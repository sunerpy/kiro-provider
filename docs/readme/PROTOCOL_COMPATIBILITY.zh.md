# 协议兼容范围与迁移

简体中文 · [English](../PROTOCOL_COMPATIBILITY.md)

kiro-provider v0.5 定位为**经过验证的 OpenAI/Anthropic 兼容子集**，而不是
接受上游协议所有字段的实现。默认 `safe` 投影模式会保留客户端文本、角色、
内容块边界、工具身份、顺序和来源路径；Kiro 无法等价表达的保证，会在发起
上游请求前返回 HTTP 400。

Provider 不会添加隐藏提示词、改写客户端指令、合并相邻消息、清空重复
assistant 内容、删除尾部 `{`，也不会为孤立工具、被省略图片、thinking 或
Web Search 生成解释性补偿文本。

## 能力矩阵

| 能力 | v0.5 行为 |
| --- | --- |
| 普通文本与连续同角色回合 | 保持原始顺序直接发送，不合并，也不插入分隔文本。 |
| 同一消息中的多个顶层文本块 | 返回 `unsupported_content_block_projection`。Kiro 只有一个文本字段，直接拼接会抹掉块边界；工具结果内部的文本数组仍保持结构化。 |
| Responses `instructions`；Chat/Responses `system`、`developer`；Anthropic `system` | `safe`：返回 `unsupported_instruction_projection`。`legacy-user-prefix`：仅用 `\n\n` 连接原始文本并前置到首个 user 回合；不会恢复其他旧改写。 |
| function 工具与 Responses custom 工具 | 保留精确声明、公开名称、schema、调用 ID、参数、结果、顺序与来源路径。历史缺少原始声明时返回 `missing_tool_declaration`。 |
| `tool_choice: auto` | 支持。 |
| `tool_choice: none` | 仅在不存在尚未完成的工具状态时支持，否则拒绝。 |
| required/指定工具 | 返回 `unsupported_tool_choice`；Kiro 无法保证。 |
| `parallel_tool_calls: false` | 返回 `unsupported_parallel_tool_calls`。 |
| strict schema、custom grammar、namespace 工具 | `strict: true`、custom `format` 和 namespace 身份都会被拒绝，不会被弱化或改名。 |
| reasoning effort | 保留显式 effort 映射；无法映射的控制项按字段拒绝。 |
| Responses `reasoning.encrypted_content` | Kiro 返回完整签名文本或 redacted envelope 时，响应包含随机 `kr1_...` 令牌，并由本地加密存储支撑。只有签名等不完整事件不会生成令牌。 |
| 图片 | Anthropic base64 图片和 OpenAI data URL 映射到 Kiro。远程 URL、detail 控制、非法媒体、超过 4 张图片或超过 3.75 MiB base64 数据会被拒绝。 |
| 输出 token 上限 | 仅探针确认 `claude-sonnet-5` 变体支持 1,024 到 128,000；其他模型返回 `unsupported_output_token_limit`。 |
| 结构化输出、采样/logprob、文件 | 在取得等价 Kiro 原生能力证据前拒绝；默认纯文本格式可用。 |
| `previous_response_id`、Responses `conversation`、`store: true` | 拒绝；本版本没有服务端 OpenAI response 状态存储。 |
| Kiro 托管 Web Search | 返回 `unsupported_web_search`，不会伪造 `web_search_call` 或引用事件。 |
| Chat `stream_options.include_usage` | 仅流式 Chat 支持；启用后恰好输出一个独立、`choices` 为空的 usage chunk。其他 `stream_options` 字段会被拒绝。 |

受支持对象中的未知嵌套字段也会带字段路径被拒绝。接受后丢弃会造成虚假的
协议兼容声明，因此这里有意采用默认拒绝。

## 投影模式

`protocol_projection_mode` 默认为 `safe`，也可通过
`KIRO_PROVIDER_PROTOCOL_PROJECTION_MODE` 设置。

- `safe`：不加入任何模型可见的兼容文本；指令类角色返回
  `unsupported_instruction_projection`。
- `legacy-user-prefix`：仅用于迁移指令文本。Provider 使用精确的 `\n\n`
  连接原始指令块并前置到首个 user 文本。启动时会输出不含请求正文的结构化
  警告。该模式不会恢复消息合并、内容删除、合成工具文本或其他旧改写。

迁移模式在 v0.5.x、v0.6.x 保留，计划于 v0.7.0 删除。旧 Chat 端点由
`enable_legacy_chat_completions` 独立控制，默认仍关闭。

## 会话亲和模式

`session_affinity_mode` 默认为 `explicit-only`，也可通过
`KIRO_PROVIDER_SESSION_AFFINITY_MODE` 设置。亲和元数据只用于传输路由，绝不
写入模型可见输入。

- Responses 按顺序使用 `metadata.zuno_session_id`、
  `metadata.kiro_provider_session_id`、兼容字段
  `client_metadata.thread_id|session_id|conversation_id`，最后是
  `prompt_cache_key`。
- Chat Completions 只使用 `prompt_cache_key`。
- Anthropic Messages 暂无经过验证的显式亲和字段。

显式键会串行化重叠回合，并持久化选中账号与 Kiro conversation ID。没有
显式键时，每个请求都创建新的 Kiro conversation，同时仍复用账号级调度及
缓存的 SDK/transport 对象。Kiro 模型调用 socket 默认新建；keep-alive 必须显式开启。
因此，不同会话即使 prompt 相同也不会碰撞。

`legacy-initial-input` 临时恢复 v0.4 的 prompt 指纹推导。它会输出不含正文的
启动警告，并且只影响路由；不会启用提示词注入、消息合并或其他协议改写。

## 当前编译后二进制真实客户端状态

2026-08-26 的 RC 门禁使用编译后二进制，没有私有 Header、请求补丁或客户端
提示词补偿；客户端所需的文档化选项会在对应行明确列出：

| 客户端 | v0.5.0-rc.1 结果 |
| --- | --- |
| OpenAI JavaScript SDK 7.5.0 | 通过：Responses 流式/非流式、Chat 流式/非流式、function/custom 工具循环，以及服务重启后的加密 reasoning 回放。 |
| OpenCode 1.18.18 Responses | 仅在显式 `legacy-user-prefix` 且使用 Claude Sonnet 5 时通过。safe 模式会正确拒绝其 developer prompt；GPT 请求还会携带未获原生支持的输出 token 上限。 |
| Zuno 原生 OpenAI Responses | 通过：编译后服务完成工具循环、同会话续轮和两个并行隔离会话，使用标准 `metadata.zuno_session_id`。当前功能路径显式使用 Provider `legacy-user-prefix` 和 Zuno `maxTokens: null`；safe 模式会正确拒绝 Zuno 的 Agent instructions。 |
| OpenCode 1.18.18 Chat | 阻塞：客户端加入了协议未定义的 `messages.0.cache_control`，Provider 不会静默丢弃。 |
| Codex CLI 0.149.0-alpha.4.1 | 在调用 Kiro 前阻塞：客户端发送 `parallel_tool_calls: false`，Kiro 无法保证该语义。 |
| Claude Code 2.1.209 | 在调用 Kiro 前阻塞：客户端发送未支持的 `output_config.format` / `context_management`，随后以非法的 `messages.1.role=system` 重试；Provider 不会丢字段或搬移角色。 |

这些是 RC 兼容性结论，不是应被 Provider 忽略的字段。所有要求的真实客户端
在标准配置下通过之前，稳定版 v0.5.0 的发布门禁保持关闭。

## 加密 reasoning 回放

响应令牌随机且不透明；SQLite 只保存其 SHA-256 派生查询哈希。完整 Kiro
reasoning envelope 使用 AES-256-GCM 加密，AAD 绑定租户、模型、账号、Kiro
conversation、输出指纹、过期时间与 key ID。

回放必须命中同一租户、模型、账号、Kiro conversation 和 assistant/tool 输出
指纹。缺失、过期、歧义、跨账号、跨会话、篡改或解密失败都会明确报错。
回放期间管道不能切换账号；绑定账号临时不可用时返回可重试的
`reasoning_replay_account_unavailable`。

可通过 `KIRO_PROVIDER_REASONING_REPLAY_KEYS` 提供逗号分隔的密钥环，每项格式
为 `key-id:base64url-32-byte-key`（可省略 ID）。首个密钥用于新记录加密，其余
只解密旧记录。未配置环境密钥环时，Provider 会在配置目录原子生成
`reasoning-replay-keys.json`，POSIX 权限设为 `0600`。若数据库中未过期记录
引用了缺失密钥，服务启动失败。

默认 TTL 为 24 小时、最多 10,000 条；过期与 LRU 清理在事务中完成。

## 常见字段级错误

| 错误码 | 含义 |
| --- | --- |
| `unsupported_instruction_projection` | safe 模式无法在不修改 user 文本的前提下承载指令角色。 |
| `unsupported_content_block_projection` | Kiro 无法保留同一消息中多个顶层文本块的边界；`param` 指向首个不可投影块。 |
| `unsupported_parameter` | 指定字段没有经过证明的等价映射；`param` 给出路径。 |
| `unsupported_tool_choice` | 无法保证 required 或指定工具选择。 |
| `unsupported_parallel_tool_calls` | 无法保证仅串行调用工具。 |
| `unsupported_strict_tools` | Kiro 无法保证 strict schema。 |
| `unsupported_custom_tool_format` | 无法保留 custom grammar/format。 |
| `missing_tool_declaration` | 工具历史缺少精确原始声明。 |
| `unsupported_output_token_limit` | 模型或范围没有探针确认的原生映射。 |
| `unsupported_stateful_responses` | 不提供服务端 Responses 状态。 |
| `unsupported_web_search` | 不支持原生 Kiro 搜索/引用事件。 |
| `reasoning_replay_*` | 加密回放的查询、上下文、密钥、过期、完整性或账号绑定失败。 |

## 从 v0.4 迁移

1. 保持 `protocol_projection_mode: "safe"`，运行代表性请求。
2. 删除不支持字段，不要依赖 Provider 接收后忽略。
3. 旧客户端确实依赖 system/developer 投影时，可临时选择
   `legacy-user-prefix`，记录例外并计划在 v0.7.0 前移除。
4. 只有确有需要时才设置 `enable_legacy_chat_completions: true`。
5. 保持 `session_affinity_mode: "explicit-only"`，让有能力的 Responses
   客户端发送稳定 metadata 键；`legacy-initial-input` 只用于临时路由迁移。
6. 将 reasoning 密钥文件/密钥环与 Provider 数据库一起纳入服务备份和恢复。
7. 只有带鉴权的 `/ready` 成功后才导入客户端流量；它会检查活跃账号、数据库
   可写性、密钥环可用性和活动 key ID 覆盖。

支撑这些决策的上游实时证据见
[`../audits/kiro-protocol-projection-probe-2026-08-26.md`](../audits/kiro-protocol-projection-probe-2026-08-26.md)。
编译后二进制的客户端门禁记录见
[`../audits/kiro-provider-v0.5.0-rc.1-validation-2026-08-26.md`](../audits/kiro-provider-v0.5.0-rc.1-validation-2026-08-26.md)。
