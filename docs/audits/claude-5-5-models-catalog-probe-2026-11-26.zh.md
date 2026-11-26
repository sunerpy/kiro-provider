# Kiro Claude Fable 5.2、Sonnet 5.5 与 Haiku 5.5 目录与请求字段探测

日期：2026-11-26（Asia/Shanghai）

## 结论

Kiro 上游新增三个 wire 模型，可作为一等目录模型接入：

| 公开 ID             | wire ID             | 倍率 | thinking.type               | effort 默认值 |
| ------------------- | ------------------- | ---: | --------------------------- | ------------- |
| `claude-fable-5-2`  | `claude-fable-5.2`  |    6 | `adaptive`                  | `high`        |
| `claude-sonnet-5-5` | `claude-sonnet-5.5` |  1.3 | `adaptive`、`between_tools` | `high`        |
| `claude-haiku-5-5`  | `claude-haiku-5.5`  | 0.06 | `adaptive`、`disabled`      | `medium`      |

- 三者都是 1,000,000 input / 64,000 output，`supportedInputTypes` 为 `TEXT`、
  `IMAGE`，支持 prompt caching；`output_config.effort` 为完整
  `low|medium|high|xhigh|max` 五档，`thinking.display` 为 `summarized|omitted`。
- 三者都进入 `XHIGH_CAPABLE_MODELS`、adaptive thinking 显示集合与
  `PROBE_CONFIRMED_MAX_TOKENS_MODELS`。Codex 默认档位取各自 schema 的 `default`。
- Haiku 5.5 显式 `thinking.type: "disabled"` 返回 200 且不推理；同一请求不带
  thinking 字段时仍会推理，因此显式禁用会原样下发。Fable 5.2 与 Sonnet 5.5 的
  schema 不含 `disabled`，上游以 `REQUEST_BODY_INVALID` 拒绝，网关对它们保持
  不发送 thinking 字段的既有行为。
- Sonnet 5.5 的 `between_tools` 直接发送返回 `400 Improperly formed request.`，
  网关从不生成该类型。
- 同一天，`claude-opus-5.5` 的目录输出上限从 128,000 降为 64,000，schema 中
  `max_tokens` 的 `maximum` 也变为 64,000。

另外，取证账号所在组织在同一天停用了旧模型：`claude-fable-5.1`、`claude-opus-5`、
`claude-sonnet-5`、`claude-haiku-4.5` 不再出现在目录中，请求返回
`400 INVALID_MODEL_ID`（"Your current model is made unavailable by the admins in
your organization"）。这是组织级策略，不能据此推断 Kiro 在所有组织下线这些模型。

## 方法

- 上游操作：管理面 `ListAvailableModels`（`management.us-east-1.kiro.dev`，
  `origin=AI_EDITOR`），以及 KiroRuntime `GenerateAssistantResponse`
  （`us-east-1`，带 profile）。
- 隔离边界：`~/.config/kiro-provider/accounts.db` 以只读方式打开，不刷新 token、
  不写库；不触碰已安装服务、生产配置和 replay keyring。请求经本机
  `http://127.0.0.1:1080` 代理出网（不经代理时 Claude 模型会误报
  `INVALID_MODEL_ID`）。同一账号上 `claude-opus-5.5` 与 `claude-haiku-5.5` 的 control 返回 200，用作
  出网路径对照。
- 请求正文全部为合成文本；证据只保留枚举、计数、长度、哈希和上游校验信息。
- 可复现命令（账号 access token 剩余有效期需超过 30 分钟）：

```sh
bun run scripts/probe-v3-request-fields.ts --confirm \
  --model claude-sonnet-5.5 --proxy http://127.0.0.1:1080 \
  --cases control,effort_xhigh,effort_low,effort_max,thinking_summarized,thinking_omitted,thinking_adaptive,thinking_disabled,thinking_between_tools,max_tokens,max_tokens_64000,max_tokens_64001,max_tokens_upper,max_tokens_128001,max_output_tokens
```

## 结果

### 管理面目录

见 [`evidence/claude-5-5-models-catalog-probe-2026-11-26/management-catalog.json`](evidence/claude-5-5-models-catalog-probe-2026-11-26/management-catalog.json)。
14 个健康账号逐一调用，结果一致：每个账号都列出同样 15 个模型，默认模型为
`claude-opus-5.5`，都包含三个新模型，都不含 `claude-fable-5.1`。

15 个模型为 `auto`、`claude-opus-5.5`、`claude-sonnet-5.5`、`claude-haiku-5.5`、
`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`kimi-k3`、`claude-opus-4.6`、
`claude-fable-5.2`、`deepseek-3.2`、`minimax-m2.5`、`minimax-m2.1`、`glm-5`、
`qwen3-coder-next`。

### 请求字段

见 [`evidence/claude-5-5-models-catalog-probe-2026-11-26/request-fields.json`](evidence/claude-5-5-models-catalog-probe-2026-11-26/request-fields.json)。

| 用例                                                     | Fable 5.2                  | Sonnet 5.5                 | Haiku 5.5        |
| -------------------------------------------------------- | -------------------------- | -------------------------- | ---------------- |
| `control`                                                | 200                        | 200                        | 200              |
| `effort_xhigh` / `effort_low` / `effort_max`             | 200                        | 200                        | 200              |
| `thinking_summarized` / `thinking_omitted`               | 200                        | 200                        | 200              |
| `thinking_adaptive`（不带 display）                      | 200                        | 200                        | 200              |
| `thinking_disabled`                                      | 400 `REQUEST_BODY_INVALID` | 400 `REQUEST_BODY_INVALID` | 200，0 reasoning |
| `thinking_between_tools`                                 | 400                        | 400                        | 400              |
| `max_tokens` 1,024 / 64,000 / 64,001 / 128,000 / 128,001 | 均 200                     | 均 200                     | 均 200           |
| `max_output_tokens`                                      | 400 `REQUEST_BODY_INVALID` | 400                        | 400              |

出现推理时每次都带 1 个签名；omitted 显示只返回签名、不返回推理文本。同一个需要
推理的合成提问下，`effort_low` 与 `effort_max` 的推理字符数为 Fable 5.2 0 → 122、
Sonnet 5.5 0 → 114、Haiku 5.5 73 → 297（`effort_xhigh` 沿用旧的简短提问，不参与
比较）。这是单次观测；接入五档 effort 的依据是 schema 枚举加上各档返回 200。

经隔离网关的 Messages 请求（需要推理的合成提问、`effort: max`、`display: summarized`）
三个模型都返回可见摘要和 1 个完整原生签名：Fable 5.2 138 字符、Sonnet 5.5 192 字符、
Haiku 5.5 714 字符。

### 输出 token 上限

目录与 schema 声明 64,000，但上游对 1,024 到 128,001 全部返回 200，Opus 5.5 也
一样（2026-09-26 时 128,001 曾被拒绝）。上游当前不执行该上限。网关保留共享的
1,024–128,000 请求范围：收紧会让现有客户端（例如对 Opus 5.5 发送 128,000 的
客户端）新增被拒请求，而上游并不拒绝。目录展示的 `output_limit` 采用 64,000。

## 跨账号推理回放

本机 121 个账号共用同一个 profile ARN 和区域 `us-east-1`。用
`scripts/probe-replay-portability.ts --confirm --model <wire id> --effort max --reasoning-challenge`
在账号 A 产生签名推理和工具调用，再在账号 B 的新会话中带工具结果回放：

| 模型                | 结果                                   |
| ------------------- | -------------------------------------- |
| `claude-sonnet-5.5` | 3/3 通过                               |
| `claude-haiku-5.5`  | 3/3 通过                               |
| `claude-fable-5.2`  | 3/3 通过                               |
| `claude-opus-5.5`   | 3/3 通过（补上 2026-09-26 欠下的探测） |

见 [`replay-portability.json`](evidence/claude-5-5-models-catalog-probe-2026-11-26/replay-portability.json)。
Sonnet 5.5 不加 `--reasoning-challenge` 时会直接调用工具、不产生可回放的签名推理，
探针因此无法取证。仓库探针原先在第二轮对带点的 wire ID 报 `Unsupported model`，
现已在读取 `--model` 后注册该 wire ID。

三个新模型的 cell 放进 `VERIFIED_SAME_PROFILE_REPLAY_CELLS`：证据只覆盖同一个
profile，因此与 Fable 5.1 一样要求目标账号的 profile 与 mint profile 一致。Opus 5.5
的 cell 保持原位，注释改为记录这次自身探测。

## 摘要显示的签名形态

`scripts/probe-reasoning-signatures.ts --confirm --model <wire id> --display summarized --turns 3 --long`
直接请求上游，每个模型 2 次、每次 3 轮，共 24 轮：每轮都只有 1 个签名事件
（`signature_relation: first`），推理文本 269 到 7,674 字符，没有出现 2026-10-09 时
Opus 5.5 那种多段不同签名。合成提问不含工具调用和长历史，不能代替真实长会话。见
[`summarized-signatures.json`](evidence/claude-5-5-models-catalog-probe-2026-11-26/summarized-signatures.json)。

## 已安装客户端

两个客户端都经隔离网关验证：网关运行本分支源码，账号库是生产库的只读副本，refresh
token 已替换为占位符，端口与密钥独立，不触碰已安装服务。

- **kirocodex 投影**：Codex CLI 0.171.0 读取网关 `/v1/models` 作为
  `model_catalog_json`。`scripts/probe-client-model-switch.ts --client codex` 的 9 行
  矩阵共 18 次运行全部通过，包括 `claude-sonnet-5-5` ↔ `-low`、
  `claude-haiku-5-5-max` → base、`claude-fable-5-2` → `claude-opus-5-5`、
  `gpt-5.6-sol` → `claude-sonnet-5-5`；每次均完成工具轮次并回放推理。见
  [`client-switch-codex.json`](evidence/claude-5-5-models-catalog-probe-2026-11-26/client-switch-codex.json)。
- **kiroclaude 投影**：本机 `/etc/claude-code/managed-settings.json` 固定
  `ANTHROPIC_BASE_URL` 指向生产端口，优先级高于 `--settings`。因此按
  [CLAUDE_CODE.md](../CLAUDE_CODE.md) 的隔离方法，在 bwrap 私有挂载命名空间中用
  `--managed-policy-copy` 把策略副本指向 capture 端口，宿主策略不变。Claude Code
  2.1.322 经仓库 `scripts/kiroclaude` 运行 4 行矩阵共 8 次，全部通过，包括
  `claude-opus-5-5` → `claude-sonnet-5-5`、`claude-fable-5-2` → `claude-opus-5-5`、
  `claude-sonnet-5-5` → `claude-haiku-5-5`。每个会话首个请求按预期被拒
  （`messages.1.output_config`，客户端随即去掉该字段重试），探针把它计为预检拒绝。
  见 [`client-switch-claude.json`](evidence/claude-5-5-models-catalog-probe-2026-11-26/client-switch-claude.json)。
- Claude Code 对每个模型（包括三个新模型）都发送 `max_tokens: 128000`。若把请求
  上限收紧到目录声明的 64,000，kiroclaude 的每个请求都会被拒绝，这也是保留共享
  1,024–128,000 范围的直接原因。
- `scripts/probe-client-context.mjs`（合成 loopback）在本机无法运行：managed 端点
  会把 fixture 流量导向生产端口。脚本现在检测到这种覆盖时直接拒绝启动。

## 接入范围

- 已接入：目录条目（Sonnet/Haiku 带 `low`…`max` 变体与 `-thinking` 别名，Fable 5.2
  与 Fable 5.1 一样只列 base）、五档 effort、adaptive thinking 显示、
  `max_tokens` 透传、Haiku 5.5 显式禁用、Codex 档位与默认值。Fable 5.2 沿用
  Fable 5.1 的 Codex Ultra（`ultra`、`multi_agent_version: "v2"`、
  `multi_agent_reasoning_effort: "max"`）与无状态 Responses 路由。
- 有意不扩展，保持 fail-closed：空签名冲突前缀省略恢复、
  `anthropic_thinking_display_mode` 与 `responses_thinking_display_mode` 的
  forced-omitted 策略（仍只限 Fable 5.1 与 Opus 5.5）、web search cell、原生
  Responses capability cell。跨账号 reasoning replay 在取证后以同 profile cell 接入，
  见上文。

## 已知限制

- **跨账号 reasoning replay 只覆盖同一 profile。** 取证账号共用一个 profile，未验证
  跨 profile 迁移；Messages 之外的协议（Responses）没有为 Claude 模型开放迁移。
- **冲突前缀省略未取证。** Fable 5.1 出现过的多段空签名前缀，新模型上尚未复现，
  出现时按错误处理。
- **原生 Responses 未验证。** 原生通道自 2026-09-21 起对整个账号池返回 403，
  无法取证；Fable 5.2 按 Fable 5.1 先例强制走无状态投影。
- **显式关闭 thinking 仍是近似。** Fable 5.2 与 Sonnet 5.5 的 schema 不含
  `disabled`，网关与 Opus 5.5 一样省略 thinking 字段；带 effort 时模型仍会自适应推理，
  响应里会出现 thinking 块。隔离网关上 Fable 5.2、Sonnet 5.5 和 Opus 5.5 均如此。这是
  既有行为，本次未改变；只有 Haiku 5.5 会下发 `disabled`。
- **只开 thinking 时的默认 effort。** Messages 请求只开 thinking、不给 effort 和
  budget 时沿用网关既有的 `medium` 回退，而不是 schema 默认值；Codex 的默认档位按
  schema 显示。
- **Sonnet 5.5 与 Haiku 5.5 的 Responses 通道** 与 Opus 5.5 一样，在请求语义允许时
  默认走原生 `CreateResponse`；`store: false` 的请求走无状态投影。
- **未做满 1M 输入验收**，沿用目录声明。
- **组织策略可能再变。** 旧模型的停用来自组织管理员，其他组织的可用模型可能不同；
  provider 按各账号目录快照过滤可调度账号。
