# kiro-provider

> 一个面向 OpenAI Responses 与 Anthropic Messages 客户端的独立 AWS Kiro（CodeWhisperer）HTTP 网关。

[![CI](https://github.com/sunerpy/kiro-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/sunerpy/kiro-provider/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/sunerpy/kiro-provider/branch/main/graph/badge.svg)](https://codecov.io/gh/sunerpy/kiro-provider)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)
[![Bun](https://img.shields.io/badge/runtime-bun-black)](https://bun.sh/)

简体中文 · [English](../../README.md)

## 目录

- [特性](#特性)
- [安装](#安装)
- [快速开始](#快速开始)
- [常驻后台服务](#常驻后台服务)
- [配置](#配置)
- [代理](#代理)
- [安全](#安全)
- [配合 LLM 使用](#配合-llm-使用)
- [配合 Codex CLI 使用](#配合-codex-cli-使用)
- [配合 Claude Code 使用](#配合-claude-code-使用)
- [开发](#开发)
- [许可证](#许可证)

## 特性

- OpenAI Responses `POST /v1/responses` 与 Anthropic Messages `POST /v1/messages`（均支持流式和非流式），以及 `POST /v1/messages/count_tokens`、`GET /v1/models`、`GET /health` 和需鉴权的 `GET /ready`。
- 旧版 OpenAI Chat Completions 位于 `POST /v1/chat/completions`，默认关闭，必须通过 `enable_legacy_chat_completions` 显式开启。
- Bearer API Key 校验，且默认拒绝启动：未配置任何 Key 时服务不会启动，默认绑定地址为 `127.0.0.1`。
- 默认实时复用 OpenCode 认证：`auth_source: "opencode-shared"` 直接读取同一个 `~/.config/opencode/kiro.db`，遵守墓碑、更新共享健康/用量状态，并使用与 `opencode-kiro-auth` v0.20.6 兼容的刷新锁。
- 标准字段驱动的会话亲和：Codex/OpenAI、OpenCode、Claude Code 无需私有 Header、Cookie 或客户端补丁，即可尽可能复用持久化的账号绑定与 Kiro `conversationId`。
- 账号级调度与 keep-alive 连接池：不同账号可以并行，同一账号上的 Kiro 流不会重叠；访问令牌刷新只更新缓存客户端的令牌，不重建连接池。
- 零 provider 自有提示词注入：协议适配器只保留客户端文本和结构化字段；无法严格映射的能力返回显式错误，不靠隐藏指令模拟。
- 多账号轮询、自动令牌刷新与故障切换。共享模式以 OpenCode 数据库为认证事实源，provider 数据库只保存会话亲和等状态。
- 显式设置 `auth_source: "local"` 后仍可使用 `kiro-provider login` 与 `accounts import`；导入结果只是快照，不能与实时共享认证混为一谈。
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

1. **先通过 OpenCode 登录 Kiro。** 默认共享认证模式直接使用 OpenCode
   的实时账号数据库：

   ```bash
   opencode auth login
   ```

   选择 Kiro 并完成正常登录。如果你明确需要一份独立的兼容存储，则设置
   `"auth_source": "local"`，再执行：

   ```bash
   ./dist/kiro-provider login
   # 或创建一次性快照：
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

4. **调用默认开放的 Responses 接口。**

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

   const response = await client.responses.create({
     model: "auto",
     input: "解释这个仓库。",
   });

   console.log(response.output_text);
   ```

   只实现 Chat Completions 的 OpenAI 兼容库，需要先在网关配置中设置
   `"enable_legacy_chat_completions": true`。例如用
   [Vercel AI SDK](https://sdk.vercel.ai/) 配合
   `@ai-sdk/openai-compatible`：

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

## 常驻后台服务

在 Agent 主机上，建议每个系统用户只运行**一个长期存活的 provider**，再让
Codex、OpenCode、Claude Code、Zuno 等客户端都连接这个本机端点。不要为每个
Agent 或每段会话分别启动 provider。单一常驻进程可以让这些标准客户端共享
已持久化的会话/账号亲和状态，以及进程内按账号划分的 keep-alive 连接池。
这仍然只是尽可能复用连接，并不保证每个请求都使用同一条物理 TCP 连接。

常驻部署建议使用固定版本的独立二进制，不要在每次启动时通过 `bunx` 临时
拉取。以下示例采用发布安装脚本的默认路径：

- Linux 二进制：`~/.local/bin/kiro-provider`；
- Windows 二进制：`%USERPROFILE%\.local\bin\kiro-provider.exe`；
- 配置文件：`~/.config/kiro-provider/config.json`；
- 服务/任务名称：`kiro-provider`。

服务必须以执行过 `opencode auth login` 的**同一个系统用户**运行。默认的
`auth_source: "opencode-shared"` 会根据该用户的 home/XDG 目录定位 OpenCode
数据库；如果改成 `root`、`LocalSystem` 或其他用户，通常会读到另一套凭证。
服务定义中应使用绝对路径；API Key 保存在受保护的配置文件中，不要写进服务
参数。如果服务环境中的 XDG 配置不同，请显式设置 `opencode_auth_db_path`。

### Linux：systemd 用户服务

先检查二进制与配置文件：

```bash
test -x "$HOME/.local/bin/kiro-provider"
test -r "$HOME/.config/kiro-provider/config.json"
chmod 600 "$HOME/.config/kiro-provider/config.json"
```

安装一个 [systemd 用户服务](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)：

```bash
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
install -d -m 700 "$SERVICE_DIR"
cat > "$SERVICE_DIR/kiro-provider.service" <<'EOF'
[Unit]
Description=kiro-provider local Kiro gateway

[Service]
Type=exec
ExecStart=%h/.local/bin/kiro-provider serve --config %h/.config/kiro-provider/config.json
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
UMask=0077

[Install]
WantedBy=default.target
EOF
chmod 600 "$SERVICE_DIR/kiro-provider.service"

systemctl --user daemon-reload
systemctl --user enable --now kiro-provider.service
```

如果二进制或配置不在上述位置，请把 `ExecStart` 改为对应的绝对路径。使用
自定义 `XDG_CONFIG_HOME` 时，还应加入
`Environment=XDG_CONFIG_HOME=/absolute/path`，或显式配置
`opencode_auth_db_path`。

日常操作与日志查看：

```bash
systemctl --user is-active kiro-provider.service
systemctl --user restart kiro-provider.service
journalctl --user -u kiro-provider.service -n 100 --no-pager
```

用户服务通常随该用户的 service manager 启动。如果要求系统启动时就运行，
并且用户退出登录后仍保持常驻，可让管理员在确认机器安全策略后执行
`loginctl enable-linger <user>`。

移除服务：

```bash
systemctl --user disable --now kiro-provider.service
rm "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/kiro-provider.service"
systemctl --user daemon-reload
```

### Windows：当前用户计划任务

`kiro-provider.exe` 是普通前台程序，并没有实现原生 Windows Service Control
Manager 接口，因此不要直接用 `sc.exe` 注册。无需第三方依赖的内置方案，是
创建一个[计划任务](https://learn.microsoft.com/powershell/module/scheduledtasks/register-scheduledtask)：
当前用户登录时启动，进程失败后自动重启。

请使用拥有 OpenCode 凭证的同一用户打开 PowerShell，执行以下命令。它会创建
一个小型启动脚本，并把 stdout/stderr 保存在
`%LOCALAPPDATA%\kiro-provider`：

```powershell
$Binary = Join-Path $HOME ".local\bin\kiro-provider.exe"
$Config = Join-Path $HOME ".config\kiro-provider\config.json"
$ServiceDir = Join-Path $HOME ".config\kiro-provider"
$LogDir = Join-Path $env:LOCALAPPDATA "kiro-provider"
$Launcher = Join-Path $ServiceDir "service.ps1"

if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) {
  throw "kiro-provider binary not found: $Binary"
}
if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) {
  throw "kiro-provider config not found: $Config"
}

New-Item -ItemType Directory -Force -Path $ServiceDir, $LogDir | Out-Null
@'
$ErrorActionPreference = "Stop"
$Binary = Join-Path $HOME ".local\bin\kiro-provider.exe"
$Config = Join-Path $HOME ".config\kiro-provider\config.json"
$LogDir = Join-Path $env:LOCALAPPDATA "kiro-provider"
$Log = Join-Path $LogDir "service.log"
$PreviousLog = Join-Path $LogDir "service.previous.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
if ((Test-Path -LiteralPath $Log) -and ((Get-Item -LiteralPath $Log).Length -gt 10MB)) {
  Move-Item -Force -LiteralPath $Log -Destination $PreviousLog
}

& $Binary serve --config $Config *>> $Log
exit $LASTEXITCODE
'@ | Set-Content -LiteralPath $Launcher -Encoding UTF8

$User = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$PowerShell = (Get-Command powershell.exe).Source
$Action = New-ScheduledTaskAction `
  -Execute $PowerShell `
  -Argument ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $Launcher)
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
$Principal = New-ScheduledTaskPrincipal `
  -UserId $User `
  -LogonType Interactive `
  -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable

Stop-ScheduledTask -TaskName "kiro-provider" -ErrorAction SilentlyContinue
Register-ScheduledTask `
  -TaskName "kiro-provider" `
  -Action $Action `
  -Trigger $Trigger `
  -Principal $Principal `
  -Settings $Settings `
  -Description "Local AWS Kiro gateway for AI agents" `
  -Force | Out-Null
Start-ScheduledTask -TaskName "kiro-provider"
```

查看状态、重启和跟踪日志：

```powershell
Get-ScheduledTask -TaskName "kiro-provider" | Get-ScheduledTaskInfo
Stop-ScheduledTask -TaskName "kiro-provider"
Start-ScheduledTask -TaskName "kiro-provider"
Get-Content "$env:LOCALAPPDATA\kiro-provider\service.log" -Tail 100 -Wait
```

移除任务与启动脚本：

```powershell
Stop-ScheduledTask -TaskName "kiro-provider" -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "kiro-provider" -Confirm:$false
Remove-Item "$HOME\.config\kiro-provider\service.ps1"
```

这个任务有意只在当前用户的交互式会话中运行，因此无需保存 Windows 密码，
并可直接使用该用户的网络权限与 OpenCode 凭证。如果必须在用户登录前运行，
则需要 Windows 服务包装器和一个经过明确配置的用户账号；不要让
`LocalSystem` 运行后仍假设它能读取原用户的 OpenCode 数据库。

### 健康检查与自动化契约

安装任一服务后，都应同时检查进程存活状态和需鉴权的就绪状态：

```bash
curl -fsS http://127.0.0.1:8787/health
curl -fsS http://127.0.0.1:8787/ready \
  -H 'Authorization: Bearer sk-your-private-key'
```

对应的 PowerShell 命令：

```powershell
Invoke-RestMethod "http://127.0.0.1:8787/health"
$Headers = @{ Authorization = "Bearer sk-your-private-key" }
Invoke-RestMethod "http://127.0.0.1:8787/ready" -Headers $Headers
```

AI Agent 或安装器只有在以下条件全部满足后，才能认为配置成功：

1. 二进制和显式配置路径都存在；
2. 服务/任务由拥有凭证的用户运行；
3. `/health` 调用成功；
4. 带鉴权的 `/ready` 调用成功，证明认证源可读且至少有一个活跃账号。

固定使用上面的服务/任务名称，可以让重复配置保持幂等。配置或二进制更新后
应重启服务。不要让客户端负责启动一份私有 provider 进程；客户端只需要配置
稳定的 base URL 与网关 API Key。

## 配置

配置默认从 `~/.config/kiro-provider/config.json`（或 `$XDG_CONFIG_HOME/kiro-provider/config.json`）加载，可被 `KIRO_PROVIDER_*` 环境变量覆盖；`serve` 命令还支持部分 CLI 参数覆盖。优先级为 **CLI 参数 > 环境变量 > 配置文件 > schema 默认值**。

| 字段 | 默认值 | 环境变量 |
| --- | --- | --- |
| `host` | `127.0.0.1` | `KIRO_PROVIDER_HOST` |
| `port` | `8787` | `KIRO_PROVIDER_PORT` |
| `api_keys` | 必填，不可为空 | `KIRO_PROVIDER_API_KEYS` |
| `enable_legacy_chat_completions` | `false` | `KIRO_PROVIDER_ENABLE_LEGACY_CHAT_COMPLETIONS` |
| `auth_source` | `opencode-shared` | `KIRO_PROVIDER_AUTH_SOURCE` |
| `opencode_auth_db_path` | `null`（使用 OpenCode 默认路径） | `KIRO_PROVIDER_OPENCODE_AUTH_DB_PATH` |
| `proxy_url` | `null` | `KIRO_PROVIDER_PROXY_URL` |
| `default_region` | `us-east-1` | `KIRO_PROVIDER_DEFAULT_REGION` |
| `account_selection_strategy` | `lowest-usage` | `KIRO_PROVIDER_ACCOUNT_SELECTION_STRATEGY` |
| `session_affinity_ttl_ms` | `86400000` | `KIRO_PROVIDER_SESSION_AFFINITY_TTL_MS` |
| `session_affinity_max_entries` | `10000` | `KIRO_PROVIDER_SESSION_AFFINITY_MAX_ENTRIES` |
| `log_level` | `info` | `KIRO_PROVIDER_LOG_LEVEL` |

完整字段说明（包括重试/超时调优参数与仅用于测试的 `test_upstream_endpoint`）见 [`docs/readme/CONFIGURATION.zh.md`](CONFIGURATION.zh.md)。

## 代理

有些网络环境下某个模型系列可以直连，另一个系列却必须走代理（例如 GPT 直连、Claude 需要走审批过的出网代理）。设置 `proxy_url`（配置文件 / `KIRO_PROVIDER_PROXY_URL` / `serve --proxy`）即可让**所有**上游流量（模型调用、令牌刷新、设备码登录）都走同一个 HTTP(S) 代理；保持 `null` 则为直连。优先级与示例见 [`docs/readme/CONFIGURATION.zh.md`](CONFIGURATION.zh.md#代理)。

## 安全

- **默认拒绝启动。** 未配置至少一个非空 `api_keys` 时服务不会启动。OpenAI 路由要求 `Authorization: Bearer <key>`；Anthropic 路由还接受 `x-api-key: <key>`。
- **默认只监听本机。** `host` 默认为 `127.0.0.1`；只有在放在防火墙或带认证的反向代理之后时才应绑定 `0.0.0.0`。
- **认证事实源唯一。** 共享模式读写 OpenCode 现有 Kiro 数据库；schema 不兼容时默认拒绝启动，不会对该数据库执行 provider 自有迁移。
- **Provider 状态权限收紧。** `accounts.db`（及其 WAL / SHM 文件）创建时权限为 `0600`；共享模式下它保存亲和状态，而不是权威凭据。
- **日志不打印密钥。** 代理地址与账号令牌不会被打印；不要提交真实配置文件、账号数据库或网关 Key。

> **合规使用提示。** kiro-provider 复用的是你自己已认证的 AWS Kiro 账号，消耗的是你自己账号的额度。请只使用你自己的账号 —— 本项目不是用来共享或转卖他人 Kiro 使用权的工具，也不应用于绕过账号级别的用量限制。

## 配合 LLM 使用

新 OpenAI 客户端与 Codex 使用 `POST /v1/responses`；Anthropic 客户端与
Claude Code 使用 `POST /v1/messages`。只有在显式开启旧接口后，才应把
只支持 Chat Completions 的客户端（`@ai-sdk/openai-compatible`、旧版
LangChain 适配器，或采用该包的 OpenCode 自定义 provider）指向
`POST /v1/chat/completions`。

客户端不需要增加会话扩展字段。网关会优先读取协议已有的标准/原生字段，
缺失时使用首个用户回合生成不可逆指纹；数据库只保存指纹、账号绑定和 Kiro
`conversationId`。底层通过账号级 keep-alive 池“尽可能”复用连接，但 HTTP
与上游仍可能选择另一条物理 socket，不能把它理解成固定 TCP 连接保证。
在真正的响应状态存储完成前，Responses 的 `previous_response_id` 和
`conversation` 会明确返回 400，客户端应重传完整输入。

<details>
<summary>Agent 命令参考</summary>

- `kiro-provider serve [--config <path>] [--host <host>] [--port <port>] [--proxy <url>]` —— 启动网关。
- `kiro-provider login [--config <path>] [--start-url <url>] [--region <region>]` —— 仅用于本地兼容模式；共享模式会引导使用 `opencode auth login`。
- `kiro-provider accounts list` —— 列出本地兼容存储中的账号。
- `kiro-provider accounts import [--from <path>] [--config <path>]` —— 向本地兼容存储创建一次性快照。
- `kiro-provider accounts remove <id|email>` —— 从本地兼容存储删除账号。

契约：人类可读的状态行输出到 stdout，错误输出到 stderr，失败时返回非零退出码；`GET /v1/models`、`GET /health` 与需鉴权的 `GET /ready` 返回结构化 JSON。

</details>

## 配合 Codex CLI 使用

kiro-provider 的 `POST /v1/responses` 端点使用 OpenAI Responses 协议格式，因此 [Codex CLI](https://github.com/openai/codex)（已于 2026-08-22 使用 0.149.0-alpha.4.1 做真实端到端验证）可以把它当作自定义 `model_provider`（`wire_api = "responses"`）来用。用一个隔离的 `CODEX_HOME` 测试，绝不会碰到你真实的 `~/.codex` 配置：

```bash
export CODEX_TEST_ROOT="$(mktemp -d)"
export CODEX_HOME="$CODEX_TEST_ROOT/home"
export CODEX_SQLITE_HOME="$CODEX_TEST_ROOT/sqlite"
mkdir -p "$CODEX_HOME" "$CODEX_SQLITE_HOME"
export LOCALGW_KEY="sk-...你的网关 api key..."
cat > "$CODEX_HOME/config.toml" <<'EOF'
model = "gpt-5.6-sol"
model_provider = "localgw"
[model_providers.localgw]
name = "Local Gateway"
base_url = "http://127.0.0.1:8787/v1"
env_key = "LOCALGW_KEY"
wire_api = "responses"
EOF
codex exec --skip-git-repo-check "say hi"
```

需要网关先跑起来（`kiro-provider serve`），并且默认共享模式下 OpenCode
至少有一个可用 Kiro 账号，或显式本地兼容存储中已有账号。完整说明及现成
的隔离冒烟测试脚本（`scripts/codex-smoke.sh`）见
[`docs/readme/CODEX.zh.md`](CODEX.zh.md)。

## 配合 Claude Code 使用

Claude Code 使用 Anthropic Messages 协议，而不是 OpenAI Chat
Completions。把它指向网关根地址：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export ANTHROPIC_AUTH_TOKEN="sk-your-private-key"
claude
```

Anthropic 路由同时接受 `Authorization: Bearer <key>` 和
`x-api-key: <key>`。文本和工具调用会转换为 Anthropic SSE。网关不会伪造
extended-thinking 签名；`/v1/messages/count_tokens` 明确是估算值，响应会带
`x-kiro-token-count-mode: estimate`。详见
[`docs/readme/CLAUDE_CODE.zh.md`](CLAUDE_CODE.zh.md)。

OpenCode、Codex、Claude Code、共享认证、会话亲和与旧 Chat 开关的真实
验证记录见
[`docs/E2E_VALIDATION_2026-08-22.md`](../E2E_VALIDATION_2026-08-22.md)。

## 开发

```bash
bun install
bun run typecheck
bun test
bash scripts/security-check.sh   # 安全回归测试（Linux，需要 openssl/curl/ss）
```

## 许可证

[MIT](../../LICENSE)
