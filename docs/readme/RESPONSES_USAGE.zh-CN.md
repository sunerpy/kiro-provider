# Responses 用量与上下文统计

本契约覆盖 `/v1/responses` 的 JSON Create、SSE 终止响应和 Retrieve。
实现对照官方 OpenAI SDK、OpenAPI 用量结构及 `@ai-sdk/openai`。

## 标准字段

- `input_tokens` 包含普通输入、缓存读取和缓存写入。
- `input_tokens_details.cached_tokens`、`cache_write_tokens` 是输入的子项，不能重复相加。
- `output_tokens` 包含回复、工具调用和推理；`reasoning_tokens` 是输出的子项。
- `total_tokens = input_tokens + output_tokens`，属于本次响应。
- 保留明确的零值；缺失值不直接当作零。只有其他真实计数能唯一确定时才推导缺失计数。
- 负数、小数、不安全整数、相互矛盾的总量或子项返回 `invalid_upstream_usage`，不为修统计重试生成。

## 真实值、估算和未知值

本次实测的 Kiro Generate 通道只返回上下文占用百分比和 credits，没有精确
input/output、缓存和推理 token 明细。不能把这些不同维度互相冒充。

沿用 `responses_fidelity_mode`：

| 模式              | 上游真实统计完整                   | 上游统计不足                                       |
| ----------------- | ---------------------------------- | -------------------------------------------------- |
| `compatible` 默认 | 保留真实总量和明细                 | 提供可用于上下文管理的估算，标明来源，省略未知明细 |
| `strict`          | 返回符合完整官方 schema 的 `usage` | 省略 `usage`，不补造缺失计数                       |

兼容响应通过 `usage.metadata.kiro` 标明 `source`、`estimated_fields`、
`unknown_fields`、当前上下文来源；已取得的部分真实计数保存在 `reported`。
`metering` 单独保留上游计量值与单位，credits 不换算成 token 或货币。
这些 metadata 是 Provider 扩展，不冒充 OpenAI 定义的精确测量字段。

未知明细省略整个对象，不发送 `{}`：Codex 在明细对象存在时要求其中必须有
`cached_tokens` 或 `reasoning_tokens`。来源说明也镜像到
`response.usage_metadata.metadata`，供 Codex 的原始响应观测使用。

部分 SDK 会把缺失的缓存或 reasoning 明细显示成零。应查看原始 `usage` /
AI SDK 7 的 `result.finalStep.usage.raw` 或每个 `result.steps[i].usage.raw`，
以及 `unknown_fields`，不能据客户端默认零值断定没有缓存或推理。累计 usage
不会保留各步骤的 raw metadata。

依赖 usage 自动压缩的客户端，在当前 Kiro 缺少完整计数时应保留默认兼容模式。
严格模式省略 usage 表示未知，不表示零、空上下文或重置累计值。

## 当前上下文与累计消耗

Provider 每个响应只报告本次生成的用量。多轮和工具循环可以累计计费用量，
但压缩必须使用最近一次响应对应的上下文，再考虑新追加的输入。
压缩后的下一次请求建立新的上下文基线，不叠加压缩前已退休的窗口。

AI SDK 7 的名称与旧版本不同：

```ts
const result = await generateText(options);
const currentContext = result.finalStep.usage.totalTokens;
const cumulativeConsumption = result.usage.totalTokens;
```

AI SDK 7 的 `result.totalUsage` 是 `result.usage` 的弃用别名。
`streamText` 则需要等待 `result.finalStep` 和 `result.usage`。
官方 OpenAI SDK 的 `response.usage` 属于本次响应；Codex 退出时显示的 thread
总量则是历史请求的累计，不能用于判断单次窗口是否已满。

Codex 使用最近一次 `usage.total_tokens` 加上新追加 item 的估计值。
Stateless 返回 `X-Reasoning-Included`，表示历史 reasoning 已计入上下文，
避免客户端再重复估算；native 通道保留上游提供的对应响应头。

## 百分比分母与封顶

实测 Sol Generate：260K padding 约为 96.17%；300K、790K 都返回 100%，
但首尾独立随机标记均完整保留。Kiro 的百分比仍基于旧的 272K，且会封顶，
不能直接乘当前公开的 872K prompt 预算，也不能把 100% 永远算作 272K。

实现分别保留模型预算和原始百分比分母；未饱和的有效观测用于校准，
100% 仅作为下界，较长请求按实际投影内容继续计数。

本地估算覆盖指令、保留的历史、工具定义、调用参数和返回结果，
排除账号/profile/conversation 标识。图片按图片估算，不把 base64 像素当文字；
opaque reasoning 另行估算。缓存只保留文本哈希和计数，不保留提示词。

估算使用 `js-tiktoken` 的 `o200k_base`。Kiro 的隐藏提示、非 OpenAI 模型、
图片和 opaque reasoning 仍可能产生误差，所以保留现有模型余量和压缩安全边界，
不宣称能够恢复未公开的精确推理开销或账单。

## 状态与历史

Create、终止 SSE、Retrieve 的 usage 和来源保持一致。旧响应是历史快照，
不批量改写；旧客户端累计的估算值不会因此自动变成真实值。
本次不迁移账号或 replay key，回滚仍应保留匹配的二进制和数据库备份。

官方来源、英文契约及字段示例见 [RESPONSES_USAGE.md](../RESPONSES_USAGE.md)。
