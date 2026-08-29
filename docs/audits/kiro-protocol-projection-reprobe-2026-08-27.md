# Kiro 合法 additionalContext 指令投影复探（2026-08-27）

## 结论

- Zuno 只应发送标准 OpenAI Responses 字段；本 Provider 是负责把
  `instructions/system/developer` 投影到 Kiro 协议的一层。
- 旧探针使用了空 `name`/`description`。AWS SDK 将这两个字段标记为 required，
  所以其 HTTP 400 只能证明该请求形态非法。
- 修正为合法非空标签后，Kiro 对 GPT 5.6 Sol 与 Claude Opus 5 均返回 HTTP
  200，但模型没有收到 `innerContext` 指令文本，也没有保持指令高于冲突 user
  输入的优先级。
- 因而本 Provider 当前仍不能实现协议保真的 safe 指令投影。生产 `safe` 模式
  继续返回 `unsupported_instruction_projection`；显式
  `legacy-user-prefix` 仍是唯一可工作的迁移模式。

OpenAI Responses 的最低语义要求是 top-level `instructions` 高于 `input`，
developer 消息高于 user 消息。Kiro 的实测行为不满足该等价条件：
[Message roles and instruction following](https://developers.openai.com/api/docs/guides/text#message-roles-and-instruction-following)。

## SDK 结构证据

`@aws/codewhisperer-streaming-client` 1.0.45 的
`AdditionalContentEntry` 将 `name` 与 `description` 标记为 required，
`innerContext` 为可选文本：

```text
name: string | undefined
description: string | undefined
innerContext?: string
```

复探保留空标签请求作为负控，并新增：

- `name/description: "instructions"`；
- `name/description: "system"`；
- `name/description: "developer"`；
- system 与 developer 两个有序条目；
- 与 user 指令冲突；
- 工具调用与工具结果续轮。

所有请求只使用合成标记和合成工具参数，不包含凭证、真实用户 prompt、
reasoning 签名或其他敏感内容。

## GPT 5.6 Sol

命令：

```bash
bun scripts/probe-sdk.ts --protocol-projection
```

结果：

| 探针 | HTTP | 结果 |
| --- | ---: | --- |
| 普通 user 控制组 | 200 | 精确返回控制标记 |
| 旧式 user 前缀 | 200 | 精确返回指令标记 |
| 空标签负控 | 400 | `Improperly formed request` |
| 合法 instructions 标签 | 200 | 未返回 `innerContext` 标记 |
| 冲突 user 优先级 | 200 | 返回 user 标记，未服从 context |
| system 标签 | 200 | 未返回 system 标记 |
| developer 标签 | 200 | 未返回 developer 标记 |
| 有序多条目 | 200 | 未读取两个 context 片段 |
| context 要求工具参数 | 200 | 调用了工具，但参数不含 context 标记 |
| 工具结果续轮 | 200 | 能读取显式工具结果；不能证明初始 context 可见 |

退出码为 `1`，结论为 `PROTOCOL-PROJECTION-UNSUPPORTED`。

## Claude Opus 5

命令：

```bash
bun scripts/probe-sdk.ts --protocol-projection --protocol-projection-claude
```

首次运行命中了已耗尽配额的账号并得到 HTTP 402，因此不用于能力结论。探针的
账号选择随后改为优先未过期、未处于 rate limit 且配额利用率最低的健康账号；
重跑控制组和旧式前缀均通过。

| 探针 | HTTP | 结果 |
| --- | ---: | --- |
| 普通 user 控制组 | 200 | 精确返回控制标记 |
| 旧式 user 前缀 | 200 | 精确返回指令标记 |
| 空标签负控 | 400 | `Improperly formed request` |
| 合法 instructions 标签 | 200 | 未返回 `innerContext` 标记 |
| 冲突 user 优先级 | 200 | 未服从 context |
| system 标签 | 200 | 未返回 system 标记 |
| developer 标签 | 200 | 明确表示未收到独立 developer context |
| 有序多条目 | 200 | 未收到两个 context 片段 |
| context 要求工具参数 | 200 | 调用了工具，但使用了自行生成的参数 |
| 工具结果续轮 | 200 | 能读取显式工具结果；不能证明初始 context 可见 |

退出码为 `1`，结论为 `PROTOCOL-PROJECTION-UNSUPPORTED`。

## 生产决策

1. 本 Provider 保留从标准 Responses/Chat/Messages 到统一 IR 的无损解析；Zuno
   不需要丢弃 instructions，也不应修改 user prompt。
2. 只有当 Kiro 出现经过真实协议验证、能够保持内容、角色、顺序、优先级和
   工具循环的原生字段时，才在本 Provider 的 Kiro 适配器中启用 safe 投影。
3. 不能仅因为 Kiro 返回 HTTP 200 就映射 `additionalContext`；当前行为会把
   指令静默丢弃，违反 OpenAI 协议。
4. 不把指令复制到 `name`、`description`，也不改写 user 文本来伪装 safe。
5. `safe` 继续 fail-closed；需要现有 Kiro 能力的部署必须显式选择
   `legacy-user-prefix`，并接受其迁移模式属性。

## 与 Zuno 的边界

Zuno 的 session affinity 可通过标准 Responses `metadata` 单独改善账号与 Kiro
conversation 复用；它与指令投影是两个独立问题。即使亲和已修复，也不能让
Kiro 获得当前未暴露的 `additionalContext.innerContext` 语义。
