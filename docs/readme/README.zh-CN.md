<div align="center">

# kiro-provider

### 基于 AWS KiroRuntime 的 OpenAI Responses 与 Anthropic Messages 网关

[![CI](https://github.com/sunerpy/kiro-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/sunerpy/kiro-provider/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/sunerpy/kiro-provider)](https://github.com/sunerpy/kiro-provider/releases)
[![npm](https://img.shields.io/npm/v/%40sunerpy%2Fkiro-provider)](https://www.npmjs.com/package/@sunerpy/kiro-provider)
[![codecov](https://codecov.io/gh/sunerpy/kiro-provider/branch/main/graph/badge.svg)](https://codecov.io/gh/sunerpy/kiro-provider)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)
[![Bun](https://img.shields.io/badge/runtime-bun-black)](https://bun.sh/)

[安装](#安装) · [快速开始](#快速开始) · [协议](#协议兼容范围) · [客户端](#客户端集成) · [文档](#文档) · [开发](#开发)

[English](../../README.md) · [**简体中文**](./README.zh-CN.md)

</div>

---

## 特性

- OpenAI Responses 创建，以及本地镜像的 retrieve、delete、input-items 与
  cancel 路由；Anthropic Messages `POST /v1/messages`；显式开关后的旧版 Chat
  Completions；`GET /v1/models`、`GET /health` 和需鉴权的 `GET /ready`。
- 旧版 OpenAI Chat Completions 位于 `POST /v1/chat/completions`，默认关闭，必须通过 `enable_legacy_chat_completions` 显式开启。
- Bearer API Key 校验，且默认拒绝启动：未配置任何 Key 时服务不会启动，默认绑定地址为 `127.0.0.1`。
- 默认使用 provider 自有认证库：`auth_source: "local"` 将凭证保存在 `~/.config/kiro-provider/accounts.db`。已有 `opencode-kiro-auth` 账号可通过 `kiro-provider accounts import` 一次性导入；之后 token、用量、额度恢复和账号健康均由 kiro-provider 独立维护，不再读取或锁定 OpenCode 数据库。
- 默认只使用显式会话亲和：Responses 可通过标准 `metadata`、兼容 `client_metadata` 或 `prompt_cache_key` 选择加入；重传完整历史的标准客户端也能通过精确的上轮 assistant 输出 lineage 续轮。Provider 绝不会对 user prompt 做指纹来猜会话。配套的 Zuno 原生 OpenAI transport 会自动发送 `metadata.zuno_session_id`。
- 账号级调度与缓存的 SDK/transport 对象：不同账号可以并行，同一账号上的 Kiro 流不会重叠；access token 轮换时重建绑定凭据的 SDK client，但保留账号 transport。生产默认服务锁会阻止多个进程静默拆分队列和池。Kiro 模型调用的 HTTP keep-alive 默认关闭，必须显式选择开启。
- 通过 Kiro 管理面实时按账号发现模型并做账号感知路由，提供受限的陈旧缓存/静态兜底；生产调用使用实测确认的 `runtime.<region>.kiro.dev` 方言。带 token usage 的 metadata 是立即完成证据；当前 runtime 的合法 metering 只有后续为 clean EOF 时才被接受。
- 默认 `v3-auto` 自动选择传输：普通请求使用 KiroRuntime 原生 OpenAI
  Responses；需要 `store:false`、max effort、加密 reasoning、custom grammar、
  namespace 工具或 Codex 协作的请求使用 canonical stateless fallback。
- 对完整 Kiro 原生 reasoning envelope 提供加密回放：随机 `kr1_...` 令牌、AES-256-GCM、本租户/模型/账号/conversation/输出绑定、TTL/LRU 清理和回放账号锁定。
- 多账号轮询、自动令牌刷新与故障切换。耗尽账号不会进入模型尝试，只有经过有界、去重的 Kiro 用量探测确认新额度周期后才自动回池；后台维护循环还会在服务空闲时刷新临近过期的 token 和陈旧用量。
- `kiro-provider login` 与 `accounts import` 直接写入 provider 自有本地认证库。原有的 `auth_source: "opencode-shared"` 兼容模式已在 0.7.0 移除；仍选择该值的配置会在启动时报错并给出迁移指引（先导入一次，再改用 `local`）。
- 单一全局 `proxy_url`：一旦设置，所有上游出网流量（模型请求、令牌刷新、额度探测、设备码登录）都会走同一个 HTTP(S) 代理。
- 通过 `bun build --compile` 打包为单文件可执行文件，目标机器无需额外运行时依赖。

## 协议兼容范围

V3 实现 OpenAI Responses 核心资源，并明确暴露所有上游差异：

- 原生 JSON/SSE 创建、instructions、function 工具、经过验证的 effort/token
  控制，以及原生 `previous_response_id`；
- 对 `store:false`、max effort、加密 reasoning、custom grammar、namespace
  工具与 Codex 多代理 item 自动使用 stateless fallback；
- 按租户隔离的本地 Response 镜像，支持 retrieve、delete、input-items 分页
  与续轮；
- Kiro 无法保真的能力返回字段级 OpenAI error envelope，包括 Responses
  conversation、background、Structured Outputs、托管工具、远程文件引用、
  compact 与精确 input-token 计数。

旧 GenerateAssistantResponse 的 `safe` 模式继续默认拒绝，因为
`additionalContext` 没有保留指令内容或优先级，当前账号也没有公开私有
`systemPrompt` feature。默认 `v3-auto` 改用 KiroRuntime CreateResponse
原生 `instructions` 字段。

用量统计保留真实的缓存读写和 reasoning 子项。Kiro 只提供上下文百分比和
credits 时，默认兼容模式在 `usage.metadata.kiro` 标明估算来源和未知字段；
严格模式省略不完整的 usage。上下文计数不会再把 GPT 已封顶的旧百分比乘以
修正后的 prompt 预算。详见[用量与上下文统计](RESPONSES_USAGE.zh-CN.md)，
其中也区分了 AI SDK 7 的累计 `usage` 与当前步骤的 `finalStep.usage`。

传输选择、Response 状态、数据保留边界、模型控制与客户端验证见
[`PROTOCOL_COMPATIBILITY.zh-CN.md`](PROTOCOL_COMPATIBILITY.zh-CN.md) 和
[`docs/audits/`](../audits/README.md)。

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
curl -fsSL https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.sh | KIRO_PROVIDER_VERSION=3.0.0 sh
```

```powershell
$env:KIRO_PROVIDER_VERSION = "3.0.0"; irm https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.ps1 | iex
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
   仓库中包含全部字段的 [`config.example.json`](../../config.example.json) 与
   [`docs/readme/CONFIGURATION.zh-CN.md`](CONFIGURATION.zh-CN.md) 列出了全部字段。

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

在 Agent 主机上，每个系统用户只运行一个长期存活的 Provider。使用固定版本的
独立二进制，让认证与服务由同一用户执行，并在连接客户端前同时检查无需鉴权的
`/health` 与需要鉴权的 `/ready`。默认单实例锁会阻止第二个进程拆分账号队列和
会话状态。

[后台服务指南](SERVICE.zh-CN.md)提供完整的 systemd 用户服务与 Windows 计划任务
示例、日志位置、生命周期命令、健康门禁和卸载步骤。

## 配置

配置从平台配置目录加载，再由 `KIRO_PROVIDER_*` 环境变量和 `serve` 支持的 CLI
参数覆盖。优先级为 **CLI 参数 > 环境变量 > JSON 文件 > schema 默认值**。未知
字段和越界值会在启动时失败；空环境变量按未设置处理。

仓库中的 [`config.example.json`](../../config.example.json) 是带注释的起点。
[配置参考](CONFIGURATION.zh-CN.md)是所有字段、默认值、环境变量、超时、代理、文件
位置和协议开关的事实源。不要把 `responses_fidelity_mode` 等 Provider 自身配置
复制到下游客户端的请求 options。

## 安全

- **默认拒绝启动。** 未配置至少一个非空 `api_keys` 时服务不会启动。OpenAI 路由要求 `Authorization: Bearer <key>`；Anthropic 路由还接受 `x-api-key: <key>`。
- **默认只监听本机。** `host` 默认为 `127.0.0.1`；只有在放在防火墙或带认证的反向代理之后时才应绑定 `0.0.0.0`。
- **认证事实源唯一。** 登录或一次性导入后，只使用 Provider 自有本地库。不要让两个独立进程轮换同一份导入的 refresh token；原实时 `opencode-shared` 模式已不再支持。
- **默认单一服务所有者。** 编译服务监听前会取得平台配置目录中的进程锁，避免进程内账号/会话队列与 SDK 池被意外拆分。
- **Provider 状态权限收紧。** `accounts.db`（及其 WAL / SHM 文件）创建时权限为 `0600`；默认本地模式下它保存凭据、用量、健康状态、会话亲和以及加密的 reasoning 回放状态。
- **Reasoning 回放带认证加密。** 数据库只保存令牌/指纹哈希和 AES-256-GCM 密文，不保存原始 `kr1_...`；缺少活动解密密钥时启动失败。
- **日志不打印敏感正文。** 网关/账号密钥、回放令牌、签名、reasoning 与请求提示词不会写入日志；结构化审计只记录哈希和字段名。不要提交真实配置文件、账号数据库、密钥环或网关 Key。

> **合规使用提示。** kiro-provider 复用的是你自己已认证的 AWS Kiro 账号，消耗的是你自己账号的额度。请只使用你自己的账号 —— 本项目不是用来共享或转卖他人 Kiro 使用权的工具，也不应用于绕过账号级别的用量限制。

## 客户端集成

OpenAI Responses 客户端使用 `POST /v1/responses`，Anthropic Messages 客户端
使用 `POST /v1/messages`。只有客户端无法使用这两个主要接口时，才显式开启
`POST /v1/chat/completions`。

| 客户端 | 接口 | 指南 |
| --- | --- | --- |
| Zuno | OpenAI Responses | [配置、会话路由与隔离验收](ZUNO.zh-CN.md) |
| Codex CLI | OpenAI Responses | [隔离 profile 与支持边界](CODEX.zh-CN.md) |
| Claude Code | Anthropic Messages | [隔离 `kiroclaude` profile 与兼容边界](CLAUDE_CODE.zh-CN.md) |
| 其他 SDK | Responses、Messages 或显式开启的旧版 Chat | [V3 协议兼容范围](PROTOCOL_COMPATIBILITY.zh-CN.md) |

默认 `session_affinity_mode: "explicit-only"` 不会对 prompt 正文做指纹。客户端
应发送稳定的标准亲和字段，或按 API 能力重传完整历史 / 使用
`previous_response_id`。native 与 stateless 传输由网关自动选择，客户端不应
强制指定内部通道。

## 排障

[`docs/readme/TROUBLESHOOTING.zh-CN.md`](TROUBLESHOOTING.zh-CN.md) 是"症状优先"的
排障手册：每个症状都指出应查看的审计事件、`accounts list --details` 的
可用性取值或 HTTP 状态码与 `error.code`，再给出原因和处置。覆盖
`needs-relogin` 与令牌刷新失败、`quota-exhausted` 与 `overage-blocked`
（`stop_on_overage`）、`503 no_healthy_accounts`、`502 upstream_stream_*`
及发布前重试事件、"助手宣布了下一步然后就停了"时如何解读
`sdk_stream_terminal`、reasoning 回放的 `400`、单实例锁、配置告警、两种
`413`、代理故障；并附 systemd 服务的 `journalctl` 查询模板与可选的
`request_shape` 调试事件说明。

## 文档

[`docs/README.md`](../README.md) 是完整文档地图，区分当前运维/协议指南与带日期的
审计证据，并关联英文和简体中文版本。发布历史位于
[`changelog/`](../../changelog/README.md)。

## 开发

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun test
bun run build
bun run build:binary
bash scripts/security-check.sh   # 安全回归测试（Linux，需要 openssl/curl/ss）
```

`make ci` 会执行仓库的快速正确性门禁：格式检查、类型检查、lint、shell
脚本语法、测试、构建、安全自测和覆盖率配置一致性检查。`make pre-ci` 还会
执行完整覆盖率测试并强制覆盖率下限。
`make fmt-check` 使用仓库锁定的 `oxfmt` 版本；请先运行
`bun install --frozen-lockfile` 安装依赖。`bun run scripts/smoke.ts --help` 说明了针对运行中网关的端到端冒烟检查。

## 许可证

[MIT](../../LICENSE)
