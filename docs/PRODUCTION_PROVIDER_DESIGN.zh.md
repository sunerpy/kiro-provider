# kiro-provider 生产级重构设计

> 审视基线：2026-08-22。参考仓库为同级目录
> `opencode-kiro-auth` 的远端最新 `v0.20.6`
> (`13c1a648f66fc80fb5f5f766a3ff9b90c2d3474f`)。

## 1. 目标

把 kiro-provider 收敛为一个协议明确、认证所有权单一、流式资源可控、
可观测且可演进的 Kiro 模型网关：

- Codex 走 OpenAI Responses。
- Claude Code 走 Anthropic Messages。
- OpenCode 优先走 Responses；只有旧 SDK/适配器需要显式开启 Chat
  Completions。
- 默认以 OpenCode 的 `kiro.db` 为唯一认证事实源，并复用与
  `opencode-kiro-auth` v0.20.6 一致的刷新锁、事务和持久化顺序。
- 所有协议共享一个内部请求/响应模型，不各自复制 Kiro 业务逻辑。

## 2. 本轮已落实

| 项目 | 状态 |
| --- | --- |
| `POST /v1/responses` | 默认开放；保留 Codex custom/namespace tool bridge |
| `POST /v1/messages` | 已增加；支持 Anthropic JSON/SSE、工具调用与工具结果 |
| `POST /v1/messages/count_tokens` | 已增加；响应头明确标记 `estimate` |
| `POST /v1/chat/completions` | 默认关闭；仅 `enable_legacy_chat_completions: true` 时开放 |
| Anthropic 鉴权 | 支持 Bearer 与 `x-api-key`，错误 envelope 使用 Anthropic 形状 |
| 流式生命周期 | deadline、client abort、consumer cancel、上游错误均做单终态清理 |
| 服务端依赖环 | 请求生命周期类型已从 `app`/Chat 路由抽离 |
| 慢读回归 | 修正测试事件循环饥饿；应用资源释放用例通过 |
| 零隐式提示词 | 已清除 provider 自行添加的 thinking、工具续接、delegated-task、tool-error 等模型可见文本；不可映射能力显式拒绝 |
| 共享认证 | 默认 `opencode-shared`；实时读取 OpenCode `kiro.db`，兼容上游刷新锁，先持久化后发布，并防止旧刷新覆盖新登录 |
| Schema 边界 | 只验证 v0.20.6 必要表/列，不对 OpenCode 数据库执行 provider 自有 migration |
| `/ready` | 已增加鉴权就绪检查；认证库不可读或无活跃账号时返回 503 |
| 会话亲和 | 从标准客户端字段或初始用户回合生成租户隔离指纹，持久化账号与 Kiro `conversationId`，无需私有 Header/Cookie |
| 调度器 | 已移除进程级全局单队列；同会话串行、同账号串行、不同账号并行，流结束前持续持有账号 lease |
| 连接复用 | SDK 客户端在 token 刷新后继续复用；同账号不同 effort 客户端共享 keep-alive transport |
| 真实客户端验证 | OpenCode 1.18.18、Codex 0.149.0-alpha.4.1、Claude Code 2.1.209 的工具回合已通过；Chat 默认拒绝/显式开启双态已通过 |

认证、协议和真实客户端主链路已达到本项目定义的生产级 provider 核心要求；
部署层仍需要反向代理、进程监管、指标/日志采集和容量规划。

## 3. 客户端协议矩阵

| 客户端 | 首选协议 | Base URL | 默认状态 |
| --- | --- | --- | --- |
| Codex | OpenAI Responses | `http://host:port/v1` | 开放 |
| Claude Code | Anthropic Messages | `http://host:port` | 开放 |
| OpenCode `@ai-sdk/openai` | Responses | `http://host:port/v1` | 开放 |
| OpenCode `@ai-sdk/openai-compatible` | Chat Completions | `http://host:port/v1` | 必须显式开启 |
| 旧 OpenAI SDK | Chat Completions | `http://host:port/v1` | 必须显式开启 |

Chat Completions 被定义为兼容层，不再是系统内部的事实协议。内部 Kiro
管道暂时仍以 Chat-shaped canonical wire 表达，后续应继续下沉为与外部协议
无关的 `CanonicalRequest` / `CanonicalEvent`。

## 4. 已实现的共享认证模型

`accounts import` 的确只是一次性快照，因此它现在只属于显式
`auth_source: "local"` 兼容模式。生产默认值
`auth_source: "opencode-shared"` 不复制 token，而是把
`~/.config/opencode/kiro.db`（或配置覆盖路径）作为唯一认证事实源：

```text
OpenCode + opencode-kiro-auth ─┐
                              ├─ same kiro.db + same per-account lock path
kiro-provider ────────────────┘
              │
              └─ provider accounts.db: affinity/state only
```

Provider 的共享认证实现包含：

- 启动时验证 `accounts`、`removed_accounts` 和 v0.20.6 必要列；不做
  provider 自有 migration；
- 每次管道选择前重新读取共享账号，及时看到新登录、重新登录、token
  轮换、墓碑、健康和用量变化；
- `BEGIN IMMEDIATE`、SQLite busy timeout 与有界退避；
- 与上游一致的每账号 refresh lock 文件位置、过期时间、等待上限和退避；
- 获取锁后重新读取账号，避免拿旧快照刷新；
- 刷新结果先持久化，再发布给请求；
- 以完整 token/login 快照做 compare-and-swap，旧的在途刷新无法覆盖更新
  的重新登录或 token 轮换；
- 同进程内同账号刷新去重，跨进程由共享锁去重；
- 账号选择、限流和健康状态写回同一个 OpenCode 数据库。

`GET /ready` 会实际读取配置的认证源并要求至少一个活跃账号。Schema 不兼容、
数据库缺失或没有可用账号时返回 503/启动失败，而不是回退到陈旧快照。

## 5. 许可与演进边界

当前 provider 保持 MIT，`opencode-kiro-auth` 为 GPL-3.0-or-later。因此本项目：

- 不 import `@sunerpy/opencode-kiro-auth/dist/...` 私有子路径；
- 不复制其 GPL 实现；
- 只实现本机共享数据库、锁文件和刷新持久化所需的协议兼容行为；
- 对不认识的未来 schema 默认拒绝，而不是猜测迁移。

如果上游未来提供稳定、版本化且许可兼容的 headless API、sidecar 或
双重许可 `auth-core`，可以把当前兼容层替换为该公开边界。理想接口至少应
覆盖候选账号、fresh-auth lease、限流/失败回报和释放；在此之前，现有实现
已解决同机 OpenCode 与 provider 并行运行时最关键的 token 轮换竞争。

## 6. 内部架构目标

```text
HTTP auth / limits / deadline
          │
          ▼
Protocol adapters
Responses | Messages | explicit legacy Chat
          │
          ▼
CanonicalRequest / CanonicalEvent
          │
          ▼
Account scheduler + shared auth runtime
          │
          ▼
Kiro SDK transport
```

要求：

- 协议适配器只做 schema、错误 envelope 和事件序列转换；
- 账号选择、刷新、重试、限流分类不能复制到各协议；
- 流式终态只有一个 owner；
- HTTP 200 后的错误必须用对应协议可观察的流事件表达；
- 任何无法严格映射的语义必须显式降级或拒绝，不能静默伪造。
- provider 不得自行生成模型可见的“继续调用工具”“任务优先级”“thinking
  mode”等文本；客户端原始 system/message/tool 文本除外。

## 7. 已完成的 P0 与剩余运维 P1

### 已完成 P0：共享认证运行时

默认共享 OpenCode 认证库、跨进程刷新锁、锁内重读、先持久化后发布和
防旧刷新覆盖新登录均已实现并有并发回归测试。`local` 模式只作为明确选择的
兼容路径保留。

### 已完成：标准字段会话亲和与账号级调度

本轮已把 `acquirePipelineQueue` 替换为两个 keyed queue：

- 会话队列：防止同一逻辑会话并发修改上下文；
- 账号队列：同一 Kiro 账号串行，不同账号可并行；
- 流式响应在完成、错误、超时或取消前持续持有账号 lease；
- 限流/不健康切换会重绑账号并更换 Kiro `conversationId`；
- SQLite 持久化跨进程逻辑绑定，队列与物理连接池仍是进程内资源。

会话识别不要求客户端定制：Responses 优先使用
`client_metadata`/`prompt_cache_key`，Chat 使用
`prompt_cache_key`/`user`，Messages 使用 `metadata.user_id`，缺失时回退到
首个用户回合指纹。这里只承诺尽可能复用，不承诺固定一条物理 TCP socket。

### P1：可观测性

`/health` 只证明进程存活；需鉴权的 `/ready` 已验证认证库可读且至少有一个
活跃账号。完整托管服务仍应补充：

- 结构化日志：request id、protocol、model、account hash、attempt、终态；
- Prometheus/OpenTelemetry 指标；
- refresh、rate limit、queue wait、TTFT、stream duration、client abort；
- 日志和 trace 中的 token、authorization、tool payload 脱敏。

### P1：优雅停机

进程监管层应先停止接收新流量并提供有界 drain 窗口。本项目后续仍应增加
一等的 SIGTERM drain：等待活动流、取消剩余 SDK iterator、释放账号 lease、
关闭认证库与状态库。

### P1：传输层边界

Bun 1.3.14 下暂停读取的慢客户端可能让 TCP Send-Q 超出应用层清理窗口。
生产部署必须在前置代理配置：

- TLS；
- 最大请求体；
- 连接/读取/发送超时；
- 并发与速率限制；
- 可信代理与访问日志脱敏。

## 8. 协议降级原则

- Responses custom/namespace tool 必须原子恢复，不能泄漏内部 alias。
- Messages signed thinking 不可伪造，因此当前不向客户端输出 thinking block。
- Messages `tool_choice: any/tool` 与 `disable_parallel_tool_use: true`
  已返回 capability 错误，不再用提示词模拟强约束。
- Messages `max_tokens` 当前只能校验，Kiro 传输层没有可映射的精确输出
  token 上限，不能对外承诺硬限制。
- Count Tokens 是估算值，响应头必须保留。
- 未知输入字段可以前向兼容地忽略；已知字段的畸形 payload 必须 400。
- Responses 中 OpenAI 托管的 `web_search` 等工具声明可以为 Codex wire
  兼容而接受，但不会暴露给 Kiro，也不会用提示词模拟托管执行。
- Responses `previous_response_id` / `conversation` 在没有真实响应状态存储时
  返回 `unsupported_stateful_responses`，不能静默忽略。
- 旧 Chat 只有显式配置才存在，避免无意扩大攻击面和兼容负担。

## 9. 实施状态

### 阶段 A：协议与边界收敛（已完成）

- Responses 保持默认；
- Messages/Claude Code 接入；
- Chat 显式开关；
- 流式终态和慢读回归；
- 零 provider 自有提示词；
- 标准字段会话亲和、持久账号/`conversationId` 绑定；
- 账号级调度与 token 刷新后连接池复用；
- 文档明确能力与限制。

### 阶段 B：共享认证（已在 provider 内完成）

- 默认实时使用 OpenCode `kiro.db`；
- 复用兼容的 refresh lock、事务和持久化顺序；
- `accounts import` 已降级为 local 兼容模式的一次性快照并显示警告；
- 上游未来若发布稳定 headless API/auth-core，可替换当前兼容层。

### 阶段 C：运维（部分完成）

- readiness 已完成；metrics、trace 待补；
- 一等 graceful shutdown 待补；
- 反向代理参考配置和故障注入测试。

### 阶段 D：发布门禁（核心链路已完成）

- Codex Responses 工具回合：已通过；
- Claude Code Messages 工具回合：已通过；
- OpenCode Responses 工具回合与同 session 续聊：已通过；
- legacy Chat 默认拒绝、显式开启后推理：已通过；
- 两个独立 auth runtime 并发刷新只产生一次网络刷新：已通过；
- 在途旧刷新不能覆盖新登录：已通过；
- DB busy、有界重试、200 后流错误、慢读和客户端断开：已有回归覆盖；
- SIGTERM 完整 drain：待补；
- 二进制和 npm 包的许可清单。

## 10. “生产可用”的验收定义

| 条件 | 当前状态 |
| --- | --- |
| 与 OpenCode 共用认证事实源 | 已完成 |
| refresh token 跨进程锁、先持久化后发布、防旧刷新覆盖新登录 | 已完成并测试 |
| 多账号不再被全局单队列串行 | 已完成 |
| Responses、Messages、显式 Chat 真实端到端 | 已完成，见 E2E 记录 |
| readiness | 已完成 |
| 指标、trace、结构化生产日志 | 部署侧需补/项目待增强 |
| SIGTERM 有界 drain | 项目待增强；当前应由进程监管与流量摘除配合 |
| 慢读连接硬超时 | 必须由前置反向代理保证 |
| MIT/GPL 边界 | 已明确，不链接或复制 GPL 私有实现 |

因此，本轮代码可作为生产部署的 provider 核心使用，并已通过真实标准客户端
链路；但在没有反向代理、进程监管、外部指标/日志和 drain 策略时，不应宣传为
“零运维的一体化托管服务”。
