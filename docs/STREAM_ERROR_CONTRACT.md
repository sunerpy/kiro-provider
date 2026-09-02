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
Attempt-level retry belongs in the downstream orchestrator.

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

The `upstream_tool_restore_failed` audit event (Responses) includes
`error_code`, `error_disposition`, the internal `bridge_code`, and a hashed
`tool_name_hash`; the raw tool name is never logged.

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
