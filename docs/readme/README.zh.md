# kiro-provider

> 一个独立的、OpenAI 兼容的 AWS Kiro（CodeWhisperer）HTTP 网关 —— 用任意 OpenAI SDK 或 Agent 直接调用你自己的 Kiro 账号。

[![CI](https://github.com/sunerpy/kiro-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/sunerpy/kiro-provider/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/sunerpy/kiro-provider/branch/main/graph/badge.svg)](https://codecov.io/gh/sunerpy/kiro-provider)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)
[![Bun](https://img.shields.io/badge/runtime-bun-black)](https://bun.sh/)

简体中文 · [English](../../README.md)

## 目录

- [特性](#特性)
- [安装](#安装)
- [快速开始](#快速开始)
- [配置](#配置)
- [代理](#代理)
- [安全](#安全)
- [配合 LLM 使用](#配合-llm-使用)
- [开发](#开发)
- [许可证](#许可证)

## 特性

- OpenAI 兼容的 `POST /v1/chat/completions`（流式 SSE 与非流式 JSON）、`GET /v1/models`、`GET /health`。
- Bearer API Key 校验，且默认拒绝启动：未配置任何 Key 时服务不会启动，默认绑定地址为 `127.0.0.1`。
- 多账号轮询、自动令牌刷新与故障切换，账号数据落在本地 `bun:sqlite`，删除采用墓碑标记，防止被同步逻辑复活。
- `accounts import` 可复用 [OpenCode 的 Kiro 认证](https://opencode.ai/) 已登录的账号，无需再走一次设备码登录。
- 单一全局 `proxy_url`：一旦设置，所有上游出网流量（模型请求、令牌刷新、设备码登录）都会走同一个 HTTP(S) 代理。
- 通过 `bun build --compile` 打包为单文件可执行文件，目标机器无需额外运行时依赖。

## 安装

三种渠道任选其一。

### 1. bunx / bun（最简单，需要 Bun）

kiro-provider 发布的 npm 包用了 Bun 专属 API（`bun:sqlite`、`Bun.serve`），因此只能用 **Bun 或 `bunx` 运行，不支持 `npx` 或纯 `node`**。先安装 [Bun](https://bun.sh/)，然后：

```bash
bunx @sunerpy/kiro-provider serve --help
```

或者全局安装：

```bash
bun add -g @sunerpy/kiro-provider
kiro-provider --help
```

### 2. 预编译二进制（无依赖）

每次发布都会为 `linux`（x64、arm64）、`darwin`（x64、arm64）、`windows`（x64）打包独立二进制。从 [Releases](https://github.com/sunerpy/kiro-provider/releases/latest) 下载对应平台的文件，`chmod +x` 后直接运行，运行时不需要 Bun 或 Node.js。

一行安装（Linux/macOS）：

```bash
curl -fsSL https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.sh | sh
```

Windows（PowerShell）：

```powershell
irm https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.ps1 | iex
```

两个脚本都会从 `releases/latest/download/` 拉取对应资产，默认安装到 `~/.local/bin`（可用 `KIRO_PROVIDER_INSTALL_DIR` 覆盖）。

### 3. 从源码构建（开发者）

需要 [Bun](https://bun.sh/)。

```bash
git clone https://github.com/sunerpy/kiro-provider.git
cd kiro-provider
bun install
bun run build:binary
./dist/kiro-provider --help
```

也可以不编译，直接从源码运行：

```bash
bun install
bun run src/cli/bin.ts --help
```

本文档后续用 `./dist/kiro-provider` 泛指以上任一渠道；请根据你使用的渠道替换为 `bunx @sunerpy/kiro-provider`、已安装的二进制路径，或 `bun run src/cli/bin.ts`。

## 快速开始

1. **先把一个账号放进本地存储。** 可以交互式登录：

   ```bash
   ./dist/kiro-provider login
   ```

   或直接导入 OpenCode 已认证过的账号：

   ```bash
   ./dist/kiro-provider accounts import
   ```

2. **创建配置文件并写入你自己的 API Key。**

   ```bash
   mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider"
   cp config.example.json "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json"
   # 编辑 config.json，把 "sk-REPLACE-ME" 换成一个私有的随机 Key
   ```

3. **启动网关。**

   ```bash
   ./dist/kiro-provider serve
   ```

4. **用 OpenAI 兼容客户端调用。**

   ```bash
   curl -fsS http://127.0.0.1:8787/v1/models \
     -H 'Authorization: Bearer sk-your-private-key'
   ```

   ```ts
   import OpenAI from "openai";

   const client = new OpenAI({
     baseURL: "http://127.0.0.1:8787/v1",
     apiKey: "sk-your-private-key",
   });

   const completion = await client.chat.completions.create({
     model: "auto",
     messages: [{ role: "user", content: "Explain this repository." }],
   });

   console.log(completion.choices[0]?.message.content);
   ```

   也可以用 [Vercel AI SDK](https://sdk.vercel.ai/) 配合 `@ai-sdk/openai-compatible`：

   ```ts
   import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
   import { generateText } from "ai";

   const kiro = createOpenAICompatible({
     name: "kiro-provider",
     baseURL: "http://127.0.0.1:8787/v1",
     apiKey: "sk-your-private-key",
   });

   const { text } = await generateText({
     model: kiro("auto"),
     prompt: "Explain this repository.",
   });
   ```

## 配置

配置默认从 `~/.config/kiro-provider/config.json`（或 `$XDG_CONFIG_HOME/kiro-provider/config.json`）加载，可被 `KIRO_PROVIDER_*` 环境变量覆盖；`serve` 命令还支持部分 CLI 参数覆盖。优先级为 **CLI 参数 > 环境变量 > 配置文件 > schema 默认值**。

| 字段 | 默认值 | 环境变量 |
| --- | --- | --- |
| `host` | `127.0.0.1` | `KIRO_PROVIDER_HOST` |
| `port` | `8787` | `KIRO_PROVIDER_PORT` |
| `api_keys` | 必填，不可为空 | `KIRO_PROVIDER_API_KEYS` |
| `proxy_url` | `null` | `KIRO_PROVIDER_PROXY_URL` |
| `default_region` | `us-east-1` | `KIRO_PROVIDER_DEFAULT_REGION` |
| `account_selection_strategy` | `lowest-usage` | `KIRO_PROVIDER_ACCOUNT_SELECTION_STRATEGY` |
| `log_level` | `info` | `KIRO_PROVIDER_LOG_LEVEL` |

完整字段说明（包括重试/超时调优参数与仅用于测试的 `test_upstream_endpoint`）见 [`docs/readme/CONFIGURATION.zh.md`](CONFIGURATION.zh.md)。

## 代理

有些网络环境下某个模型系列可以直连，另一个系列却必须走代理（例如 GPT 直连、Claude 需要走审批过的出网代理）。设置 `proxy_url`（配置文件 / `KIRO_PROVIDER_PROXY_URL` / `serve --proxy`）即可让**所有**上游流量（模型调用、令牌刷新、设备码登录）都走同一个 HTTP(S) 代理；保持 `null` 则为直连。优先级与示例见 [`docs/readme/CONFIGURATION.zh.md`](CONFIGURATION.zh.md#代理)。

## 安全

- **默认拒绝启动。** 未配置至少一个非空 `api_keys` 时服务不会启动，所有路由都要求 `Authorization: Bearer <key>`。
- **默认只监听本机。** `host` 默认为 `127.0.0.1`；只有在放在防火墙或带认证的反向代理之后时才应绑定 `0.0.0.0`。
- **账号存储权限收紧。** `accounts.db`（及其 WAL / SHM 文件）创建时权限为 `0600`。
- **日志不打印密钥。** 代理地址与账号令牌不会被打印；不要提交真实配置文件、账号数据库或网关 Key。

> **合规使用提示。** kiro-provider 复用的是你自己已认证的 AWS Kiro 账号，消耗的是你自己账号的额度。请只使用你自己的账号 —— 本项目不是用来共享或转卖他人 Kiro 使用权的工具，也不应用于绕过账号级别的用量限制。

## 配合 LLM 使用

将任意 OpenAI 兼容客户端（`openai`、`@ai-sdk/openai-compatible`、LangChain 等）的 base URL 指向 `http://<host>:<port>/v1`，Key 用配置好的 `api_keys` 之一。

<details>
<summary>Agent 命令参考</summary>

- `kiro-provider serve [--config <path>] [--host <host>] [--port <port>] [--proxy <url>]` —— 启动网关。
- `kiro-provider login [--config <path>] [--start-url <url>] [--region <region>]` —— 设备码登录（AWS Builder ID，或带 `--start-url` 的 IAM Identity Center）。
- `kiro-provider accounts list` —— 列出已存储账号及其健康状态。
- `kiro-provider accounts import [--from <path>] [--config <path>]` —— 从 OpenCode 的 `kiro.db` 导入账号（默认源：`~/.config/opencode/kiro.db`）。
- `kiro-provider accounts remove <id|email>` —— 删除单个账号（写入墓碑标记）。

契约：人类可读的状态行输出到 stdout，错误输出到 stderr，失败时返回非零退出码；`GET /v1/models` 与 `GET /health` 返回结构化 JSON。

</details>

## 开发

```bash
bun install
bun run typecheck
bun test
bash scripts/security-check.sh   # 安全回归测试（Linux，需要 openssl/curl/ss）
```

## 许可证

[MIT](../../LICENSE)
