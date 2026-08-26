# Using kiro-provider with Claude Code

kiro-provider exposes `POST /v1/messages` and
`POST /v1/messages/count_tokens` for Anthropic-compatible clients.

## Current v0.5.0-rc.1 status

The compiled-service gate on 2026-08-26 used **Claude Code 2.1.209** with only
the standard `ANTHROPIC_BASE_URL`, API key, and model settings. Current Claude
Code requests include semantics that the verified Kiro projection cannot
preserve:

- `output_config.format`;
- `context_management`;
- after the first rejection, a retry with `system` in `messages.1.role`.

The first two are rejected before Kiro with `unsupported_parameter` and their
exact field path. The retry is rejected by the Anthropic request schema because
`messages[].role` permits only `user` or `assistant`; the provider will not
silently lift or relocate it. The same result occurs in safe and
`legacy-user-prefix` modes; legacy mode only projects valid instruction text
and never enables unrelated features. Consequently Claude Code 2.1.209 has
**not passed the v0.5 stable gate**, and the historical v0.4 tool-loop result
is not a current RC pass.

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
export ANTHROPIC_AUTH_TOKEN="sk-your-private-key"
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-5"
claude -p "Reply with exactly: CLAUDE_CODE_OK"
```

For Claude Code 2.1.209, the expected RC result is a non-zero exit identifying
`output_config.format`, `context_management`, or the invalid
`messages.1.role=system` retry. Do not add a request-stripping or role-moving
proxy: accepting the client requires an equivalent native implementation or a
client version/configuration that sends a supported request shape.

In shared-auth mode, authenticate with `opencode auth login` and require
authenticated `GET /ready` to return 200 before running the probe. The gateway
root is used as the base URL; do not append `/v1`.

See the current evidence in
[`audits/kiro-provider-v0.5.0-rc.1-validation-2026-08-26.md`](audits/kiro-provider-v0.5.0-rc.1-validation-2026-08-26.md).
The older [`E2E_VALIDATION_2026-08-22.md`](E2E_VALIDATION_2026-08-22.md) is a
historical v0.4 record only.
