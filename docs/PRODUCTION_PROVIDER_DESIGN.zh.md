# kiro-provider v0.5 生产级协议保真设计

> 当前基线：2026-08-27。认证参考为同级目录最新
> `opencode-kiro-auth` v0.20.7，提交 `bae3e14`。本项目复用其公开数据库/锁
> 契约与已验证的刷新、重试、流处理经验，不复制 GPL 私有实现，也不复用其
> 提示词修补逻辑。

## 1. 定位

kiro-provider 是 AWS Kiro/CodeWhisperer 之上的协议网关，目标是提供经过验证
的 OpenAI Responses、Anthropic Messages 与显式开启的旧 Chat 子集。它不是
“接受所有上游字段再尽量猜测”的兼容层。

核心规则：

- 所有外部协议先转换为 `CanonicalRequest`；
- IR 保留角色、消息、内容块、工具声明/调用/结果、reasoning 和来源路径；
- Kiro 输出先转换为严格版本化的 `CanonicalCompletion` / `CanonicalEvent`；
- Kiro 适配器只做结构化降级；无法等价表达时在调用上游前返回字段级 400；
- 默认 `safe` 模式不加入、改写、合并或删除任何模型可见文本；
- Chat 由 `enable_legacy_chat_completions` 独立控制，默认关闭；
- 指令迁移只能显式选择 `legacy-user-prefix`，并计划在 v0.7.0 删除。

## 2. 已实现架构

```text
HTTP auth / body limits / deadline
            │
            ▼
Responses | Messages | explicitly enabled Chat adapters
            │
            ▼
CanonicalRequest + field/source paths
            │
            ▼
capability validation + safe/legacy projection
            │
            ▼
session queue + account scheduler + local auth refresh
            │
            ▼
account-scoped SDK client / configurable HTTP transport
            │
            ▼
Kiro event stream
            │
            ▼
CanonicalCompletion / CanonicalEvent
            │
            ▼
protocol-specific JSON/SSE encoders
```

Responses 与 Messages 都不再经过 Chat 形状的输出中间层。三个入口共享同一
能力校验和 Kiro 管道；流式与非流式出口共享同一 Canonical 状态契约，再分别
编码为 Responses、Messages 或显式开启的 Chat，避免跨协议语义污染。

## 3. 协议保真边界

已删除或禁止：

- `injectSystemPrompt` 一类 user 前缀注入（显式 legacy 指令迁移除外）；
- 相邻同角色合并；
- 重复 assistant 内容清空；
- 尾部 `{` 删除；
- orphan tool、图片省略、thinking mode、继续工具循环等补偿文本；
- 从调用参数推断工具 schema/描述；
- 从模型文本猜测工具调用；
- reasoning、未知 item、`author`/`recipient` 等语义字段的静默丢弃。

Kiro 的单条消息只有一个文本字段：同一消息全部为文本块时，会在 Canonical
IR 中保留块边界，仅在 Kiro 标量边界按原字节、无分隔符拼接；文本块与图片/
文件等非文本块交错时返回 `unsupported_content_block_projection`，并通过
`param` 指向首个不可保真投影的块。连续同角色消息按原顺序独立发送。

当前主要能力：

| 能力 | 行为 |
| --- | --- |
| 普通文本、function/custom 工具 | 结构化映射，保留名称、schema、ID、参数、结果和顺序 |
| system/developer/instructions | safe 400；显式 legacy 仅按原始块用 `\n\n` 前置 |
| `tool_choice: auto` | 支持 |
| `tool_choice: none` | 无未完成工具状态时支持 |
| required/指定工具 | `unsupported_tool_choice` |
| `parallel_tool_calls: false` | 无可调用工具（含 `tool_choice: none`）时作为 no-op 接受；否则 `unsupported_parallel_tool_calls` |
| strict/custom grammar/namespace 身份 | 不弱化、不改名，明确拒绝 |
| Responses 内联文件 | `file_data` + `filename` 映射到 Kiro 原生 document；扩展名结构化拆到 `format`，无法无损表示的名称返回 `invalid_file_name`；`file_id` 明确拒绝 |
| output token limit | 探针确认 Claude Sonnet 5 与 Claude Opus 5 的 1,024–128,000 |
| Stateful Responses | `unsupported_stateful_responses` |
| Kiro Web Search | `unsupported_web_search`，不伪造搜索/引用事件 |

完整矩阵见 [协议兼容文档](PROTOCOL_COMPATIBILITY.md)。

## 4. 双模式指令投影

- `safe`（默认）：禁止模型可见的协议补偿。Kiro 原生
  `additionalContext` 虽会接受合法结构，但 GPT 与 Claude 实测均未保留其中
  的指令内容或优先级，因此指令类角色返回
  `unsupported_instruction_projection`。
- `legacy-user-prefix`：只把每个原始指令文本块用精确 `\n\n` 连接，并前置
  到首个 user 回合。不会恢复其他旧版合并、删除、工具补偿或提示词模板。

启用 legacy 时启动日志只记录模式警告，不记录指令正文。该模式只用于
v0.5.x/v0.6.x 迁移。

## 5. 本地认证、会话亲和与连接复用

默认 `auth_source: "local"` 使用
`~/.config/kiro-provider/accounts.db` 作为唯一认证事实源。已有 OpenCode +
`opencode-kiro-auth` 账号通过 `kiro-provider accounts import` 一次性复制，
之后不再读取 OpenCode 数据库，也不需要跨进程刷新锁：

- 服务空闲时也会主动刷新临近过期的 access token，并先持久化后使用；
- access token 变化时重建 SDK 客户端，只复用账号级 transport；
- 普通账号用量过期后后台调用 Kiro `getUsageLimits` 刷新；
- 已达到已知额度的账号在刷新和 SDK 创建前排除，上游 402 立即持久化并切换；
- 额度复查时间到期后，在模型重试循环外执行权威探测；同账号探测去重、批次
  并发受限，只有权威快照确认恢复才重新加入账号池；
- 永久失效的 refresh credential 会标记为不健康，不进入模型重试轮次；
- 后台维护有独立的间隔、并发和整批超时。

导入不会建立实时链接。相同的会轮换 refresh token 不应同时由独立运行的
OpenCode 插件和 Provider 维护。`auth_source: "opencode-shared"` 仅保留为显式
兼容模式，它会重新引入共享数据库与跨进程所有权，不是默认部署路径。

Provider 自有 SQLite 同时保存凭证、用量、健康、会话亲和与加密 reasoning
回放。默认 `session_affinity_mode: "explicit-only"` 只接受显式会话键：
Responses 的标准 `metadata.zuno_session_id` /
`metadata.kiro_provider_session_id`、兼容 `client_metadata` 或
`prompt_cache_key`，以及 Chat 的 `prompt_cache_key`。Anthropic 暂无经过验证
的显式字段。缺失显式键时，首轮创建新的 Kiro conversation；完整
assistant/tool 输出结束后，Provider 只保存精确输出 lineage 的租户隔离哈希，
后续完整历史命中时复用同一账号与 conversation。绝不从初始 prompt、user
文本或工具参数推导会话身份。

`legacy-initial-input` 只用于迁移，可恢复旧版初始输入亲和推导，但不会改写任何
模型可见内容。数据库只保存不可逆键哈希、账号与 Kiro `conversationId`
绑定，不保存原始会话值或 prompt。

同会话队列防止重叠回合，同账号队列防止并发 Kiro 流，不同账号可并行。
SDK 客户端只在账号、effort 和 access token 均未变化时缓存；token 变化会使用
新凭据重建 SDK 客户端，账号级 transport 继续复用。Kiro 模型调用 socket 默认
新建（`sdk_http_keep_alive: false`）；只有显式开启后才尝试池化复用。

本地状态显示 `overage_count > 0`，或正数 `limit_count` 已被 `used_count`
达到时，账号会在 token 刷新和 SDK 创建前直接排除。上游 HTTP 402 不进入
限流重试，会被持久化并在当前请求内立即排除。HTTP 401 或 invalid-bearer 403
每账号只允许一次强制刷新；刷新后仍失败则在当前请求内排除该账号，并最终返回
明确的 401/403，而不是迭代耗尽后的 500。

已耗尽账号不会因时间到达而直接解禁。`rate_limit_reset` 到期后，Provider
先按需刷新 token，再执行权威额度探测；结果仍耗尽或探测失败时继续排除，并按
`quota_recheck_interval_ms` 安排下次探测。该过程有独立超时和并发上限，不消耗
`max_request_iterations`，也不会把账号送进模型调用试错。

这里承诺“尽可能复用账号、Kiro conversation 与 SDK 对象”，不保证固定一条
TCP socket。缺少显式会话键时仍可复用账号级 SDK/transport 对象，但不会复用
conversation，除非后续完整历史命中已保存的 assistant 输出 lineage。
工具声明、公开名/上游别名和结果关联始终属于当前请求，多个并发会话不会共享
可变工具映射。reasoning 回放会进一步锁死原账号和原 Kiro conversation。

生产默认 `enforce_single_instance: true`，服务绑定端口前取得平台配置目录的
进程锁，避免进程内会话/账号队列和 SDK/socket 池被多个 Provider 静默拆分。
需要多个进程时必须使用独立凭证与状态，或提供外部跨进程串行器。

模型能力按账号通过 Kiro 管理面动态发现，缓存新鲜期、陈旧可用期与请求超时
均可配置；请求只路由到公开精确 wire model 的账号。模型调用默认使用
`runtime.<region>.kiro.dev`；token usage metadata 可立即证明完成，合法
metering 则必须随后 clean EOF 才可证明完成。旧 `q` 方言只保留为显式
诊断/迁移选项。

## 6. 加密 reasoning 回放

完整 Kiro signed-text 或 redacted envelope 使用 AES-256-GCM 加密；Responses
只返回随机 `kr1_...` 令牌，数据库保存令牌哈希而非原始令牌。AAD 绑定租户、
模型、账号、conversation、输出指纹、过期时间与 key ID。


标准 Responses 手工续轮可把返回的 reasoning item（包括 `summary`、`content`
和 `encrypted_content`）原样放入下一次 input。只有有效的 `kr1_...` 令牌具有
回放权威；显示元数据不投影到 Kiro，也不作为明文 reasoning 降级。
默认 TTL 24 小时、最多 10,000 条，事务内清理过期和 LRU。支持环境密钥环；
未配置时原子生成权限 `0600` 的密钥文件。数据库存在未过期记录但缺少对应
密钥时，服务启动失败。跨租户、跨账号、跨会话、过期、篡改、歧义和解密
失败都明确报错，不降级为明文 reasoning。

## 7. Readiness 与日志

- `/health` 是无需鉴权的纯存活检查；
- `/ready` 需鉴权，并检查认证源、活跃账号、Provider 数据库可写、密钥环和
  未过期记录的 key ID 覆盖，同时报告模型目录当前来自 live/stale/static/
  disabled 哪一层；
- 结构化日志记录 projection mode、拒绝字段、reasoning hit/miss/expired、
  账号/conversation 哈希、亲和来源和连接池命中；
- 日志不记录 API key、token、签名、reasoning、工具 payload 或 prompt 正文。

## 8. v0.5.0-rc.4 真实客户端与本地认证门禁

所有测试均使用编译后二进制；客户端只配置标准 base URL、API key 和模型。

| 门禁 | 当前结果 |
| --- | --- |
| 一次导入后的本地认证 | 通过；OpenCode 数据库路径不存在时仍独立刷新故意过期的 access token 与陈旧 usage |
| 官方 OpenAI JavaScript SDK 7.5.0 | 使用 Opus 5 通过 Responses 流式/非流式、显式 Chat、function 工具续轮与直接 Messages JSON/SSE |
| RC.4 官方 SDK 本地认证 E2E | 通过两轮标准 Responses；无需实时共享认证库或跨进程锁 |
| reasoning 重启回放 | RC.3 通过；同账号、同 conversation，服务重启后签名回放成功 |
| OpenCode 1.18.18 Responses | RC.4 在显式 legacy 下通过真实 bash/write/read 工具循环；RC.3 的 Opus 5 Max 工具链、同账号、同 conversation、`effort=max` 结论保留 |
| OpenCode 1.18.18 Chat | RC.3 未重跑；RC.2 阻塞于非标准 `messages.0.cache_control` |
| Codex 0.150.0-alpha.9 | Opus 5 模型校验通过；随后阻塞于 `reasoning.summary` |
| Claude Code 2.1.209 | Opus 5 模型校验通过；随后阻塞于 `context_management` |
| Zuno | 按范围未重跑，且未修改 Zuno 源码或配置；RC.1 只作历史集成证据 |
| Web Search | 明确 `unsupported_web_search`，无伪事件 |

因此可以发布预发布版 `v0.5.0-rc.4` 收集兼容反馈，但不能发布稳定版
`v0.5.0`。不能通过忽略字段、请求补丁、私有 Header 或拼接提示词把上述阻塞
伪装成通过。

详细证据见
[RC.4 本地认证验收报告](audits/kiro-provider-v0.5.0-rc.4-local-auth-maintenance-validation-2026-08-29.md)、
[RC.3 协议验收报告](audits/kiro-provider-v0.5.0-rc.3-opus5-validation-2026-08-27.md)
和 [Kiro 原生探针](audits/kiro-protocol-projection-probe-2026-08-26.md)。

## 9. 部署边界

建议每个凭据所有者运行一个常驻 Provider 进程，并由 systemd 或 Windows
Task Scheduler 监管。生产暴露到非本机网络时仍需要前置代理负责 TLS、请求体
上限、连接/读写超时、速率限制和访问日志脱敏。

默认服务锁只允许一个 Provider 进程拥有同一进程域。若显式关闭该保护，
SQLite 技术上仍只支持同一主机、同一数据库和同一密钥环，但它不会替代跨
进程账号/会话流串行；部署方必须自行提供外部协调。跨主机集群存储不在 v0.5
范围内。Provider 核心已有 readiness、账号级调度和流式清理，但完整
Prometheus/OpenTelemetry 与一等 SIGTERM drain 仍属于后续运维增强。
