# 已知限制

本页列出 kiro-provider 有意拒绝的内容、Kiro 没有提供的能力，以及已知的未解决问题。这里列出的每一项被拒绝时，都会以写明字段的带类型错误失败，不存在接受之后再忽略的情况。

## OpenAI Responses 中拒绝的内容

- `background: true`、Responses 的 `conversation` 对象、`POST /v1/responses/compact`，以及精确的 `POST /v1/responses/input_tokens`（后两者返回 `501 unsupported_endpoint`）。
- Structured Outputs 和 JSON 模式，但 Codex CLI 生成会话标题所用的一个本地小型 profile 除外。
- 联网搜索以外的托管工具：File Search、Computer Use 和托管 MCP。Kiro 没有这些工具，kiro-provider 也不会模拟它们的事件。
- `required`、指定名称或带约束的 `tool_choice`。`auto` 和 `none` 可以使用。
- 远程图片 URL 和 OpenAI 的 `file_id` 引用；请直接内联图片和文件。
- 提示词模板、审核设置和上下文管理。

## Anthropic Messages 中拒绝的内容

- 删除内容的上下文编辑。只接受 `keep: "all"` 的 `clear_thinking_20251015`。
- Structured Outputs，但 Claude Code 生成会话标题所用的同一个小型 profile 除外。
- 强制使用某个工具，或要求工具逐个执行。
- 一条用户消息中既有自己的图片、又有工具结果中的图片。
- 未知的 beta 字段和工具版本。

`/v1/messages/count_tokens` 返回的是估算值，响应头 `x-kiro-token-count-mode: estimate` 会说明这一点。提示词缓存标记只是给 Kiro 的提示，不是保证。

## Kiro 没有提供的能力

- 接受 `parallel_tool_calls: false`，但 Kiro 不保证严格逐个执行工具。
- `DELETE /v1/responses/{id}` 删除的是 kiro-provider 在本地的副本。Kiro 没有提供删除其服务端响应状态的方式，网关因此无法对此作出保证。
- `store: false` 关闭网关在本地的副本，但这不是 AWS 的零数据保留承诺。
- 联网搜索只在 `gpt-5.6-sol` 和 `claude-opus-5.5` 下、在位于 `us-east-1` 的账号上执行，这些是经过测试的组合。[联网搜索](guide/web-search.md)

## 平台

- 独立二进制支持 Linux x64 和 ARM64、macOS Intel 和 Apple Silicon，以及 Windows x64，没有 Windows ARM64 版本。
- npm 包只能在 Bun 上运行。

## 未解决的问题

- **完成工具轮次后的 Opus 5。** 如果 Claude Opus 5 对话的历史中包含一个已完成的工具轮次和最终回答，下一轮可能以 `502 upstream_stream_incomplete` 失败。同样的请求在 Opus 5.5 上可以成功。原因在上游，目前尚不清楚；kiro-provider 不会为掩盖它而裁剪历史。复现方法见[审计记录](../../audits/model-switch-replay-2026-10-04.zh.md#仍-open-的上游问题)。

每份客户端指南都列出了验证过的客户端版本；更新的客户端可能发送暂不支持的字段。完整的契约见[协议兼容性](../../readme/PROTOCOL_COMPATIBILITY.zh-CN.md)。
