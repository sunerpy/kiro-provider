# Configuration reference

[简体中文](readme/CONFIGURATION.zh.md) · English

kiro-provider loads configuration from a JSON file, layered with environment variables and (for `serve`) CLI flags. This document is the complete field reference; see the [README](../README.md#configuration) for a quick summary.

## Precedence

For every field, the effective value is the first one found, in this order:

1. **CLI flag** — `serve` only supports `--config`, `--host`, `--port`, `--proxy`. `login` supports `--config` (selects the file, does not override fields) and `--help`.
2. **Environment variable** — `KIRO_PROVIDER_*`, listed per field below.
3. **Configuration file** — JSON at the resolved config path.
4. **Schema default** — the zod schema default in `src/config/schema.ts`.

The config file path defaults to the platform configuration root plus `kiro-provider/config.json` (see [File locations](#file-locations)): `$XDG_CONFIG_HOME/kiro-provider/config.json` or `~/.config/kiro-provider/config.json` on Linux/macOS, `%APPDATA%\kiro-provider\config.json` on Windows. `accounts list|import|remove` target the provider-owned local authentication store without loading gateway configuration, so `accounts import` does not accept `--config`. `accounts refresh|relogin` load refresh, timeout, region, proxy, and `quota_recheck_concurrency` settings from the selected config and require `auth_source: "local"`.

## Validation rules

Configuration is validated once at startup; any violation raises a `ConfigLoadError` naming the offending field (and, for environment values, the variable) and the process exits before binding a port.

- **Empty environment variables are unset.** A `KIRO_PROVIDER_*` variable whose value is empty or whitespace-only is ignored, so `KIRO_PROVIDER_PORT=""` keeps the config-file value or the default instead of becoming `0`. This applies to every variable, including `KIRO_PROVIDER_PROXY_URL`; to disable a file-configured proxy from the environment, set `proxy_url` to `null` in the file or use `serve --proxy ""`.
- **Integer variables must be plain decimal integers.** Surrounding whitespace and an explicit sign are accepted; `0x1f90`, `8787.5`, `1e3`, or `NaN` are rejected with a message such as `Invalid environment variable KIRO_PROVIDER_PORT: expected a decimal integer, got "0x1f90"`. Out-of-range values are reported as `port: Number must be less than or equal to 65535 (from KIRO_PROVIDER_PORT)`.
- **Unknown config-file keys are rejected.** A misspelled key such as `enable_legacy_chat_completion` fails with `unknown key "enable_legacy_chat_completion" (did you mean "enable_legacy_chat_completions"?)` rather than being silently dropped.
- **Loose file permissions are reported.** On POSIX, when the config file is readable or writable by group or others (`mode & 0o077 != 0`), startup emits a `config_file_permissions_loose` warning with the path and current mode because the file usually contains `api_keys`. Loading still succeeds; run `chmod 600` on the file to silence the warning. The check is skipped on Windows.
- **Every numeric field is a bounded integer.** The accepted ranges are listed in the table below; fractional, `NaN`, infinite, and out-of-range values are rejected. Millisecond fields are capped at `2147483647` (see [Timeout limits](#timeout-limits)).

## Field reference

| Field                        | Type / default                                                            | Environment override                       | Description                                                                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`                       | `string` (non-empty), default `"127.0.0.1"`                               | `KIRO_PROVIDER_HOST`                       | HTTP bind address. Leading and trailing whitespace is trimmed; an empty value is rejected.                                                                                                                                                                                            |
| `port`                       | integer, `0`-`65535`, default `8787`                                      | `KIRO_PROVIDER_PORT`                       | HTTP listen port. `0` asks the OS for an ephemeral port (the bound address is printed at startup); `serve --port 0` is rejected. Fractional and out-of-range values are rejected, and an empty `KIRO_PROVIDER_PORT` no longer becomes `0`.                                              |
| `api_keys`                   | `string[]`, **required, non-empty after trimming**                        | `KIRO_PROVIDER_API_KEYS`                   | Accepted Bearer keys. The environment value is a comma-separated list. An empty or whitespace-only list is rejected and the server refuses to start (fail-closed).                                                                                                                    |
| `enable_legacy_chat_completions` | `boolean`, default `false`                                            | `KIRO_PROVIDER_ENABLE_LEGACY_CHAT_COMPLETIONS` | Exposes `POST /v1/chat/completions`. Keep this disabled unless a client cannot use Responses or Anthropic Messages. Environment values accept `true`, `false`, `1`, `0`.                                                                                                             |
| `protocol_projection_mode`   | `"safe" \| "legacy-user-prefix"`, default `"safe"`                    | `KIRO_PROVIDER_PROTOCOL_PROJECTION_MODE`   | `safe` forbids model-visible compatibility text and rejects unprojectable instruction roles. `legacy-user-prefix` is an instruction-only migration mode scheduled for removal in v0.7.0.                                                                                              |
| `session_affinity_mode`      | `"explicit-only" \| "legacy-initial-input"`, default `"explicit-only"` | `KIRO_PROVIDER_SESSION_AFFINITY_MODE`      | `explicit-only` never derives a logical session from prompt text. `legacy-initial-input` temporarily restores the old initial-input fingerprint heuristics without changing model-visible content.                                                                                     |
| `auth_source` | `"local"`, default `"local"` | `KIRO_PROVIDER_AUTH_SOURCE` | Authentication authority. Only the provider-owned local store is supported. The former `"opencode-shared"` value is rejected at startup with a migration message since 0.7.0: copy accounts once with `kiro-provider accounts import`, then use `"local"`. |
| `opencode_auth_db_path` | `string \| null`, default `null` | `KIRO_PROVIDER_OPENCODE_AUTH_DB_PATH` | Deprecated since 0.7.0 and ignored (a warning is logged); scheduled for removal. Point `kiro-provider accounts import --from <path>` at a non-default OpenCode database instead. |
| `proxy_url`                  | `string \| null`, default `null`                                          | `KIRO_PROVIDER_PROXY_URL`                  | Optional global HTTP(S) proxy for **all** upstream egress (model requests, token refresh, quota probes, device-code login). Must be a valid `http://` or `https://` URL; other schemes (e.g. SOCKS) are rejected. `null` or an empty string means direct connections.                 |
| `default_region`             | AWS region enum (`RegionSchema`), default `"us-east-1"`                    | `KIRO_PROVIDER_DEFAULT_REGION`             | Region used by `login` and for accounts without a profile ARN override. Must be one of the regions listed in `src/kiro/regions.ts` (for example `us-east-1`, `eu-west-1`, `ap-northeast-1`); unknown regions are rejected at startup.                                                    |
| `sdk_http_keep_alive`        | `boolean`, default `false`                                                | `KIRO_PROVIDER_SDK_HTTP_KEEP_ALIVE`        | Controls Kiro model-call sockets only. The transport object stays cached in either mode; an SDK client is reused only while its access token is unchanged and is rebuilt immediately after token rotation. `false` uses fresh direct/proxy SDK sockets; `true` opts into pooling after deployment-specific validation. Token refresh and device login keep their independent transport policy. |
| `enforce_single_instance`    | `boolean`, default `true`                                                 | `KIRO_PROVIDER_ENFORCE_SINGLE_INSTANCE`    | Acquires one service-process lock before binding the HTTP listener, keeping account/session queues and SDK pools single-owner. Disable only with independent credentials/state or an external serializer.                                                                              |
| `instance_lock_path`         | `string \| null`, default `null`                                          | `KIRO_PROVIDER_INSTANCE_LOCK_PATH`         | Optional service-lock target. `null` uses the platform config directory at `kiro-provider/service.instance`. POSIX mode is `0600`; different paths deliberately create independent process domains.                                                                                    |
| `runtime_endpoint_mode`      | `"kiro-runtime" \| "legacy-q"`, default `"kiro-runtime"`                 | `KIRO_PROVIDER_RUNTIME_ENDPOINT_MODE`      | Uses the live-probe-confirmed Kiro runtime endpoint by default. Successful current-runtime streams end with token-usage metadata or valid metering followed by clean EOF. `legacy-q` is retained for diagnosis/migration only and may not provide either authoritative witness.                                                                          |
| `dynamic_model_catalog`      | `boolean`, default `true`                                                 | `KIRO_PROVIDER_DYNAMIC_MODEL_CATALOG`      | Discovers models per usable account through Kiro management, routes only to accounts exposing the requested wire model, and uses the checked-in bounded catalog when management is unavailable.                                                                                        |
| `model_catalog_ttl_ms`       | integer, `1`-`2147483647`, default `900000` (15 min)                      | `KIRO_PROVIDER_MODEL_CATALOG_TTL_MS`       | Fresh lifetime of a successful per-account model catalog.                                                                                                                                                                                                                             |
| `model_catalog_stale_ttl_ms` | integer, `1`-`2147483647`, default `86400000` (24 h)                      | `KIRO_PROVIDER_MODEL_CATALOG_STALE_TTL_MS` | Maximum lifetime of a last-known-good account catalog after refresh failures.                                                                                                                                                                                                          |
| `model_catalog_request_timeout_ms` | integer, `1`-`2147483647`, default `10000`                         | `KIRO_PROVIDER_MODEL_CATALOG_REQUEST_TIMEOUT_MS` | Deadline for one Kiro management model-list request.                                                                                                                                                                                                                            |
| `account_selection_strategy` | `"sticky" \| "round-robin" \| "lowest-usage"`, default `"lowest-usage"`   | `KIRO_PROVIDER_ACCOUNT_SELECTION_STRATEGY` | How the gateway picks an account per request: `sticky` favors the same account, `round-robin` cycles, `lowest-usage` prefers the account with the most remaining quota.                                                                                                               |
| `rate_limit_max_retries`     | integer, `0`-`100`, default `3`                                           | `KIRO_PROVIDER_RATE_LIMIT_MAX_RETRIES`     | Maximum retry count for retryable rate-limit responses. `0` disables rate-limit retries.                                                                                                                                                                                              |
| `rate_limit_retry_delay_ms`  | integer, `1`-`2147483647`, default `5000`                                 | `KIRO_PROVIDER_RATE_LIMIT_RETRY_DELAY_MS`  | Base retry delay in milliseconds before a rate-limit retry.                                                                                                                                                                                                                           |
| `quota_recheck_interval_ms`  | integer, `1`-`2147483647`, default `900000` (15 min)                      | `KIRO_PROVIDER_QUOTA_RECHECK_INTERVAL_MS`  | Minimum wait before an exhausted account is probed again. If Kiro reports a quota reset time, the probe waits for that reset instead, capped at the larger of this interval and 24 hours. An HTTP 402, a still-exhausted snapshot, or a failed probe advances this timestamp; it does not create a model retry. |
| `quota_recheck_timeout_ms`   | integer, `1`-`2147483647`, default `10000`                                | `KIRO_PROVIDER_QUOTA_RECHECK_TIMEOUT_MS`   | Bounds both the request preflight quota-recheck batch and each started account probe. A timed-out probe keeps the account excluded and schedules the next check.                                                                                                                       |
| `quota_recheck_concurrency`  | integer, `1`-`32`, default `4`                                            | `KIRO_PROVIDER_QUOTA_RECHECK_CONCURRENCY`  | Maximum number of due exhausted accounts probed concurrently. Concurrent requests join the same per-account in-flight probe. Also bounds the concurrency of `accounts refresh`, which uses the same usage prober as the server.                                                          |
| `account_maintenance_enabled` | `boolean`, default `true`                                                | `KIRO_PROVIDER_ACCOUNT_MAINTENANCE_ENABLED` | Enables provider-owned background token and usage maintenance. Disable only when an external operator deliberately owns that lifecycle.                                                                                                                                              |
| `account_maintenance_interval_ms` | integer, `1000`-`2147483647`, default `60000`                      | `KIRO_PROVIDER_ACCOUNT_MAINTENANCE_INTERVAL_MS` | Interval between background maintenance passes. The first pass is scheduled shortly after startup.                                                                                                                                                                           |
| `account_maintenance_timeout_ms` | integer, `1000`-`2147483647`, default `120000`                       | `KIRO_PROVIDER_ACCOUNT_MAINTENANCE_TIMEOUT_MS` | Absolute deadline for one maintenance pass across all accounts.                                                                                                                                                                                                               |
| `account_maintenance_concurrency` | integer, `1`-`32`, default `4`                                      | `KIRO_PROVIDER_ACCOUNT_MAINTENANCE_CONCURRENCY` | Maximum concurrent proactive access-token refreshes.                                                                                                                                                                                                                          |
| `usage_refresh_interval_ms`  | integer, `1000`-`2147483647`, default `900000` (15 min)                    | `KIRO_PROVIDER_USAGE_REFRESH_INTERVAL_MS`  | Maximum age of a normal account usage snapshot before background maintenance calls Kiro `getUsageLimits`. Exhausted accounts continue to use the separate quota-recheck schedule.                                                                                                |
| `max_request_iterations`     | integer, `1`-`1000`, default `20`                                         | `KIRO_PROVIDER_MAX_REQUEST_ITERATIONS`     | Global cap on account-switching and retry-loop iterations for a single request. `0` is rejected because it would fail every request.                                                                                                                                                  |
| `request_timeout_ms`         | integer, `1`-`2147483647`, default `120000`                               | `KIRO_PROVIDER_REQUEST_TIMEOUT_MS`         | Absolute deadline for a request, in milliseconds. See [Timeout limits](#timeout-limits) for the accepted range and a known limitation.                                                                                                                                                |
| `stream_idle_timeout_ms`     | integer, `1`-`2147483647`, default `60000`                                | `KIRO_PROVIDER_STREAM_IDLE_TIMEOUT_MS`     | Maximum idle interval between upstream streaming events before the stream is aborted, in milliseconds. See [Timeout limits](#timeout-limits) for the accepted range.                                                                                                                  |
| `max_request_body_bytes`     | integer, `1`-`2147483647`, default `10485760` (10 MiB)                    | `KIRO_PROVIDER_MAX_REQUEST_BODY_BYTES`     | Maximum accepted request body size; larger requests get HTTP 413.                                                                                                                                                                                                                     |
| `token_expiry_buffer_ms`     | integer, `1`-`2147483647`, default `300000` (5 min)                       | `KIRO_PROVIDER_TOKEN_EXPIRY_BUFFER_MS`     | How long before actual access-token expiry the gateway proactively refreshes.                                                                                                                                                                                                         |
| `session_affinity_ttl_ms`    | integer, `1`-`2147483647`, default `86400000` (24 h)                       | `KIRO_PROVIDER_SESSION_AFFINITY_TTL_MS`    | Sliding lifetime of a persisted logical-session binding. A hit extends the expiry; an expired binding is recreated using the normal account strategy.                                                                                                                                 |
| `session_affinity_max_entries` | integer, `1`-`1000000`, default `10000`                                  | `KIRO_PROVIDER_SESSION_AFFINITY_MAX_ENTRIES` | Maximum persisted session bindings. When over the limit, least-recently-seen entries are removed.                                                                                                                                                                                     |
| `reasoning_replay_key_path`  | `string \| null`, default `null`                                          | `KIRO_PROVIDER_REASONING_REPLAY_KEY_PATH`  | Key-file override. `null` uses the platform config directory and atomically creates `reasoning-replay-keys.json` when no environment keyring is configured. POSIX mode is forced to `0600`.                                                                                           |
| `reasoning_replay_keys`      | `string[]`, default `[]`                                                   | `KIRO_PROVIDER_REASONING_REPLAY_KEYS`      | AES-256-GCM keyring. Environment entries are comma-separated `key-id:base64url-32-byte-key` values; the key ID may be omitted. The first key encrypts new records and later keys only decrypt old records.                                                                             |
| `reasoning_replay_ttl_ms`    | integer, `1`-`2147483647`, default `86400000` (24 h)                       | `KIRO_PROVIDER_REASONING_REPLAY_TTL_MS`    | Lifetime of an encrypted reasoning replay record. Expired records fail explicitly and are pruned transactionally.                                                                                                                                                                     |
| `reasoning_replay_max_entries` | integer, `1`-`1000000`, default `10000`                                  | `KIRO_PROVIDER_REASONING_REPLAY_MAX_ENTRIES` | Maximum encrypted replay records. Least-recently-used records are removed transactionally after expiry cleanup.                                                                                                                                                                      |
| `effort`                     | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| null`, default `null` | `KIRO_PROVIDER_EFFORT`                     | Optional global reasoning-effort override applied to every request. `null` leaves effort unset unless the request specifies it.                                                                                                                                                       |
| `auto_effort_mapping`        | `boolean`, default `true`                                                 | `KIRO_PROVIDER_AUTO_EFFORT_MAPPING`        | When enabled, the gateway automatically maps model-variant suffixes and request effort. Environment values accept `true`, `false`, `1`, `0`.                                                                                                                                          |
| `log_level`                  | `"debug" \| "info" \| "warn" \| "error"`, default `"info"`               | `KIRO_PROVIDER_LOG_LEVEL`                  | Minimum level of the structured audit log (one JSON object per line on stderr). Levels order `debug < info < warn < error`; events below the threshold are dropped. `warn` silences per-request `info` events such as `upstream_affinity_selected`. Applied by every command that loads configuration (`serve`, `login`, `accounts refresh|relogin`). |
| `test_upstream_endpoint`     | `string` (valid URL), optional, omitted by default                        | `KIRO_PROVIDER_TEST_UPSTREAM`              | **Test-only.** Overrides the AWS CodeWhisperer SDK endpoint used for upstream calls. Used by `scripts/security-check.sh` and isolated tests to point at a non-production endpoint. When set, `serve` prints a warning to stderr on startup. Do not set this in normal production use. |

## Authentication source

`auth_source: "local"` is the production default. It uses
`~/.config/kiro-provider/accounts.db` as the sole authentication authority.
Populate it either with direct device-code login or a one-time import:

```bash
kiro-provider login
# or, after authenticating with OpenCode plus opencode-kiro-auth:
kiro-provider accounts import
# optional non-default source:
kiro-provider accounts import --from /path/to/kiro.db
# overwrite local rows even when they are newer than the source:
kiro-provider accounts import --from /path/to/kiro.db --force
```

`login` completes the device-code flow and then calls Kiro's usage endpoint
once to learn the authenticated email before deriving the account ID. If that
lookup fails (for example, offline), the row is stored with the placeholder
email `builder-id@aws.amazon.com`, a warning is printed, and a later
`accounts refresh --all` or `accounts relogin` fills in the real identity.
When the identity is verified, logging in again as the same person (same
email, start URL, and profile) updates the existing row in place and removes
older duplicate rows instead of inserting a second account. Each SSO OIDC
request (client registration, device authorization, token poll) has a 30 s
deadline, and transient network failures during token polling are retried
until the device code expires.

Import copies active account credentials and usage into the provider database;
it does not retain a live link, shared lock, or runtime dependency on OpenCode.
A source row is skipped when the local copy already has a later access-token
expiry or usage sync (kiro-provider has refreshed it since the last import);
pass `--force` to overwrite anyway. `accounts import` does not read gateway
configuration and therefore has no `--config` option.
After import, kiro-provider independently:

- refreshes near-expiry access tokens and persists them before use;
- rebuilds the credential-bound SDK client when the access token changes while
  preserving the account transport;
- refreshes stale normal usage snapshots in the background;
- excludes exhausted accounts before token refresh or SDK construction;
- probes exhausted accounts only when their persisted recheck time is due and
  returns them to selection only after an authoritative non-exhausted snapshot;
- marks permanently invalid refresh credentials unhealthy instead of retrying
  them in model loops;
- deduplicates per-account probes and bounds maintenance concurrency.

The local account store can be operated without OpenCode:

```bash
kiro-provider accounts list
kiro-provider accounts list --details
kiro-provider accounts list --json
kiro-provider accounts refresh --all
kiro-provider accounts refresh <id|email> --json
kiro-provider accounts relogin <id|email>
kiro-provider accounts remove <id|email>
```

The default list is an aligned summary. `--details` and `--json` expose the
stable internal ID needed to disambiguate duplicate emails, but never include
access tokens, refresh tokens, or client secrets. Email identifiers are
case-insensitive and accepted only when exactly one row matches.

Manual refresh always calls Kiro's authoritative usage endpoint, including for
fresh or currently exhausted rows. It refreshes an access token only when it is
near expiry or after one invalid-bearer response. A partial failure produces a
non-zero exit code and a per-account result; `--json` is suitable for
monitoring. Background maintenance remains responsible for automatic
near-expiry token renewal, normal usage refresh, and periodic quota recovery.

`accounts relogin` resolves the target before opening device authorization,
then verifies the authenticated Kiro usage email before writing credentials.
It preserves the selected internal account ID so existing session affinity can
continue to reference the same account. `accounts remove` prompts by default;
`--yes` is required for non-interactive deletion, which also removes that
account's persisted affinity, output-lineage, and reasoning-replay rows.

Run only one authentication owner for an imported rotating refresh token.
Continuing to use the same imported account through an independently running
OpenCode plugin can race token rotation; re-import only as an intentional
operator action.

The former `auth_source: "opencode-shared"` mode, which read OpenCode's live
database and shared its refresh lock, was removed in 0.7.0. A configuration
that still selects it fails at startup with a migration message: run
`kiro-provider accounts import [--from <path>]` once, then set `auth_source`
to `"local"` or delete the key. `opencode_auth_db_path` is ignored and only
logs a deprecation warning until it is removed.

## Proxy

`proxy_url` is the single knob that redirects **every** kind of upstream traffic through one HTTP(S) proxy:

- Model requests (chat completions).
- Access-token refresh.
- Authoritative quota rechecks and periodic usage refreshes (`getUsageLimits`).
- Device-code login into the provider-owned local store (`login`).

A proxy may be required when a network reaches some model families directly but not others — for example, GPT requests succeed direct while Claude requests need an approved proxy egress and otherwise return HTTP 401/403.

Setting it, in order of precedence for `serve`:

1. `--proxy <url>` (CLI flag, `serve` only).
2. `KIRO_PROVIDER_PROXY_URL` (environment variable).
3. `proxy_url` in the config file.

`login` has no `--proxy` flag, so device-code login picks up the environment
variable or config-file value. One-time import is local SQLite work and does
not contact the network.

```bash
KIRO_PROVIDER_PROXY_URL=http://proxy.example.com:8080 \
  ./dist/kiro-provider serve

./dist/kiro-provider serve --proxy https://proxy.example.com:8443
```

Only `http://` and `https://` schemes are accepted; an invalid or non-HTTP(S) URL fails config validation at startup.

## Protocol exposure

- `POST /v1/responses` is always enabled for OpenAI Responses clients. A
  particular Codex version is supported only when its standard request stays
  within the documented verified subset.
- `POST /v1/messages` and `POST /v1/messages/count_tokens` are always enabled
  for Anthropic Messages clients. A particular Claude Code version is
  supported only when its standard request stays within that subset.
- `POST /v1/chat/completions` returns
  `legacy_chat_completions_disabled` unless
  `enable_legacy_chat_completions` is explicitly set to `true`.
- Authenticated `GET /ready` returns HTTP 200 only when the configured
  authentication source is readable, at least one active account exists, the
  provider database is writable, the reasoning keyring is available, and all
  key IDs used by unexpired replay rows are present. Its `model_catalog`
  object reports whether model metadata currently comes from live, stale,
  static-fallback, or disabled discovery.

`protocol_projection_mode: "safe"` is the production default. Live GPT and
Claude probes showed that Kiro accepts a valid required-label
`additionalContext` shape but does not preserve its instruction content or
instruction-over-user priority. Safe mode therefore returns
`unsupported_instruction_projection` for Responses `instructions`, OpenAI
`system`/`developer`, and Anthropic `system`. It never falls back to a user
prefix.

`legacy-user-prefix` joins only the original instruction text with exactly
`\n\n` and prefixes the first user turn. Startup emits a content-free
structured warning. It does not restore message merging, repeated-content
collapse, trailing-character deletion, synthetic tool prose, or any other
rewrite. This migration mode is available in v0.5.x and v0.6.x and is
scheduled for removal in v0.7.0.

The exact accepted/rejected API subset is documented in
[`PROTOCOL_COMPATIBILITY.md`](PROTOCOL_COMPATIBILITY.md).

The token-count endpoint uses the provider's fallback estimator because Kiro
does not expose a standalone tokenizer. Its successful response includes
`x-kiro-token-count-mode: estimate`.

## Kiro runtime and model catalog

Production requests default to `runtime_endpoint_mode: "kiro-runtime"`.
Live A/B capture showed that `runtime.<region>.kiro.dev` emits authoritative
completion witnesses required to distinguish a complete response from a clean
but truncated stream: token-usage metadata completes immediately, while valid
metering completes only when followed by clean EOF. The old SDK `q` endpoint
may provide neither witness, so `legacy-q` is an explicit
diagnostic/migration option rather than an automatic fallback.

With `dynamic_model_catalog: true`, the provider calls Kiro's management
`ListAvailableModels` operation using the selected account's current token and
the truthful `AI_EDITOR` origin. Responses are cached per account, concurrent
refreshes are deduplicated, and a last-known-good response may be used through
`model_catalog_stale_ttl_ms`. A requested model is sent only to an account
whose live/stale catalog contains its exact wire ID. If management is
temporarily unreachable and no cached response exists, the checked-in catalog
is used as a bounded fallback; unknown models are still rejected before SDK
generation.

## Session affinity and connection reuse

`session_affinity_mode: "explicit-only"` is the production default. It does
not hash input text, messages, tool arguments, or any other model-visible
content to guess whether two requests belong to one conversation. It accepts
these explicit sources:

- Responses, in priority order: standard
  `metadata.zuno_session_id`, standard
  `metadata.kiro_provider_session_id`, compatibility
  `client_metadata.thread_id|session_id|conversation_id`, then
  `prompt_cache_key`.
- Chat Completions: `prompt_cache_key` only.
- Anthropic Messages: no verified explicit field, so no affinity binding in
  this mode.

With an explicit key, the provider stores only its tenant-isolated hash, the
selected account ID, Kiro `conversationId`, and timestamps—not the original
session value or prompt. One logical session is serialized in-process.
Different accounts can execute concurrently, while requests sharing an
account use one account queue. Transport objects are cached per account, and
SDK clients are cached only while the account access token is unchanged. A
token refresh rebuilds the SDK client against the new immutable credential
while preserving the transport.

Accounts with `overage_count > 0`, or with a positive known limit where
`used_count >= limit_count`, are excluded before refresh and SDK construction.
An upstream HTTP 402 marks the account exhausted and excludes it from the
current request without retrying it. A 401 or invalid-bearer 403 gets at most
one forced refresh per account; if authentication still fails, that account is
excluded for the rest of the request and the final response preserves HTTP
401/403 instead of becoming `max_request_iterations` HTTP 500. A rate-limit,
quota, authentication, or unhealthy-account failover rebinds the session to
the replacement account and rotates the Kiro conversation ID.

Standard clients that cannot send a stable metadata key still get a safe
continuation path when they resend full history. After a completed assistant
or tool output, the provider stores only a tenant-isolated fingerprint of that
exact output lineage with its account and Kiro conversation. A later request
whose latest assistant output matches that lineage reuses both. The first
turn, a request without assistant history, or unmatched history starts a fresh
Kiro conversation. User text, tool arguments, and initial prompts are never
fingerprinted to guess identity.

Account selection and account-scoped SDK/transport object reuse still apply
when neither explicit nor history lineage is available. The Kiro SDK's
direct/proxy agents use fresh sockets by default; `sdk_http_keep_alive: true`
is an explicit opt-in for deployments that have validated pooled socket
behavior.

`legacy-initial-input` is migration-only. It restores the previous Responses
initial-input, Chat `user`/initial-turn, and Anthropic
`metadata.user_id`/initial-turn heuristics. Startup emits a structured
content-free warning. This mode changes only routing affinity; it does not
prepend, merge, delete, or otherwise modify model-visible request content.

This maximizes logical-session and SDK-object reuse without tying a session to
one physical TCP socket. Even when keep-alive is enabled, the Node/Smithy
agent, proxy, remote server, idle timeout, and network can open a new socket.
`enforce_single_instance: true` is therefore the production default: a second
provider using the same service lock fails before binding, so account/session
queues and socket pools cannot silently split across processes. If this guard
is disabled or different lock paths are used, queue serialization becomes
per-process; that is safe only with independent credentials/state or an
external cross-process serializer.

The gateway is stateless with respect to OpenAI response objects.
`previous_response_id` and `conversation` therefore return
`unsupported_stateful_responses` instead of being silently ignored. Resend
the complete Responses input.

## Encrypted reasoning replay

When Kiro emits a complete signed-text or redacted reasoning envelope, the
provider can return a random `kr1_...` value for Responses
`reasoning.encrypted_content`. Signature-only, unsigned-text, conflicting, or
mixed text/redacted event streams do not produce a replay token. The database
stores only token/fingerprint hashes plus AES-256-GCM ciphertext.

Authenticated additional data binds every ciphertext to the tenant, model,
account, Kiro conversation ID, output fingerprint, expiry, and key ID. Replay
must match all of those fields. Account failover is disabled during replay;
an unavailable bound account returns retryable
`reasoning_replay_account_unavailable`.

Key configuration precedence is:

1. Non-empty `KIRO_PROVIDER_REASONING_REPLAY_KEYS` / `reasoning_replay_keys`.
2. `reasoning_replay_key_path`.
3. The platform default config path.

Example environment keyring (generate keys with a cryptographically secure
random source; do not copy this placeholder):

```bash
export KIRO_PROVIDER_REASONING_REPLAY_KEYS='2026-08:<base64url-32-byte-key>,2026-07:<old-key>'
```

The first entry is active for encryption. Keep old keys until every record
encrypted by them has expired. If any unexpired database row references a key
that is no longer present, service construction fails instead of silently
breaking active sessions. Logs never contain key material, raw replay tokens,
signatures, reasoning text, redacted bytes, or request prompt content.

## File locations

All provider-owned files live under one per-user configuration root:

| Platform | Root | Files |
| --- | --- | --- |
| Linux / macOS | `$XDG_CONFIG_HOME` or `~/.config` | `kiro-provider/config.json`, `kiro-provider/accounts.db`, `kiro-provider/service.instance`, `kiro-provider/reasoning-replay-keys.json`; OpenCode import source `opencode/kiro.db` |
| Windows | `%APPDATA%` or `%USERPROFILE%\AppData\Roaming` | `kiro-provider\config.json`, `kiro-provider\accounts.db`, `kiro-provider\service.instance`, `kiro-provider\reasoning-replay-keys.json`; OpenCode import source `opencode\kiro.db` |

An empty `XDG_CONFIG_HOME` or `APPDATA` is treated as unset. Before v0.6 the
config file alone was always read from `~/.config/kiro-provider/config.json`,
even on Windows. On Windows, when `%APPDATA%\kiro-provider\config.json` does
not exist but the legacy `~/.config/kiro-provider/config.json` does, the legacy
file is still used; move it to `%APPDATA%` to complete the migration. Use
`--config <path>` to bypass the default lookup entirely.

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
  "protocol_projection_mode": "safe",
  "session_affinity_mode": "explicit-only",
  "auth_source": "local",
  "opencode_auth_db_path": null,
  "proxy_url": null,
  "default_region": "us-east-1",
  "enforce_single_instance": true,
  "instance_lock_path": null,
  "runtime_endpoint_mode": "kiro-runtime",
  "dynamic_model_catalog": true,
  "model_catalog_ttl_ms": 900000,
  "model_catalog_stale_ttl_ms": 86400000,
  "model_catalog_request_timeout_ms": 10000,
  "account_selection_strategy": "lowest-usage",
  "rate_limit_max_retries": 3,
  "sdk_http_keep_alive": false,
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

This mirrors `config.example.json` at the repo root. Replace `sk-REPLACE-ME` with a private, randomly generated key before deploying; an empty `api_keys` list is rejected at startup.
