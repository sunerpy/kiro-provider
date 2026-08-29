# Kiro provider stream-error hardening — 2026-08-29

## Scope

This change hardens in-stream failure propagation for the OpenAI Responses,
Chat Completions, and Anthropic Messages compatibility surfaces. It was
implemented in an isolated worktree on branch `codex/typed-stream-errors`,
based on commit `71a5027c417a04833c3ba1ebe305d28ce209bf74`.

No production service, user configuration, account database, or downstream
Zuno checkout was modified.

## Incident interpretation

The 18:05 failure had partial assistant events and no completion witness, but
the provider log recorded a top-level SDK `TypeError`. That is not the same
runtime path as a clean EOF reaching
`SemanticStreamTruncationError`.

The implemented mapping is therefore:

- SDK reader/decoder/transport `TypeError`:
  `upstream_stream_error`, retryable.
- Clean EOF without token-usage metadata or valid metering completion:
  `upstream_stream_incomplete`, retryable.
- Structural reasoning/tool/event violations:
  a specific fatal protocol code.

This preserves the recovery class without erasing the distinction needed for
later diagnosis.

## Provider changes

- Added one central stream-error registry with stable public messages and a
  `retryable` versus `fatal` disposition.
- Preserved typed stream errors through `response.failed.response.error.code`
  instead of rewriting every reader failure to `upstream_error`.
- Added `upstream_stream_idle_timeout`,
  `request_deadline_exceeded`, `missing_upstream_stream`, and
  `invalid_upstream_reasoning`.
- Reclassified contradictory reasoning metadata from an untyped `TypeError` to
  a fatal `SdkStreamProtocolError`.
- Distinguished canonical EOF-before-completion from malformed/order-invalid
  canonical streams.
- Added Chat `error.code`; retained `error.type` for compatibility.
- Mapped retryable Anthropic stream failures to `overloaded_error` and fatal
  protocol failures to `api_error`.
- Added structured audit fields for normalized code, disposition, exception
  type, safe source/cause codes, and hashed messages. Raw exception prose is
  not logged.

The complete wire and downstream contract is documented in
[`../STREAM_ERROR_CONTRACT.md`](../STREAM_ERROR_CONTRACT.md).

## Downstream requirement

Zuno must classify these structured codes as transient:

- `upstream_stream_error`
- `upstream_stream_incomplete`
- `upstream_stream_idle_timeout`
- `request_deadline_exceeded`

Protocol codes must remain fatal. A retry must create a new persisted attempt
and replace the failed partial output; it must not append new output to the
partial stream or repeat a non-idempotent tool side effect.

The legacy generic `upstream_error` code intentionally remains outside the
recommended retry set because older provider builds used it for both transient
and protocol failures.

## Verification

- `bun run lint`: passed, 167 files checked.
- `bun run typecheck`: passed.
- `bun test`: passed, 891 tests, 0 failures, 3,681 expectations.
  Local-listener and raw-TCP tests were run outside the restricted sandbox
  after the sandbox returned `EADDRINUSE` for port `0`.
- `bun run build`: passed, 191 modules bundled.
- `git diff --check`: passed.

## Remaining rollout work

1. Merge and deploy the provider change first.
2. Add the structured-code classification and attempt-level retry behavior to
   Zuno.
3. Validate one injected transient stream failure and one injected fatal
   protocol failure end to end.
4. Confirm retry records, replacement of partial output, bounded backoff, and
   no duplicate tool execution in the downstream persistence layer.
