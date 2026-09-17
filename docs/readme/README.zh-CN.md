<div align="center">

# kiro-provider

让支持 OpenAI Responses 或 Anthropic Messages 的客户端使用你自己的 AWS Kiro 账号。

[![CI](https://github.com/sunerpy/kiro-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/sunerpy/kiro-provider/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/sunerpy/kiro-provider)](https://github.com/sunerpy/kiro-provider/releases)
[![npm](https://img.shields.io/npm/v/%40sunerpy%2Fkiro-provider)](https://www.npmjs.com/package/@sunerpy/kiro-provider)
[![codecov](https://codecov.io/gh/sunerpy/kiro-provider/branch/main/graph/badge.svg)](https://codecov.io/gh/sunerpy/kiro-provider)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)

[快速开始](#快速开始) · [接入客户端](#接入-agent-客户端) · [兼容方式](#兼容方式) · [文档](#文档)

[English](../../README.md) · [**简体中文**](./README.zh-CN.md)

</div>

## 它做什么

kiro-provider 是运行在本机的 HTTP 网关，也是 Kiro 凭据的唯一所有者。它负责登录
Kiro、按账号发现可用模型、调度请求，并向客户端提供两套主要接口：

| 接口                    | 路由                                          | 默认状态                                      |
| ----------------------- | --------------------------------------------- | --------------------------------------------- |
| OpenAI Responses        | `POST /v1/responses`                          | 开启                                          |
| Anthropic Messages      | `POST /v1/messages`                           | 开启                                          |
| Anthropic token 估算    | `POST /v1/messages/count_tokens`              | 开启                                          |
| OpenAI Chat Completions | `POST /v1/chat/completions`                   | 关闭；需设置 `enable_legacy_chat_completions` |
| 模型与就绪检查          | `GET /v1/models`、`GET /health`、`GET /ready` | 开启                                          |

Responses 还支持本地 retrieve、delete、input-items、cancel 和续轮。网关能完整保留
请求时会使用 KiroRuntime 原生 Responses；否则切到 stateless adapter。如果两条路径
都无法保留某项语义，请求会返回明确的类型化错误，不会悄悄删除字段。

## 安装

任选一种方式即可。下文统一使用 `kiro-provider`；如果通过 `bunx` 运行，请替换成
`bunx @sunerpy/kiro-provider`。

### Bun

npm 包使用了 Bun 专属 API，不能用 Node.js 或 `npx` 运行。

```bash
bun add -g @sunerpy/kiro-provider
kiro-provider --version
```

临时运行：

```bash
bunx @sunerpy/kiro-provider --help
```

### 独立二进制

每个 GitHub Release 都提供 Linux x64/arm64、macOS x64/arm64 和 Windows x64
二进制。安装脚本会先用该版本的 `SHA256SUMS` 校验文件，再默认写入
`~/.local/bin`。

Linux 或 macOS：

```bash
curl -fsSL https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.sh | sh
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.ps1 | iex
```

常驻服务建议设置 `KIRO_PROVIDER_VERSION` 固定版本，不要直接跟随 `latest`。完整配置
见[后台服务指南](SERVICE.zh-CN.md)。

### 查看版本与升级

`--version` 只打印已安装版本；加 `--check` 会查询 GitHub 上最新的 Release，加
`--json` 输出机器可读格式。

```bash
kiro-provider --version
kiro-provider --version --check
```

独立二进制可以自我替换。`self-update` 会下载当前平台的 Release 资产，先用该版本的
`SHA256SUMS` 校验摘要，通过后才原地替换二进制；摘要不匹配时已安装的文件保持不变。

```bash
kiro-provider self-update --check          # 只报告将要安装的版本
kiro-provider self-update                  # 确认后替换
kiro-provider self-update --yes            # 免交互
kiro-provider self-update --tag 3.3.1      # 指定版本，也可用于回退
```

npm 安装请改用包管理器升级（`bun add -g @sunerpy/kiro-provider@latest`），
`self-update` 会拒绝并给出提示。两个命令都支持 `--proxy <url>`，否则依次读取
`KIRO_PROVIDER_PROXY_URL`、`HTTPS_PROXY`/`HTTP_PROXY`；`--proxy ""` 表示不选择任何
代理，而不是继续回退到这些变量。Bun 的 `fetch` 自身也会读取
`HTTPS_PROXY`/`HTTP_PROXY`，需要完全直连时请取消这两个变量。替换二进制只需要安装
目录的写权限，不需要对二进制本身可写，因此刻意设为只读的安装同样可以升级。它们都不
加载网关配置，因此 `config.json` 有问题也不会阻塞升级。以服务方式部署时，请在更新后
重启服务。

## 快速开始

### 1. 创建网关配置

只有 `api_keys` 必填。请使用私有随机值；本地客户端会用这个 Key 访问网关。

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider"
cat > "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json" <<'EOF_CONFIG'
{
  "api_keys": ["sk-replace-with-a-private-random-key"]
}
EOF_CONFIG
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json"
```

Windows 默认目录是 `%APPDATA%\kiro-provider`。需要使用其他文件时，给 `login` 和
`serve` 传入 `--config <path>`。

### 2. 登录 Kiro

```bash
# AWS Builder ID / 默认设备码流程
kiro-provider login

# IAM Identity Center
kiro-provider login \
  --start-url https://example.awsapps.com/start \
  --region us-east-1
```

直接登录会由 Provider 自行发现并持久化 Kiro profile，不依赖 Kiro CLI 或其状态。
如果该身份有多个 profile，且 start URL 无法唯一选中，可重试并传入
`--profile-arn <arn>`。
登录/OIDC 区域与选中 profile 的运行区域可以不同；Provider 会枚举 Kiro 当前的商业
profile control plane（`us-east-1` 与 `eu-central-1`），并分别保存两者。

如果已经使用 `opencode-kiro-auth`，可以把账号一次性复制到 Provider 自有数据库：

```bash
kiro-provider accounts import
```

导入不是实时链接。完成后，kiro-provider 负责其账号副本的 token 与用量刷新。

### 3. 启动网关

```bash
kiro-provider serve
```

默认地址是 `http://127.0.0.1:8787`。另开一个终端，同时检查进程健康和带鉴权的
就绪状态：

```bash
export KIRO_GATEWAY_API_KEY='sk-replace-with-a-private-random-key'
curl -fsS http://127.0.0.1:8787/health
curl -fsS http://127.0.0.1:8787/ready \
  -H "Authorization: Bearer $KIRO_GATEWAY_API_KEY"
```

### 4. 发送 Responses 请求

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: process.env.KIRO_GATEWAY_API_KEY,
});

const response = await client.responses.create({
  model: "auto",
  input: "只回复：KIRO_OK",
});

console.log(response.output_text);
```

模型列表来自当前就绪账号。请查询 `GET /v1/models`，不要把其他账号或区域的模型
列表直接写死在客户端中。

## 接入 Agent 客户端

| 客户端      | 接口                  | 指南                                                             |
| ----------- | --------------------- | ---------------------------------------------------------------- |
| Zuno        | OpenAI Responses      | [原生 Provider 配置与会话路由](ZUNO.zh-CN.md)                    |
| Codex CLI   | OpenAI Responses      | [隔离 profile 与兼容性检查](CODEX.zh-CN.md)                      |
| Claude Code | Anthropic Messages    | [共享状态的 `kiroclaude` 启动器与模型选择](CLAUDE_CODE.zh-CN.md) |
| 其他 SDK    | Responses 或 Messages | [协议兼容范围](PROTOCOL_COMPATIBILITY.zh-CN.md)                  |

长期使用独立状态的 `kirocodex`／`kiroclaude`，参见[启动器示例](CLIENT_LAUNCHERS.zh-CN.md)。
仓库内 `kiroclaude` 默认共享原生 Claude 状态，只为当前进程覆盖 provider／模型；
仅换命令名不代表历史也已隔离。指南会注明最近一次
验证的客户端版本；这些版本是带日期的实测记录，不代表未来版本一定保持相同请求
格式。

## 配置

配置优先级为 CLI 参数、环境变量、JSON 文件、schema 默认值。未知字段和无效取值会
在启动时失败。可以从 [`config.example.json`](../../config.example.json) 开始，再到
[配置参考](CONFIGURATION.zh-CN.md)查看全部字段、环境变量、超时、文件位置和协议开关。

## 兼容方式

默认 `protocol_projection_mode: "v3-auto"` 由网关自动选择传输：

- 普通 Responses 请求使用 KiroRuntime 原生 Responses；
- `store: false`、max effort、Provider reasoning 回放、custom grammar 或协作
  item 等需要 stateless 语义的请求，使用 canonical stateless 路径；
- Anthropic Messages 直接投影到 Kiro contract，signed thinking 回放对客户端保持
  opaque；
- 无法保留的语义返回字段级错误。

这不等于完整复刻 OpenAI 或 Anthropic。托管工具、background Responses、Responses
conversation、Structured Outputs、远程文件、精确 input-token 计数、破坏性
context edit 等能力目前无法完整保留。[协议兼容说明](PROTOCOL_COMPATIBILITY.zh-CN.md)
定义当前契约；[审计索引](../audits/README.md)保存带日期的探测证据。

## 状态与安全

- `api_keys` 为空时服务拒绝启动，默认只绑定 `127.0.0.1`。
- `auth_source: "local"` 把凭据与账号状态保存在平台配置目录。数据库及其
  WAL/SHM 文件创建时只允许所属用户访问；JSON 配置也应保持 owner-only。
- 单实例锁会阻止两个 Provider 进程拆分本地账号队列与续轮状态。
- Reasoning 回放使用 AES-256-GCM 加密。日志不记录凭据、prompt、工具参数、签名或
  原始 reasoning。
- 配置 `proxy_url` 后，模型调用、登录、token 刷新和额度探测统一走该代理。

只应使用你自己控制的 Kiro 账号。本项目不用于共享或转卖访问权，也不用于绕过账号
级用量限制。

## 文档

可以浏览 [kiro-provider.firlab.app](https://kiro-provider.firlab.app/readme/)，也可以从仓库内的[文档索引](../README.md)开始，或直接查看：

- [配置参考](CONFIGURATION.zh-CN.md)
- [后台服务](SERVICE.zh-CN.md)
- [排障手册](TROUBLESHOOTING.zh-CN.md)
- [Responses 用量与上下文统计](RESPONSES_USAGE.zh-CN.md)
- [架构说明（英文）](../ARCHITECTURE.md)
- [审计与验收记录](../audits/README.md)
- [更新记录](../../changelog/README.md)

## 开发

```bash
git clone https://github.com/sunerpy/kiro-provider.git
cd kiro-provider
bun install --frozen-lockfile
make ci
make coverage-gate
bun run build:binary
```

`make pre-ci` 会执行完整的本地 PR 门禁。仓库自有检查与 Codecov 都要求 93% 覆盖率；
`codecov/project` 和 `codecov/patch` 是合并前的必需检查。实现、安全与发布约束见
[AGENTS.md](../../AGENTS.md)。

## 许可证

[MIT](../../LICENSE)
