# 配合 Codex CLI 使用 kiro-provider

kiro-provider 提供 `POST /v1/responses`，即 OpenAI Responses API 的协议格式。当 [Codex CLI](https://github.com/openai/codex) 的自定义 `model_provider` 设置 `wire_api = "responses"` 时会使用这个格式，因此可以让 Codex 直接对接你自己的 Kiro 账号。

已于 2026-08-22 使用 **codex-cli 0.149.0-alpha.4.1** 完成真实端到端
验证，包括一次实际 shell 工具往返。

## 支持范围

- ✅ 支持对话、推理、标准 `function` 工具、Codex 内置的 `exec` / `apply_patch` 工具（`custom`），以及多智能体 `collaboration` 工具（`namespace`）。
- 网关会把 `custom` 和 namespace 子工具转换成本次请求内的 Kiro JSON-schema function 别名，并在返回 Codex 前恢复为 `custom_tool_call` 或带 namespace 的 `function_call`。成功的 Responses 结果不会泄漏内部别名。
- 工具调用与结果按 `call_id` 配对；流式和非流式响应共用同一条全有或全无的恢复路径。
- Codex 即使当前任务只需要本地工具，也可能声明 OpenAI 托管的
  `web_search`。Provider 会为协议兼容接受该声明，但不会把它暴露给 Kiro，
  因为本服务无法执行 OpenAI 托管工具；也不会用隐藏提示词模拟搜索。

OpenAI custom tool grammar 有一项明确限制：Kiro 不提供 token-level CFG
constrained decoding。kiro-provider 只把 custom tool 结构化桥接成一个字符串
输入，再为 Codex 恢复 raw call；不会把 grammar 粘贴进工具描述或隐藏提示词。
因此 grammar 约束仍由 Codex 侧负责。

Codex 不需要增加私有会话 Header。它正常发送的 Responses
`client_metadata` / `prompt_cache_key` 会驱动持久化的账号与 Kiro
`conversationId` 绑定；访问令牌刷新后也会继续复用所选账号的 keep-alive
连接池。这是尽可能复用物理连接，不保证每个回合固定使用同一条 TCP socket。

`previous_response_id` 与 `conversation` 需要真实的服务端 response 状态存储；
当前会返回 `unsupported_stateful_responses`，Codex 回合需要携带完整输入历史。

## 隔离测试配置（绝不会碰你真实的 `~/.codex`）

如果你已经在用 Codex 跑真实项目，不要直接编辑 `~/.codex/config.toml` 来试用。应分别使用临时的 `CODEX_HOME` 和 `CODEX_SQLITE_HOME`，同时隔离文件形式的 config/auth/log 状态与 Codex 的 SQLite 状态，避免影响正常配置。

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

注意事项：

- `base_url` 对应 kiro-provider 默认的 `host`/`port`（`127.0.0.1:8787`）；如果你的 `serve` 命令用了不同的值，请相应调整。
- `LOCALGW_KEY` 必须是你 kiro-provider `config.json` 里 `api_keys` 列表中的某一个 Key。
- 必须设置 `wire_api = "responses"`。kiro-provider 的 Chat Completions 端点（`/v1/chat/completions`）没有实现 Responses 协议格式，而 Codex 对自定义 provider 只会说 Responses。
- 网关必须已经在运行（`kiro-provider serve`）。默认共享模式请先执行
  `opencode auth login` 并登录 Kiro，且需鉴权的 `/ready` 应返回 200；只有
  显式选择 `auth_source: "local"` 时才使用本地登录/导入。

## 现成的冒烟测试脚本

`scripts/codex-smoke.sh` 把上面的流程封装成一个 fail-closed 的脚本：它在同一个 `mktemp -d` 下创建彼此独立的 `CODEX_HOME` 与 `CODEX_SQLITE_HOME`，若任一路径解析到受保护的 Codex 状态目录内就拒绝运行，然后写入临时 `config.toml` 并非交互执行 `codex exec`。默认的 `Reply with exactly: OK` 只证明连通性和推理能力：

```bash
bash scripts/codex-smoke.sh
```

显式启用工具探针后，脚本还会执行一次成功的 custom 命令、一次失败 custom 命令后的恢复，以及一次 namespace collaboration 调用：

```bash
KIRO_PROVIDER_SMOKE_MODE=tools bash scripts/codex-smoke.sh
```

工具探针会同时检查 Codex JSON 事件和确定性的文件副作用，还会通过不记录 headers 的 loopback 请求体抓包确认公开 namespace call/output 配对、定向 child task、child answer 与已完成的 wait。它拒绝任何 `kiro_custom_*` / `kiro_ns_*` 内部别名泄漏，并把每轮限制在 120 秒内。工具选择仍由模型决定；若模型拒绝按要求调用工具，探针会失败，而不会给出假阳性。两种模式都不会写入真实的 Codex home 或 SQLite 状态。

## 端点说明

- `POST /v1/responses` —— OpenAI Responses API。支持流式（类型化 SSE：`response.created`、`response.output_item.added`、`response.output_text.delta`、`response.output_item.done`、`response.completed`、`response.failed`，以及 reasoning-summary 系列事件）和非流式 JSON。与其他所有路由一样，需要 `Authorization: Bearer <api_key>`。

其余 API 说明见根目录 [README](../../README.md#features)（`/v1/messages`、需显式开启的 `/v1/chat/completions`、`/v1/models`、`/health`）。真实客户端验证证据见
[`E2E_VALIDATION_2026-08-22.md`](../E2E_VALIDATION_2026-08-22.md)。
