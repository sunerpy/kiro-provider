# Troubleshooting

[简体中文](readme/TROUBLESHOOTING.zh.md) · English

A symptom-first runbook for operators. Every entry names the signal to look at
(an audit event, an `accounts list --details` availability value, or an HTTP
status and `error.code`), the cause, and the remedy. The field reference for
every knob mentioned here is [CONFIGURATION.md](CONFIGURATION.md); the
in-stream error codes are specified in
[STREAM_ERROR_CONTRACT.md](STREAM_ERROR_CONTRACT.md).

## Where the signals live

- **Audit log.** One JSON object per line on stderr. `log_level` (default
  `info`) is the minimum level emitted; `debug` enables the opt-in
  `request_shape` diagnostic. Fields hold counts, booleans, enumerated labels,
  and 16-hex-character `auditHash` values (`account_hash`, `conversation_hash`,
  `detail_hash`); the log never carries prompt text, tool arguments, tokens,
  or signatures.
- **`kiro-provider accounts list --details`** (or `--json`). The
  `AVAILABILITY` column is the selection view of each account:

  | Value | Meaning |
  | --- | --- |
  | `available` | Healthy, not rate-limited, quota not exhausted. |
  | `rate-limited` | A `429`/backoff window is active until `RECHECK_AT`. |
  | `quota-exhausted` | Kiro reported the quota as used up; a due probe re-admits it. |
  | `overage-blocked` | Healthy and within quota, but `stop_on_overage` excludes it because its paid overage count exceeds `overage_threshold`. |
  | `unhealthy` | Marked unhealthy for a transient reason (`HEALTH` is `unhealthy`). |
  | `needs-relogin` | The refresh token or OIDC client is permanently dead; only `accounts relogin` recovers it. |

- **HTTP status and `error.code`.** OpenAI-shaped routes return
  `{ "error": { "type", "code", "message" } }`; `/v1/messages` returns the
  Anthropic envelope, where quota `402` becomes `429 rate_limit_error` and the
  provider code is preserved in the message text.

### `journalctl` recipes for the systemd user service

The audit log is the service's stderr, so the journal is the log. `-o cat`
prints only the message, which keeps every line a parsable JSON object.

```bash
# Last 200 lines, human-readable
journalctl --user -u kiro-provider.service -n 200 --no-pager

# Warnings and errors in the last hour
journalctl --user -u kiro-provider.service --since -1h -o cat --no-pager \
  | grep -E '"level":"(warn|error)"'

# Follow one event type live
journalctl --user -u kiro-provider.service -f -o cat \
  | grep --line-buffered -F '"event":"sdk_stream_terminal"'

# Token-refresh failures per account hash (needs jq)
journalctl --user -u kiro-provider.service --since -1d -o cat --no-pager \
  | grep -F '"event":"account_token_refresh_failed"' \
  | jq -r '[.timestamp, .account_hash, .error_code, .refresh_token_dead] | @tsv'

# Count terminal provenance values for the day
journalctl --user -u kiro-provider.service --since today -o cat --no-pager \
  | grep -F '"event":"sdk_stream_terminal"' \
  | jq -r '.terminal_provenance' | sort | uniq -c

# Everything about one account (hash from `accounts list --json` is not the
# audit hash; copy `account_hash` from any event that names the account)
journalctl --user -u kiro-provider.service --since -1d -o cat --no-pager \
  | grep -F '"account_hash":"0123456789abcdef"'
```

Without systemd, redirect stderr to a file when starting `kiro-provider serve`
and apply the same `grep`/`jq` filters to it.

## Accounts and quota

### An account shows `needs-relogin`; the log has `account_token_refresh_failed`

- **Look at:** `accounts list --details` → `AVAILABILITY` `needs-relogin`;
  audit `account_token_refresh_failed` (`warn`) with `refresh_token_dead:
  true` and an `error_code` such as `invalid_grant`, `InvalidGrantException`,
  `ExpiredTokenException`, or `InvalidTokenException`; the background
  maintenance pass logs the same condition as
  `account_maintenance_token_refresh_failed`.
- **Cause:** Kiro's token service rejected the refresh token or the OIDC client
  registration itself. Access-token errors (`bearer token ... is invalid`) are
  *not* permanent and are handled by a forced refresh; only the refresh-dead
  markers park the account.
- **Remedy:** `kiro-provider accounts relogin <id|email>`. The account keeps
  its internal ID and session-affinity rows. A transient `error_code` such as
  `NETWORK_ERROR` or a bare `HTTP_<status>` (proxy or WAF HTML, empty body)
  never marks the account dead; it produces `account_token_refresh_retry`
  once, then the pipeline switches account and the maintenance loop retries
  later. `refresh_token_dead: false` therefore means "look at the network or
  proxy", not "re-login".

### A row shows the placeholder email `builder-id@aws.amazon.com`

- **Look at:** `accounts list` → `EMAIL` column; the `login` command printed
  `Warning: Kiro usage did not include an account email; storing the
  placeholder ...`.
- **Cause:** The IAM Identity Center / Builder ID device-code flow does not
  return an email; the provider fills it from Kiro's `getUsageLimits`
  response. If that lookup failed or the response carried no `email`, the
  placeholder is stored.
- **Remedy:** `kiro-provider accounts refresh <id>` once the usage endpoint is
  reachable; the email is updated on the next successful usage sync. The
  placeholder is functional (selection uses the account ID), but
  `accounts relogin` against a placeholder row accepts any Kiro identity, so
  verify the row is the account you meant before re-authenticating. Two
  placeholder rows cannot be told apart by email; use the `ID` column.

### `quota-exhausted` vs `overage-blocked`, and `402 quota_exhausted` vs `402 paid_overage_blocked`

- **Look at:** `accounts list --details` → `AVAILABILITY`, `USAGE`, and
  `OVERAGE` columns; audit `quota_exhausted_account_persisted` (`warn`,
  `account_hash`, `recheck_after`), `quota_exhausted_accounts_excluded`
  (`info`, `account_count`), and `quota_exhausted_account_recovered`
  (`info`); HTTP `402` with `error.code` `quota_exhausted` or
  `paid_overage_blocked` (on `/v1/messages`: `429 rate_limit_error` with the
  code in the message).
- **Cause:**
  - `quota-exhausted`: Kiro reported the account's quota as used up (an
    upstream `402`, or a usage snapshot at the limit). The account stays
    healthy and is re-admitted only after a due authoritative usage probe
    confirms a new quota window (`quota_recheck_interval_ms`, or the reset
    time Kiro reports).
  - `overage-blocked`: the account still has quota or is in paid overage, but
    `stop_on_overage` (default `true`) excludes any account whose overage
    count exceeds `overage_threshold` (default `0`). This is a selection gate,
    not a health signal; the next usage sync re-evaluates it.
  - `402 quota_exhausted`: every otherwise eligible account is exhausted.
  - `402 paid_overage_blocked`: every otherwise eligible account is blocked
    only by the overage gate.
- **Remedy:** For quota exhaustion, wait for the reset (the `Retry-After`
  header and `rate_limit_wait_for_reset` show the wait) or add accounts. For
  overage blocking, decide explicitly: set `stop_on_overage: false` to
  knowingly spend paid overage, or raise `overage_threshold`. Do not mark the
  account unhealthy; it is not.

### `503 no_healthy_accounts` or `503 upstream_token_refresh_failed`

- **Look at:** HTTP `503` with `error.code` `no_healthy_accounts` ("All
  accounts are unhealthy or rate-limited") or `upstream_token_refresh_failed`
  ("Token refresh failed for every usable Kiro account"); audit
  `account_token_refresh_failed` / `account_token_refresh_retry`,
  `rate_limit_wait_for_reset` (`wait_ms`, `remaining_ms`), and
  `accounts list --details` for the per-account reason.
- **Cause:** `no_healthy_accounts` means no account passed selection within
  `request_timeout_ms`: all are `rate-limited`, `unhealthy`, `needs-relogin`,
  `quota-exhausted`, or `overage-blocked`, or the model is unavailable to the
  remaining ones (`account_model_unavailable`). When the earliest
  rate-limit reset fits inside the request deadline the pipeline waits for it
  instead of failing. `upstream_token_refresh_failed` means every candidate
  failed its access-token refresh during this request; a network or proxy
  outage that affects all accounts at once produces exactly this.
- **Remedy:** Read the availability column first. `needs-relogin` →
  `accounts relogin`; `rate-limited` → wait for `RECHECK_AT`;
  `overage-blocked` → see the previous entry. For
  `upstream_token_refresh_failed`, check `proxy_url` and outbound
  connectivity, then `kiro-provider accounts refresh --all` to confirm the
  token endpoint is reachable again. `GET /ready` returning
  `no_active_accounts` is the same condition seen from the readiness probe.

## Streams

### `502 upstream_stream_incomplete` / `upstream_stream_error`, and the pre-publication retry events

- **Look at:** Non-stream requests return HTTP `502` with `error.type`
  `upstream_error` and the code; streams end with the same code in the
  terminal frame (`response.failed` for Responses, an `error` frame for Chat,
  `overloaded_error` for Anthropic). In the audit log the incident itself is
  `sdk_stream_upstream_error` (`warn`, with `error_code`,
  `error_disposition`, `error_type`, hashed messages, `raw_event_count`,
  `last_event_type`, `event_type_counts`) or `sdk_stream_idle_timeout`
  (`warn`, `idle_timeout_ms`). Around it, the stream-resilience layer emits:

  | Event | Level | Fields | Meaning |
  | --- | --- | --- | --- |
  | `sdk_stream_attempt_retry` | `warn` | `attempt`, `max_attempts`, `error_code`, `same_account`, `account_hash` | An attempt failed before the first semantic event reached the client; the pipeline is retrying (same account first, then another). Nothing was published, so the client sees no error. |
  | `sdk_stream_attempts_exhausted` | `warn` | `attempt`, `max_attempts`, `error_code`, `account_hash` | `stream_max_attempts` was spent; the last failure becomes the client-visible `502` or in-stream error. |
  | `sdk_stream_empty_completion_retry` | `warn` | `attempt`, `max_attempts`, `account_hash` | Kiro completed with no reasoning, text, or tool output; `retry_empty_completion` spends one more attempt on the same account. |
  | `sdk_stream_transport_error_after_completion` | `warn` | `error_code`, `account_hash`, `completion_witnessed` | The transport failed *after* an authoritative completion witness (token usage or a valid metering event). The completed turn is delivered; the error is recorded, not surfaced. |

- **Cause:** `upstream_stream_error` is a reader, decoder, transport, or
  embedded upstream failure; `upstream_stream_incomplete` is a clean EOF
  without a completion witness. Both are transient by contract. If you see
  the `502` and no `sdk_stream_attempt_retry` before it, the failure happened
  after the first semantic event was already published, where the provider
  never retries (it could duplicate text or repeat a tool side effect).
- **Remedy:** Downstream retries as a replacement attempt with the same
  session key (see the contract). Operator-side, a burst of
  `sdk_stream_attempts_exhausted` on one `account_hash` points at that
  account or region; across all accounts it points at the network or proxy.
  Raising `stream_max_attempts` (max `10`) buys more pre-publication retries
  at the cost of latency; `stream_idle_timeout_ms` controls when a silent
  stream is declared idle.

### Reading `sdk_stream_terminal`: "the assistant announced a next step and stopped"

Every stream ends with exactly one `sdk_stream_terminal` event (`info`).
Fields: `terminal_provenance`, `completion_witnessed`, `witness_kind`,
`reasoning_chars`, `visible_chars`, `tool_count`, `tool_intent_open`,
`finish_reason_synthesized`, plus `account_hash` and `conversation_hash`.

| `terminal_provenance` | What happened | Who to blame |
| --- | --- | --- |
| `normal_complete` | Kiro sent a completion witness and the stream closed cleanly. | Nobody: this is Kiro ending the turn. |
| `idle_timeout` | No upstream event for `stream_idle_timeout_ms`. | Transport / upstream stall. |
| `upstream_error` | The SDK reader or Kiro reported an error mid-stream. | Transport / upstream. |
| `consumer_cancel` | The client closed the response before the stream ended. | The client (its own timeout or user cancel). |
| `external_abort` | The provider aborted the upstream: `request_timeout_ms` deadline, shutdown, or lock compromise. | Provider configuration or lifecycle. |

When a user reports "the model said *Next, I'll run the tests* and then
stopped":

1. Find the turn's `sdk_stream_terminal`.
2. `terminal_provenance: normal_complete`, `completion_witnessed: true`, and
   `tool_count: 0` means Kiro ended the turn without emitting a tool call.
   The provider delivered everything it received; the "stop" is model
   behaviour, not a truncated stream. `tool_intent_open: true` records that
   the visible text ended on an announced action with no tool call behind
   it, which is the pattern to count when comparing prompts or projection
   modes. `finish_reason_synthesized: true` is normal here: Kiro exposes no
   stop reason, so the provider derives `end_turn` / `tool_use` from
   `tool_count`.
3. `upstream_error` or `idle_timeout` is a transport incident: the client
   received the typed in-stream error and should retry per the contract; look
   for the matching `sdk_stream_upstream_error` / `sdk_stream_idle_timeout`
   and any retry events.
4. `consumer_cancel` means the client left first. Check the client's
   read/idle timeout before suspecting the gateway; the provider then aborted
   the upstream request so the account lease was released.
5. Compare `visible_chars` and `reasoning_chars` with what the client shows.
   A large `reasoning_chars` with small `visible_chars` on a `normal_complete`
   is a model that thought and answered briefly, not a lost stream.

## Reasoning replay

### `400 invalid_reasoning_signature`

- **Look at:** HTTP `400`, `error.code` `invalid_reasoning_signature`
  (Anthropic envelope: `invalid_request_error` with the same message). The
  upstream message names the offending block, e.g. `messages.1.content.0:
  Invalid signature in thinking block`.
- **Cause:** Kiro validates replayed `thinking` signatures server-side. The
  client echoed a `thinking` block whose `signature` was altered, truncated,
  re-encoded, or produced by a different model/provider. Signatures are not
  bound to the conversation or account, so this is never an affinity
  problem.
- **Remedy:** Replay the `thinking` block exactly as returned (text and
  signature unchanged), or drop the `thinking` blocks from history; Kiro
  accepts a history without them. The provider does not retry, switch
  accounts, or degrade silently on this error, and does not mark the account
  unhealthy.

### `400 unsupported_reasoning_plaintext_replay` (Responses)

- **Look at:** HTTP `400`, `error.code`
  `unsupported_reasoning_plaintext_replay`, `param` pointing at the
  `input[i]` reasoning item; `invalid_reasoning_replay` is the sibling code
  for a malformed or non-`kr1_` `encrypted_content`.
- **Cause:** The client replayed a `reasoning` item that carries only
  plaintext `summary`/`content` and no `encrypted_content` anywhere in that
  turn. The provider never converts plaintext reasoning into a prompt, so it
  cannot be projected.
- **Remedy:** Request `include: ["reasoning.encrypted_content"]` and echo the
  returned `encrypted_content` (`kr1_...`) on the reasoning item when
  replaying the turn. Exactly one reasoning item per turn carries the token;
  other reasoning items in the same turn may keep plaintext summaries. A
  client that cannot store the token should omit reasoning items from
  history instead of sending summaries alone.

### `reasoning_replay_locked: false` in `upstream_affinity_selected`

- **Look at:** The `info` event `upstream_affinity_selected` (per attempt)
  with `affinity_kind`, `affinity_bound`, `account_hash`,
  `conversation_hash`, and `reasoning_replay_locked`.
- **Meaning:** `reasoning_replay_locked: true` means the request replays
  encrypted reasoning that is bound to the account that minted it, so
  account failover is disabled for this request (a failure returns
  `reasoning_replay_*` rather than switching). `false` means the client is
  not replaying account-bound reasoning: either no reasoning item is in the
  history, or the replay kind carries no binding (Anthropic `thinking`
  signatures are validated by Kiro, not bound locally). `false` is the
  normal value for most traffic and is not an error.

## Process and configuration

### Startup fails with `service_instance_already_running`; `single_instance_lock_busy` or `single_instance_lock_compromised` in the log

- **Look at:** Startup error `Another kiro-provider instance already holds
  the service lock at <path> (gave up after N attempt(s) ...; a lock left
  behind by a dead process becomes stale after 15000 ms)` with code
  `service_instance_already_running`; audit `single_instance_lock_busy`
  (`warn`, first retry: `retry_attempts`, `retry_delay_ms`, `stale_ms`),
  `single_instance_lock_acquired` (`info`, `attempts`), and
  `single_instance_lock_compromised` (`error`, `error_code`, `stale_ms`,
  `update_ms`, `handler_count`).
- **Cause:** `enforce_single_instance: true` (default) takes a lock file
  under the platform config root (`instance_lock_path` overrides). The lock
  is refreshed every 5 s and becomes stale 15 s after the owner stops
  refreshing it; acquisition retries 20 × 1 s so a restart after `SIGKILL`
  succeeds once the stale window passes. `single_instance_lock_compromised`
  means the lock was lost while running (lock directory deleted, or the
  mtime refresh missed the stale window because the process was frozen). The
  provider fails closed: it stops accepting requests, drains for up to 10 s,
  and exits `1` so the service manager restarts it.
- **Remedy:** For `already_running`, confirm with `systemctl --user
  is-active kiro-provider.service` that only one service is defined and no
  foreground `serve` is running as the same user; a second copy for another
  OS user selects a different config root and lock. For a lock compromise,
  keep the config directory intact and investigate host suspend/resume or
  I/O stalls longer than 15 s. Disabling the lock
  (`enforce_single_instance: false`, logged as
  `single_instance_protection_disabled`) is not a fix: two processes rotating
  the same refresh tokens invalidate each other.

### `config_file_permissions_loose`

- **Look at:** Audit `config_file_permissions_loose` (`warn`) with `path`,
  `mode` (e.g. `0644`), `recommended_mode: "0600"`, and a `hint`.
- **Cause:** On POSIX the config file is group- or world-readable and it
  contains `api_keys`.
- **Remedy:** `chmod 600 <path>`. The systemd unit in the README sets
  `UMask=0077` so files the service creates are private; the config file
  itself is created by you.

### Startup fails with `unknown key "..." (did you mean "...")`

- **Look at:** The `ConfigLoadError` printed before the port is bound; no
  audit event because the process never reaches `serve`.
- **Cause:** The config file is validated strictly. Typos and keys from other
  versions are rejected with a nearest-match suggestion; environment
  variables use the `KIRO_PROVIDER_*` names listed in CONFIGURATION.md and
  are reported as `(from KIRO_PROVIDER_...)`.
- **Remedy:** Rename or delete the key. Legacy `opencode_auth_db_path` is
  still accepted but ignored and logs `config_opencode_auth_db_path_deprecated`.

### Startup fails with `auth_source "opencode-shared" was removed in kiro-provider 0.7.0`

- **Look at:** The startup message itself: `Copy the OpenCode accounts once
  with "kiro-provider accounts import [--from <path>]", then set auth_source
  to "local" or delete the key`.
- **Cause:** The live-reader compatibility mode was removed in 0.7.0 because
  it reintroduced cross-process credential ownership and could block the
  event loop on the shared SQLite lock.
- **Remedy:** Run the one-time import as the same OS user that runs the
  service, then set `auth_source` to `"local"` (or remove it; `local` is the
  default). The OpenCode database is not read afterwards.

### `413`: request too large vs context length exceeded

- **Look at:** HTTP `413`. `error.code` `request_too_large` (message
  `Request body exceeds the N byte limit`) is the ingress body limit. A `413`
  with `error.type` `upstream_error` and `error.code` `context_length_exceeded`
  is Kiro rejecting the prompt as exceeding the model context (structured
  reasons `CONTENT_LENGTH_EXCEEDS_THRESHOLD` / `PROMPT_TOO_LONG`, or the
  `input is too long` message on older responses); the provider remaps that
  upstream `400` to `413` so clients can tell it from a malformed request.
- **Cause:** The first is a body larger than `max_request_body_bytes`
  (default 10 MiB; Bun answers even larger bodies with a plain `413` before
  the JSON envelope). The second is conversation history, tool results, or
  attached documents exceeding the model's context window.
- **Remedy:** For the body limit, raise `max_request_body_bytes` only if the
  payload is legitimate (large inline documents). For context overflow, the
  client must compact history; the provider does not truncate, summarize, or
  drop messages on the model's behalf. The `request_shape` diagnostic
  (`input_text_chars`, `document_count`, `tool_result_count`) shows which
  part of the request grew.

### Proxy problems (`proxy_url`)

- **Look at:** Startup `ConfigLoadError` `proxy_url must be a valid URL` /
  `proxy_url must be http(s)`; at runtime `account_token_refresh_retry` then
  `account_token_refresh_failed` with `error_code: NETWORK_ERROR` or a bare
  `HTTP_<status>`, `sdk_stream_upstream_error` with transport codes
  (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`),
  `model_catalog_refresh_failed`, and finally `503
  upstream_token_refresh_failed` or `503 no_healthy_accounts`.
  `sdk_connection_pool_selected` (`info`) shows `http_keep_alive` and pool
  hits per account but does not include the proxy address.
- **Cause:** `proxy_url` routes *all* egress (model calls, token refresh,
  usage probes, device-code login) through one HTTP(S) proxy. SOCKS is not
  supported. A proxy that returns an HTML block page yields `HTTP_<status>`
  refresh errors that are deliberately treated as transient, so accounts stay
  `rate-limited` rather than `needs-relogin`.
- **Remedy:** Verify the proxy from the service user's shell (`curl -x
  "$PROXY" https://oidc.us-east-1.amazonaws.com/`); set `proxy_url` in the
  config file or `KIRO_PROVIDER_PROXY_URL` (the `serve --proxy` flag wins over
  both); restart the service. `kiro-provider accounts refresh --all` is the
  quickest end-to-end check because it exercises the token endpoint and the
  usage endpoint through the same proxy resolution.

## Request-shape diagnostics (`request_shape`, `debug`)

Set `log_level: "debug"` (or `KIRO_PROVIDER_LOG_LEVEL=debug`) and every
Responses, Messages, and Chat request emits one `request_shape` event after
its canonical request is built and before account selection. It contains only
counts, booleans, one hash, and two labels:

| Field | Meaning |
| --- | --- |
| `protocol` | `responses`, `anthropic-messages`, or `chat-completions`. |
| `model` | The requested public model name. |
| `message_count` | Canonical messages after adaptation. |
| `user_message_count`, `assistant_message_count`, `tool_message_count`, `instruction_message_count` | Role counts (`instruction_message_count` is `system` plus `developer`). |
| `tool_declaration_count` | Declared tools. |
| `tool_call_count` | Tool calls in history (assistant `toolCalls` plus `tool_use` parts, unique by id per message). |
| `tool_result_count` | Tool results in history. |
| `orphan_tool_result_count` | Results whose call id matches no call in an earlier message. |
| `image_count`, `document_count` | Inline attachments. |
| `has_reasoning_replay`, `reasoning_replay_count` | Whether and how many encrypted reasoning replays the request carries. |
| `system_instruction_present` | Top-level `instructions`/`system` or a system/developer message exists. |
| `input_text_chars` | Sum of text lengths over messages, tool-result text, and instructions. A size, never the content. |
| `tool_set_hash` | `auditHash` of the sorted tool names, so identical tool sets correlate across requests without logging the names. |

Use it to answer "did the client send the whole history?", "is a tool result
arriving without its call?", or "how big is this conversation?" without ever
enabling request-body logging, which the provider does not offer.
