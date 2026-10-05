# OpenCode

[OpenCode](https://opencode.ai) 会自己安装 `@ai-sdk/anthropic` 包，所以 kiro-provider 以 Anthropic Messages provider 的身份接入。一个条目同时覆盖 Claude 和 GPT-5.6 模型。

## 添加 provider

把 provider 写入 `~/.config/opencode/opencode.json`，或项目根目录的 `opencode.json`：

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

在启动 OpenCode 的 shell 中导出密钥。`/models` 在两个模型之间切换，`-m` 为单次运行指定模型：

```sh
export KIRO_GATEWAY_API_KEY='<api_keys 中的一个密钥>'
opencode
opencode run -m kiro-provider/gpt-5.6-sol "Reply with exactly: KIRO_OK"
```

## 各项设置的作用

| 设置            | 原因                                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `baseURL`       | 以 `/v1` 结尾：`@ai-sdk/anthropic` 在它后面加上 `/messages`，Anthropic SDK 加的则是 `/v1/messages`。                                                                                                                     |
| `headers`       | OpenCode 的每个请求都带 `max_tokens`。Kiro 没有 GPT-5.6 模型的输出上限，所以请求不带 `x-kiro-output-token-limit-mode: advisory` 时，kiro-provider 会拒绝这些模型的请求；带上它之后，kiro-provider 只对这些模型略去上限。 |
| `toolStreaming` | Claude 模型设为 `false`。否则 OpenCode 会给它们的工具加上 `eager_input_streaming`，kiro-provider 会拒绝它。                                                                                                              |
| `thinking`      | GPT-5.6 模型开启。GPT-5.6 可能在回答开始之后才发出推理签名。开启 thinking 时 kiro-provider 会等待这个签名；不开启时，这样的回复会以 `Upstream returned invalid reasoning metadata` 失败。                                |
| `limit`         | OpenCode 规划时使用的上下文和输出大小，取自 `GET /v1/models`。                                                                                                                                                           |

## 可用的模型

每个 Messages 请求都带 `max_tokens`。kiro-provider 只为四个 Claude 模型把它传给 Kiro：`claude-opus-5-5`、`claude-opus-5`、`claude-sonnet-5` 和 `claude-fable-5-1`，范围是 1,024 到 128,000。加上前面的 header 后，`gpt-5.6-sol`、`gpt-5.6-terra` 和 `gpt-5.6-luna` 也能使用。其他模型会以关于 `max_tokens` 的 `invalid_request_error` 被拒绝，请改用 [Pi](pi.md) 这样的 Responses 客户端。

在 `models` 下添加模型时，填入 `GET /v1/models` 报告的数值；Claude 模型加上 `toolStreaming: false`，GPT-5.6 模型加上 `thinking`：

```sh
curl -s http://127.0.0.1:8787/v1/models -H "Authorization: Bearer $KIRO_GATEWAY_API_KEY" |
  jq -r '.data[] | [.id, .context_limit, .output_limit] | @tsv'
```

## Responses provider

OpenCode 也可以用 `@ai-sdk/openai` 以同样的 `baseURL` 连接网关。这样 Claude 模型能用，GPT-5.6 不能：通过这个包，OpenCode 的每个请求都带 `max_output_tokens`，而 advisory header 只对 Messages 生效，所以 GPT-5.6 的请求会以 `unsupported_output_token_limit` 失败。上面的 Messages 配置能同时覆盖两类模型。

## 来自 opencode-kiro-auth 的账号

如果你此前在 OpenCode 中通过 `opencode-kiro-auth` 插件使用 Kiro，请把这些账号一次性复制到 kiro-provider，并停止使用该插件的 provider：两个程序同时续期同一个刷新令牌会相互冲突。导入方法见[账号](../guide/accounts.md#从-opencode-导入)。
