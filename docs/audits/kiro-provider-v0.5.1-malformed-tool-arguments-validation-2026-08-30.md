# Kiro Provider v0.5.1 malformed tool arguments validation

Date: 2026-08-30

## Scope

This release separates syntactically malformed completed tool arguments from
structural tool-call protocol violations.

The observed Zuno failure had:

- an authoritative `metering-clean-eof` completion witness;
- 18 `toolUseEvent` fragments;
- partial assistant text;
- no exposed or dispatched tool call;
- a final accumulated argument payload that was not valid JSON.

Prompt size and tool count may increase model error probability, but this
change does not claim they are the direct root cause.

## Provider behavior

The new retryable code is:

```text
malformed_upstream_tool_arguments
```

It is emitted only when all of the following are true:

1. the streamed tool call has a stable ID and name;
2. the tool call emitted its stop marker;
3. the fully accumulated argument payload fails final JSON parsing;
4. no canonical `tool_call_delta` has been emitted.

The following remain fatal:

- missing tool ID or name;
- tool name changes during one call;
- argument fragments after the stop marker;
- a missing stop marker;
- other canonical stream ordering or protocol violations.

Legacy `invalid_upstream_tool_call` remains fatal. Older Provider versions used
that code for both malformed JSON and structural violations, so globally
reclassifying it would make migration unsafe.

## Atomicity and observability

The Provider continues to buffer every tool fragment and validates all
completed tool calls before emitting any canonical tool-call event. A failed
attempt may therefore contain partial assistant text, but it contains no
Provider-exposed tool call.

`ToolCallViolation` audit fields include:

- `violation_kind`;
- `tool_id_hash`;
- `tool_name_hash`;
- `tool_arguments_length` as UTF-8 bytes;
- `tool_arguments_hash`;
- `tool_fragment_count`.

Raw tool arguments, IDs, and names are not written to the audit log.

## Protocol mapping

- Responses:
  `response.failed.response.error.code=malformed_upstream_tool_arguments`.
- Chat Completions:
  `error.type=upstream_error` and
  `error.code=malformed_upstream_tool_arguments`.
- Anthropic Messages:
  `error.type=overloaded_error`.

Structural `invalid_upstream_tool_call` continues to map to a fatal Responses
failure, Chat `upstream_protocol_error`, and Anthropic `api_error`.

## Regression evidence

The injected fixture reproduces a clean metering completion followed by final
validation of 18 malformed tool fragments. It proves:

- partial assistant text is present;
- no `tool_call_delta`, Responses function-call item, or custom-tool item is
  emitted;
- the stream terminates with the new retryable code;
- telemetry reports `malformed_arguments` and fragment count `18`;
- telemetry contains hashes and lengths but no raw argument, ID, or name.

Structural fixtures separately cover missing identity, name changes, fragments
after stop, and missing stop.

## Release gates

- `make ci`: `896 pass / 0 fail`, `3718` expectations;
- `make coverage-gate`: `13865/14810 = 93.62%`, passing the `93%` threshold;
- `make fmt-check`: passed;
- `make coverage-parity`: passed;
- `make security`: `7/7` passed;
- `make codex-smoke-security`: passed;
- `bun run build`: passed, 191 modules;
- `bun run build:binary`: passed;
- `bun run build:npm`: passed;
- `git diff --check`: passed;
- CodeGraph: 174 files, 2705 nodes, 10949 edges, no pending changes.

## Zuno rollout requirement

Deploy Provider v0.5.1 before enabling the Zuno retry classification. Old Zuno
versions will safely treat the unknown code as fatal.

Zuno should then map only `malformed_upstream_tool_arguments` to its replacement
stream retry path. The failed attempt and structured code must be persisted,
partial output must be replaced rather than appended, session affinity must be
preserved, and the tool dispatcher must remain untouched for the failed
attempt. Existing `invalid_upstream_tool_call` handling must remain fatal.

The complete downstream contract is in
[`../ZUNO_STREAM_ERROR_HANDOFF.zh.md`](../ZUNO_STREAM_ERROR_HANDOFF.zh.md).
