# 配置字段完整参考

简体中文 · [English](../CONFIGURATION.md)

kiro-provider 的配置由 JSON 文件、环境变量以及（仅 `serve`）CLI 参数三层叠加而成。本文是完整字段参考；快速概览见 [README](../../README.zh.md#配置)。

## 优先级

每个字段的最终取值按以下顺序取第一个命中的来源：

1. **CLI 参数** —— `serve` 仅支持 `--config`、`--host`、`--port`、`--proxy`；`login` 支持 `--config`（仅用于选择文件，不会覆盖字段）和 `--help`。
2. **环境变量** —— `KIRO_PROVIDER_*`，见下表。
3. **配置文件** —— 解析出的配置路径下的 JSON 文件。
4. **Schema 默认值** —— `src/config/schema.ts` 中 zod schema 的默认值。

配置文件默认路径为平台配置根目录下的 `kiro-provider/config.json`（见[文件位置](#文件位置)）：Linux/macOS 为 `$XDG_CONFIG_HOME/kiro-provider/config.json` 或 `~/.config/kiro-provider/config.json`，Windows 为 `%APPDATA%\kiro-provider\config.json`。`accounts list|import|remove` 直接操作 provider 自有本地认证库，不加载网关配置，因此 `accounts import` 不接受 `--config`；`accounts refresh|relogin` 会从所选配置读取刷新、超时、区域、代理以及 `quota_recheck_concurrency` 设置，并要求 `auth_source: "local"`。

## 校验规则

配置在启动时一次性校验；任何违规都会抛出 `ConfigLoadError`，指明出错字段（环境变量来源时同时指明变量名），进程在绑定端口前退出。

- **空环境变量视为未设置。** 值为空或仅含空白的 `KIRO_PROVIDER_*` 变量会被忽略，因此 `KIRO_PROVIDER_PORT=""` 会沿用配置文件值或默认值，而不会变成 `0`。该规则适用于所有变量，包括 `KIRO_PROVIDER_PROXY_URL`；若要通过环境关闭配置文件中的代理，请在文件中把 `proxy_url` 设为 `null`，或使用 `serve --proxy ""`。
- **整数变量必须是十进制整数。** 允许首尾空白和显式正负号；`0x1f90`、`8787.5`、`1e3`、`NaN` 会被拒绝，并给出类似 `Invalid environment variable KIRO_PROVIDER_PORT: expected a decimal integer, got "0x1f90"` 的错误。超出范围的值报错形如 `port: Number must be less than or equal to 65535 (from KIRO_PROVIDER_PORT)`。
- **配置文件中的未知键会被拒绝。** 例如拼错的 `enable_legacy_chat_completion` 会报 `unknown key "enable_legacy_chat_completion" (did you mean "enable_legacy_chat_completions"?)`，而不是被静默丢弃。
- **文件权限过宽会告警。** POSIX 下若配置文件对同组或其他用户可读/可写（`mode & 0o077 != 0`），启动时输出 `config_file_permissions_loose` 结构化警告（含路径与当前权限），因为该文件通常包含 `api_keys`。加载仍会成功；对文件执行 `chmod 600` 即可消除警告。Windows 上跳过此检查。
- **所有数值字段都是有界整数。** 取值范围见下表；小数、`NaN`、无穷大以及超出范围的值都会被拒绝。毫秒字段上限为 `2147483647`（见[超时字段的取值范围](#超时字段的取值范围)）。

## 字段参考

| 字段                         | 类型 / 默认值                                                          | 环境变量                                   | 说明                                                                                                                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`                       | `string`（非空），默认 `"127.0.0.1"`                                    | `KIRO_PROVIDER_HOST`                       | HTTP 绑定地址。首尾空白会被去除；空值会被拒绝。                                                                                                                                                    |
| `port`                       | 整数 `0`-`65535`，默认 `8787`                                          | `KIRO_PROVIDER_PORT`                       | HTTP 监听端口。`0` 表示由操作系统分配临时端口（启动时会打印实际地址）；`serve --port 0` 会被拒绝。小数和超出范围的值会被拒绝，空的 `KIRO_PROVIDER_PORT` 也不再变成 `0`。                          |
| `api_keys`                   | `string[]`，**必填，去空格后不能为空**                                 | `KIRO_PROVIDER_API_KEYS`                   | 接受的 Bearer Key 列表。环境变量以逗号分隔。空列表或仅含空白会被拒绝，服务不会启动（默认拒绝启动）。                                                                                               |
| `enable_legacy_chat_completions` | `boolean`，默认 `false`                                          | `KIRO_PROVIDER_ENABLE_LEGACY_CHAT_COMPLETIONS` | 是否开放 `POST /v1/chat/completions`。除非客户端不能使用 Responses 或 Anthropic Messages，否则应保持关闭。环境变量接受 `true`、`false`、`1`、`0`。                                              |
| `protocol_projection_mode`  | `"safe" \| "legacy-user-prefix"`，默认 `"safe"`                    | `KIRO_PROVIDER_PROTOCOL_PROJECTION_MODE`   | `safe` 禁止模型可见的兼容文本并拒绝无法投影的指令角色；`legacy-user-prefix` 仅用于指令迁移，计划在 v0.7.0 删除。                                                                                       |
| `session_affinity_mode`     | `"explicit-only" \| "legacy-initial-input"`，默认 `"explicit-only"` | `KIRO_PROVIDER_SESSION_AFFINITY_MODE`      | `explicit-only` 绝不从提示词推导逻辑会话；`legacy-initial-input` 临时恢复旧版初始输入指纹，但不会改变模型可见内容。                                                                                  |
| `auth_source`                | `"local" \| "opencode-shared"`，默认 `"local"`                        | `KIRO_PROVIDER_AUTH_SOURCE`                | 认证事实源。本地模式以 provider 自有账号库为权威，支持一次性导入 OpenCode 凭证或直接登录；共享模式仅作为显式兼容选项。                                                                             |
| `opencode_auth_db_path`      | `string \| null`，默认 `null`                                         | `KIRO_PROVIDER_OPENCODE_AUTH_DB_PATH`      | OpenCode Kiro 共享数据库的可选覆盖路径。`null` 使用 `$XDG_CONFIG_HOME/opencode/kiro.db` 或 `~/.config/opencode/kiro.db`；本地模式忽略此字段。                                                      |
| `proxy_url`                  | `string \| null`，默认 `null`                                          | `KIRO_PROVIDER_PROXY_URL`                  | 可选的全局 HTTP(S) 代理，覆盖**所有**上游出网流量（模型请求、令牌刷新、额度探测、设备码登录）。必须是合法的 `http://` 或 `https://` URL，其他协议（如 SOCKS）会被拒绝。`null` 或空字符串表示直连。 |
| `default_region`             | AWS 区域枚举（`RegionSchema`），默认 `"us-east-1"`                      | `KIRO_PROVIDER_DEFAULT_REGION`             | `login` 使用的区域，以及没有单独 profile ARN 覆盖的账号所使用的区域。必须是 `src/kiro/regions.ts` 中列出的区域之一（如 `us-east-1`、`eu-west-1`、`ap-northeast-1`）；未知区域在启动时被拒绝。       |
| `sdk_http_keep_alive`       | `boolean`，默认 `false`                                               | `KIRO_PROVIDER_SDK_HTTP_KEEP_ALIVE`        | 只控制 Kiro 模型调用 socket。两种模式都会缓存 transport 对象；SDK 客户端只在 access token 未变化时复用，token 轮换后立即重建。`false` 使用新的直连/代理 SDK socket，`true` 在部署验证后启用池化。令牌刷新与设备登录保持各自独立的传输策略。       |
| `enforce_single_instance`   | `boolean`，默认 `true`                                                | `KIRO_PROVIDER_ENFORCE_SINGLE_INSTANCE`    | 绑定 HTTP 监听前取得服务进程锁，使账号/会话队列与 SDK 池只有一个所有者。只有各进程使用独立凭证/状态，或已有外部串行器时才应关闭。                                                                                              |
| `instance_lock_path`        | `string \| null`，默认 `null`                                        | `KIRO_PROVIDER_INSTANCE_LOCK_PATH`         | 可选服务锁目标。`null` 使用平台配置目录下的 `kiro-provider/service.instance`；POSIX 权限为 `0600`。不同路径会有意创建相互独立的进程域。                                                                                     |
| `runtime_endpoint_mode`     | `"kiro-runtime" \| "legacy-q"`，默认 `"kiro-runtime"`               | `KIRO_PROVIDER_RUNTIME_ENDPOINT_MODE`      | 默认使用实测确认的 Kiro runtime 端点。当前 runtime 的成功流以 token usage metadata，或合法 metering 后的 clean EOF 作为权威完成证据；`legacy-q` 仅保留用于诊断/迁移，且可能两者都不提供。                                                                                                  |
| `dynamic_model_catalog`     | `boolean`，默认 `true`                                                | `KIRO_PROVIDER_DYNAMIC_MODEL_CATALOG`      | 按可用账号分别调用 Kiro 管理面发现模型，只把请求路由到公开对应 wire model 的账号；管理面不可用时使用仓库内受限静态目录兜底。                                                                                                 |
| `model_catalog_ttl_ms`      | 整数 `1`-`2147483647`，默认 `900000`（15 分钟）                       | `KIRO_PROVIDER_MODEL_CATALOG_TTL_MS`       | 每账号模型目录成功响应的新鲜期。                                                                                                                                                                                         |
| `model_catalog_stale_ttl_ms` | 整数 `1`-`2147483647`，默认 `86400000`（24 小时）                    | `KIRO_PROVIDER_MODEL_CATALOG_STALE_TTL_MS` | 刷新失败后允许继续使用最后一次成功目录的最长时间。                                                                                                                                                                       |
| `model_catalog_request_timeout_ms` | 整数 `1`-`2147483647`，默认 `10000`                           | `KIRO_PROVIDER_MODEL_CATALOG_REQUEST_TIMEOUT_MS` | 单次 Kiro 管理模型列表请求的超时。                                                                                                                                                                                |
| `account_selection_strategy` | `"sticky" \| "round-robin" \| "lowest-usage"`，默认 `"lowest-usage"`   | `KIRO_PROVIDER_ACCOUNT_SELECTION_STRATEGY` | 每次请求如何选择账号：`sticky` 倾向复用同一账号，`round-robin` 轮询，`lowest-usage` 优先选剩余额度最多的账号。                                                                                     |
| `rate_limit_max_retries`     | 整数 `0`-`100`，默认 `3`                                               | `KIRO_PROVIDER_RATE_LIMIT_MAX_RETRIES`     | 对可重试限流响应的最大重试次数；`0` 表示不重试。                                                                                                                                                   |
| `rate_limit_retry_delay_ms`  | 整数 `1`-`2147483647`，默认 `5000`                                     | `KIRO_PROVIDER_RATE_LIMIT_RETRY_DELAY_MS`  | 限流重试的基础延迟（毫秒）。                                                                                                                                                                       |
| `quota_recheck_interval_ms`  | 整数 `1`-`2147483647`，默认 `900000`（15 分钟）                       | `KIRO_PROVIDER_QUOTA_RECHECK_INTERVAL_MS`  | 已耗尽账号再次被探测前的最短等待时间。若 Kiro 返回配额重置时间，则等到该时间再探测，上限为本间隔与 24 小时中的较大者。HTTP 402、仍耗尽的快照或探测失败只会推进该时间，不会形成模型请求重试。        |
| `quota_recheck_timeout_ms`   | 整数 `1`-`2147483647`，默认 `10000`                                   | `KIRO_PROVIDER_QUOTA_RECHECK_TIMEOUT_MS`   | 同时限制请求前置额度探测批次与每个已启动账号探测。超时后账号继续排除，并安排下一次探测。                                                                                                           |
| `quota_recheck_concurrency`  | 整数 `1`-`32`，默认 `4`                                               | `KIRO_PROVIDER_QUOTA_RECHECK_CONCURRENCY`  | 同时探测的到期耗尽账号上限；并发请求会加入同一个账号的在途探测。`accounts refresh` 与服务端共用同一探测器，因此也受此值约束。                                                                       |
| `account_maintenance_enabled` | `boolean`，默认 `true`                                               | `KIRO_PROVIDER_ACCOUNT_MAINTENANCE_ENABLED` | 启用 provider 自有的后台令牌与用量维护。只有明确由外部运维系统接管该生命周期时才应关闭。                                                                                                           |
| `account_maintenance_interval_ms` | 整数 `1000`-`2147483647`，默认 `60000`                          | `KIRO_PROVIDER_ACCOUNT_MAINTENANCE_INTERVAL_MS` | 后台维护批次间隔；服务启动后会很快安排首个批次。                                                                                                                                               |
| `account_maintenance_timeout_ms` | 整数 `1000`-`2147483647`，默认 `120000`                           | `KIRO_PROVIDER_ACCOUNT_MAINTENANCE_TIMEOUT_MS` | 单个全账号维护批次的绝对截止时间。                                                                                                                                                              |
| `account_maintenance_concurrency` | 整数 `1`-`32`，默认 `4`                                          | `KIRO_PROVIDER_ACCOUNT_MAINTENANCE_CONCURRENCY` | 主动刷新 access token 的最大并发数。                                                                                                                                                            |
| `usage_refresh_interval_ms`  | 整数 `1000`-`2147483647`，默认 `900000`（15 分钟）                    | `KIRO_PROVIDER_USAGE_REFRESH_INTERVAL_MS`  | 普通账号用量快照允许的最大陈旧时间；超过后后台调用 Kiro `getUsageLimits`。已耗尽账号继续使用独立的额度复查周期。                                                                                  |
| `max_request_iterations`     | 整数 `1`-`1000`，默认 `20`                                             | `KIRO_PROVIDER_MAX_REQUEST_ITERATIONS`     | 单次请求内账号切换与重试循环的总迭代次数上限。`0` 会让所有请求失败，因此被拒绝。                                                                                                                   |
| `request_timeout_ms`         | 整数，`1`-`2147483647`，默认 `120000`                                  | `KIRO_PROVIDER_REQUEST_TIMEOUT_MS`         | 单次请求的绝对超时时间（毫秒）。取值范围与已知限制见[超时字段的取值范围](#超时字段的取值范围)。                                                                                                    |
| `stream_idle_timeout_ms`     | 整数，`1`-`2147483647`，默认 `60000`                                   | `KIRO_PROVIDER_STREAM_IDLE_TIMEOUT_MS`     | 流式响应中两次上游事件之间允许的最大空闲间隔（毫秒），超过则中止流。取值范围见[超时字段的取值范围](#超时字段的取值范围)。                                                                          |
| `max_request_body_bytes`     | 整数 `1`-`2147483647`，默认 `10485760`（10 MiB）                       | `KIRO_PROVIDER_MAX_REQUEST_BODY_BYTES`     | 允许的最大请求体大小；超出返回 HTTP 413。                                                                                                                                                          |
| `token_expiry_buffer_ms`     | 整数 `1`-`2147483647`，默认 `300000`（5 分钟）                         | `KIRO_PROVIDER_TOKEN_EXPIRY_BUFFER_MS`     | 在访问令牌实际过期前多久主动触发刷新。                                                                                                                                                             |
| `session_affinity_ttl_ms`    | 整数，`1`-`2147483647`，默认 `86400000`（24 小时）                    | `KIRO_PROVIDER_SESSION_AFFINITY_TTL_MS`    | 持久化逻辑会话绑定的滑动有效期；每次命中都会续期。过期后按正常账号策略重新建立绑定。                                                                                                               |
| `session_affinity_max_entries` | 整数，`1`-`1000000`，默认 `10000`                                   | `KIRO_PROVIDER_SESSION_AFFINITY_MAX_ENTRIES` | 最多保留的会话绑定数；超限时优先清理最久未使用的记录。                                                                                                                                           |
| `reasoning_replay_key_path` | `string \| null`，默认 `null`                                         | `KIRO_PROVIDER_REASONING_REPLAY_KEY_PATH`  | reasoning 密钥文件覆盖路径。`null` 使用平台配置目录；未配置环境密钥环时会原子生成 `reasoning-replay-keys.json`，POSIX 权限强制为 `0600`。                                                          |
| `reasoning_replay_keys`     | `string[]`，默认 `[]`                                                  | `KIRO_PROVIDER_REASONING_REPLAY_KEYS`      | AES-256-GCM 密钥环。环境变量使用逗号分隔的 `key-id:base64url-32-byte-key`，key ID 可省略。首个密钥用于新记录加密，其余只解密旧记录。                                                               |
| `reasoning_replay_ttl_ms`   | 整数，`1`-`2147483647`，默认 `86400000`（24 小时）                    | `KIRO_PROVIDER_REASONING_REPLAY_TTL_MS`    | 加密 reasoning 回放记录的有效期；过期会明确报错，并在事务中清理。                                                                                                                                |
| `reasoning_replay_max_entries` | 整数，`1`-`1000000`，默认 `10000`                                  | `KIRO_PROVIDER_REASONING_REPLAY_MAX_ENTRIES` | 加密回放记录上限；清理过期记录后，在同一事务中按 LRU 淘汰。                                                                                                                                     |
| `effort`                     | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| null`，默认 `null` | `KIRO_PROVIDER_EFFORT`                     | 可选的全局推理强度覆盖，应用于每个请求。`null` 表示不强制覆盖，除非请求自身指定。                                                                                                                  |
| `auto_effort_mapping`        | `boolean`，默认 `true`                                                 | `KIRO_PROVIDER_AUTO_EFFORT_MAPPING`        | 启用后，网关会自动映射模型变体后缀与请求的 effort。环境变量值接受 `true`、`false`、`1`、`0`。                                                                                                      |
| `log_level`                  | `"debug" \| "info" \| "warn" \| "error"`，默认 `"info"`            | `KIRO_PROVIDER_LOG_LEVEL`                  | 结构化审计日志（stderr 上每行一个 JSON 对象）的最低输出级别。级别顺序为 `debug < info < warn < error`，低于阈值的事件被丢弃；`warn` 会屏蔽 `upstream_affinity_selected` 等逐请求 `info` 事件。所有加载配置的命令（`serve`、`login`、`accounts refresh|relogin`）都会应用该值。 |
| `test_upstream_endpoint`     | `string`（合法 URL），可选，默认不设置                                 | `KIRO_PROVIDER_TEST_UPSTREAM`              | **仅用于测试。** 覆盖 AWS CodeWhisperer SDK 用于上游调用的端点，供 `scripts/security-check.sh` 和隔离测试指向非生产端点使用。设置后 `serve` 启动时会在 stderr 打印警告。正常生产环境不要设置此项。 |

## 认证事实源

`auth_source: "local"` 是生产默认值，以
`~/.config/kiro-provider/accounts.db` 作为唯一认证事实源。可直接设备码登录，
也可从已有 OpenCode + `opencode-kiro-auth` 数据库一次性导入：

```bash
kiro-provider login
# 或：
kiro-provider accounts import
# 非默认源：
kiro-provider accounts import --from /path/to/kiro.db
# 即使本地记录更新也强制覆盖：
kiro-provider accounts import --from /path/to/kiro.db --force
```

`login` 完成设备码流程后会调用一次 Kiro 用量接口，在推导账号 ID 之前获取
真实登录邮箱。若该请求失败（例如离线），记录会以占位邮箱
`builder-id@aws.amazon.com` 保存并打印警告，之后执行 `accounts refresh --all`
或 `accounts relogin` 即可补全真实身份。身份已确认时，同一个人（邮箱、start
URL、profile 相同）再次登录会原地更新已有记录并清理旧的重复记录，而不是再插
入一条账号。每个 SSO OIDC 请求（客户端注册、设备授权、令牌轮询）都有 30 秒
超时；令牌轮询期间的瞬时网络错误会持续重试，直到设备码过期。

导入会复制活跃账号凭证与用量，不会保留实时链接、共享锁或 OpenCode 运行期
依赖。若本地记录的 access token 过期时间或用量同步时间比源记录更新（说明
kiro-provider 在上次导入后已刷新过它），该行会被跳过；传入 `--force` 可强制
覆盖。`accounts import` 不读取网关配置，因此没有 `--config` 选项。导入完成后，
kiro-provider 会独立完成：

- 主动刷新临近过期的 access token，并先持久化再使用；
- token 变化时重建绑定凭据的 SDK client，同时保留账号 transport；
- 后台刷新普通账号的陈旧用量；
- 在 token 刷新和 SDK 构建前排除已耗尽账号；
- 只在持久化复查时间到期时探测耗尽账号，并仅在权威快照确认额度恢复后回池；
- 将永久失效的 refresh credential 标记为不健康，不让其进入模型重试循环；
- 去重同账号探测，并限制后台维护并发。

本地账号库可完全脱离 OpenCode 进行运维：

```bash
kiro-provider accounts list
kiro-provider accounts list --details
kiro-provider accounts list --json
kiro-provider accounts refresh --all
kiro-provider accounts refresh <id|email> --json
kiro-provider accounts relogin <id|email>
kiro-provider accounts remove <id|email>
```

默认列表为对齐后的摘要；`--details` 与 `--json` 会显示用于消歧重复邮箱的稳定
内部 ID，但绝不包含 access token、refresh token 或 client secret。邮箱匹配不区分
大小写，且只有唯一匹配时才允许继续。

手工 refresh 始终调用 Kiro 权威用量接口，包括刚刷新过或当前已耗尽的账号；
仅在 access token 临近到期，或收到一次 invalid-bearer 响应后才刷新 token。
只要任一账号失败、超时或需要重新登录，命令就返回非零退出码，并给出逐账号
结果；`--json` 可用于监控。后台维护仍会自动完成临期 token 刷新、普通账号
用量刷新以及耗尽账号的周期性额度恢复探测。

`accounts relogin` 会先解析目标，再打开设备授权，并在写入凭证前通过 Kiro usage
邮箱校验实际登录身份。它保留所选内部账号 ID，因此已有会话亲和仍可继续引用
同一账号。`accounts remove` 默认要求确认；非交互删除必须使用 `--yes`，且会
一并删除该账号的持久化亲和、输出 lineage 与 reasoning replay 记录。

一个会轮换的 refresh token 只应由一个认证所有者维护。导入后继续让独立运行
的 OpenCode 插件使用同一账号可能产生 token 轮换竞争；再次导入应是明确的
运维动作，而不是运行期同步方式。

`auth_source: "opencode-shared"` 仍保留为兼容选项：它实时读取 OpenCode
数据库、校验 v0.20.7 账号/墓碑 schema、遵守兼容刷新锁，且绝不对该数据库
执行 provider 迁移。该模式会重新引入跨进程所有权，默认部署不需要它。

## 代理

`proxy_url` 是唯一的开关，一旦设置，会把**所有**上游流量都改走同一个 HTTP(S) 代理：

- 模型请求（chat completions）。
- 访问令牌刷新。
- 权威额度复查与周期用量刷新（`getUsageLimits`）。
- 登录到 provider 自有本地认证库的设备码流程（`login`）。

某些网络环境下，一部分模型系列可以直连，另一部分不能 —— 例如 GPT 请求直连成功，而 Claude 请求需要走审批过的代理出网，否则会返回 HTTP 401/403。

对 `serve` 而言，设置方式按以下优先级生效：

1. `--proxy <url>`（CLI 参数，仅 `serve` 支持）。
2. `KIRO_PROVIDER_PROXY_URL`（环境变量）。
3. 配置文件中的 `proxy_url`。

`login` 没有 `--proxy` 参数，因此设备码登录只会读取环境变量或配置文件中的
值。一次性导入只是本地 SQLite 操作，不访问网络。

```bash
KIRO_PROVIDER_PROXY_URL=http://proxy.example.com:8080 \
  ./dist/kiro-provider serve

./dist/kiro-provider serve --proxy https://proxy.example.com:8443
```

只接受 `http://` 和 `https://` 协议；非法或非 HTTP(S) 的 URL 会在启动时的配置校验阶段失败。

## 协议暴露面

- `POST /v1/responses` 始终为 OpenAI Responses 客户端启用；具体 Codex 版本
  只有在其标准请求落入文档列出的已验证子集时才算支持。
- `POST /v1/messages` 与 `POST /v1/messages/count_tokens` 始终启用，供
  Anthropic Messages 客户端使用；具体 Claude Code 版本同样必须落入该子集。
- `POST /v1/chat/completions` 默认返回
  `legacy_chat_completions_disabled`；只有显式设置
  `enable_legacy_chat_completions: true` 后才开放。
- 需鉴权的 `GET /ready` 只有在认证事实源可读、至少存在一个活跃账号、Provider
  数据库可写、reasoning 密钥环可用，并且所有未过期回放记录引用的 key ID 都已
  覆盖时才返回 HTTP 200。其 `model_catalog` 对象还会说明当前模型信息来自
  实时、陈旧缓存、静态兜底或已禁用的动态发现。

`protocol_projection_mode: "safe"` 是生产默认值。GPT 与 Claude 实时探针已经
证明，Kiro 会接受合法非空标签的 `additionalContext` 结构，但不会保留其中的
指令内容或指令高于 user 的优先级。因此 safe 模式对 Responses `instructions`、
OpenAI `system`/`developer` 与 Anthropic `system` 返回
`unsupported_instruction_projection`，不会自动回退到 user 前缀。

`legacy-user-prefix` 只会用精确的 `\n\n` 连接原始指令文本，并前置到首个 user
回合。服务启动时输出不含正文的结构化警告；该模式不会恢复消息合并、重复
内容折叠、尾部字符删除、合成工具说明或其他改写。迁移模式在 v0.5.x、
v0.6.x 保留，计划在 v0.7.0 删除。

完整接受/拒绝范围见
[`PROTOCOL_COMPATIBILITY.zh.md`](PROTOCOL_COMPATIBILITY.zh.md)。

Kiro 没有提供独立 tokenizer，因此 count-tokens 接口使用 provider
现有的回退估算器；成功响应会携带
`x-kiro-token-count-mode: estimate`。

## Kiro runtime 与模型目录

生产请求默认使用 `runtime_endpoint_mode: "kiro-runtime"`。实时 A/B 抓包表明，
`runtime.<region>.kiro.dev` 会给出区分“完整响应”和“干净但被截断流”所需的
权威完成证据：token usage metadata 可立即完成，合法 metering 只有随后为
clean EOF 时才完成。旧 SDK `q` 端点可能两者都不提供。因此 `legacy-q`
只是显式诊断/迁移选项，不会作为自动回退。

启用 `dynamic_model_catalog` 后，Provider 使用所选账号的当前令牌和真实
`AI_EDITOR` origin 调用 Kiro 管理面的 `ListAvailableModels`。响应按账号缓存，
并发刷新会合并；刷新失败时可在 `model_catalog_stale_ttl_ms` 内使用最后一次
成功结果。请求只会发送给实时/缓存目录中包含精确 wire ID 的账号。若管理面
暂不可达且没有缓存，则使用仓库内目录做受限兜底；未知模型仍会在调用 SDK
前被拒绝。

## 会话亲和与连接复用

生产默认值 `session_affinity_mode: "explicit-only"` 不会对 input、messages、
工具参数或其他模型可见内容做哈希，来猜测两个请求是否属于同一会话。它只
接受以下显式来源：

- Responses 按优先级依次使用标准
  `metadata.zuno_session_id`、标准
  `metadata.kiro_provider_session_id`、兼容字段
  `client_metadata.thread_id|session_id|conversation_id`，最后是
  `prompt_cache_key`。
- Chat Completions 只使用 `prompt_cache_key`。
- Anthropic Messages 暂无经过验证的显式字段，因此本模式不建立亲和绑定。

存在显式键时，Provider SQLite 只保存按租户隔离的键哈希、选中的账号 ID、
Kiro `conversationId` 和时间戳，不保存原始会话值或提示词。同一逻辑会话在
单进程内串行；不同账号可并行；共享同一账号的请求经过账号队列。transport
对象按账号缓存；SDK 客户端只在该账号 access token 未变化时缓存。token 刷新
后会用新的不可变凭据重建 SDK 客户端，同时保留 transport。

`overage_count > 0`，或已知正数上限且 `used_count >= limit_count` 的账号，会在
刷新 token 和创建 SDK 前直接排除。上游 HTTP 402 会把账号标记为额度耗尽，并
从当前请求排除，不会重试同一账号。HTTP 401 或 invalid-bearer 403 对每个账号
最多强制刷新一次；刷新后仍失败时，该账号在本请求剩余阶段保持排除，最终响应
保留 HTTP 401/403，不再变成 `max_request_iterations` HTTP 500。遇到限流、额度
耗尽、认证失败或不健康账号时，会话会重绑到替代账号并更换 Kiro
`conversationId`。

无法发送稳定 metadata 的标准客户端，在重传完整历史时仍有安全续轮路径。
一次完整 assistant/tool 输出结束后，Provider 只保存该精确输出 lineage 的
租户隔离指纹、账号与 Kiro conversation；后续请求最新 assistant 输出命中时，
复用同一账号和 conversation。首轮、没有 assistant 历史或未命中的历史会创建
新 conversation。Provider 不会对 user 文本、工具参数或初始 prompt 做指纹来
猜测会话。

既没有显式键也没有历史 lineage 时，账号选择与账号级 SDK/transport 对象
复用仍然生效。Kiro SDK 的直连/代理 agent 默认使用新 socket；只有部署环境
已经验证池化 socket 行为时，才显式设置 `sdk_http_keep_alive: true`。

`legacy-initial-input` 仅用于迁移，会恢复旧版 Responses 初始输入、Chat
`user`/首回合，以及 Anthropic `metadata.user_id`/首回合推导。启动时输出
不含正文的结构化警告。该模式只影响路由亲和，不会前置、合并、删除或以其他
方式修改模型可见内容。

这里复用的是逻辑会话与 SDK 对象，不把会话绑定到固定物理 TCP socket。即使
开启 keep-alive，Node/Smithy Agent、代理、远端服务、空闲超时与网络仍可能
创建新 socket。因此生产默认 `enforce_single_instance: true`：第二个使用
同一服务锁的 Provider 会在绑定端口前失败，避免账号/会话队列与 socket 池被
静默拆到多个进程。若关闭该保护或使用不同锁路径，队列只在各自进程内串行；
只有凭证/状态彼此独立，或已有外部跨进程串行器时才安全。

本网关不保存 OpenAI response 对象状态，因此 `previous_response_id` 与
`conversation` 会返回 `unsupported_stateful_responses`，不会被静默忽略；
客户端需要重传完整 Responses 输入。

## 加密 reasoning 回放

Kiro 返回完整签名文本或 redacted reasoning envelope 时，Provider 可以为
Responses `reasoning.encrypted_content` 返回随机 `kr1_...`。只有签名、无签名
文本、冲突签名或 text/redacted 混合事件都不会生成回放令牌。数据库只保存
令牌/指纹哈希和 AES-256-GCM 密文。

AAD 将密文绑定到租户、模型、账号、Kiro conversation ID、输出指纹、过期
时间和 key ID。回放必须全部匹配；回放期间禁止账号故障切换。绑定账号不可用
时返回可重试的 `reasoning_replay_account_unavailable`。

密钥配置优先级：

1. 非空的 `KIRO_PROVIDER_REASONING_REPLAY_KEYS` / `reasoning_replay_keys`；
2. `reasoning_replay_key_path`；
3. 平台默认配置路径。

环境密钥环示例（必须使用密码学安全随机源生成，不要复制占位值）：

```bash
export KIRO_PROVIDER_REASONING_REPLAY_KEYS='2026-08:<base64url-32-byte-key>,2026-07:<old-key>'
```

首项为活动加密密钥。旧密钥应保留到其加密记录全部过期；若任一未过期数据库
记录引用了已缺失的 key，服务构造会失败，不会悄悄破坏活动会话。日志不会
包含密钥、原始回放令牌、签名、reasoning 文本、redacted bytes 或请求提示词。

## 文件位置

所有 provider 自有文件都位于同一个用户级配置根目录下：

| 平台 | 根目录 | 文件 |
| --- | --- | --- |
| Linux / macOS | `$XDG_CONFIG_HOME` 或 `~/.config` | `kiro-provider/config.json`、`kiro-provider/accounts.db`、`kiro-provider/service.instance`、`kiro-provider/reasoning-replay-keys.json`；OpenCode 导入源 `opencode/kiro.db` |
| Windows | `%APPDATA%` 或 `%USERPROFILE%\AppData\Roaming` | `kiro-provider\config.json`、`kiro-provider\accounts.db`、`kiro-provider\service.instance`、`kiro-provider\reasoning-replay-keys.json`；OpenCode 导入源 `opencode\kiro.db` |

空的 `XDG_CONFIG_HOME` 或 `APPDATA` 视为未设置。v0.6 之前，配置文件在任何平台
上都只从 `~/.config/kiro-provider/config.json` 读取（包括 Windows）。Windows 上若
`%APPDATA%\kiro-provider\config.json` 不存在而旧的 `~/.config/kiro-provider/config.json`
存在，则仍使用旧文件；把它移动到 `%APPDATA%` 即完成迁移。使用 `--config <path>`
可完全绕过默认查找。

## 超时字段的取值范围

`request_timeout_ms` 和 `stream_idle_timeout_ms` 均接受 `1` 到 `2147483647`（2³¹−1）之间的整数毫秒值。小数、`0`、负数、`NaN` 以及超过 `2147483647` 的值都会在配置校验阶段被拒绝。这个上限来自 JS/Bun `setTimeout` 的 32 位安全计时器范围，并不是产品层面随意设定的上限——超出这个范围的值会悄悄提前触发，而不是明确报错。

`request_timeout_ms` 只保证网关自身应用层资源的确定性释放：一旦超过截止时间，管道队列锁、截止计时器、请求级空闲超时租约恢复，以及 SDK 迭代器/读取器的清理尝试都会被释放，无论客户端当时在做什么。但它**不能**保证底层 TCP 套接字的文件描述符或出站 `Send-Q` 会在同一时间窗口内关闭。在 Bun 1.3.14 上，一个因写入反压而暂停读取的客户端，即便网关已经完成自身清理，连接仍可能停留在 `ESTABLISHED`/`FIN-WAIT-1` 状态并持有非零 `Send-Q`——这是 Bun 当前传输层的平台级限制，不是 `request_timeout_ms` 本身能约束的范围。

如果需要一个不依赖客户端读取行为的连接生命周期硬上限，请在网关前面的反向代理上配置独立的发送/写入超时，或关注未来提供更强传输层保证的 Bun 版本。

## 配置文件示例

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "api_keys": ["sk-REPLACE-ME"],
  "enable_legacy_chat_completions": false,
  "protocol_projection_mode": "safe",
  "session_affinity_mode": "explicit-only",
  "auth_source": "local",
  "opencode_auth_db_path": null,
  "proxy_url": null,
  "default_region": "us-east-1",
  "sdk_http_keep_alive": false,
  "enforce_single_instance": true,
  "instance_lock_path": null,
  "runtime_endpoint_mode": "kiro-runtime",
  "dynamic_model_catalog": true,
  "model_catalog_ttl_ms": 900000,
  "model_catalog_stale_ttl_ms": 86400000,
  "model_catalog_request_timeout_ms": 10000,
  "account_selection_strategy": "lowest-usage",
  "rate_limit_max_retries": 3,
  "rate_limit_retry_delay_ms": 5000,
  "quota_recheck_interval_ms": 900000,
  "quota_recheck_timeout_ms": 10000,
  "quota_recheck_concurrency": 4,
  "account_maintenance_enabled": true,
  "account_maintenance_interval_ms": 60000,
  "account_maintenance_timeout_ms": 120000,
  "account_maintenance_concurrency": 4,
  "usage_refresh_interval_ms": 900000,
  "max_request_iterations": 20,
  "request_timeout_ms": 120000,
  "stream_idle_timeout_ms": 60000,
  "max_request_body_bytes": 10485760,
  "token_expiry_buffer_ms": 300000,
  "session_affinity_ttl_ms": 86400000,
  "session_affinity_max_entries": 10000,
  "reasoning_replay_key_path": null,
  "reasoning_replay_keys": [],
  "reasoning_replay_ttl_ms": 86400000,
  "reasoning_replay_max_entries": 10000,
  "effort": null,
  "auto_effort_mapping": true,
  "log_level": "info"
}
```

以上与仓库根目录的 `config.example.json` 一致。部署前请把 `sk-REPLACE-ME` 换成私有的随机 Key；空的 `api_keys` 列表会在启动时被拒绝。
