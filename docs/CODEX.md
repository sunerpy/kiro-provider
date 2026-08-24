# Using kiro-provider with Codex CLI

kiro-provider exposes `POST /v1/responses`, the OpenAI Responses API wire format that [Codex CLI](https://github.com/openai/codex) speaks when a custom `model_provider` sets `wire_api = "responses"`. This lets you point Codex at your own Kiro accounts.

Verified end-to-end against **codex-cli 0.149.0-alpha.4.1** on 2026-08-22,
including a real shell-tool round trip.

## Supported scope

- ✅ Chat, reasoning, standard `function` tools, Codex's built-in `exec` / `apply_patch` tools (`custom`), and multi-agent `collaboration` tools (`namespace`) are supported.
- `custom` and namespace children are translated to request-local JSON-schema function aliases for Kiro, then restored to `custom_tool_call` or namespaced `function_call` items before Codex sees them. Internal aliases are never part of a successful Responses result.
- Tool calls and outputs are matched by `call_id`; streaming and non-streaming responses use the same all-or-nothing restoration path.
- Codex may advertise OpenAI-hosted tools such as `web_search` even when the
  requested task only needs local tools. Those declarations are accepted for
  wire compatibility but are not exposed to Kiro, because this provider
  cannot execute OpenAI-hosted tools. They are never emulated with hidden
  prompt text.

OpenAI custom-tool grammars have one explicit limitation: Kiro does not
provide token-level CFG constrained decoding. kiro-provider bridges a custom
tool structurally as one string input and restores the raw call for Codex; it
does not paste the grammar into a tool description or hidden prompt. Grammar
enforcement therefore remains on the Codex side.

Codex does not need any private session header. Its normal Responses
`client_metadata` / `prompt_cache_key` fields drive a persisted account and
Kiro `conversationId` binding, and the selected account's keep-alive pool is
reused across access-token refreshes. This is best-effort physical connection
reuse, not a promise that every turn uses one TCP socket.

`previous_response_id` and `conversation` require a real server-side response
state store. They currently return `unsupported_stateful_responses`; Codex
turns must carry the complete input history.

## Isolated test config (never touches your real `~/.codex`)

If you already run Codex with real projects, do not edit `~/.codex/config.toml` to try this out. Use separate throwaway `CODEX_HOME` and `CODEX_SQLITE_HOME` directories instead. This isolates both file-based config/auth/log state and Codex's SQLite state from your normal setup.

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
codex exec --skip-git-repo-check "say hi"
```

Notes:

- `base_url` matches kiro-provider's default `host`/`port` (`127.0.0.1:8787`); adjust if your `serve` command uses different values.
- `LOCALGW_KEY` must be one of the keys in your kiro-provider `config.json` `api_keys` list.
- `wire_api = "responses"` is required. kiro-provider's Chat Completions endpoint (`/v1/chat/completions`) does not implement the Responses wire format, and Codex only speaks Responses for custom providers.
- The gateway must already be running (`kiro-provider serve`). In the default
  shared mode, authenticate Kiro with `opencode auth login`; the authenticated
  `/ready` endpoint must return 200. Local login/import applies only when
  `auth_source: "local"` is selected.

## Ready-made smoke test

`scripts/codex-smoke.sh` wraps the recipe above in a fail-closed script: it creates distinct `CODEX_HOME` and `CODEX_SQLITE_HOME` directories under one `mktemp -d`, rejects either path if it resolves inside protected Codex state, writes a temporary `config.toml`, and runs `codex exec` non-interactively. The default `Reply with exactly: OK` turn proves connectivity and reasoning only:

```bash
bash scripts/codex-smoke.sh
```

Run the explicit tool probe to exercise a successful custom command, recovery from a failed custom command, and a namespace collaboration call:

```bash
KIRO_PROVIDER_SMOKE_MODE=tools bash scripts/codex-smoke.sh
```

The tool probe verifies Codex's JSON events and deterministic side effects. It also runs a headers-free loopback request-body capture to prove the public namespace call/output pair, directed child task, child answer, and completed wait, while rejecting leaked `kiro_custom_*` / `kiro_ns_*` aliases. Every turn is bounded to 120 seconds. Tool selection is still model-driven, so a model that refuses a required tool makes the probe fail rather than producing a false pass. Neither mode writes to your real Codex home or SQLite state.

## Endpoint reference

- `POST /v1/responses` — OpenAI Responses API. Supports streaming (typed SSE: `response.created`, `response.output_item.added`, `response.output_text.delta`, `response.output_item.done`, `response.completed`, `response.failed`, plus the reasoning-summary event family) and non-streaming JSON. Requires the same `Authorization: Bearer <api_key>` as every other route.

See the root [README](../README.md#features) for the rest of the API surface
(`/v1/messages`, explicitly enabled `/v1/chat/completions`, `/v1/models`, and
`/health`). The exact real-client evidence is recorded in
[`E2E_VALIDATION_2026-08-22.md`](E2E_VALIDATION_2026-08-22.md).
