# OpenCode

[OpenCode](https://opencode.ai) installs the `@ai-sdk/anthropic` package on its own, so kiro-provider joins it as an
Anthropic Messages provider. One entry covers the Claude and the GPT-5.6 models.

## Add the provider

Put the provider in `~/.config/opencode/opencode.json`, or in `opencode.json` at the root of a project:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "kiro-provider": {
      "npm": "@ai-sdk/anthropic",
      "name": "kiro-provider",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "{env:KIRO_GATEWAY_API_KEY}",
        "headers": {
          "x-kiro-output-token-limit-mode": "advisory"
        }
      },
      "models": {
        "claude-opus-5-5": {
          "name": "Claude Opus 5.5",
          "limit": { "context": 1000000, "output": 128000 },
          "options": { "toolStreaming": false }
        },
        "gpt-5.6-sol": {
          "name": "GPT-5.6 Sol",
          "limit": { "context": 1000000, "output": 128000 },
          "options": { "thinking": { "type": "enabled", "budgetTokens": 16000 } }
        }
      }
    }
  },
  "model": "kiro-provider/claude-opus-5-5"
}
```

Export the key in the shell that starts OpenCode. `/models` switches between the two models, and `-m` picks one for a
single run:

```sh
export KIRO_GATEWAY_API_KEY='<one of your api_keys>'
opencode
opencode run -m kiro-provider/gpt-5.6-sol "Reply with exactly: KIRO_OK"
```

## What the settings do

| Setting         | Why                                                                                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseURL`       | Ends in `/v1`: `@ai-sdk/anthropic` adds `/messages` to it, where the Anthropic SDKs add `/v1/messages`.                                                                                                                                                                   |
| `headers`       | OpenCode sends `max_tokens` with every request. Kiro has no output limit for the GPT-5.6 models, so kiro-provider refuses their requests unless `x-kiro-output-token-limit-mode: advisory` is present. With it, kiro-provider leaves the limit out for those models only. |
| `toolStreaming` | `false` on Claude models. Otherwise OpenCode marks their tools with `eager_input_streaming`, which kiro-provider refuses.                                                                                                                                                 |
| `thinking`      | On for GPT-5.6 models. GPT-5.6 can send its reasoning signature after the answer has begun. With thinking on, kiro-provider waits for it; without, such a reply fails with `Upstream returned invalid reasoning metadata`.                                                |
| `limit`         | The context and output sizes OpenCode plans with, copied from `GET /v1/models`.                                                                                                                                                                                           |

## Which models work

Every Messages request carries `max_tokens`. kiro-provider passes it on to Kiro for four Claude models:
`claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5` and `claude-fable-5-1`, from 1,024 to 128,000. With the header
above, `gpt-5.6-sol`, `gpt-5.6-terra` and `gpt-5.6-luna` work too. Any other model is refused with an
`invalid_request_error` about `max_tokens`; use it from a Responses client such as [Pi](pi.md).

Add a model under `models` with the numbers `GET /v1/models` reports, `toolStreaming: false` for a Claude model and
`thinking` for a GPT-5.6 model:

```sh
curl -s http://127.0.0.1:8787/v1/models -H "Authorization: Bearer $KIRO_GATEWAY_API_KEY" |
  jq -r '.data[] | [.id, .context_limit, .output_limit] | @tsv'
```

## The Responses provider

OpenCode can also reach the gateway with `@ai-sdk/openai` at the same `baseURL`. Claude models work that way; GPT-5.6
does not. Through that package OpenCode sends `max_output_tokens` on every request, and the advisory header applies to
Messages only, so a GPT-5.6 request fails with `unsupported_output_token_limit`. The Messages setup above covers both.

## Accounts from opencode-kiro-auth

If you have been using Kiro in OpenCode through the `opencode-kiro-auth` plugin, copy those accounts into kiro-provider
once and stop using the plugin's provider: two programs renewing one refresh token race each other.
[Accounts](../guide/accounts.md#import-from-opencode) covers the import.
