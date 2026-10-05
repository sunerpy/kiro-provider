<div align="center">

<img src="./docs/site/public/kiro-provider-logo.svg" alt="" width="72" />

# kiro-provider

### Use your AWS Kiro accounts from clients that speak OpenAI Responses or Anthropic Messages

[![CI](https://github.com/sunerpy/kiro-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/sunerpy/kiro-provider/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/sunerpy/kiro-provider)](https://github.com/sunerpy/kiro-provider/releases)
[![npm](https://img.shields.io/npm/v/%40sunerpy%2Fkiro-provider)](https://www.npmjs.com/package/@sunerpy/kiro-provider)
[![codecov](https://codecov.io/gh/sunerpy/kiro-provider/branch/main/graph/badge.svg)](https://codecov.io/gh/sunerpy/kiro-provider)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[Website](https://firlab.app/kiro-provider/) · [Install](#install) · [Quick start](#quick-start) · [Clients](#use-it-with-an-agent) · [Documentation](#documentation)

[**English**](./README.md) · [简体中文](./docs/readme/README.zh-CN.md)

</div>

---

kiro-provider is a gateway you run on your own machine. It signs in to AWS Kiro, keeps the tokens of every account you
add, and serves those accounts through OpenAI Responses and Anthropic Messages, so Codex CLI, Claude Code, OpenCode,
Pi, Crush, Zuno and the official SDKs work with a base URL and a key.

## Features

- **Two APIs, one gateway.** `POST /v1/responses` and `POST /v1/messages`, streaming and non-streaming, with tools,
  images and reasoning effort. Chat Completions is available as an opt-in legacy route.
- **Direct sign-in.** Device-code login for AWS Builder ID and IAM Identity Center. kiro-provider discovers the Kiro
  profile itself; Kiro CLI is not involved.
- **Many accounts, one endpoint.** Requests go to the least busy eligible account; tokens are renewed and usage is
  refreshed in the background, and an exhausted account sits out until its quota resets.
- **Fails closed.** A field that cannot reach Kiro intact fails the request with a typed error that names it; nothing
  is dropped quietly.
- **Conversations that survive.** Stored responses and encrypted reasoning replay let clients continue, switch model
  or effort, and resume after a restart.
- **Web search, if you want it.** The hosted web search tool of both APIs, run by kiro-provider through your own
  account. Off by default.
- **Verifiable releases.** Standalone binaries for Linux, macOS and Windows with `SHA256SUMS` and build attestations,
  and a `self-update` that replaces the binary only after its checksum matches.

## Install

The install scripts download the release binary for your platform, verify it against the release's `SHA256SUMS`, and
place it in `~/.local/bin` (set `KIRO_PROVIDER_INSTALL_DIR` to change that).

Linux or macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.ps1 | iex
```

With [Bun](https://bun.sh); the npm package uses Bun's APIs and does not run under Node.js or `npx`:

```bash
bun add -g @sunerpy/kiro-provider
```

Set `KIRO_PROVIDER_VERSION` to pin a release, as a long-lived service should. The
[install guide](https://firlab.app/kiro-provider/guide/install) covers pinning, checking the build attestation,
building from source and uninstalling.

## Quick start

1. Choose a key for your clients. The gateway refuses to start without one:

   ```bash
   mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider"
   cat > "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json" <<'EOF_CONFIG'
   {
     "api_keys": ["sk-replace-with-a-private-random-key"]
   }
   EOF_CONFIG
   chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json"
   ```

   On Windows the file is `%APPDATA%\kiro-provider\config.json`.

2. Sign in to Kiro. Add `--start-url <url> --region <region>` for IAM Identity Center, and `--profile-arn <arn>` when
   the identity has several profiles:

   ```bash
   kiro-provider login
   ```

   Accounts from `opencode-kiro-auth` can be copied once with `kiro-provider accounts import`.

3. Start the gateway and check that an account is ready:

   ```bash
   kiro-provider serve
   ```

   ```bash
   export KIRO_GATEWAY_API_KEY='sk-replace-with-a-private-random-key'
   curl -fsS http://127.0.0.1:8787/health
   curl -fsS http://127.0.0.1:8787/ready -H "Authorization: Bearer $KIRO_GATEWAY_API_KEY"
   ```

4. Send a request:

   ```ts
   import OpenAI from "openai";

   const client = new OpenAI({
     baseURL: "http://127.0.0.1:8787/v1",
     apiKey: process.env.KIRO_GATEWAY_API_KEY,
   });

   const response = await client.responses.create({
     model: "gpt-5.6-sol",
     store: false,
     input: "Reply with exactly: KIRO_OK",
   });

   console.log(response.output_text);
   ```

   `store: false` sends the request through kiro-provider's own conversion, the way Codex CLI does. Without it the
   request goes to Kiro's native Responses operation, which Kiro can refuse for an account with `403 access_denied`.
   `GET /v1/models` lists the model names your accounts can use.

The [quick start](https://firlab.app/kiro-provider/guide/quick-start) on the website walks through each step, with
an Anthropic Messages request as well.

## Use it with an agent

| Client      | API                   | Guide                                                                         |
| ----------- | --------------------- | ----------------------------------------------------------------------------- |
| Codex CLI   | OpenAI Responses      | [Isolated profile and model switching](docs/CODEX.md)                         |
| Claude Code | Anthropic Messages    | [Shared-state `kiroclaude` launcher and model selection](docs/CLAUDE_CODE.md) |
| OpenCode    | Anthropic Messages    | [A provider in `opencode.json`](docs/site/clients/opencode.md)                |
| Pi          | OpenAI Responses      | [A provider in `models.json`, with thinking levels](docs/site/clients/pi.md)  |
| Crush       | Anthropic Messages    | [A provider in `crush.json`](docs/site/clients/crush.md)                      |
| Zuno        | OpenAI Responses      | [Native provider configuration and session routing](docs/ZUNO.md)             |
| Other SDKs  | Responses or Messages | [Protocol compatibility](docs/PROTOCOL_COMPATIBILITY.md)                      |

For persistent `kirocodex` and `kiroclaude` commands with their own state, follow
[the launcher examples](docs/CLIENT_LAUNCHERS.md).

## Compatibility

| Route                                                               | Default                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------ |
| `POST /v1/responses`, plus retrieve, delete, input items and cancel | Enabled                                                |
| `POST /v1/messages`, `POST /v1/messages/count_tokens` (an estimate) | Enabled                                                |
| `POST /v1/chat/completions`                                         | Disabled; opt in with `enable_legacy_chat_completions` |
| `GET /v1/models`, `GET /health`, `GET /ready`                       | Enabled                                                |

In the default `v3-auto` mode, a Responses request that Kiro's native Responses operation can preserve exactly goes
there; `store: false`, max effort, reasoning replay and the other stateless-only shapes use the provider's stateless
path, as do all Messages requests. Unsupported semantics, such as hosted tools other than web search, background
responses, conversation objects and arbitrary JSON Schema output, are rejected with field-level errors. This is not
a promise of full OpenAI or Anthropic parity: [protocol compatibility](docs/PROTOCOL_COMPATIBILITY.md) is the
current contract, and the [audit index](docs/audits/README.md) holds the dated probe evidence.

## Configuration

Configuration precedence is CLI flag, environment variable, JSON file, then schema default. Unknown keys and invalid
values fail at startup. Start from [`config.example.json`](config.example.json); the
[configuration reference](docs/CONFIGURATION.md) lists every field, environment variable, timeout, file location and
protocol switch.

## State and security

- The server refuses to start without a non-empty `api_keys` entry and binds to `127.0.0.1` by default.
- Credentials and account state live in `accounts.db` in the platform config directory. The database and its WAL/SHM
  files are created owner-only; keep the JSON config owner-only as well.
- A single-instance lock stops two gateways on one config directory from splitting account capacity and conversation
  state.
- Reasoning replay is encrypted with AES-256-GCM. Logs exclude credentials, prompts, tool arguments, signatures and
  raw reasoning.
- A configured `proxy_url` applies to model calls, login, token refresh and quota probes together.

Use only Kiro accounts you control. The project is not intended to share or resell access or to bypass account-level
usage limits.

## Updates

```bash
kiro-provider --version --check    # look up the latest release
kiro-provider self-update          # replace a standalone binary after verifying it
bun add -g @sunerpy/kiro-provider@latest
```

`self-update` refuses npm installs and never reads the gateway config. Restart the gateway after updating it; the
[service guide](docs/SERVICE.md#upgrading-the-service-binary) has the sequence for systemd and the Windows scheduled
task.

## Documentation

The website, [firlab.app/kiro-provider](https://firlab.app/kiro-provider/), has the guides in English and Chinese.
In this repository:

- [Configuration reference](docs/CONFIGURATION.md)
- [Background service](docs/SERVICE.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Responses usage and context accounting](docs/RESPONSES_USAGE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Audit and validation records](docs/audits/README.md)
- [Changelog](changelog/CHANGELOG-v3.x.md)

The [documentation index](docs/README.md) links every document and its Simplified Chinese version.

## Development

```bash
git clone https://github.com/sunerpy/kiro-provider.git
cd kiro-provider
bun install --frozen-lockfile
make check
make coverage-gate
bun run build:binary
```

`make pre-ci` runs the full local pull-request gate. Coverage is enforced at 93% for both the repository-owned gate
and Codecov; `codecov/project` and `codecov/patch` are required merge checks. See [AGENTS.md](AGENTS.md) for the
repository's implementation, security and release rules.

## License

[MIT](LICENSE)
