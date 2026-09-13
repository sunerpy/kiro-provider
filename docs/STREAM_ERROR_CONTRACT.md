# Streaming error contract

This contract describes the v3.1.1 delivery boundary. It separates upstream
acceptance, incremental progress and validated completion. Error codes introduced
in v0.5.x remain available; accepted streams no longer wait for a complete tool
call before publishing.

The Chinese client handoff is in
[ZUNO_STREAM_ERROR_HANDOFF.zh.md](ZUNO_STREAM_ERROR_HANDOFF.zh.md). This release changes only the Provider.

## Why an in-stream error has no HTTP status

Once an SSE response has started, its HTTP status and headers have already been
sent. A later failure therefore arrives as a terminal stream event rather than
a new HTTP response. For the Responses surface, consumers must inspect
`response.failed.response.error.code`; `status=None` at the client is expected
and must not by itself make the error fatal.

The provider does not retry after it has emitted response bytes. Retrying inside
the same SSE response could duplicate text or repeat a tool side effect.
Attempt-level retry after that point belongs in the downstream orchestrator.

Request validation, authentication and preparation still finish before publication.
For streaming requests, a successful HTTP response with the expected upstream
content type is the acceptance boundary. The SDK HTTP handler observes headers
even when its EventStream decoder is still waiting for the first frame. KiroRuntime
Generate uses the SDK RPC codec to preserve its initial-response metadata; its
client cache is separate from REST CodeWhisperer clients. Responses
then emits its lifecycle, Chat emits its assistant-role chunk, and native Responses
flushes one SSE comment before forwarding the upstream lifecycle unchanged.

A comment is transport activity, never model output, token usage or a completion
witness. No timer-generated heartbeat or model-visible placeholder is added.
See [Provider retry boundaries](#provider-retry-boundaries).

## Error codes

### Retryable stream failures

| Code | Meaning | Recommended downstream action |
| --- | --- | --- |
| `upstream_stream_error` | The Kiro SDK reader, decoder, transport, or embedded upstream error terminated the stream. | Retry with bounded exponential backoff. |
| `upstream_stream_incomplete` | The stream ended without an authoritative completion witness, or the canonical stream reached EOF before `completed`. | Retry with bounded exponential backoff. |
| `upstream_stream_idle_timeout` | No upstream event arrived before the configured stream idle timeout. | Retry if the request deadline still has budget. |
| `request_deadline_exceeded` | The provider-side request deadline won the terminal race. | Retry only under the caller's overall deadline and attempt budget. |
| `malformed_upstream_tool_arguments` | Kiro completed a tool call, but the fully accumulated argument payload was not valid JSON. Partial argument deltas may already be visible, but no validated tool completion is emitted. A call that stopped without ever carrying an `input` key (the probe-confirmed zero-parameter shape) is projected as `{}` and is not malformed; an empty or whitespace-only fragment that was actually received still is. | Retry as a replacement attempt if no external tool side effect has been dispatched. |

The 2026-08-29 18:05 incident was logged as a top-level SDK `TypeError`, not a
clean EOF. With this contract it maps to `upstream_stream_error`.
`upstream_stream_incomplete` remains reserved for a clean end without a valid
completion witness.

### Fatal protocol failures

| Code | Meaning |
| --- | --- |
| `upstream_protocol_error` | The canonical stream was malformed, out of order, or internally inconsistent. |
| `upstream_invalid_state` | Kiro emitted an explicit invalid-state event. |
| `unsupported_upstream_event` | Kiro emitted an unknown or unsupported event type. |
| `invalid_upstream_reasoning` | Reasoning signatures or visible/redacted reasoning metadata contradicted each other, or (Anthropic Messages) a thinking block completed without any signature, or a signature arrived without a thinking block. This matches the non-stream HTTP 502 for the same upstream output. |
| `invalid_upstream_tool_call` | A tool call omitted its identity, changed its name while streaming, or appended arguments after its stop marker. |
| `incomplete_upstream_tool_call` | A completion witness arrived but a tool call never reached its structural stop marker. |
| `upstream_tool_arguments_too_large` | Aggregate tool arguments and identities exceed `max_request_body_bytes`; no completed call is emitted. |
| `upstream_tool_schema_violation` | Final JSON arguments violate the declared tool schema. |
| `upstream_tool_choice_violation` | Upstream called a tool despite `tool_choice: none`. |
| `invalid_upstream_response` | A successful upstream response has the wrong streaming Content-Type. |
| `missing_upstream_stream` | The SDK response contained no event stream. |
| `unknown_upstream_tool` | The upstream tool identity matches no declared tool or bridge alias. Validation happens before forwarding that identity. The bridge code is `unknown_tool_alias`. |
| `invalid_custom_tool_input` | Kiro completed a Responses custom-tool call whose arguments were not exactly `{"input": string}`. |

Tool restoration codes are shared by the Responses SSE path (`response.failed`) and the
non-stream Responses path, which returns HTTP 502 with
`error.type=upstream_error` and the same `error.code`.

`unknown_upstream_tool` and `invalid_custom_tool_input` are model-output
failures rather than transport or provider-protocol failures. They keep the
fatal disposition for now: retrying may repeat the same output, and the alias
table could also be at fault. The provider records an
`upstream_tool_restore_failed` audit event for each occurrence so real traffic
can show whether replacement attempts succeed; the disposition will be revisited
after that evidence exists. Downstream classifiers should therefore treat both
codes as fatal until this document changes.

These failures require a provider/protocol correction. Mechanical retry can
repeat the same failure and must not be the default.

## Surface mapping

### OpenAI Responses

The provider emits the standard terminal event:

```json
{
  "type": "response.failed",
  "response": {
    "status": "failed",
    "error": {
      "code": "upstream_stream_incomplete",
      "message": "Upstream stream ended before completion"
    }
  }
}
```

Consumers classify the structured `error.code`. The optional `request_id` and
`details` fields retain diagnostic evidence, not retry authorization. Existing
SDK consumers may continue using standard fields. A failed stream never adds a
contradictory `response.completed` event or Chat `[DONE]` sentinel.

### Chat Completions

The terminal SSE frame contains both the compatibility `type` and the specific
`code`:

```json
{
  "error": {
    "message": "Upstream stream idle timeout",
    "type": "upstream_error",
    "code": "upstream_stream_idle_timeout"
  }
}
```

Retryable failures use `type=upstream_error`; fatal protocol failures use
`type=upstream_protocol_error`.

### Anthropic Messages

Anthropic's error event has no independent provider code field. Retryable
stream failures map to `overloaded_error`; fatal protocol failures map to
`api_error`. Downstream Anthropic clients should classify by that structured
type and must not parse the prose message.

## Required downstream behavior

1. Persist the failed attempt and its structured code before scheduling a
   retry.
2. Treat retry output as a replacement attempt. Never append it to text from
   the failed partial stream.
3. Reissue the original turn with the same session-affinity key. Do not turn
   the partial assistant text into conversation history.
4. Use bounded exponential backoff with jitter. A practical default is three
   total attempts: the initial request plus retries near 0.5 s and 1.5 s,
   capped by the caller's overall deadline.
5. Do not automatically retry after a tool side effect was dispatched unless
   the tool execution has an idempotency key or an equivalent deduplication
   guarantee.
6. Keep fatal protocol codes out of the retry set.

Incremental tool arguments are provisional. Wait for a successful response
terminal state and validated call completion before executing them. A failure
must discard provisional arguments; never close a JSON fragment, substitute `{}`,
or join output from replacement generations. The existing zero-argument exception
requires **no input field**, an explicit tool stop, and a completion witness.

Function names, item IDs, call IDs and ordering remain stable. Function argument
deltas are forwarded as they arrive; split Unicode scalars are held until complete.
Custom-tool wrappers are buffered per call until the complete string is safely
restored. Comments emitted for actual custom fragments indicate activity only.
Final validation checks JSON, the aggregate byte budget, and the declared schema.
Schema validation never coerces values or inserts defaults. Unsupported external
references and asynchronous schemas fail before dispatch with `invalid_tool_schema`.
This local validation does not claim that upstream strict generation is supported.

## Provider retry boundaries

- Before upstream acceptance, typed HTTP/transport retry policy applies within
  the existing `rate_limit_max_retries` budget and request deadline. SDK retries
  remain disabled. Generic permission 403 does not force credential refresh;
  actual credential rejection retains the existing one-refresh allowance.
- Numeric and HTTP-date `Retry-After` values are honored. Missing or invalid values
  use the configured fallback, not an invented zero or fixed 60-second wait.
  Remaining valid backoff is returned in error response headers where applicable.
- Once a stream is accepted, EOF, idle, malformed arguments and SDK errors finish
  that stream. Even a witnessed empty completion is returned without replacement.
  No stream replay or account switch can splice a second generation into it.
- Non-stream collection keeps its bounded replacement behavior because nothing
  has been published. `stream_max_attempts` bounds pre-semantic collection failures;
  `retry_empty_completion` permits one empty-result replacement inside that budget.
  Later collection failures retain the existing general retry budget.
- Cancellation and the request deadline stop dispatch, pending queue acquisition,
  token refresh, backoff and body consumption. Cleanup cannot replace the first
  cancellation source or previous upstream failure.

The request deadline uses a single timer and monotonic elapsed diagnostics. Raw
upstream activity refreshes transport idle, including frames with no projectable
content. Projected-frame counters are separate. Neither timer-driven heartbeats
nor raw activity reset the total deadline. Backpressure does not create an idle
failure while the Provider deliberately waits for the consumer; the total deadline
still releases the request's resources.

Native Responses still validates IDs, increasing sequence numbers and terminal
consistency, including a final EOF check before committing stored state. A bare
`[DONE]` is not a completion witness. Its genuine `response.incomplete` reason is
preserved. Stateless SDK completion keeps the established token-usage/metering
witness policy; transport cleanup cannot erase already validated completion.

No Zuno configuration migration, timeout increase, model switch or reasoning change
is required by this release. Clients should preserve structured failure and request
IDs and apply their own bounded, side-effect-aware replacement policy.

## Provider observability

The `upstream_tool_restore_failed` audit event (Responses, emitted by both the
SSE and non-stream paths) includes `error_code`, `error_disposition`, the
internal `bridge_code`, and a hashed `tool_name_hash`; the raw tool name is
never logged.

The `sdk_stream_upstream_error` audit event now includes:

- `error_code`
- `error_disposition`
- `error_type`
- hashed top-level and cause messages
- safe cause/source error codes when present
- the existing raw event count, final event type, and per-event counts
- tool violation kind
- hashed tool ID and name
- accumulated argument UTF-8 byte length and hash
- fragment count

Raw exception prose is not logged, avoiding accidental credential or payload
disclosure while still allowing repeated failures to be correlated. Raw tool
arguments, tool IDs, and tool names are never written to the audit log.

`sdk_stream_completed`, `sdk_stream_upstream_error`, `sdk_stream_idle_timeout`,
and `sdk_stream_completion_witness` now carry `mode` (`stream` / `non-stream`).
A local failure while priming the accepted SDK lifecycle may carry
`phase: "prefetch"`; it does not authorize replacing an accepted stream.

### Non-stream collection retry events

| Event | Level | Fields |
| --- | --- | --- |
| `sdk_stream_attempt_retry` | warn | `attempt` (the failed attempt, 1-based), `max_attempts`, `error_code`, `same_account` (boolean), `account_hash`, `mode` |
| `sdk_stream_attempts_exhausted` | warn | `attempt`, `max_attempts`, `error_code`, `account_hash`, `mode` |
| `sdk_stream_empty_completion_retry` | warn | `attempt`, `max_attempts`, `account_hash`, `model`, `conversation_hash`, `mode`, raw event counts |
| `sdk_stream_transport_error_after_completion` | warn | `model`, `conversation_hash`, `witness_kind`, `error_type`, `error_code`, `error_disposition`, `error_message_hash`, safe cause fields |

### Stream terminal telemetry

Exactly one `sdk_stream_terminal` (info) is emitted per attempt-stream, on both
the streaming and non-stream paths, including outcomes that previously left no
trace (`consumer_cancel`, `external_abort`):

- `terminal_provenance` ∈ `normal_complete`, `idle_timeout`, `upstream_error`,
  `consumer_cancel`, `external_abort`
- `completion_witnessed` (boolean) and `witness_kind`
  (`token-usage-metadata` / `metering-clean-eof`)
- `reasoning_chars`, `visible_chars`, `tool_count`, `tool_delta_count`, `reasoning_redacted`;
  `tool_count` stays zero until successful completion
- `tool_intent_open` — a tool call started but never reached its stop marker
- `finish_reason` and `finish_reason_synthesized` — present only when a
  `completed` event exists; the latter is always `true` because Kiro exposes
  no stop marker and the canonical finish reason is derived from the tool count
- `canonical_event_count`, plus the existing `model`, `conversation_hash`,
  `mode`, `raw_event_count`, `last_event_type`, `event_type_counts`

Counts only; no reasoning, text, or tool content is ever logged.
`sdk_stream_completed` is retained unchanged for backward compatibility.

### Request and attempt diagnostics

`X-Request-ID` identifies the logical gateway request. Each dispatch has a separate
`attempt_id`. Error details contain phase, attempt, elapsed milliseconds,
`response_committed`, `completion_witnessed`, `cancel_source`, `first_failure` and
`last_failure`. Evidence retains actual upstream HTTP status/code/request ID when
observed; unknown values stay null. A local deadline after a 503 retains both causes.

Audit events record request receipt, dispatch, upstream headers/acceptance,
downstream handoff, first/last upstream frame, first projected frame, cleanup and
body closure. Handoff timestamps describe the server boundary; client receipt
latency is measured separately by real HTTP tests. `downstream_bytes` counts bytes
handed to the HTTP body consumer, not a remote acknowledgement. Closing a local
socket is recorded without claiming the remote model has stopped computing.

Error messages are bounded to 1,024 characters and redact known credentials,
request text, JSON payloads, URLs, emails and authorization fields. Audit logs use
message hashes instead of raw exception prose. Invalid request IDs are omitted;
IDs are not metric labels, prompts, account selectors or idempotency credentials.

The reproducible isolated probe is `scripts/probe-stream-delivery.ts` (pinned
OpenAI SDK 7.13.0). It executes no tools, checks incremental arguments byte for byte,
manually supplies a fixed tool result to validate full-output replay, and checks
cancellation. Authentication failures remain explicit limitations, never evidence
of native streaming success.
