# Using kiro-provider with Claude Code

kiro-provider exposes `POST /v1/messages` and
`POST /v1/messages/count_tokens` for Anthropic-compatible clients.

## Current v0.5.0-rc.3 status

The compiled-service gate on 2026-08-27 used **Claude Code 2.1.209** with only
the standard `ANTHROPIC_BASE_URL`, API key, `claude-opus-5`, and max effort.
The model now passes provider validation. The request is then rejected before
Kiro with `unsupported_parameter` at `context_management`.

That field has no proven native Kiro equivalent, and the provider does not
discard it. Consequently Claude Code 2.1.209 has **not passed the v0.5 stable
gate**. Direct Opus 5 Messages requests within the verified subset do pass
JSON and SSE generation.

The direct Messages subset itself supports text, exact tools/results, base64
images, typed JSON/SSE events, estimated token counting, and complete native
Kiro signed/redacted reasoning replay. Safe mode rejects `system`; the
explicit migration mode can prefix only the original instruction blocks.
Forced tool selection, serial-only tool guarantees, prompt-cache directives,
unsupported output formats, and unknown nested fields remain explicit errors.

## Isolated compatibility probe

Start the provider, then configure only the standard variables:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export ANTHROPIC_API_KEY="sk-your-private-key"
claude --bare --safe-mode --model claude-opus-5 --effort max \
  -p "Reply with exactly: CLAUDE_CODE_OK"
```

For Claude Code 2.1.209, the expected RC.3 result is a non-zero exit at
`context_management`. Do not add a request-stripping proxy: support requires
an equivalent native implementation or a client version/configuration with a
supported shape.

In shared-auth mode, authenticate with `opencode auth login` and require
authenticated `GET /ready` to return 200 before running the probe. The gateway
root is used as the base URL; do not append `/v1`.

See the current evidence in
[`audits/kiro-provider-v0.5.0-rc.3-opus5-validation-2026-08-27.md`](audits/kiro-provider-v0.5.0-rc.3-opus5-validation-2026-08-27.md).
The older [`E2E_VALIDATION_2026-08-22.md`](E2E_VALIDATION_2026-08-22.md) is a
historical v0.4 record only.
