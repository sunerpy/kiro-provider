# Streaming error contract

This contract is part of `v0.5.0` and later provider builds. It separates
transient stream failures from structural protocol failures so downstream
clients can retry only the former.

The Zuno-specific Chinese handoff, including the current source location,
minimal Rust change, persistence requirements, and acceptance cases, is in
[ZUNO_STREAM_ERROR_HANDOFF.zh.md](ZUNO_STREAM_ERROR_HANDOFF.zh.md).

## Why an in-stream error has no HTTP status

Once an SSE response has started, its HTTP status and headers have already been
sent. A later failure therefore arrives as a terminal stream event rather than
a new HTTP response. For the Responses surface, consumers must inspect
`response.failed.response.error.code`; `status=None` at the client is expected
and must not by itself make the error fatal.

The provider does not retry after it has emitted response bytes. Retrying inside
the same SSE response could duplicate text or repeat a tool side effect.
Attempt-level retry after that point belongs in the downstream orchestrator.

Before that point the provider owns the retry: an upstream failure that happens
before the first semantic event exists is replaced by a new upstream attempt
without the client ever seeing a `started` event or a terminal error. See
[Provider-side pre-publication retry](#provider-side-pre-publication-retry).

## Error codes

### Retryable stream failures

| Code | Meaning | Recommended downstream action |
| --- | --- | --- |
| `upstream_stream_error` | The Kiro SDK reader, decoder, transport, or embedded upstream error terminated the stream. | Retry with bounded exponential backoff. |
| `upstream_stream_incomplete` | The stream ended without an authoritative completion witness, or the canonical stream reached EOF before `completed`. | Retry with bounded exponential backoff. |
| `upstream_stream_idle_timeout` | No upstream event arrived before the configured stream idle timeout. | Retry if the request deadline still has budget. |
| `request_deadline_exceeded` | The provider-side request deadline won the terminal race. | Retry only under the caller's overall deadline and attempt budget. |
| `malformed_upstream_tool_arguments` | Kiro completed a tool call, but the fully accumulated argument payload was not valid JSON. No tool-call delta is exposed before this validation succeeds. A call that stopped without ever carrying an `input` key (the probe-confirmed zero-parameter shape) is projected as `{}` and is not malformed; an empty or whitespace-only fragment that was actually received still is. | Retry as a replacement attempt if no external tool side effect has been dispatched. |

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
| `missing_upstream_stream` | The SDK response contained no event stream. |
| `unknown_upstream_tool` | Kiro completed a tool call whose wire name matches no declared tool or bridge alias (typically a hallucinated tool name). Responses only; the bridge code is `unknown_tool_alias`. |
| `invalid_custom_tool_input` | Kiro completed a Responses custom-tool call whose arguments were not exactly `{"input": string}`. |

Both codes are shared by the Responses SSE path (`response.failed`) and the
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

No private `retryable` field is added. Consumers classify the structured
`error.code`.

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

`malformed_upstream_tool_arguments` is safe to classify separately because the
provider buffers every tool fragment and validates every completed tool call
before emitting any canonical `tool_call_delta`. Partial assistant text may
already have been streamed, so the retry must still replace the failed
attempt's output rather than append to it. The legacy
`invalid_upstream_tool_call` remains fatal during migration because older
provider versions used it for both malformed JSON and structural violations.

Provider rollout should precede downstream classification rollout. The legacy
generic `upstream_error` code mixed transient and protocol failures and should
not be globally declared retryable during migration.

## Provider-side pre-publication retry

The streaming response is not published until the first **semantic** canonical
event exists: `reasoning_delta`, `reasoning_redacted`, `text_delta`,
`tool_call_delta`, or `completed`. Until then the pipeline drives the canonical
stream into a small prefetch buffer. Once a semantic event is buffered the
buffer and the live iterator are handed to the response as one stream, so a
retried request produces exactly the same NDJSON/SSE sequence (`started` first)
as an unretried one. The non-stream path publishes nothing until the end and
therefore applies the same rule to failures that happen before its first
semantic event.

What is retried (only before the first semantic event):

- any failure whose contract disposition is **retryable**
  (`upstream_stream_error`, `upstream_stream_incomplete`,
  `upstream_stream_idle_timeout`, `malformed_upstream_tool_arguments`), including
  a stream idle timeout while waiting for the first event;
- a **fully empty completion**: `completed` reached with a valid witness but
  zero reasoning characters, zero visible text characters, zero tool calls, and
  no signed/redacted/encrypted reasoning envelope. When
  `retry_empty_completion` is `true` exactly one same-account replacement
  attempt is spent; if it is empty as well, that result is returned.

What is never retried by the provider:

- anything after a semantic event has been produced, even if it only sits in
  the prefetch buffer (the client-visible contract above applies unchanged);
- **fatal** dispositions (`upstream_protocol_error`, `upstream_invalid_state`,
  `unsupported_upstream_event`, `invalid_upstream_reasoning`,
  `invalid_upstream_tool_call`, `incomplete_upstream_tool_call`,
  `missing_upstream_stream`, `unknown_upstream_tool`,
  `invalid_custom_tool_input`) — these return HTTP 502 with the code, as today;
- a request deadline or client disconnect during the prefetch — the attempt is
  torn down and the request ends with 504/499 exactly like a pre-commit abort.

Bounds and account policy:

- `stream_max_attempts` (default 3) is the total number of upstream streams
  opened for one request, counting the initial attempt and the empty-completion
  replacement. Exhausting it returns HTTP 502 with the last failure's code.
- The first retry always reuses the same account. When the same account fails a
  second time and another selectable account exists, the failing account is
  excluded for this request and normal selection switches (its lease is
  released before the next lease is taken). With no alternative, or under a
  signed-reasoning replay lock, the same account is retried until the budget
  is spent. Stream failures never change account health or rate-limit state.
- Backoff is the rate-limit backoff: `rate_limit_retry_delay_ms` doubled per
  failed attempt with up to 25% random jitter, bounded by the request deadline.
- Each attempt owns its upstream abort; the failed attempt's socket is
  destroyed before the replacement is sent.

Transport errors after a completion witness: when a metering (or token-usage)
witness has already been observed and the SDK reader then rejects with a
transport error while draining the trailing bytes, the canonical stream
completes normally and the fault is audited as
`sdk_stream_transport_error_after_completion`. An embedded upstream `error` or
`invalidStateEvent` after the witness still fails the stream as before.

## Zuno classification change

In `crates/zuno-provider-compatible/src/stream.rs::classify`, inspect the
structured code before the generic fatal fallback:

```rust
if matches!(
    error.code_str(),
    Some(
        "upstream_stream_error"
            | "upstream_stream_incomplete"
            | "upstream_stream_idle_timeout"
            | "request_deadline_exceeded"
            | "malformed_upstream_tool_arguments"
    )
) {
    return ProviderError::Transient {
        status: None,
        source: Some(Box::new(ReportedWireError::new(provider, error))),
    };
}
```

Add regression cases proving that every code above becomes
`ProviderError::Transient`, while `upstream_protocol_error`,
`invalid_upstream_tool_call`, and `invalid_upstream_reasoning` remain
`ProviderError::Fatal`.

The retry scheduler must then create and persist a new attempt record. Merely
changing `Fatal` to `Transient` is insufficient if the engine does not discard
the failed attempt's partial output before replay.

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
A failure audited during the prefetch phase additionally carries
`phase: "prefetch"`.

### Pre-publication retry events

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
- `reasoning_chars`, `visible_chars`, `tool_count`, `reasoning_redacted`
- `tool_intent_open` — a tool call started but never reached its stop marker
- `finish_reason` and `finish_reason_synthesized` — present only when a
  `completed` event exists; the latter is always `true` because Kiro exposes
  no stop marker and the canonical finish reason is derived from the tool count
- `canonical_event_count`, plus the existing `model`, `conversation_hash`,
  `mode`, `raw_event_count`, `last_event_type`, `event_type_counts`

Counts only; no reasoning, text, or tool content is ever logged.
`sdk_stream_completed` is retained unchanged for backward compatibility.
