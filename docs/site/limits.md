# Known limits

This page lists what kiro-provider refuses on purpose, what Kiro does not offer, and the open problems it knows of.
Everything in the two lists of refusals fails with a typed error that names the field. A few fields are accepted
without an effect Kiro can guarantee; the third list names them.

## Refused in OpenAI Responses

- `background: true`, Responses `conversation` objects, `POST /v1/responses/compact` and an exact
  `POST /v1/responses/input_tokens` (the last two answer `501 unsupported_endpoint`).
- Structured Outputs and JSON mode, except one small local profile that Codex CLI uses for thread titles.
- Hosted tools other than web search: File Search, Computer Use and hosted MCP. Kiro has none of them, and
  kiro-provider does not imitate their events.
- A `required`, named or constrained `tool_choice`. `auto` and `none` work.
- Remote image URLs and OpenAI `file_id` references; send images and files inline instead.
- Prompt templates, moderation settings and context management.

## Refused in Anthropic Messages

- Context edits that remove content. Only `clear_thinking_20251015` with `keep: "all"` is accepted.
- Structured Outputs, except the same small profile, which Claude Code uses for session titles.
- Forcing a tool, or requiring tools to run one at a time.
- A user message that mixes images of its own with images inside tool results.
- Unknown beta fields and tool versions.

`/v1/messages/count_tokens` returns an estimate, marked by the response header `x-kiro-token-count-mode: estimate`.
Prompt-cache markers are hints for Kiro, not a guarantee.

## What Kiro does not offer

- `parallel_tool_calls: false` is accepted, but Kiro does not promise to run tools strictly one at a time.
- `text.verbosity` is accepted as compatibility metadata; Kiro has no verbosity control to pass it to.
- `DELETE /v1/responses/{id}` removes kiro-provider's local copy. Kiro offers no way to delete its own server-side
  state for a response, so the gateway cannot promise that.
- `store: false` turns off the gateway's local copy; it is not a zero data retention promise from AWS.
- Web search runs only with `gpt-5.6-sol` and `claude-opus-5.5` on accounts in `us-east-1`, the combinations that
  were tested. [Web search](guide/web-search.md)

## Platforms

- Standalone binaries exist for Linux x64 and ARM64, macOS Intel and Apple Silicon, and Windows x64. There is no
  Windows ARM64 build.
- The npm package runs on Bun only.

## Open problems

- **Opus 5 after a finished tool turn.** A Claude Opus 5 conversation whose history holds a completed tool turn and
  a final answer can fail on the next turn with `502 upstream_stream_incomplete`. The same request succeeds on Opus
  5.5. The cause is upstream and not yet known; kiro-provider does not trim the history to hide it. The
  [audit record](../audits/model-switch-replay-2026-10-04.zh.md#仍-open-的上游问题) has the reproduction.

Each client guide also lists the client versions that were validated; a newer client can send a field that is not
supported yet. [Protocol compatibility](../PROTOCOL_COMPATIBILITY.md) is the complete contract.
