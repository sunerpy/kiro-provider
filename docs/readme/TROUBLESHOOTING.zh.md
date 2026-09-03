# 排障手册

简体中文 · [English](../TROUBLESHOOTING.md)

面向运维的"症状优先"手册。每一条都给出应查看的信号（审计事件、
`accounts list --details` 的可用性取值、或 HTTP 状态码与 `error.code`）、
原因与处置办法。涉及的配置项在 [CONFIGURATION.zh.md](CONFIGURATION.zh.md)；
流内错误码定义见 [STREAM_ERROR_CONTRACT.md](../STREAM_ERROR_CONTRACT.md)。

## 信号在哪里

- **审计日志。** stderr 上每行一个 JSON 对象。`log_level`（默认 `info`）是
  输出的最低级别；`debug` 会开启可选的 `request_shape` 诊断事件。字段只包含
  计数、布尔值、枚举标签以及 16 位十六进制的 `auditHash`
  （`account_hash`、`conversation_hash`、`detail_hash`）；日志绝不携带
  提示词正文、工具参数、令牌或签名。
- **`kiro-provider accounts list --details`**（或 `--json`）。`AVAILABILITY`
  列是每个账号在选择器眼中的状态：

  | 取值 | 含义 |
  | --- | --- |
  | `available` | 健康、未限流、额度未耗尽。 |
  | `rate-limited` | `429`/退避窗口生效中，持续到 `RECHECK_AT`。 |
  | `quota-exhausted` | Kiro 报告额度已用完；到期探测确认新周期后自动回池。 |
  | `overage-blocked` | 健康且额度未耗尽，但付费超额次数超过 `overage_threshold`，被 `stop_on_overage` 排除。 |
  | `unhealthy` | 因临时原因被标记不健康（`HEALTH` 为 `unhealthy`）。 |
  | `needs-relogin` | refresh token 或 OIDC 客户端已永久失效；只有 `accounts relogin` 能恢复。 |

- **HTTP 状态码与 `error.code`。** OpenAI 形态的路由返回
  `{ "error": { "type", "code", "message" } }`；`/v1/messages` 返回 Anthropic
  信封，其中额度 `402` 会映射为 `429 rate_limit_error`，Provider 的错误码
  保留在 message 文本中。

### systemd 用户服务的 `journalctl` 查询模板

审计日志就是服务的 stderr，因此 journal 就是日志。`-o cat` 只输出消息体，
每一行都是可解析的 JSON。

```bash
# 最近 200 行，便于人工阅读
journalctl --user -u kiro-provider.service -n 200 --no-pager

# 最近一小时的 warn / error
journalctl --user -u kiro-provider.service --since -1h -o cat --no-pager \
  | grep -E '"level":"(warn|error)"'

# 实时跟踪某一类事件
journalctl --user -u kiro-provider.service -f -o cat \
  | grep --line-buffered -F '"event":"sdk_stream_terminal"'

# 按账号哈希统计令牌刷新失败（需要 jq）
journalctl --user -u kiro-provider.service --since -1d -o cat --no-pager \
  | grep -F '"event":"account_token_refresh_failed"' \
  | jq -r '[.timestamp, .account_hash, .error_code, .refresh_token_dead] | @tsv'

# 统计当天各种终止来源的数量
journalctl --user -u kiro-provider.service --since today -o cat --no-pager \
  | grep -F '"event":"sdk_stream_terminal"' \
  | jq -r '.terminal_provenance' | sort | uniq -c

# 查看某个账号的全部事件（`accounts list --json` 里的 id 不是审计哈希；
# 从任意提到该账号的事件里复制 `account_hash`）
journalctl --user -u kiro-provider.service --since -1d -o cat --no-pager \
  | grep -F '"account_hash":"0123456789abcdef"'
```

不使用 systemd 时，启动 `kiro-provider serve` 时把 stderr 重定向到文件，再
用同样的 `grep`/`jq` 过滤即可。

## 账号与额度

### 账号显示 `needs-relogin`；日志出现 `account_token_refresh_failed`

- **查看：** `accounts list --details` 的 `AVAILABILITY` 为 `needs-relogin`；
  审计事件 `account_token_refresh_failed`（`warn`），其中
  `refresh_token_dead: true`，`error_code` 形如 `invalid_grant`、
  `InvalidGrantException`、`ExpiredTokenException`、`InvalidTokenException`；
  后台维护轮次会以 `account_maintenance_token_refresh_failed` 记录同一状况。
- **原因：** Kiro 的令牌服务拒绝了 refresh token 或 OIDC 客户端注册本身。
  access token 类错误（`bearer token ... is invalid`）**不是**永久性的，
  会通过强制刷新处理；只有 refresh-dead 标记才会停用账号。
- **处置：** `kiro-provider accounts relogin <id|email>`。账号保留内部 ID
  与会话亲和记录。`NETWORK_ERROR` 或裸 `HTTP_<status>`（代理/WAF 返回的
  HTML、空响应）这类临时 `error_code` 绝不会把账号标记为死亡：它会先产生一次
  `account_token_refresh_retry`，然后流水线切换账号，维护循环稍后重试。
  因此 `refresh_token_dead: false` 的含义是"去查网络或代理"，而不是
  "重新登录"。

### 某行的邮箱是占位符 `builder-id@aws.amazon.com`

- **查看：** `accounts list` 的 `EMAIL` 列；`login` 命令曾打印
  `Warning: Kiro usage did not include an account email; storing the
  placeholder ...`。
- **原因：** IAM Identity Center / Builder ID 的设备码流程不返回邮箱；Provider
  从 Kiro `getUsageLimits` 的响应中补齐。若该查询失败或响应不含 `email`，
  就会保存占位符。
- **处置：** 用量接口可达后执行 `kiro-provider accounts refresh <id>`，下一次
  成功的用量同步会更新邮箱。占位符不影响使用（选择器按账号 ID 工作），但对
  占位符行执行 `accounts relogin` 时会接受任意 Kiro 身份，请先确认这一行
  就是你想重新认证的账号。多个占位符行无法靠邮箱区分，请使用 `ID` 列。

### `quota-exhausted` 与 `overage-blocked`；`402 quota_exhausted` 与 `402 paid_overage_blocked`

- **查看：** `accounts list --details` 的 `AVAILABILITY`、`USAGE`、`OVERAGE`
  列；审计事件 `quota_exhausted_account_persisted`（`warn`，
  `account_hash`、`recheck_after`）、`quota_exhausted_accounts_excluded`
  （`info`，`account_count`）、`quota_exhausted_account_recovered`（`info`）；
  HTTP `402`，`error.code` 为 `quota_exhausted` 或 `paid_overage_blocked`
  （`/v1/messages` 上是 `429 rate_limit_error`，错误码在 message 中）。
- **原因：**
  - `quota-exhausted`：Kiro 报告该账号额度已用完（上游 `402`，或用量快照
    达到上限）。账号仍然健康，只有到期的权威用量探测确认新额度周期后才
    回池（`quota_recheck_interval_ms`，或 Kiro 报告的重置时间）。
  - `overage-blocked`：账号仍有额度或处于付费超额，但 `stop_on_overage`
    （默认 `true`）会排除超额次数超过 `overage_threshold`（默认 `0`）的
    账号。这是选择门禁，不是健康信号；下一次用量同步会重新评估。
  - `402 quota_exhausted`：所有本可用的账号都已耗尽。
  - `402 paid_overage_blocked`：所有本可用的账号都只因超额门禁被排除。
- **处置：** 额度耗尽时等待重置（`Retry-After` 头与
  `rate_limit_wait_for_reset` 给出等待时长）或增加账号。超额阻塞时需要
  明确决策：设置 `stop_on_overage: false` 表示有意消耗付费超额，或提高
  `overage_threshold`。不要把账号标记为不健康，它并没有问题。

### `503 no_healthy_accounts` 或 `503 upstream_token_refresh_failed`

- **查看：** HTTP `503`，`error.code` 为 `no_healthy_accounts`
  （"All accounts are unhealthy or rate-limited"）或
  `upstream_token_refresh_failed`（"Token refresh failed for every usable
  Kiro account"）；审计事件 `account_token_refresh_failed` /
  `account_token_refresh_retry`、`rate_limit_wait_for_reset`
  （`wait_ms`、`remaining_ms`）；以及 `accounts list --details` 中每个账号
  的原因。
- **原因：** `no_healthy_accounts` 表示在 `request_timeout_ms` 内没有账号通过
  选择：全部处于 `rate-limited`、`unhealthy`、`needs-relogin`、
  `quota-exhausted` 或 `overage-blocked`，或者剩余账号无法使用该模型
  （`account_model_unavailable`）。若最早的限流重置时间落在请求期限内，
  流水线会等待而不是直接失败。`upstream_token_refresh_failed` 表示本次请求中
  每个候选账号的 access token 刷新都失败了；同时影响所有账号的网络或代理
  故障正好会产生这种结果。
- **处置：** 先看可用性列。`needs-relogin` → `accounts relogin`；
  `rate-limited` → 等到 `RECHECK_AT`；`overage-blocked` → 见上一条。对于
  `upstream_token_refresh_failed`，检查 `proxy_url` 与出网连通性，然后执行
  `kiro-provider accounts refresh --all` 确认令牌端点重新可达。`GET /ready`
  返回 `no_active_accounts` 是同一状况在就绪探针上的表现。

## 流式请求

### `502 upstream_stream_incomplete` / `upstream_stream_error`，以及发布前重试事件

- **查看：** 非流式请求返回 HTTP `502`，`error.type` 为 `upstream_error` 并带
  错误码；流式请求在终止帧中携带同一错误码（Responses 为
  `response.failed`，Chat 为 `error` 帧，Anthropic 为 `overloaded_error`）。
  审计日志中事故本身是 `sdk_stream_upstream_error`（`warn`，含
  `error_code`、`error_disposition`、`error_type`、消息哈希、
  `raw_event_count`、`last_event_type`、`event_type_counts`）或
  `sdk_stream_idle_timeout`（`warn`，`idle_timeout_ms`）。围绕它，流韧性层
  会输出：

  | 事件 | 级别 | 字段 | 含义 |
  | --- | --- | --- | --- |
  | `sdk_stream_attempt_retry` | `warn` | `attempt`、`max_attempts`、`error_code`、`same_account`、`account_hash` | 某次尝试在第一个语义事件送达客户端之前失败；流水线正在重试（先同一账号，再换账号）。尚未发布任何内容，客户端看不到错误。 |
  | `sdk_stream_attempts_exhausted` | `warn` | `attempt`、`max_attempts`、`error_code`、`account_hash` | `stream_max_attempts` 已用尽；最后一次失败成为客户端可见的 `502` 或流内错误。 |
  | `sdk_stream_empty_completion_retry` | `info` | `attempt`、`max_attempts`、`account_hash` | Kiro 完成了流但没有任何推理、文本或工具输出；`retry_empty_completion` 在同一账号上多花一次尝试。 |
  | `sdk_stream_transport_error_after_completion` | `info` | `error_code`、`account_hash`、`completion_witnessed` | 在权威完成见证（token 用量或有效的 metering 事件）**之后**传输层失败。已完成的轮次照常交付；错误只记录、不上抛。 |

- **原因：** `upstream_stream_error` 是读取器、解码器、传输或内嵌上游错误；
  `upstream_stream_incomplete` 是没有完成见证的干净 EOF。按契约两者都是
  临时性错误。如果看到 `502` 但之前没有 `sdk_stream_attempt_retry`，说明
  失败发生在第一个语义事件已经发布之后，此时 Provider 永不重试（可能重复
  文本或重复工具副作用）。
- **处置：** 下游以相同会话键发起替换尝试重试（见契约）。运维侧，同一个
  `account_hash` 上集中出现 `sdk_stream_attempts_exhausted` 指向该账号或
  区域；所有账号都出现则指向网络或代理。提高 `stream_max_attempts`
  （最大 `10`）可换来更多发布前重试，代价是延迟；`stream_idle_timeout_ms`
  决定多久没有事件视为空闲。

### 解读 `sdk_stream_terminal`："助手宣布了下一步然后就停了"

每个流结束时恰好输出一条 `sdk_stream_terminal`（`info`）。字段：
`terminal_provenance`、`completion_witnessed`、`witness_kind`、
`reasoning_chars`、`visible_chars`、`tool_count`、`tool_intent_open`、
`finish_reason_synthesized`，以及 `account_hash` 和 `conversation_hash`。

| `terminal_provenance` | 发生了什么 | 责任方 |
| --- | --- | --- |
| `normal_complete` | Kiro 发送了完成见证，流干净地关闭。 | 无：这是 Kiro 结束本轮。 |
| `idle_timeout` | 超过 `stream_idle_timeout_ms` 没有上游事件。 | 传输 / 上游停滞。 |
| `upstream_error` | SDK 读取器或 Kiro 在流中报告错误。 | 传输 / 上游。 |
| `consumer_cancel` | 客户端在流结束前关闭了响应。 | 客户端（自身超时或用户取消）。 |
| `external_abort` | Provider 主动中止上游：`request_timeout_ms` 到期、关停或锁被破坏。 | Provider 配置或生命周期。 |

当用户反馈"模型说了*接下来我会运行测试*然后就停了"：

1. 找到该轮次的 `sdk_stream_terminal`。
2. `terminal_provenance: normal_complete`、`completion_witnessed: true` 且
   `tool_count: 0` 表示 Kiro 在没有发出工具调用的情况下结束了本轮。Provider
   已交付收到的全部内容；这个"停止"是模型行为，不是流被截断。
   `tool_intent_open: true` 记录了可见文本以一个宣布的动作结尾却没有对应的
   工具调用，这正是比较提示词或投影模式时应统计的模式。
   `finish_reason_synthesized: true` 在这里是正常的：Kiro 不暴露停止原因，
   Provider 根据 `tool_count` 推导出 `end_turn` / `tool_use`。
3. `upstream_error` 或 `idle_timeout` 是传输事故：客户端已收到类型化流内
   错误，应按契约重试；查看对应的 `sdk_stream_upstream_error` /
   `sdk_stream_idle_timeout` 以及重试事件。
4. `consumer_cancel` 表示客户端先离开了。先检查客户端的读取/空闲超时，再
   怀疑网关；Provider 随即中止上游请求，释放账号租约。
5. 把 `visible_chars` 与 `reasoning_chars` 和客户端显示的内容对照。
   `normal_complete` 下 `reasoning_chars` 很大而 `visible_chars` 很小，是模型
   思考很多回答很短，不是流丢失。

## Reasoning 回放

### `400 invalid_reasoning_signature`

- **查看：** HTTP `400`，`error.code` 为 `invalid_reasoning_signature`
  （Anthropic 信封：`invalid_request_error`，message 相同）。上游消息会指出
  出错的块，例如 `messages.1.content.0: Invalid signature in thinking block`。
- **原因：** Kiro 在服务端校验回放的 `thinking` 签名。客户端回放的
  `thinking` 块的 `signature` 被修改、截断、重新编码，或来自其他模型/供应商。
  签名不绑定会话或账号，所以这绝不是亲和问题。
- **处置：** 原样回放 `thinking` 块（文本与签名都不改动），或从历史中删除
  `thinking` 块；Kiro 接受不含它们的历史。Provider 遇到该错误不会重试、
  不换账号、不静默降级，也不会把账号标记为不健康。

### `400 unsupported_reasoning_plaintext_replay`（Responses）

- **查看：** HTTP `400`，`error.code` 为 `unsupported_reasoning_plaintext_replay`，
  `param` 指向 `input[i]` 的 reasoning 条目；`invalid_reasoning_replay` 是
  `encrypted_content` 格式错误或不是 `kr1_` 前缀时的同类错误码。
- **原因：** 客户端回放的 `reasoning` 条目只带明文 `summary`/`content`，而
  该轮次里任何位置都没有 `encrypted_content`。Provider 从不把明文推理转成
  提示词，因此无法投影。
- **处置：** 请求时带上 `include: ["reasoning.encrypted_content"]`，回放该
  轮次时把返回的 `encrypted_content`（`kr1_...`）原样放回 reasoning 条目。
  每轮恰好一个 reasoning 条目携带令牌；同一轮次的其他 reasoning 条目可以
  保留明文摘要。无法保存令牌的客户端应从历史中省略 reasoning 条目，而不是
  只发摘要。

### `upstream_affinity_selected` 中的 `reasoning_replay_locked: false`

- **查看：** `info` 事件 `upstream_affinity_selected`（每次尝试一条），含
  `affinity_kind`、`affinity_bound`、`account_hash`、`conversation_hash` 与
  `reasoning_replay_locked`。
- **含义：** `reasoning_replay_locked: true` 表示请求回放的加密推理绑定到
  铸造它的账号，因此本次请求禁用账号故障切换（失败时返回
  `reasoning_replay_*` 而不是换账号）。`false` 表示客户端没有回放绑定账号的
  推理：历史中没有 reasoning 条目，或回放类型不带绑定（Anthropic `thinking`
  签名由 Kiro 校验，不在本地绑定）。`false` 是大多数流量的正常取值，不是
  错误。

## 进程与配置

### 启动失败 `service_instance_already_running`；日志出现 `single_instance_lock_busy` 或 `single_instance_lock_compromised`

- **查看：** 启动错误 `Another kiro-provider instance already holds the
  service lock at <path> (gave up after N attempt(s) ...; a lock left behind
  by a dead process becomes stale after 15000 ms)`，错误码
  `service_instance_already_running`；审计事件 `single_instance_lock_busy`
  （`warn`，首次重试：`retry_attempts`、`retry_delay_ms`、`stale_ms`）、
  `single_instance_lock_acquired`（`info`，`attempts`）、
  `single_instance_lock_compromised`（`error`，`error_code`、`stale_ms`、
  `update_ms`、`handler_count`）。
- **原因：** `enforce_single_instance: true`（默认）在平台配置根目录下持有
  一个锁文件（`instance_lock_path` 可覆盖）。锁每 5 s 刷新一次，持有者停止
  刷新 15 s 后视为过期；获取时最多重试 20 × 1 s，因此 `SIGKILL` 后重启会在
  过期窗口过后成功。`single_instance_lock_compromised` 表示运行中丢失了锁
  （锁目录被删除，或进程被冻结导致 mtime 刷新错过了过期窗口）。Provider
  会失败关闭：停止接受请求，最多排空 10 s，然后以退出码 `1` 退出，交由
  服务管理器重启。
- **处置：** 对于 `already_running`，用 `systemctl --user is-active
  kiro-provider.service` 确认只定义了一个服务，且同一用户没有前台运行的
  `serve`；为另一个系统用户运行第二份会选择不同的配置根目录和锁。对于锁
  被破坏，保持配置目录完整，并排查主机休眠/恢复或超过 15 s 的 I/O 停顿。
  关闭锁（`enforce_single_instance: false`，会记录
  `single_instance_protection_disabled`）不是修复：两个进程轮换同一批
  refresh token 会相互作废。

### `config_file_permissions_loose`

- **查看：** 审计事件 `config_file_permissions_loose`（`warn`），含 `path`、
  `mode`（如 `0644`）、`recommended_mode: "0600"` 和 `hint`。
- **原因：** POSIX 上配置文件对组或所有人可读，而它包含 `api_keys`。
- **处置：** `chmod 600 <path>`。README 中的 systemd 单元设置了
  `UMask=0077`，服务自己创建的文件是私有的；配置文件由你创建。

### 启动失败 `unknown key "..." (did you mean "...")`

- **查看：** 绑定端口之前打印的 `ConfigLoadError`；没有审计事件，因为进程
  没有走到 `serve`。
- **原因：** 配置文件按严格模式校验。拼写错误和其他版本的键会被拒绝，并给出
  最接近的建议；环境变量使用 CONFIGURATION.zh.md 中列出的 `KIRO_PROVIDER_*`
  名称，报错时以 `(from KIRO_PROVIDER_...)` 标注。
- **处置：** 改名或删除该键。旧的 `opencode_auth_db_path` 仍被接受但会被
  忽略，并记录 `config_opencode_auth_db_path_deprecated`。

### 启动失败 `auth_source "opencode-shared" was removed in kiro-provider 0.7.0`

- **查看：** 启动消息本身：`Copy the OpenCode accounts once with
  "kiro-provider accounts import [--from <path>]", then set auth_source to
  "local" or delete the key`。
- **原因：** 实时读取 OpenCode 数据库的兼容模式在 0.7.0 中移除，因为它重新
  引入了跨进程凭据所有权，并可能在共享 SQLite 锁上阻塞事件循环。
- **处置：** 以运行服务的同一系统用户执行一次性导入，然后把 `auth_source`
  设为 `"local"`（或删除该键；`local` 是默认值）。之后不再读取 OpenCode
  数据库。

### `413`：请求体过大与上下文超长

- **查看：** HTTP `413`。`error.code` 为 `request_too_large`（message 为
  `Request body exceeds the N byte limit`）是入口的请求体上限。`error.type`
  为 `upstream_error`、message 含 `input is too long` 或
  `CONTENT_LENGTH_EXCEEDS_THRESHOLD` 的 `413`，则是 Kiro 以提示词超过模型
  上下文为由拒绝；Provider 把该上游 `400` 重新映射为 `413`，以便客户端把它
  与格式错误的请求区分开。
- **原因：** 前者是请求体超过 `max_request_body_bytes`（默认 10 MiB；更大的
  请求体 Bun 会在 JSON 信封之前直接返回纯 `413`）。后者是会话历史、工具结果
  或附带文档超过了模型的上下文窗口。
- **处置：** 请求体上限只在负载确实合理时（大体积内联文档）才提高
  `max_request_body_bytes`。上下文超长必须由客户端压缩历史；Provider 不会
  代替模型截断、总结或丢弃消息。`request_shape` 诊断
  （`input_text_chars`、`document_count`、`tool_result_count`）能显示请求的
  哪一部分在膨胀。

### 代理问题（`proxy_url`）

- **查看：** 启动时的 `ConfigLoadError` `proxy_url must be a valid URL` /
  `proxy_url must be http(s)`；运行时先是 `account_token_refresh_retry`，再是
  `error_code: NETWORK_ERROR` 或裸 `HTTP_<status>` 的
  `account_token_refresh_failed`，带传输错误码（`ECONNREFUSED`、
  `ECONNRESET`、`ETIMEDOUT`、`ENOTFOUND`、`EAI_AGAIN`）的
  `sdk_stream_upstream_error`，`model_catalog_refresh_failed`，最终是
  `503 upstream_token_refresh_failed` 或 `503 no_healthy_accounts`。
  `sdk_connection_pool_selected`（`info`）显示每个账号的 `http_keep_alive`
  与池命中情况，但不包含代理地址。
- **原因：** `proxy_url` 把**所有**出网流量（模型调用、令牌刷新、用量探测、
  设备码登录）都经由同一个 HTTP(S) 代理。不支持 SOCKS。返回 HTML 拦截页的
  代理会产生 `HTTP_<status>` 刷新错误，这类错误被有意视为临时性，因此账号
  停留在 `rate-limited` 而不是 `needs-relogin`。
- **处置：** 在服务用户的 shell 中验证代理（`curl -x "$PROXY"
  https://oidc.us-east-1.amazonaws.com/`）；在配置文件或
  `KIRO_PROVIDER_PROXY_URL` 中设置 `proxy_url`（`serve --proxy` 优先级高于
  两者）；重启服务。`kiro-provider accounts refresh --all` 是最快的端到端
  检查，因为它通过同一套代理解析同时访问令牌端点和用量端点。

## 请求形态诊断（`request_shape`，`debug`）

设置 `log_level: "debug"`（或 `KIRO_PROVIDER_LOG_LEVEL=debug`）后，每个
Responses、Messages、Chat 请求都会在构造出规范请求之后、账号选择之前输出一条
`request_shape` 事件。它只包含计数、布尔值、一个哈希和两个标签：

| 字段 | 含义 |
| --- | --- |
| `protocol` | `responses`、`anthropic-messages` 或 `chat-completions`。 |
| `model` | 请求的公开模型名。 |
| `message_count` | 适配后的规范消息数。 |
| `user_message_count`、`assistant_message_count`、`tool_message_count`、`instruction_message_count` | 角色计数（`instruction_message_count` 为 `system` 加 `developer`）。 |
| `tool_declaration_count` | 声明的工具数。 |
| `tool_call_count` | 历史中的工具调用数（assistant 的 `toolCalls` 加 `tool_use` 内容块，同一消息内按 id 去重）。 |
| `tool_result_count` | 历史中的工具结果数。 |
| `orphan_tool_result_count` | 调用 id 在更早消息中找不到对应调用的结果数。 |
| `image_count`、`document_count` | 内联附件数。 |
| `has_reasoning_replay`、`reasoning_replay_count` | 请求是否携带加密推理回放，以及数量。 |
| `system_instruction_present` | 存在顶层 `instructions`/`system` 或 system/developer 消息。 |
| `input_text_chars` | 消息文本、工具结果文本与 instructions 的长度之和。只是大小，不是内容。 |
| `tool_set_hash` | 排序后工具名的 `auditHash`，用于在不记录工具名的前提下关联相同工具集的请求。 |

用它来回答"客户端是否发送了完整历史？"、"是否有工具结果没有对应的调用？"、
"这段会话有多大？"，而无需开启请求体日志（Provider 也不提供这种日志）。
