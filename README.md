<div align="center">

# kiro-provider

### OpenAI Responses and Anthropic Messages over AWS KiroRuntime

[![CI](https://github.com/sunerpy/kiro-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/sunerpy/kiro-provider/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/sunerpy/kiro-provider)](https://github.com/sunerpy/kiro-provider/releases)
[![npm](https://img.shields.io/npm/v/%40sunerpy%2Fkiro-provider)](https://www.npmjs.com/package/@sunerpy/kiro-provider)
[![codecov](https://codecov.io/gh/sunerpy/kiro-provider/branch/main/graph/badge.svg)](https://codecov.io/gh/sunerpy/kiro-provider)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-bun-black)](https://bun.sh/)

[Install](#install) · [Quickstart](#quickstart) · [Protocol](#protocol-compatibility) · [Clients](#client-integrations) · [Docs](#documentation) · [Development](#development)

[**English**](./README.md) · [简体中文](./docs/readme/README.zh-CN.md)

</div>

---

## Features

- OpenAI Responses creation plus locally mirrored retrieve, delete, input-items,
  and cancel routes; Anthropic Messages `POST /v1/messages`; legacy Chat
  Completions behind an explicit switch; `GET /v1/models`, `GET /health`, and
  authenticated `GET /ready`.
- Legacy OpenAI Chat Completions is available at `POST /v1/chat/completions`, but is disabled by default and must be explicitly enabled with `enable_legacy_chat_completions`.
- Bearer API-key gate that fails closed: the server refuses to start with no configured keys, and defaults to binding `127.0.0.1`.
- Provider-owned authentication by default: `auth_source: "local"` stores credentials in `~/.config/kiro-provider/accounts.db`. Existing `opencode-kiro-auth` accounts can be imported once with `kiro-provider accounts import`; after that, kiro-provider refreshes access tokens, usage, quota recovery, and account health without reading or locking OpenCode's database.
- Explicit-only session affinity by default: Responses requests can opt in through standard `metadata`, compatibility `client_metadata`, or `prompt_cache_key`; standard clients that resend complete history can also continue through the exact prior assistant-output lineage. User prompts are never fingerprinted to guess a session. A matching Zuno native OpenAI transport supplies `metadata.zuno_session_id` automatically.
- Account-scoped scheduling and cached SDK/transport objects: unrelated accounts can run concurrently, while one account is protected from overlapping Kiro streams. Access-token rotation rebuilds the credential-bound SDK client while retaining the account transport. A production-default service lock prevents multiple processes from silently splitting those queues and pools. Kiro model-call HTTP keep-alive is disabled by default and is an explicit transport opt-in.
- Live per-account model discovery and account-aware routing through Kiro management, with bounded stale/static fallback. Production calls use the live-probe-confirmed `runtime.<region>.kiro.dev` dialect. Token-usage metadata is an immediate completion witness; the current runtime's valid terminal metering event is accepted only when followed by clean EOF.
- Default `v3-auto` transport selection: ordinary requests use KiroRuntime's
  native OpenAI Responses operation and request shapes requiring `store:false`,
  max effort, provider `kr1_` replay, custom grammar, or Codex collaboration
  use the canonical stateless fallback. Verified namespace/free-form tools can
  stay on native Responses through a persistent tool bridge.
- Complete signed Kiro envelopes use provider `kr1_...` replay tokens, AES-256-GCM storage, tenant/model/account/conversation/output binding, TTL/LRU cleanup, and account-locked replay. Native opaque tokens stay on CreateResponse and recover their owner from durable response records.
- Multi-account rotation with automatic token refresh and failover. Exhausted accounts are hard-excluded from model attempts, then automatically rejoin only after a bounded, deduplicated Kiro usage probe confirms a new quota window. A provider-owned maintenance loop also refreshes near-expiry tokens and stale usage while the service is idle.
- `kiro-provider login` and `accounts import` write directly to the provider-owned local authentication store. The former `auth_source: "opencode-shared"` compatibility mode was removed in 0.7.0; a configuration that still selects it fails at startup with migration instructions (import once, then use `local`).
- A single global `proxy_url` that, when set, routes all upstream egress (model requests, token refresh, quota probes, device-code login) through one HTTP(S) proxy.
- Ships as a self-contained compiled binary via `bun build --compile` — no runtime install required on the target machine.

## Protocol compatibility

V3 implements the core OpenAI Responses resource and makes every upstream
difference explicit:

- native JSON/SSE creation, instructions, function tools, supported effort and
  token controls, and `previous_response_id` (exact native replay for affected Claude and Sol reasoning histories);
- automatic stateless fallback for `store:false`, max effort, provider-token
  replay, custom grammar, unverified tool-bridge combinations, and Codex multi-agent items;
- tenant-isolated local response mirrors for retrieve, delete, input-items
  pagination, and continuation;
- field-level OpenAI error envelopes for capabilities Kiro cannot preserve,
  including Responses conversation objects, background execution, Structured
  Outputs, hosted tools, remote file references, compact, and exact
  input-token counting.

The old GenerateAssistantResponse `safe` mode remains fail-closed because
`additionalContext` did not preserve instruction content or priority, and the
account does not advertise the private `systemPrompt` feature. The default
`v3-auto` path instead uses KiroRuntime CreateResponse's native
`instructions` field.

`responses_fidelity_mode` defaults to `compatible` and reports request projection
losses in `X-Kiro-Compatibility`; `strict` rejects those semantics before generation.
`X-Kiro-Transport` distinguishes native, native-adapted, and stateless calls.
Native tool bridges are enabled only for verified model/region cells. Instruction
lifting stays experimental until its complete continuation gate passes. See the
[Responses fidelity validation](docs/audits/kiro-provider-responses-fidelity-2026-09-10.zh.md)
for history, reasoning, instruction-priority boundaries, and storage migration.
The [before/after report](docs/audits/kiro-provider-responses-before-after-2026-09-10.zh.md)
includes real OpenAI SDK, Codex, and Zuno results.

Usage preserves measured cache/read/write and reasoning sub-counts. When Kiro only
provides a context percentage and credits, compatible mode labels estimates and
unknown fields in `usage.metadata.kiro`; strict mode omits incomplete usage.
Context accounting does not multiply GPT's capped legacy percentage by its corrected
prompt budget. See [usage and context accounting](docs/RESPONSES_USAGE.md), including
the distinction between AI SDK 7's cumulative `usage` and `finalStep.usage`.

For the transport decision table, stored-response contract, data-retention
boundary, verified model controls, and current client evidence, see
[`docs/PROTOCOL_COMPATIBILITY.md`](docs/PROTOCOL_COMPATIBILITY.md) and the
[`docs/audits/`](docs/audits/README.md) records.

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
curl -fsSL https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.sh | KIRO_PROVIDER_VERSION=3.0.0 sh
```

```powershell
$env:KIRO_PROVIDER_VERSION = "3.0.0"; irm https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.ps1 | iex
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
   `openssl rand -hex 24`). The complete
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

For an agent host, run one long-lived provider per OS user. Use a pinned
standalone binary, run authentication and the service as the same user, and
require both unauthenticated `/health` and authenticated `/ready` before
connecting clients. The default single-instance lock prevents a second process
from splitting account queues and session state.

The [background-service guide](docs/SERVICE.md) contains complete systemd user
service and Windows Scheduled Task examples, log locations, lifecycle commands,
health gates, and removal steps.

## Configuration

Configuration is loaded from the platform config directory, then overlaid by
`KIRO_PROVIDER_*` environment variables and supported `serve` flags. Precedence
is **CLI flag > environment variable > JSON file > schema default**. Unknown
keys and invalid ranges fail at startup; an empty environment value is treated
as unset.

The checked-in [`config.example.json`](config.example.json) is an annotated
starting point. The [configuration reference](docs/CONFIGURATION.md) is the
source of truth for every field, default, environment variable, timeout, proxy,
file location, and protocol switch. Do not copy provider-only fields such as
`responses_fidelity_mode` into a downstream client's request options.

## Security

- **Fail-closed authentication.** The server will not start without at least one non-empty `api_keys` entry. OpenAI routes require `Authorization: Bearer <key>`; Anthropic routes also accept `x-api-key: <key>`.
- **Local bind by default.** `host` defaults to `127.0.0.1`; only bind `0.0.0.0` behind a firewall or authenticated reverse proxy.
- **Single authentication authority.** The provider-owned local store is the sole authority after login or one-time import. Do not keep two independent processes rotating the same imported refresh token; the former live `opencode-shared` mode is no longer supported.
- **Single service owner by default.** The compiled service acquires a platform-config lock before listening, so process-local account/session queues and SDK pools cannot be split accidentally.
- **Locked-down provider state.** `accounts.db` (and its WAL/SHM files) are created with mode `0600`; in default local mode it contains credentials, usage, health, session affinity, and encrypted replay state.
- **Authenticated reasoning replay.** The database stores token/fingerprint hashes and AES-256-GCM ciphertext, not raw `kr1_...` tokens. Missing active decryption keys fail startup.
- **No sensitive content in logs.** Gateway/account secrets, replay tokens, signatures, reasoning, and request prompt text are not logged; structured audit fields contain hashes and field names only. Don't commit a real config file, account database, keyring, or gateway key.

> **Responsible use.** kiro-provider reuses AWS Kiro accounts you already control and consumes your own account quota. Supply your own accounts — this project is not a way to share or resell someone else's Kiro access, and it should not be used to circumvent per-account usage limits.

## Client integrations

Use `POST /v1/responses` for OpenAI Responses clients and `POST /v1/messages`
for Anthropic Messages clients. Enable `POST /v1/chat/completions` only for a
client that cannot use either primary surface.

| Client | Endpoint | Guide |
| --- | --- | --- |
| Zuno | OpenAI Responses | [Configuration, session routing, and isolated validation](docs/ZUNO.md) |
| Codex CLI | OpenAI Responses | [Isolated profile and supported request boundary](docs/CODEX.md) |
| Claude Code | Anthropic Messages | [Isolated `kiroclaude` profile and compatibility boundary](docs/CLAUDE_CODE.md) |
| Other SDKs | Responses, Messages, or explicitly enabled legacy Chat | [V3 protocol compatibility](docs/PROTOCOL_COMPATIBILITY.md) |

The default `session_affinity_mode: "explicit-only"` never fingerprints prompt
text. Clients should send a stable standard affinity field, or resend complete
history / use `previous_response_id` as their API supports. Native and stateless
transport selection remains a gateway concern; clients should not force an
internal lane.

## Troubleshooting

[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) is the symptom-first
runbook: for each symptom it names the audit event, the
`accounts list --details` availability value, or the HTTP status and
`error.code` to look at, then the cause and the remedy. It covers
`needs-relogin` and token-refresh failures, `quota-exhausted` versus
`overage-blocked` (`stop_on_overage`), `503 no_healthy_accounts`, the
`502 upstream_stream_*` codes, accepted-stream failures and non-stream retry events, how to
read `sdk_stream_terminal` when "the assistant announced a next step and
stopped", reasoning-replay `400`s, the single-instance lock, configuration
warnings, `413` variants, and proxy failures. It also lists `journalctl` grep
recipes for the systemd service and the opt-in `request_shape` debug event.

## Documentation

[`docs/README.md`](docs/README.md) is the complete documentation map. It
separates current operator/protocol guides from dated audit evidence and links
the English and Simplified Chinese variants. Release history lives under
[`changelog/`](changelog/README.md).

## Development

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun test
bun run build
bun run build:binary
bash scripts/security-check.sh   # security regression suite (Linux, needs openssl/curl/ss)
```

`make ci` runs the repository's fast correctness gate: formatting, typecheck,
lint, shell-script syntax, tests, build, security self-tests, and coverage-config
parity. `make pre-ci` adds the full coverage run and enforced coverage floor.
`make fmt-check` uses the repository-pinned `oxfmt` version; install dependencies
first with `bun install --frozen-lockfile`. `bun run scripts/smoke.ts --help` describes
the live end-to-end checks against a running gateway.

## License

[MIT](LICENSE)
