# 为 Claude Code 和 Codex 配置独立的 Kiro 入口

简体中文 · [English](../CLIENT_LAUNCHERS.md)

以下 Linux／macOS／WSL 示例保留普通 `claude`、`codex` 命令及其用户配置目录。
需要已运行的 kiro-provider、Python 3、Claude Code 2.1.270 或 Codex 0.154.0，
并在与 provider 版本匹配的 checkout 中操作。其他客户端版本需另行验证。

需要区分连接覆盖与状态隔离。仓库自带的 `kiroclaude` 默认共享原生 Claude
状态，只为当前进程叠加连接与模型设置；个人 `kirocodex` 若仍使用 `~/.codex`，
即使用 `-c` 覆盖 provider，也会共享配置、历史、技能、插件和记忆。
启动器本身不写入 provider 设置，但客户端正常操作仍可能写入共享状态。
以下示例使用独立目录；项目指令和管理员策略仍会生效，这不等于操作系统沙箱。

## 安装辅助脚本

在相同版本的 checkout 根目录执行，保留原客户端命令名：

```sh
mkdir -p "$HOME/.local/bin"
install -d -m 700 "$HOME/.local/libexec/kiro-provider"
install -m 755 scripts/kiroclaude scripts/kiroclaude-token \
  "$HOME/.local/libexec/kiro-provider/"
```

Token helper 读取仅当前用户可访问的 provider `config.json`，无需把 API key
写入 wrapper 或导出到工具子进程。Release 二进制安装器目前不安装这些辅助脚本。
下列步骤用 `set -C` 拒绝覆盖已有文件；已有自定义 launcher／配置时请合并内容。

## 创建独立的 `kiroclaude`

```sh
(
  umask 077
  set -C
  cat > "$HOME/.local/bin/kiroclaude" <<'SH'
#!/bin/sh
set -eu
umask 077
export KIROCLAUDE_CONFIG_DIR="${KIROCLAUDE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kiroclaude}"
mkdir -p "$KIROCLAUDE_CONFIG_DIR"
exec "$HOME/.local/libexec/kiro-provider/kiroclaude" "$@"
SH
)
chmod 755 "$HOME/.local/bin/kiroclaude"
```

可使用绝对路径运行，也可将 `~/.local/bin` 放入 `PATH`：

```sh
kiroclaude
kiroclaude --model fable
KIROCLAUDE_MODEL=sonnet KIROCLAUDE_EFFORT=high kiroclaude
```

启动器已经为验证过的 Opus、Sonnet、Fable、Sol、Terra、Luna 默认项配置
`[1m]` 与 `autoCompactWindow: 1000000`。Claude 发请求前去掉 `[1m]`，
Haiku 仍为 200K，自定义模型覆盖值原样保留。默认 Ultra 在已验证客户端上
发送 `xhigh`。启动器也包含保持 Fable thinking 和 Bash 历史回放稳定的兼容设置；
再包一层 wrapper 时应保留这些设置。

网关根地址为 `http://127.0.0.1:8787`，**不能带 `/v1`**。
可用 `KIROCLAUDE_BASE_URL` 修改；凭据配置不在默认位置时使用
`KIROCLAUDE_PROVIDER_CONFIG`。权限沿用客户端默认行为，具体模型与权限控制见
[Claude Code 接入说明](CLAUDE_CODE.zh-CN.md)。

## 创建独立的 `kirocodex`

在专用 home 中创建长期使用的配置：

```sh
(
  umask 077
  kiro_codex_state="${KIROCODEX_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/kirocodex}"
  mkdir -p "$kiro_codex_state/sqlite"
  set -C
  cat > "$kiro_codex_state/config.toml" <<'TOML'
model = "gpt-5.6-sol"
model_provider = "kiro"
model_reasoning_effort = "ultra"
web_search = "disabled"

[model_providers.kiro]
name = "Kiro Provider"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
supports_websockets = false

[model_providers.kiro.auth]
command = "sh"
args = ["-c", 'exec "$HOME/.local/libexec/kiro-provider/kiroclaude-token"']
timeout_ms = 5000
refresh_interval_ms = 300000
TOML
  cat > "$HOME/.local/bin/kirocodex" <<'SH'
#!/bin/sh
set -eu
umask 077
export CODEX_HOME="${KIROCODEX_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/kirocodex}"
export CODEX_SQLITE_HOME="${KIROCODEX_SQLITE_HOME:-$CODEX_HOME/sqlite}"
export KIRO_PROVIDER_CONFIG="${KIROCODEX_PROVIDER_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json}"
mkdir -p "$CODEX_SQLITE_HOME"
exec codex "$@"
SH
)
chmod 755 "$HOME/.local/bin/kirocodex"
```

```sh
kirocodex
kirocodex exec --skip-git-repo-check "Reply with exactly: KIROCODEX_OK"
```

Provider 配置应放在这个专用的用户级 `config.toml` 中，而不是项目
`.codex/config.toml`。Wrapper 中的 home 环境变量仅作用于其子进程；
不要在 shell 全局导出这些变量，也不要把普通 `codex` 命令替换成别名。

Codex 会读取网关模型目录中的上下文和推理能力。已验证的在线 Sol 目录声明
1M，Codex 0.154.0 使用 950,000 tokens 的有效预算；保守静态回退目录可能更小。
对于**已验证的 1M 模型**，也可以只在本次启动时显式指定：

```sh
kirocodex --model gpt-5.6-sol -c model_context_window=1000000
```

切换到小窗口模型时不要沿用这项覆盖。Ultra 是客户端编排预设，实际推理 effort
为 `max`，不是 Kiro 的模型别名或名为 `ultra` 的 wire effort。
示例保留客户端默认权限，并关闭当前上游不提供的托管 Web Search。
更多接口细节见 [Codex 接入说明](CODEX.zh-CN.md)；自定义 provider 鉴权与
`CODEX_HOME` 规则以 [Codex 官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)为准。

## 请求协议与并行任务

`kiroclaude` 使用 Anthropic 兼容 Messages，`kirocodex` 使用 OpenAI Responses。
这是**客户端协议**；Kiro 上游通道由 `v3-auto` 单独选择。可无损支持的
Responses 形状可以走 KiroRuntime native Responses，Ultra／max、
`store: false`、namespace 协作等不兼容形状走 canonical stateless 通道。
这两个入口都不通过旧 Chat Completions 中转，也不强制发送上游不支持的 native 请求。

Provider 默认每账号十个推理槽位（`account_inference_concurrency`，可设 1–10）。
独立分支可使用同一账号或不同合格账号，同一有状态分支仍保序。让 Claude 自己生成
session／agent 身份 header，不要填固定全局值。客户端自己的 Agent 数量限制与
服务端账号容量是两项设置。

新 home 不继承旧目录的历史和客户端本地插件，需要在新目录配置所需扩展。
把整个 home 链接回原目录会恢复共享状态。跨不支持签名互通的 provider 时应新建会话。
客户端窗口为 1M 不代表所有模型都已通过满 1M 输入验收，详见
[实测限制与验收结果](../audits/agent-workflow-validation-2026-09-17.zh.md)。
