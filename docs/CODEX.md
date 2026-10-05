# Use kiro-provider V3 with Codex CLI

[简体中文](readme/CODEX.zh-CN.md) · English

**Latest focused validation:** Codex CLI 0.159.3 model/effort switching and the
real `/model` picker on 2026-10-04. Earlier automatic-title/image validation
used 0.156.1; the broader V3 smoke below used 0.154.0.

kiro-provider V3 exposes the OpenAI Responses wire API used by a Codex custom
`model_provider`.

For a persistent `kirocodex` command that leaves the native Codex home intact,
see [separate client launchers](CLIENT_LAUNCHERS.md). It includes command-backed
authentication, model-catalog context windows, Ultra, and per-account concurrency.

## Model and effort switching

The Codex `models` projection lists base IDs. Reasoning effort travels through
`supported_reasoning_levels`; standard OpenAI `data` retains legacy suffix
aliases. Fetch this catalog into a temporary file and configure
`model_catalog_json` before starting Codex. Custom providers do not automatically
replace Codex's bundled picker catalog.

Same-wire base/effort/thinking aliases share authenticated replay identity. In
default compatible mode, changing the actual wire model authenticates old
provider tokens before omitting their opaque reasoning. Visible messages and
tool call/result history remain intact. The response reports
`x-kiro-reasoning-model-replay-mode: incompatible-omitted`.
See [model-switch configuration](CONFIGURATION.md#switching-models-and-reasoning-effort)
for strict mode and bounded v3 token reads.

Use the real CLI capture gate with an **isolated** gateway, key and state:

```bash
bun scripts/probe-client-model-switch.ts --client codex \
  --codex-bin /absolute/path/to/codex \
  --base-url http://127.0.0.1:TEST_PORT \
  --provider-config /private/probe/config.json --out /private/probe/codex.json
```

The harness authenticates capture traffic, proves the selected port before
forwarding generation, loads the gateway catalog, and tests base effort,
base/suffix, suffix/base, suffix/suffix and GPT-to-Claude resumes with signed
reasoning and a completed tool turn. It emits enums/counts/verdicts, cleans up
client state, and never accepts production port 8787.

## Run with an isolated profile

Do not test against a real Codex profile. Create temporary file and SQLite state,
then point the custom provider at the local gateway:

```bash
export CODEX_TEST_ROOT="$(mktemp -d)"
export CODEX_HOME="$CODEX_TEST_ROOT/home"
export CODEX_SQLITE_HOME="$CODEX_TEST_ROOT/sqlite"
mkdir -p "$CODEX_HOME" "$CODEX_SQLITE_HOME"
export LOCALGW_KEY="sk-...your gateway api key..."

cat > "$CODEX_HOME/config.toml" <<'EOF_CONFIG'
model = "gpt-5.6-sol"
model_provider = "localgw"
model_reasoning_effort = "xhigh"

[model_providers.localgw]
name = "Local Kiro Gateway"
base_url = "http://127.0.0.1:8787/v1"
env_key = "LOCALGW_KEY"
wire_api = "responses"
EOF_CONFIG

codex exec --skip-git-repo-check "Reply with exactly: CODEX_OK"
```

The provider must already be running with at least one usable account.
Authenticated `GET /ready` must return HTTP 200 before Codex starts.

## What the V3 contract covers

The checked-in real-client gate covers a normal completed turn, successful and
failed command execution, recovery after a command failure, compaction, Ultra
reasoning, and namespace collaboration through `spawn_agent`, a child response,
and `wait`. The checked-in Codex contract also replays the current `view_image`
function-output shape: its tool association remains intact while the image bytes
are lifted into the same Kiro user turn. Captured output is also checked for
leakage of the provider's private custom/namespace aliases.

V3 selects its transport per request. Ordinary compatible requests use native
KiroRuntime Responses. Requests using Ultra/max or needing custom grammar, namespace tools,
`agent_message`, `additional_tools`, `parallel_tool_calls: false`, encrypted
reasoning, `store: false`, hosted web search, or the bounded local thread-title
output profile use the canonical stateless lane.

With `web_search_enabled` on, Codex's hosted web search is executed by the
provider. Configure Codex for live search (`web_search = "live"` in
`config.toml`, or `-c web_search=live`): the default cached mode declares
`external_web_access: false`, which the provider rejects instead of answering
from an index it does not have. Searches appear as `web_search_call` items, and
links to retrieved sources carry `url_citation` annotations. When Codex replays
the turn it keeps the call's `id`, `status` and `action.query`; the provider
restores the result the model saw from its encrypted snapshot. See
[Web search](CONFIGURATION.md#web-search).

In compatible fidelity mode, Codex automatic thread titles use the provider-local
`single-string-object-v1` profile: one required string property,
`store:false`, and a buffered stream that publishes JSON only after local
validation. This primarily covers same-shape metadata requests, for example the Codex title
thread; it is not general Structured Outputs support and does not imply native
Kiro JSON Schema enforcement. The default `responses_fidelity_mode: "compatible"`
enables this profile; `strict` rejects it before an upstream request. Conversion
is explicit in `X-Kiro-Compatibility`: visible text is trimmed, stripped of a
single Markdown code fence around the whole output, bounded to the requested
string length, wrapped as the single requested property and validated.
The provider preserves the requested schema in the Responses result and makes
at most one upstream inference dispatch for each metadata request.

Codex 0.156.1 can attach its collaboration namespace even to the automatic title
worker. Current `tools` and `additional_tools` declarations pass through the
normal validation and projection unchanged. The compatibility header then also
reports `structured_output_tool_calls_rejected`: any actual output tool call
fails before publication, including calls to a declared tool. Tool-call history,
tool results, images and continuation remain outside this metadata profile.

## Long sessions with screenshots

The gateway defaults to a 32 MiB HTTP request-body limit. This counts JSON and
inline base64 image bytes, independently of Codex's token-context percentage.
Historical screenshots can make a request too large even when a 1M model still
has substantial token capacity. Repeating the same oversized request does not
reduce its size. HTTP 413 followed by `error sending request` is an upload-limit
symptom; a `MODEL_TEMPORARILY_UNAVAILABLE` event after acceptance is a different
upstream failure.

Existing installations with an explicit 10 MiB value must update
`max_request_body_bytes` to `33554432` and restart after active work finishes.
See [request admission](CONFIGURATION.md#global-request-admission) for the shared
128 MiB budget and concurrency implications. Use a model-catalog context window
appropriate to the selected model; increasing the token window does not raise
the HTTP byte limit.

## Reproduce the smoke gate

Two bounded probes exercise the installed client against a separately started
gateway with isolated account/state copies and account maintenance disabled:

```bash
bun scripts/probe-codex-title.ts --confirm \
  --config /private/probe/kiro-provider/config.json \
  --endpoint http://127.0.0.1:18879/v1 --out /private/probe/title-evidence.json
bun scripts/probe-codex-large-body.ts --confirm-live \
  --config /private/probe/kiro-provider/config.json \
  --endpoint http://127.0.0.1:18879/v1
```

The title probe drives the TUI's own automatic worker and checks the persisted
session name after exit; it never sends a manual rename. The large-body probe
first sends synthetic historical tool images, then has the real Codex client
call `view_image` for 14 generated PNGs and verifies the subsequent request
exceeds 10 MiB and completes. Both use the gateway's Codex catalog projection
to avoid a static client fallback selecting an unavailable model. Reports contain
counts, enums and hashes. These probes send real upstream inference requests.

The smoke script builds an isolated Codex profile, capture proxy, and temporary
workspace:

```bash
CODEX_SMOKE_CODEX_BIN=/absolute/path/to/codex \
CODEX_SMOKE_EXPECTED_VERSION=0.154.0 \
KIRO_PROVIDER_SMOKE_MODE=tools \
bash scripts/codex-smoke.sh
```

The capture contains only sanitized request metadata: counts, item types, roles,
hashes, and presence flags. It is stored in an owner-only temporary directory
and deleted by the exit trap. Credentials, raw request bodies, reasoning
envelopes, and prompt text are not persisted.

## Limits

- Hosted web search is real-time only and limited to the verified model/region
  cells in [Web search](CONFIGURATION.md#web-search). KiroRuntime provides no
  OpenAI-hosted File Search, Computer Use, or hosted MCP tools.
- `background`, Responses `conversation`, arbitrary Structured Outputs/JSON
  mode, `/responses/compact`, and exact `/responses/input_tokens` are rejected.
  Only the bounded compatible-mode single-string metadata profile is locally
  enforced; tool execution/history, continuation, complex schemas, and strict fidelity remain
  fail-closed.
- `parallel_tool_calls: false` is accepted for Codex compatibility, but Kiro
  cannot guarantee strictly serial tool execution.
- Image-valued tool results require an inline data URL and at most one image
  block per result; remote image URLs remain rejected.
- `store: false` disables the provider's local response mirror; it is not an AWS
  Zero Data Retention guarantee.

For the complete wire contract, see [V3 protocol compatibility](PROTOCOL_COMPATIBILITY.md).
The dated [initial V3 validation](audits/kiro-provider-v3-openai-responses-validation-2026-09-05.md)
and [replay/compaction validation](audits/responses-replay-delivery-2026-09-14.zh.md)
record the corresponding evidence.
