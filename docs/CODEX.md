# Use kiro-provider V3 with Codex CLI

[简体中文](readme/CODEX.zh-CN.md) · English

**Last checked-in validation:** Codex CLI 0.154.0 on 2026-09-14.

kiro-provider V3 exposes the OpenAI Responses wire API used by a Codex custom
`model_provider`.

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
and `wait`. Captured output is also checked for leakage of the provider's private
custom/namespace aliases.

V3 selects its transport per request. Ordinary compatible requests use native
KiroRuntime Responses. Requests that need custom grammar, namespace tools,
`agent_message`, `additional_tools`, `parallel_tool_calls: false`, encrypted
reasoning, or `store: false` use the canonical stateless lane.

## Reproduce the smoke gate

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
- `background`, Responses `conversation`, Structured Outputs,
  `/responses/compact`, and exact `/responses/input_tokens` are rejected.
- `parallel_tool_calls: false` is accepted for Codex compatibility, but Kiro
  cannot guarantee strictly serial tool execution.
- `store: false` disables the provider's local response mirror; it is not an AWS
  Zero Data Retention guarantee.

For the complete wire contract, see [V3 protocol compatibility](PROTOCOL_COMPATIBILITY.md).
The dated [initial V3 validation](audits/kiro-provider-v3-openai-responses-validation-2026-09-05.md)
and [replay/compaction validation](audits/responses-replay-delivery-2026-09-14.zh.md)
record the corresponding evidence.
