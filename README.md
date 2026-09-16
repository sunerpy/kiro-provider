<div align="center">

# kiro-provider

Use your AWS Kiro accounts from clients that speak OpenAI Responses or Anthropic Messages.

[![CI](https://github.com/sunerpy/kiro-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/sunerpy/kiro-provider/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/sunerpy/kiro-provider)](https://github.com/sunerpy/kiro-provider/releases)
[![npm](https://img.shields.io/npm/v/%40sunerpy%2Fkiro-provider)](https://www.npmjs.com/package/@sunerpy/kiro-provider)
[![codecov](https://codecov.io/gh/sunerpy/kiro-provider/branch/main/graph/badge.svg)](https://codecov.io/gh/sunerpy/kiro-provider)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[Quickstart](#quickstart) · [Clients](#use-it-with-an-agent) · [Compatibility](#compatibility-model) · [Documentation](#documentation)

[**English**](./README.md) · [简体中文](./docs/readme/README.zh-CN.md)

</div>

## What it does

kiro-provider is a loopback HTTP gateway and credential owner. It signs in to
Kiro, discovers the models available to each account, schedules requests across
those accounts, and presents two client-facing APIs:

| API | Route | Default |
| --- | --- | --- |
| OpenAI Responses | `POST /v1/responses` | Enabled |
| Anthropic Messages | `POST /v1/messages` | Enabled |
| Anthropic token estimate | `POST /v1/messages/count_tokens` | Enabled |
| OpenAI Chat Completions | `POST /v1/chat/completions` | Disabled; opt in with `enable_legacy_chat_completions` |
| Models and readiness | `GET /v1/models`, `GET /health`, `GET /ready` | Enabled |

Responses also has local retrieve, delete, input-items, cancel, and continuation
support. The gateway chooses a native KiroRuntime Responses call when it can
preserve the request exactly. Otherwise it uses its stateless adapter. If
neither path can preserve a requested feature, the request fails with a typed
error instead of quietly losing fields.

## Install

Choose one command. The examples below use `kiro-provider`; if you run through
`bunx`, substitute `bunx @sunerpy/kiro-provider`.

### Bun

The npm package uses Bun APIs and does not run under Node.js or `npx`.

```bash
bun add -g @sunerpy/kiro-provider
kiro-provider --version
```

For a one-off run:

```bash
bunx @sunerpy/kiro-provider --help
```

### Standalone binary

Each GitHub release contains binaries for Linux x64/arm64, macOS x64/arm64, and
Windows x64. The installers verify the downloaded binary against the release's
`SHA256SUMS` before placing it in `~/.local/bin` by default.

Linux or macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.ps1 | iex
```

For a service install, set `KIRO_PROVIDER_VERSION` to a release version instead
of following `latest`. See the [service guide](docs/SERVICE.md) for a pinned,
long-lived setup.

### Check the version and upgrade

`--version` prints the installed version only. Add `--check` to look up the
newest GitHub release, and `--json` for machine-readable output.

```bash
kiro-provider --version
kiro-provider --version --check
```

A standalone binary can replace itself. `self-update` downloads the release
asset for this platform, verifies it against the release's `SHA256SUMS`, and
only then swaps the binary in place; a digest mismatch leaves the installed
copy untouched.

```bash
kiro-provider self-update --check          # report what would be installed
kiro-provider self-update                  # ask, then replace
kiro-provider self-update --yes            # non-interactive
kiro-provider self-update --tag 3.3.1      # pin a release, including a downgrade
```

npm installs are upgraded with the package manager instead
(`bun add -g @sunerpy/kiro-provider@latest`); `self-update` refuses them and
says so. Both commands accept `--proxy <url>` and otherwise honour
`KIRO_PROVIDER_PROXY_URL`, then `HTTPS_PROXY`/`HTTP_PROXY`; `--proxy ""` selects
no proxy instead of falling through to those variables. Bun's `fetch` reads
`HTTPS_PROXY`/`HTTP_PROXY` itself, so unset them for a fully direct connection.
Replacing the binary needs write access to the install directory, not to the
binary itself, so a hardened read-only install still updates. Neither command
loads the gateway config, so a broken `config.json` cannot block an upgrade.
Restart the service after updating a service install.

## Quickstart

### 1. Create the gateway config

Only `api_keys` is required. Use a private random value; this key authenticates
local clients to the gateway.

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider"
cat > "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json" <<'EOF_CONFIG'
{
  "api_keys": ["sk-replace-with-a-private-random-key"]
}
EOF_CONFIG
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json"
```

On Windows the default directory is `%APPDATA%\kiro-provider`. Pass
`--config <path>` to `login` and `serve` when using another file.

### 2. Sign in to Kiro

```bash
kiro-provider login
```

If you already used `opencode-kiro-auth`, copy those accounts into the
provider-owned store once:

```bash
kiro-provider accounts import
```

The import is not a live link. After it finishes, kiro-provider owns token and
usage refresh for its copy of the accounts.

### 3. Start the gateway

```bash
kiro-provider serve
```

The default address is `http://127.0.0.1:8787`. In another terminal, confirm
both process health and authenticated readiness:

```bash
export KIRO_GATEWAY_API_KEY='sk-replace-with-a-private-random-key'
curl -fsS http://127.0.0.1:8787/health
curl -fsS http://127.0.0.1:8787/ready \
  -H "Authorization: Bearer $KIRO_GATEWAY_API_KEY"
```

### 4. Send a Responses request

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: process.env.KIRO_GATEWAY_API_KEY,
});

const response = await client.responses.create({
  model: "auto",
  input: "Reply with exactly: KIRO_OK",
});

console.log(response.output_text);
```

Model IDs come from the accounts currently ready in the local pool. Query
`GET /v1/models` rather than hard-coding a catalog copied from another account
or region.

## Use it with an agent

| Client | API | Guide |
| --- | --- | --- |
| Zuno | OpenAI Responses | [Native provider configuration and session routing](docs/ZUNO.md) |
| Codex CLI | OpenAI Responses | [Isolated profile and compatibility checks](docs/CODEX.md) |
| Claude Code | Anthropic Messages | [Shared-state `kiroclaude` launcher and model selection](docs/CLAUDE_CODE.md) |
| Other SDKs | Responses or Messages | [Protocol compatibility](docs/PROTOCOL_COMPATIBILITY.md) |

Codex uses an isolated profile. `kiroclaude` instead keeps Claude's native
state and applies a provider/model overlay only to the launched process, so the
ordinary `claude` command keeps its provider. The guides record the exact
client versions last tested; treat them as dated evidence, not a promise about
future request shapes.

## Configuration

Configuration precedence is CLI flag, environment variable, JSON file, then
schema default. Unknown keys and invalid values fail at startup. Start from
[`config.example.json`](config.example.json), then use the
[configuration reference](docs/CONFIGURATION.md) for every field, environment
variable, timeout, file location, and protocol switch.

## Compatibility model

The default `protocol_projection_mode: "v3-auto"` keeps transport selection in
the gateway:

- ordinary Responses requests use KiroRuntime's native Responses operation;
- requests that need stateless-only semantics, including `store: false`, max
  effort, provider reasoning replay, custom grammar, or collaboration items,
  use the canonical stateless path;
- Anthropic Messages requests are projected directly into the Kiro contract,
  with signed thinking replay kept opaque to the client;
- unsupported semantics are rejected with field-level errors.

This is not a promise of full OpenAI or Anthropic parity. Hosted tools,
background Responses, Responses conversation objects, Structured Outputs,
remote file references, exact input-token counting, and destructive context
edits are examples of features the gateway cannot currently preserve. The
[compatibility guide](docs/PROTOCOL_COMPATIBILITY.md) is the current contract;
the [audit index](docs/audits/README.md) contains dated probe evidence.

## State and security

- The server refuses to start without a non-empty `api_keys` entry and binds to
  `127.0.0.1` by default.
- `auth_source: "local"` stores credentials and account state in the platform
  config directory. The database and its WAL/SHM files are created owner-only;
  keep the JSON config owner-only as well.
- A single-instance lock prevents two provider processes from splitting local
  account queues and continuation state.
- Reasoning replay is encrypted with AES-256-GCM. Logs exclude credentials,
  prompts, tool arguments, signatures, and raw reasoning.
- A configured `proxy_url` applies to model calls, login, token refresh, and
  quota probes together.

Use only Kiro accounts you control. The project is not intended to share or
resell access or to bypass account-level usage limits.

## Documentation

Browse the rendered documentation at [kiro-provider.firlab.app](https://kiro-provider.firlab.app/), use the [repository index](docs/README.md), or go directly to:

- [Configuration reference](docs/CONFIGURATION.md)
- [Background service](docs/SERVICE.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Responses usage and context accounting](docs/RESPONSES_USAGE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Audit and validation records](docs/audits/README.md)
- [Changelog](changelog/README.md)

Simplified Chinese versions are linked from the documentation index.

## Development

```bash
git clone https://github.com/sunerpy/kiro-provider.git
cd kiro-provider
bun install --frozen-lockfile
make ci
make coverage-gate
bun run build:binary
```

`make pre-ci` runs the full local pull-request gate. Coverage is enforced at
93% for both the repository-owned gate and Codecov; `codecov/project` and
`codecov/patch` are required merge checks. See [AGENTS.md](AGENTS.md) for the
repository's implementation, security, and release rules.

## License

[MIT](LICENSE)
