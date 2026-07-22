# 配合 Codex CLI 使用 kiro-provider

kiro-provider 提供 `POST /v1/responses`，即 OpenAI Responses API 的协议格式。当 [Codex CLI](https://github.com/openai/codex) 的自定义 `model_provider` 设置 `wire_api = "responses"` 时会使用这个格式，因此可以让 Codex 直接对接你自己的 Kiro 账号。

已在 **codex-cli 0.144.6** 上验证。

## 支持范围

- ✅ 支持对话、推理和标准 `function` 工具。
- ❌ 不支持 Codex 内置的 `exec` / `apply_patch` 工具（`custom`）和多智能体 `collaboration` 工具（`namespace`）。原因是上游 Kiro 模型不会生成这些工具所需的 `custom_tool_call` 或 namespace 调用协议。

这是明确的能力边界：网关会接收 Codex 对这些不支持工具类型的声明，但不会声称或模拟它们能够执行。

## 隔离测试配置（绝不会碰你真实的 `~/.codex`）

如果你已经在用 Codex 跑真实项目，不要直接编辑 `~/.codex/config.toml` 来试用。改用一个临时的 `CODEX_HOME`：Codex 会读取 `CODEX_HOME` 环境变量来整体重定位它的 config/auth/log/state 目录，所以指向一个临时目录就能完全隔离，不会影响你的正常配置。

```bash
export CODEX_HOME="$(mktemp -d)"        # 隔离环境；不会动到真实 ~/.codex
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

注意事项：

- `base_url` 对应 kiro-provider 默认的 `host`/`port`（`127.0.0.1:8787`）；如果你的 `serve` 命令用了不同的值，请相应调整。
- `LOCALGW_KEY` 必须是你 kiro-provider `config.json` 里 `api_keys` 列表中的某一个 Key。
- 必须设置 `wire_api = "responses"`。kiro-provider 的 Chat Completions 端点（`/v1/chat/completions`）没有实现 Responses 协议格式，而 Codex 对自定义 provider 只会说 Responses。
- 网关必须已经在运行（`kiro-provider serve`），且已导入或登录过至少一个 Kiro 账号（`kiro-provider login` 或 `kiro-provider accounts import`）；否则 Codex 无对象可谈。
- 网关支持的任何模型在这里的用法都和 `/v1/chat/completions` 一致，包括推理模型（Claude 走你配置的代理，GPT 直连）。

## 现成的冒烟测试脚本

`scripts/codex-smoke.sh` 把上面的流程封装成一个 fail-closed 的脚本：它用 `mktemp -d` 创建自己的 `CODEX_HOME`，在导出任何环境变量之前先校验这个目录不是 `~/.codex` 或其子目录，写入临时 `config.toml`，然后非交互运行 `codex exec`。其中 `Reply with exactly: OK` 这一轮只证明连通性和推理能力，不验证工具能力。等网关启动、账号导入完成后自行运行：

```bash
bash scripts/codex-smoke.sh
```

它绝不会写入你真实的 `~/.codex`。

## 端点说明

- `POST /v1/responses` —— OpenAI Responses API。支持流式（类型化 SSE：`response.created`、`response.output_item.added`、`response.output_text.delta`、`response.output_item.done`、`response.completed`、`response.failed`，以及 reasoning-summary 系列事件）和非流式 JSON。与其他所有路由一样，需要 `Authorization: Bearer <api_key>`。

其余 API 说明见根目录 [README](../../README.md#features)（`/v1/chat/completions`、`/v1/models`、`/health`）。
