# 配合 Codex CLI 使用 kiro-provider

kiro-provider 提供 `POST /v1/responses`。Codex 自定义 `model_provider` 设置
`wire_api = "responses"` 时会使用该协议。

## v0.5.0-rc.3 当前状态

2026-08-27 使用编译后二进制和 **Codex CLI 0.150.0-alpha.9** 进行门禁；
客户端只配置标准 base URL、API key、模型和 reasoning effort。
`claude-opus-5-max` 已通过 Provider 模型校验。调用 Kiro 前的第一个字段级
拒绝为：

```json
{"reasoning":{"summary":"none"}}
```

`reasoning.summary` 没有经过证明的 Kiro 等价能力，因此 Provider 返回 HTTP
400：`unsupported_reasoning_summary`，字段路径为 `reasoning.summary`。
Provider 不会忽略该字段，也不会用提示词模拟。因此该 Codex 版本目前
**尚未通过 v0.5 稳定版门禁**。

未来 Codex 请求若落在已验证子集内，Responses 适配器可提供精确的
function/custom 声明与结果、加密 reasoning 回放，以及标准字段驱动的账号与
Kiro conversation 亲和。namespace 身份、custom grammar、托管 Web Search、
有状态 Responses，以及存在可调用工具时的仅串行保证仍会明确报 capability
错误。

## 隔离兼容性探针

不要修改真实 `~/.codex`。使用隔离的文件和 SQLite 状态：

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
codex exec --skip-git-repo-check "Reply with exactly: CODEX_OK"
```

Codex 0.150.0-alpha.9 的 RC.3 预期结果是非零退出，并在
`reasoning.summary` 返回 `unsupported_reasoning_summary`。未来出现受支持的请求形态后，
还必须继续验证真实 shell/custom 工具往返、续轮，以及 Provider 重启后的
reasoning 回放，才能标记为支持。

网关必须预先运行。默认共享认证模式先执行 `opencode auth login`，并要求带
鉴权的 `GET /ready` 返回 200。验收契约不包含私有 Header 或请求改写代理。

当前证据见
[`../audits/kiro-provider-v0.5.0-rc.3-opus5-validation-2026-08-27.md`](../audits/kiro-provider-v0.5.0-rc.3-opus5-validation-2026-08-27.md)。
旧的 [`../E2E_VALIDATION_2026-08-22.md`](../E2E_VALIDATION_2026-08-22.md)
仅是历史 v0.4 记录。
