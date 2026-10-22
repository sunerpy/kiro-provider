# Kimi K3 适配边界与验证记录

> 日期：2026-10-21 · 版本：联调记录 v0.1
> 受众：kiro-provider 与客户端接入维护者

## 摘要

Kiro 控制面已经返回 `kimi-k3`，但目录发现不等于完整协议支持。本次适配保留 K3 的真实能力：`1000000` 输入 context、`131072` 输出上限、文本和图片输入，以及仅 `low`、`high`、`max` 三档 reasoning，默认 `max`。

launcher 回归与真实 Claude、pi、Codex CLI 的隔离出站验证已经执行。客户端探针使用私有网络命名空间和合成 HTTP 响应，不连接 Kiro；不能以这些结果替代真实上游生成或历史回放验收。完整验证账本汇总于 [validation.json](./evidence/kimi-k3-adaptation-2026-10-21/validation.json)。

## 1. 目录能力

| 字段               | 已认证控制面返回值   |
| ------------------ | -------------------- |
| Wire model         | `kimi-k3`            |
| Context            | `1000000`            |
| Output limit       | `131072`             |
| Input modalities   | `TEXT`、`IMAGE`      |
| Rate multiplier    | `2.4`                |
| `reasoning.effort` | `low`、`high`、`max` |
| 默认 effort        | `max`                |

发现模型之前的 `/v1/models` 缓存缺少 K3，是快照时序问题，不能作为上游不支持该模型的证据。原 provider 的 reasoning 支持名单没有 K3，因此曾将其投影为无 reasoning 等级；本次目录与 effort 处理需要一起修复。

`models[]` 与 OpenAI `data[]` 两个投影都必须保留 K3 的 context、输出上限和输入模态。`models[].supported_reasoning_levels` 只能包含这三档，`default_reasoning_level` 必须为 `max`；不得添加 K3 的 `ultra` 编排预设或不存在的 `medium/xhigh` 能力。

## 2. 请求契约

### Responses

使用原始模型标识 `kimi-k3`，通过 `reasoning.effort` 选择 `low`、`high` 或 `max`；没有请求或服务器 effort 覆盖时使用目录默认值 `max`。既有请求优先于服务器配置的顺序保持不变；有效配置若为不支持的档位，同样明确拒绝，不静默降级。不把 `medium`、`xhigh` 或 `ultra` 转换成其他档位，也不为此增加 Kiro wire model 别名。

K3 使用 canonical stateless Responses 路径。一次独立的真实 native KiroRuntime 请求返回上游 `400`，不能宣称原生续接可用；本次因此不选择该 lane。已有 native 状态的迁移请求在 dispatch 前明确拒绝，不猜测迁移 owner 或历史。

`131072` 是上游模型的固有输出能力，不代表客户端可请求一个任意的 `max_output_tokens`。没有证据支持的输出上限仍按既有 typed error 契约拒绝。

### Messages

K3 始终执行 reasoning。允许省略 `thinking`，或者使用不含 `budget_tokens`、`display` 的 `thinking: {"type":"adaptive"}`；显式关闭 thinking、定量 budget 或 display 模式不能无损表达，必须返回明确的 `400`，不能静默删除或转换。

`output_config.effort` 同样只接受 `low`、`high`、`max`，默认 `max`。

Claude Code 会发送本地 `max_tokens`。严格模式仍拒绝无法表示的请求上限；只有通过请求头 `X-Kiro-Output-Token-Limit-Mode: advisory` 显式选择 advisory 时，provider 才可省略该字段，并向客户端明确报告投影损失。不存在控制此行为的额外配置键。该模式不把任何 `max_*` 字段发送给 Kiro，也不声称客户端的较小上限已被执行。

## 3. 客户端边界

### kiroclaude

[工作树 launcher](../../scripts/kiroclaude) 对显式启动 K3 做以下处理：

- 从 `KIROCLAUDE_MODEL`、`--model` 或 `--model=...` 确定最终模型；接受客户端的 `kimi-k3[1m]` context 标注，真实出站模型仍为 `kimi-k3`。
- K3 未选择 effort 时使用 session `--effort max`，关闭继承的 Ultracode；`low/high/max` 均作为真实 session effort 传入。
- 显式 CLI effort 优先于环境默认值；最终选择为 `medium/xhigh/ultra/ultracode` 时，在启动 Claude 前失败，不执行映射。
- `--` 后的提示文本不作为 launcher 参数解析；其他 Claude/GPT 模型和 Bedrock 分支保持既有行为。

本次没有增加 K3 的 `modelPicker.behavesAs` 伪装项。尚未证明原生 picker 可以为一个自定义模型只显示三档 effort，因此不宣称交互菜单已经受这三档约束。已验证的是显式启动入口和真实 Messages 出站字段。

工作树用法如下；这些命令不代表 installed launcher 已经更新：

```bash
KIROCLAUDE_MODEL='kimi-k3[1m]' KIROCLAUDE_EFFORT=max ./scripts/kiroclaude
./scripts/kiroclaude --model 'kimi-k3[1m]' --effort low
./scripts/kiroclaude --model 'kimi-k3[1m]' --effort high
```

### pi

本机扩展按 provider 的动态目录注册模型，没有 Claude 家族白名单。新的目录必须提供 K3 的 reasoning 等级和 `output_limit`，扩展应直接读取这些能力。

当前用户扩展将所有非 `auto` 模型的本地 `maxTokens` 固定为 `128000`，比 K3 的 `131072` 小 `3072`；本任务未修改该用户文件。它设置了 `supportsMaxOutputTokens: false`，所以这个本地值不会变成发送给 Kiro 的请求上限。

隔离探针使用合成扩展，配置真实的三档 effort、`1000000/131072` 能力和文本/图片输入。已验证 pi 1.3.0 对 `low/high/max` 分别发送同值的 Responses effort；没有借助 `medium/xhigh` 映射。

### Codex

真实 Codex CLI 通过临时 `model_catalog_json` 加载 provider 当前 `handleModels()` 生成的 `models[]`，并通过 app-server `model/list` 确认 K3 可见、等级恰为 `low/high/max`、默认 `max`。随后分别执行三个真实 Responses 出站请求，effort 均保持原值，没有发送输出上限。

这证明了目录加载和 CLI 推理请求接线，不代表人工操作过 TUI `/model`。本机 kirocodex 的既有 Sol、`ultra` 和 context 启动默认值不应作为 K3 能力来源；使用 K3 时必须采用它自己的目录与显式等级。

## 4. 已执行验证

| 验证                                | 结果                              | 能证明的范围                                                                |
| ----------------------------------- | --------------------------------- | --------------------------------------------------------------------------- |
| 新增 launcher 回归                  | 修改前 `4 fail`，修改后通过       | K3 默认、合法等级、非法等级与参数入口                                       |
| launcher 专属测试集                 | `20 pass`、`289` 个断言           | 原模型、权限、配置合并与 Bedrock 回归                                       |
| Claude Code 2.1.296                 | `3/3` 合成 HTTP 请求通过          | `kimi-k3`、adaptive、无 budget/display、精确 effort、advisory 请求头        |
| pi 1.3.0                            | `3/3` 合成 HTTP 请求通过          | Responses 精确 effort、不发送输出上限                                       |
| Codex 0.162.1 目录加载              | `model/list` 通过                 | 读取 provider 的 K3 目录与三档等级                                          |
| Codex 0.162.1 出站                  | `3/3` 合成 HTTP 请求通过          | Responses 精确 effort、不发送输出上限                                       |
| 真实 Kiro SDK 生成与历史回放        | 独立 candidate 已验证；以账本为准 | 无输出上限的 max、签名 token、两代工具回放、low 与 high 图片短请求          |
| 桥接安全回归                        | `6 pass`、`32` 个断言             | 并发单次 forward、独占 ledger、能力探测严格拒绝、配置文件隔离               |
| 真实 Claude → 独立 candidate → Kiro | `200`、正常完成                   | K3/max/adaptive、advisory、无工具，端点由 private netns 和 Unix bridge 固定 |

真实 Kiro 的独立 SDK 验证没有下发任何 `max_*` 字段：max 短请求返回 `200/completed`，
349 字符 reasoning、一个 replay token；93 次 signature 观察是一次 first 与 92 次相同的
duplicate（每次 218 bytes），没有放宽 unsigned 或 conflicting signature 校验。两代工具
请求完成一次已认证的 replay 解析，low 短请求与 high 红色色块图短请求也已完成；各次
均为一个 attempt、一次 cleanup，refresh 为零。

首次真实 Claude 桥接尝试只得到 provider `400` preflight、SDK dispatch 为零；该次没有保留
typed cause，不能事后猜测。随后用真实 adapter 的合成回归确认，Claude 的 `safeguards`
能力探测必须返回 `unsupported_parameter`，不能由 provider 忽略。探针允许客户端在本地
收到该 typed `400` 后自行发送不含该字段的合法请求，不替客户端删除任何语义。

最后一次真实 Claude → private netns → Unix bridge → 独立 candidate → Kiro 验证在
2026-10-21 08:49:07–08:49:28 UTC 完成：两次 native HTTP 中，一次能力探测在本地拒绝，
仅一次 HTTP 转发至 SHA256 `72cbbcdf31ffbaebb6ec6cd1592d9928751bc9244fca370e34c6928037338d99`
的独立 candidate。该请求为 `kimi-k3/max`、adaptive、无 budget/display、advisory，返回
`200`、一个 `message_stop`、零流错误，Claude exit 0 且固定标记命中。provider 记录一次
SDK dispatch、一个 attempt、一次 cleanup、正常完成、零 refresh、零工具；input/output
分别为 `79/88` tokens，reasoning `187` 字符。全新私有 DB、tenant、keyring 与生产隔离，
副本移除了真实 refresh 材料，结束后已删除私有状态。该结果不扩大为真实客户端工具、
图片或长上下文验证。

三个客户端均没有执行工具；Codex 原生请求声明了八个工具，合成服务没有返回工具调用。探针不读取现有会话，不使用生产 API key，不更新 installed 客户端。私有网络命名空间隔离了宿主的 loopback 服务，临时状态在完成后删除。

### 复现客户端出站检查

使用 [probe-kimi-clients.ts](../../scripts/probe-kimi-clients.ts)，需要 Linux、bubblewrap、Bun，以及已安装的真实客户端：

```bash
bun scripts/probe-kimi-clients.ts \
  --claude-bin /absolute/path/to/claude \
  --pi-bin /absolute/path/to/pi \
  --codex-bin /absolute/path/to/codex \
  --out /tmp/kimi-k3-client-wire.json
```

证据只保留能力、枚举、计数与布尔值。`wire_capture_passed` 证明客户端实际使用请求中的模型与等级；`messages_contract_compatible` 单独检查 Messages thinking 形状，合成 HTTP 的成功不会替代它。Claude 真实出站 body 还会经过当前 `adaptAnthropicMessagesRequest`；只有 `safeguards` 的合法能力探测允许一次 typed 拒绝，其他不支持字段保持严格失败。

## 5. 未由本记录证明的范围

图片理解质量、接近百万 token 的真实上下文、真实客户端带工具与加密 reasoning 的跨轮回放，以及断连和超时行为，须分别以对应测试或实测证据验收。真实 SDK 的单张红色色块图与工具回放不能外推所有客户端、图片组合或任务质量。

默认 `max` 与三个等级的能力声明也不能推导其他模型同样支持 K3 的语义。此次没有修改用户的 pi 扩展、installed launcher、正式 provider 配置或服务。

## 参考

- [launcher 回归测试](../../__tests__/kiroclaude-scripts.test.ts)
- [provider 双投影实现](../../src/server/routes/models.ts)
- [Kiro 官方 Kimi K3（Experimental）说明](https://kiro.dev/docs/models/available-models/#kimi-k3-experimental)。目录与客户端的具体适配值仍以本轮已认证控制面结果和可执行证据为准。
