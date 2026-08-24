# 配合 Claude Code 使用 kiro-provider

Claude Code 的推理请求使用 Anthropic Messages 协议，不使用 OpenAI
Responses 或 Chat Completions。

已于 2026-08-22 使用 **Claude Code 2.1.209** 完成真实端到端验证，包括一次
实际 `Read` 工具调用和工具结果续接。

## 配置 Claude Code

先启动 kiro-provider，再把 Claude Code 指向网关根地址（不要追加
`/v1`）：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export ANTHROPIC_AUTH_TOKEN="sk-your-private-key"
claude
```

`ANTHROPIC_AUTH_TOKEN` 会与 `api_keys` 匹配。Anthropic 路由也接受
`x-api-key`。

默认共享认证模式下，请先运行 `opencode auth login` 并登录 Kiro，同时要求
需鉴权的 `GET /ready` 返回 200。只有 `auth_source: "local"` 才使用
provider 本地登录/导入。

如果 Claude Code 的默认模型别名与 `GET /v1/models` 返回值不一致，可以
显式设置：

```bash
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4.5"
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4.1"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-4.5"
```

实际值应以当前运行中网关暴露的模型 ID 为准。

## 端点

- `POST /v1/messages`：非流式 Anthropic Message JSON，或 Anthropic
  Messages SSE。
- `POST /v1/messages/count_tokens`：输入 token 估算。

## 已支持

- 文本、base64 图片、system prompt、工具声明、工具调用与工具结果。
- 流式事件顺序为 `message_start`、content-block 事件、
  `message_delta`、`message_stop`。
- HTTP 200 之后发生的错误会输出 Anthropic `error` SSE 事件。
- 请求截止时间、客户端取消、请求体大小限制、Bun 请求级 idle-timeout
  租约清理与 Responses 共用同一生命周期约束。
- 不需要私有会话 Header。`metadata.user_id` 加首个用户回合，或仅首个用户
  回合，会驱动持久化的账号与 Kiro conversation 亲和。

## 明确限制

- Kiro 不提供 Anthropic signed-thinking block。重放的 `thinking` 与
  `redacted_thinking` 不会被转换成模型可见文本，网关也不会伪造或返回
  thinking signature。
- Kiro 没有与 `tool_choice: any/tool` 或
  `disable_parallel_tool_use: true` 等价的结构化硬约束，因此这些请求会返回
  明确的 invalid-request 错误，不会通过拼接提示词模拟。
- `max_tokens` 会按 Messages API 契约校验，但当前 Kiro 传输层没有精确的
  输出 token 上限能力，不能将其视为硬性生成限制。
- Kiro 没有提供独立 tokenizer。count-tokens 响应会带
  `x-kiro-token-count-mode: estimate`，不能当作计费级精确值。
- Anthropic prompt-cache 指令会作为前向兼容元数据被接受，但本网关无法
  暴露 Kiro 的缓存计费数据。

生产部署与共享认证要求见
[生产级 provider 设计](../PRODUCTION_PROVIDER_DESIGN.zh.md)。真实客户端
验证证据见
[`E2E_VALIDATION_2026-08-22.md`](../E2E_VALIDATION_2026-08-22.md)。
