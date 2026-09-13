# Zuno 接入 Kiro Provider 流交付与失败恢复说明

本文对应 Provider v3.1.1。此次修改仅在 Kiro Provider，不要求修改 Zuno 的模型、reasoning、超时或 `responses_*` 配置，也不操作 Zuno 的真实会话库、Goal 和已接纳输入。

## 1. 响应头与工具参数的交付边界

旧实现等待首个 canonical 语义事件，工具参数又在完整调用结束后才投影。上游持续发送 `toolUseEvent` 时，客户端仍可能一直等待响应头。

现在按以下顺序处理：

```text
请求校验、鉴权和有界准备
  → 上游真实 HTTP 接纳
  → 下游响应头与生命周期
  → 文本、推理、工具参数增量
  → 完整性校验与终态，或明确失败
```

SDK HTTP handler 在 EventStream 解码器等候首帧时也能报告上游响应头。成功响应必须具有正确 Content-Type；JSON 错误不会冒充成功 SSE。Responses 发出规范生命周期，Chat 先发 assistant-role chunk；native Responses 用一条 SSE 注释交付已接纳连接，然后保持上游事件序号。

Function 参数逐段传递，调用身份和输出索引保持稳定。跨片段的 Unicode 字符不会被替换或丢失。Custom wrapper 在单个调用完成后才安全解包；实际收到 wrapper 片段时可以发送活性注释，但注释不表示模型语义、token usage 或完成。

## 2. 参数增量不代表可执行调用

只有身份、工具停止、整体完成凭证、JSON、累计大小和声明 schema 均通过校验，调用才可以完成。客户端不能在部分参数到达时执行工具。

截断、畸形 JSON、schema 不匹配或超限时，Provider 会终结为失败，不补造 `{}`、不强行闭合参数，也不把另一次生成拼接进来。历史零参数特例只接受“从未出现 input 字段 + 明确 stop + 完成凭证”，不是对空字符串或残缺 JSON 的修复。

`max_request_body_bytes` 同时约束工具参数和身份累计字节数，复用现有默认 10 MiB。Schema 校验不改写类型、不注入默认值、不移除字段，也不代表上游 strict 生成约束已经得到验证。无法本地验证的外部引用或异步 schema 在派发前返回 `invalid_tool_schema`。

## 3. 失败与请求关联

SSE 已发布后 HTTP 状态不能再改成 503/504。Responses 使用 `response.failed`，Chat 使用带结构化 code 的错误帧；不能随后追加成功终态或 `[DONE]`。

客户端读取 `response.failed.response.error.code`，并可保存新增诊断字段：

```json
{
  "code": "request_deadline_exceeded",
  "message": "Request deadline exceeded; earlier upstream failure HTTP 503",
  "request_id": "req_fixture",
  "details": {
    "phase": "retry_backoff",
    "response_committed": false,
    "completion_witnessed": false,
    "cancel_source": "request_deadline",
    "first_failure": {
      "upstream_status": 503,
      "upstream_code": "ServiceUnavailableException",
      "upstream_request_id": "upstream_fixture"
    }
  }
}
```

这是字段示例，省略了 attempt、耗时和最后失败等字段；不是某个真实会话的日志。实际 HTTP 层预算失败在发布前返回 JSON 504，发布后才使用流内错误。

`X-Request-ID` 关联逻辑请求，`attempt_id` 关联每次派发。未知上游状态和 ID 保持 null，不把本地超时或账户选择失败编造成上游 503。先 503、后本地 deadline 时，两种原因均保留；清理失败不会覆盖取消首因。

| code | 客户端处理 |
| --- | --- |
| `upstream_stream_error`、`upstream_stream_incomplete` | 在自身总预算内决定是否替代重试；保留失败记录 |
| `upstream_stream_idle_timeout` | 核对空闲阶段和剩余总预算 |
| `request_deadline_exceeded` | Provider 总预算到期；不能重新无限计时 |
| `malformed_upstream_tool_arguments` | 丢弃部分调用；无副作用时才考虑替代重试 |
| `invalid_upstream_tool_call`、`incomplete_upstream_tool_call` | 身份或停止契约异常，不机械重试 |
| `upstream_tool_arguments_too_large`、`upstream_tool_schema_violation` | 参数大小或 schema 不合法，不执行工具 |
| `unknown_upstream_tool`、`invalid_custom_tool_input`、`upstream_tool_choice_violation` | 工具声明、包装或选择控制不匹配 |
| `invalid_upstream_response`、`upstream_protocol_error`、`unsupported_upstream_event`、`upstream_invalid_state`、`invalid_upstream_reasoning`、`missing_upstream_stream` | 协议错误，应调查而不是反复生成 |

错误正文统一脱敏并限长。日志保存摘要哈希、计数和身份关联，不记录原始提示词、工具参数、Authorization、Cookie 或私有 reasoning。

## 4. 重试、时钟和取消

- 上游接纳前，继续采用类型化 HTTP/传输重试策略及现有共享预算。普通权限 403 不强制刷新令牌；真正凭据失效仍保留原有一次刷新机会。
- 已接纳的流不透明重试，包括仅收到生命周期、部分工具参数、EOF 或空完成。客户端需要另建替代请求，不能拼接部分结果或重放已经产生的副作用。
- 非流式收集保留原有有界替代行为。`stream_max_attempts` 和 `retry_empty_completion` 不再用于替换已接纳的流。
- 真实原始帧刷新传输空闲计时，投影事件单独统计；总 deadline 不因任一种活动重置。没有新增无限心跳或放大默认超时。
- 客户端断连、body consumer 取消和 Provider deadline 分别记录来源，贯穿队列、SDK 请求、迭代器和清理。关闭本地 socket 不等于能够证明远端模型已经停止计算。
- 有效的数值或 HTTP 日期 `Retry-After` 会参与退避，错误响应尽可能返回剩余等待信息。缺失值使用现有配置，不再误读为零或固定一分钟。

## 5. Zuno 配置与隔离验收

正常 Zuno 仍使用现有 `kiro-local` Responses provider。`responses_fidelity_mode`、`responses_instruction_lift`、`responses_native_tool_bridge` 是 Provider 开关，不应添加到 Zuno 请求参数中。

验收使用当前安装版本、独立 XDG/配置/数据库目录和原 `kiro-local` profile 的副本。副本仅更改测试 endpoint、禁用工具执行和学习后台任务，并限制每个测试只有一次 Provider 请求。真实 profile 和会话状态保持不变。

官方 OpenAI SDK 7.13.0 验证：响应头先于完成、工具参数逐字节一致、调用只完成一次、完整 `response.output` 回放和显式合成结果续接。探针不执行工具。GPT 未返回可见推理不被判为缺陷；请求和派发的 effort 分别核对，不以可见 reasoning 数量推断 effort。

原生权限、输出上限等约束失败须单独记录。`unsupported_output_token_limit` 仍保持明确拒绝；不能静默删除预算或换模型后宣称原路径已修复。

跨协议完整定义见 [STREAM_ERROR_CONTRACT.md](STREAM_ERROR_CONTRACT.md)。修复前后证据见本批流交付审查报告；旧 v0.5.x 的 Zuno 分类补丁和发布数字仅为历史记录，不是此次需要执行的 Zuno 变更。
