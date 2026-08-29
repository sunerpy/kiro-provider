# kiro-provider 运行时、模型目录与会话隔离验收审计

日期：2026-08-28

## 结论

本轮已经把 Kiro CLI/SDK 实际行为中可验证、适合 Provider 的部分落实到
`kiro-provider`：

- 使用 Kiro 当前运行时域名和请求方标识，不模拟 CLI 的提示词或私有交互文本；
- 以 Kiro 实际 `meteringEvent` 或有效 token usage 作为流正常完成证据，普通
  clean EOF 不再被误判为成功；
- 从 Kiro management API 按账号加载实时模型目录，并在请求路由时校验目标账号
  确实可用该模型；
- 标准客户端不携带会话 metadata 时，可依据完整历史的不可逆指纹恢复账号和
  Kiro conversation；存在歧义时拒绝猜测；
- 保留每账号传输层和 SDK client 池，并增加单实例数据库锁，防止两个进程同时
  消费同一本地账号/亲和状态；
- Responses 内联文件使用 Kiro 原生 document 结构，不把文件内容或说明拼进
  prompt；
- GPT 5.6 Sol 只隐藏精确等于 `...` 或 `…` 的无信息 reasoning 占位符，Claude
  reasoning 不受影响；
- reasoning 加密回放在服务重启后仍锁定原账号和原 Kiro conversation。

编译后二进制已通过官方 OpenAI SDK、真实 OpenCode 工具循环、文件输入、连续
文本块、多会话亲和和 reasoning 跨重启回放。当前 Codex、Claude Code 和
OpenCode Chat 仍各有一个标准客户端扩展字段被安全模式明确拒绝，因此本报告
不宣布稳定版验收完成，也没有发布新版本。

## 1. 验收基线

| 项目 | 值 |
| --- | --- |
| 仓库基线 | `b22395200bc69b87d5af9442f34e6a86f68e7daa` |
| 基线标签/包版本 | `v0.5.0-rc.3` / `0.5.0-rc.3` |
| 工作分支 | `codex/safe-instruction-projection` |
| Bun | 1.3.14 |
| Kiro CLI | 2.20.1 |
| OpenCode | 1.18.18 |
| Codex CLI | 0.150.0-alpha.9 |
| Claude Code | 2.1.209 |
| OpenAI JavaScript SDK | 7.5.0 |
| 共享认证数据库 | OpenCode Kiro 数据库，42 个账号 |

所有在线验证均使用本仓库最终编译的 `dist/kiro-provider`。客户端只配置标准
base URL、API key 和模型；没有私有 Header、请求补丁、客户端字段剥离或提示词
补偿。Zuno 仓库没有被修改或重跑。

最终本机 Linux 二进制：

- 大小：95,246,464 bytes；
- 权限：`0755`；
- SHA-256：
  `f8bb2c3fdd3221f197a7ec71586dd7e196ee5811f8feb8d700ae2fd700641125`。

## 2. Kiro 运行时与流完成语义

Kiro 实际成功流的脱敏事件顺序为：

```text
assistantResponseEvent × 3
contextUsageEvent × 1
metadataEvent × 1
meteringEvent × 1
clean EOF
```

其中本次观测到的 `metadataEvent` 可以为空；把它或单独的 EOF 当作完成信号会
掩盖截断。Provider 现在只接受以下任一完成证据：

1. 结构有效的 token usage metadata；
2. 结构有效的 `meteringEvent`，随后正常 EOF。

只有 assistant/context 事件后 EOF、格式错误的 metering、读取异常或超时均
返回流失败，不生成伪 completed 事件。SSE 与非流式收集器共用这一判定。

请求运行时同步为当前 Kiro 形态：

- endpoint：`runtime.<region>.kiro.dev`；
- `origin`：`AI_EDITOR`；
- 设置 `agentContinuationId`；
- 设置 `agentTaskType: "vibe"`。

这些字段只描述客户端/会话，不包含额外系统提示、模型可见补偿文本或 CLI
prompt。

## 3. 实时模型目录与账号感知路由

Provider 新增 Kiro management client，并按账号缓存实时模型能力：

- 验收时 42 个可读账号均能取得目录；
- 每个账号观测到 19 个 Kiro wire model；
- 公共目录由“静态已验证能力定义”和“至少一个健康账号实时可用”共同决定；
- 选定账号后再次校验该账号是否拥有目标 wire model；
- 目录暂时不可用时保留有界缓存，不把未知模型伪装为可用。

本次实测目录包含 Opus 5、Sonnet 5、GPT 5.6 等已经在本项目声明并验证的模型
家族。Provider 不把 management API 中未知或尚未完成协议能力验证的模型自动
暴露为 OpenAI 兼容模型。

## 4. 会话隔离、账号亲和与连接复用

标准客户端无自定义 metadata 时，Provider 现在按以下优先级恢复亲和：

1. 显式标准 metadata 中的会话键；
2. 当前请求完整历史对应的 lineage 指纹；
3. 创建新的账号与 Kiro conversation 绑定。

lineage 只保存不可逆指纹及绑定关系，不保存 prompt 正文。只有唯一匹配才恢复；
零匹配创建新会话，多匹配返回歧义错误，不跨会话猜测账号。

使用每次生成唯一标记的两轮 Responses 验证得到：

```json
{
  "account_hash": "5bafd91ab936c907",
  "conversation_hash": "869d5f24fe7f1adf",
  "second_turn_affinity_bound": true,
  "second_turn_affinity_kind": "history-lineage",
  "transport_pool_hit": true,
  "sdk_client_pool_hit": true
}
```

真实 OpenCode function/bash/read 三轮工具循环也始终复用：

```json
{
  "account_hash": "d899e225e3de1a28",
  "conversation_hash": "1b24ca76de25e4f0",
  "effort": "max"
}
```

后续轮次均命中 transport 与 SDK client 池。这里证明的是同账号、同 Kiro
conversation 和同进程客户端对象复用；HTTP keep-alive 的底层物理 TCP socket
仍由 Smithy/Node 连接池管理，不作逐请求固定 socket 的虚假保证。

单实例锁默认启用。第二个编译后二进制指向同一状态目录时退出码为 1，并返回：

```text
Another kiro-provider instance already holds the service lock
```

这避免多个进程并发使用同一 SQLite 亲和表和账号租约。需要多进程部署时必须
显式规划独立状态目录或未来的共享协调后端，不能简单关闭锁后共享数据库。

## 5. 文件、内容块与 reasoning 投影

### Responses 内联文件

支持的原生格式为：

```text
csv doc docx html md pdf txt xls xlsx
```

Provider 保留 Canonical IR 中的原始文件名、格式和 bytes，在最终 Kiro 边界才
投影为 document block。已实测：

```text
marker.txt -> { name: "marker", format: "txt" }
```

文件内容没有转换成 user prompt 文本。`file_id` 因 Kiro 无等价取回机制而明确
拒绝。

Kiro 实测要求去掉最终扩展名后的 `name` 为 1–200 个 ASCII 字符，只能包含
字母、数字、空格、连字符、下划线、圆括号和方括号，且不能首尾空格或连续
空格。任何必须靠重命名才能发送的文件在调用 Kiro 前返回
`invalid_file_name`，参数精确指向 `.filename`；Provider 不进行有损清洗。

### 连续文本内容块

Responses 同一 message 中的多个纯文本块会在 Canonical IR 中保留边界，在
Kiro 单一 text 字段的最终边界按原字节顺序、无分隔符连接。混合文本与其他
不可等价内容块时仍返回 `unsupported_content_block_projection`，不会静默
重排或插入解释文本。

### GPT reasoning 占位符

仅当模型属于 GPT 5.6 Sol 且 reasoning 文本 trim 后精确等于 `...` 或 `…`
时，Provider 隐藏该无信息块。其他 GPT reasoning、Claude/Opus thinking、
签名和 redacted content 均保持原处理路径。

### 加密 reasoning 回放

使用 `claude-opus-4-8-thinking` 取得真实 reasoning envelope 后：

1. Responses 返回随机 `kr1_` opaque token；
2. SQLite 只保存 token hash 和 AES-256-GCM 密文；
3. 停止并重启最终编译服务；
4. 使用上一轮输出发起回放。

重启后的日志记录：

```json
{
  "event": "reasoning_replay_hit",
  "account_hash": "9e0e6e9aa857355e",
  "conversation_hash": "81e6f7cdebb124ab",
  "reasoning_replay_locked": true
}
```

原始 token、签名、reasoning 文本和密钥均未写入日志。回放没有切换账号，也
没有在未命中时降级为明文 reasoning。

## 6. 编译后二进制端到端结果

### 官方 OpenAI SDK 7.5.0

```text
OPUS5_CATALOG_OK
OPUS5_RESPONSE_NONSTREAM_OK
OPUS5_RESPONSE_STREAM_OK
OPUS5_FUNCTION_TOOL_OK
OPUS5_CHAT_OK
OPUS5_MESSAGES_NONSTREAM_OK
OPUS5_MESSAGES_STREAM_OK
OPUS5_OUTPUT_BOUNDARY_OK
ZED_MULTI_TEXT_OK
NATIVE_FILE_OK
INVALID_DOCUMENT_NAME_FAIL_CLOSED_OK
HISTORY_LINEAGE_UNIQUE_OK
GPT_PLACEHOLDER_HIDDEN_OK
REASONING_FIRST_OK
REASONING_RESTART_REPLAY_OK
```

### OpenCode 1.18.18

Responses 实际工具循环通过。OpenCode 依次：

1. 用 bash 写入临时标记；
2. 用 read 工具读回；
3. 返回精确最终文本。

三轮保持同一账号、conversation 和 `effort=max`。因为 OpenCode 会发送
developer 指令，该次客户端验收显式使用 `legacy-user-prefix`；这不改变默认
`safe` 模式。

OpenCode Chat 使用 `@ai-sdk/openai-compatible` 时在调用 Kiro 前失败：

```json
{
  "code": "unsupported_message_field",
  "param": "messages.0.cache_control"
}
```

Provider 没有静默删除客户端字段。

### Codex CLI 0.150.0-alpha.9

标准 Responses 配置在调用 Kiro 前失败：

```json
{
  "code": "unsupported_reasoning_summary",
  "param": "reasoning.summary"
}
```

### Claude Code 2.1.209

标准 Messages 配置在调用 Kiro 前失败：

```json
{
  "code": "unsupported_parameter",
  "param": "context_management"
}
```

以上三个字段是稳定版门禁，不属于提示词投影问题。本轮保持 fail-closed，
没有通过丢弃字段来制造客户端“成功”。

## 7. 自动化门禁

| 门禁 | 结果 |
| --- | --- |
| `bun run fmt` | 通过 |
| `bun run lint` | 通过 |
| `bun run typecheck` | 通过 |
| `bun test` | 771 pass，0 fail，3,388 expect calls |
| `make coverage-gate` | 通过；12,016 / 12,804 lines，93.85% |
| `make coverage-parity` | 通过 |
| `bun run build` | 通过 |
| `bun run build:binary` | 通过 |
| `make security` | 通过；7 项安全断言 |
| `make codex-smoke-security` | 通过 |

测试覆盖新增：

- management API 解析、缓存与模型能力交集；
- document 文件名、格式、大小和非 UTF-8 bytes；
- metering/usage 完成证据及截断失败；
- history-lineage 唯一恢复与歧义拒绝；
- 单实例锁；
- GPT placeholder 与 Claude reasoning 隔离；
- reasoning 加密、重启、账号/conversation 绑定。

## 8. 协议边界与发布决策

本轮没有改变以下安全结论：

- Kiro 当前没有经过真实验证、可保持 OpenAI `instructions/system/developer`
  内容和优先级的原生通道；
- 默认 `safe` 模式继续返回 `unsupported_instruction_projection`；
- `legacy-user-prefix` 仍是显式迁移模式，不是完整协议保真模式；
- 不实现 Kiro Web Search 伪事件；
- 不接受 `previous_response_id` 或服务端 Responses 存储语义；
- 不从 tool arguments 推断工具 schema，也不插入 orphan tool/图片/thinking
  补偿文本。

因此当前工作树适合作为下一 RC 的候选实现，但稳定版门禁仍未关闭：

1. Codex 的 `reasoning.summary`；
2. Claude Code 的 `context_management`；
3. OpenCode Chat 的 message `cache_control`；
4. 完整真实客户端矩阵需在对应字段获得明确、无损语义后重跑。

本轮没有提交、推送、创建标签或发布 GitHub Release。
