# 配置字段完整参考

简体中文 · [English](../CONFIGURATION.md)

kiro-provider 的配置由 JSON 文件、环境变量以及（仅 `serve`）CLI 参数三层叠加而成。本文是完整字段参考；快速概览见 [README](../../README.zh.md#配置)。

## 优先级

每个字段的最终取值按以下顺序取第一个命中的来源：

1. **CLI 参数** —— `serve` 仅支持 `--config`、`--host`、`--port`、`--proxy`；`login` 支持 `--config`（仅用于选择文件，不会覆盖字段）。
2. **环境变量** —— `KIRO_PROVIDER_*`，见下表。
3. **配置文件** —— 解析出的配置路径下的 JSON 文件。
4. **Schema 默认值** —— `src/config/schema.ts` 中 zod schema 的默认值。

配置文件默认路径为 `~/.config/kiro-provider/config.json`，若设置了 `XDG_CONFIG_HOME`，则为 `$XDG_CONFIG_HOME/kiro-provider/config.json`。账号管理子命令（`accounts list|import|remove`）只操作本地兼容存储，不加载网关配置，也不要求 `api_keys`。

## 字段参考

| 字段                         | 类型 / 默认值                                                          | 环境变量                                   | 说明                                                                                                                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`                       | `string`，默认 `"127.0.0.1"`                                           | `KIRO_PROVIDER_HOST`                       | HTTP 绑定地址。                                                                                                                                                                                    |
| `port`                       | `number`，默认 `8787`                                                  | `KIRO_PROVIDER_PORT`                       | HTTP 监听端口。                                                                                                                                                                                    |
| `api_keys`                   | `string[]`，**必填，去空格后不能为空**                                 | `KIRO_PROVIDER_API_KEYS`                   | 接受的 Bearer Key 列表。环境变量以逗号分隔。空列表或仅含空白会被拒绝，服务不会启动（默认拒绝启动）。                                                                                               |
| `enable_legacy_chat_completions` | `boolean`，默认 `false`                                          | `KIRO_PROVIDER_ENABLE_LEGACY_CHAT_COMPLETIONS` | 是否开放 `POST /v1/chat/completions`。除非客户端不能使用 Responses 或 Anthropic Messages，否则应保持关闭。环境变量接受 `true`、`false`、`1`、`0`。                                              |
| `protocol_projection_mode`  | `"safe" \| "legacy-user-prefix"`，默认 `"safe"`                    | `KIRO_PROVIDER_PROTOCOL_PROJECTION_MODE`   | `safe` 禁止模型可见的兼容文本并拒绝无法投影的指令角色；`legacy-user-prefix` 仅用于指令迁移，计划在 v0.7.0 删除。                                                                                       |
| `auth_source`                | `"opencode-shared" \| "local"`，默认 `"opencode-shared"`              | `KIRO_PROVIDER_AUTH_SOURCE`                | 认证事实源。共享模式实时使用 OpenCode 的 Kiro 数据库和兼容刷新锁；本地模式使用 provider 自有账号库，并允许 `kiro-provider login`。                                                               |
| `opencode_auth_db_path`      | `string \| null`，默认 `null`                                         | `KIRO_PROVIDER_OPENCODE_AUTH_DB_PATH`      | OpenCode Kiro 共享数据库的可选覆盖路径。`null` 使用 `$XDG_CONFIG_HOME/opencode/kiro.db` 或 `~/.config/opencode/kiro.db`；本地模式忽略此字段。                                                      |
| `proxy_url`                  | `string \| null`，默认 `null`                                          | `KIRO_PROVIDER_PROXY_URL`                  | 可选的全局 HTTP(S) 代理，覆盖**所有**上游出网流量（模型请求、令牌刷新、设备码登录）。必须是合法的 `http://` 或 `https://` URL，其他协议（如 SOCKS）会被拒绝。`null` 或空字符串表示直连。           |
| `default_region`             | `string`，默认 `"us-east-1"`                                           | `KIRO_PROVIDER_DEFAULT_REGION`             | `login` 使用的区域，以及没有单独 profile ARN 覆盖的账号所使用的区域。                                                                                                                              |
| `account_selection_strategy` | `"sticky" \| "round-robin" \| "lowest-usage"`，默认 `"lowest-usage"`   | `KIRO_PROVIDER_ACCOUNT_SELECTION_STRATEGY` | 每次请求如何选择账号：`sticky` 倾向复用同一账号，`round-robin` 轮询，`lowest-usage` 优先选剩余额度最多的账号。                                                                                     |
| `rate_limit_max_retries`     | `number`，默认 `3`                                                     | `KIRO_PROVIDER_RATE_LIMIT_MAX_RETRIES`     | 对可重试限流响应的最大重试次数。                                                                                                                                                                   |
| `rate_limit_retry_delay_ms`  | `number`，默认 `5000`                                                  | `KIRO_PROVIDER_RATE_LIMIT_RETRY_DELAY_MS`  | 限流重试的基础延迟（毫秒）。                                                                                                                                                                       |
| `max_request_iterations`     | `number`，默认 `20`                                                    | `KIRO_PROVIDER_MAX_REQUEST_ITERATIONS`     | 单次请求内账号切换与重试循环的总迭代次数上限。                                                                                                                                                     |
| `request_timeout_ms`         | 整数，`1`-`2147483647`，默认 `120000`                                  | `KIRO_PROVIDER_REQUEST_TIMEOUT_MS`         | 单次请求的绝对超时时间（毫秒）。取值范围与已知限制见[超时字段的取值范围](#超时字段的取值范围)。                                                                                                    |
| `stream_idle_timeout_ms`     | 整数，`1`-`2147483647`，默认 `60000`                                   | `KIRO_PROVIDER_STREAM_IDLE_TIMEOUT_MS`     | 流式响应中两次上游事件之间允许的最大空闲间隔（毫秒），超过则中止流。取值范围见[超时字段的取值范围](#超时字段的取值范围)。                                                                          |
| `max_request_body_bytes`     | `number`，默认 `10485760`（10 MiB）                                    | `KIRO_PROVIDER_MAX_REQUEST_BODY_BYTES`     | 允许的最大请求体大小；超出返回 HTTP 413。                                                                                                                                                          |
| `token_expiry_buffer_ms`     | `number`，默认 `300000`（5 分钟）                                      | `KIRO_PROVIDER_TOKEN_EXPIRY_BUFFER_MS`     | 在访问令牌实际过期前多久主动触发刷新。                                                                                                                                                             |
| `session_affinity_ttl_ms`    | 整数，`1`-`2147483647`，默认 `86400000`（24 小时）                    | `KIRO_PROVIDER_SESSION_AFFINITY_TTL_MS`    | 持久化逻辑会话绑定的滑动有效期；每次命中都会续期。过期后按正常账号策略重新建立绑定。                                                                                                               |
| `session_affinity_max_entries` | 整数，`1`-`1000000`，默认 `10000`                                   | `KIRO_PROVIDER_SESSION_AFFINITY_MAX_ENTRIES` | 最多保留的会话绑定数；超限时优先清理最久未使用的记录。                                                                                                                                           |
| `reasoning_replay_key_path` | `string \| null`，默认 `null`                                         | `KIRO_PROVIDER_REASONING_REPLAY_KEY_PATH`  | reasoning 密钥文件覆盖路径。`null` 使用平台配置目录；未配置环境密钥环时会原子生成 `reasoning-replay-keys.json`，POSIX 权限强制为 `0600`。                                                          |
| `reasoning_replay_keys`     | `string[]`，默认 `[]`                                                  | `KIRO_PROVIDER_REASONING_REPLAY_KEYS`      | AES-256-GCM 密钥环。环境变量使用逗号分隔的 `key-id:base64url-32-byte-key`，key ID 可省略。首个密钥用于新记录加密，其余只解密旧记录。                                                               |
| `reasoning_replay_ttl_ms`   | 整数，`1`-`2147483647`，默认 `86400000`（24 小时）                    | `KIRO_PROVIDER_REASONING_REPLAY_TTL_MS`    | 加密 reasoning 回放记录的有效期；过期会明确报错，并在事务中清理。                                                                                                                                |
| `reasoning_replay_max_entries` | 整数，`1`-`1000000`，默认 `10000`                                  | `KIRO_PROVIDER_REASONING_REPLAY_MAX_ENTRIES` | 加密回放记录上限；清理过期记录后，在同一事务中按 LRU 淘汰。                                                                                                                                     |
| `effort`                     | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| null`，默认 `null` | `KIRO_PROVIDER_EFFORT`                     | 可选的全局推理强度覆盖，应用于每个请求。`null` 表示不强制覆盖，除非请求自身指定。                                                                                                                  |
| `auto_effort_mapping`        | `boolean`，默认 `true`                                                 | `KIRO_PROVIDER_AUTO_EFFORT_MAPPING`        | 启用后，网关会自动映射模型变体后缀与请求的 effort。环境变量值接受 `true`、`false`、`1`、`0`。                                                                                                      |
| `log_level`                  | `string`，默认 `"info"`                                                | `KIRO_PROVIDER_LOG_LEVEL`                  | 传给日志组件的日志级别。                                                                                                                                                                           |
| `test_upstream_endpoint`     | `string`（合法 URL），可选，默认不设置                                 | `KIRO_PROVIDER_TEST_UPSTREAM`              | **仅用于测试。** 覆盖 AWS CodeWhisperer SDK 用于上游调用的端点，供 `scripts/security-check.sh` 和隔离测试指向非生产端点使用。设置后 `serve` 启动时会在 stderr 打印警告。正常生产环境不要设置此项。 |

## 认证事实源

`auth_source: "opencode-shared"` 是生产默认值。Provider 会：

- 打开 `opencode_auth_db_path` 指定的数据库，或 OpenCode 的平台默认 Kiro
  数据库。
- 要求符合 v0.20.7 的账号/墓碑 schema；缺少必要列时默认拒绝启动，不会迁移
  或改写上游 schema。
- 每次进入账号选择流程时同步账号新增、重新登录、token 轮换、墓碑、健康与
  用量状态。
- 使用与 `opencode-kiro-auth` 相同的每账号锁文件约定和有界等待策略，并在
  获得锁后重新读取最新 token。
- 先持久化刷新结果，再对请求发布；使用完整 token/login 快照做
  compare-and-swap，防止旧的在途刷新覆盖更新的重新登录。

请运行 `opencode auth login` 并选择 Kiro。共享模式下执行
`kiro-provider login` 会明确提示改用 OpenCode，不会悄悄创建第二个认证
所有者。

`auth_source: "local"` 只用于隔离兼容部署，使用
`~/.config/kiro-provider/accounts.db`。`kiro-provider login`、
`accounts list|import|remove` 与快照导入都只作用于该存储。不要让本地快照与
OpenCode 同时持有同一个会轮换的 refresh token，除非你明确接受认证所有权
分裂的风险。

## 代理

`proxy_url` 是唯一的开关，一旦设置，会把**所有**上游流量都改走同一个 HTTP(S) 代理：

- 模型请求（chat completions）。
- 访问令牌刷新。
- 本地兼容模式的设备码登录（`login`）。

某些网络环境下，一部分模型系列可以直连，另一部分不能 —— 例如 GPT 请求直连成功，而 Claude 请求需要走审批过的代理出网，否则会返回 HTTP 401/403。

对 `serve` 而言，设置方式按以下优先级生效：

1. `--proxy <url>`（CLI 参数，仅 `serve` 支持）。
2. `KIRO_PROVIDER_PROXY_URL`（环境变量）。
3. 配置文件中的 `proxy_url`。

`login` 没有 `--proxy` 参数，因此本地模式的设备码登录只会读取环境变量或
配置文件中的值。共享模式的首次认证由 OpenCode 发起；provider 自身的 token
刷新仍会遵守 `proxy_url`。

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
  覆盖时才返回 HTTP 200。

`protocol_projection_mode: "safe"` 是生产默认值。实时 Kiro 探针已经证明，
被测试的空标签 `additionalContext` 会遭到拒绝；因此 safe 模式对 Responses
`instructions`、OpenAI `system`/`developer` 与 Anthropic `system` 返回
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

## 会话亲和与连接复用

网关不要求客户端增加私有 Header、Cookie 或补丁，而是从标准客户端本来就会
发送的字段中生成按 API Key 租户隔离、不可逆的会话指纹：

- Responses：依次使用 `client_metadata.thread_id`、`session_id`、
  `conversation_id`，然后是 `prompt_cache_key`，最后回退到初始输入。
- Chat Completions：依次使用 `prompt_cache_key`、`user` 加首个用户回合，
  最后回退到首个用户回合。
- Anthropic Messages：优先使用 `metadata.user_id` 加首个用户回合，最后
  回退到首个用户回合。

Provider 自有 SQLite 只保存指纹、选中的账号 ID、Kiro `conversationId` 和
时间戳，不保存原始会话字段或提示词。同一逻辑会话在单进程内串行；不同账号可并行；共享
同一账号的请求经过账号队列，并复用该账号的 keep-alive 传输池。遇到限流
或不健康账号时，会话会重绑到替代账号并更换 Kiro `conversationId`。

这属于“尽可能复用”，不是固定物理 TCP socket 的承诺：Node/Smithy
Agent、代理、远端服务、空闲超时与网络都可能创建新 socket。多进程部署时，
provider SQLite 共享逻辑账号/会话绑定，OpenCode 数据库和刷新锁协调认证；
排队串行和 socket 池仍是每进程独立。

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
  "auth_source": "opencode-shared",
  "opencode_auth_db_path": null,
  "proxy_url": null,
  "default_region": "us-east-1",
  "account_selection_strategy": "lowest-usage",
  "rate_limit_max_retries": 3,
  "rate_limit_retry_delay_ms": 5000,
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
