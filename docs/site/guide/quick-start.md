# Quick start

This page takes you from an installed `kiro-provider` to a first answer: one key, one signed-in account, the gateway
running, and a request through each API. It assumes you have [installed](install.md) kiro-provider.

## 1. Choose a key for your clients

The gateway refuses to start without at least one entry in `api_keys`. Every client sends one of these keys, so pick a
long random value and keep it private. It is not a Kiro or AWS credential.

```sh
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider"
cat > "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json" <<'EOF'
{
  "api_keys": ["sk-replace-with-a-private-random-key"]
}
EOF
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json"
```

On Windows the file is `%APPDATA%\kiro-provider\config.json`. Every other field has a default;
[`config.example.json`](../../../config.example.json) and the [configuration reference](../../CONFIGURATION.md) list them.

## 2. Sign in to Kiro

```sh
kiro-provider login
```

`login` prints `Open this URL to sign in:` and a link. Open it, check that the code on the page matches, and sign in
with your AWS Builder ID; the command waits and then prints `Login successful:` with the account's email. For an
organization that uses IAM Identity Center, pass its start URL and region:

```sh
kiro-provider login --start-url https://example.awsapps.com/start --region us-east-1
```

kiro-provider finds your Kiro profile and stores the account in its own database. When the identity has several
profiles, it stops before saving anything and asks you to rerun with `--profile-arn <arn>`. Run `login` again for
each further account; [Accounts](accounts.md) covers importing accounts from OpenCode and everything after sign-in.

## 3. Start the gateway

```sh
kiro-provider serve
```

It listens on `http://127.0.0.1:8787` and prints `Listening on http://127.0.0.1:8787`. Its log, one JSON object per
line, goes to standard error. In a second terminal, check that it is alive and that an account is ready:

```sh
export KIRO_GATEWAY_API_KEY='sk-replace-with-a-private-random-key'
curl -fsS http://127.0.0.1:8787/health
curl -fsS http://127.0.0.1:8787/ready -H "Authorization: Bearer $KIRO_GATEWAY_API_KEY"
```

`/health` answers `{"status":"ok"}` without a key. `/ready` needs the key and returns HTTP 200 only when at least one
account is active and the gateway's database and key file are usable.

To keep the gateway running after you log out, install it as a [background service](../../SERVICE.md).

## 4. Send a first request

Through OpenAI Responses:

```sh
curl -s http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer $KIRO_GATEWAY_API_KEY" \
  --json '{"model": "gpt-5.6-sol", "store": false, "input": "Reply with exactly: KIRO_OK"}'
```

Through Anthropic Messages:

```sh
curl -s http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: $KIRO_GATEWAY_API_KEY" \
  --json '{"model": "claude-opus-5-5", "max_tokens": 1024,
           "messages": [{"role": "user", "content": "Reply with exactly: KIRO_OK"}]}'
```

`--json` needs curl 7.82 or later. Both answers contain `KIRO_OK`. The same request from the OpenAI SDK for
JavaScript:

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

`store: false` sends the request through kiro-provider's own conversion, the way Codex CLI sends its requests.
Without it, the request goes to Kiro's own Responses operation and the gateway keeps the response so you can retrieve
and continue it later. Kiro can refuse that operation for an account, which shows up as `403 access_denied`;
[protocol compatibility](../../PROTOCOL_COMPATIBILITY.md) explains the two paths.

The model names come from your accounts. `GET /v1/models` lists what they can use, including `auto` and, for models
with effort levels, one name per level such as `claude-opus-5-5-high`.

## 5. Connect your agent

- [Codex CLI](../../CODEX.md): a `model_provider` with `wire_api = "responses"`.
- [Claude Code](../../CLAUDE_CODE.md): the `kiroclaude` launcher.
- [Zuno](../../ZUNO.md): a provider with `surface: "responses"`.
- Anything else: [choose a client](../clients/index.md).
