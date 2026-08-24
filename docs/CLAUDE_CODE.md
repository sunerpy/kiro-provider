# Using kiro-provider with Claude Code

Claude Code sends Anthropic Messages requests. It does not use OpenAI
Responses or Chat Completions for inference.

Verified end-to-end against **Claude Code 2.1.209** on 2026-08-22, including a
real `Read` tool call and tool-result continuation.

## Configure Claude Code

Start kiro-provider, then point Claude Code at the gateway root (do not append
`/v1`):

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export ANTHROPIC_AUTH_TOKEN="sk-your-private-key"
claude
```

`ANTHROPIC_AUTH_TOKEN` is matched against `api_keys`. Anthropic routes also
accept `x-api-key`.

In the default shared-auth mode, authenticate Kiro first with
`opencode auth login` and require authenticated `GET /ready` to return 200.
Provider-local login/import is only for `auth_source: "local"`.

If Claude Code's default model aliases do not match a model returned by
`GET /v1/models`, set the relevant aliases explicitly:

```bash
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4.5"
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4.1"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-4.5"
```

Use model IDs actually exposed by your running gateway.

## Endpoints

- `POST /v1/messages` — non-streaming Anthropic Message JSON or Anthropic
  Messages SSE.
- `POST /v1/messages/count_tokens` — estimated input token count.

## Supported behavior

- Text, base64 image input, system prompts, tools, tool calls, and tool results.
- Streaming event order: `message_start`, content-block events,
  `message_delta`, then `message_stop`.
- Errors after HTTP 200 are emitted as Anthropic `error` SSE events.
- Request deadline, client cancellation, body-size limit, and request-scoped
  Bun idle-timeout lease cleanup use the same lifecycle as Responses.
- No private session header is needed. `metadata.user_id` plus the initial
  user turn, or the initial turn alone, drives persisted account and Kiro
  conversation affinity.

## Explicit limitations

- Kiro does not expose Anthropic signed-thinking blocks. Replayed `thinking`
  and `redacted_thinking` blocks are not converted into model-visible text,
  and the gateway does not fabricate or return thinking signatures.
- `tool_choice` values `any` and `tool`, and
  `disable_parallel_tool_use: true`, return an explicit invalid-request error
  because Kiro has no equivalent structured hard constraint. They are not
  emulated with prompt text.
- `max_tokens` is validated for Messages API compatibility, but the current
  Kiro transport does not expose an exact output-token ceiling. Do not rely on
  it as a hard generation limit.
- Kiro does not expose a standalone tokenizer. Count-tokens responses carry
  `x-kiro-token-count-mode: estimate`; do not treat them as billing-accurate.
- Anthropic prompt-cache directives are accepted as forward-compatible
  metadata, but Kiro cache accounting is not exposed through this gateway.

For production deployment and shared-auth requirements, see
[the production-provider design](PRODUCTION_PROVIDER_DESIGN.zh.md). The exact
real-client evidence is in
[`E2E_VALIDATION_2026-08-22.md`](E2E_VALIDATION_2026-08-22.md).
