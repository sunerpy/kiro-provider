# 选择客户端

每个客户端需要的都是同样两样东西：网关的地址，以及 `api_keys` 中的一个密钥。客户端里不需要安装任何东西。

| 客户端        | 接口               | 基础 URL                   | 指南                                                |
| ------------- | ------------------ | -------------------------- | --------------------------------------------------- |
| Codex CLI     | OpenAI Responses   | `http://127.0.0.1:8787/v1` | [Codex CLI](../../../readme/CODEX.zh-CN.md)         |
| Claude Code   | Anthropic Messages | `http://127.0.0.1:8787`    | [Claude Code](../../../readme/CLAUDE_CODE.zh-CN.md) |
| OpenCode      | Anthropic Messages | `http://127.0.0.1:8787/v1` | [OpenCode](opencode.md)                             |
| Pi            | OpenAI Responses   | `http://127.0.0.1:8787/v1` | [Pi](pi.md)                                         |
| Crush         | Anthropic Messages | `http://127.0.0.1:8787`    | [Crush](crush.md)                                   |
| Zuno          | OpenAI Responses   | `http://127.0.0.1:8787/v1` | [Zuno](../../../readme/ZUNO.zh-CN.md)               |
| OpenAI SDK    | OpenAI Responses   | `http://127.0.0.1:8787/v1` | [见下文](#sdk)                                      |
| Anthropic SDK | Anthropic Messages | `http://127.0.0.1:8787`    | [见下文](#sdk)                                      |

基础 URL 取决于客户端在它后面追加什么。Claude Code、Crush 和 Anthropic SDK 追加 `/v1/messages`；OpenCode 的 `@ai-sdk/anthropic` 只追加 `/messages`，所以它的基础 URL 保留 `/v1`。

客户端的新版本可能改变它发送的请求；如果新增的字段暂不支持，网关会在带类型的错误中写明该字段，而不是忽略它。

## 密钥

网关在每个路由上都接受 `Authorization: Bearer <key>` 或 `x-api-key: <key>` 两种形式，因此两类 SDK 都无需改动。每个密钥各自是一个独立的租户：用一个密钥产生的保存响应、会话绑定和推理历史，对使用另一个密钥的请求不可见。为每个客户端分配单独的密钥可以把它们隔开；继续一段对话时，必须使用开始它的那个密钥。

## 模型名称

`GET /v1/models` 列出你的账号可用的模型。除了 `gpt-5.6-sol`、`claude-opus-5-5` 这样的普通名称，它还列出 `auto`，以及有推理等级的模型按等级区分的名称，例如 `claude-opus-5-5-high`。Codex CLI 的 `/model` 菜单从同一个列表读取推理等级，加载方法见 [Codex 指南](../../../readme/CODEX.zh-CN.md#切换模型与推理等级)。

对话中途可以切换模型或推理等级：可见的历史和工具调用会保留，新模型无法读取的推理内容会被省略，并在响应头中说明。具体规则见[配置参考](../../../readme/CONFIGURATION.zh-CN.md#切换模型与推理等级)。

## SDK

OpenAI 的 JavaScript SDK：

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

Anthropic 的 JavaScript SDK。它的基础 URL 不带 `/v1`，因为 SDK 会自己加上：

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

kiro-provider 只为 `claude-opus-5-5`、`claude-opus-5`、`claude-sonnet-5` 和 `claude-fable-5-1` 把 `max_tokens` 传给 Kiro，范围是 1,024 到 128,000；超出范围的值会被拒绝，而不是被改写。对其他模型，Kiro 没有 kiro-provider 可以设置的输出上限，而每个 Messages 请求都带 `max_tokens`，所以 Messages 只提供这四个模型；请求带有 `x-kiro-output-token-limit-mode: advisory` header 时，还可以使用 GPT-5.6 模型（[OpenCode](opencode.md) 中有设置示例）。在 Responses 上，`max_output_tokens` 遵循同样的规则，但它是可选的；不带它的请求可以使用所有模型。

## 为 Kiro 单独准备的命令

[客户端启动器](../../../readme/CLIENT_LAUNCHERS.zh-CN.md)会在你已有的 `codex` 和 `claude` 旁边建立 `kirocodex` 和 `kiroclaude` 命令，各自使用单独的主目录，你平时的会话和设置因此保持不变。

## 其他客户端

任何支持 OpenAI Responses 或 Anthropic Messages 的客户端都可以尝试使用同样的基础 URL。[协议兼容性](../../../readme/PROTOCOL_COMPATIBILITY.zh-CN.md)列出了支持哪些请求字段。只支持 Chat Completions 的客户端需要用 `enable_legacy_chat_completions` 开启该路由；它不携带 Responses 的会话元数据。
