# Using kiro-provider with Claude Code

kiro-provider exposes `POST /v1/messages` and
`POST /v1/messages/count_tokens` for Anthropic-compatible clients.

## Current v0.5.0-rc.2 status

The compiled-service gate on 2026-08-27 used **Claude Code 2.1.209** with only
the standard `ANTHROPIC_BASE_URL`, API key, and model settings. The final run
produced this request sequence:

- the first request included unsupported `output_config.format`;
- after that rejection, Claude Code retried with `system` in
  `messages.1.role`.

The first request is rejected before Kiro with `unsupported_parameter` and the
exact field path. The retry is rejected by the Anthropic request schema because
`messages[].role` permits only `user` or `assistant`; the provider will not
silently lift or relocate it. An earlier redacted capture from the same client
version also included `context_management`. The same result occurs in safe and
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

For Claude Code 2.1.209, the expected RC.2 result is a non-zero exit after
`output_config.format` and/or the invalid `messages.1.role=system` retry.
Earlier captures may also expose `context_management`. Do not add a
request-stripping or role-moving proxy: support requires an equivalent native
implementation or a client version/configuration with a supported shape.

In shared-auth mode, authenticate with `opencode auth login` and require
authenticated `GET /ready` to return 200 before running the probe. The gateway
root is used as the base URL; do not append `/v1`.

See the current evidence in
[`audits/kiro-provider-v0.5.0-rc.2-validation-2026-08-27.md`](audits/kiro-provider-v0.5.0-rc.2-validation-2026-08-27.md).
The older [`E2E_VALIDATION_2026-08-22.md`](E2E_VALIDATION_2026-08-22.md) is a
historical v0.4 record only.
