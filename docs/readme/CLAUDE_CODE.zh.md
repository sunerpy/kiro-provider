# 配合 Claude Code 使用 kiro-provider

kiro-provider 为 Anthropic 兼容客户端提供 `POST /v1/messages` 和
`POST /v1/messages/count_tokens`。

## v0.5.0-rc.2 当前状态

2026-08-27 使用编译后二进制和 **Claude Code 2.1.209** 进行门禁；客户端只
配置标准 `ANTHROPIC_BASE_URL`、API key 和模型。最终运行的请求顺序为：

- 首个请求包含未支持的 `output_config.format`；
- 该请求被拒绝后，Claude Code 把 `system` 放进
  `messages.1.role` 重试。

首个请求会在调用 Kiro 前以 `unsupported_parameter` 和精确字段路径被拒绝。
重试请求则由 Anthropic schema 拒绝，因为 `messages[].role` 只允许 `user` 或
`assistant`；Provider 不会静默提升或搬移该角色。同版本此前的脱敏 capture
还包含 `context_management`。safe 与
`legacy-user-prefix` 的结果相同；legacy 只处理合法的指令文本，不会开启其他
能力。因此 Claude Code 2.1.209 **尚未通过 v0.5 稳定版门禁**，历史 v0.4
工具循环结果不能作为当前 RC 已通过的证据。

直接 Messages 子集本身支持文本、精确工具声明/结果、base64 图片、类型化
JSON/SSE、估算 token 计数，以及完整 Kiro 签名/redacted reasoning 回放。
safe 模式会拒绝 `system`；显式迁移模式只会前置原始指令块。强制工具选择、
仅串行工具保证、prompt-cache 指令、不支持的输出格式和未知嵌套字段仍明确
报错。

## 隔离兼容性探针

先启动 Provider，再只配置标准环境变量：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export ANTHROPIC_AUTH_TOKEN="sk-your-private-key"
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-5"
claude -p "Reply with exactly: CLAUDE_CODE_OK"
```

Claude Code 2.1.209 的 RC.2 预期结果是非零退出，并指出
`output_config.format` 和/或非法的 `messages.1.role=system` 重试；此前 capture
还可能暴露 `context_management`。不要增加剥离字段或搬移角色的请求代理；
真正支持该客户端需要等价原生实现，或客户端版本/配置发送已支持的请求形态。

共享认证模式下先执行 `opencode auth login`，并要求带鉴权的 `GET /ready`
返回 200。base URL 使用网关根地址，不追加 `/v1`。

当前证据见
[`../audits/kiro-provider-v0.5.0-rc.2-validation-2026-08-27.md`](../audits/kiro-provider-v0.5.0-rc.2-validation-2026-08-27.md)。
旧的 [`../E2E_VALIDATION_2026-08-22.md`](../E2E_VALIDATION_2026-08-22.md)
仅是历史 v0.4 记录。
