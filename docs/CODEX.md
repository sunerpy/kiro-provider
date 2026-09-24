# Use kiro-provider V3 with Codex CLI

[简体中文](readme/CODEX.zh-CN.md) · English

**Latest local validation:** Codex CLI 0.156.1 automatic titles and large image
history on 2026-09-23; the broader V3 smoke below was checked with 0.154.0.

kiro-provider V3 exposes the OpenAI Responses wire API used by a Codex custom
`model_provider`.

For a persistent `kirocodex` command that leaves the native Codex home intact,
see [separate client launchers](CLIENT_LAUNCHERS.md). It includes command-backed
authentication, model-catalog context windows, Ultra, and per-account concurrency.

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
reasoning, `store: false`, or the bounded local thread-title output profile use
the canonical stateless lane.

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

- KiroRuntime does not provide OpenAI-hosted Web Search, File Search, Computer
  Use, or hosted MCP tools.
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
