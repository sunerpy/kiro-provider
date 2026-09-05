# 使用 kiro-provider V3 对接 Codex CLI

> **日期**：2026-09-05 · **已验证客户端**：Codex CLI 0.153.0

kiro-provider V3 提供 Codex 自定义 `model_provider` 所需的 OpenAI Responses
wire API。

## V3 已支持契约

编译后的 V3 候选已通过隔离真实客户端门禁，覆盖：

- 普通 `response.completed` 回合；
- custom command 执行及精确副作用；
- 命令失败后的成功恢复；
- 通过 `spawn_agent`、子代理响应与 `wait` 完成 namespace 协作；
- Provider 私有 custom/namespace 别名零泄漏。

需要 custom grammar、namespace 工具、`agent_message`、`additional_tools`、
`parallel_tool_calls: false`、加密 reasoning 或 `store: false` 的 Codex 请求
会自动使用 V3 stateless 兼容通道；普通请求使用原生 KiroRuntime Responses。

## 配置

测试时不要修改真实 Codex profile，应隔离文件与 SQLite 状态：

```bash
export CODEX_TEST_ROOT="$(mktemp -d)"
export CODEX_HOME="$CODEX_TEST_ROOT/home"
export CODEX_SQLITE_HOME="$CODEX_TEST_ROOT/sqlite"
mkdir -p "$CODEX_HOME" "$CODEX_SQLITE_HOME"
export LOCALGW_KEY="sk-...你的网关 api key..."

cat > "$CODEX_HOME/config.toml" <<'EOF'
model = "gpt-5.6-sol"
model_provider = "localgw"
model_reasoning_effort = "xhigh"

[model_providers.localgw]
name = "Local Kiro Gateway"
base_url = "http://127.0.0.1:8787/v1"
env_key = "LOCALGW_KEY"
wire_api = "responses"
EOF

codex exec --skip-git-repo-check "Reply with exactly: CODEX_OK"
```

网关必须预先运行，并已填充 Provider 自有账号库。启动客户端前，要求带鉴权的
`GET /ready` 返回 HTTP 200。

## 可复现 smoke 门禁

仓库 smoke 脚本会创建隔离 Codex 状态、隔离 capture proxy 与临时 workspace：

```bash
CODEX_SMOKE_CODEX_BIN=/absolute/path/to/codex \
CODEX_SMOKE_EXPECTED_VERSION=0.153.0 \
KIRO_PROVIDER_SMOKE_MODE=tools \
bash scripts/codex-smoke.sh
```

Capture 只会写入 owner-only 临时目录，并由退出 trap 删除。失败诊断只打印
item type、role、工具名与存在性标记，不输出凭据、原始 reasoning envelope 或
prompt 正文。

## 仍存在的边界

- KiroRuntime 不提供 OpenAI 托管 Web Search、File Search、Computer Use 或托管
  MCP 工具。
- `background`、Responses `conversation`、Structured Outputs、
  `/responses/compact` 与精确 `/responses/input_tokens` 会被明确拒绝。
- 为兼容 Codex，V3 接受 `parallel_tool_calls: false`，但 Kiro 不提供硬性串行
  工具保证。
- `store: false` 会阻止本地 Response 镜像，但不等于 AWS Zero Data Retention
  保证。

详见 [V3 协议兼容范围](PROTOCOL_COMPATIBILITY.zh.md) 与
[V3 验证证据](../audits/kiro-provider-v3-openai-responses-validation-2026-09-05.zh.md)。
