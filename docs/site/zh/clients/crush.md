# Crush

[Crush](https://github.com/charmbracelet/crush) 把 kiro-provider 配置为 `anthropic` 类型的 provider，用 Anthropic Messages 与网关通信。Claude 和 GPT-5.6 模型都能使用。

## 添加 provider

把 provider 写入 `~/.config/crush/crush.json`，或项目根目录的 `crush.json`：

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

在启动 Crush 的 shell 中导出密钥：

```sh
export KIRO_GATEWAY_API_KEY='<api_keys 中的一个密钥>'
crush
crush run "Reply with exactly: KIRO_OK"
```

使用 GPT-5.6 Sol 时，把上面的 `models` 部分换成下面这段，它选择 GPT-5.6 Sol 并开启 thinking：

```json
{
  "models": {
    "large": { "model": "gpt-5.6-sol", "provider": "kiro-provider", "think": true },
    "small": { "model": "claude-opus-5-5", "provider": "kiro-provider" }
  }
}
```

## 各项设置的作用

| 设置             | 原因                                                                                                                                                                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base_url`       | 不带 `/v1`：Crush 会自己加上 `/v1/messages`。                                                                                                                                                                                                                                                                           |
| `extra_headers`  | `Authorization`：Crush 用 `x-api-key` 发送密钥，同时还发送一个不带密钥的 `Authorization: Bearer`。kiro-provider 优先读取 `Authorization`，没有这一项时会返回 `invalid_api_key`。`x-kiro-output-token-limit-mode: advisory`：Crush 的每个请求都带 `max_tokens`，没有这个 header 时 kiro-provider 会拒绝 GPT-5.6 的请求。 |
| `think`          | GPT-5.6 模型设为 `true`。GPT-5.6 可能在回答开始之后才发出推理签名。开启 thinking 时 kiro-provider 会等待这个签名；不开启时，这样的回复会以 `Upstream returned invalid reasoning metadata` 失败。                                                                                                                        |
| `context_window` | 取自 `GET /v1/models` 中的 `context_limit`。                                                                                                                                                                                                                                                                            |

`small` 模型负责生成会话标题。请让它使用 Claude 模型，或者在那里也给 GPT-5.6 模型加上 `"think": true`。

## 可用的模型

kiro-provider 只为四个 Claude 模型把 `max_tokens` 传给 Kiro：`claude-opus-5-5`、`claude-opus-5`、`claude-sonnet-5` 和 `claude-fable-5-1`，范围是 1,024 到 128,000。加上 advisory header 后，`gpt-5.6-sol`、`gpt-5.6-terra` 和 `gpt-5.6-luna` 也能使用。Crush 的每个请求都带 `max_tokens`，所以其他模型会以关于它的 `invalid_request_error` 被拒绝。新增条目所需的数值可以从 `GET /v1/models` 获得：

```sh
curl -s http://127.0.0.1:8787/v1/models -H "Authorization: Bearer $KIRO_GATEWAY_API_KEY" |
  jq -r '.data[] | [.id, .context_limit, .output_limit] | @tsv'
```
