# kiro-provider

> A protocol-fidelity gateway exposing a verified OpenAI Responses and Anthropic Messages subset over AWS Kiro (CodeWhisperer).

[![CI](https://github.com/sunerpy/kiro-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/sunerpy/kiro-provider/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/sunerpy/kiro-provider/branch/main/graph/badge.svg)](https://codecov.io/gh/sunerpy/kiro-provider)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-bun-black)](https://bun.sh/)

[简体中文](docs/readme/README.zh.md) · English

## Table of Contents

- [Features](#features)
- [Protocol compatibility](#protocol-compatibility)
- [Install](#install)
- [Quickstart](#quickstart)
- [Run as a background service](#run-as-a-background-service)
- [Configuration](#configuration)
- [Proxy](#proxy)
- [Security](#security)
- [Using with an LLM](#using-with-an-llm)
- [Use with Zuno](#use-with-zuno)
- [Use with Codex CLI](#use-with-codex-cli)
- [Use with Claude Code](#use-with-claude-code)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## Features

- OpenAI Responses `POST /v1/responses` and Anthropic Messages `POST /v1/messages` (both streaming and non-streaming), plus `POST /v1/messages/count_tokens`, `GET /v1/models`, `GET /health`, and authenticated `GET /ready`.
- Legacy OpenAI Chat Completions is available at `POST /v1/chat/completions`, but is disabled by default and must be explicitly enabled with `enable_legacy_chat_completions`.
- Bearer API-key gate that fails closed: the server refuses to start with no configured keys, and defaults to binding `127.0.0.1`.
- Provider-owned authentication by default: `auth_source: "local"` stores credentials in `~/.config/kiro-provider/accounts.db`. Existing `opencode-kiro-auth` accounts can be imported once with `kiro-provider accounts import`; after that, kiro-provider refreshes access tokens, usage, quota recovery, and account health without reading or locking OpenCode's database.
- Explicit-only session affinity by default: Responses requests can opt in through standard `metadata`, compatibility `client_metadata`, or `prompt_cache_key`; standard clients that resend complete history can also continue through the exact prior assistant-output lineage. User prompts are never fingerprinted to guess a session. A matching Zuno native OpenAI transport supplies `metadata.zuno_session_id` automatically.
- Account-scoped scheduling and cached SDK/transport objects: unrelated accounts can run concurrently, while one account is protected from overlapping Kiro streams. Access-token rotation rebuilds the credential-bound SDK client while retaining the account transport. A production-default service lock prevents multiple processes from silently splitting those queues and pools. Kiro model-call HTTP keep-alive is disabled by default and is an explicit transport opt-in.
- Live per-account model discovery and account-aware routing through Kiro management, with bounded stale/static fallback. Production calls use the live-probe-confirmed `runtime.<region>.kiro.dev` dialect. Token-usage metadata is an immediate completion witness; the current runtime's valid terminal metering event is accepted only when followed by clean EOF.
- Zero provider-owned prompt injection in the default `safe` mode: a canonical
  input IR preserves client text, roles, content-block boundaries, tool
  identity, ordering, and source paths; Kiro output is normalized into a
  separate canonical completion/event IR before protocol-specific encoding.
- Encrypted reasoning replay for complete native Kiro envelopes: opaque `kr1_...` tokens, AES-256-GCM storage, tenant/model/account/conversation/output binding, TTL/LRU cleanup, and account-locked replay.
- Multi-account rotation with automatic token refresh and failover. Exhausted accounts are hard-excluded from model attempts, then automatically rejoin only after a bounded, deduplicated Kiro usage probe confirms a new quota window. A provider-owned maintenance loop also refreshes near-expiry tokens and stale usage while the service is idle.
- `kiro-provider login` and `accounts import` write directly to the provider-owned local authentication store. The former `auth_source: "opencode-shared"` compatibility mode was removed in 0.7.0; a configuration that still selects it fails at startup with migration instructions (import once, then use `local`).
- A single global `proxy_url` that, when set, routes all upstream egress (model requests, token refresh, quota probes, device-code login) through one HTTP(S) proxy.
- Ships as a self-contained compiled binary via `bun build --compile` — no runtime install required on the target machine.

## Protocol compatibility

v0.5 is intentionally a **verified compatibility subset**. It does not accept
fields and silently discard them. The default `protocol_projection_mode:
"safe"` never prepends or rewrites client instructions, merges adjacent
messages, clears repeated assistant output, removes trailing text such as `{`,
or creates model-visible compensation prose.

Key boundaries:

- plain text, consecutive same-role turns, function/custom tool declarations,
  calls, and results retain their original structure and order;
- plain-text-only top-level blocks remain distinct in the canonical request,
  then are concatenated byte-for-byte with no inserted separator at Kiro's
  single-text-field boundary; multiple text blocks interleaved with images or
  tool content still return `unsupported_content_block_projection`;
- `instructions`, `system`, and `developer` return
  `unsupported_instruction_projection` in safe mode because Kiro accepted a
  valid `additionalContext` shape but did not preserve its instruction content
  or priority in live GPT and Claude probes;
- `tool_choice: auto` is supported; `parallel_tool_calls: false` is accepted as
  a no-op only when no callable tool can run (including `tool_choice: none`),
  and otherwise returns `unsupported_parallel_tool_calls`; required/named
  choice, strict schemas, custom grammars, and namespace tools are rejected
  rather than weakened;
- base64/data-URL images are supported, while remote image URLs and detail
  controls are rejected;
- Responses `input_file` supports inline base64/data-URL documents in Kiro's
  native document formats. The original filename remains in the canonical
  request; its recognized extension becomes the separate Kiro `format`, while
  the extensionless ASCII name is validated before the SDK call. Names that
  would require lossy rewriting return `invalid_file_name`; `file_id`
  references are rejected because the provider has no OpenAI file store;
- an output-token limit is probe-confirmed for `claude-sonnet-5` and
  `claude-opus-5` variants in the range 1,024–128,000;
- Responses omits only the exact `...`/`…` reasoning placeholder emitted by
  GPT 5.6 Sol; Opus reasoning, non-placeholder Sol reasoning, effort mapping,
  and encrypted reasoning replay remain unchanged;
- stateful Responses fields and native Web Search remain unsupported, and the
  provider never fabricates search/citation events.

The current state of the verified subset, the compiled-binary acceptance runs
behind each release, and the 2026-09-02 full code review with its remediation
plan are recorded in [`docs/audits/`](docs/audits/README.md). Stable releases
stay gated on those records rather than on silently discarding unsupported
fields.

For the complete capability matrix, error codes, reasoning replay contract,
and v0.4 migration steps, see
[`docs/PROTOCOL_COMPATIBILITY.md`](docs/PROTOCOL_COMPATIBILITY.md).

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

Both scripts download the platform asset together with the release's `SHA256SUMS`, verify the checksum, and abort on a mismatch before installing to `~/.local/bin` (override with `KIRO_PROVIDER_INSTALL_DIR`). By default they follow `releases/latest`; for reproducible or service installs, pin a release with `KIRO_PROVIDER_VERSION` (recommended):

```bash
curl -fsSL https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.sh | KIRO_PROVIDER_VERSION=0.5.1 sh
```

```powershell
$env:KIRO_PROVIDER_VERSION = "0.5.1"; irm https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.ps1 | iex
```

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

1. **Create a config with your own API key.** Only `api_keys` is required;
   every other field has a production default (`auth_source: "local"`,
   `host: "127.0.0.1"`, `port: 8787`).

   ```bash
   mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider"
   cat > "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json" <<'EOF'
   {
     "api_keys": ["sk-your-private-key"]
   }
   EOF
   chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json"
   ```

   Replace `sk-your-private-key` with a private, random value (for example
   `openssl rand -hex 24`). The fully annotated
   [`config.example.json`](config.example.json) in the repository and
   [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) describe every field.

   **Windows locations.** On Windows the default config path is
   `%APPDATA%\kiro-provider\config.json`, and `accounts.db`, the instance
   lock, and the reasoning keyring live in that same directory (POSIX uses
   `~/.config/kiro-provider` for all of them). Pass `--config <path>` to use a
   different file.

2. **Populate the provider-owned authentication store.** If you previously
   authenticated through OpenCode plus `opencode-kiro-auth`, import that
   database once:

   ```bash
   ./dist/kiro-provider accounts import
   ```

   The default source is `~/.config/opencode/kiro.db`; use `--from <path>` when
   needed. This is a copy, not a live link: subsequent token and usage refreshes
   are owned by kiro-provider. Alternatively, authenticate directly:

   ```bash
   ./dist/kiro-provider login
   ```

   Avoid continuing to use the same imported refresh tokens from two
   independently running authentication owners.

   Inspect or refresh the provider-owned account pool at any time:

   ```bash
   ./dist/kiro-provider accounts list
   ./dist/kiro-provider accounts list --details
   ./dist/kiro-provider accounts refresh --all
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
compatible OpenAI/Anthropic clients, OpenCode, Zuno, and compatibility probes
for Codex or Claude Code at that local endpoint.
Do not start a new provider for every agent or conversation. Keeping one
process alive lets requests with an explicit affinity key reuse their
persisted account/Kiro-conversation binding, while all requests can reuse
process-local, account-scoped SDK clients and transport objects. A request
without an explicit key starts a fresh Kiro conversation on its first turn,
then can recover the same binding from exact assistant-output history on later
turns. Kiro model-call HTTP sockets are fresh by default
(`sdk_http_keep_alive: false`); enabling it is a best-effort transport
optimization, never a promise that one session owns one physical TCP
connection. The default `enforce_single_instance: true` also prevents a second
service process from splitting the in-memory queues and pools.

Use a pinned standalone binary for a service rather than fetching through
`bunx` on every start. The examples below assume the release installers'
defaults:

- binary: `~/.local/bin/kiro-provider` on Linux,
  `%USERPROFILE%\.local\bin\kiro-provider.exe` on Windows;
- config: `~/.config/kiro-provider/config.json` on Linux,
  `%APPDATA%\kiro-provider\config.json` on Windows;
- service/task name: `kiro-provider`.

Run the one-time import and the service as the **same OS user** so the service
owns the same `~/.config/kiro-provider/accounts.db`, config, keyring, and
instance lock. Running as `root`, `LocalSystem`, or another user normally
selects a different local store. Use absolute paths and keep the API key in
the protected config file rather than service arguments. The OpenCode
database is not read again after the import.

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
`Environment=XDG_CONFIG_HOME=/absolute/path` line.

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

Run the following in PowerShell as the same user that owns the provider's
local authentication database and config. It creates a small launcher so
stdout/stderr are retained under `%LOCALAPPDATA%\kiro-provider`:

```powershell
$Binary = Join-Path $HOME ".local\bin\kiro-provider.exe"
$Config = Join-Path $env:APPDATA "kiro-provider\config.json"
$ServiceDir = Join-Path $env:APPDATA "kiro-provider"
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
$Config = Join-Path $env:APPDATA "kiro-provider\config.json"
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
Remove-Item "$env:APPDATA\kiro-provider\service.ps1"
```

This task intentionally runs only in the current user's interactive session,
so it can use that user's network access, provider database, and keyring
without storing a Windows password. A true pre-login Windows service requires
a service wrapper and a deliberately configured user account; do not run it
as `LocalSystem` and expect the same provider-owned files.

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
4. authenticated `/ready` succeeds, proving a readable auth source, at least
   one active account, writable provider state, an available reasoning keyring,
   and coverage for every key ID referenced by an unexpired replay record.

Use the fixed service/task name above so repeated setup is idempotent. Restart
it after changing the config or replacing the binary. Do not make the client
responsible for starting a private provider process; configure clients only
with the stable base URL and gateway API key.

## Configuration

Config is loaded from `~/.config/kiro-provider/config.json` (or `$XDG_CONFIG_HOME/kiro-provider/config.json`; on Windows `%APPDATA%\kiro-provider\config.json`, with the legacy `~/.config` location still read as a fallback), overridable by `KIRO_PROVIDER_*` environment variables and, for `serve`, by CLI flags. Unknown keys in the file are rejected with a suggestion, numeric fields are range-checked, and an empty environment variable counts as unset. Precedence is **CLI flag > environment variable > config file > schema default**.

| Field | Default | Env var |
| --- | --- | --- |
| `host` | `127.0.0.1` | `KIRO_PROVIDER_HOST` |
| `port` | `8787` | `KIRO_PROVIDER_PORT` |
| `api_keys` | required, non-empty | `KIRO_PROVIDER_API_KEYS` |
| `enable_legacy_chat_completions` | `false` | `KIRO_PROVIDER_ENABLE_LEGACY_CHAT_COMPLETIONS` |
| `protocol_projection_mode` | `safe` | `KIRO_PROVIDER_PROTOCOL_PROJECTION_MODE` |
| `session_affinity_mode` | `explicit-only` | `KIRO_PROVIDER_SESSION_AFFINITY_MODE` |
| `auth_source` | `local` | `KIRO_PROVIDER_AUTH_SOURCE` |
| `opencode_auth_db_path` | `null` (deprecated since 0.7.0, ignored) | `KIRO_PROVIDER_OPENCODE_AUTH_DB_PATH` |
| `proxy_url` | `null` | `KIRO_PROVIDER_PROXY_URL` |
| `default_region` | `us-east-1` | `KIRO_PROVIDER_DEFAULT_REGION` |
| `sdk_http_keep_alive` | `false` | `KIRO_PROVIDER_SDK_HTTP_KEEP_ALIVE` |
| `enforce_single_instance` | `true` | `KIRO_PROVIDER_ENFORCE_SINGLE_INSTANCE` |
| `instance_lock_path` | platform config directory | `KIRO_PROVIDER_INSTANCE_LOCK_PATH` |
| `runtime_endpoint_mode` | `kiro-runtime` | `KIRO_PROVIDER_RUNTIME_ENDPOINT_MODE` |
| `dynamic_model_catalog` | `true` | `KIRO_PROVIDER_DYNAMIC_MODEL_CATALOG` |
| `model_catalog_ttl_ms` | `900000` | `KIRO_PROVIDER_MODEL_CATALOG_TTL_MS` |
| `model_catalog_stale_ttl_ms` | `86400000` | `KIRO_PROVIDER_MODEL_CATALOG_STALE_TTL_MS` |
| `model_catalog_request_timeout_ms` | `10000` | `KIRO_PROVIDER_MODEL_CATALOG_REQUEST_TIMEOUT_MS` |
| `account_selection_strategy` | `lowest-usage` | `KIRO_PROVIDER_ACCOUNT_SELECTION_STRATEGY` |
| `quota_recheck_interval_ms` | `900000` | `KIRO_PROVIDER_QUOTA_RECHECK_INTERVAL_MS` |
| `quota_recheck_timeout_ms` | `10000` | `KIRO_PROVIDER_QUOTA_RECHECK_TIMEOUT_MS` |
| `quota_recheck_concurrency` | `4` | `KIRO_PROVIDER_QUOTA_RECHECK_CONCURRENCY` |
| `account_maintenance_enabled` | `true` | `KIRO_PROVIDER_ACCOUNT_MAINTENANCE_ENABLED` |
| `account_maintenance_interval_ms` | `60000` | `KIRO_PROVIDER_ACCOUNT_MAINTENANCE_INTERVAL_MS` |
| `account_maintenance_timeout_ms` | `120000` | `KIRO_PROVIDER_ACCOUNT_MAINTENANCE_TIMEOUT_MS` |
| `account_maintenance_concurrency` | `4` | `KIRO_PROVIDER_ACCOUNT_MAINTENANCE_CONCURRENCY` |
| `usage_refresh_interval_ms` | `900000` | `KIRO_PROVIDER_USAGE_REFRESH_INTERVAL_MS` |
| `session_affinity_ttl_ms` | `86400000` | `KIRO_PROVIDER_SESSION_AFFINITY_TTL_MS` |
| `session_affinity_max_entries` | `10000` | `KIRO_PROVIDER_SESSION_AFFINITY_MAX_ENTRIES` |
| `reasoning_replay_key_path` | auto-generated config path | `KIRO_PROVIDER_REASONING_REPLAY_KEY_PATH` |
| `reasoning_replay_keys` | `[]` | `KIRO_PROVIDER_REASONING_REPLAY_KEYS` |
| `reasoning_replay_ttl_ms` | `86400000` | `KIRO_PROVIDER_REASONING_REPLAY_TTL_MS` |
| `reasoning_replay_max_entries` | `10000` | `KIRO_PROVIDER_REASONING_REPLAY_MAX_ENTRIES` |
| `log_level` | `info` | `KIRO_PROVIDER_LOG_LEVEL` |

The full field reference, including retry/timeout tuning and the test-only `test_upstream_endpoint`, lives in [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

## Proxy

Some networks reach one model family directly while another needs a proxy (for example, GPT direct, Claude via an approved egress). Set `proxy_url` (config file, `KIRO_PROVIDER_PROXY_URL`, or `serve --proxy`) to route **all** upstream traffic — model calls, token refresh, quota probes, and device-code login — through a single HTTP(S) proxy. Leave it `null` for direct connections. See [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md#proxy) for precedence details and examples.

## Security

- **Fail-closed authentication.** The server will not start without at least one non-empty `api_keys` entry. OpenAI routes require `Authorization: Bearer <key>`; Anthropic routes also accept `x-api-key: <key>`.
- **Local bind by default.** `host` defaults to `127.0.0.1`; only bind `0.0.0.0` behind a firewall or authenticated reverse proxy.
- **Single authentication authority.** The default local mode makes kiro-provider the sole owner after one-time import. Do not keep two independent processes rotating the same imported refresh token. The explicit shared compatibility mode validates OpenCode's schema and never migrates it.
- **Single service owner by default.** The compiled service acquires a platform-config lock before listening, so process-local account/session queues and SDK pools cannot be split accidentally.
- **Locked-down provider state.** `accounts.db` (and its WAL/SHM files) are created with mode `0600`; in default local mode it contains credentials, usage, health, session affinity, and encrypted replay state.
- **Authenticated reasoning replay.** The database stores token/fingerprint hashes and AES-256-GCM ciphertext, not raw `kr1_...` tokens. Missing active decryption keys fail startup.
- **No sensitive content in logs.** Gateway/account secrets, replay tokens, signatures, reasoning, and request prompt text are not logged; structured audit fields contain hashes and field names only. Don't commit a real config file, account database, keyring, or gateway key.

> **Responsible use.** kiro-provider reuses AWS Kiro accounts you already control and consumes your own account quota. Supply your own accounts — this project is not a way to share or resell someone else's Kiro access, and it should not be used to circumvent per-account usage limits.

## Using with an LLM

Use `POST /v1/responses` for OpenAI Responses clients. Use
`POST /v1/messages` for Anthropic Messages clients. Only point a
Chat-Completions-only client (`@ai-sdk/openai-compatible`, older LangChain
adapters, or an OpenCode custom provider using that package) at
`POST /v1/chat/completions` after explicitly enabling the legacy endpoint.

Standard clients must also stay within the verified subset. In safe mode a
client that always sends system/developer instructions, custom grammars,
namespace tools, or Anthropic `cache_control` receives a field-level 400; the
gateway does not modify that request to force it through Kiro. The optional
`legacy-user-prefix` projection is an explicit instruction-only compatibility
mode. It remains deprecated, but removal is evidence-gated: Kiro must expose a
protocol-faithful native instruction channel, or affected clients must migrate
away from instruction roles first.

The default `session_affinity_mode: "explicit-only"` never hashes prompt text
to guess a conversation. Responses checks, in order,
`metadata.zuno_session_id`, `metadata.kiro_provider_session_id`, compatibility
`client_metadata.thread_id|session_id|conversation_id`, and
`prompt_cache_key`. Chat checks only `prompt_cache_key`; Anthropic Messages
has no verified explicit affinity field. With no key, the request gets a
fresh Kiro conversation on its first turn; a later full-history request can
reuse the same account/conversation by matching the exact prior assistant
output lineage. It can also reuse account-scoped SDK clients and transport
objects. The Kiro SDK's direct/proxy agents use fresh sockets by default; set
`sdk_http_keep_alive: true` only when the deployment has validated pooled
socket behavior.
The temporary `legacy-initial-input` mode restores only the old affinity
heuristics and logs a startup warning; it does not alter request content.

Stateful Responses fields `previous_response_id` and `conversation` are
rejected until the gateway has a real response-state store, so clients must
resend the complete input.

<details>
<summary>Agent command reference</summary>

- `kiro-provider serve [--config <path>] [--host <host>] [--port <port>] [--proxy <url>]` — start the gateway.
- `kiro-provider login [--config <path>] [--start-url <url>] [--region <region>]` — authenticate directly into the provider-owned local store.
- `kiro-provider accounts list [--details | --json]` — show aligned account health/usage; details and JSON include the stable account ID but never credentials.
- `kiro-provider accounts refresh (--all | <id|email>) [--config <path>] [--json]` — bypass the usage cache, refresh authoritative Kiro usage, and renew an access token only when needed or rejected upstream.
- `kiro-provider accounts relogin <id|email> [--config <path>] [--start-url <url>] [--region <region>]` — re-authenticate a selected account after Kiro identity verification while preserving its internal ID and session-affinity references.
- `kiro-provider accounts import [--from <path>] [--force]` — copy authenticated OpenCode Kiro accounts once into the provider-owned local store; rows whose local copy is newer are skipped unless `--force` is given; no live database link remains.
- `kiro-provider accounts remove <id|email> [--yes]` — remove one account and its affinity/lineage/reasoning state; interactive confirmation is required unless `--yes` is supplied.

Contract: human-readable status lines go to stdout, errors to stderr, non-zero exit on failure. `GET /v1/models`, `GET /health`, and authenticated `GET /ready` return structured JSON.

</details>

## Use with Zuno

Run one compiled kiro-provider service as the credential-owning OS user, then
configure Zuno's native Rust OpenAI transport. No Node package, AI SDK, private
header, or provider-spawn hook is required:

```json
{
  "model": "kiro/auto",
  "small_model": "kiro/auto",
  "provider": {
    "kiro": {
      "name": "Local kiro-provider",
      "transport": "openai",
      "surface": "responses",
      "env": ["KIRO_GATEWAY_API_KEY"],
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "maxTokens": null
      },
      "models": {
        "auto": {
          "name": "Kiro Auto",
          "reasoning": true,
          "tool_call": true
        }
      }
    }
  }
}
```

Set `KIRO_GATEWAY_API_KEY` to one key from the provider's `api_keys`, then
verify the native route:

```bash
export KIRO_GATEWAY_API_KEY='sk-your-private-key'
zuno debug config
zuno models kiro --verbose
```

The matching Zuno OpenAI Responses transport maps the durable Zuno session ID
to standard `metadata.zuno_session_id` on every main turn and tool
continuation. It does not add that ID to input, messages, instructions, tool
descriptions, or any other model-visible field; internal title/summary calls
do not join the main provider conversation. Therefore one Zuno session is
serialized onto one persisted account/Kiro-conversation binding, while
different sessions remain isolated even if their first prompt and upstream
tool aliases are identical. Tool declaration and alias state remains local to
each request.

Keep `surface: "responses"` for this integration. Selecting `chat` requires
the separately enabled legacy endpoint and does not carry the Zuno Responses
session metadata.

Current Zuno sends agent instructions. Valid required-label
`additionalContext` requests reached Kiro in live GPT and Claude probes, but
the models did not receive the instruction content or preserve its priority.
Consequently the verified functional path currently requires the provider's
explicit `protocol_projection_mode: "legacy-user-prefix"`; `safe` correctly
returns `unsupported_instruction_projection` and never rewrites the request.
Set Zuno `options.maxTokens` to `null` as shown so its generic layer does not
add the unsupported `max_output_tokens: 32000`. Neither setting uses a private
Header or client-side prompt patch; the legacy mode is an explicit migration
exception whose removal is gated on native instruction fidelity or completed
client migration.

## Use with Codex CLI

Codex uses the correct Responses endpoint. The last compiled protocol gate
with Codex
0.150.0-alpha.9 and `claude-opus-5-max` now passes provider model validation,
but its first request is rejected before Kiro at `reasoning.summary`, which
has no proven native equivalent. The provider does not strip that field or
simulate it with prompt text. The following isolated configuration reproduces
the compatibility check without touching the real `~/.codex` state:

```bash
export CODEX_TEST_ROOT="$(mktemp -d)"
export CODEX_HOME="$CODEX_TEST_ROOT/home"
export CODEX_SQLITE_HOME="$CODEX_TEST_ROOT/sqlite"
mkdir -p "$CODEX_HOME" "$CODEX_SQLITE_HOME"
export LOCALGW_KEY="sk-...your gateway api key..."
cat > "$CODEX_HOME/config.toml" <<'EOF'
model = "claude-opus-5-max"
model_provider = "localgw"
model_reasoning_effort = "high"
[model_providers.localgw]
name = "Local Gateway"
base_url = "http://127.0.0.1:8787/v1"
env_key = "LOCALGW_KEY"
wire_api = "responses"
EOF
codex exec --skip-git-repo-check "say hi"
```

For Codex 0.150.0-alpha.9 the expected result is a non-zero exit with
`unsupported_reasoning_summary` at `reasoning.summary`. A future supported request shape must
then pass a real shell/custom-tool loop, continuation, and restart reasoning
replay before Codex is marked supported. Full details live in
[`docs/CODEX.md`](docs/CODEX.md).

## Use with Claude Code

Claude Code uses Anthropic Messages. The last compiled protocol run with Claude Code
2.1.209, `claude-opus-5`, and max effort passes provider model validation but
is rejected before Kiro at `context_management`, which has no proven native
equivalent. The provider does not discard it. Direct Opus 5 Messages JSON/SSE
within the verified subset passes; the standard Claude Code configuration
below remains a compatibility probe rather than a full support claim:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export ANTHROPIC_API_KEY="sk-your-private-key"
claude --bare --safe-mode --model claude-opus-5 --effort max
```

The gateway accepts either `Authorization: Bearer <key>` or `x-api-key:
<key>` for Anthropic routes. Direct Messages requests within the verified
subset support typed JSON/SSE and tools, while `/v1/messages/count_tokens` is
an explicit estimate. See
[`docs/CLAUDE_CODE.md`](docs/CLAUDE_CODE.md).

The current account-management and live-usage validation record is in
[`docs/audits/kiro-provider-v0.5.0-rc.5-account-management-validation-2026-08-29.md`](docs/audits/kiro-provider-v0.5.0-rc.5-account-management-validation-2026-08-29.md).
The v0.5.0 typed stream-error contract and downstream Zuno handoff are in
[`docs/STREAM_ERROR_CONTRACT.md`](docs/STREAM_ERROR_CONTRACT.md) and
[`docs/ZUNO_STREAM_ERROR_HANDOFF.zh.md`](docs/ZUNO_STREAM_ERROR_HANDOFF.zh.md).
The preceding local-auth lifecycle record is retained in
[`docs/audits/kiro-provider-v0.5.0-rc.4-local-auth-maintenance-validation-2026-08-29.md`](docs/audits/kiro-provider-v0.5.0-rc.4-local-auth-maintenance-validation-2026-08-29.md).
The preceding protocol/client matrix is retained in
[`docs/audits/kiro-provider-v0.5.0-rc.3-opus5-validation-2026-08-27.md`](docs/audits/kiro-provider-v0.5.0-rc.3-opus5-validation-2026-08-27.md).
The older [`docs/E2E_VALIDATION_2026-08-22.md`](docs/E2E_VALIDATION_2026-08-22.md)
is retained as historical v0.4 evidence only.

## Troubleshooting

[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) is the symptom-first
runbook: for each symptom it names the audit event, the
`accounts list --details` availability value, or the HTTP status and
`error.code` to look at, then the cause and the remedy. It covers
`needs-relogin` and token-refresh failures, `quota-exhausted` versus
`overage-blocked` (`stop_on_overage`), `503 no_healthy_accounts`, the
`502 upstream_stream_*` codes with the pre-publication retry events, how to
read `sdk_stream_terminal` when "the assistant announced a next step and
stopped", reasoning-replay `400`s, the single-instance lock, configuration
warnings, `413` variants, and proxy failures. It also lists `journalctl` grep
recipes for the systemd service and the opt-in `request_shape` debug event.

## Development

```bash
bun install
bun run lint
bun run typecheck
bun test
bun run build
bun run build:binary
bash scripts/security-check.sh   # security regression suite (Linux, needs openssl/curl/ss)
```

`make ci` runs typecheck, lint, shell-script syntax checks, and the test suite.
`make fmt-check` (and `make fmt`) additionally require the `oxfmt` formatter
for YAML/JSON/Markdown; install the version CI uses with
`bun install --global oxfmt@0.59.0`. `bun run scripts/smoke.ts --help` describes
the live end-to-end checks against a running gateway.

## License

[MIT](LICENSE)
