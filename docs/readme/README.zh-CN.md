<div align="center">

<img src="../site/public/kiro-provider-logo.svg" alt="" width="72" />

# kiro-provider

### 让支持 OpenAI Responses 或 Anthropic Messages 的客户端使用你自己的 AWS Kiro 账号

[![CI](https://github.com/sunerpy/kiro-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/sunerpy/kiro-provider/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/sunerpy/kiro-provider)](https://github.com/sunerpy/kiro-provider/releases)
[![npm](https://img.shields.io/npm/v/%40sunerpy%2Fkiro-provider)](https://www.npmjs.com/package/@sunerpy/kiro-provider)
[![codecov](https://codecov.io/gh/sunerpy/kiro-provider/branch/main/graph/badge.svg)](https://codecov.io/gh/sunerpy/kiro-provider)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)

[网站](https://firlab.app/kiro-provider/zh/) · [安装](#安装) · [快速开始](#快速开始) · [接入客户端](#接入-agent-客户端) · [文档](#文档)

[English](../../README.md) · [**简体中文**](./README.zh-CN.md)

</div>

---

kiro-provider 是运行在你自己机器上的网关。它登录 AWS Kiro，保管你添加的每个账号的令牌，并以 OpenAI Responses 和
Anthropic Messages 接口提供这些账号，Codex CLI、Claude Code、OpenCode、Pi、Crush、Zuno 和官方 SDK 只需配置一个地址和一个密钥即可使用。

## 特性

- **一个网关，两种接口。** `POST /v1/responses` 和 `POST /v1/messages`，支持流式与非流式、工具、图片和推理等级。
  Chat Completions 作为可选开启的旧路由提供。
- **直接登录。** 以设备码方式登录 AWS Builder ID 和 IAM Identity Center。kiro-provider 自己查找 Kiro profile，不需要 Kiro CLI。
- **多个账号，一个地址。** 请求交给最空闲的可用账号；令牌在后台续期、用量在后台刷新，额度用完的账号会暂停使用，直到额度重置。
- **失败即关闭。** 无法完整送达 Kiro 的字段会让请求以写明该字段的带类型错误失败，不会被悄悄丢弃。
- **对话可以延续。** 保存的响应和加密的 reasoning 回放让客户端可以继续对话、切换模型或推理等级，并在重启后恢复。
- **按需联网搜索。** 两种接口的托管联网搜索工具由 kiro-provider 通过你自己的账号执行，默认关闭。
- **可校验的发布。** Linux、macOS 和 Windows 的独立二进制附带 `SHA256SUMS` 和构建证明，`self-update` 只在校验和一致时才替换二进制。

## 安装

安装脚本会下载当前平台的发布二进制，用该版本的 `SHA256SUMS` 校验，然后放到 `~/.local/bin`（可用
`KIRO_PROVIDER_INSTALL_DIR` 修改）。

Linux 或 macOS：

```bash
curl -fsSL https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.sh | sh
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.ps1 | iex
```

使用 [Bun](https://bun.sh)。npm 包使用 Bun 的 API，不能在 Node.js 或 `npx` 下运行：

```bash
bun add -g @sunerpy/kiro-provider
```

设置 `KIRO_PROVIDER_VERSION` 可以固定版本，长期运行的服务应当这样做。固定版本、校验构建证明、从源码构建和卸载见网站上的
[安装指南](https://firlab.app/kiro-provider/zh/guide/install)。

## 快速开始

1. 为客户端设定一个密钥，没有密钥时网关拒绝启动：

   ```bash
   mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider"
   cat > "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json" <<'EOF_CONFIG'
   {
     "api_keys": ["sk-replace-with-a-private-random-key"]
   }
   EOF_CONFIG
   chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json"
   ```

   Windows 上的文件是 `%APPDATA%\kiro-provider\config.json`。

2. 登录 Kiro。使用 IAM Identity Center 时加上 `--start-url <url> --region <region>`，身份有多个 profile 时再加上
   `--profile-arn <arn>`：

   ```bash
   kiro-provider login
   ```

   `opencode-kiro-auth` 中的账号可以用 `kiro-provider accounts import` 一次性复制过来。

3. 启动网关，并确认有可用的账号：

   ```bash
   kiro-provider serve
   ```

   ```bash
   export KIRO_GATEWAY_API_KEY='sk-replace-with-a-private-random-key'
   curl -fsS http://127.0.0.1:8787/health
   curl -fsS http://127.0.0.1:8787/ready -H "Authorization: Bearer $KIRO_GATEWAY_API_KEY"
   ```

4. 发送一个请求：

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

   `store: false` 让请求经由 kiro-provider 自己的转换处理，Codex CLI 也是这样发送的。不带它时，请求会发往 Kiro 原生的
   Responses 操作，而 Kiro 可能对某个账号以 `403 access_denied` 拒绝该操作。`GET /v1/models` 列出你的账号可用的模型名称。

网站上的[快速开始](https://firlab.app/kiro-provider/zh/guide/quick-start)逐步说明了每一步，并附有 Anthropic Messages 请求的示例。

## 接入 Agent 客户端

| 客户端      | 接口                  | 指南                                                               |
| ----------- | --------------------- | ------------------------------------------------------------------ |
| Codex CLI   | OpenAI Responses      | [隔离配置与模型切换](CODEX.zh-CN.md)                               |
| Claude Code | Anthropic Messages    | [共享状态的 `kiroclaude` 启动器与模型选择](CLAUDE_CODE.zh-CN.md)   |
| OpenCode    | Anthropic Messages    | [`opencode.json` 中的 provider](../site/zh/clients/opencode.md)    |
| Pi          | OpenAI Responses      | [`models.json` 中的 provider 与推理等级](../site/zh/clients/pi.md) |
| Crush       | Anthropic Messages    | [`crush.json` 中的 provider](../site/zh/clients/crush.md)          |
| Zuno        | OpenAI Responses      | [原生 Provider 配置与会话路由](ZUNO.zh-CN.md)                      |
| 其他 SDK    | Responses 或 Messages | [协议兼容范围](PROTOCOL_COMPATIBILITY.zh-CN.md)                    |

需要长期使用、各自拥有独立状态的 `kirocodex` 和 `kiroclaude` 命令时，参见[启动器示例](CLIENT_LAUNCHERS.zh-CN.md)。

## 兼容方式

| 路由                                                               | 默认状态                                      |
| ------------------------------------------------------------------ | --------------------------------------------- |
| `POST /v1/responses`，以及 retrieve、delete、input items 和 cancel | 开启                                          |
| `POST /v1/messages`、`POST /v1/messages/count_tokens`（估算值）    | 开启                                          |
| `POST /v1/chat/completions`                                        | 关闭；需设置 `enable_legacy_chat_completions` |
| `GET /v1/models`、`GET /health`、`GET /ready`                      | 开启                                          |

在默认的 `v3-auto` 模式下，Kiro 原生 Responses 操作能完整保留的 Responses 请求会发往那里；`store: false`、max effort、reasoning 回放以及其他只有 stateless 路径才能处理的请求走 provider 的 stateless 路径，所有 Messages 请求也是如此。无法保留的语义，例如联网搜索以外的托管工具、后台响应、conversation 对象和任意 JSON Schema 输出，都会以字段级错误拒绝。这并不承诺与 OpenAI 或 Anthropic 完全一致：[协议兼容范围](PROTOCOL_COMPATIBILITY.zh-CN.md)是当前契约，[审计索引](../audits/README.md)保存带日期的探测证据。

## 配置

配置优先级为 CLI 参数、环境变量、JSON 文件、schema 默认值。未知字段和无效取值会在启动时失败。可以从
[`config.example.json`](../../config.example.json) 开始，再到[配置参考](CONFIGURATION.zh-CN.md)查看全部字段、环境变量、超时、文件位置和协议开关。

## 状态与安全

- `api_keys` 为空时服务拒绝启动，默认只绑定 `127.0.0.1`。
- 凭据与账号状态保存在平台配置目录的 `accounts.db` 中。数据库及其 WAL/SHM 文件创建时只允许所属用户访问；JSON
  配置也应保持只有所属用户可读。
- 单实例锁会阻止两个网关在同一配置目录上拆分账号容量和对话状态。
- Reasoning 回放使用 AES-256-GCM 加密。日志不记录凭据、提示词、工具参数、签名或原始 reasoning。
- 配置 `proxy_url` 后，模型调用、登录、令牌刷新和额度探测统一经过该代理。

只应使用你自己控制的 Kiro 账号。本项目不用于共享或转卖访问权，也不用于绕过账号级用量限制。

## 更新

```bash
kiro-provider --version --check    # 查询最新版本
kiro-provider self-update          # 校验后替换独立二进制
bun add -g @sunerpy/kiro-provider@latest
```

`self-update` 会拒绝 npm 安装，也从不读取网关配置。更新后请重启网关；systemd 和 Windows 计划任务的步骤见[后台服务指南](SERVICE.zh-CN.md#升级服务二进制)。

## 文档

网站 [firlab.app/kiro-provider](https://firlab.app/kiro-provider/zh/) 提供中英文指南。仓库内的文档：

- [配置参考](CONFIGURATION.zh-CN.md)
- [后台服务](SERVICE.zh-CN.md)
- [排障手册](TROUBLESHOOTING.zh-CN.md)
- [Responses 用量与上下文统计](RESPONSES_USAGE.zh-CN.md)
- [架构说明（英文）](../ARCHITECTURE.md)
- [审计与验收记录](../audits/README.md)
- [更新日志](../../changelog/CHANGELOG-v3.x.md)

[文档索引](../README.md)链接了全部文档及其简体中文版本。

## 开发

```bash
git clone https://github.com/sunerpy/kiro-provider.git
cd kiro-provider
bun install --frozen-lockfile
make check
make coverage-gate
bun run build:binary
```

`make pre-ci` 会执行完整的本地 PR 门禁。仓库自有检查与 Codecov 都要求 93% 覆盖率；`codecov/project` 和
`codecov/patch` 是合并前的必需检查。实现、安全与发布约束见 [AGENTS.md](../../AGENTS.md)。

## 许可证

[MIT](../../LICENSE)
