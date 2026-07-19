# Configuration reference

[简体中文](readme/CONFIGURATION.zh.md) · English

kiro-provider loads configuration from a JSON file, layered with environment variables and (for `serve`) CLI flags. This document is the complete field reference; see the [README](../README.md#configuration) for a quick summary.

## Precedence

For every field, the effective value is the first one found, in this order:

1. **CLI flag** — `serve` only supports `--config`, `--host`, `--port`, `--proxy`. `login` supports `--config` (selects the file, does not override fields).
2. **Environment variable** — `KIRO_PROVIDER_*`, listed per field below.
3. **Configuration file** — JSON at the resolved config path.
4. **Schema default** — the zod schema default in `src/config/schema.ts`.

The config file path defaults to `~/.config/kiro-provider/config.json`, or `$XDG_CONFIG_HOME/kiro-provider/config.json` when `XDG_CONFIG_HOME` is set. Account-management subcommands (`accounts list|import|remove`) do not load gateway configuration and do not require `api_keys`.

## Field reference

| Field | Type / default | Environment override | Description |
| --- | --- | --- | --- |
| `host` | `string`, default `"127.0.0.1"` | `KIRO_PROVIDER_HOST` | HTTP bind address. |
| `port` | `number`, default `8787` | `KIRO_PROVIDER_PORT` | HTTP listen port. |
| `api_keys` | `string[]`, **required, non-empty after trimming** | `KIRO_PROVIDER_API_KEYS` | Accepted Bearer keys. The environment value is a comma-separated list. An empty or whitespace-only list is rejected and the server refuses to start (fail-closed). |
| `proxy_url` | `string \| null`, default `null` | `KIRO_PROVIDER_PROXY_URL` | Optional global HTTP(S) proxy for **all** upstream egress (model requests, token refresh, device-code login). Must be a valid `http://` or `https://` URL; other schemes (e.g. SOCKS) are rejected. `null` or an empty string means direct connections. |
| `default_region` | `string`, default `"us-east-1"` | `KIRO_PROVIDER_DEFAULT_REGION` | Region used by `login` and for accounts without a profile ARN override. |
| `account_selection_strategy` | `"sticky" \| "round-robin" \| "lowest-usage"`, default `"lowest-usage"` | `KIRO_PROVIDER_ACCOUNT_SELECTION_STRATEGY` | How the gateway picks an account per request: `sticky` favors the same account, `round-robin` cycles, `lowest-usage` prefers the account with the most remaining quota. |
| `rate_limit_max_retries` | `number`, default `3` | `KIRO_PROVIDER_RATE_LIMIT_MAX_RETRIES` | Maximum retry count for retryable rate-limit responses. |
| `rate_limit_retry_delay_ms` | `number`, default `5000` | `KIRO_PROVIDER_RATE_LIMIT_RETRY_DELAY_MS` | Base retry delay in milliseconds before a rate-limit retry. |
| `max_request_iterations` | `number`, default `20` | `KIRO_PROVIDER_MAX_REQUEST_ITERATIONS` | Global cap on account-switching and retry-loop iterations for a single request. |
| `request_timeout_ms` | `number`, default `120000` | `KIRO_PROVIDER_REQUEST_TIMEOUT_MS` | Absolute deadline for a request, in milliseconds. |
| `stream_idle_timeout_ms` | `number`, default `60000` | `KIRO_PROVIDER_STREAM_IDLE_TIMEOUT_MS` | Maximum idle interval between upstream streaming events before the stream is aborted, in milliseconds. |
| `max_request_body_bytes` | `number`, default `10485760` (10 MiB) | `KIRO_PROVIDER_MAX_REQUEST_BODY_BYTES` | Maximum accepted request body size; larger requests get HTTP 413. |
| `token_expiry_buffer_ms` | `number`, default `300000` (5 min) | `KIRO_PROVIDER_TOKEN_EXPIRY_BUFFER_MS` | How long before actual access-token expiry the gateway proactively refreshes. |
| `effort` | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| null`, default `null` | `KIRO_PROVIDER_EFFORT` | Optional global reasoning-effort override applied to every request. `null` leaves effort unset unless the request specifies it. |
| `auto_effort_mapping` | `boolean`, default `true` | `KIRO_PROVIDER_AUTO_EFFORT_MAPPING` | When enabled, the gateway automatically maps model-variant suffixes and request effort. Environment values accept `true`, `false`, `1`, `0`. |
| `log_level` | `string`, default `"info"` | `KIRO_PROVIDER_LOG_LEVEL` | Log verbosity passed to the logger. |
| `test_upstream_endpoint` | `string` (valid URL), optional, omitted by default | `KIRO_PROVIDER_TEST_UPSTREAM` | **Test-only.** Overrides the AWS CodeWhisperer SDK endpoint used for upstream calls. Used by `scripts/security-check.sh` and isolated tests to point at a non-production endpoint. When set, `serve` prints a warning to stderr on startup. Do not set this in normal production use. |

## Proxy

`proxy_url` is the single knob that redirects **every** kind of upstream traffic through one HTTP(S) proxy:

- Model requests (chat completions).
- Access-token refresh.
- Device-code login (`login`).

A proxy may be required when a network reaches some model families directly but not others — for example, GPT requests succeed direct while Claude requests need an approved proxy egress and otherwise return HTTP 401/403.

Setting it, in order of precedence for `serve`:

1. `--proxy <url>` (CLI flag, `serve` only).
2. `KIRO_PROVIDER_PROXY_URL` (environment variable).
3. `proxy_url` in the config file.

`login` has no `--proxy` flag, so device-code login only picks up the environment variable or the config file value.

```bash
KIRO_PROVIDER_PROXY_URL=http://proxy.example.com:8080 \
  ./dist/kiro-provider serve

./dist/kiro-provider serve --proxy https://proxy.example.com:8443
```

Only `http://` and `https://` schemes are accepted; an invalid or non-HTTP(S) URL fails config validation at startup.

## Example config file

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

This mirrors `config.example.json` at the repo root. Replace `sk-REPLACE-ME` with a private, randomly generated key before deploying; an empty `api_keys` list is rejected at startup.
