# Kiro 协议投影、reasoning 与输出上限探针（2026-08-26）

> 指令投影部分已被
> [2026-08-27 合法 `additionalContext` 复探](kiro-protocol-projection-reprobe-2026-08-27.md)
> 取代。本文空标签请求的 HTTP 400 仍是有效负控，但不能证明合法
> `additionalContext` 结构会被拒绝；reasoning、输出上限和同角色消息结论不受
> 影响。

## 结论

- Kiro 当前链路不接受空 `name`/`description` 的 `additionalContext`；文本、
  冲突优先级和工具场景均返回 HTTP 400
  `ValidationException: Improperly formed request.`。
- 因而没有证据证明 `additionalContext` 能在不增加 Provider 文本的前提下等价
  承载 OpenAI `instructions/system/developer`。生产 `safe` 模式必须明确拒绝
  这些角色，不能自动回退到 user 前缀。
- Kiro 接受连续 user 历史和连续 assistant 历史，均返回 HTTP 200 并命中精确
  标记；生产路径不需要合并文本，也不需要插入空结构消息。
- Claude Sonnet 5 本次产生了 `reasoningContentEvent` 和非空签名，但 reasoning
  文本为 0 bytes、`redactedContent` 为 0 bytes。这是**签名存在但 envelope
  不完整**，不能猜测签名覆盖的文本，也不能生成 `kr1_...` 回放令牌。
- Claude Sonnet 5 接受原生 `additionalModelRequestFields.max_tokens`，实测上限
  为 128,000；Kiro 对小于 1,024 的值也会拒绝。GPT 5.6 对
  `max_output_tokens`、`max_tokens`、`max_completion_tokens`、`maxTokens` 均以
  schema 未定义为由返回 HTTP 400。

## 环境

- 日期：2026-08-26（Asia/Shanghai）
- 认证：OpenCode 共享 Kiro IdC 数据库 `/config/.config/opencode/kiro.db`
- 生成区域：`us-east-1`
- 投影模型：仓库映射的 `gpt-5.6-sol`
- reasoning/输出上限模型：仓库映射的 `claude-sonnet-5`
- SDK：`@aws/codewhisperer-streaming-client` 1.0.45
- 命令：
  - `bun run scripts/probe-sdk.ts --protocol-projection`
  - `bun run scripts/probe-sdk.ts --output-token-limit`
- 两个命令退出码均为 `1`：分别表示结构化指令投影不支持、GPT 输出上限字段
  不支持；控制请求均成功，因此结论有效而非认证失败。

探针只使用合成标记，不打印 access token、refresh token、client secret、
reasoning 签名或 redacted bytes。签名只输出 SHA-256 前 16 位。

## 指令投影与消息序列结果

| 探针 | HTTP | clean EOF | 结果 |
|---|---:|---|---|
| 控制请求 | 200 | 是 | 精确返回 `KIRO_CONTROL_5F24A9C1` |
| 旧式 user 前缀 | 200 | 是 | 精确返回 `KIRO_CONTEXT_7C8A1E42` |
| 空标签 `additionalContext` | 400 | 否 | `Improperly formed request` |
| `additionalContext` 优先级冲突 | 400 | 否 | `Improperly formed request` |
| `additionalContext` + tool | 400 | 否 | `Improperly formed request` |
| 连续 user 历史 | 200 | 是 | 精确返回 `KIRO_SEQUENCE_8B2D4E61` |
| 空 assistant 分隔 user 历史 | 200 | 是 | 精确返回同一标记 |
| 连续 assistant 历史 | 200 | 是 | 精确返回同一标记 |
| 空 user 分隔 assistant 历史 | 200 | 是 | 精确返回同一标记 |

控制组证明凭证、模型和网络链路有效，因此 `additionalContext` 的 400 是有效
上游协议证据。

### 脱敏请求与事件证据

探针实际发送的结构化投影片段如下，`innerContext` 为合成标记文本，未加入
标签或 Provider 说明：

```json
{
  "additionalContext": [
    {
      "name": "",
      "description": "",
      "innerContext": "Reply with exactly KIRO_CONTEXT_7C8A1E42 and no other text."
    }
  ]
}
```

对应脱敏结果：

```text
HTTP status: 400
Raw event types: (none)
Error: ValidationException: Improperly formed request.
```

连续同角色请求直接使用两个相邻 `userInputMessage` 或
`assistantResponseMessage`，未插入文本；四个直接/空结构对照请求都得到：

```text
HTTP status: 200
Content: KIRO_SEQUENCE_8B2D4E61
Raw event types: assistantResponseEvent, contextUsageEvent, meteringEvent
Clean EOF: yes
```

## Native reasoning 结果

Claude Sonnet 5 请求：

```text
Prompt: Compute 127 multiplied by 389. Use internal reasoning, then answer with only the integer.
HTTP status: 200
Content: 49403
Reasoning text bytes: 0
Reasoning signature hash: 36ad40bfa48f052b
Reasoning redacted bytes: 0
Raw event types: assistantResponseEvent, contextUsageEvent, meteringEvent, reasoningContentEvent
Clean EOF: yes
```

由于没有签名文本或 redacted bytes，探针没有向 Kiro 回放不完整 envelope，也就
无法从真实上游证明同会话回放、错误 conversation 或篡改拒绝。Provider 层的
加密存储、跨租户/账号/conversation/模型/输出指纹、过期、篡改、密钥轮换和
账号锁定由自动化测试覆盖；只有未来取得完整原生 envelope 后，才能补充真实
上游回放证据。

这与最新版 `opencode-kiro-auth` 的 reasoning accumulator 原则一致：只有
`text + signature` 或独立 `redactedContent` 才是可发送 envelope；signature-only
事件不可回放。

## 输出 token 上限结果

| 探针 | HTTP | 结果 |
|---|---:|---|
| Claude Sonnet 5 无限制控制组 | 200 | 40 个精确 `alpha`，reasoning event，clean EOF |
| Claude Sonnet 5 `max_tokens` | 200 | 字段被 schema 接受，40 个精确 `alpha`，clean EOF |
| Claude Sonnet 5 `max_tokens=2147483647` | 400 | `must have a maximum value of 128000.0` |
| GPT 5.6 无限制控制组 | 200 | 40 个精确 `alpha`，reasoning event，clean EOF |
| GPT 5.6 `max_output_tokens` | 400 | property 未在 schema 定义 |
| GPT 5.6 `max_tokens` | 400 | property 未在 schema 定义 |
| GPT 5.6 `max_completion_tokens` | 400 | property 未在 schema 定义 |
| GPT 5.6 `maxTokens` | 400 | property 未在 schema 定义 |

代表性的脱敏错误：

```text
ValidationException: Invalid additionalModelRequestFields: must have a maximum value of 128000.0
ValidationException: Invalid additionalModelRequestFields: property 'max_output_tokens' is not defined in the schema and the schema does not allow additional properties
```

结合最小值探针（1,023 被拒绝，1,024 接受），生产映射固定为：

- `claude-sonnet-5` 及其 provider 变体：`1_024..=128_000` 映射到原生
  `max_tokens`；
- GPT 5.6 及未探针确认的模型：请求输出上限时返回
  `unsupported_output_token_limit`，不会接受后忽略。

## 生产决策

1. `protocol_projection_mode=safe` 为默认值；出现
   `instructions/system/developer` 时返回
   `unsupported_instruction_projection`。
2. 只有显式 `legacy-user-prefix` 才允许精确 `\n\n` 指令前缀，并输出不含内容
   的弃用警告。
3. 相邻同角色消息按原顺序直接下发；删除 merge/collapse、尾部 `{` 删除和
   所有模型可见补偿逻辑。
4. reasoning 回放只接受 Provider 自己持久化且完整校验的原生材料；没有完整
   envelope 时不生成 `encrypted_content`。
5. 不把普通工具事件或模型文字转换为 Kiro 托管 Web Search 证据。
6. 输出 token 限制仅按上述 Claude Sonnet 5 范围映射，其他模型默认拒绝。

## 复现

```bash
bun run scripts/probe-sdk.ts --protocol-projection
bun run scripts/probe-sdk.ts --output-token-limit
```

`--protocol-projection` 退出码：

- `0`：`additionalContext` 通过文本、优先级和工具续轮验证；
- `1`：控制组有效，但结构化投影未通过；
- `2`：凭证或控制组不足以建立结论。

`--output-token-limit` 退出码：

- `0`：所有被测模型均存在可证明的限制字段；
- `1`：控制组有效，但至少一个模型没有可用字段；
- `2`：凭证或控制组不足以建立结论。
