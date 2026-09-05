# Using kiro-provider V3 with Codex CLI

> **Date**: 2026-09-05 · **Validated client**: Codex CLI 0.153.0

kiro-provider V3 exposes the OpenAI Responses wire API expected by a Codex
custom `model_provider`.

## Supported V3 contract

The compiled V3 candidate passed an isolated real-client gate covering:

- a normal `response.completed` turn;
- custom command execution with the exact side effect;
- a failed command followed by successful recovery;
- namespace collaboration through `spawn_agent`, a child response, and
  `wait`;
- no leakage of the provider's private custom/namespace aliases.

Codex request shapes that require custom grammar, namespace tools,
`agent_message`, `additional_tools`, `parallel_tool_calls: false`, encrypted
reasoning, or `store: false` automatically use V3's stateless compatibility
lane. Ordinary requests use native KiroRuntime Responses.

## Configuration

Do not modify a real Codex profile while testing. Use isolated file and SQLite
state:

```bash
export CODEX_TEST_ROOT="$(mktemp -d)"
export CODEX_HOME="$CODEX_TEST_ROOT/home"
export CODEX_SQLITE_HOME="$CODEX_TEST_ROOT/sqlite"
mkdir -p "$CODEX_HOME" "$CODEX_SQLITE_HOME"
export LOCALGW_KEY="sk-...your gateway api key..."

cat > "$CODEX_HOME/config.toml" <<'EOF'
model = "gpt-5.6-sol"
model_provider = "localgw"
model_reasoning_effort = "xhigh"

[model_providers.localgw]
name = "Local Kiro Gateway"
base_url = "http://127.0.0.1:8787/v1"
env_key = "LOCALGW_KEY"
wire_api = "responses"
EOF

codex exec --skip-git-repo-check "Reply with exactly: CODEX_OK"
```

The gateway must already be running with a populated provider-owned account
store. Require authenticated `GET /ready` to return HTTP 200 before starting
the client.

## Reproducible smoke gate

The repository smoke script creates isolated Codex state, an isolated capture
proxy, and a temporary workspace:

```bash
CODEX_SMOKE_CODEX_BIN=/absolute/path/to/codex \
CODEX_SMOKE_EXPECTED_VERSION=0.153.0 \
KIRO_PROVIDER_SMOKE_MODE=tools \
bash scripts/codex-smoke.sh
```

The capture contains request bodies only in an owner-only temporary directory
and is deleted by the exit trap. Failure diagnostics print only item types,
roles, tool names, and presence flags—never credentials, raw reasoning
envelopes, or prompt text.

## Remaining boundaries

- OpenAI hosted Web Search, File Search, Computer Use, and hosted MCP tools are
  not provided by KiroRuntime.
- `background`, Responses `conversation`, Structured Outputs,
  `/responses/compact`, and exact `/responses/input_tokens` are explicitly
  unsupported.
- `parallel_tool_calls: false` is accepted for Codex compatibility, but Kiro
  does not provide a hard serial-tool guarantee.
- `store: false` prevents local response mirroring; it is not an AWS Zero Data
  Retention guarantee.

See [V3 protocol compatibility](PROTOCOL_COMPATIBILITY.md) and
[V3 validation evidence](audits/kiro-provider-v3-openai-responses-validation-2026-09-05.md).
