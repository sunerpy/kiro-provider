# Use kiro-provider with Claude Code

[简体中文](readme/CLAUDE_CODE.zh-CN.md) · English

**Last validated client:** Claude Code 2.1.270. Newer releases may add beta
headers or request fields; validate their wire shape before extending this
support claim.

kiro-provider exposes the two Anthropic-compatible routes Claude Code needs:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens` — an estimate, marked by
  `x-kiro-token-count-mode: estimate`

## Start a Kiro session with shared Claude state

First check that the local gateway is healthy and ready:

```bash
curl -fsS http://127.0.0.1:8787/health
curl -fsS -H "Authorization: Bearer $(scripts/kiroclaude-token)" \
  http://127.0.0.1:8787/ready
```

Then run Claude Code through the repository launcher:

```bash
PATH="$PWD/scripts:$PATH" kiroclaude -p 'Reply with exactly: KIROCLAUDE_OK'
```

By default, `kiroclaude` leaves Claude's native config resolution unchanged
(normally `~/.claude` plus `~/.claude.json`). Settings, skills, commands,
plugins, MCP servers, CLAUDE.md files, history, and sessions therefore remain
available to both `claude` and `kiroclaude`.

The launcher supplies one process-local `--settings` overlay. Kiro mode
explicitly disables inherited Bedrock, Vertex, Foundry, and Mantle routing,
clears inherited Anthropic credentials, and then selects the local gateway and
model aliases. It does not edit the native settings files, so an ordinary
`claude` process keeps its existing provider.

Shared history does not make provider-specific signatures portable. Start a
new session when switching between native Bedrock and Kiro if the old
continuation contains signed thinking that the other provider cannot replay.

The release installer does not install these helper scripts. Run them from a
checkout for tests, or copy/link them after deciding to keep this profile.

### Defaults and overrides

| Setting | Default |
| --- | --- |
| Gateway root | `http://127.0.0.1:8787` (no `/v1` suffix) |
| Claude state | Shared native `~/.claude` and `~/.claude.json` |
| Model | Opus 5 |
| Reasoning | Ultra: `effortLevel: "max"`, `ultracode: true` |
| Permission mode | Inherit native Claude settings; no launcher override |
| Away recap | Disabled |
| Nonessential title/classifier traffic | Disabled |
| Experimental betas | Enabled |

Override only the current process when needed. Set `KIROCLAUDE_CONFIG_DIR` only
when a deliberately isolated Claude home is required:

```bash
KIROCLAUDE_BASE_URL=http://127.0.0.1:18787 \
KIROCLAUDE_CONFIG_DIR=/tmp/kiroclaude-profile \
KIROCLAUDE_MODEL=sonnet \
KIROCLAUDE_EFFORT=high \
PATH="$PWD/scripts:$PATH" kiroclaude
```

`KIROCLAUDE_EFFORT=ultra` is the default and sets `effortLevel: "max"` with
Ultracode enabled. Claude Code 2.1.270 serializes this Ultra selection as
`output_config.effort: "xhigh"`. `low`, `medium`, `high`, `xhigh`, and `max`
select the corresponding ordinary effort level and disable Ultracode.

The launcher does not elevate permissions by default. It inherits the native
Claude permission policy. Set `KIROCLAUDE_PERMISSION_MODE` explicitly to
`acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, or `plan` to
override that policy for the launched process. Only the explicit
`bypassPermissions` override suppresses the dangerous-mode confirmation. This
removes Claude approval prompts; it does not create an operating-system
sandbox, so use it only in a trusted workspace or an externally isolated
environment. A Claude CLI flag such as `--permission-mode plan` remains a
per-invocation override.

The launcher registers `kiroclaude-token` as Claude Code's `apiKeyHelper`. The
helper reads the first non-empty `api_keys` value from
`${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json`, or from
`KIROCLAUDE_PROVIDER_CONFIG` when set. It refuses files not owned by the current
user or accessible by other users, and it never exports the key to tool
subprocesses.

## Choose a model

The built-in Claude rows map to `claude-opus-5`, `claude-sonnet-5`, and
`claude-haiku-4-5`. The launcher also adds `gpt-5.6-sol`, `gpt-5.6-terra`, and
`gpt-5.6-luna` to the picker.

Claude Code's gateway discovery filters out model IDs without `claude` or
`anthropic`, so the GPT rows must be declared explicitly. Each uses
`behavesAs: "claude-opus-5"` as the client-side capability template. This
exposes adaptive thinking and the left/right effort control without duplicating
each model at every effort level. Claude Code reports a conservative 200K
context window for these custom rows; it does not enforce Kiro's larger GPT
limits from this declaration.

Claude Code also sends a positive `max_tokens` (64,000 in the validated GPT
request), while Kiro's GPT stateless schema rejects every tested upstream
output-token field. The launcher therefore sends:

```text
X-Kiro-Output-Token-Limit-Mode: advisory
```

For the three GPT-5.6 models only, this opts into an explicit compromise: the
provider removes `max_tokens` before calling Kiro, logs
`anthropic_output_token_limit_unenforced`, and returns
`x-kiro-output-token-limit-mode: advisory-unenforced`. Missing or invalid
headers and non-GPT requests remain fail closed. The setting does not change
OpenAI Responses, Chat Completions, another Anthropic client, or the ordinary
`claude` command.

Private catalogs may override the three IDs with `KIROCLAUDE_SOL_MODEL`,
`KIROCLAUDE_TERRA_MODEL`, and `KIROCLAUDE_LUNA_MODEL`.

### Use Fable 5.1 through native Bedrock

Fable cannot be another Kiro picker row because Claude Code chooses its provider
and base URL once per process. Start the Bedrock fallback as a separate process:

```bash
PATH="$PWD/scripts:$PATH" kiroclaude --bedrock-fable
```

This mode uses the same shared Claude home, `model: "fable"`, max effort,
`AWS_PROFILE=us-claude`, `AWS_REGION=us-east-2`, and
`ANTHROPIC_DEFAULT_FABLE_MODEL=us.anthropic.claude-fable-5-1`. It does not set
the Kiro token helper or `ANTHROPIC_BASE_URL`. Override those values with
`KIROCLAUDE_AWS_PROFILE`, `KIROCLAUDE_AWS_REGION`,
`KIROCLAUDE_FABLE_MODEL`, and `KIROCLAUDE_FABLE_EFFORT`.
The process overlay clears inherited custom Anthropic, Vertex, Foundry, and
Mantle routes before enabling Bedrock; native skills and other settings remain
shared.

Changing between Kiro and Bedrock requires a new process and, when prior signed
thinking is provider-specific, a new session. It is not a model switch inside
an existing conversation.

## Compatibility boundary

The adapter accepts the request shapes observed from Claude Code 2.1.270:

- text, base64 images, standard tools, `tool_use`, `tool_result`, and `is_error`;
- one image-bearing `tool_result` in a user message, with the tool identity,
  status, text, and image bytes preserved;
- adjacent text blocks that form one contiguous run around an image or tool
  result;
- top-level and mid-conversation system text through the configured projection
  mode;
- adaptive thinking, `output_config.effort`, and supported Claude
  `temperature`;
- GPT effort projected to `reasoning.effort`, while Claude effort remains
  `output_config.effort`;
- encrypted replay of omitted signed thinking through opaque `kr1_` signatures;
- removal of GPT-5.6 ellipsis-only reasoning placeholders, including split
  `"." + "." + "."` streams, with exact stored replay on continuation;
- prompt-cache markers as validated but unsupported hints, reported by
  `x-kiro-prompt-cache-mode: unsupported` and zero cache-token usage;
- the lossless `clear_thinking_20251015` / `keep: "all"`
  `context_management` form, reported with `applied_edits: []`;
- Anthropic SSE ordering, stream errors, backpressure, silence-period `ping`
  events, and `x-claude-code-session-id` affinity.

A message with multiple image-bearing tool results, or direct user images mixed
with an image-bearing tool result, is rejected because Kiro cannot preserve the
separate image origins. A real `text → non-text → text` interleave is rejected
for the same reason: Kiro exposes one text field.

The provider also rejects destructive context edits, Structured Outputs,
forced tool selection, hard serial-tool requirements, and unknown beta/tool
fields with an Anthropic `invalid_request_error`. It does not silently remove
those semantics. Prompt caching and token counting remain estimates, not native
Anthropic services.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Token helper reports unsafe permissions | Run `chmod 600 ~/.config/kiro-provider/config.json` and confirm the current user owns the file. |
| `capability_rejected:context_management` | The client requested a destructive edit outside the supported lossless form. Do not hide it with an unreviewed field-stripping proxy. |
| Kiro GPT row is absent | Start through `kiroclaude`; gateway discovery alone filters out the GPT IDs. |
| Ordinary `claude` uses the wrong backend | Check the normal `~/.claude` profile. `kiroclaude` does not modify it. |
| A resumed session reports an invalid provider signature | Start a new session after switching between Kiro and native Bedrock. |

References: [Messages API](https://platform.claude.com/docs/en/api/messages/create),
[Claude Code settings](https://code.claude.com/docs/en/settings),
[Claude Code permissions](https://code.claude.com/docs/en/permissions),
[Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol),
and [Claude Code environment variables](https://code.claude.com/docs/en/env-vars).
