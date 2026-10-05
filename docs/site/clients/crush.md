# Crush

[Crush](https://github.com/charmbracelet/crush) reaches kiro-provider through Anthropic Messages, as a provider of
type `anthropic`. The Claude and the GPT-5.6 models work through it.

## Add the provider

Put the provider in `~/.config/crush/crush.json`, or in `crush.json` at the root of a project:

```json
{
  "$schema": "https://charm.land/crush.json",
  "providers": {
    "kiro-provider": {
      "name": "kiro-provider",
      "type": "anthropic",
      "base_url": "http://127.0.0.1:8787",
      "api_key": "$KIRO_GATEWAY_API_KEY",
      "extra_headers": {
        "Authorization": "Bearer $KIRO_GATEWAY_API_KEY",
        "x-kiro-output-token-limit-mode": "advisory"
      },
      "models": [
        {
          "id": "claude-opus-5-5",
          "name": "Claude Opus 5.5",
          "context_window": 1000000,
          "default_max_tokens": 32000,
          "can_reason": true
        },
        {
          "id": "gpt-5.6-sol",
          "name": "GPT-5.6 Sol",
          "context_window": 1000000,
          "default_max_tokens": 32000,
          "can_reason": true
        }
      ]
    }
  },
  "models": {
    "large": { "model": "claude-opus-5-5", "provider": "kiro-provider" },
    "small": { "model": "claude-opus-5-5", "provider": "kiro-provider" }
  }
}
```

Export the key in the shell that starts Crush:

```sh
export KIRO_GATEWAY_API_KEY='<one of your api_keys>'
crush
crush run "Reply with exactly: KIRO_OK"
```

To work with GPT-5.6 Sol, select it with thinking on, in place of the `models` block above:

```json
{
  "models": {
    "large": { "model": "gpt-5.6-sol", "provider": "kiro-provider", "think": true },
    "small": { "model": "claude-opus-5-5", "provider": "kiro-provider" }
  }
}
```

## What the settings do

| Setting          | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `base_url`       | Without `/v1`: Crush adds `/v1/messages` itself.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `extra_headers`  | Crush sends the key as `x-api-key` and, next to it, an `Authorization: Bearer` header with no key. kiro-provider reads `Authorization` first when a request has one and would answer `invalid_api_key`, so this header has to carry the key. Crush also sends `max_tokens` (`default_max_tokens`) with every request; Kiro has no output limit for the GPT-5.6 models, so kiro-provider refuses their requests without `x-kiro-output-token-limit-mode: advisory`. |
| `think`          | `true` for GPT-5.6 models. GPT-5.6 can send its reasoning signature after the answer has begun. With thinking on, kiro-provider waits for it; without, such a reply fails with `Upstream returned invalid reasoning metadata`.                                                                                                                                                                                                                                     |
| `context_window` | Copied from `context_limit` in `GET /v1/models`.                                                                                                                                                                                                                                                                                                                                                                                                                   |

The `small` model writes session titles. Keep it on a Claude model, or give a GPT-5.6 model `"think": true` there too.

## Which models work

kiro-provider passes `max_tokens` on to Kiro for `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5` and
`claude-fable-5-1`, from 1,024 to 128,000, and with the advisory header it serves `gpt-5.6-sol`, `gpt-5.6-terra` and
`gpt-5.6-luna` as well. Crush always sends `max_tokens`, so other models are refused with an `invalid_request_error`
about it. `GET /v1/models` gives the numbers for a new entry:

```sh
curl -s http://127.0.0.1:8787/v1/models -H "Authorization: Bearer $KIRO_GATEWAY_API_KEY" |
  jq -r '.data[] | [.id, .context_limit, .output_limit] | @tsv'
```
