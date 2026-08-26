# kiro-provider v0.5 生产级协议保真设计

> 当前基线：2026-08-26。认证参考为同级目录最新
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
session queue + account scheduler + shared auth refresh
            │
            ▼
account-scoped SDK client / keep-alive transport pool
            │
            ▼
Kiro event stream
            │
            ▼
shared response state builder → protocol JSON/SSE
```

Responses 不再经过 Chat 形状的中间转换。三个入口共享同一能力校验和 Kiro
管道，避免每个协议复制账号选择、刷新、重试和流式终态逻辑。

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

Kiro 的单条消息只有一个文本字段，因此同一消息的多个顶层文本块会返回
`unsupported_content_block_projection`，并通过 `param` 指向首个不可投影
块；不会拼接后谎称保留了边界。连续同角色消息则按原顺序独立发送。

当前主要能力：

| 能力 | 行为 |
| --- | --- |
| 普通文本、function/custom 工具 | 结构化映射，保留名称、schema、ID、参数、结果和顺序 |
| system/developer/instructions | safe 400；显式 legacy 仅按原始块用 `\n\n` 前置 |
| `tool_choice: auto` | 支持 |
| `tool_choice: none` | 无未完成工具状态时支持 |
| required/指定工具 | `unsupported_tool_choice` |
| `parallel_tool_calls: false` | `unsupported_parallel_tool_calls` |
| strict/custom grammar/namespace 身份 | 不弱化、不改名，明确拒绝 |
| output token limit | 仅探针确认 Claude Sonnet 5 的 1,024–128,000 |
| Stateful Responses | `unsupported_stateful_responses` |
| Kiro Web Search | `unsupported_web_search`，不伪造搜索/引用事件 |

完整矩阵见 [协议兼容文档](PROTOCOL_COMPATIBILITY.md)。

## 4. 双模式指令投影

- `safe`（默认）：禁止模型可见的协议补偿。Kiro 原生
  `additionalContext` 探针未通过，因此指令类角色返回
  `unsupported_instruction_projection`。
- `legacy-user-prefix`：只把每个原始指令文本块用精确 `\n\n` 连接，并前置
  到首个 user 回合。不会恢复其他旧版合并、删除、工具补偿或提示词模板。

启用 legacy 时启动日志只记录模式警告，不记录指令正文。该模式只用于
v0.5.x/v0.6.x 迁移。

## 5. 共享认证、会话亲和与连接复用

默认 `auth_source: "opencode-shared"` 直接使用同一系统用户的
`~/.config/opencode/kiro.db`：

- 验证必要 schema，不对 OpenCode 数据库执行 Provider migration；
- 实时读取登录、重登录、token 轮换、墓碑、健康和用量变化；
- 使用兼容的每账号刷新锁、锁内重读、先持久化后发布与快照 CAS；
- `accounts import` 只属于显式 `local` 模式的一次性快照。

Provider 自有 SQLite 只保存会话亲和、加密 reasoning 回放和本地兼容模式
数据。会话键来自协议已有字段；缺失时使用初始用户回合的不可逆指纹。数据库
保存账号与 Kiro `conversationId` 绑定，不保存原始 prompt。

同会话队列防止重叠回合，同账号队列防止并发 Kiro 流，不同账号可并行。
SDK 客户端与 keep-alive transport 按账号缓存，token 刷新只更新凭据。这里
承诺“尽可能复用账号、Kiro conversation 与连接池”，不保证固定一条 TCP
socket。reasoning 回放会进一步锁死原账号和原 Kiro conversation。

## 6. 加密 reasoning 回放

完整 Kiro signed-text 或 redacted envelope 使用 AES-256-GCM 加密；Responses
只返回随机 `kr1_...` 令牌，数据库保存令牌哈希而非原始令牌。AAD 绑定租户、
模型、账号、conversation、输出指纹、过期时间与 key ID。

默认 TTL 24 小时、最多 10,000 条，事务内清理过期和 LRU。支持环境密钥环；
未配置时原子生成权限 `0600` 的密钥文件。数据库存在未过期记录但缺少对应
密钥时，服务启动失败。跨租户、跨账号、跨会话、过期、篡改、歧义和解密
失败都明确报错，不降级为明文 reasoning。

## 7. Readiness 与日志

- `/health` 是无需鉴权的纯存活检查；
- `/ready` 需鉴权，并检查认证源、活跃账号、Provider 数据库可写、密钥环和
  未过期记录的 key ID 覆盖；
- 结构化日志记录 projection mode、拒绝字段、reasoning hit/miss/expired、
  账号/conversation 哈希、亲和来源和连接池命中；
- 日志不记录 API key、token、签名、reasoning、工具 payload 或 prompt 正文。

## 8. v0.5.0-rc.1 真实客户端门禁

所有测试均使用编译后二进制；客户端只配置标准 base URL、API key 和模型。

| 门禁 | 当前结果 |
| --- | --- |
| 官方 OpenAI JavaScript SDK 7.5.0 | 通过 Responses/Chat 流式与非流式、function/custom 工具循环 |
| reasoning 重启回放 | 通过；同账号、同 conversation，服务重启后签名回放成功 |
| OpenCode 1.18.18 Responses | 仅显式 legacy + Claude Sonnet 5 通过；工具循环通过 |
| OpenCode 1.18.18 Chat | 阻塞于非标准 `messages.0.cache_control` |
| Codex 0.149.0-alpha.4.1 | 阻塞于 `parallel_tool_calls: false` |
| Claude Code 2.1.209 | 阻塞于 `output_config.format`、`context_management`，以及非法的 `messages.1.role=system` 重试 |
| Web Search | 明确 `unsupported_web_search`，无伪事件 |

因此可以发布预发布版 `v0.5.0-rc.1` 收集兼容反馈，但不能发布稳定版
`v0.5.0`。不能通过忽略字段、请求补丁、私有 Header 或拼接提示词把上述阻塞
伪装成通过。

详细证据见
[当前 RC 验收报告](audits/kiro-provider-v0.5.0-rc.1-validation-2026-08-26.md)
和 [Kiro 原生探针](audits/kiro-protocol-projection-probe-2026-08-26.md)。

## 9. 部署边界

建议每个凭据所有者运行一个常驻 Provider 进程，并由 systemd 或 Windows
Task Scheduler 监管。生产暴露到非本机网络时仍需要前置代理负责 TLS、请求体
上限、连接/读写超时、速率限制和访问日志脱敏。

SQLite 多进程只支持同一主机、同一数据库和同一密钥环；跨主机集群存储不在
v0.5 范围内。Provider 核心已有 readiness、账号级调度和流式清理，但完整
Prometheus/OpenTelemetry 与一等 SIGTERM drain 仍属于后续运维增强。
