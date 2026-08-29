# Protocol compatibility and migration

[简体中文](readme/PROTOCOL_COMPATIBILITY.zh.md) · English

kiro-provider v0.5 is a **verified OpenAI/Anthropic compatibility subset**, not
an implementation of every field accepted by the upstream APIs. The default
`safe` projection mode preserves client text, roles, content-block boundaries,
tool identity, ordering, and source paths. If Kiro cannot express a requested
guarantee, the provider returns HTTP 400 before starting an upstream request.

The provider never adds hidden prompts, rewrites client instructions, merges
adjacent messages, clears repeated assistant content, removes a trailing `{`,
or invents prose for orphan tools, omitted images, thinking, or Web Search.

## Compatibility matrix

| Capability | v0.5 behavior |
| --- | --- |
| Plain text and consecutive same-role turns | Preserved in original order and sent without merge or separator text. |
| Multiple top-level text blocks in one message | Plain-text-only blocks remain separate in the canonical request and are concatenated exactly, with no inserted separator, only at Kiro's scalar text boundary. Multiple text blocks interleaved with non-text content are rejected with `unsupported_content_block_projection`; tool-result text arrays remain structured. |
| Responses `instructions`; Chat/Responses `system` and `developer`; Anthropic `system` | `safe`: `unsupported_instruction_projection`. Valid `additionalContext` is structurally accepted by Kiro but did not preserve instruction content or priority in live GPT and Claude probes. `legacy-user-prefix`: exact text is joined with `\n\n` and prepended to the first user turn; no other legacy rewrites return. |
| Function tools and Responses custom tools | Exact declaration, public name, schema, call ID, arguments, result, order, and source path are retained. History without the exact declaration returns `missing_tool_declaration`. |
| `tool_choice: auto` | Supported. |
| `tool_choice: none` | Supported only when no unfinished tool state requires a declaration. Otherwise rejected. |
| Required/specific tool choice | Rejected with `unsupported_tool_choice`; Kiro cannot guarantee it. |
| `parallel_tool_calls: false` | Accepted as a no-op only when no callable tools can run, including `tool_choice: none`; otherwise rejected with `unsupported_parallel_tool_calls`. |
| Strict schemas, custom grammar, namespace tools | `strict: true`, custom `format`, and namespace identity are rejected rather than weakened or renamed. |
| Reasoning effort | Explicit effort mapping is retained. Opus 5 `low/medium/high/xhigh/max` is live-probe confirmed through native `output_config.effort`; unsupported controls are rejected field-by-field. |
| Responses reasoning summary | The exact `...` or `…` placeholder from GPT 5.6 Sol is omitted. Opus reasoning and any non-placeholder Sol reasoning are preserved. If encrypted replay was requested, the opaque replay item remains with an empty visible summary. |
| Responses `reasoning.encrypted_content` | When Kiro emits a complete signed-text or redacted envelope, the response contains a random `kr1_...` token backed by encrypted local storage. Incomplete/signature-only upstream events produce no token. |
| Images | Base64 Anthropic images and OpenAI data URLs are mapped to Kiro. Remote URLs, image-detail controls, invalid media, more than four images, or more than 3.75 MiB of base64 data are rejected. |
| Responses inline files | `input_file` with inline `file_data` plus `filename` maps to Kiro's native document structure without inserting filename/content prose. The canonical request retains the original filename; lowering moves a recognized final extension to the separate `format` field. The remaining name must be 1–200 ASCII alphanumeric/space/`-`/`_`/parenthesis/bracket characters, without leading, trailing, or consecutive spaces. A name requiring any other rewrite is rejected with `invalid_file_name`. Raw base64 and base64 data URLs are supported for `csv`, `doc`, `docx`, `html`, `md`, `pdf`, `txt`, `xls`, and `xlsx`. `file_id` is rejected because this stateless provider cannot resolve OpenAI file storage. |
| Output token limit | Probe-confirmed for `claude-sonnet-5` and `claude-opus-5` variants, from 1,024 through 128,000. Other models return `unsupported_output_token_limit`. |
| Structured output and sampling/logprob controls | Rejected until an equivalent native Kiro capability is proven. Default text format is accepted. |
| `previous_response_id`, Responses `conversation`, `store: true` | Rejected; this version does not provide a server-side OpenAI response store. |
| Kiro-managed Web Search | Rejected with `unsupported_web_search`. The provider does not fabricate `web_search_call` or citation events. |
| Chat `stream_options.include_usage` | Supported only for streaming Chat. Exactly one separate, choices-empty usage chunk is emitted when requested. Other `stream_options` fields are rejected. |
| Stream completion semantics | Token-usage metadata is an immediate authoritative completion witness. The current Kiro runtime also ends successful streams with a valid metering event; that witness is accepted only when followed by clean EOF. Plain EOF, context-only streams, empty/malformed metering, embedded upstream errors, unknown event types, missing tool identity, or malformed/incomplete tool arguments fail explicitly; tool events must also be structurally complete. Non-streaming requests retry within the configured bound. |

Unknown nested fields in supported objects are rejected with a field path.
This is intentional: accepting and discarding them would falsely claim protocol
compatibility.

Streaming failures preserve a structured error code instead of collapsing to
generic `upstream_error`. Retryable transport/truncation/timeout codes and fatal
protocol codes, including the required downstream attempt semantics, are
defined in [STREAM_ERROR_CONTRACT.md](STREAM_ERROR_CONTRACT.md).

## Projection modes

`protocol_projection_mode` defaults to `safe` and can also be set through
`KIRO_PROVIDER_PROTOCOL_PROJECTION_MODE`.

- `safe`: no model-visible compatibility text. Unsupported instruction roles
  return `unsupported_instruction_projection`.
- `legacy-user-prefix`: migration-only behavior for instruction text. The
  provider joins the original instruction blocks with exactly `\n\n` and
  prefixes the first user text. Startup emits a structured warning containing
  no request content. This mode does not restore message merging, content
  deletion, synthetic tool prose, or any other old rewrite.

The migration mode remains available in v0.5.x and v0.6.x and is scheduled for
removal in v0.7.0. The legacy Chat endpoint is controlled separately by
`enable_legacy_chat_completions` and remains disabled by default.

## Session affinity modes

`session_affinity_mode` defaults to `explicit-only` and can also be set
through `KIRO_PROVIDER_SESSION_AFFINITY_MODE`. Affinity metadata is transport
routing state; it is never inserted into model-visible input.

- Responses, in order: `metadata.zuno_session_id`,
  `metadata.kiro_provider_session_id`, compatibility
  `client_metadata.thread_id|session_id|conversation_id`, then
  `prompt_cache_key`.
- Chat Completions: `prompt_cache_key` only.
- Anthropic Messages: no verified explicit affinity field.

An explicit key serializes overlapping turns and persists the chosen account
plus Kiro conversation ID. Standard clients without such a key can still
continue safely when they resend full history: after a complete assistant/tool
output, the provider persists only a tenant-isolated fingerprint of that exact
output lineage and reuses its account/conversation when the next request's
latest assistant output matches. First turns and unmatched histories get a
fresh Kiro conversation. User prompts and tool arguments are never hashed to
guess identity. Kiro model-call sockets are fresh by default; keep-alive is an
explicit opt-in. Identical prompts in independent sessions therefore do not
collide.

Known quota-exhausted accounts are removed before token refresh or SDK
construction. An upstream HTTP 402 excludes and persists the account
immediately, without retrying it in the same request. Once its persisted
recheck time arrives, the provider performs a bounded, per-account-deduplicated
Kiro `getUsageLimits` probe outside the model retry loop. Only a newer exact
snapshot below the quota clears exclusion; failed or still-exhausted probes
advance the next check. `last_sync` ordering prevents an older provider probe
from overwriting newer OpenCode usage. A 401 or invalid-bearer 403 gets one
forced refresh per account; continued failure excludes that account for the
remainder of the request. SDK clients are rebuilt when their access token
changes while the account-scoped transport remains reusable.

The compiled service defaults to a single process lock because account and
session queues, SDK clients, and socket pools are process-local. Disabling
`enforce_single_instance` or choosing different lock paths requires independent
credentials/state or an external cross-process serializer.

`legacy-initial-input` temporarily restores the v0.4 prompt-fingerprint
heuristics. It emits a content-free startup warning and affects routing only;
it does not enable prompt injection, message merging, or any other protocol
rewrite.

## Current compiled-client acceptance status

RC.4 adds an independent provider-owned authentication lifecycle. A compiled
binary imported one real OpenCode account once, then refreshed a deliberately
expired access token and stale usage while its configured OpenCode database
path did not exist. Official OpenAI SDK Responses and a real OpenCode tool
loop both succeeded afterward. This validates authentication independence; it
does not change the RC.3 protocol/client compatibility findings below.

The 2026-08-27 RC.3 gate used the compiled binary without private headers,
request patches, or client-side prompt compensation. Any required documented
client option is stated in its row:

| Client | v0.5.0-rc.3 result |
| --- | --- |
| OpenAI JavaScript SDK 7.5.0 | Pass with Opus 5: Responses streaming/non-streaming, explicitly enabled Chat, function-tool continuation, direct Messages JSON/SSE, and exact 128,001 boundary rejection. |
| OpenCode 1.18.18 Responses | Pass with `claude-opus-5-max` in explicit `legacy-user-prefix` mode: real bash then read tool loop, one account, one Kiro conversation, and `effort=max`. An auxiliary unsupported reasoning-summary request was rejected without breaking the main command. |
| OpenCode 1.18.18 Chat | Not rerun in RC.3; RC.2 remains blocked because the client adds nonstandard `messages.0.cache_control`. |
| Codex CLI 0.150.0-alpha.9 | Opus 5 model validation passes; blocked before Kiro on `reasoning.summary`, which has no proven native equivalent. |
| Claude Code 2.1.209 | Opus 5 model validation passes; blocked before Kiro on unsupported `context_management`. |
| Zuno native OpenAI Responses | Not changed or rerun by explicit scope. RC.1 remains historical integration guidance, not a fresh RC.3 pass. |

These are RC compatibility findings, not fields the provider should ignore.
The stable v0.5.0 gate remains closed until all required real clients pass
without private headers, request patches, or prompt compensation.

## Encrypted reasoning replay

The response token is random and opaque; the SQLite database stores only its
SHA-256-derived lookup hash. Complete Kiro reasoning envelopes are encrypted
with AES-256-GCM. Authenticated additional data binds tenant, model, account,
Kiro conversation, output fingerprint, expiry, and key ID.

For standard manual Responses continuation, a client may resubmit the returned
reasoning item, including its `summary` and `content`, unchanged. A valid
`encrypted_content: "kr1_..."` token remains authoritative; visible metadata
is never projected to Kiro and is never used as a plaintext fallback.

Replay must resolve to the same tenant, model, account, Kiro conversation, and
assistant/tool output fingerprint. A missing, expired, ambiguous, cross-account,
cross-conversation, tampered, or undecryptable record fails explicitly. The
pipeline cannot switch accounts while replaying signed reasoning; temporary
account loss returns retryable `reasoning_replay_account_unavailable`.

Keys can be supplied with `KIRO_PROVIDER_REASONING_REPLAY_KEYS` as a
comma-separated keyring. Each entry is `key-id:base64url-32-byte-key` (the ID
may be omitted). The first key encrypts new records and later keys decrypt old
records. If no environment keyring is configured, the provider atomically
creates `reasoning-replay-keys.json` in its config directory and restricts it
to mode `0600` on POSIX. Startup fails if an unexpired database record refers
to a missing key.

Defaults are a 24-hour TTL and 10,000 records. Cleanup of expired and
least-recently-used records happens transactionally.

## Common field-level errors

| Code | Meaning |
| --- | --- |
| `unsupported_instruction_projection` | Kiro accepts the tested structured field but does not expose its instruction content or priority to the model; safe mode cannot represent instruction roles without modifying user text. |
| `unsupported_content_block_projection` | Kiro cannot preserve the ordering of multiple text blocks interleaved with non-text content. `param` identifies the first unprojectable text block. |
| `unsupported_file_reference` | A Responses `file_id` cannot be resolved by this stateless provider; send inline `file_data` and `filename`. |
| `invalid_file_name` | The filename cannot be represented by Kiro's native `name` plus `format` fields without a lossy rewrite. `param` points to `filename`. |
| `unsupported_file_format` / `invalid_file_data` | The inline file format or base64 payload cannot be projected to a Kiro native document. |
| `unsupported_parameter` | The named field has no proven equivalent; `param` identifies it. |
| `unsupported_tool_choice` | Required or named tool selection cannot be guaranteed. |
| `unsupported_parallel_tool_calls` | Serial-only execution cannot be guaranteed. |
| `unsupported_strict_tools` | Kiro cannot guarantee strict schema enforcement. |
| `unsupported_custom_tool_format` | A custom grammar/format cannot be preserved. |
| `missing_tool_declaration` | Tool history lacks the exact original declaration. |
| `unsupported_output_token_limit` | The model/range has no probe-confirmed native mapping. |
| `unsupported_stateful_responses` | Server-side Responses state is unavailable. |
| `unsupported_web_search` | Native Kiro search/citation events are not supported. |
| `reasoning_replay_*` | Encrypted replay lookup, context, key, expiry, integrity, or account binding failed. |
| `quota_exhausted` (HTTP 402) | Every otherwise eligible account has reached its known quota. Exhausted accounts are rejected before refresh/SDK construction; an upstream 402 also persists and excludes that account immediately. |
| upstream authentication error (HTTP 401/403) | One forced refresh was insufficient for every eligible account. The original authentication status is preserved instead of returning `max_request_iterations` HTTP 500. |

## Migration from v0.4

1. Keep `protocol_projection_mode: "safe"` and run representative requests.
2. Remove unsupported fields instead of expecting the provider to ignore them.
3. If an older client requires system/developer projection, temporarily select
   `legacy-user-prefix`, record that exception, and plan to remove it before
   v0.7.0.
4. Enable Chat only when required:
   `enable_legacy_chat_completions: true`.
5. Keep `session_affinity_mode: "explicit-only"` and have capable Responses
   clients send a stable metadata key. Use `legacy-initial-input` only as a
   temporary routing migration.
6. Persist the reasoning key file/keyring alongside the provider database and
   include it in service backup/restore procedures.
7. Require authenticated `/ready` before routing clients; it checks active
   accounts, database writability, keyring availability, and active key-ID
   coverage.
8. Keep `runtime_endpoint_mode: "kiro-runtime"`,
   `dynamic_model_catalog: true`, and `enforce_single_instance: true` unless a
   deployment has explicit evidence and external coordination for changing
   those production defaults.

The live upstream evidence behind these decisions is in
[`audits/kiro-protocol-projection-probe-2026-08-26.md`](audits/kiro-protocol-projection-probe-2026-08-26.md).
The compiled-service client gate is recorded in
[`audits/kiro-provider-v0.5.0-rc.3-opus5-validation-2026-08-27.md`](audits/kiro-provider-v0.5.0-rc.3-opus5-validation-2026-08-27.md).
