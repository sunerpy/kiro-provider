# 在 Claude Code 中使用 kiro-provider

kiro-provider 提供 Claude Code 使用的 Anthropic 兼容端点：

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`（估算；响应包含
  `x-kiro-token-count-mode: estimate`）

本修订版以 Claude Code **2.1.263** 为兼容目标。未来版本可能增加新的 beta
header 或请求字段；升级客户端后应重新抓取请求形状，不能自动沿用本结论。

## 隔离的 `kiroclaude` 配置

仓库 `scripts/` 下提供 Linux 启动脚本。它使用独立
`CLAUDE_CONFIG_DIR`，将设置、插件、凭据、signed thinking 与会话历史同普通
`~/.claude` 完全隔离。脚本不会编辑 `~/.claude/settings.json`，因此普通
`claude` 命令继续使用已有 provider，包括原生 Amazon Bedrock。

仅从当前 checkout 运行：

```bash
PATH="$PWD/scripts:$PATH" kiroclaude -p 'Reply with exactly: KIROCLAUDE_OK'
```

默认值：

- 网关根地址 `http://127.0.0.1:8787`，不能追加 `/v1`；
- 独立目录 `~/.kiroclaude`；
- 内置 Opus/Sonnet/Haiku 分别固定为 `claude-opus-5`、
  `claude-sonnet-5`、`claude-haiku-4-5`；
- 额外提供 `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna` 三个
  picker 行；
- 默认 Opus 5 + Ultra 模式，即 `effortLevel: "xhigh"` 与
  `ultracode: true`；
- 通过 `awaySummaryEnabled: false` 与
  `CLAUDE_CODE_ENABLE_AWAY_SUMMARY=0` 双重关闭离开后 recap；
- 关闭非必要 Claude 流量，因为 Kiro 无法约束标题/分类请求使用的 Structured
  Outputs；
- 不关闭 experimental betas。

隔离验收示例：

```bash
KIROCLAUDE_BASE_URL=http://127.0.0.1:18787 \
KIROCLAUDE_CONFIG_DIR=/tmp/kiroclaude-profile \
KIROCLAUDE_MODEL=sonnet \
KIROCLAUDE_EFFORT=high \
PATH="$PWD/scripts:$PATH" kiroclaude
```

`KIROCLAUDE_EFFORT=ultra`（默认）会启用 Ultracode 并发送 `xhigh`。显式设置
`low`、`medium`、`high`、`xhigh` 或 `max` 时会关闭 Ultracode，并使用对应普通
effort 档位。

`kiroclaude-token` 作为 Claude Code `apiKeyHelper` 使用。它从
`${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json` 读取第一个非空
`api_keys`（可用 `KIROCLAUDE_PROVIDER_CONFIG` 覆盖），要求文件仅 owner 可读写，
并且不会把 key 注入工具子进程环境。

本修订版不把脚本接入 release installer；临时验收直接从 checkout 运行，只有在
明确决定永久启用后才复制或链接。

### Bedrock Fable 5.1 备用后端

Fable 不能直接作为 Kiro picker 的另一行：Claude Code 的 provider/base URL 是
进程级选择，不会随 picker 行切换。当前 MyOpenAI 提供 OpenAI API，但没有
Anthropic Messages 端点；已有原生 Bedrock profile 则已提供 Fable 5.1。使用
独立进程和 profile 启动：

```bash
PATH="$PWD/scripts:$PATH" kiroclaude --bedrock-fable
```

该模式使用 `~/.kiroclaude-fable`、`model: "fable"`、max effort、
`AWS_PROFILE=us-claude`、`AWS_REGION=us-east-2` 与
`ANTHROPIC_DEFAULT_FABLE_MODEL=us.anthropic.claude-fable-5-1`，不会设置 Kiro
`apiKeyHelper` 或 `ANTHROPIC_BASE_URL`。可分别用
`KIROCLAUDE_AWS_PROFILE`、`KIROCLAUDE_AWS_REGION`、
`KIROCLAUDE_FABLE_MODEL` 与 `KIROCLAUDE_FABLE_EFFORT` 覆盖。这是启动时后端
选择，不能在已有 Kiro 会话中热切换。

### GPT 模型选择与输出上限边界

Claude Code 的 gateway discovery 会有意过滤掉 ID 中不含 `claude` 或
`anthropic` 的模型，因此无法自动发现 kiro-provider 返回的 GPT ID。启动器改用
三个显式 `modelPicker` 行；每行设置 `behavesAs: "claude-opus-5"`，让 Claude
Code 2.1.263 继承 effort、xhigh/max 与 adaptive thinking。因此选择 Sol、Terra
或 Luna 后可直接左右切换 effort，不需要把每个 suffix variant 都显示成独立
模型。Claude Code 当前对这些自定义行报告保守的 200K context window；启动器
不会把 Kiro 侧更大的 GPT limit 宣称成客户端已经强制执行的 window。

Claude Code 会固定发送正整数 `max_tokens`（已验证 GPT 请求为 64,000），但
Kiro GPT stateless schema 会拒绝所有已探测的 output-token 字段拼写。启动器因此
显式发送：

```text
X-Kiro-Output-Token-Limit-Mode: advisory
```

该声明只对 GPT-5.6 Sol/Terra/Luna 生效，表示调用方接受 `max_tokens` 是 Claude
Code 的必填字段、但 Kiro 上游无法强制执行。Provider 不把它发给 Kiro，记录
`anthropic_output_token_limit_unenforced` 审计事件，并在响应中返回
`x-kiro-output-token-limit-mode: advisory-unenforced`。缺少 Header、值拼错或用于
非 GPT 模型时都不能绕过验证。OpenAI Responses、Chat Completions、普通
Anthropic 客户端以及普通 `claude` 命令继续保持默认 fail closed。

私有兼容目录可通过 `KIROCLAUDE_SOL_MODEL`、`KIROCLAUDE_TERRA_MODEL`、
`KIROCLAUDE_LUNA_MODEL` 覆盖三个 GPT ID。`behavesAs` 和客户端请求形状可能随
Claude Code 版本变化，因此当前支持结论仍固定在 2.1.263。

## 当前支持边界

Messages 适配器支持 Claude Code 2.1.263 的实际请求：

- 文本、base64 图片、标准工具、`tool_use`、`tool_result` 与 `is_error`；
- 每条 user message 支持一个带图片的 `tool_result`：其中的 base64 图片会提升到
  同一个 Kiro user turn，同时保留 tool ID、状态、文本和原始图片字节；同一消息内
  多个图片型 tool result，或与普通 user 图片混用时仍会 fail closed，因为 Kiro
  无法保留这些不同的图片归属；
- 顶层及会话中途的 system 文本，按既有 Kiro projection mode 投影；
- adaptive thinking 与 `output_config.effort`；
- GPT effort 转换为 Kiro `reasoning.effort`；Claude 模型继续使用
  `output_config.effort`；
- GPT-5.6 Sol/Terra/Luna 的纯省略号 reasoning 会先缓冲再隐藏，包括
  `"." + "." + "."` 分片；Claude Code 只收到空 thinking 与原生签名，续轮时
  Provider 按 assistant 输出指纹恢复存储的原始 placeholder；
- `thinking.display: "omitted"`：真实 Kiro thinking 与签名加密存入 replay
  store，客户端只收到空 thinking 和 opaque `kr1_` signature，续轮时恢复原始块；
- cache marker 只作为性能提示校验并移除，同时返回
  `x-kiro-prompt-cache-mode: unsupported`，cache token 用量为零；
- `context_management` 仅接受无损的
  `clear_thinking_20251015` / `keep: "all"`，并返回
  `applied_edits: []`；
- Claude 路径的 `temperature`；
- 严格 Anthropic SSE 顺序、流内错误、背压，以及上游静默期间的 `ping`；
- 使用 `x-claude-code-session-id` 作为显式账号/会话 affinity。

Kiro 无法表达的语义仍然明确拒绝：destructive context edits、Structured
Outputs、强制工具、串行工具保证和未知 beta/tool 字段返回 Anthropic
`invalid_request_error`，不会静默丢弃。Prompt caching 和 token counting 不是
Anthropic 原生能力。

## 就绪与排障

启动前要求：

```bash
curl -fsS http://127.0.0.1:8787/health
curl -fsS -H "Authorization: Bearer $(scripts/kiroclaude-token)" \
  http://127.0.0.1:8787/ready
```

helper 报权限错误时，将 provider 配置设为 `chmod 600`。
`capability_rejected:context_management` 表示客户端请求了无损子集以外的编辑；
不要再叠加未经审计的删字段代理。

参考：

- [Claude Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol)
- [Claude Code environment variables](https://code.claude.com/docs/en/env-vars)
