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
| 同一消息中的多个顶层文本块 | 纯文本块在统一请求中保持独立，只在 Kiro 标量文本边界按原字节无分隔拼接。多个文本块与非文本内容交错时返回 `unsupported_content_block_projection`；工具结果内部的文本数组仍保持结构化。 |
| Responses `instructions`；Chat/Responses `system`、`developer`；Anthropic `system` | `safe`：返回 `unsupported_instruction_projection`。Kiro 虽接受合法 `additionalContext` 结构，但 GPT 与 Claude 实测均未保留其中的指令内容或优先级。`legacy-user-prefix`：仅用 `\n\n` 连接原始文本并前置到首个 user 回合；不会恢复其他旧改写。 |
| function 工具与 Responses custom 工具 | 保留精确声明、公开名称、schema、调用 ID、参数、结果、顺序与来源路径。历史缺少原始声明时返回 `missing_tool_declaration`。 |
| `tool_choice: auto` | 支持。 |
| `tool_choice: none` | 仅在不存在尚未完成的工具状态时支持，否则拒绝。 |
| required/指定工具 | 返回 `unsupported_tool_choice`；Kiro 无法保证。 |
| `parallel_tool_calls: false` | 仅在没有可调用工具（包括 `tool_choice: none`）时作为无副作用字段接受，否则返回 `unsupported_parallel_tool_calls`。 |
| strict schema、custom grammar、namespace 工具 | `strict: true`、custom `format` 和 namespace 身份都会被拒绝，不会被弱化或改名。 |
| reasoning effort | 保留显式 effort 映射；Opus 5 的 `low/medium/high/xhigh/max` 已通过原生 `output_config.effort` 实时探针确认，无法映射的控制项按字段拒绝。 |
| Responses reasoning summary | 仅省略 GPT 5.6 Sol 返回的精确 `...` 或 `…` 占位内容。Opus reasoning 与 Sol 的任何非占位 reasoning 均保留；请求加密回放时仍返回可回放的不透明 item，只是可见 summary 为空。 |
| Responses `reasoning.encrypted_content` | Kiro 返回完整签名文本或 redacted envelope 时，响应包含随机 `kr1_...` 令牌，并由本地加密存储支撑。只有签名等不完整事件不会生成令牌。 |
| 图片 | Anthropic base64 图片和 OpenAI data URL 映射到 Kiro。远程 URL、detail 控制、非法媒体、超过 4 张图片或超过 3.75 MiB base64 数据会被拒绝。 |
| Responses 内联文件 | 带 `file_data` 与 `filename` 的 `input_file` 映射到 Kiro 原生 document 结构，不会插入文件名或内容说明文本。Canonical 请求保留原始文件名；降级时把已识别的末尾扩展名放入独立 `format` 字段。剩余名称必须为 1–200 个 ASCII 字母数字、空格、`-`、`_`、圆括号或方括号，且不能有首尾或连续空格；任何需要其他有损改名的输入都返回 `invalid_file_name`。支持原始 base64 或 base64 data URL，格式为 `csv`、`doc`、`docx`、`html`、`md`、`pdf`、`txt`、`xls`、`xlsx`。无状态 Provider 无法解析 OpenAI 文件存储，因此拒绝 `file_id`。 |
| 输出 token 上限 | 已探针确认 `claude-sonnet-5` 与 `claude-opus-5` 变体支持 1,024 到 128,000；其他模型返回 `unsupported_output_token_limit`。 |
| 结构化输出与采样/logprob 控制 | 在取得等价 Kiro 原生能力证据前拒绝；默认纯文本格式可用。 |
| `previous_response_id`、Responses `conversation`、`store: true` | 拒绝；本版本没有服务端 OpenAI response 状态存储。 |
| Kiro 托管 Web Search | 返回 `unsupported_web_search`，不会伪造 `web_search_call` 或引用事件。 |
| Chat `stream_options.include_usage` | 仅流式 Chat 支持；启用后恰好输出一个独立、`choices` 为空的 usage chunk。其他 `stream_options` 字段会被拒绝。 |
| 流完成语义 | 带 token usage 的 metadata 是立即生效的权威完成证据。当前 Kiro runtime 也会用合法 metering 事件结束成功流，但只有其后出现 clean EOF 才接受该证据。普通 EOF、只有 context 的流、空或非法 metering、嵌入式上游错误、未知事件、缺少工具身份或不完整/非法工具参数都会明确失败；工具事件也必须结构完整，非流式请求会在配置上限内重试。 |

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
显式键的标准客户端在重传完整历史时仍可安全续轮：完整 assistant/tool 输出
结束后，Provider 只持久化该精确输出 lineage 的租户隔离指纹；下次请求最新
assistant 输出命中时复用对应账号/conversation。首轮和未命中的历史创建新的
Kiro conversation。Provider 不会哈希 user prompt 或工具参数来猜测身份。
Kiro 模型调用 socket 默认新建；keep-alive 必须显式开启。因此，不同会话即使
prompt 相同也不会碰撞。

已知额度耗尽的账号会在 token 刷新或创建 SDK 前排除。上游 HTTP 402 会立即
排除并持久化该账号，同一请求不再重试。持久化复查时间到期后，Provider 会在
模型重试循环之外执行有界、同账号去重的 Kiro `getUsageLimits` 探测；只有更新
且精确的权威快照低于额度时才解除排除，失败或仍耗尽只推进下次复查时间。
`last_sync` 顺序可防止旧 Provider 探测覆盖 OpenCode 更新的用量。HTTP 401 或
invalid-bearer 403 对每个账号只强制刷新一次；继续失败时，本请求剩余阶段不再
选择该账号。access token 变化时重建 SDK 客户端，但账号级 transport 仍可复用。

编译服务默认持有单进程锁，因为账号/会话队列、SDK 客户端和 socket 池都属于
进程内状态。关闭 `enforce_single_instance` 或使用不同锁路径时，必须保证
凭证/状态彼此独立，或提供外部跨进程串行器。

`legacy-initial-input` 临时恢复 v0.4 的 prompt 指纹推导。它会输出不含正文的
启动警告，并且只影响路由；不会启用提示词注入、消息合并或其他协议改写。

## 当前编译后二进制真实客户端状态

RC.4 新增 Provider 自有且独立的认证生命周期。编译后二进制从真实 OpenCode
账号一次性导入，随后在配置的 OpenCode 数据库路径不存在时，仍刷新故意过期的
access token 与陈旧 usage，并通过官方 OpenAI SDK Responses 和真实 OpenCode
工具循环。该结果证明认证独立性，不改变下列 RC.3 协议/客户端兼容性结论。

2026-08-27 的 RC.3 门禁使用编译后二进制，没有私有 Header、请求补丁或客户端
提示词补偿；客户端所需的文档化选项会在对应行明确列出：

| 客户端 | v0.5.0-rc.3 结果 |
| --- | --- |
| OpenAI JavaScript SDK 7.5.0 | 使用 Opus 5 通过：Responses 流式/非流式、显式开启的 Chat、function 工具续轮、直接 Messages JSON/SSE，以及 128,001 的精确越界拒绝。 |
| OpenCode 1.18.18 Responses | 显式 `legacy-user-prefix` 下使用 `claude-opus-5-max` 通过：真实 bash→read 工具循环、同一账号、同一 Kiro conversation、`effort=max`。一个辅助 reasoning-summary 请求被明确拒绝，但不影响主命令成功。 |
| OpenCode 1.18.18 Chat | RC.3 未重跑；RC.2 仍因客户端加入非标准 `messages.0.cache_control` 而阻塞。 |
| Codex CLI 0.150.0-alpha.9 | Opus 5 模型校验通过；在调用 Kiro 前被没有原生等价能力的 `reasoning.summary` 阻塞。 |
| Claude Code 2.1.209 | Opus 5 模型校验通过；在调用 Kiro 前被未支持的 `context_management` 阻塞。 |
| Zuno 原生 OpenAI Responses | 按明确范围未修改也未重跑。RC.1 只保留为历史集成说明，不视为新的 RC.3 通过。 |

这些是 RC 兼容性结论，不是应被 Provider 忽略的字段。所有要求的真实客户端
在标准配置下通过之前，稳定版 v0.5.0 的发布门禁保持关闭。

## 加密 reasoning 回放

响应令牌随机且不透明；SQLite 只保存其 SHA-256 派生查询哈希。完整 Kiro
reasoning envelope 使用 AES-256-GCM 加密，AAD 绑定租户、模型、账号、Kiro
conversation、输出指纹、过期时间与 key ID。

按标准 Responses 手工续轮契约，客户端可将返回的 reasoning item（包括
`summary` 与 `content`）原样放入下一次 input。有效的
`encrypted_content: "kr1_..."` 令牌仍是唯一权威；可见元数据不会投影到
Kiro，也绝不会作为明文 reasoning 降级。

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
| `unsupported_instruction_projection` | Kiro 接受被测结构化字段，却没有向模型暴露其指令内容或优先级；safe 模式无法在不修改 user 文本的前提下承载指令角色。 |
| `unsupported_content_block_projection` | Kiro 无法保留多个文本块与非文本内容交错时的顺序；`param` 指向首个不可投影文本块。 |
| `unsupported_file_reference` | 无状态 Provider 无法解析 Responses `file_id`；应发送内联 `file_data` 与 `filename`。 |
| `invalid_file_name` | 文件名无法在不有损改写的前提下表示为 Kiro 原生 `name` 与 `format`；`param` 指向 `filename`。 |
| `unsupported_file_format` / `invalid_file_data` | 内联文件格式或 base64 数据无法映射为 Kiro 原生 document。 |
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
| `quota_exhausted`（HTTP 402） | 所有其他条件合格的账号均已达到已知额度。耗尽账号在刷新/创建 SDK 前被拒绝；上游 402 也会立即持久化并排除该账号。 |
| 上游认证错误（HTTP 401/403） | 每个合格账号的一次强制刷新仍无法恢复认证。Provider 保留原始认证状态，不再返回 `max_request_iterations` HTTP 500。 |

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
8. 保持 `runtime_endpoint_mode: "kiro-runtime"`、
   `dynamic_model_catalog: true` 与 `enforce_single_instance: true`；只有部署
   已取得明确证据并提供外部协调时才改变这些生产默认值。

支撑这些决策的上游实时证据见
[`../audits/kiro-protocol-projection-probe-2026-08-26.md`](../audits/kiro-protocol-projection-probe-2026-08-26.md)。
编译后二进制的客户端门禁记录见
[`../audits/kiro-provider-v0.5.0-rc.3-opus5-validation-2026-08-27.md`](../audits/kiro-provider-v0.5.0-rc.3-opus5-validation-2026-08-27.md)。
