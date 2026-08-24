# kiro-provider

> A standalone OpenAI Responses and Anthropic Messages gateway for AWS Kiro (CodeWhisperer).

[![CI](https://github.com/sunerpy/kiro-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/sunerpy/kiro-provider/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/sunerpy/kiro-provider/branch/main/graph/badge.svg)](https://codecov.io/gh/sunerpy/kiro-provider)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-bun-black)](https://bun.sh/)

[简体中文](docs/readme/README.zh.md) · English

## Table of Contents

- [Features](#features)
- [Install](#install)
- [Quickstart](#quickstart)
- [Run as a background service](#run-as-a-background-service)
- [Configuration](#configuration)
- [Proxy](#proxy)
- [Security](#security)
- [Using with an LLM](#using-with-an-llm)
- [Use with Codex CLI](#use-with-codex-cli)
- [Use with Claude Code](#use-with-claude-code)
- [Development](#development)
- [License](#license)

## Features

- OpenAI Responses `POST /v1/responses` and Anthropic Messages `POST /v1/messages` (both streaming and non-streaming), plus `POST /v1/messages/count_tokens`, `GET /v1/models`, `GET /health`, and authenticated `GET /ready`.
- Legacy OpenAI Chat Completions is available at `POST /v1/chat/completions`, but is disabled by default and must be explicitly enabled with `enable_legacy_chat_completions`.
- Bearer API-key gate that fails closed: the server refuses to start with no configured keys, and defaults to binding `127.0.0.1`.
- Live OpenCode authentication reuse by default: `auth_source: "opencode-shared"` reads the same `~/.config/opencode/kiro.db`, honors tombstones, updates shared health/usage, and uses a refresh lock compatible with `opencode-kiro-auth` v0.20.6.
- Standard-field session affinity: Codex/OpenAI, OpenCode, and Claude Code requests reuse a persisted account binding and Kiro conversation ID without private headers, cookies, or client patches.
- Account-scoped scheduling and keep-alive transport pools: unrelated accounts can run concurrently, while one account is protected from overlapping Kiro streams; access-token refresh updates the cached client instead of rebuilding its connection pool.
- Zero provider-owned prompt injection: request adapters preserve client text and structured protocol fields, and reject unsupported guarantees instead of emulating them with hidden instructions.
- Multi-account rotation with automatic token refresh and failover. Shared mode treats OpenCode's database as the authentication authority; the provider database stores session affinity only.
- An explicit `auth_source: "local"` compatibility mode retains `kiro-provider login` and `accounts import`; imported accounts are snapshots and must not be confused with live shared authentication.
- A single global `proxy_url` that, when set, routes all upstream egress (model requests, token refresh, device-code login) through one HTTP(S) proxy.
- Ships as a self-contained compiled binary via `bun build --compile` — no runtime install required on the target machine.

## Install

Pick one of three channels.

### 1. bunx / bun (fastest, requires Bun)

kiro-provider ships an npm package built on Bun-only APIs (`bun:sqlite`, `Bun.serve`), so it runs under **Bun or `bunx`, not `npx` or plain `node`**. Install [Bun](https://bun.sh/) first, then:

```bash
bunx @sunerpy/kiro-provider serve --help
```

Or install it globally:

```bash
bun add -g @sunerpy/kiro-provider
kiro-provider --help
```

### 2. Prebuilt binary (no dependencies)

Every release publishes standalone binaries for `linux` (x64, arm64), `darwin` (x64, arm64), and `windows` (x64). Download the one for your platform from [Releases](https://github.com/sunerpy/kiro-provider/releases/latest), `chmod +x` it, and run it directly. No Bun or Node.js needed at runtime.

One-line install (Linux/macOS):

```bash
curl -fsSL https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.ps1 | iex
```

Both scripts pull the matching asset from `releases/latest/download/` and install it to `~/.local/bin` (override with `KIRO_PROVIDER_INSTALL_DIR`).

### 3. From source (developers)

Requires [Bun](https://bun.sh/).

```bash
git clone https://github.com/sunerpy/kiro-provider.git
cd kiro-provider
bun install
bun run build:binary
./dist/kiro-provider --help
```

Or run without compiling:

```bash
bun install
bun run src/cli/bin.ts --help
```

In the rest of this README, `./dist/kiro-provider` refers to any of the above; substitute `bunx @sunerpy/kiro-provider`, your installed binary path, or `bun run src/cli/bin.ts` depending on which channel you used.

## Quickstart

1. **Authenticate Kiro through OpenCode.** The default shared-auth mode uses
   OpenCode's live account database:

   ```bash
   opencode auth login
   ```

   Select Kiro and complete the normal login flow. If you intentionally want
   an independent compatibility store instead, set `"auth_source": "local"`
   and then use:

   ```bash
   ./dist/kiro-provider login
   # or take a one-time snapshot:
   ./dist/kiro-provider accounts import
   ```

2. **Create a config with your own API key.**

   ```bash
   mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider"
   cp config.example.json "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json"
   # edit config.json and replace "sk-REPLACE-ME" with a private, random key
   ```

3. **Start the gateway.**

   ```bash
   ./dist/kiro-provider serve
   ```

4. **Call the default Responses endpoint.**

   ```bash
   curl -fsS http://127.0.0.1:8787/v1/models \
     -H 'Authorization: Bearer sk-your-private-key'
   ```

   ```ts
   import OpenAI from "openai";

   const client = new OpenAI({
     baseURL: "http://127.0.0.1:8787/v1",
     apiKey: "sk-your-private-key",
   });

   const response = await client.responses.create({
     model: "auto",
     input: "Explain this repository.",
   });

   console.log(response.output_text);
   ```

   OpenAI-compatible libraries that only implement Chat Completions require
   `"enable_legacy_chat_completions": true` in the gateway config. For example,
   with the [Vercel AI SDK](https://sdk.vercel.ai/) via
   `@ai-sdk/openai-compatible`:

   ```ts
   import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
   import { generateText } from "ai";

   const kiro = createOpenAICompatible({
     name: "kiro-provider",
     baseURL: "http://127.0.0.1:8787/v1",
     apiKey: "sk-your-private-key",
   });

   const { text } = await generateText({
     model: kiro("auto"),
     prompt: "Explain this repository.",
   });
   ```

## Run as a background service

For an agent host, run **one long-lived provider per OS user** and point
Codex, OpenCode, Claude Code, Zuno, and other clients at that local endpoint.
Do not start a new provider for every agent or conversation. Keeping one
process alive lets those standard clients share the provider's persisted
session/account affinity and its process-local, account-scoped keep-alive
pools. This remains best-effort connection reuse, not a promise that every
request uses one physical TCP connection.

Use a pinned standalone binary for a service rather than fetching through
`bunx` on every start. The examples below assume the release installers'
defaults:

- binary: `~/.local/bin/kiro-provider` on Linux,
  `%USERPROFILE%\.local\bin\kiro-provider.exe` on Windows;
- config: `~/.config/kiro-provider/config.json`;
- service/task name: `kiro-provider`.

Run the service as the **same OS user** that ran `opencode auth login`.
Default `auth_source: "opencode-shared"` resolves that user's OpenCode
database and home/XDG directories; running as `root`, `LocalSystem`, or
another user will normally select different credentials. Use absolute paths,
keep the API key in the protected config file rather than service arguments,
and set `opencode_auth_db_path` explicitly if the service has a different XDG
environment.

### Linux: systemd user service

Verify the installed binary and config first:

```bash
test -x "$HOME/.local/bin/kiro-provider"
test -r "$HOME/.config/kiro-provider/config.json"
chmod 600 "$HOME/.config/kiro-provider/config.json"
```

Install a [systemd user service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html):

```bash
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
install -d -m 700 "$SERVICE_DIR"
cat > "$SERVICE_DIR/kiro-provider.service" <<'EOF'
[Unit]
Description=kiro-provider local Kiro gateway

[Service]
Type=exec
ExecStart=%h/.local/bin/kiro-provider serve --config %h/.config/kiro-provider/config.json
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
UMask=0077

[Install]
WantedBy=default.target
EOF
chmod 600 "$SERVICE_DIR/kiro-provider.service"

systemctl --user daemon-reload
systemctl --user enable --now kiro-provider.service
```

If the binary or config is elsewhere, replace `ExecStart` with those absolute
paths. For a custom `XDG_CONFIG_HOME`, also add an explicit
`Environment=XDG_CONFIG_HOME=/absolute/path` line or configure
`opencode_auth_db_path`.

Operate and inspect the service:

```bash
systemctl --user is-active kiro-provider.service
systemctl --user restart kiro-provider.service
journalctl --user -u kiro-provider.service -n 100 --no-pager
```

User services normally start with that user's service manager. If the
provider must start at boot and remain after logout, an administrator may
enable lingering with `loginctl enable-linger <user>` after reviewing the
machine's security policy.

To remove the unit:

```bash
systemctl --user disable --now kiro-provider.service
rm "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/kiro-provider.service"
systemctl --user daemon-reload
```

### Windows: per-user scheduled task

`kiro-provider.exe` is a normal foreground executable, not a native Windows
Service Control Manager executable. Do not register it directly with
`sc.exe`. The built-in, dependency-free option is a
[Scheduled Task](https://learn.microsoft.com/powershell/module/scheduledtasks/register-scheduledtask)
that starts at sign-in, runs as the current user, and restarts after failure.

Run the following in PowerShell as the same user that owns the OpenCode
credentials. It creates a small launcher so stdout/stderr are retained under
`%LOCALAPPDATA%\kiro-provider`:

```powershell
$Binary = Join-Path $HOME ".local\bin\kiro-provider.exe"
$Config = Join-Path $HOME ".config\kiro-provider\config.json"
$ServiceDir = Join-Path $HOME ".config\kiro-provider"
$LogDir = Join-Path $env:LOCALAPPDATA "kiro-provider"
$Launcher = Join-Path $ServiceDir "service.ps1"

if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) {
  throw "kiro-provider binary not found: $Binary"
}
if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) {
  throw "kiro-provider config not found: $Config"
}

New-Item -ItemType Directory -Force -Path $ServiceDir, $LogDir | Out-Null
@'
$ErrorActionPreference = "Stop"
$Binary = Join-Path $HOME ".local\bin\kiro-provider.exe"
$Config = Join-Path $HOME ".config\kiro-provider\config.json"
$LogDir = Join-Path $env:LOCALAPPDATA "kiro-provider"
$Log = Join-Path $LogDir "service.log"
$PreviousLog = Join-Path $LogDir "service.previous.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
if ((Test-Path -LiteralPath $Log) -and ((Get-Item -LiteralPath $Log).Length -gt 10MB)) {
  Move-Item -Force -LiteralPath $Log -Destination $PreviousLog
}

& $Binary serve --config $Config *>> $Log
exit $LASTEXITCODE
'@ | Set-Content -LiteralPath $Launcher -Encoding UTF8

$User = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$PowerShell = (Get-Command powershell.exe).Source
$Action = New-ScheduledTaskAction `
  -Execute $PowerShell `
  -Argument ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $Launcher)
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
$Principal = New-ScheduledTaskPrincipal `
  -UserId $User `
  -LogonType Interactive `
  -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable

Stop-ScheduledTask -TaskName "kiro-provider" -ErrorAction SilentlyContinue
Register-ScheduledTask `
  -TaskName "kiro-provider" `
  -Action $Action `
  -Trigger $Trigger `
  -Principal $Principal `
  -Settings $Settings `
  -Description "Local AWS Kiro gateway for AI agents" `
  -Force | Out-Null
Start-ScheduledTask -TaskName "kiro-provider"
```

Inspect, restart, and follow logs:

```powershell
Get-ScheduledTask -TaskName "kiro-provider" | Get-ScheduledTaskInfo
Stop-ScheduledTask -TaskName "kiro-provider"
Start-ScheduledTask -TaskName "kiro-provider"
Get-Content "$env:LOCALAPPDATA\kiro-provider\service.log" -Tail 100 -Wait
```

To remove the task and launcher:

```powershell
Stop-ScheduledTask -TaskName "kiro-provider" -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "kiro-provider" -Confirm:$false
Remove-Item "$HOME\.config\kiro-provider\service.ps1"
```

This task intentionally runs only in the current user's interactive session,
so it can use that user's network access and OpenCode credentials without
storing a Windows password. A true pre-login Windows service requires a
service wrapper and a deliberately configured user account; do not run it as
`LocalSystem` and expect the same OpenCode database.

### Health checks and automation contract

After either installation, verify both process liveness and authenticated
readiness:

```bash
curl -fsS http://127.0.0.1:8787/health
curl -fsS http://127.0.0.1:8787/ready \
  -H 'Authorization: Bearer sk-your-private-key'
```

PowerShell equivalent:

```powershell
Invoke-RestMethod "http://127.0.0.1:8787/health"
$Headers = @{ Authorization = "Bearer sk-your-private-key" }
Invoke-RestMethod "http://127.0.0.1:8787/ready" -Headers $Headers
```

For an AI agent or installer, treat setup as successful only when:

1. the binary and explicit config path exist;
2. the service/task runs as the credential-owning user;
3. `/health` succeeds;
4. authenticated `/ready` succeeds, proving a readable auth source and at
   least one active account.

Use the fixed service/task name above so repeated setup is idempotent. Restart
it after changing the config or replacing the binary. Do not make the client
responsible for starting a private provider process; configure clients only
with the stable base URL and gateway API key.

## Configuration

Config is loaded from `~/.config/kiro-provider/config.json` (or `$XDG_CONFIG_HOME/kiro-provider/config.json`), overridable by `KIRO_PROVIDER_*` environment variables and, for `serve`, by CLI flags. Precedence is **CLI flag > environment variable > config file > schema default**.

| Field | Default | Env var |
| --- | --- | --- |
| `host` | `127.0.0.1` | `KIRO_PROVIDER_HOST` |
| `port` | `8787` | `KIRO_PROVIDER_PORT` |
| `api_keys` | required, non-empty | `KIRO_PROVIDER_API_KEYS` |
| `enable_legacy_chat_completions` | `false` | `KIRO_PROVIDER_ENABLE_LEGACY_CHAT_COMPLETIONS` |
| `auth_source` | `opencode-shared` | `KIRO_PROVIDER_AUTH_SOURCE` |
| `opencode_auth_db_path` | `null` (uses the OpenCode default) | `KIRO_PROVIDER_OPENCODE_AUTH_DB_PATH` |
| `proxy_url` | `null` | `KIRO_PROVIDER_PROXY_URL` |
| `default_region` | `us-east-1` | `KIRO_PROVIDER_DEFAULT_REGION` |
| `account_selection_strategy` | `lowest-usage` | `KIRO_PROVIDER_ACCOUNT_SELECTION_STRATEGY` |
| `session_affinity_ttl_ms` | `86400000` | `KIRO_PROVIDER_SESSION_AFFINITY_TTL_MS` |
| `session_affinity_max_entries` | `10000` | `KIRO_PROVIDER_SESSION_AFFINITY_MAX_ENTRIES` |
| `log_level` | `info` | `KIRO_PROVIDER_LOG_LEVEL` |

The full field reference, including retry/timeout tuning and the test-only `test_upstream_endpoint`, lives in [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

## Proxy

Some networks reach one model family directly while another needs a proxy (for example, GPT direct, Claude via an approved egress). Set `proxy_url` (config file, `KIRO_PROVIDER_PROXY_URL`, or `serve --proxy`) to route **all** upstream traffic — model calls, token refresh, and device-code login — through a single HTTP(S) proxy. Leave it `null` for direct connections. See [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md#proxy) for precedence details and examples.

## Security

- **Fail-closed authentication.** The server will not start without at least one non-empty `api_keys` entry. OpenAI routes require `Authorization: Bearer <key>`; Anthropic routes also accept `x-api-key: <key>`.
- **Local bind by default.** `host` defaults to `127.0.0.1`; only bind `0.0.0.0` behind a firewall or authenticated reverse proxy.
- **Single authentication authority.** Shared mode reads and updates OpenCode's existing Kiro database and fails closed on an incompatible schema; it never runs provider-owned migrations against that database.
- **Locked-down provider state.** `accounts.db` (and its WAL/SHM files) are created with mode `0600`; in shared mode this database contains affinity/state, not the authoritative credentials.
- **No secrets in logs.** Proxy URLs and account tokens are never printed; don't commit a real config file, account database, or gateway key.

> **Responsible use.** kiro-provider reuses AWS Kiro accounts you already control and consumes your own account quota. Supply your own accounts — this project is not a way to share or resell someone else's Kiro access, and it should not be used to circumvent per-account usage limits.

## Using with an LLM

Use `POST /v1/responses` for new OpenAI clients and Codex. Use
`POST /v1/messages` for Anthropic clients and Claude Code. Only point a
Chat-Completions-only client (`@ai-sdk/openai-compatible`, older LangChain
adapters, or an OpenCode custom provider using that package) at
`POST /v1/chat/completions` after explicitly enabling the legacy endpoint.

No client-specific session extension is required. The gateway derives
affinity from standard/native request fields when present and otherwise from
the initial user turn, stores only an irreversible key hash, and persists the
selected account plus Kiro conversation ID. Connection reuse is best-effort
through an account-scoped keep-alive pool; HTTP and upstream behavior can
still select a different physical socket. Stateful Responses fields
`previous_response_id` and `conversation` are rejected until the gateway has
a real response-state store, so clients must resend the complete input.

<details>
<summary>Agent command reference</summary>

- `kiro-provider serve [--config <path>] [--host <host>] [--port <port>] [--proxy <url>]` — start the gateway.
- `kiro-provider login [--config <path>] [--start-url <url>] [--region <region>]` — local compatibility mode only; shared mode directs you to `opencode auth login`.
- `kiro-provider accounts list` — list accounts in the local compatibility store.
- `kiro-provider accounts import [--from <path>] [--config <path>]` — take a one-time snapshot into the local compatibility store.
- `kiro-provider accounts remove <id|email>` — remove one account from the local compatibility store.

Contract: human-readable status lines go to stdout, errors to stderr, non-zero exit on failure. `GET /v1/models`, `GET /health`, and authenticated `GET /ready` return structured JSON.

</details>

## Use with Codex CLI

kiro-provider's `POST /v1/responses` endpoint speaks the OpenAI Responses wire format, so [Codex CLI](https://github.com/openai/codex) (verified end-to-end against 0.149.0-alpha.4.1 on 2026-08-22) can use it as a custom `model_provider` with `wire_api = "responses"`. Test it with an isolated `CODEX_HOME` so your real `~/.codex` config is never touched:

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

Requires the gateway running (`kiro-provider serve`) with at least one active
OpenCode Kiro account in the default shared mode, or an account in the
explicit local compatibility store. Full details, plus a ready-made isolated
smoke test (`scripts/codex-smoke.sh`), live in
[`docs/CODEX.md`](docs/CODEX.md).

## Use with Claude Code

Claude Code uses the Anthropic Messages protocol rather than OpenAI Chat
Completions. Point it at the gateway root:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export ANTHROPIC_AUTH_TOKEN="sk-your-private-key"
claude
```

The gateway accepts either `Authorization: Bearer <key>` or `x-api-key:
<key>` for Anthropic routes. Streaming text and tool calls are translated to
Anthropic SSE. Extended-thinking signatures are not fabricated or exposed,
and `/v1/messages/count_tokens` is an explicit estimate (the response carries
`x-kiro-token-count-mode: estimate`). See
[`docs/CLAUDE_CODE.md`](docs/CLAUDE_CODE.md).

The real-client validation record for OpenCode, Codex, Claude Code, shared
authentication, affinity reuse, and the legacy Chat gate is in
[`docs/E2E_VALIDATION_2026-08-22.md`](docs/E2E_VALIDATION_2026-08-22.md).

## Development

```bash
bun install
bun run typecheck
bun test
bash scripts/security-check.sh   # security regression suite (Linux, needs openssl/curl/ss)
```

## License

[MIT](LICENSE)
