# kiro-provider

> A standalone OpenAI-compatible HTTP gateway for AWS Kiro (CodeWhisperer) — point any OpenAI SDK or agent at your own Kiro accounts.

[![CI](https://github.com/sunerpy/kiro-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/sunerpy/kiro-provider/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/sunerpy/kiro-provider/branch/main/graph/badge.svg)](https://codecov.io/gh/sunerpy/kiro-provider)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-bun-black)](https://bun.sh/)

[简体中文](docs/readme/README.zh.md) · English

## Table of Contents

- [Features](#features)
- [Install](#install)
- [Quickstart](#quickstart)
- [Configuration](#configuration)
- [Proxy](#proxy)
- [Security](#security)
- [Using with an LLM](#using-with-an-llm)
- [Development](#development)
- [License](#license)

## Features

- OpenAI-compatible `POST /v1/chat/completions` (streaming SSE and non-streaming JSON), `GET /v1/models`, and `GET /health`.
- Bearer API-key gate that fails closed: the server refuses to start with no configured keys, and defaults to binding `127.0.0.1`.
- Multi-account rotation with automatic token refresh and failover, backed by a local `bun:sqlite` account store with tombstone-based removal.
- `accounts import` to reuse accounts already authenticated by [OpenCode's Kiro auth](https://opencode.ai/) instead of repeating device-code login.
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

1. **Get an account into the local store.** Either sign in interactively:

   ```bash
   ./dist/kiro-provider login
   ```

   or import accounts already authenticated by OpenCode:

   ```bash
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

4. **Call it with an OpenAI-compatible client.**

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

   const completion = await client.chat.completions.create({
     model: "auto",
     messages: [{ role: "user", content: "Explain this repository." }],
   });

   console.log(completion.choices[0]?.message.content);
   ```

   Or with the [Vercel AI SDK](https://sdk.vercel.ai/) via `@ai-sdk/openai-compatible`:

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

## Configuration

Config is loaded from `~/.config/kiro-provider/config.json` (or `$XDG_CONFIG_HOME/kiro-provider/config.json`), overridable by `KIRO_PROVIDER_*` environment variables and, for `serve`, by CLI flags. Precedence is **CLI flag > environment variable > config file > schema default**.

| Field | Default | Env var |
| --- | --- | --- |
| `host` | `127.0.0.1` | `KIRO_PROVIDER_HOST` |
| `port` | `8787` | `KIRO_PROVIDER_PORT` |
| `api_keys` | required, non-empty | `KIRO_PROVIDER_API_KEYS` |
| `proxy_url` | `null` | `KIRO_PROVIDER_PROXY_URL` |
| `default_region` | `us-east-1` | `KIRO_PROVIDER_DEFAULT_REGION` |
| `account_selection_strategy` | `lowest-usage` | `KIRO_PROVIDER_ACCOUNT_SELECTION_STRATEGY` |
| `log_level` | `info` | `KIRO_PROVIDER_LOG_LEVEL` |

The full field reference, including retry/timeout tuning and the test-only `test_upstream_endpoint`, lives in [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

## Proxy

Some networks reach one model family directly while another needs a proxy (for example, GPT direct, Claude via an approved egress). Set `proxy_url` (config file, `KIRO_PROVIDER_PROXY_URL`, or `serve --proxy`) to route **all** upstream traffic — model calls, token refresh, and device-code login — through a single HTTP(S) proxy. Leave it `null` for direct connections. See [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md#proxy) for precedence details and examples.

## Security

- **Fail-closed authentication.** The server will not start without at least one non-empty `api_keys` entry, and every route requires `Authorization: Bearer <key>`.
- **Local bind by default.** `host` defaults to `127.0.0.1`; only bind `0.0.0.0` behind a firewall or authenticated reverse proxy.
- **Locked-down account store.** `accounts.db` (and its WAL/SHM files) are created with mode `0600`.
- **No secrets in logs.** Proxy URLs and account tokens are never printed; don't commit a real config file, account database, or gateway key.

> **Responsible use.** kiro-provider reuses AWS Kiro accounts you already control and consumes your own account quota. Supply your own accounts — this project is not a way to share or resell someone else's Kiro access, and it should not be used to circumvent per-account usage limits.

## Using with an LLM

Point any OpenAI-compatible client (`openai`, `@ai-sdk/openai-compatible`, LangChain, etc.) at `http://<host>:<port>/v1` with one of your configured `api_keys`.

<details>
<summary>Agent command reference</summary>

- `kiro-provider serve [--config <path>] [--host <host>] [--port <port>] [--proxy <url>]` — start the gateway.
- `kiro-provider login [--config <path>] [--start-url <url>] [--region <region>]` — device-code login (AWS Builder ID, or IAM Identity Center with `--start-url`).
- `kiro-provider accounts list` — list stored accounts and their health.
- `kiro-provider accounts import [--from <path>] [--config <path>]` — import accounts from an OpenCode `kiro.db` (default source: `~/.config/opencode/kiro.db`).
- `kiro-provider accounts remove <id|email>` — remove one account (writes a tombstone).

Contract: human-readable status lines go to stdout, errors to stderr, non-zero exit on failure. `GET /v1/models` and `GET /health` return structured JSON.

</details>

## Development

```bash
bun install
bun run typecheck
bun test
bash scripts/security-check.sh   # security regression suite (Linux, needs openssl/curl/ss)
```

## License

[MIT](LICENSE)
