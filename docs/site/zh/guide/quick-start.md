# 快速开始

本页从已安装的 `kiro-provider` 开始，一步步得到第一个回答：设定一个密钥、登录一个账号、启动网关，再通过两种接口各发一个请求。阅读前请先完成[安装](install.md)。

## 1. 为客户端设定密钥

`api_keys` 中至少要有一个密钥，否则网关拒绝启动。每个客户端都要发送其中一个密钥，因此请使用足够长的随机值并妥善保管。它不是 Kiro 或 AWS 的凭据。

```sh
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider"
cat > "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json" <<'EOF'
{
  "api_keys": ["sk-replace-with-a-private-random-key"]
}
EOF
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json"
```

Windows 上的文件是 `%APPDATA%\kiro-provider\config.json`。其他字段都有默认值；[`config.example.json`](../../../../config.example.json) 和[配置参考](../../../readme/CONFIGURATION.zh-CN.md)列出了全部字段。

## 2. 登录 Kiro

```sh
kiro-provider login
```

`login` 会打印 `Open this URL to sign in:` 和一个链接。打开链接，确认页面上的代码一致，然后用 AWS Builder ID 登录；命令会一直等待，完成后打印 `Login successful:` 和该账号的邮箱。如果组织使用 IAM Identity Center，请传入它的起始 URL 和区域：

```sh
kiro-provider login --start-url https://example.awsapps.com/start --region us-east-1
```

kiro-provider 会查找你的 Kiro profile，并把账号保存到自己的数据库中。如果该身份有多个 profile，它会在保存任何内容之前停止，并提示你加上 `--profile-arn <arn>` 重新运行。每增加一个账号就再运行一次 `login`；从 OpenCode 导入账号以及登录之后的操作见[账号](accounts.md)。

## 3. 启动网关

```sh
kiro-provider serve
```

它监听 `http://127.0.0.1:8787`，并打印 `Listening on http://127.0.0.1:8787`。日志以每行一个 JSON 对象的形式写到标准错误。在另一个终端中确认它在运行、并且有可用的账号：

```sh
export KIRO_GATEWAY_API_KEY='sk-replace-with-a-private-random-key'
curl -fsS http://127.0.0.1:8787/health
curl -fsS http://127.0.0.1:8787/ready -H "Authorization: Bearer $KIRO_GATEWAY_API_KEY"
```

`/health` 不需要密钥，返回 `{"status":"ok"}`。`/ready` 需要密钥，只有在至少一个账号可用、且网关的数据库和密钥文件可用时才返回 HTTP 200。

如果希望退出登录后网关仍在运行，请把它安装为[后台服务](../../../readme/SERVICE.zh-CN.md)。

## 4. 发送第一个请求

通过 OpenAI Responses：

```sh
curl -s http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer $KIRO_GATEWAY_API_KEY" \
  --json '{"model": "gpt-5.6-sol", "store": false, "input": "Reply with exactly: KIRO_OK"}'
```

通过 Anthropic Messages：

```sh
curl -s http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: $KIRO_GATEWAY_API_KEY" \
  --json '{"model": "claude-opus-5-5", "max_tokens": 1024,
           "messages": [{"role": "user", "content": "Reply with exactly: KIRO_OK"}]}'
```

`--json` 需要 curl 7.82 或更高版本。两个回答中都包含 `KIRO_OK`。用 OpenAI 的 JavaScript SDK 发送同一个请求：

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

`store: false` 让请求经由 kiro-provider 自己的转换处理，Codex CLI 发送的请求也是这样。不带这个字段时，请求会发往 Kiro 自己的 Responses 操作，网关会保存响应，供之后取回和继续对话。Kiro 可能对某个账号拒绝该操作，表现为 `403 access_denied`；两条路径的区别见[协议兼容性](../../../readme/PROTOCOL_COMPATIBILITY.zh-CN.md)。

模型名称来自你的账号。`GET /v1/models` 列出它们可用的模型，其中包括 `auto`，以及有推理等级的模型按等级区分的名称，例如 `claude-opus-5-5-high`。

## 5. 连接你的 Agent

- [Codex CLI](../../../readme/CODEX.zh-CN.md)：配置一个 `wire_api = "responses"` 的 `model_provider`。
- [Claude Code](../../../readme/CLAUDE_CODE.zh-CN.md)：使用 `kiroclaude` 启动器。
- [Zuno](../../../readme/ZUNO.zh-CN.md)：配置一个 `surface: "responses"` 的 provider。
- 其他客户端：见[选择客户端](../clients/index.md)。
