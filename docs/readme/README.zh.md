# kiro-provider

> 一个基于 AWS Kiro（CodeWhisperer）、强调协议保真的 OpenAI Responses 与 Anthropic Messages 已验证子集网关。

[![CI](https://github.com/sunerpy/kiro-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/sunerpy/kiro-provider/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/sunerpy/kiro-provider/branch/main/graph/badge.svg)](https://codecov.io/gh/sunerpy/kiro-provider)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)
[![Bun](https://img.shields.io/badge/runtime-bun-black)](https://bun.sh/)

简体中文 · [English](../../README.md)

## 目录

- [特性](#特性)
- [协议兼容范围](#协议兼容范围)
- [安装](#安装)
- [快速开始](#快速开始)
- [常驻后台服务](#常驻后台服务)
- [配置](#配置)
- [代理](#代理)
- [安全](#安全)
- [配合 LLM 使用](#配合-llm-使用)
- [配合 Zuno 使用](#配合-zuno-使用)
- [配合 Codex CLI 使用](#配合-codex-cli-使用)
- [配合 Claude Code 使用](#配合-claude-code-使用)
- [开发](#开发)
- [许可证](#许可证)

## 特性

- OpenAI Responses `POST /v1/responses` 与 Anthropic Messages `POST /v1/messages`（均支持流式和非流式），以及 `POST /v1/messages/count_tokens`、`GET /v1/models`、`GET /health` 和需鉴权的 `GET /ready`。
- 旧版 OpenAI Chat Completions 位于 `POST /v1/chat/completions`，默认关闭，必须通过 `enable_legacy_chat_completions` 显式开启。
- Bearer API Key 校验，且默认拒绝启动：未配置任何 Key 时服务不会启动，默认绑定地址为 `127.0.0.1`。
- 默认实时复用 OpenCode 认证：`auth_source: "opencode-shared"` 直接读取同一个 `~/.config/opencode/kiro.db`，遵守墓碑、更新共享健康/用量状态，并复用 `opencode-kiro-auth` v0.20.7 的账号 schema 与刷新锁行为。
- 默认只使用显式会话亲和：Responses 可通过标准 `metadata`、兼容 `client_metadata` 或 `prompt_cache_key` 选择加入；没有显式键时绝不从提示词推导会话身份。配套的 Zuno 原生 OpenAI transport 会自动发送 `metadata.zuno_session_id`。
- 账号级调度与缓存的 SDK/transport 对象：不同账号可以并行，同一账号上的 Kiro 流不会重叠；访问令牌刷新只更新缓存客户端。Kiro 模型调用的 HTTP keep-alive 默认关闭，必须显式选择开启。
- 默认 `safe` 模式零 provider 自有提示词注入：统一输入 IR 保留客户端文本、
  角色、内容块边界、工具身份、顺序与来源路径；Kiro 输出先进入独立的统一
  completion/event IR，再编码为各外部协议。
- 对完整 Kiro 原生 reasoning envelope 提供加密回放：随机 `kr1_...` 令牌、AES-256-GCM、本租户/模型/账号/conversation/输出绑定、TTL/LRU 清理和回放账号锁定。
- 多账号轮询、自动令牌刷新与故障切换。共享模式以 OpenCode 数据库为认证事实源，provider 数据库只保存会话亲和等状态。
- 显式设置 `auth_source: "local"` 后仍可使用 `kiro-provider login` 与 `accounts import`；导入结果只是快照，不能与实时共享认证混为一谈。
- 单一全局 `proxy_url`：一旦设置，所有上游出网流量（模型请求、令牌刷新、设备码登录）都会走同一个 HTTP(S) 代理。
- 通过 `bun build --compile` 打包为单文件可执行文件，目标机器无需额外运行时依赖。

## 协议兼容范围

v0.5 明确定位为**经过验证的兼容子集**，不会接收字段后静默丢弃。默认
`protocol_projection_mode: "safe"` 不会前置或改写客户端指令、合并相邻
消息、清空重复 assistant 输出、删除 `{` 等尾部文本，也不会生成模型可见的
补偿说明。

主要边界：

- 普通文本、连续同角色回合、function/custom 工具声明、调用和结果保持原始
  结构与顺序；
- 同一消息包含多个顶层文本块时返回
  `unsupported_content_block_projection`；Kiro 只有一个文本字段，直接拼接
  会抹掉块边界；
- safe 模式下 `instructions`、`system`、`developer` 返回
  `unsupported_instruction_projection`，因为实测 Kiro 的
  `additionalContext` 通道被拒绝；
- 支持 `tool_choice: auto`；`parallel_tool_calls: false` 只在没有可调用工具
  （包括 `tool_choice: none`）时作为无副作用字段接受，否则返回
  `unsupported_parallel_tool_calls`；required/指定工具、strict schema、
  custom grammar 和 namespace 工具会被拒绝，不会被弱化；
- 支持 base64/data URL 图片；远程图片 URL 与 detail 控制会被拒绝；
- 输出 token 上限只对 `claude-sonnet-5` 变体的 1,024–128,000 范围完成探针
  确认；
- Stateful Responses 与 Kiro 原生 Web Search 仍不支持，Provider 不会伪造
  搜索或引用事件。

2026-08-27 编译后二进制的当前门禁：OpenAI JavaScript SDK 7.5.0 已通过
Responses、显式 Chat、function/custom 工具循环，以及服务重启后的加密
reasoning 回放。OpenCode Responses 仅在显式 `legacy-user-prefix` 且使用 Claude
Sonnet 5 时通过；OpenCode Chat 被非标准 `cache_control` 阻塞。Codex
0.149.0-alpha.4.1 首先被 `text.verbosity` 阻塞；捕获请求还包含未支持的
reasoning、工具串行化、grammar 与 namespace 控制。Claude Code 2.1.209 首先
发送 `output_config.format`，随后用非法的
`messages.1.role=system` 重试；同版本此前的脱敏 capture 还包含
`context_management`。RC.2 按明确范围未重跑 Zuno，也没有修改 Zuno 源码或
配置。这些是 RC 结论；稳定版 v0.5.0 继续保持门禁，不会靠静默丢弃或搬移
字段换取“通过”。

完整能力矩阵、错误码、reasoning 回放契约与 v0.4 迁移步骤见
[`docs/readme/PROTOCOL_COMPATIBILITY.zh.md`](PROTOCOL_COMPATIBILITY.zh.md)。

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
兼容的 OpenAI/Anthropic 客户端、OpenCode、Zuno，以及 Codex/Claude Code
兼容性探针都连接这个本机端点。不要为每个
Agent 或每段会话分别启动 provider。单一常驻进程可以让带显式亲和键的请求
复用已持久化的账号/Kiro conversation 绑定，同时让所有请求复用进程内按账号
划分的 SDK 客户端与 transport 对象。没有显式键的请求会创建新的 Kiro
conversation。Kiro 模型调用 socket 默认新建（`sdk_http_keep_alive: false`）；即使显式
开启 keep-alive，也只是尽可能优化传输，不代表一个会话独占一条物理 TCP
连接。

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
4. 带鉴权的 `/ready` 调用成功，证明认证源可读、至少有一个活跃账号、
   Provider 状态可写、reasoning 密钥环可用，且所有未过期回放记录引用的 key
   ID 都已覆盖。

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
| `protocol_projection_mode` | `safe` | `KIRO_PROVIDER_PROTOCOL_PROJECTION_MODE` |
| `session_affinity_mode` | `explicit-only` | `KIRO_PROVIDER_SESSION_AFFINITY_MODE` |
| `auth_source` | `opencode-shared` | `KIRO_PROVIDER_AUTH_SOURCE` |
| `opencode_auth_db_path` | `null`（使用 OpenCode 默认路径） | `KIRO_PROVIDER_OPENCODE_AUTH_DB_PATH` |
| `proxy_url` | `null` | `KIRO_PROVIDER_PROXY_URL` |
| `default_region` | `us-east-1` | `KIRO_PROVIDER_DEFAULT_REGION` |
| `sdk_http_keep_alive` | `false` | `KIRO_PROVIDER_SDK_HTTP_KEEP_ALIVE` |
| `account_selection_strategy` | `lowest-usage` | `KIRO_PROVIDER_ACCOUNT_SELECTION_STRATEGY` |
| `session_affinity_ttl_ms` | `86400000` | `KIRO_PROVIDER_SESSION_AFFINITY_TTL_MS` |
| `session_affinity_max_entries` | `10000` | `KIRO_PROVIDER_SESSION_AFFINITY_MAX_ENTRIES` |
| `reasoning_replay_key_path` | 配置目录自动生成 | `KIRO_PROVIDER_REASONING_REPLAY_KEY_PATH` |
| `reasoning_replay_keys` | `[]` | `KIRO_PROVIDER_REASONING_REPLAY_KEYS` |
| `reasoning_replay_ttl_ms` | `86400000` | `KIRO_PROVIDER_REASONING_REPLAY_TTL_MS` |
| `reasoning_replay_max_entries` | `10000` | `KIRO_PROVIDER_REASONING_REPLAY_MAX_ENTRIES` |
| `log_level` | `info` | `KIRO_PROVIDER_LOG_LEVEL` |

完整字段说明（包括重试/超时调优参数与仅用于测试的 `test_upstream_endpoint`）见 [`docs/readme/CONFIGURATION.zh.md`](CONFIGURATION.zh.md)。

## 代理

有些网络环境下某个模型系列可以直连，另一个系列却必须走代理（例如 GPT 直连、Claude 需要走审批过的出网代理）。设置 `proxy_url`（配置文件 / `KIRO_PROVIDER_PROXY_URL` / `serve --proxy`）即可让**所有**上游流量（模型调用、令牌刷新、设备码登录）都走同一个 HTTP(S) 代理；保持 `null` 则为直连。优先级与示例见 [`docs/readme/CONFIGURATION.zh.md`](CONFIGURATION.zh.md#代理)。

## 安全

- **默认拒绝启动。** 未配置至少一个非空 `api_keys` 时服务不会启动。OpenAI 路由要求 `Authorization: Bearer <key>`；Anthropic 路由还接受 `x-api-key: <key>`。
- **默认只监听本机。** `host` 默认为 `127.0.0.1`；只有在放在防火墙或带认证的反向代理之后时才应绑定 `0.0.0.0`。
- **认证事实源唯一。** 共享模式读写 OpenCode 现有 Kiro 数据库；schema 不兼容时默认拒绝启动，不会对该数据库执行 provider 自有迁移。
- **Provider 状态权限收紧。** `accounts.db`（及其 WAL / SHM 文件）创建时权限为 `0600`；共享模式下它保存亲和状态，而不是权威凭据。
- **Reasoning 回放带认证加密。** 数据库只保存令牌/指纹哈希和 AES-256-GCM 密文，不保存原始 `kr1_...`；缺少活动解密密钥时启动失败。
- **日志不打印敏感正文。** 网关/账号密钥、回放令牌、签名、reasoning 与请求提示词不会写入日志；结构化审计只记录哈希和字段名。不要提交真实配置文件、账号数据库、密钥环或网关 Key。

> **合规使用提示。** kiro-provider 复用的是你自己已认证的 AWS Kiro 账号，消耗的是你自己账号的额度。请只使用你自己的账号 —— 本项目不是用来共享或转卖他人 Kiro 使用权的工具，也不应用于绕过账号级别的用量限制。

## 配合 LLM 使用

OpenAI Responses 客户端使用 `POST /v1/responses`；Anthropic Messages
客户端使用 `POST /v1/messages`。只有在显式开启旧接口后，才应把
只支持 Chat Completions 的客户端（`@ai-sdk/openai-compatible`、旧版
LangChain 适配器，或采用该包的 OpenCode 自定义 provider）指向
`POST /v1/chat/completions`。

标准客户端也必须落在已验证子集内。safe 模式下，始终发送
system/developer、custom grammar、namespace 工具或 Anthropic
`cache_control` 的客户端会收到字段级 400；网关不会修改请求强行通过 Kiro。
可选的 `legacy-user-prefix` 仅是 v0.5.x/v0.6.x 的指令迁移手段，计划在
v0.7.0 删除。

默认 `session_affinity_mode: "explicit-only"` 绝不会通过 prompt 文本猜测
会话。Responses 按顺序检查 `metadata.zuno_session_id`、
`metadata.kiro_provider_session_id`、兼容字段
`client_metadata.thread_id|session_id|conversation_id` 和
`prompt_cache_key`；Chat 只检查 `prompt_cache_key`；Anthropic Messages
目前没有经过验证的显式亲和字段。缺少显式键时，请求使用新的 Kiro
conversation，但仍可复用账号级 SDK 客户端和 transport 对象。Kiro SDK 的
直连/代理 agent 默认使用新 socket；只有部署环境验证过池化 socket 行为后，才应
设置 `sdk_http_keep_alive: true`。临时的
`legacy-initial-input` 只恢复旧版亲和推导并输出启动警告，不会修改请求正文。

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

## 配合 Zuno 使用

先以拥有 OpenCode/Kiro 凭证的系统用户运行一个编译后的 kiro-provider 常驻
服务，再配置 Zuno 的原生 Rust OpenAI transport。这里不需要 Node 包、AI
SDK、私有 Header 或由 Zuno 启动 provider 的钩子：

```json
{
  "model": "kiro/auto",
  "small_model": "kiro/auto",
  "provider": {
    "kiro": {
      "name": "Local kiro-provider",
      "transport": "openai",
      "surface": "responses",
      "env": ["KIRO_GATEWAY_API_KEY"],
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "maxTokens": null
      },
      "models": {
        "auto": {
          "name": "Kiro Auto",
          "reasoning": true,
          "tool_call": true
        }
      }
    }
  }
}
```

把 `KIRO_GATEWAY_API_KEY` 设置为 provider `api_keys` 中的一项，再验证原生
路由：

```bash
export KIRO_GATEWAY_API_KEY='sk-your-private-key'
zuno debug config
zuno models kiro --verbose
```

配套的 Zuno OpenAI Responses transport 会在每个主回合和工具续轮中，把
持久 Zuno 会话 ID 映射到标准 `metadata.zuno_session_id`。它不会把该 ID
放入 input、messages、instructions、工具描述或任何模型可见字段；内部标题/
摘要请求也不会加入主会话。因此，同一 Zuno 会话会串行复用一份持久化的账号/
Kiro conversation 绑定；不同会话即使首个 prompt 与上游工具别名完全相同，
也保持隔离。工具声明和别名状态始终只属于当前请求。

该集成应保持 `surface: "responses"`。选择 `chat` 需要另行显式开启旧接口，
且不会携带上述 Zuno Responses 会话元数据。

当前 Zuno 会发送 Agent instructions，而 Kiro `additionalContext` 实时探针尚未
证明存在无损指令投影。因此，已验证的功能路径目前要求 Provider 显式设置
`protocol_projection_mode: "legacy-user-prefix"`；`safe` 会正确返回
`unsupported_instruction_projection`，绝不改写请求。还应按上例把 Zuno
`options.maxTokens` 设为 `null`，避免通用层加入 Kiro 不支持的
`max_output_tokens: 32000`。这两项都不依赖私有 Header 或客户端提示词补丁；
legacy 模式只是计划在 v0.7.0 删除的显式迁移例外。

## 配合 Codex CLI 使用

Codex 使用正确的 Responses 端点，但编译后的 RC.2 对
0.149.0-alpha.4.1 尚未通过。第一个字段级错误是 `text.verbosity`；该字段没有
经过证明的 Kiro 等价能力，因此 Provider 在调用 Kiro 前返回
`unsupported_parameter`，`param` 为 `text.verbosity`。脱敏请求还包含
`reasoning.context`、存在可调用 additional tools 时的
`parallel_tool_calls: false`，以及 custom grammar/namespace 语义。Provider
不会剥离这些字段，也不会用提示词模拟。以下隔离配置只用于重现兼容性检查，
不会碰到真实 `~/.codex`：

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

Codex 0.149.0-alpha.4.1 的 RC.2 预期结果是非零退出，并返回
`text.verbosity` 字段级错误。未来出现受支持的请求形态后，还必须通过真实
shell/custom 工具循环、续轮和重启 reasoning 回放，才能标记为支持。完整说明见
[`docs/readme/CODEX.zh.md`](CODEX.zh.md)。

## 配合 Claude Code 使用

Claude Code 使用 Anthropic Messages，但 2.1.209 的最终 RC.2 运行先发送
`output_config.format`，随后把 `system` 放进 `messages.1.role` 重试。这不是
合法的 Anthropic Messages 角色，也不能被静默搬移。同版本此前的脱敏 capture
还包含 `context_management`。safe 和 legacy 指令模式都会在调用 Kiro 前拒绝
这些请求形态。以下标准配置因此是兼容性探针，而不是当前支持声明：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export ANTHROPIC_AUTH_TOKEN="sk-your-private-key"
claude
```

Anthropic 路由同时接受 `Authorization: Bearer <key>` 和
`x-api-key: <key>`。落在已验证子集内的直接 Messages 请求支持类型化 JSON/SSE
和工具；`/v1/messages/count_tokens` 明确是估算值。详见
[`docs/readme/CLAUDE_CODE.zh.md`](CLAUDE_CODE.zh.md)。

当前编译服务验证记录见
[`docs/audits/kiro-provider-v0.5.0-rc.2-validation-2026-08-27.md`](../audits/kiro-provider-v0.5.0-rc.2-validation-2026-08-27.md)。
旧的 [`docs/E2E_VALIDATION_2026-08-22.md`](../E2E_VALIDATION_2026-08-22.md)
仅保留为历史 v0.4 证据。

## 开发

```bash
bun install
bun run lint
bun run typecheck
bun test
bun run build
bun run build:binary
bash scripts/security-check.sh   # 安全回归测试（Linux，需要 openssl/curl/ss）
```

## 许可证

[MIT](../../LICENSE)
