# Pi

[Pi](https://pi.dev) 通过 OpenAI Responses 连接 kiro-provider，使用它内置的 `openai-responses` API。GPT-5.6 和 Claude 模型都通过同一个 provider 条目使用。

## 添加 provider

Pi 从 agent 目录中的 `models.json` 读取自定义端点：默认是 `~/.pi/agent/models.json`，设置了 `PI_CODING_AGENT_DIR` 时则是它指定的目录。

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

在启动 Pi 的 shell 中导出密钥，然后在命令行上选择模型，或之后用 `/model` 选择：

```sh
export KIRO_GATEWAY_API_KEY='<api_keys 中的一个密钥>'
pi --model kiro-provider/gpt-5.6-sol
```

## 各项设置的作用

| 设置                         | 原因                                                                                                                                                                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`                     | `$KIRO_GATEWAY_API_KEY` 让 Pi 从环境变量读取密钥，密钥不会写进文件。                                                                                                                                                                          |
| `compat`                     | `supportsMaxOutputTokens: false`。Pi 的每个请求都带 `max_output_tokens`；kiro-provider 只为 `claude-opus-5-5`、`claude-opus-5`、`claude-sonnet-5` 和 `claude-fable-5-1` 把它传给 Kiro，对其他模型则以 `unsupported_output_token_limit` 拒绝。 |
| `reasoning`                  | 让 `/thinking`、`--thinking` 或 `--model kiro-provider/gpt-5.6-sol:high` 这样的后缀可以设置推理等级。                                                                                                                                         |
| `thinkingLevelMap`           | 只有映射了 `xhigh` 和 `max` 的模型，Pi 才提供这两个等级。                                                                                                                                                                                     |
| `contextWindow`、`maxTokens` | Pi 规划时使用的大小，取自 `GET /v1/models`。不写时 Pi 按 128,000 和 16,384 处理。                                                                                                                                                             |

## 添加其他模型

`GET /v1/models` 列出你的账号可用的每个模型，以及 `contextWindow` 和 `maxTokens` 应填的数值：

```sh
curl -s http://127.0.0.1:8787/v1/models -H "Authorization: Bearer $KIRO_GATEWAY_API_KEY" |
  jq -r '.data[] | [.id, .context_limit, .output_limit] | @tsv'
```

把每个模型作为 `models` 下的一个新条目加入；除了上面四个 Claude 模型，都要加上 `compat.supportsMaxOutputTokens: false`。不需要 `claude-opus-5-5-high` 这类带推理等级后缀的名称：推理等级由 thinking 等级设置。

## Pi 的 Anthropic API

Pi 的 `anthropic-messages` API 也能以 `http://127.0.0.1:8787` 连接网关，但开启 `reasoning: true` 时，Pi 会请求摘要形式的 thinking。kiro-provider 只能为 Claude Fable 5.1 表示摘要 thinking，对其他模型会以 `unsupported_reasoning_display` 拒绝，因此应当使用 `openai-responses`。
