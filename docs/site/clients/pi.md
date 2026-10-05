# Pi

[Pi](https://pi.dev) reaches kiro-provider through OpenAI Responses, with its built-in `openai-responses` API. The
GPT-5.6 and Claude models work through the same provider entry.

## Add the provider

Pi reads custom endpoints from `models.json` in its agent directory: `~/.pi/agent/models.json`, or the directory
`PI_CODING_AGENT_DIR` names.

```json
{
  "providers": {
    "kiro-provider": {
      "baseUrl": "http://127.0.0.1:8787/v1",
      "api": "openai-responses",
      "apiKey": "$KIRO_GATEWAY_API_KEY",
      "models": [
        {
          "id": "gpt-5.6-sol",
          "name": "GPT-5.6 Sol",
          "reasoning": true,
          "thinkingLevelMap": { "xhigh": "xhigh", "max": "max" },
          "contextWindow": 1000000,
          "maxTokens": 128000,
          "compat": { "supportsMaxOutputTokens": false }
        },
        {
          "id": "claude-opus-5-5",
          "name": "Claude Opus 5.5",
          "reasoning": true,
          "thinkingLevelMap": { "xhigh": "xhigh", "max": "max" },
          "contextWindow": 1000000,
          "maxTokens": 128000
        }
      ]
    }
  }
}
```

Export the key in the shell that starts Pi, then pick a model on the command line or later with `/model`:

```sh
export KIRO_GATEWAY_API_KEY='<one of your api_keys>'
pi --model kiro-provider/gpt-5.6-sol
```

## What the settings do

| Setting                      | Why                                                                                                                                                                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`                     | `$KIRO_GATEWAY_API_KEY` makes Pi take the key from the environment variable, so it is not written into the file.                                                                                                                                                                       |
| `compat`                     | `supportsMaxOutputTokens: false`. Pi sends `max_output_tokens` with every request; kiro-provider passes it on to Kiro for `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5` and `claude-fable-5-1` only, and refuses it for any other model with `unsupported_output_token_limit`. |
| `reasoning`                  | Lets `/thinking`, `--thinking` or a suffix such as `--model kiro-provider/gpt-5.6-sol:high` set the reasoning effort.                                                                                                                                                                  |
| `thinkingLevelMap`           | Pi offers the `xhigh` and `max` levels only for a model that maps them.                                                                                                                                                                                                                |
| `contextWindow`, `maxTokens` | The sizes Pi plans with, copied from `GET /v1/models`. Without them Pi assumes 128,000 and 16,384.                                                                                                                                                                                     |

## Add other models

`GET /v1/models` lists every model your accounts can use, with the numbers for `contextWindow` and `maxTokens`:

```sh
curl -s http://127.0.0.1:8787/v1/models -H "Authorization: Bearer $KIRO_GATEWAY_API_KEY" |
  jq -r '.data[] | [.id, .context_limit, .output_limit] | @tsv'
```

Add each one as another entry under `models`, with `compat.supportsMaxOutputTokens: false` unless it is one of the
four Claude models above. Names with an effort suffix, such as `claude-opus-5-5-high`, are not needed: the thinking
level sets the effort.

## Pi's Anthropic API

Pi's `anthropic-messages` API reaches the gateway too, at `http://127.0.0.1:8787`, but with `reasoning: true` Pi asks
for summarized thinking. kiro-provider represents summarized thinking for Claude Fable 5.1 only and refuses it for
other models with `unsupported_reasoning_display`, so `openai-responses` is the API to use.
