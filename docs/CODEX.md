# Using kiro-provider with Codex CLI

kiro-provider exposes `POST /v1/responses`, which is the wire API used by a
Codex custom `model_provider` when `wire_api = "responses"` is selected.

## Current v0.5.0-rc.2 status

The compiled-service gate on 2026-08-27 used Codex CLI
**0.149.0-alpha.4.1** with only a standard base URL, API key, and model. The
first field-level rejection before Kiro was:

```json
{"text":{"verbosity":"low"}}
```

`text.verbosity` has no proven Kiro equivalent, so the provider returns HTTP
400 with `unsupported_parameter` and `param: "text.verbosity"`. It does not
ignore the field or simulate it with prompt text. Therefore this Codex version
is **not an accepted v0.5 stable client yet**, and the historical v0.4 success
record must not be read as a current RC pass.

The redacted captured request also contains `reasoning.context`,
`parallel_tool_calls: false` while callable `additional_tools` are active, and
custom grammar/namespace semantics. Each remains a distinct capability
boundary; the provider does not strip them to force a successful request.

When a future Codex request stays within the verified subset, the Responses
adapter supports exact function/custom declarations and results, encrypted
reasoning replay, and standard-field account/Kiro-conversation affinity.
Namespace identity, custom grammar constraints, hosted Web Search, stateful
Responses, and serial-only execution with callable tools remain explicit
capability errors.

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

For Codex 0.149.0-alpha.4.1, the expected RC.2 result is a non-zero exit with
`unsupported_parameter` at `text.verbosity`. A supported future request shape
must then pass a real shell/custom-tool round trip, continuation, and reasoning
replay across a provider restart before Codex can be marked supported.

The gateway must already be running. In the default shared-auth mode, first
authenticate Kiro with `opencode auth login` and require authenticated
`GET /ready` to return 200. No private header or request-rewrite proxy is part
of the acceptance contract.

See the current evidence in
[`audits/kiro-provider-v0.5.0-rc.2-validation-2026-08-27.md`](audits/kiro-provider-v0.5.0-rc.2-validation-2026-08-27.md).
The older [`E2E_VALIDATION_2026-08-22.md`](E2E_VALIDATION_2026-08-22.md) is a
historical v0.4 record only.
