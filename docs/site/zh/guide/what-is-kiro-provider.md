# kiro-provider 是什么

本页介绍 kiro-provider 如何使用你的 Kiro 账号、一个请求在其中如何流转，以及它的边界在哪里。

kiro-provider 是运行在你自己机器上的网关。它以你的身份登录 AWS Kiro，保管你添加的每个账号的令牌，并通过编码 Agent 常用的两种接口提供这些账号：OpenAI Responses 和 Anthropic Messages。这样 Codex CLI、Claude Code、Zuno 和官方 SDK 只需配置一个地址和一个密钥，选择账号、续期令牌和转换为 Kiro 格式都在网关中完成。

## 一个请求如何流转

1. **鉴权。** 客户端发送 `api_keys` 中的一个密钥，放在 `Authorization: Bearer` 或 `x-api-key` 中。其他请求在读取请求体之前就会被拒绝。
2. **选择账号。** 请求交给当前最空闲、且能使用该模型的账号。带有会话标识的对话（Claude Code 和 Zuno 都会发送）在原账号有空闲时继续留在该账号上。
3. **选择路径。** Kiro 自己的 Responses 操作能原样接收的 Responses 请求会直接发往那里；其余请求，包括所有 Messages 请求，由 kiro-provider 转换为 Kiro 的对话格式。
4. **返回结果。** 回复以客户端所用接口的格式流式返回。两条路径都无法保留某个字段时，请求会失败并写明该字段，不会悄悄丢弃。
5. **保存状态。** 保存的 Responses 和加密的推理内容存放在本地数据库中，客户端因此可以继续对话、切换模型或推理等级，并在网关重启后恢复会话。

## 一个网关，两种接口

| 路由                             | 用途                                            |
| -------------------------------- | ----------------------------------------------- |
| `POST /v1/responses`             | Codex CLI、Zuno、OpenAI SDK 等 Responses 客户端 |
| `POST /v1/messages`              | Claude Code、Anthropic SDK 等 Messages 客户端   |
| `POST /v1/messages/count_tokens` | Claude Code 的上下文统计（估算值）              |
| `GET /v1/models`                 | 模型选择菜单                                    |
| `GET /health`、`GET /ready`      | 服务管理器和监控                                |
| `POST /v1/chat/completions`      | 较早的客户端，需要手动开启该路由                |

两种接口共用账号、排队和限额，因此 Codex 会话和 Claude Code 会话可以同时使用同一个网关。

## 它保存什么

你的账号、令牌与用量、保存的响应和加密的推理内容都存放在配置目录的 `accounts.db` 中，只有你的用户可以读取。网关日志只记录计数、长度和哈希，从不记录提示词、工具参数或凭据。[数据与网络](../privacy.md)列出了它写入的每个文件和连接的每个主机。

## 它不做什么

- **不承诺与 OpenAI 或 Anthropic 完全一致。** 联网搜索以外的托管工具、后台响应、conversation 对象、远程文件引用和任意 JSON Schema 输出都会以带类型的错误拒绝。[已知限制](../limits.md)列出了这些内容。
- **不共享访问权限。** 它只用于你自己控制的 Kiro 账号，也不会绕过这些账号的用量限制。
- **不依赖 Kiro CLI。** 登录、查找 profile 和续期令牌都由它自己完成。

## 下一步

- [安装](install.md)
- [快速开始](quick-start.md)
- [选择客户端](../clients/index.md)
