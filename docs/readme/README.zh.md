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
- 默认使用 provider 自有认证库：`auth_source: "local"` 将凭证保存在 `~/.config/kiro-provider/accounts.db`。已有 `opencode-kiro-auth` 账号可通过 `kiro-provider accounts import` 一次性导入；之后 token、用量、额度恢复和账号健康均由 kiro-provider 独立维护，不再读取或锁定 OpenCode 数据库。
- 默认只使用显式会话亲和：Responses 可通过标准 `metadata`、兼容 `client_metadata` 或 `prompt_cache_key` 选择加入；重传完整历史的标准客户端也能通过精确的上轮 assistant 输出 lineage 续轮。Provider 绝不会对 user prompt 做指纹来猜会话。配套的 Zuno 原生 OpenAI transport 会自动发送 `metadata.zuno_session_id`。
- 账号级调度与缓存的 SDK/transport 对象：不同账号可以并行，同一账号上的 Kiro 流不会重叠；access token 轮换时重建绑定凭据的 SDK client，但保留账号 transport。生产默认服务锁会阻止多个进程静默拆分队列和池。Kiro 模型调用的 HTTP keep-alive 默认关闭，必须显式选择开启。
- 通过 Kiro 管理面实时按账号发现模型并做账号感知路由，提供受限的陈旧缓存/静态兜底；生产调用使用实测确认的 `runtime.<region>.kiro.dev` 方言。带 token usage 的 metadata 是立即完成证据；当前 runtime 的合法 metering 只有后续为 clean EOF 时才被接受。
- 默认 `safe` 模式零 provider 自有提示词注入：统一输入 IR 保留客户端文本、
  角色、内容块边界、工具身份、顺序与来源路径；Kiro 输出先进入独立的统一
  completion/event IR，再编码为各外部协议。
- 对完整 Kiro 原生 reasoning envelope 提供加密回放：随机 `kr1_...` 令牌、AES-256-GCM、本租户/模型/账号/conversation/输出绑定、TTL/LRU 清理和回放账号锁定。
- 多账号轮询、自动令牌刷新与故障切换。耗尽账号不会进入模型尝试，只有经过有界、去重的 Kiro 用量探测确认新额度周期后才自动回池；后台维护循环还会在服务空闲时刷新临近过期的 token 和陈旧用量。
- `kiro-provider login` 与 `accounts import` 直接写入 provider 自有本地认证库。`auth_source: "opencode-shared"` 仅保留为显式兼容选项；一次导入后不再需要它。
- 单一全局 `proxy_url`：一旦设置，所有上游出网流量（模型请求、令牌刷新、额度探测、设备码登录）都会走同一个 HTTP(S) 代理。
- 通过 `bun build --compile` 打包为单文件可执行文件，目标机器无需额外运行时依赖。

## 协议兼容范围

v0.5 明确定位为**经过验证的兼容子集**，不会接收字段后静默丢弃。默认
`protocol_projection_mode: "safe"` 不会前置或改写客户端指令、合并相邻
消息、清空重复 assistant 输出、删除 `{` 等尾部文本，也不会生成模型可见的
补偿说明。

主要边界：

- 普通文本、连续同角色回合、function/custom 工具声明、调用和结果保持原始
  结构与顺序；
- 纯文本顶层块在统一 IR 中仍保持独立，只在 Kiro 单文本字段边界按原字节
  无分隔拼接；若多个文本块与图片或工具内容交错，仍返回
  `unsupported_content_block_projection`；
- safe 模式下 `instructions`、`system`、`developer` 返回
  `unsupported_instruction_projection`，因为实测 Kiro 虽接受合法的
  `additionalContext` 结构，却没有保留其中的指令内容或优先级；
- 支持 `tool_choice: auto`；`parallel_tool_calls: false` 只在没有可调用工具
  （包括 `tool_choice: none`）时作为无副作用字段接受，否则返回
  `unsupported_parallel_tool_calls`；required/指定工具、strict schema、
  custom grammar 和 namespace 工具会被拒绝，不会被弱化；
- 支持 base64/data URL 图片；远程图片 URL 与 detail 控制会被拒绝；
- Responses `input_file` 支持 Kiro 原生格式的内联 base64/data URL 文档。
  Canonical 请求保留原始文件名；降级时把已识别扩展名放入独立 `format`
  字段，并在 SDK 调用前校验去扩展名后的 ASCII 名称。任何需要有损改名的
  输入返回 `invalid_file_name`；因 Provider 没有 OpenAI 文件存储，
  `file_id` 引用会被拒绝；
- 输出 token 上限已对 `claude-sonnet-5` 与 `claude-opus-5` 变体的
  1,024–128,000 范围完成探针确认；
- Responses 只隐藏 GPT 5.6 Sol 返回的精确 `...`/`…` reasoning 占位块；
  Opus reasoning、Sol 的非占位 reasoning、effort 映射与加密回放均不变；
- Stateful Responses 与 Kiro 原生 Web Search 仍不支持，Provider 不会伪造
  搜索或引用事件。

当前已验证子集的状态、每次发布背后的编译后二进制验收记录，以及
2026-09-02 的全面代码审视与修复方案，均记录在
[`docs/audits/`](../audits/README.md)。稳定版继续以这些记录为门禁，
不会靠静默丢弃不支持字段换取“通过”。

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

两个脚本都会同时下载对应平台资产和该发布的 `SHA256SUMS`，校验通过后才安装到 `~/.local/bin`（可用 `KIRO_PROVIDER_INSTALL_DIR` 覆盖），校验不一致会直接中止。默认跟随 `releases/latest`；常驻服务或需要可复现安装时，建议用 `KIRO_PROVIDER_VERSION` 固定版本：

```bash
curl -fsSL https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.sh | KIRO_PROVIDER_VERSION=0.5.1 sh
```

```powershell
$env:KIRO_PROVIDER_VERSION = "0.5.1"; irm https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.ps1 | iex
```

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

1. **创建配置文件并写入你自己的 API Key。** 只有 `api_keys` 是必填项，
   其余字段都有生产默认值（`auth_source: "local"`、`host: "127.0.0.1"`、
   `port: 8787`）。

   ```bash
   mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider"
   cat > "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json" <<'EOF'
   {
     "api_keys": ["sk-your-private-key"]
   }
   EOF
   chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json"
   ```

   把 `sk-your-private-key` 换成一个私有的随机值（例如 `openssl rand -hex 24`）。
   仓库中带完整注释的 [`config.example.json`](../../config.example.json) 与
   [`docs/readme/CONFIGURATION.zh.md`](CONFIGURATION.zh.md) 列出了全部字段。

   **Windows 路径。** Windows 上默认配置文件为
   `%APPDATA%\kiro-provider\config.json`，`accounts.db`、实例锁和 reasoning
   密钥环也位于同一目录（POSIX 上这些文件统一放在
   `~/.config/kiro-provider`）。需要其他位置时使用 `--config <path>`。

2. **填充 provider 自有认证库。** 如果此前通过 OpenCode 和
   `opencode-kiro-auth` 完成认证，只需导入一次：

   ```bash
   ./dist/kiro-provider accounts import
   ```

   默认源为 `~/.config/opencode/kiro.db`，必要时使用 `--from <path>`。
   导入是复制，不是实时链接；之后 token 与用量刷新都由 kiro-provider
   独立负责。也可以直接登录：

   ```bash
   ./dist/kiro-provider login
   ```

   不要让两个独立认证所有者同时轮换同一批导入的 refresh token。

   可随时查看或刷新 provider 自有账号池：

   ```bash
   ./dist/kiro-provider accounts list
   ./dist/kiro-provider accounts list --details
   ./dist/kiro-provider accounts refresh --all
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
划分的 SDK 客户端与 transport 对象。没有显式键的请求首轮会创建新的 Kiro
conversation，后续完整历史可通过精确 assistant 输出 lineage 找回同一绑定。
Kiro 模型调用 socket 默认新建（`sdk_http_keep_alive: false`）；即使显式
开启 keep-alive，也只是尽可能优化传输，不代表一个会话独占一条物理 TCP
连接。默认 `enforce_single_instance: true` 还会阻止第二个服务进程拆分
进程内队列和池。

常驻部署建议使用固定版本的独立二进制，不要在每次启动时通过 `bunx` 临时
拉取。以下示例采用发布安装脚本的默认路径：

- Linux 二进制：`~/.local/bin/kiro-provider`；
- Windows 二进制：`%USERPROFILE%\.local\bin\kiro-provider.exe`；
- 配置文件：Linux 为 `~/.config/kiro-provider/config.json`，Windows 为
  `%APPDATA%\kiro-provider\config.json`；
- 服务/任务名称：`kiro-provider`。

一次性导入与常驻服务应由**同一个系统用户**执行，使服务读取同一份
`~/.config/kiro-provider/accounts.db`、配置、密钥环和实例锁。改成 `root`、
`LocalSystem` 或其他用户通常会选择另一套本地存储。服务定义中应使用绝对
路径；API Key 保存在受保护的配置文件中，不要写进服务参数。导入完成后不会
再次读取 OpenCode 数据库。

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

请使用拥有 provider 本地认证库与配置的同一用户打开 PowerShell，执行以下
命令。它会创建一个小型启动脚本，并把 stdout/stderr 保存在
`%LOCALAPPDATA%\kiro-provider`：

```powershell
$Binary = Join-Path $HOME ".local\bin\kiro-provider.exe"
$Config = Join-Path $env:APPDATA "kiro-provider\config.json"
$ServiceDir = Join-Path $env:APPDATA "kiro-provider"
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
$Config = Join-Path $env:APPDATA "kiro-provider\config.json"
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
Remove-Item "$env:APPDATA\kiro-provider\service.ps1"
```

这个任务有意只在当前用户的交互式会话中运行，因此无需保存 Windows 密码，
并可直接使用该用户的网络权限、provider 数据库与密钥环。如果必须在用户
登录前运行，则需要 Windows 服务包装器和一个经过明确配置的用户账号；不要
让 `LocalSystem` 运行后仍假设它能读取原用户的 provider 文件。

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
| `auth_source` | `local` | `KIRO_PROVIDER_AUTH_SOURCE` |
| `opencode_auth_db_path` | `null`（使用 OpenCode 默认路径） | `KIRO_PROVIDER_OPENCODE_AUTH_DB_PATH` |
| `proxy_url` | `null` | `KIRO_PROVIDER_PROXY_URL` |
| `default_region` | `us-east-1` | `KIRO_PROVIDER_DEFAULT_REGION` |
| `sdk_http_keep_alive` | `false` | `KIRO_PROVIDER_SDK_HTTP_KEEP_ALIVE` |
| `enforce_single_instance` | `true` | `KIRO_PROVIDER_ENFORCE_SINGLE_INSTANCE` |
| `instance_lock_path` | 平台配置目录 | `KIRO_PROVIDER_INSTANCE_LOCK_PATH` |
| `runtime_endpoint_mode` | `kiro-runtime` | `KIRO_PROVIDER_RUNTIME_ENDPOINT_MODE` |
| `dynamic_model_catalog` | `true` | `KIRO_PROVIDER_DYNAMIC_MODEL_CATALOG` |
| `model_catalog_ttl_ms` | `900000` | `KIRO_PROVIDER_MODEL_CATALOG_TTL_MS` |
| `model_catalog_stale_ttl_ms` | `86400000` | `KIRO_PROVIDER_MODEL_CATALOG_STALE_TTL_MS` |
| `model_catalog_request_timeout_ms` | `10000` | `KIRO_PROVIDER_MODEL_CATALOG_REQUEST_TIMEOUT_MS` |
| `account_selection_strategy` | `lowest-usage` | `KIRO_PROVIDER_ACCOUNT_SELECTION_STRATEGY` |
| `quota_recheck_interval_ms` | `900000` | `KIRO_PROVIDER_QUOTA_RECHECK_INTERVAL_MS` |
| `quota_recheck_timeout_ms` | `10000` | `KIRO_PROVIDER_QUOTA_RECHECK_TIMEOUT_MS` |
| `quota_recheck_concurrency` | `4` | `KIRO_PROVIDER_QUOTA_RECHECK_CONCURRENCY` |
| `account_maintenance_enabled` | `true` | `KIRO_PROVIDER_ACCOUNT_MAINTENANCE_ENABLED` |
| `account_maintenance_interval_ms` | `60000` | `KIRO_PROVIDER_ACCOUNT_MAINTENANCE_INTERVAL_MS` |
| `account_maintenance_timeout_ms` | `120000` | `KIRO_PROVIDER_ACCOUNT_MAINTENANCE_TIMEOUT_MS` |
| `account_maintenance_concurrency` | `4` | `KIRO_PROVIDER_ACCOUNT_MAINTENANCE_CONCURRENCY` |
| `usage_refresh_interval_ms` | `900000` | `KIRO_PROVIDER_USAGE_REFRESH_INTERVAL_MS` |
| `session_affinity_ttl_ms` | `86400000` | `KIRO_PROVIDER_SESSION_AFFINITY_TTL_MS` |
| `session_affinity_max_entries` | `10000` | `KIRO_PROVIDER_SESSION_AFFINITY_MAX_ENTRIES` |
| `reasoning_replay_key_path` | 配置目录自动生成 | `KIRO_PROVIDER_REASONING_REPLAY_KEY_PATH` |
| `reasoning_replay_keys` | `[]` | `KIRO_PROVIDER_REASONING_REPLAY_KEYS` |
| `reasoning_replay_ttl_ms` | `86400000` | `KIRO_PROVIDER_REASONING_REPLAY_TTL_MS` |
| `reasoning_replay_max_entries` | `10000` | `KIRO_PROVIDER_REASONING_REPLAY_MAX_ENTRIES` |
| `log_level` | `info` | `KIRO_PROVIDER_LOG_LEVEL` |

完整字段说明（包括重试/超时调优参数与仅用于测试的 `test_upstream_endpoint`）见 [`docs/readme/CONFIGURATION.zh.md`](CONFIGURATION.zh.md)。

## 代理

有些网络环境下某个模型系列可以直连，另一个系列却必须走代理（例如 GPT 直连、Claude 需要走审批过的出网代理）。设置 `proxy_url`（配置文件 / `KIRO_PROVIDER_PROXY_URL` / `serve --proxy`）即可让**所有**上游流量（模型调用、令牌刷新、额度探测、设备码登录）都走同一个 HTTP(S) 代理；保持 `null` 则为直连。优先级与示例见 [`docs/readme/CONFIGURATION.zh.md`](CONFIGURATION.zh.md#代理)。

## 安全

- **默认拒绝启动。** 未配置至少一个非空 `api_keys` 时服务不会启动。OpenAI 路由要求 `Authorization: Bearer <key>`；Anthropic 路由还接受 `x-api-key: <key>`。
- **默认只监听本机。** `host` 默认为 `127.0.0.1`；只有在放在防火墙或带认证的反向代理之后时才应绑定 `0.0.0.0`。
- **认证事实源唯一。** 共享模式读写 OpenCode 现有 Kiro 数据库；schema 不兼容时默认拒绝启动，不会对该数据库执行 provider 自有迁移。
- **默认单一服务所有者。** 编译服务监听前会取得平台配置目录中的进程锁，避免进程内账号/会话队列与 SDK 池被意外拆分。
- **Provider 状态权限收紧。** `accounts.db`（及其 WAL / SHM 文件）创建时权限为 `0600`；默认本地模式下它保存凭据、用量、健康状态、会话亲和以及加密的 reasoning 回放状态。
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
conversation 作为首轮；后续完整历史可通过精确的上轮 assistant 输出 lineage
复用同一账号/conversation，并继续复用账号级 SDK 客户端和 transport 对象。
Kiro SDK 的直连/代理 agent 默认使用新 socket；只有部署环境验证过池化 socket
行为后，才应设置 `sdk_http_keep_alive: true`。临时的
`legacy-initial-input` 只恢复旧版亲和推导并输出启动警告，不会修改请求正文。

在真正的响应状态存储完成前，Responses 的 `previous_response_id` 和
`conversation` 会明确返回 400，客户端应重传完整输入。

<details>
<summary>Agent 命令参考</summary>

- `kiro-provider serve [--config <path>] [--host <host>] [--port <port>] [--proxy <url>]` —— 启动网关。
- `kiro-provider login [--config <path>] [--start-url <url>] [--region <region>]` —— 直接登录到 provider 自有本地认证库。
- `kiro-provider accounts list [--details | --json]` —— 对齐显示账号健康与用量；details/JSON 会显示稳定账号 ID，但绝不输出凭证。
- `kiro-provider accounts refresh (--all | <id|email>) [--config <path>] [--json]` —— 绕过用量缓存，立即读取 Kiro 权威用量，并仅在 access token 到期或被上游拒绝时刷新。
- `kiro-provider accounts relogin <id|email> [--config <path>] [--start-url <url>] [--region <region>]` —— 经 Kiro 身份校验后重新认证选定账号，同时保留内部账号 ID 与会话亲和引用。
- `kiro-provider accounts import [--from <path>] [--config <path>]` —— 将 OpenCode Kiro 账号一次性复制到 provider 自有本地认证库，不保留实时数据库链接。
- `kiro-provider accounts remove <id|email> [--yes]` —— 删除账号及其亲和、lineage、reasoning 状态；除非显式传入 `--yes`，否则必须交互确认。

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

当前 Zuno 会发送 Agent instructions。合法的非空标签 `additionalContext`
请求已在 GPT 与 Claude 实时探针中到达 Kiro，但模型没有收到其中的指令内容，
也没有保持其优先级。因此，已验证的功能路径目前要求 Provider 显式设置
`protocol_projection_mode: "legacy-user-prefix"`；`safe` 会正确返回
`unsupported_instruction_projection`，绝不改写请求。还应按上例把 Zuno
`options.maxTokens` 设为 `null`，避免通用层加入 Kiro 不支持的
`max_output_tokens: 32000`。这两项都不依赖私有 Header 或客户端提示词补丁；
legacy 模式只是计划在 v0.7.0 删除的显式迁移例外。

## 配合 Codex CLI 使用

Codex 使用正确的 Responses 端点。最近一次编译后二进制协议门禁使用 Codex
0.150.0-alpha.9 与 `claude-opus-5-max` 时已通过 Provider 模型校验，但首个
请求会在调用 Kiro 前被 `reasoning.summary` 阻塞；该字段没有经过证明的原生
等价能力。Provider 不会剥离该字段，也不会用提示词模拟。以下隔离配置只用于
重现兼容性检查，不会碰到真实 `~/.codex`：

```bash
export CODEX_TEST_ROOT="$(mktemp -d)"
export CODEX_HOME="$CODEX_TEST_ROOT/home"
export CODEX_SQLITE_HOME="$CODEX_TEST_ROOT/sqlite"
mkdir -p "$CODEX_HOME" "$CODEX_SQLITE_HOME"
export LOCALGW_KEY="sk-...你的网关 api key..."
cat > "$CODEX_HOME/config.toml" <<'EOF'
model = "claude-opus-5-max"
model_provider = "localgw"
model_reasoning_effort = "high"
[model_providers.localgw]
name = "Local Gateway"
base_url = "http://127.0.0.1:8787/v1"
env_key = "LOCALGW_KEY"
wire_api = "responses"
EOF
codex exec --skip-git-repo-check "say hi"
```

Codex 0.150.0-alpha.9 的预期结果是非零退出，并在
`reasoning.summary` 返回 `unsupported_reasoning_summary`。未来出现受支持的
请求形态后，还必须通过真实 shell/custom 工具循环、续轮和重启 reasoning
回放，才能标记为支持。完整说明见
[`docs/readme/CODEX.zh.md`](CODEX.zh.md)。

## 配合 Claude Code 使用

Claude Code 使用 Anthropic Messages。最近一次编译后二进制协议门禁使用 Claude Code
2.1.209、`claude-opus-5` 与 max effort 时已通过 Provider 模型校验，但会在
调用 Kiro 前被 `context_management` 阻塞；该字段没有经过证明的原生等价
能力，Provider 不会丢弃它。已验证子集内的直接 Opus 5 Messages JSON/SSE
通过；以下标准配置仍是兼容性探针，而不是完整支持声明：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export ANTHROPIC_API_KEY="sk-your-private-key"
claude --bare --safe-mode --model claude-opus-5 --effort max
```

Anthropic 路由同时接受 `Authorization: Bearer <key>` 和
`x-api-key: <key>`。落在已验证子集内的直接 Messages 请求支持类型化 JSON/SSE
和工具；`/v1/messages/count_tokens` 明确是估算值。详见
[`docs/readme/CLAUDE_CODE.zh.md`](CLAUDE_CODE.zh.md)。

当前账号管理与真实用量验证记录见
[`docs/audits/kiro-provider-v0.5.0-rc.5-account-management-validation-2026-08-29.md`](../audits/kiro-provider-v0.5.0-rc.5-account-management-validation-2026-08-29.md)。
v0.5.0 类型化流错误契约与 Zuno 下游接入说明见
[`docs/STREAM_ERROR_CONTRACT.md`](../STREAM_ERROR_CONTRACT.md) 和
[`docs/ZUNO_STREAM_ERROR_HANDOFF.zh.md`](../ZUNO_STREAM_ERROR_HANDOFF.zh.md)。
此前本地认证生命周期记录保留在
[`docs/audits/kiro-provider-v0.5.0-rc.4-local-auth-maintenance-validation-2026-08-29.md`](../audits/kiro-provider-v0.5.0-rc.4-local-auth-maintenance-validation-2026-08-29.md)。
此前协议与客户端矩阵保留在
[`docs/audits/kiro-provider-v0.5.0-rc.3-opus5-validation-2026-08-27.md`](../audits/kiro-provider-v0.5.0-rc.3-opus5-validation-2026-08-27.md)。
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

`make ci` 会依次执行类型检查、lint、shell 脚本语法检查和测试套件。
`make fmt-check`（以及 `make fmt`）还需要 `oxfmt` 来格式化 YAML/JSON/Markdown，
请安装与 CI 相同的版本：`bun install --global oxfmt@0.59.0`。
`bun run scripts/smoke.ts --help` 说明了针对运行中网关的端到端冒烟检查。

## 许可证

[MIT](../../LICENSE)
