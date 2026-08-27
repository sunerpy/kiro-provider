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
| Multiple top-level text blocks in one message | Rejected with `unsupported_content_block_projection`. Kiro exposes one text field, so concatenating blocks would erase their boundaries. Tool-result text arrays remain structured. |
| Responses `instructions`; Chat/Responses `system` and `developer`; Anthropic `system` | `safe`: `unsupported_instruction_projection`. `legacy-user-prefix`: exact text is joined with `\n\n` and prepended to the first user turn; no other legacy rewrites return. |
| Function tools and Responses custom tools | Exact declaration, public name, schema, call ID, arguments, result, order, and source path are retained. History without the exact declaration returns `missing_tool_declaration`. |
| `tool_choice: auto` | Supported. |
| `tool_choice: none` | Supported only when no unfinished tool state requires a declaration. Otherwise rejected. |
| Required/specific tool choice | Rejected with `unsupported_tool_choice`; Kiro cannot guarantee it. |
| `parallel_tool_calls: false` | Accepted as a no-op only when no callable tools can run, including `tool_choice: none`; otherwise rejected with `unsupported_parallel_tool_calls`. |
| Strict schemas, custom grammar, namespace tools | `strict: true`, custom `format`, and namespace identity are rejected rather than weakened or renamed. |
| Reasoning effort | Explicit effort mapping is retained. Unsupported effort controls are rejected field-by-field. |
| Responses `reasoning.encrypted_content` | When Kiro emits a complete signed-text or redacted envelope, the response contains a random `kr1_...` token backed by encrypted local storage. Incomplete/signature-only upstream events produce no token. |
| Images | Base64 Anthropic images and OpenAI data URLs are mapped to Kiro. Remote URLs, image-detail controls, invalid media, more than four images, or more than 3.75 MiB of base64 data are rejected. |
| Output token limit | Probe-confirmed only for `claude-sonnet-5` variants, from 1,024 through 128,000. Other models return `unsupported_output_token_limit`. |
| Structured output, sampling/logprob controls, files | Rejected until an equivalent native Kiro capability is proven. Default text format is accepted. |
| `previous_response_id`, Responses `conversation`, `store: true` | Rejected; this version does not provide a server-side OpenAI response store. |
| Kiro-managed Web Search | Rejected with `unsupported_web_search`. The provider does not fabricate `web_search_call` or citation events. |
| Chat `stream_options.include_usage` | Supported only for streaming Chat. Exactly one separate, choices-empty usage chunk is emitted when requested. Other `stream_options` fields are rejected. |

Unknown nested fields in supported objects are rejected with a field path.
This is intentional: accepting and discarding them would falsely claim protocol
compatibility.

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
plus Kiro conversation ID. With no explicit key, each request gets a fresh
Kiro conversation while retaining account-level scheduler and cached
SDK/transport object reuse. Kiro model-call sockets are fresh by default;
keep-alive is an explicit opt-in. Identical prompts in independent sessions therefore do
not collide.

`legacy-initial-input` temporarily restores the v0.4 prompt-fingerprint
heuristics. It emits a content-free startup warning and affects routing only;
it does not enable prompt injection, message merging, or any other protocol
rewrite.

## Current compiled-client acceptance status

The 2026-08-27 RC.2 gate used the compiled binary without private headers,
request patches, or client-side prompt compensation. Any required documented
client option is stated in its row:

| Client | v0.5.0-rc.2 result |
| --- | --- |
| OpenAI JavaScript SDK 7.5.0 | Pass: Responses streaming/non-streaming, Chat streaming/non-streaming, function/custom tool loops, and encrypted reasoning replay across a provider restart. |
| OpenCode 1.18.18 Responses | Pass only with explicit `legacy-user-prefix` and a Claude Sonnet 5 model. Safe mode correctly rejects its developer prompt; GPT requests also carry an unsupported output-token limit. |
| OpenCode 1.18.18 Chat | Blocked: the client adds `messages.0.cache_control`, which this protocol does not define and the provider will not silently discard. |
| Codex CLI 0.149.0-alpha.4.1 | Blocked before Kiro first on `text.verbosity`. The captured request also contains unsupported `reasoning.context`, serial-only tool semantics while callable tools are active, and custom grammar/namespace controls. |
| Claude Code 2.1.209 | Blocked before Kiro: the final run first sent unsupported `output_config.format`, then retried with invalid `messages.1.role=system`; an earlier redacted capture also contained `context_management`. |
| Zuno native OpenAI Responses | Not rerun in RC.2 by explicit scope, and no Zuno source or configuration was changed. RC.1 evidence remains historical integration guidance, not a fresh RC.2 pass. |

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
| `unsupported_instruction_projection` | Safe mode cannot represent instruction roles without modifying user text. |
| `unsupported_content_block_projection` | Kiro cannot preserve multiple top-level text block boundaries in one message. `param` identifies the first unprojectable block. |
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

The live upstream evidence behind these decisions is in
[`audits/kiro-protocol-projection-probe-2026-08-26.md`](audits/kiro-protocol-projection-probe-2026-08-26.md).
The compiled-service client gate is recorded in
[`audits/kiro-provider-v0.5.0-rc.2-validation-2026-08-27.md`](audits/kiro-provider-v0.5.0-rc.2-validation-2026-08-27.md).
