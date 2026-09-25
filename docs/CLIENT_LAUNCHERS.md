# Separate Kiro launchers for Claude Code and Codex

[简体中文](readme/CLIENT_LAUNCHERS.zh-CN.md) · English

These Linux/macOS/WSL examples keep the ordinary `claude` and `codex` commands
and their user configuration directories available. They require a running
kiro-provider, Python 3, Claude Code 2.1.270 or Codex 0.154.0, and a checkout
matching the provider version. Other client versions need their own validation.

There are two different kinds of separation. The repository's `kiroclaude`
uses a process-local settings overlay and **shares native Claude state by
default**. A personal `kirocodex` that sets `-c model_provider=...` while using
`~/.codex` likewise shares settings, history, skills, plugins, and memory.
Neither launcher writes a provider setting at startup, but normal client
actions can still write shared state. The examples below use separate homes.
Project instructions and administrator policy still apply; a separate home
is not an operating-system sandbox.

## Install the helpers

From the matching checkout, install the versioned helpers without renaming
the native clients:

```sh
mkdir -p "$HOME/.local/bin"
install -d -m 700 "$HOME/.local/libexec/kiro-provider"
install -m 755 scripts/kiroclaude scripts/kiroclaude-token \
  "$HOME/.local/libexec/kiro-provider/"
```

The token helper reads the provider's owner-only `config.json`. No API key is
embedded in these wrappers or exported to tool subprocesses. The release binary
installer does not install these helpers. The following setup uses `set -C`
to refuse existing files; merge an existing custom launcher/config manually.

## Create an isolated `kiroclaude`

```sh
(
  umask 077
  set -C
  cat > "$HOME/.local/bin/kiroclaude" <<'SH'
#!/bin/sh
set -eu
umask 077
export KIROCLAUDE_CONFIG_DIR="${KIROCLAUDE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kiroclaude}"
mkdir -p "$KIROCLAUDE_CONFIG_DIR"
exec "$HOME/.local/libexec/kiro-provider/kiroclaude" "$@"
SH
)
chmod 755 "$HOME/.local/bin/kiroclaude"
```

Run it by its absolute path or put `~/.local/bin` on `PATH`:

```sh
kiroclaude
kiroclaude --model fable
KIROCLAUDE_MODEL=sonnet KIROCLAUDE_EFFORT=high kiroclaude
```

The launcher already maps the verified Opus 5.5, Opus 5, Sonnet, Fable, Sol,
Terra, and Luna defaults to `[1m]` and sets `autoCompactWindow: 1000000`. Claude
removes `[1m]` before sending the model ID. Opus 5.5 is both the built-in Opus
row's target and a named `Claude Opus 5.5` picker row, and it is the default
session model; the small-fast row maps to Sonnet 5, so it inherits that 1M
window. Explicit custom model pins are preserved. Ultra is the default; it sends
`xhigh` in the validated Claude version. The launcher also supplies the
compatibility settings needed for stable Fable thinking and Bash history replay.
Keep these settings when writing another wrapper around it.

The gateway root is `http://127.0.0.1:8787`, **without `/v1`**. Override it
with `KIROCLAUDE_BASE_URL`; use `KIROCLAUDE_PROVIDER_CONFIG` if its credential
file is elsewhere. Permissions keep the client's defaults. See the
[Claude Code guide](CLAUDE_CODE.md) for the exact model and permission controls.

## Create an isolated `kirocodex`

Create a persistent configuration under a dedicated home:

```sh
(
  umask 077
  kiro_codex_state="${KIROCODEX_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/kirocodex}"
  mkdir -p "$kiro_codex_state/sqlite"
  set -C
  cat > "$kiro_codex_state/config.toml" <<'TOML'
model = "gpt-5.6-sol"
model_provider = "kiro"
model_reasoning_effort = "ultra"
web_search = "disabled"

[model_providers.kiro]
name = "Kiro Provider"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
supports_websockets = false

[model_providers.kiro.auth]
command = "sh"
args = ["-c", 'exec "$HOME/.local/libexec/kiro-provider/kiroclaude-token"']
timeout_ms = 5000
refresh_interval_ms = 300000
TOML
  cat > "$HOME/.local/bin/kirocodex" <<'SH'
#!/bin/sh
set -eu
umask 077
export CODEX_HOME="${KIROCODEX_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/kirocodex}"
export CODEX_SQLITE_HOME="${KIROCODEX_SQLITE_HOME:-$CODEX_HOME/sqlite}"
export KIRO_PROVIDER_CONFIG="${KIROCODEX_PROVIDER_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json}"
mkdir -p "$CODEX_SQLITE_HOME"
exec codex "$@"
SH
)
chmod 755 "$HOME/.local/bin/kirocodex"
```

```sh
kirocodex
kirocodex exec --skip-git-repo-check "Reply with exactly: KIROCODEX_OK"
```

Provider configuration belongs in this dedicated user-level `config.toml`,
not a project's `.codex/config.toml`. The wrapper sets the home variables only
for its child process; do not globally export them or replace the native
`codex` command with an alias.

Codex reads the gateway's model catalog, including its context and reasoning
capabilities. The validated online Sol catalog declares 1M; Codex 0.154.0
uses a 950,000-token effective budget. Its conservative static fallback can
be smaller.

On a fresh Codex 0.156.1 home, check the selected model before submitting a turn:
the client's static migration prompt can otherwise switch to a model absent from
the gateway catalog. A `model_catalog_json` file containing the gateway's
`{"models": [...]}` projection pins discovery to that provider. Both real-client
probes in the [Codex guide](CODEX.md#reproduce-the-smoke-gate) do this automatically.

For a verified 1M model, the context override is:

```sh
kirocodex --model gpt-5.6-sol -c model_context_window=1000000
```

The gateway's 32 MiB HTTP body limit is independent of this token window. Inline
screenshots still count toward request bytes; existing explicit 10 MiB configs
need the migration described in the [Codex guide](CODEX.md#long-sessions-with-screenshots).

Do not carry that override to a smaller model. Ultra is a client orchestration
preset that sends inference effort `max`, not a Kiro model alias or a wire
effort named `ultra`. This example leaves permissions at the native client's
defaults and disables unavailable hosted Web Search. See the
[Codex guide](CODEX.md) and the
[official Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
for
custom-provider authentication and `CODEX_HOME` behavior.

## Protocols and parallel tasks

`kiroclaude` uses Anthropic-compatible Messages; `kirocodex` uses OpenAI
Responses. These are the native **client protocols**. The Kiro upstream
transport is selected separately by `v3-auto`: lossless supported Responses
shapes can use KiroRuntime native Responses, while Ultra/max, `store: false`,
namespace collaboration, and other incompatible shapes use the canonical
stateless lane. Neither launcher routes through legacy Chat Completions or
forces unsupported native requests.

The provider defaults to ten inference slots per account
(`account_inference_concurrency`, configurable 1–10). Independent branches
can use the same or different eligible accounts; one stateful branch remains
ordered. Leave Claude's session/agent identity headers to Claude itself.
Client agent-count limits and the provider's account slots are separate.

A new home does not inherit the old home's history or client-local plugins.
Configure the desired extensions there; linking the entire home back to the
native directory restores shared state. Start new sessions when crossing
providers whose signed reasoning cannot be replayed. A 1M client window is not
proof that every model completes every 1M input; see the
[measured limits and acceptance results](audits/agent-workflow-validation-2026-09-17.zh.md).
