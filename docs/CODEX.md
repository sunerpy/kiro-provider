# Using kiro-provider with Codex CLI

kiro-provider exposes `POST /v1/responses`, the OpenAI Responses API wire format that [Codex CLI](https://github.com/openai/codex) speaks when a custom `model_provider` sets `wire_api = "responses"`. This lets you point Codex at your own Kiro accounts.

Verified against **codex-cli 0.144.6**.

## Isolated test config (never touches your real `~/.codex`)

If you already run Codex with real projects, do not edit `~/.codex/config.toml` to try this out. Use a throwaway `CODEX_HOME` instead: Codex reads `CODEX_HOME` to relocate its entire config/auth/log/state directory, so a temp dir gives you full isolation with zero risk to your normal setup.

```bash
export CODEX_HOME="$(mktemp -d)"        # isolated; your real ~/.codex is untouched
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
- The gateway must already be running (`kiro-provider serve`) with at least one Kiro account imported or logged in (`kiro-provider login` or `kiro-provider accounts import`); Codex has nothing to talk to otherwise.
- Any model your gateway serves works the same way as it does for `/v1/chat/completions`, including reasoning models (Claude via your configured proxy, GPT direct).

## Ready-made smoke test

`scripts/codex-smoke.sh` wraps the recipe above in a fail-closed script: it creates its own `mktemp -d` `CODEX_HOME`, verifies that directory is not `~/.codex` or a subdirectory of it before exporting anything, writes a temporary `config.toml`, and runs `codex exec` non-interactively. Run it yourself once the gateway is up and an account is imported:

```bash
bash scripts/codex-smoke.sh
```

It never writes to your real `~/.codex`.

## Endpoint reference

- `POST /v1/responses` — OpenAI Responses API. Supports streaming (typed SSE: `response.created`, `response.output_item.added`, `response.output_text.delta`, `response.output_item.done`, `response.completed`, `response.failed`, plus the reasoning-summary event family) and non-streaming JSON. Requires the same `Authorization: Bearer <api_key>` as every other route.

See the root [README](../README.md#features) for the rest of the API surface (`/v1/chat/completions`, `/v1/models`, `/health`).
