---
title: 快速开始
description: 安装 kiro-provider、登录、启动网关并完成第一次请求。
outline: [2, 3]
---

# 快速开始

下面的步骤会把一个本地 Kiro 账号接到 OpenAI Responses，并完成第一次请求。网关保持默认 loopback 地址，客户端使用独立的私有 API Key。

## 1. 安装网关

在 Linux 或 macOS 上安装独立二进制：

```bash
curl -fsSL https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.sh | sh
kiro-provider --version
```

安装脚本会使用 Release 中的 `SHA256SUMS` 校验二进制。常驻服务应设置 `KIRO_PROVIDER_VERSION` 固定版本，不要直接跟随 `latest`。Windows、Bun 和源码安装方式见[项目 README](https://github.com/sunerpy/kiro-provider/blob/main/docs/readme/README.zh-CN.md#安装)。

之后可以用 `kiro-provider --version --check` 查看最新 Release，并用 `kiro-provider self-update` 在校验同一份 `SHA256SUMS` 后替换当前二进制。升级已安装的服务见[后台服务](../../readme/SERVICE.zh-CN.md)。

## 2. 创建私有网关 Key

```bash
export KIRO_GATEWAY_API_KEY="sk-$(openssl rand -hex 24)"
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider"
cat > "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json" <<EOF_CONFIG
{
  "api_keys": ["$KIRO_GATEWAY_API_KEY"]
}
EOF_CONFIG
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json"
```

该 Key 用于本地客户端访问 kiro-provider，并不是 Kiro 凭据。Windows 默认目录为 `%APPDATA%\kiro-provider`。修改监听地址、代理、存储或协议行为前，请先阅读[配置参考](../../readme/CONFIGURATION.zh-CN.md)。

## 3. 登录 Kiro

```bash
kiro-provider login
```

按终端提示完成设备授权。如果此前使用 `opencode-kiro-auth`，也可以执行 `kiro-provider accounts import` 一次性复制账号。导入不是实时链接；完成后，这份账号副本的 token 和用量状态由 kiro-provider 维护。

## 4. 启动并检查网关

```bash
kiro-provider serve
```

保持该进程运行。另开一个终端，必要时重新设置 `KIRO_GATEWAY_API_KEY`，然后要求两项检查都成功：

```bash
curl -fsS http://127.0.0.1:8787/health
curl -fsS http://127.0.0.1:8787/ready \
  -H "Authorization: Bearer $KIRO_GATEWAY_API_KEY"
```

`/health` 只确认进程正在提供服务；带鉴权的 `/ready` 还会确认 Provider 至少有一个可用账号。

## 5. 发送第一次请求

```bash
curl -fsS http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer $KIRO_GATEWAY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"auto","input":"只回复：KIRO_OK"}'
```

成功时会返回已完成的 Responses 对象和 assistant 文本。模型可用性与账号、区域有关；请通过带鉴权的 `GET /v1/models` 查询，不要复制其他环境的模型列表。

## 继续阅读

- [Codex CLI](../../readme/CODEX.zh-CN.md)——隔离的 OpenAI Responses profile。
- [Claude Code](../../readme/CLAUDE_CODE.zh-CN.md)——隔离的 Anthropic Messages profile。
- [Zuno](../../readme/ZUNO.zh-CN.md)——原生 Provider 配置与会话路由。
- [作为服务运行](../../readme/SERVICE.zh-CN.md)——固定版本、生命周期、日志和就绪门禁。
- [排障手册](../../readme/TROUBLESHOOTING.zh-CN.md)——任一步骤失败时按现象诊断。
