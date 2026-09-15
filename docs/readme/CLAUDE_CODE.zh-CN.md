# 在 Claude Code 中使用 kiro-provider

简体中文 · [English](../CLAUDE_CODE.md)

**最近验证的客户端：**Claude Code 2.1.263。后续版本可能增加 beta header 或请求
字段；要扩大兼容声明，需先重新验证真实请求形态。

kiro-provider 提供 Claude Code 所需的两个 Anthropic 兼容端点：

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`——返回估算值，并带有
  `x-kiro-token-count-mode: estimate`

## 启动隔离的 Kiro 会话

先确认本地网关正常且已有可用账号：

```bash
curl -fsS http://127.0.0.1:8787/health
curl -fsS -H "Authorization: Bearer $(scripts/kiroclaude-token)" \
  http://127.0.0.1:8787/ready
```

再通过仓库内的启动器运行 Claude Code：

```bash
PATH="$PWD/scripts:$PATH" kiroclaude -p 'Reply with exactly: KIROCLAUDE_OK'
```

`kiroclaude` 将 `CLAUDE_CONFIG_DIR` 设为 `~/.kiroclaude`，不会修改
`~/.claude/settings.json`。因此普通 `claude` 命令仍使用原有 provider，包括原生
Amazon Bedrock。独立目录也避免 Kiro 凭据、signed thinking 和会话历史进入普通
Claude 配置。

Release installer 目前不安装这些辅助脚本。临时测试可直接从 checkout 运行；确定
长期使用后再自行复制或建立链接。

### 默认值与覆盖方式

| 设置 | 默认值 |
| --- | --- |
| 网关根地址 | `http://127.0.0.1:8787`，不能带 `/v1` |
| 配置目录 | `~/.kiroclaude` |
| 模型 | Opus 5 |
| 推理模式 | Ultra，即 `effortLevel: "xhigh"`、`ultracode: true` |
| 离开后的 recap | 关闭 |
| 标题、分类等非必要流量 | 关闭 |
| Experimental betas | 开启 |

需要调整时，只覆盖本次隔离进程：

```bash
KIROCLAUDE_BASE_URL=http://127.0.0.1:18787 \
KIROCLAUDE_CONFIG_DIR=/tmp/kiroclaude-profile \
KIROCLAUDE_MODEL=sonnet \
KIROCLAUDE_EFFORT=high \
PATH="$PWD/scripts:$PATH" kiroclaude
```

`KIROCLAUDE_EFFORT=ultra` 是默认值，会启用 Ultracode 并发送 `xhigh`。设置为
`low`、`medium`、`high`、`xhigh` 或 `max` 时，则使用对应的普通 effort 档位并
关闭 Ultracode。

启动器将 `kiroclaude-token` 注册为 Claude Code 的 `apiKeyHelper`。该 helper 从
`${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json` 读取第一个非空
`api_keys`，也可通过 `KIROCLAUDE_PROVIDER_CONFIG` 指定其他文件。文件不属于当前
用户或对其他用户开放时，helper 会拒绝读取；API key 也不会进入工具子进程的环境
变量。

## 选择模型

内置 Claude 行分别映射到 `claude-opus-5`、`claude-sonnet-5` 和
`claude-haiku-4-5`。启动器还会在 picker 中加入 `gpt-5.6-sol`、
`gpt-5.6-terra` 和 `gpt-5.6-luna`。

Claude Code 的 gateway discovery 会过滤掉 ID 中不含 `claude` 或 `anthropic`
的模型，所以这三个 GPT 行需要显式声明。它们以 `behavesAs: "claude-opus-5"`
作为客户端能力模板，从而获得 adaptive thinking 和左右切换 effort 的能力，无需
为每个 effort 档位重复模型。Claude Code 对这些自定义行只显示保守的 200K context
window；这项声明不会让客户端强制执行 Kiro 侧更大的 GPT 上限。

Claude Code 还会发送正整数 `max_tokens`（验证过的 GPT 请求为 64,000），但 Kiro
GPT stateless schema 会拒绝已测试的所有上游 output-token 字段。启动器因此发送：

```text
X-Kiro-Output-Token-Limit-Mode: advisory
```

该声明只对三个 GPT-5.6 模型生效。Provider 会在请求 Kiro 前移除 `max_tokens`，
记录 `anthropic_output_token_limit_unenforced`，并返回
`x-kiro-output-token-limit-mode: advisory-unenforced`。缺少或错误的 header、非
GPT 请求仍会 fail closed。它也不会改变 OpenAI Responses、Chat Completions、
其他 Anthropic 客户端或普通 `claude` 命令的行为。

私有模型目录可通过 `KIROCLAUDE_SOL_MODEL`、`KIROCLAUDE_TERRA_MODEL` 和
`KIROCLAUDE_LUNA_MODEL` 覆盖这三个 ID。

### 通过原生 Bedrock 使用 Fable 5.1

Fable 不能直接成为 Kiro picker 的一行，因为 Claude Code 会在进程启动时固定
provider 和 base URL。请使用另一个 profile 启动 Bedrock 备用后端：

```bash
PATH="$PWD/scripts:$PATH" kiroclaude --bedrock-fable
```

该模式使用 `~/.kiroclaude-fable`、`model: "fable"`、max effort、
`AWS_PROFILE=us-claude`、`AWS_REGION=us-east-2` 和
`ANTHROPIC_DEFAULT_FABLE_MODEL=us.anthropic.claude-fable-5-1`，不会设置 Kiro token
helper 或 `ANTHROPIC_BASE_URL`。对应覆盖项为 `KIROCLAUDE_AWS_PROFILE`、
`KIROCLAUDE_AWS_REGION`、`KIROCLAUDE_FABLE_MODEL` 和
`KIROCLAUDE_FABLE_EFFORT`。

Kiro 与 Bedrock 之间的切换需要启动新进程，不能在已有会话中当作普通模型切换。

## 兼容边界

适配器接受 Claude Code 2.1.263 中已经观察到的请求形态：

- 文本、base64 图片、标准工具、`tool_use`、`tool_result` 和 `is_error`；
- 每条 user message 中一个带图片的 `tool_result`，并保留工具身份、状态、文本和
  图片字节；
- 图片或 tool result 两侧构成一个连续文本簇的相邻文本块；
- 顶层及会话中途的 system 文本，按既有 projection mode 投影；
- adaptive thinking、`output_config.effort` 和 Claude 路径支持的 `temperature`；
- GPT effort 投影到 `reasoning.effort`，Claude effort 保持
  `output_config.effort`；
- 通过 opaque `kr1_` signature 加密回放被隐藏的 signed thinking；
- 隐藏 GPT-5.6 纯省略号 reasoning，包括 `"." + "." + "."` 分片，并在续轮时
  精确恢复已存储的原始块；
- 校验 prompt-cache marker 后将其作为不支持的提示移除，同时返回
  `x-kiro-prompt-cache-mode: unsupported` 和零 cache-token 用量；
- 无损的 `clear_thinking_20251015` / `keep: "all"` `context_management`，返回
  `applied_edits: []`；
- Anthropic SSE 顺序、流内错误、背压、上游静默期间的 `ping`，以及
  `x-claude-code-session-id` affinity。

同一条消息包含多个图片型 tool result，或将普通 user 图片与图片型 tool result
混用时，请求会被拒绝，因为 Kiro 无法保留不同的图片来源。真正的
`text → 非文本 → text` 交错输入也会被拒绝：Kiro 只有一个文本字段。

Destructive context edits、Structured Outputs、强制工具、硬性串行工具要求和未知
beta/tool 字段会返回 Anthropic `invalid_request_error`，不会被静默删除。Prompt
caching 与 token counting 仍是估算能力，不是 Anthropic 原生服务。

## 排障

| 现象 | 处理方式 |
| --- | --- |
| Token helper 报文件权限不安全 | 运行 `chmod 600 ~/.config/kiro-provider/config.json`，并确认文件属于当前用户。 |
| `capability_rejected:context_management` | 客户端请求了支持范围外的 destructive edit。不要用未经审计的删字段代理隐藏错误。 |
| Picker 中没有 Kiro GPT 模型 | 通过 `kiroclaude` 启动；单靠 gateway discovery 会过滤这些 ID。 |
| 普通 `claude` 使用了错误后端 | 检查普通 `~/.claude` 配置；`kiroclaude` 不会修改它。 |

参考资料：[Messages API](https://platform.claude.com/docs/en/api/messages/create)、
[Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol) 和
[Claude Code 环境变量](https://code.claude.com/docs/en/env-vars)。
