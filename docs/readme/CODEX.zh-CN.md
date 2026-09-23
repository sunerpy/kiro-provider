# 使用 kiro-provider V3 对接 Codex CLI

简体中文 · [English](../CODEX.md)

**最近一次本地验收：**Codex CLI 0.156.1，2026-09-23，覆盖自动标题和大图片历史。
下方较完整的 V3 smoke 记录使用 0.154.0。

kiro-provider V3 提供 Codex 自定义 `model_provider` 所需的 OpenAI Responses
wire API。

长期使用且希望保留原生 Codex home 时，参见[独立客户端入口示例](CLIENT_LAUNCHERS.zh-CN.md)，
其中包含 `kirocodex`、命令鉴权、模型目录窗口、Ultra 和账号并发配置。

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

V3 按请求选择通道。普通兼容请求使用原生 KiroRuntime Responses；Ultra／max、custom
grammar、namespace 工具、`agent_message`、`additional_tools`、
`parallel_tool_calls: false`、加密 reasoning 或 `store: false` 的请求使用 canonical
stateless 通道。Codex 标题请求使用的有界本地输出 profile 也固定走该通道。

compatible fidelity 模式下，Codex 自动会话标题使用 Provider 本地执行的
`single-string-object-v1`：恰好一个 required string 字段、`store:false`，
流式文本在本地验证完成后才以 JSON 公开。该能力主要覆盖同形的单字符串元数据请求，例如 Codex 标题线程；它不是通用
Structured Outputs，也不能证明 Kiro 上游原生执行 JSON Schema。
默认 `responses_fidelity_mode: "compatible"` 启用该能力；`strict` 会在上游请求前拒绝。
`X-Kiro-Compatibility` 明确报告本地转换：裁剪首尾空白，按请求的字符串长度截断，
包装成唯一属性后验证。响应保留请求的 schema，每个元数据请求至多发起一次上游推理。

Codex 0.156.1 的自动标题线程也可能携带 collaboration namespace。当前 `tools` 和
`additional_tools` 声明经过既有校验后完整投影，兼容头额外报告
`structured_output_tool_calls_rejected`。实际输出工具调用会在公开前失败，已声明的工具
也不例外；工具调用历史、工具结果、图片和续接仍不属于这个元数据 profile。

## 带截图的长会话

网关默认 HTTP 请求体上限为 32 MiB，计算 JSON 和内联 base64 图片字节，
与 Codex 显示的 token 上下文百分比独立。历史截图可能让请求超限，即使 1M 模型仍有
大量 token 空间。重试相同请求不会减少体积。HTTP 413 后的 `error sending request`
表示上传限制问题；请求被接受后出现 `MODEL_TEMPORARILY_UNAVAILABLE` 属于另一类上游失败。

现有安装若显式配置了 10 MiB，需要把 `max_request_body_bytes` 改成 `33554432`，
并在活动请求结束后重启。总预算仍为 128 MiB，并发影响见[全局请求资源准入](CONFIGURATION.zh-CN.md#全局请求资源准入)。
模型窗口应采用所选模型的目录能力；提高 token 窗口不会提高 HTTP 字节上限。

## 复现 smoke 门禁

以下两个有界探针使用本机实际客户端，目标网关应使用独立端口、账号/状态副本，
并设置 `account_maintenance_enabled:false`：

```bash
bun scripts/probe-codex-title.ts --confirm \
  --config /private/probe/kiro-provider/config.json \
  --endpoint http://127.0.0.1:18879/v1 --out /private/probe/title-evidence.json
bun scripts/probe-codex-large-body.ts --confirm-live \
  --config /private/probe/kiro-provider/config.json \
  --endpoint http://127.0.0.1:18879/v1
```

标题探针驱动 TUI 自己的自动标题线程，并在退出后验证持久化会话名称，全程没有手动
rename。大请求探针先发送合成的历史工具图片，再让真实 Codex 调用 `view_image` 读取
14 张生成的 PNG，确认随后的请求超过 10 MiB 且完整结束。两者都加载网关的 Codex
目录投影，避免客户端静态回退选中不可用模型。报告仅包含计数、枚举与哈希；这些探针会
发起真实上游推理。

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
- `background`、Responses `conversation`、任意 Structured Outputs/JSON mode、
  `/responses/compact` 与精确 `/responses/input_tokens` 会被拒绝。只有 compatible
  模式下的单字符串元数据 profile 在本地执行；工具、continuation、复杂 Schema 和
  strict fidelity 继续 fail closed。
- 为兼容 Codex，V3 接受 `parallel_tool_calls: false`，但 Kiro 无法保证工具严格
  串行执行。
- 图片型工具结果必须使用内联 data URL，并且每个结果最多包含一个图片块；远程图片
  URL 仍会被拒绝。
- `store: false` 只关闭 Provider 的本地 Response 镜像，不等于 AWS Zero Data
  Retention 保证。

完整 wire 契约见 [V3 协议兼容范围](PROTOCOL_COMPATIBILITY.zh-CN.md)。带日期的
[初始 V3 验证](../audits/kiro-provider-v3-openai-responses-validation-2026-09-05.zh.md)
和[回放/压缩验收](../audits/responses-replay-delivery-2026-09-14.zh.md)保存了对应证据。
