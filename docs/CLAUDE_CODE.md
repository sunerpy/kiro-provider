# Using kiro-provider with Claude Code

kiro-provider exposes the Anthropic-compatible endpoints used by Claude Code:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens` (estimated; responses include
  `x-kiro-token-count-mode: estimate`)

The compatibility target for this revision is Claude Code **2.1.263**. A future
Claude Code release can add beta headers or body fields, so re-capture its
request shape before claiming compatibility with a newer version.

## Isolated `kiroclaude` profile

The repository contains Linux launch helpers under `scripts/`. They deliberately
use a separate `CLAUDE_CONFIG_DIR`, so settings, plugins, credentials, signed
thinking, and session history never mix with the normal `~/.claude` profile.
The launcher does not edit `~/.claude/settings.json`; a normal `claude` command
therefore keeps its existing provider, including native Amazon Bedrock.

For a checkout-only invocation:

```bash
PATH="$PWD/scripts:$PATH" kiroclaude -p 'Reply with exactly: KIROCLAUDE_OK'
```

Defaults:

- gateway root: `http://127.0.0.1:8787` (do not append `/v1`);
- profile: `~/.kiroclaude`;
- built-in model aliases: `claude-opus-5`, `claude-sonnet-5`, and
  `claude-haiku-4-5`;
- additional picker rows: `gpt-5.6-sol`, `gpt-5.6-terra`, and
  `gpt-5.6-luna`;
- selected model/mode: Opus 5 with `effortLevel: "xhigh"` and
  `ultracode: true` (shown as Ultra mode by Claude Code);
- away/recap summaries disabled in this isolated profile with both
  `awaySummaryEnabled: false` and `CLAUDE_CODE_ENABLE_AWAY_SUMMARY=0`;
- nonessential Claude traffic disabled because Kiro does not enforce Structured
  Outputs used by title/classifier requests;
- experimental betas remain enabled.

Override them without changing the ordinary Claude profile:

```bash
KIROCLAUDE_BASE_URL=http://127.0.0.1:18787 \
KIROCLAUDE_CONFIG_DIR=/tmp/kiroclaude-profile \
KIROCLAUDE_MODEL=sonnet \
KIROCLAUDE_EFFORT=high \
PATH="$PWD/scripts:$PATH" kiroclaude
```

`KIROCLAUDE_EFFORT=ultra` (the default) enables Ultracode and sends `xhigh`.
Explicit `low`, `medium`, `high`, `xhigh`, or `max` values disable Ultracode
and select that ordinary effort rung.

`kiroclaude-token` is used through Claude Code's `apiKeyHelper`. It reads the
first non-empty `api_keys` entry from
`${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json` (override with
`KIROCLAUDE_PROVIDER_CONFIG`), requires an owner-only file mode, and never puts
the key in the tool subprocess environment.

These scripts are not installed by the release installer in this revision. Copy
or link them only after deciding to make the profile permanent; isolated smoke
tests can run them directly from the checkout.

### Bedrock Fable 5.1 fallback

Fable cannot be added as another row in the Kiro model picker: Claude Code
selects its provider/base URL per process, not per model row. The configured
MyOpenAI service exposes OpenAI APIs but no Anthropic Messages endpoint, while
the existing native Bedrock profile exposes Fable 5.1. Start that fallback as
a separate process and profile:

```bash
PATH="$PWD/scripts:$PATH" kiroclaude --bedrock-fable
```

This uses `~/.kiroclaude-fable`, `model: "fable"`, max effort,
`AWS_PROFILE=us-claude`, `AWS_REGION=us-east-2`, and
`ANTHROPIC_DEFAULT_FABLE_MODEL=us.anthropic.claude-fable-5-1`. It does not use
the Kiro `apiKeyHelper` or `ANTHROPIC_BASE_URL`. Override those three Bedrock
values with `KIROCLAUDE_AWS_PROFILE`, `KIROCLAUDE_AWS_REGION`, and
`KIROCLAUDE_FABLE_MODEL`; override its effort separately with
`KIROCLAUDE_FABLE_EFFORT`. This is a launch-time backend choice, not a hot
model switch within an existing Kiro conversation.

### GPT model picker and output-limit boundary

Claude Code gateway discovery deliberately keeps only model IDs containing
`claude` or `anthropic`, so it cannot discover the GPT IDs returned by
kiro-provider. The launcher instead supplies three explicit `modelPicker` rows.
Each row has `behavesAs: "claude-opus-5"`, which Claude Code 2.1.263 accepts as
the capability template for effort, xhigh/max effort, and adaptive thinking.
This is why selecting Sol, Terra, or Luna exposes the same left/right effort
control without adding five suffix variants per model. Claude Code currently
reports a conservative 200K context window for these custom rows; the launcher
does not claim the larger Kiro-side GPT limit as a client-enforced window.

Claude Code always sends a positive `max_tokens` (64,000 in the validated GPT
request), but Kiro's GPT stateless schema rejects every tested output-token
field spelling. The launcher therefore sends the explicit request header:

```text
X-Kiro-Output-Token-Limit-Mode: advisory
```

For GPT-5.6 Sol/Terra/Luna only, this says the caller accepts that `max_tokens`
is required by Claude Code but cannot be enforced upstream. The provider omits
the field from Kiro, emits the audit event
`anthropic_output_token_limit_unenforced`, and returns
`x-kiro-output-token-limit-mode: advisory-unenforced`. Missing, misspelled, or
non-GPT uses of the header do not bypass validation. OpenAI Responses, Chat
Completions, ordinary Anthropic clients, and a normal `claude` command retain
the existing fail-closed behavior.

The three GPT IDs can be overridden for a compatible private catalog with
`KIROCLAUDE_SOL_MODEL`, `KIROCLAUDE_TERRA_MODEL`, and
`KIROCLAUDE_LUNA_MODEL`. Since `behavesAs` and Claude Code request shapes can
change between releases, the current support claim remains pinned to Claude
Code 2.1.263.

## Supported Claude Code request behavior

The Messages adapter accepts the current Claude Code request shape while keeping
Kiro-only limitations explicit:

- text, base64 images, standard tools, `tool_use`, `tool_result`, and
  `is_error`;
- top-level and mid-conversation system text through the configured Kiro
  projection mode;
- adaptive thinking and `output_config.effort`;
- GPT effort is translated to Kiro's `reasoning.effort`; Claude models keep
  Kiro's `output_config.effort`;
- GPT-5.6 Sol/Terra/Luna ellipsis-only reasoning placeholders are buffered and
  omitted, including split `"." + "." + "."` streams; Claude Code receives an
  empty thinking block with the unchanged native signature, and continuation
  restores the exact stored placeholder by assistant-output fingerprint;
- `thinking.display: "omitted"`: real signed Kiro thinking is encrypted in the
  replay store, while Claude Code receives an empty thinking block and an opaque
  `kr1_` signature that restores the original block on continuation;
- prompt-cache markers are validated and removed as performance hints, with
  `x-kiro-prompt-cache-mode: unsupported` and zero cache-token usage making the
  lack of Anthropic prompt caching explicit;
- `context_management` is accepted only for the lossless
  `clear_thinking_20251015` / `keep: "all"` form and reports
  `applied_edits: []`;
- `temperature` for the supported Claude path;
- real Anthropic SSE block ordering, stream errors, backpressure, and periodic
  `ping` events during upstream silence;
- `x-claude-code-session-id` as an explicit account/conversation affinity key.

The provider still rejects semantics Kiro cannot represent. Destructive context
edits, Structured Outputs, forced tool selection, serial-tool guarantees, and
unknown beta/tool fields return an Anthropic `invalid_request_error` rather than
being silently discarded. Prompt caching and token counting remain estimates,
not Anthropic-native services.

## Readiness and troubleshooting

Before starting Claude Code, require:

```bash
curl -fsS http://127.0.0.1:8787/health
curl -fsS -H "Authorization: Bearer $(scripts/kiroclaude-token)" \
  http://127.0.0.1:8787/ready
```

A helper permission error means the provider config is not owner-only; use
`chmod 600` on the file. A `capability_rejected:context_management` error means
the client requested a destructive edit outside the lossless subset. Do not
work around these errors with an unreviewed field-stripping proxy.

References:

- [Claude Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol)
- [Claude Code environment variables](https://code.claude.com/docs/en/env-vars)
