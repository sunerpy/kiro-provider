# Using kiro-provider with Codex CLI

kiro-provider exposes `POST /v1/responses`, which is the wire API used by a
Codex custom `model_provider` when `wire_api = "responses"` is selected.

## Current v0.5.0-rc.1 status

The compiled-service gate on 2026-08-26 used Codex CLI
**0.149.0-alpha.4.1** with only a standard base URL, API key, and model. The
request was rejected before Kiro because Codex sent:

```json
{"parallel_tool_calls": false}
```

Kiro has no native control that guarantees serial-only tool execution, so safe
mode returns HTTP 400 with `unsupported_parallel_tool_calls` and
`param: "parallel_tool_calls"`. The provider does not ignore this field or
simulate it with prompt text. Therefore this Codex version is **not an accepted
v0.5 stable client yet**, and the historical v0.4 success record must not be
read as a current RC pass.

When a future Codex request stays within the verified subset, the Responses
adapter supports exact function/custom declarations and results, encrypted
reasoning replay, and standard-field account/Kiro-conversation affinity.
Namespace identity, custom grammar constraints, hosted Web Search, stateful
Responses, and `parallel_tool_calls: false` remain explicit capability errors.

## Isolated compatibility probe

Do not edit a real `~/.codex` configuration. Use isolated file and SQLite
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

[model_providers.localgw]
name = "Local Gateway"
base_url = "http://127.0.0.1:8787/v1"
env_key = "LOCALGW_KEY"
wire_api = "responses"
EOF
codex exec --skip-git-repo-check "Reply with exactly: CODEX_OK"
```

For Codex 0.149.0-alpha.4.1, the expected RC result is a non-zero exit with
`unsupported_parallel_tool_calls`. A successful future run must then be
extended to a real shell/custom-tool round trip, continuation, and reasoning
replay across a provider restart before Codex can be marked supported.

The gateway must already be running. In the default shared-auth mode, first
authenticate Kiro with `opencode auth login` and require authenticated
`GET /ready` to return 200. No private header or request-rewrite proxy is part
of the acceptance contract.

See the current evidence in
[`audits/kiro-provider-v0.5.0-rc.1-validation-2026-08-26.md`](audits/kiro-provider-v0.5.0-rc.1-validation-2026-08-26.md).
The older [`E2E_VALIDATION_2026-08-22.md`](E2E_VALIDATION_2026-08-22.md) is a
historical v0.4 record only.
