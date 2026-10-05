# Choose a client

Every client needs the same two things: the gateway's address and one of the keys in your `api_keys`. Nothing is
installed into the client.

| Client         | API                | Base URL                   | Guide                               |
| -------------- | ------------------ | -------------------------- | ----------------------------------- |
| Codex CLI      | OpenAI Responses   | `http://127.0.0.1:8787/v1` | [Codex CLI](../../CODEX.md)         |
| Claude Code    | Anthropic Messages | `http://127.0.0.1:8787`    | [Claude Code](../../CLAUDE_CODE.md) |
| OpenCode       | Anthropic Messages | `http://127.0.0.1:8787/v1` | [OpenCode](opencode.md)             |
| Pi             | OpenAI Responses   | `http://127.0.0.1:8787/v1` | [Pi](pi.md)                         |
| Crush          | Anthropic Messages | `http://127.0.0.1:8787`    | [Crush](crush.md)                   |
| Zuno           | OpenAI Responses   | `http://127.0.0.1:8787/v1` | [Zuno](../../ZUNO.md)               |
| OpenAI SDKs    | OpenAI Responses   | `http://127.0.0.1:8787/v1` | [below](#sdks)                      |
| Anthropic SDKs | Anthropic Messages | `http://127.0.0.1:8787`    | [below](#sdks)                      |

The base URL depends on what the client appends to it. Claude Code, Crush and the Anthropic SDKs add `/v1/messages`;
OpenCode's `@ai-sdk/anthropic` adds `/messages` only, so its base URL keeps `/v1`.

A newer client release can change the requests it sends; if a field it adds is not supported yet, the gateway names it
in a typed error instead of ignoring it.

## The key

The gateway accepts the key as `Authorization: Bearer <key>` or as `x-api-key: <key>` on every route, so both SDK
families work unchanged. Each key is a tenant of its own: stored responses, session bindings and reasoning history
made with one key are invisible to requests with another. Giving each client its own key keeps them apart; a
conversation has to continue with the key that started it.

## Model names

`GET /v1/models` lists the models your accounts can use. Besides the plain names, such as `gpt-5.6-sol` or
`claude-opus-5-5`, it lists `auto` and one name per effort level for models that have levels, such as
`claude-opus-5-5-high`. Codex CLI reads the effort levels from the same list for its `/model` picker; the
[Codex guide](../../CODEX.md#model-and-effort-switching) shows how to load it.

Switching model or effort in the middle of a conversation works: the visible history and tool calls carry over, and
reasoning that the new model cannot read is left out and reported in a response header. The
[configuration reference](../../CONFIGURATION.md#switching-models-and-reasoning-effort) explains the rules.

## SDKs

The OpenAI SDK for JavaScript:

```ts
import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: process.env.KIRO_GATEWAY_API_KEY,
});

const response = await openai.responses.create({
  model: "gpt-5.6-sol",
  store: false,
  input: "Reply with exactly: KIRO_OK",
});
console.log(response.output_text);
```

The Anthropic SDK for JavaScript. Its base URL has no `/v1`, because the SDK adds it:

```ts
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  baseURL: "http://127.0.0.1:8787",
  apiKey: process.env.KIRO_GATEWAY_API_KEY,
});

const message = await anthropic.messages.create({
  model: "claude-opus-5-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Reply with exactly: KIRO_OK" }],
});
console.log(message.content[0].type === "text" ? message.content[0].text : "");
```

kiro-provider passes `max_tokens` on to Kiro for `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5` and
`claude-fable-5-1`, from 1,024 to 128,000; a value outside that range is refused rather than changed. Kiro has no
output limit kiro-provider can set for other models, and every Messages request carries `max_tokens`, so Messages
serves those four models, plus the GPT-5.6 models when the request has the header
`x-kiro-output-token-limit-mode: advisory` ([OpenCode](opencode.md) sets it). On Responses, `max_output_tokens`
follows the same rule but is optional; a request without it can use every model.

## Separate commands for Kiro

The [client launchers](../../CLIENT_LAUNCHERS.md) set up a `kirocodex` and a `kiroclaude` command next to the `codex`
and `claude` you already have, each with its own home directory, so your usual sessions and settings stay as they
are.

## Other clients

Any client that speaks OpenAI Responses or Anthropic Messages can try the same base URLs. The
[protocol compatibility](../../PROTOCOL_COMPATIBILITY.md) reference lists which request fields are supported. Clients
that only speak Chat Completions need the route turned on with `enable_legacy_chat_completions`; it does not carry
Responses session metadata.
