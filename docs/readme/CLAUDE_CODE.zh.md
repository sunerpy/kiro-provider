# 配合 Claude Code 使用 kiro-provider

kiro-provider 为 Anthropic 兼容客户端提供 `POST /v1/messages` 和
`POST /v1/messages/count_tokens`。

## v0.5.0 支持边界

v0.5.0 包含 provider 自有账号运维、真实用量刷新和类型化流错误；这些能力
不改变这里的协议投影边界。最近一次
Claude Code 门禁于 2026-08-27 使用编译后二进制和 **Claude Code 2.1.209**；
客户端只
配置标准 `ANTHROPIC_BASE_URL`、API key、`claude-opus-5` 与 max effort。
模型现在已通过 Provider 校验，随后请求会在调用 Kiro 前以
`unsupported_parameter` 阻塞于 `context_management`。

该字段没有经过证明的 Kiro 原生等价能力，Provider 不会丢弃它。因此 Claude
Code 2.1.209 **尚未通过 v0.5 稳定版门禁**。已验证子集内的直接 Opus 5
Messages 请求已通过 JSON 与 SSE 生成。

直接 Messages 子集本身支持文本、精确工具声明/结果、base64 图片、类型化
JSON/SSE、估算 token 计数，以及完整 Kiro 签名/redacted reasoning 回放。
safe 模式会拒绝 `system`；显式迁移模式只会前置原始指令块。强制工具选择、
仅串行工具保证、prompt-cache 指令、不支持的输出格式和未知嵌套字段仍明确
报错。

## 隔离兼容性探针

先启动 Provider，再只配置标准环境变量：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export ANTHROPIC_API_KEY="sk-your-private-key"
claude --bare --safe-mode --model claude-opus-5 --effort max \
  -p "Reply with exactly: CLAUDE_CODE_OK"
```

Claude Code 2.1.209 的预期结果是非零退出，并指出
`context_management`。不要增加剥离字段的请求代理；真正支持该客户端需要
等价原生实现，或客户端版本/配置发送已支持的请求形态。

先通过 `kiro-provider login` 或一次性的 `kiro-provider accounts import`
填充 provider 自有本地认证库，并要求带鉴权的 `GET /ready` 返回 200。
base URL 使用网关根地址，不追加 `/v1`。

RC.5 账号管理证据见
[`../audits/kiro-provider-v0.5.0-rc.5-account-management-validation-2026-08-29.md`](../audits/kiro-provider-v0.5.0-rc.5-account-management-validation-2026-08-29.md)。
RC.4 认证生命周期证据保留在
[`../audits/kiro-provider-v0.5.0-rc.4-local-auth-maintenance-validation-2026-08-29.md`](../audits/kiro-provider-v0.5.0-rc.4-local-auth-maintenance-validation-2026-08-29.md)。
最近一次 Claude Code 协议证据仍为
[`../audits/kiro-provider-v0.5.0-rc.3-opus5-validation-2026-08-27.md`](../audits/kiro-provider-v0.5.0-rc.3-opus5-validation-2026-08-27.md)。
旧的 [`../E2E_VALIDATION_2026-08-22.md`](../E2E_VALIDATION_2026-08-22.md)
仅是历史 v0.4 记录。
