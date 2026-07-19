# 配置字段完整参考

简体中文 · [English](../CONFIGURATION.md)

kiro-provider 的配置由 JSON 文件、环境变量以及（仅 `serve`）CLI 参数三层叠加而成。本文是完整字段参考；快速概览见 [README](../../README.zh.md#配置)。

## 优先级

每个字段的最终取值按以下顺序取第一个命中的来源：

1. **CLI 参数** —— `serve` 仅支持 `--config`、`--host`、`--port`、`--proxy`；`login` 支持 `--config`（仅用于选择文件，不会覆盖字段）。
2. **环境变量** —— `KIRO_PROVIDER_*`，见下表。
3. **配置文件** —— 解析出的配置路径下的 JSON 文件。
4. **Schema 默认值** —— `src/config/schema.ts` 中 zod schema 的默认值。

配置文件默认路径为 `~/.config/kiro-provider/config.json`，若设置了 `XDG_CONFIG_HOME`，则为 `$XDG_CONFIG_HOME/kiro-provider/config.json`。账号管理子命令（`accounts list|import|remove`）不加载网关配置，也不要求 `api_keys`。

## 字段参考

| 字段 | 类型 / 默认值 | 环境变量 | 说明 |
| --- | --- | --- | --- |
| `host` | `string`，默认 `"127.0.0.1"` | `KIRO_PROVIDER_HOST` | HTTP 绑定地址。 |
| `port` | `number`，默认 `8787` | `KIRO_PROVIDER_PORT` | HTTP 监听端口。 |
| `api_keys` | `string[]`，**必填，去空格后不能为空** | `KIRO_PROVIDER_API_KEYS` | 接受的 Bearer Key 列表。环境变量以逗号分隔。空列表或仅含空白会被拒绝，服务不会启动（默认拒绝启动）。 |
| `proxy_url` | `string \| null`，默认 `null` | `KIRO_PROVIDER_PROXY_URL` | 可选的全局 HTTP(S) 代理，覆盖**所有**上游出网流量（模型请求、令牌刷新、设备码登录）。必须是合法的 `http://` 或 `https://` URL，其他协议（如 SOCKS）会被拒绝。`null` 或空字符串表示直连。 |
| `default_region` | `string`，默认 `"us-east-1"` | `KIRO_PROVIDER_DEFAULT_REGION` | `login` 使用的区域，以及没有单独 profile ARN 覆盖的账号所使用的区域。 |
| `account_selection_strategy` | `"sticky" \| "round-robin" \| "lowest-usage"`，默认 `"lowest-usage"` | `KIRO_PROVIDER_ACCOUNT_SELECTION_STRATEGY` | 每次请求如何选择账号：`sticky` 倾向复用同一账号，`round-robin` 轮询，`lowest-usage` 优先选剩余额度最多的账号。 |
| `rate_limit_max_retries` | `number`，默认 `3` | `KIRO_PROVIDER_RATE_LIMIT_MAX_RETRIES` | 对可重试限流响应的最大重试次数。 |
| `rate_limit_retry_delay_ms` | `number`，默认 `5000` | `KIRO_PROVIDER_RATE_LIMIT_RETRY_DELAY_MS` | 限流重试的基础延迟（毫秒）。 |
| `max_request_iterations` | `number`，默认 `20` | `KIRO_PROVIDER_MAX_REQUEST_ITERATIONS` | 单次请求内账号切换与重试循环的总迭代次数上限。 |
| `request_timeout_ms` | `number`，默认 `120000` | `KIRO_PROVIDER_REQUEST_TIMEOUT_MS` | 单次请求的绝对超时时间（毫秒）。 |
| `stream_idle_timeout_ms` | `number`，默认 `60000` | `KIRO_PROVIDER_STREAM_IDLE_TIMEOUT_MS` | 流式响应中两次上游事件之间允许的最大空闲间隔（毫秒），超过则中止流。 |
| `max_request_body_bytes` | `number`，默认 `10485760`（10 MiB） | `KIRO_PROVIDER_MAX_REQUEST_BODY_BYTES` | 允许的最大请求体大小；超出返回 HTTP 413。 |
| `token_expiry_buffer_ms` | `number`，默认 `300000`（5 分钟） | `KIRO_PROVIDER_TOKEN_EXPIRY_BUFFER_MS` | 在访问令牌实际过期前多久主动触发刷新。 |
| `effort` | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| null`，默认 `null` | `KIRO_PROVIDER_EFFORT` | 可选的全局推理强度覆盖，应用于每个请求。`null` 表示不强制覆盖，除非请求自身指定。 |
| `auto_effort_mapping` | `boolean`，默认 `true` | `KIRO_PROVIDER_AUTO_EFFORT_MAPPING` | 启用后，网关会自动映射模型变体后缀与请求的 effort。环境变量值接受 `true`、`false`、`1`、`0`。 |
| `log_level` | `string`，默认 `"info"` | `KIRO_PROVIDER_LOG_LEVEL` | 传给日志组件的日志级别。 |
| `test_upstream_endpoint` | `string`（合法 URL），可选，默认不设置 | `KIRO_PROVIDER_TEST_UPSTREAM` | **仅用于测试。** 覆盖 AWS CodeWhisperer SDK 用于上游调用的端点，供 `scripts/security-check.sh` 和隔离测试指向非生产端点使用。设置后 `serve` 启动时会在 stderr 打印警告。正常生产环境不要设置此项。 |

## 代理

`proxy_url` 是唯一的开关，一旦设置，会把**所有**上游流量都改走同一个 HTTP(S) 代理：

- 模型请求（chat completions）。
- 访问令牌刷新。
- 设备码登录（`login`）。

某些网络环境下，一部分模型系列可以直连，另一部分不能 —— 例如 GPT 请求直连成功，而 Claude 请求需要走审批过的代理出网，否则会返回 HTTP 401/403。

对 `serve` 而言，设置方式按以下优先级生效：

1. `--proxy <url>`（CLI 参数，仅 `serve` 支持）。
2. `KIRO_PROVIDER_PROXY_URL`（环境变量）。
3. 配置文件中的 `proxy_url`。

`login` 没有 `--proxy` 参数，因此设备码登录只会读取环境变量或配置文件中的值。

```bash
KIRO_PROVIDER_PROXY_URL=http://proxy.example.com:8080 \
  ./dist/kiro-provider serve

./dist/kiro-provider serve --proxy https://proxy.example.com:8443
```

只接受 `http://` 和 `https://` 协议；非法或非 HTTP(S) 的 URL 会在启动时的配置校验阶段失败。

## 配置文件示例

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "api_keys": ["sk-REPLACE-ME"],
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
  "effort": null,
  "auto_effort_mapping": true,
  "log_level": "info"
}
```

以上与仓库根目录的 `config.example.json` 一致。部署前请把 `sk-REPLACE-ME` 换成私有的随机 Key；空的 `api_keys` 列表会在启动时被拒绝。
