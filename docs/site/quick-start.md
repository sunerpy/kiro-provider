---
title: Quick start
description: Install kiro-provider, sign in, start the gateway, and complete a first request.
outline: [2, 3]
---

# Quick start

This path gets one local Kiro account to a successful OpenAI Responses request. It keeps the gateway on its default loopback address and uses a private client API key.

## 1. Install the gateway

Install the standalone binary on Linux or macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.sh | sh
kiro-provider --version
```

The installer verifies the binary against the release `SHA256SUMS`. For a long-lived service, pin `KIRO_PROVIDER_VERSION` instead of following `latest`. Windows, Bun, and source-install options are documented in the [project README](https://github.com/sunerpy/kiro-provider#install).

Later, `kiro-provider --version --check` reports the newest release and `kiro-provider self-update` replaces this binary with it after verifying the same `SHA256SUMS`. See [Running as a background service](../SERVICE.md) for upgrading an installed service.

## 2. Create a private gateway key

```bash
export KIRO_GATEWAY_API_KEY="sk-$(openssl rand -hex 24)"
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider"
cat > "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json" <<EOF_CONFIG
{
  "api_keys": ["$KIRO_GATEWAY_API_KEY"]
}
EOF_CONFIG
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json"
```

The key authenticates local clients to kiro-provider; it is not a Kiro credential. Windows uses `%APPDATA%\kiro-provider` by default. See [Configuration](../CONFIGURATION.md) before changing the bind address, proxy, storage, or protocol behavior.

## 3. Sign in to Kiro

```bash
kiro-provider login
```

Complete the displayed device authorization flow. If you previously authenticated through `opencode-kiro-auth`, you may instead copy those accounts once with `kiro-provider accounts import`. Import is not a live link: after it completes, kiro-provider owns refresh and usage state for its copy.

## 4. Start and verify the gateway

```bash
kiro-provider serve
```

Keep that process running. In a second terminal, restore `KIRO_GATEWAY_API_KEY` if necessary, then require both checks to pass:

```bash
curl -fsS http://127.0.0.1:8787/health
curl -fsS http://127.0.0.1:8787/ready \
  -H "Authorization: Bearer $KIRO_GATEWAY_API_KEY"
```

`/health` confirms the process is serving. Authenticated `/ready` also confirms that the provider has a usable account.

## 5. Send the first request

```bash
curl -fsS http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer $KIRO_GATEWAY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"auto","input":"Reply with exactly: KIRO_OK"}'
```

A successful response contains a completed Responses object and assistant text. Model availability is account- and region-specific; query authenticated `GET /v1/models` instead of copying a catalog from another environment.

## Choose the next guide

- [Codex CLI](../CODEX.md) — isolated OpenAI Responses profile.
- [Claude Code](../CLAUDE_CODE.md) — isolated Anthropic Messages profile.
- [Zuno](../ZUNO.md) — native provider configuration and session routing.
- [Run as a service](../SERVICE.md) — pinned binary, lifecycle, logs, and readiness gates.
- [Troubleshooting](../TROUBLESHOOTING.md) — symptom-first diagnostics if any step fails.
