# Configuration reference

[简体中文](readme/CONFIGURATION.zh.md) · English

kiro-provider loads configuration from a JSON file, layered with environment variables and (for `serve`) CLI flags. This document is the complete field reference; see the [README](../README.md#configuration) for a quick summary.

## Precedence

For every field, the effective value is the first one found, in this order:

1. **CLI flag** — `serve` only supports `--config`, `--host`, `--port`, `--proxy`. `login` supports `--config` (selects the file, does not override fields).
2. **Environment variable** — `KIRO_PROVIDER_*`, listed per field below.
3. **Configuration file** — JSON at the resolved config path.
4. **Schema default** — the zod schema default in `src/config/schema.ts`.

The config file path defaults to `~/.config/kiro-provider/config.json`, or `$XDG_CONFIG_HOME/kiro-provider/config.json` when `XDG_CONFIG_HOME` is set. Account-management subcommands (`accounts list|import|remove`) target the local compatibility store; they do not load gateway configuration and do not require `api_keys`.

## Field reference

| Field                        | Type / default                                                            | Environment override                       | Description                                                                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`                       | `string`, default `"127.0.0.1"`                                           | `KIRO_PROVIDER_HOST`                       | HTTP bind address.                                                                                                                                                                                                                                                                    |
| `port`                       | `number`, default `8787`                                                  | `KIRO_PROVIDER_PORT`                       | HTTP listen port.                                                                                                                                                                                                                                                                     |
| `api_keys`                   | `string[]`, **required, non-empty after trimming**                        | `KIRO_PROVIDER_API_KEYS`                   | Accepted Bearer keys. The environment value is a comma-separated list. An empty or whitespace-only list is rejected and the server refuses to start (fail-closed).                                                                                                                    |
| `enable_legacy_chat_completions` | `boolean`, default `false`                                            | `KIRO_PROVIDER_ENABLE_LEGACY_CHAT_COMPLETIONS` | Exposes `POST /v1/chat/completions`. Keep this disabled unless a client cannot use Responses or Anthropic Messages. Environment values accept `true`, `false`, `1`, `0`.                                                                                                             |
| `auth_source`                | `"opencode-shared" \| "local"`, default `"opencode-shared"`              | `KIRO_PROVIDER_AUTH_SOURCE`                | Authentication authority. Shared mode uses OpenCode's live Kiro database and compatible refresh lock. Local mode uses the provider-owned account database and enables `kiro-provider login`.                                                                                         |
| `opencode_auth_db_path`      | `string \| null`, default `null`                                         | `KIRO_PROVIDER_OPENCODE_AUTH_DB_PATH`      | Optional override for the shared OpenCode Kiro database. `null` uses `$XDG_CONFIG_HOME/opencode/kiro.db` or `~/.config/opencode/kiro.db`. Ignored by local mode.                                                                                                                       |
| `proxy_url`                  | `string \| null`, default `null`                                          | `KIRO_PROVIDER_PROXY_URL`                  | Optional global HTTP(S) proxy for **all** upstream egress (model requests, token refresh, device-code login). Must be a valid `http://` or `https://` URL; other schemes (e.g. SOCKS) are rejected. `null` or an empty string means direct connections.                               |
| `default_region`             | `string`, default `"us-east-1"`                                           | `KIRO_PROVIDER_DEFAULT_REGION`             | Region used by `login` and for accounts without a profile ARN override.                                                                                                                                                                                                               |
| `account_selection_strategy` | `"sticky" \| "round-robin" \| "lowest-usage"`, default `"lowest-usage"`   | `KIRO_PROVIDER_ACCOUNT_SELECTION_STRATEGY` | How the gateway picks an account per request: `sticky` favors the same account, `round-robin` cycles, `lowest-usage` prefers the account with the most remaining quota.                                                                                                               |
| `rate_limit_max_retries`     | `number`, default `3`                                                     | `KIRO_PROVIDER_RATE_LIMIT_MAX_RETRIES`     | Maximum retry count for retryable rate-limit responses.                                                                                                                                                                                                                               |
| `rate_limit_retry_delay_ms`  | `number`, default `5000`                                                  | `KIRO_PROVIDER_RATE_LIMIT_RETRY_DELAY_MS`  | Base retry delay in milliseconds before a rate-limit retry.                                                                                                                                                                                                                           |
| `max_request_iterations`     | `number`, default `20`                                                    | `KIRO_PROVIDER_MAX_REQUEST_ITERATIONS`     | Global cap on account-switching and retry-loop iterations for a single request.                                                                                                                                                                                                       |
| `request_timeout_ms`         | integer, `1`-`2147483647`, default `120000`                               | `KIRO_PROVIDER_REQUEST_TIMEOUT_MS`         | Absolute deadline for a request, in milliseconds. See [Timeout limits](#timeout-limits) for the accepted range and a known limitation.                                                                                                                                                |
| `stream_idle_timeout_ms`     | integer, `1`-`2147483647`, default `60000`                                | `KIRO_PROVIDER_STREAM_IDLE_TIMEOUT_MS`     | Maximum idle interval between upstream streaming events before the stream is aborted, in milliseconds. See [Timeout limits](#timeout-limits) for the accepted range.                                                                                                                  |
| `max_request_body_bytes`     | `number`, default `10485760` (10 MiB)                                     | `KIRO_PROVIDER_MAX_REQUEST_BODY_BYTES`     | Maximum accepted request body size; larger requests get HTTP 413.                                                                                                                                                                                                                     |
| `token_expiry_buffer_ms`     | `number`, default `300000` (5 min)                                        | `KIRO_PROVIDER_TOKEN_EXPIRY_BUFFER_MS`     | How long before actual access-token expiry the gateway proactively refreshes.                                                                                                                                                                                                         |
| `session_affinity_ttl_ms`    | integer, `1`-`2147483647`, default `86400000` (24 h)                       | `KIRO_PROVIDER_SESSION_AFFINITY_TTL_MS`    | Sliding lifetime of a persisted logical-session binding. A hit extends the expiry; an expired binding is recreated using the normal account strategy.                                                                                                                                 |
| `session_affinity_max_entries` | integer, `1`-`1000000`, default `10000`                                  | `KIRO_PROVIDER_SESSION_AFFINITY_MAX_ENTRIES` | Maximum persisted session bindings. When over the limit, least-recently-seen entries are removed.                                                                                                                                                                                     |
| `effort`                     | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| null`, default `null` | `KIRO_PROVIDER_EFFORT`                     | Optional global reasoning-effort override applied to every request. `null` leaves effort unset unless the request specifies it.                                                                                                                                                       |
| `auto_effort_mapping`        | `boolean`, default `true`                                                 | `KIRO_PROVIDER_AUTO_EFFORT_MAPPING`        | When enabled, the gateway automatically maps model-variant suffixes and request effort. Environment values accept `true`, `false`, `1`, `0`.                                                                                                                                          |
| `log_level`                  | `string`, default `"info"`                                                | `KIRO_PROVIDER_LOG_LEVEL`                  | Log verbosity passed to the logger.                                                                                                                                                                                                                                                   |
| `test_upstream_endpoint`     | `string` (valid URL), optional, omitted by default                        | `KIRO_PROVIDER_TEST_UPSTREAM`              | **Test-only.** Overrides the AWS CodeWhisperer SDK endpoint used for upstream calls. Used by `scripts/security-check.sh` and isolated tests to point at a non-production endpoint. When set, `serve` prints a warning to stderr on startup. Do not set this in normal production use. |

## Authentication source

`auth_source: "opencode-shared"` is the production default. The provider:

- Opens the same Kiro database used by OpenCode at
  `opencode_auth_db_path` or the platform default.
- Requires the v0.20.6 account/tombstone schema and fails closed when required
  columns are missing. It does not migrate or rewrite the schema.
- Reconciles account additions, re-logins, token rotation, tombstones, health,
  and usage from that live database for each pipeline selection.
- Uses the same per-account lock-file convention and bounded lock behavior as
  `opencode-kiro-auth`, then re-reads the current token inside the lock.
- Persists a refreshed token before publishing it to requests and uses a
  compare-and-swap snapshot so a stale in-flight refresh cannot overwrite a
  newer login.

Authenticate with `opencode auth login` and select Kiro. In this mode,
`kiro-provider login` exits with an explanation instead of creating a second
authentication owner.

`auth_source: "local"` is retained for isolated compatibility deployments.
It uses `~/.config/kiro-provider/accounts.db`; `kiro-provider login`,
`accounts list|import|remove`, and snapshot imports apply only to that store.
Do not run a local snapshot and OpenCode against the same rotating refresh
token unless you intentionally accept split ownership.

## Proxy

`proxy_url` is the single knob that redirects **every** kind of upstream traffic through one HTTP(S) proxy:

- Model requests (chat completions).
- Access-token refresh.
- Device-code login in local compatibility mode (`login`).

A proxy may be required when a network reaches some model families directly but not others — for example, GPT requests succeed direct while Claude requests need an approved proxy egress and otherwise return HTTP 401/403.

Setting it, in order of precedence for `serve`:

1. `--proxy <url>` (CLI flag, `serve` only).
2. `KIRO_PROVIDER_PROXY_URL` (environment variable).
3. `proxy_url` in the config file.

`login` has no `--proxy` flag, so local-mode device-code login only picks up
the environment variable or the config file value. Shared-mode authentication
is initiated by OpenCode; provider-side refresh still honors `proxy_url`.

```bash
KIRO_PROVIDER_PROXY_URL=http://proxy.example.com:8080 \
  ./dist/kiro-provider serve

./dist/kiro-provider serve --proxy https://proxy.example.com:8443
```

Only `http://` and `https://` schemes are accepted; an invalid or non-HTTP(S) URL fails config validation at startup.

## Protocol exposure

- `POST /v1/responses` is always enabled and is the preferred OpenAI/Codex
  interface.
- `POST /v1/messages` and `POST /v1/messages/count_tokens` are always enabled
  for Anthropic clients and Claude Code.
- `POST /v1/chat/completions` returns
  `legacy_chat_completions_disabled` unless
  `enable_legacy_chat_completions` is explicitly set to `true`.
- Authenticated `GET /ready` returns HTTP 200 only when the configured
  authentication source is readable and at least one active account exists.

The token-count endpoint uses the provider's fallback estimator because Kiro
does not expose a standalone tokenizer. Its successful response includes
`x-kiro-token-count-mode: estimate`.

## Session affinity and connection reuse

The gateway does not require custom headers, cookies, or modified clients.
It derives a tenant-isolated, irreversible affinity hash from fields already
sent by standard clients:

- Responses: `client_metadata.thread_id`, `session_id`, or
  `conversation_id`; then `prompt_cache_key`; then the initial input.
- Chat Completions: `prompt_cache_key`; then `user` plus the initial user
  turn; then the initial user turn alone.
- Anthropic Messages: `metadata.user_id` plus the initial user turn; then the
  initial user turn alone.

The provider SQLite binding stores the hash, selected account ID, Kiro
`conversationId`, and timestamps—not the original session field or prompt.
One logical session is serialized in-process. Different accounts can execute
concurrently, while requests sharing an account use one account queue and a
shared keep-alive transport pool. A rate-limit or unhealthy-account failover
rebinds the session to the replacement account and rotates the Kiro
conversation ID.

This maximizes reuse but does not guarantee one physical TCP socket: the
Node/Smithy agent, proxy, remote server, idle timeout, and network can open a
new socket. Across multiple provider processes, the provider SQLite database
preserves the logical account/conversation binding, while the OpenCode
database and refresh lock preserve authentication coordination. Queue
serialization and socket pools remain per process.

The gateway is stateless with respect to OpenAI response objects.
`previous_response_id` and `conversation` therefore return
`unsupported_stateful_responses` instead of being silently ignored. Resend
the complete Responses input.

## Timeout limits

`request_timeout_ms` and `stream_idle_timeout_ms` both accept integers from `1` through `2147483647` (2³¹−1) milliseconds. Fractional values, `0`, negative numbers, `NaN`, and anything above `2147483647` are rejected at config validation. This bound comes from the JS/Bun `setTimeout` 32-bit-safe timer range, not from an arbitrary product cap — values above it would silently fire far earlier than configured instead of failing loudly.

`request_timeout_ms` bounds the gateway's own application-layer cleanup: the pipeline queue lock, the deadline timer, request-scoped idle-timeout lease restoration, and the SDK iterator/reader cleanup attempt are all released deterministically once the deadline fires, regardless of what the client is doing. It does **not** guarantee that the underlying TCP socket's file descriptor or its outbound `Send-Q` closes within that same window. On Bun 1.3.14, a client that has paused reading under write backpressure can leave the connection in `ESTABLISHED`/`FIN-WAIT-1` with a nonzero `Send-Q` even after the gateway has finished its own cleanup — this is a platform-level limitation of Bun's current transport, not something `request_timeout_ms` can bound on its own.

If you need a hard upper bound on connection lifetime regardless of client read behavior, terminate the connection at a reverse proxy with its own send/write timeout in front of the gateway, or track future Bun releases for stronger transport-level guarantees.

## Example config file

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "api_keys": ["sk-REPLACE-ME"],
  "enable_legacy_chat_completions": false,
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
  "effort": null,
  "auto_effort_mapping": true,
  "log_level": "info"
}
```

This mirrors `config.example.json` at the repo root. Replace `sk-REPLACE-ME` with a private, randomly generated key before deploying; an empty `api_keys` list is rejected at startup.
