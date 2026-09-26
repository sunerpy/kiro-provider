# Use kiro-provider with Claude Code

[简体中文](readme/CLAUDE_CODE.zh-CN.md) · English

**Last validated client:** Claude Code 2.1.270. Newer releases may add beta
headers or request fields; validate their wire shape before extending this
support claim.

kiro-provider exposes the two Anthropic-compatible routes Claude Code needs:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens` — an estimate, marked by
  `x-kiro-token-count-mode: estimate`

For a persistent command with a separate Claude home, see
[separate client launchers](CLIENT_LAUNCHERS.md). The repository launcher's
shared-state default below is a different, intentional choice.

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
checkout for tests, or copy/link them after deciding to keep this launcher.

### Defaults and overrides

| Setting                               | Default                                              |
| ------------------------------------- | ---------------------------------------------------- |
| Gateway root                          | `http://127.0.0.1:8787` (no `/v1` suffix)            |
| Claude state                          | Shared native `~/.claude` and `~/.claude.json`       |
| Model                                 | Opus 5.5, 1M client context window                   |
| Reasoning                             | Ultra: `xhigh` plus Ultracode orchestration          |
| Permission mode                       | Inherit native Claude settings; no launcher override |
| Away recap                            | Disabled                                             |
| Nonessential title/classifier traffic | Disabled                                             |
| Experimental betas                    | Enabled                                              |

Override only the current process when needed. Set `KIROCLAUDE_CONFIG_DIR` only
when a deliberately isolated Claude home is required:

```bash
KIROCLAUDE_BASE_URL=http://127.0.0.1:18787 \
KIROCLAUDE_CONFIG_DIR=/tmp/kiroclaude-profile \
KIROCLAUDE_MODEL=sonnet \
KIROCLAUDE_EFFORT=high \
PATH="$PWD/scripts:$PATH" kiroclaude
```

`KIROCLAUDE_EFFORT=ultra` is the default. It enables Claude Code's Ultracode,
which runs at `output_config.effort: "xhigh"` with standing dynamic-workflow
orchestration, and writes the matching `effortLevel: "xhigh"`. `low`, `medium`,
`high`, and `xhigh` write that `effortLevel` and disable Ultracode.

`max` also disables Ultracode, but Claude Code 2.1.280 persists only `low`
through `xhigh` and silently drops any other `effortLevel`; the earlier
`effortLevel: "max"` therefore reached the wire as `medium`. The launcher passes
max as the session flag `--effort max` ahead of your arguments instead.
Subagents inherit that session level, and a later explicit `--effort` on the
command line still wins because Claude keeps the last one. Any explicit session
effort turns Ultracode off, so Ultra never adds the flag. The
[before/after effort matrix](audits/evidence/kiroclaude-max-effort-2026-09-26/effort-matrix.json)
records the installed-client result.

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

The built-in Opus and Sonnet rows map to `claude-opus-5-5[1m]` and
`claude-sonnet-5[1m]`. The built-in Haiku/small-fast row intentionally also
maps to `claude-sonnet-5[1m]`: Claude Code uses that row for prompt hooks and
sends a positive `max_tokens`, while Kiro Haiku 4.5 rejects every
`additionalModelRequestFields` object. This removes that Haiku-specific
rejection. Claude Code 2.1.280 session-title generation and prompt hooks
additionally send `output_config.format`. Messages accepts it only as the
bounded local `single-string-object-v1` profile described below, which covers
the single required `title` string of the session-title request; the
`hook_prompt` evaluator schema (`ok`/`reason`/`impossible`, two required
properties, boolean types) is outside that profile and still returns
`400 unsupported_structured_output`, so neither the model mapping nor this
profile claims complete prompt-hook compatibility. The built-in
Fable row maps to `claude-fable-5-1[1m]`, whose Kiro wire id is
`claude-fable-5.1`. The launcher also adds `claude-opus-5-5[1m]`,
`claude-opus-5[1m]`, `gpt-5.6-sol[1m]`, `gpt-5.6-terra[1m]`, and
`gpt-5.6-luna[1m]` to the picker.

`claude-opus-5-5` carries the Kiro wire id `claude-opus-5.5`, which keeps its
dotted minor version even though plain Opus 5 does not. Its live catalog entry
advertises a 1M input window, 128K output, image input, a 2.0x rate multiplier,
prompt caching, and an `additionalModelRequestFieldsSchema` declaring
`output_config.effort` as the full `low|medium|high|xhigh|max` enum plus
`max_tokens` from 1,024 through 128,000. Kiro still describes it as an
experimental preview. The built-in Opus row carries it so the `opus` family
alias resolves to the current flagship, and the same ID is declared a second time
as a picker row labelled `Claude Opus 5.5`, which is also what the launcher pins
as the session model. Those two rows resolve to one model on purpose: the named
row is what makes the exact version visible in the client instead of a generic
Opus label. Opus 5 stays reachable as its own picker row and through
`KIROCLAUDE_OPUS5_MODEL`, and `KIROCLAUDE_MODEL=opus` selects the family alias.

### Session titles and `output_config.format`

Claude Code 2.1.280 generates a session title with a side request on
`/v1/messages`: thinking disabled, an empty tool list, one user message, and
`output_config.format` carrying `{ type: "json_schema", schema }` whose root
object has exactly one required string property (`title`) with
`additionalProperties: false`. Messages accepts `output_config.format` only in
that shape, the bounded local `single-string-object-v1` profile: a root object,
exactly one required string property, `additionalProperties: false`, and a
local 1-256 character bound (explicit integer `minLength`/`maxLength` must stay
within it). The schema is never sent upstream and no prompt is injected. Kiro
produces ordinary text; the provider buffers it, trims it, unwraps a single
Markdown code fence around the whole output, wraps it as `{"title":"..."}` (an
upstream JSON object or JSON string with the same property is normalized rather
than double-wrapped), truncates it to `maxLength`
code points, validates it locally, and only then publishes exactly one text
block containing that JSON with `stop_reason: "end_turn"`. Successful responses
carry `x-kiro-structured-output: single-string-object-v1`. `output_config.effort`
keeps working alongside `format`; every other `output_config` key (for example
`task_budget`) keeps its `unsupported_parameter` rejection, and `output_config`
inside a message keeps its `unsupported_message_field` rejection.

The profile fails closed. Any other schema shape, enabled thinking, or a forced
`tool_choice` with `format` returns `400 unsupported_structured_output`. An
upstream tool call, upstream reasoning arriving although thinking is disabled,
output over 64 KiB, or empty text that cannot satisfy the profile returns
`502 structured_output_unexpected_tool_call`,
`structured_output_unexpected_reasoning`, `structured_output_buffer_exceeded`,
or `structured_output_validation_failed` (an SSE `api_error` event once the
stream is committed). Partial text is never published before validation, and
validation failure never triggers a second inference. The profile does not
depend on `responses_fidelity_mode`, which governs only the Responses lane;
Claude Code has no other way to obtain a title.
A session whose only inputs are slash commands (for example `/model`) or prompts
under 10 characters still shows its first prompt as the title, because Claude
Code never asks for one in that case, and upgrading the provider does not rewrite
existing transcripts.

Claude Code's gateway discovery filters out model IDs without `claude` or
`anthropic`, so the GPT rows must be declared explicitly. The two Claude Opus
rows pass that filter on their own but are still declared so their `[1m]` suffix
applies rather than a discovered default window. Every declared picker row uses
`behavesAs: "claude-opus-5"` as the client-side capability template. This
exposes adaptive thinking and the left/right effort control without duplicating
each model at every effort level. The `[1m]` suffix makes Claude Code use
the advertised 1M context window; Claude strips it before sending the model
ID. The actual installed client was checked for all seven distinct 1M model IDs
it can send (`claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5`,
`claude-fable-5-1`, and the three GPT rows), both through the family alias and
through the exact ID pinned as the session model, and the small-fast row inherits
Sonnet's 1M window. A provider catalog alone does not change the client window,
and output reserves still reduce the available input budget.

The Kiro overlay also sets `autoCompactWindow: 1000000` so these gateway
models compact proactively. Claude caps it at the selected model's window
and reserves space for output and compaction. `--autocompact` and
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` remain per-launch overrides. Native settings
files and the separate Bedrock overlay are not changed.

Explicit `KIROCLAUDE_*_MODEL` overrides are preserved as supplied. Include
`[1m]` yourself when pinning a custom ID that supports the larger window.
`KIROCLAUDE_OPUS_MODEL` repoints the built-in Opus row, the named
`Claude Opus 5.5` picker row, and the default session model together, so
`KIROCLAUDE_OPUS_MODEL=claude-opus-5[1m]` restores the pre-3.6.0 default.
`KIROCLAUDE_OPUS5_MODEL` repoints only the Opus 5 picker row.
`KIROCLAUDE_HAIKU_MODEL` remains an explicit escape hatch, but its target must
accept Claude Code's required positive `max_tokens` or prompt hooks will fail.
This changes only the Kiro launcher; the separate Bedrock mode is unchanged.

Run the optional installed-client regression probe from a checkout:

```bash
bun scripts/probe-client-context.mjs --claude-bin /path/to/claude
bun scripts/probe-client-context.mjs --claude-bin /path/to/claude \
  --thresholds --cases 1m-old-threshold,1m-above
bun scripts/probe-client-context.mjs --claude-bin /path/to/claude --tool-loop
bun scripts/probe-client-context.mjs --claude-bin /path/to/claude --effort-matrix
```

It uses a loopback fake API, dummy credentials, and temporary Claude state.
The probe checks model IDs, effective windows, complete large-input delivery,
and auto-compaction events without calling a real model. Its output contains
only metadata and counts; real upstream capacity still needs a separate probe.
The tool-loop check runs two harmless `Bash` commands (`true`) and compares
the submitted prefix with the next request's history. The effort matrix checks
the wire effort and Ultracode state for every `KIROCLAUDE_EFFORT` value, a
command-line `--effort` override, and one synthetic subagent at max. Add
`--launcher /path/to/kiroclaude` to check an installed copy.

The Kiro overlay disables Claude Code 2.1.270's ephemeral batching and secondary
reminders with `CLAUDE_CODE_TOASTY_THIMBLE=0` and
`CLAUDE_CODE_GENTLE_PARASOL=0`. Those reminders disappear from later client
history. Projecting them into Kiro user text would therefore invalidate
prefix-bound Fable thinking. These are process-local compatibility settings;
validate them again with `--tool-loop` when upgrading Claude Code.

The launcher also declares `claude-code-bash-v1` client normalization and sends
a SHA-256 hash of its working directory. Both are authenticated in provider
replay records. Claude's Bash tool removes a leading literal `cd` to that same
directory before storing tool history; the gateway compares that documented
normal form while still binding the command remainder, every other argument,
the tool name/ID, tenant, model, and replay owner. The directory itself is not
sent in the header. Commands changing to another directory, expansions, and
unrecognized rewrites remain strict. A client running tools in a different
working directory must supply the corresponding context; the gateway does not
infer it from prompts.

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
`KIROCLAUDE_KIRO_FABLE_MODEL` overrides the Fable mapping without changing the
separate native Bedrock fallback.

### Use Fable 5.1 through native Bedrock

Kiro now exposes Fable 5.1 directly through both `/v1/responses` and
`/v1/messages`. Its live catalog advertises a 1M input window, 128K output,
image input, prompt caching, a 6x rate multiplier, adaptive thinking, and the
five effort levels. Inputs and outputs are subject to the retention and abuse
review notice included in Kiro's model description.

Fable uses the stateless Responses projection because Kiro's native
`CreateResponse` operation currently rejects it. Stored Responses continue to
use the provider-owned continuation and replay state rather than the native
upstream continuation id.

Messages requests with adaptive thinking use Fable's native `omitted` display
by default. Signed reasoning is still retained and replayed through the opaque
signature. An explicit `thinking.display: "summarized"` is preserved. Kiro can
return multiple independently signed summary segments; the gateway rejects
that unsupported shape rather than concatenating signatures or discarding
reasoning.

The native Bedrock fallback remains available as a separate process when Kiro
is unavailable or an AWS-native route is required:

```bash
PATH="$PWD/scripts:$PATH" kiroclaude --bedrock-fable
```

This mode uses the same shared Claude home, `model: "fable"`, max effort
passed as `--effort max`,
`AWS_PROFILE=us-claude`, `AWS_REGION=us-east-2`, and
`ANTHROPIC_DEFAULT_FABLE_MODEL=us.anthropic.claude-fable-5-1`. It does not set
the Kiro token helper or `ANTHROPIC_BASE_URL`. Override those values with
`KIROCLAUDE_AWS_PROFILE`, `KIROCLAUDE_AWS_REGION`,
`KIROCLAUDE_FABLE_MODEL`, and `KIROCLAUDE_FABLE_EFFORT`.
The process overlay clears inherited custom Anthropic, Vertex, Foundry, and
Mantle routes before enabling Bedrock; native skills and other settings remain
shared.

Changing between Kiro and Bedrock requires a new process and, when prior signed
thinking is provider-specific, a new session. Within the Kiro process, select
the built-in `fable` alias or set `KIROCLAUDE_MODEL=fable`.

## Compatibility boundary

The adapter accepts the request shapes observed from Claude Code 2.1.270:

- text, base64 images, standard tools, `tool_use`, `tool_result`, and `is_error`;
- one or more image-bearing `tool_result` blocks in a user message, with tool
  identities, status, text, and image-block order preserved;
- adjacent text blocks that form one contiguous run around an image or tool
  result;
- top-level and mid-conversation system text through the configured projection
  mode;
- adaptive thinking, `output_config.effort`, and supported Claude
  `temperature`;
- GPT effort projected to `reasoning.effort`, while Claude effort remains
  `output_config.effort`;
- encrypted replay of omitted signed thinking through opaque `kr2_` signatures (with legacy `kr1_` reads);
- removal of GPT-5.6 ellipsis-only reasoning placeholders, including split
  `"." + "." + "."` streams, with exact stored replay on continuation;
- prompt-cache markers as performance hints reported by `x-kiro-prompt-cache-mode`;
  server-auto is the default, explicit checkpoints are capability-gated, and only
  measured cache-token usage is reported;
- the lossless `clear_thinking_20251015` / `keep: "all"`
  `context_management` form, reported with `applied_edits: []`;
- Anthropic SSE ordering, stream errors, backpressure, silence-period `ping`
  events, and `x-claude-code-session-id` affinity.

Kiro tool-result content carries text/JSON only, so tool-result images are lifted
to the containing Kiro user turn. For multiple image-bearing results the wire
keeps every tool result and image in stable order, but cannot encode a per-image
tool association; the response explicitly reports this bounded loss as
`x-kiro-tool-result-image-mode: multiple-lifted` and emits a count-only audit.
Direct user images mixed with image-bearing tool results remain rejected. A real
`text → non-text → text` interleave is also rejected because Kiro exposes one
text field.

The provider also rejects destructive context edits, Structured Outputs outside
the bounded `single-string-object-v1` profile, forced tool selection, hard
serial-tool requirements, and unknown beta/tool fields with an Anthropic
`invalid_request_error`. It does not silently remove
those semantics. Prompt caching and token counting remain estimates, not native
Anthropic services.

## Troubleshooting

| Symptom                                                 | Action                                                                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Token helper reports unsafe permissions                 | Run `chmod 600 ~/.config/kiro-provider/config.json` and confirm the current user owns the file.                                       |
| `capability_rejected:context_management`                | The client requested a destructive edit outside the supported lossless form. Do not hide it with an unreviewed field-stripping proxy. |
| Kiro GPT row is absent                                  | Start through `kiroclaude`; gateway discovery alone filters out the GPT IDs.                                                          |
| Ordinary `claude` uses the wrong backend                | Check the normal `~/.claude` profile. `kiroclaude` does not modify it.                                                                |
| A resumed session reports an invalid provider signature | Start a new session after switching between Kiro and native Bedrock.                                                                  |

References: [Messages API](https://platform.claude.com/docs/en/api/messages/create),
[Claude Code settings](https://code.claude.com/docs/en/settings),
[Claude Code permissions](https://code.claude.com/docs/en/permissions),
[Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol),
and [Claude Code environment variables](https://code.claude.com/docs/en/env-vars).
