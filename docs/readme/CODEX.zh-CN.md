# 使用 kiro-provider V3 对接 Codex CLI

简体中文 · [English](../CODEX.md)

**最近一次仓库内验收：**Codex CLI 0.154.0，2026-09-14。

kiro-provider V3 提供 Codex 自定义 `model_provider` 所需的 OpenAI Responses
wire API。

## 使用隔离配置运行

测试时不要修改真实 Codex profile。先创建临时配置与 SQLite 状态，再把自定义
provider 指向本地网关：

```bash
export CODEX_TEST_ROOT="$(mktemp -d)"
export CODEX_HOME="$CODEX_TEST_ROOT/home"
export CODEX_SQLITE_HOME="$CODEX_TEST_ROOT/sqlite"
mkdir -p "$CODEX_HOME" "$CODEX_SQLITE_HOME"
export LOCALGW_KEY="sk-...你的网关 api key..."

cat > "$CODEX_HOME/config.toml" <<'EOF_CONFIG'
model = "gpt-5.6-sol"
model_provider = "localgw"
model_reasoning_effort = "xhigh"

[model_providers.localgw]
name = "Local Kiro Gateway"
base_url = "http://127.0.0.1:8787/v1"
env_key = "LOCALGW_KEY"
wire_api = "responses"
EOF_CONFIG

codex exec --skip-git-repo-check "Reply with exactly: CODEX_OK"
```

Provider 需要预先启动，并至少有一个可用账号。Codex 启动前，带鉴权的
`GET /ready` 必须返回 HTTP 200。

## V3 契约覆盖范围

仓库内真实客户端门禁覆盖：普通完成回合、命令成功与失败、失败后的恢复、
compaction、Ultra reasoning，以及通过 `spawn_agent`、子代理响应和 `wait` 完成的
namespace 协作。仓库内 Codex 契约还会回放当前 `view_image` 的 function output
形状：保留工具调用关联，并把图片字节提升到同一个 Kiro user turn。验收还会检查输出
中是否泄露 Provider 私有 custom/namespace 别名。

V3 按请求选择通道。普通兼容请求使用原生 KiroRuntime Responses；需要 custom
grammar、namespace 工具、`agent_message`、`additional_tools`、
`parallel_tool_calls: false`、加密 reasoning 或 `store: false` 的请求使用 canonical
stateless 通道。

## 复现 smoke 门禁

Smoke 脚本会建立隔离的 Codex profile、capture proxy 和临时 workspace：

```bash
CODEX_SMOKE_CODEX_BIN=/absolute/path/to/codex \
CODEX_SMOKE_EXPECTED_VERSION=0.154.0 \
KIRO_PROVIDER_SMOKE_MODE=tools \
bash scripts/codex-smoke.sh
```

Capture 只包含脱敏后的请求元数据：计数、item type、role、哈希和存在性标记。文件
位于 owner-only 临时目录，并由退出 trap 删除。脚本不会持久化凭据、原始请求体、
reasoning envelope 或 prompt 正文。

## 限制

- KiroRuntime 不提供 OpenAI 托管的 Web Search、File Search、Computer Use 或托管
  MCP 工具。
- `background`、Responses `conversation`、Structured Outputs、
  `/responses/compact` 与精确 `/responses/input_tokens` 会被拒绝。
- 为兼容 Codex，V3 接受 `parallel_tool_calls: false`，但 Kiro 无法保证工具严格
  串行执行。
- 图片型工具结果必须使用内联 data URL，并且每个结果最多包含一个图片块；远程图片
  URL 仍会被拒绝。
- `store: false` 只关闭 Provider 的本地 Response 镜像，不等于 AWS Zero Data
  Retention 保证。

完整 wire 契约见 [V3 协议兼容范围](PROTOCOL_COMPATIBILITY.zh-CN.md)。带日期的
[初始 V3 验证](../audits/kiro-provider-v3-openai-responses-validation-2026-09-05.zh.md)
和[回放/压缩验收](../audits/responses-replay-delivery-2026-09-14.zh.md)保存了对应证据。
