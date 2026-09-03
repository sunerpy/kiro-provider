# 待实测探针清单

记录已有线索、但尚未用真实 Kiro 流量验证的假设；两项均已于 2026-09-03 完成实测（见各节状态行）。每一项写明要测什么、
怎么测（沿用 [`scripts/probe-evidence.ts`](../../scripts/probe-evidence.ts)
的只读探针风格）、以及各种结果分别会推动什么决策。清单只登记，不做结论；
完成后应新增一份带日期的探针记录并在 [README](README.md) 中登记，本文件
对应条目标记为已完成并指向该记录。

探针共同约束（与 2026-09-02 探针一致）：只读打开
`~/.config/kiro-provider/accounts.db`，选取用量最低且 access token 剩余有效期
≥ 10 分钟的健康账号；不写库、不刷新 token；不打印凭据、原始签名或提示词，
签名只输出 SHA-256 前 16 位。

## P1：签名-only 推理信封是否值得铸造回放令牌
> **状态：已完成（2026-09-03）**，结果与决策见 [Kiro 真机 A/B 探针（2026-09-03）](kiro-ab-probes-2026-09-03.zh.md)。结论：两臂无显著差异（sonnet-5 为天花板；opus-5 完成率 17.3% vs 15.3%，p = 0.76），保持不为签名-only 信封铸造令牌。


### 现状

Claude 在工具调用轮次会发出 `reasoningContentEvent{text:"", signature}`，
即只有签名、没有可见推理文本的信封（见
[2026-09-02 探针](kiro-protocol-evidence-probe-2026-09-02.zh.md) B20 序号 1、
B25 首轮）。Provider 与插件目前都把它当作"不完整"丢弃：不铸造 `kr1_` 令牌，
Responses 的 reasoning 条目不带 `encrypted_content`，
[`PROTOCOL_COMPATIBILITY.md`](../PROTOCOL_COMPATIBILITY.md) 也将其表述为
"Incomplete/signature-only upstream events produce no token"。

2026-09-02 探针 B25 已经证明：把 `{text:"", signature}` 原样放回 history 的
assistant 条目并继续工具结果轮次，Kiro 返回 200，且同会话、新会话、另一账号
均接受。也就是说回放它在协议上是安全的；未知的是它**有没有用**。

### 待验证

回放签名-only 信封是否改善工具循环内的连续性：模型在多工具任务中是否更少
出现"宣布下一步却不调用工具就结束"、更少重复已完成的步骤、最终完成率是否
更高。

### 方法

- 在 `scripts/probe-evidence.ts` 中新增探针 `p1`：一个需要 3～4 次串行工具
  调用才能完成的固定任务（例如依次 `list_dir` → `read_file` → `grep` →
  `write_summary`，结果由脚本确定性生成），每次工具结果轮次都在新
  `conversationId` 下发送完整 history，模拟 Provider 的无状态投影。
- 两臂对照，同一账号、同一模型（`claude-sonnet-5`，另加 `--effort high`
  一组）、同一任务与工具集：
  - **回放臂**：history 中每个工具调用轮次的 assistant 条目携带
    `reasoningContent.reasoningText = {text:"", signature}`；
  - **对照臂**：省略 reasoningContent（当前 Provider 行为）。
- 每臂 n ≥ 30 次完整任务运行，交替执行以抵消时间效应。记录：任务是否完成
  （最后一步工具被调用且输出正确）、总轮次数、出现 `tool_intent_open`
  形态（文本以宣布动作结尾且本轮无 toolUse）的轮次数、重复调用同一工具
  同一参数的次数。
- 输出与 2026-09-02 探针相同的脱敏 JSON；统计采用双侧 Fisher 精确检验
  （完成率）和 Mann-Whitney（轮次数）。

### 决策

| 结果 | 决策 |
| --- | --- |
| 回放臂完成率或过早停止率有显著改善（p < 0.05，且绝对差 ≥ 10 个百分点） | 为签名-only 信封铸造 `kr1_` 令牌（Responses）并在 Anthropic 直传中允许 `thinking: ""` + 签名回放；放宽 `PROTOCOL_COMPATIBILITY.md` 的"incomplete"表述为"签名-only 信封会产生令牌，回放时以空文本 + 签名投影"；在 `sdk_stream_terminal` 中补充 `witness_kind` 对签名-only 的区分。 |
| 无显著差异 | 保持现状；在 `PROTOCOL_COMPATIBILITY.md` 补一句"回放签名-only 信封被接受但未观察到收益（探针日期）"，避免重复调查。 |
| 回放臂更差，或出现 400 `Invalid signature` 以外的新错误形态 | 保持丢弃；把新错误形态记入 [`STREAM_ERROR_CONTRACT.md`](../STREAM_ERROR_CONTRACT.md) 的分类表。 |

## P2：`legacy-user-prefix` 在没有用户轮时的独立用户轮投影
> **状态：已完成（2026-09-03）**，结果与决策见 [Kiro 真机 A/B 探针（2026-09-03）](kiro-ab-probes-2026-09-03.zh.md)。结论：glued 31.7% vs split 33.3%（p = 0.89），保持无用户轮时的 unshift。


### 现状

`legacy-user-prefix` 投影把 system/developer 指令拼成前缀。有用户轮时前缀
并入首个用户消息；**没有**用户轮时（例如历史以 assistant 或工具结果开头）
它会把指令作为一条独立的用户消息 `unshift` 到最前
（[`src/kiro/transform/request-core.ts`](../../src/kiro/transform/request-core.ts)
约 100–111 行，`path: "legacy-user-prefix"`）。

插件侧 A/B（n = 120/臂）显示："系统提示作为独立历史轮"使 turn-2 的过早停止
率升至 34.2%（p = 0.0008），而"前缀并入首个用户消息"为对照组。该数据来自
插件的 wire 形态，尚未在 Provider 的投影输出上复现。

### 待验证

在 Provider 生成的 Kiro wire 形态下，"指令作为独立首个用户轮"是否同样显著
提高 turn-2 过早停止率；以及两种可替代方案（并入首个用户消息；无用户轮时
拒绝请求）哪一种在真实请求分布中可行。

### 方法

- 在 `scripts/probe-evidence.ts` 中新增探针 `p2`，直接构造两种 history：
  - **独立轮臂**：`U{指令}`, `A{content}`, `A{toolUses:[x]}`,
    `U{toolResults:[rx]}`（当前 unshift 形态）；
  - **并入臂**：`U{指令 + "\n\n" + 原首个用户文本}`, 其余相同。
  对照臂使用同一指令文本、同一工具与结果、同一 `currentMessage`（第二个工具
  结果），要求模型完成剩余两步工具调用。
- 同一账号、同一模型；每臂 n ≥ 60（若要复现插件的效应量 n = 120/臂更佳），
  交替执行。记录 turn-2 是否发出工具调用、是否以宣布动作结尾但无 toolUse、
  可见文本长度。
- 另统计 Provider 真实流量中"legacy-user-prefix 且无用户轮"的出现频率：在
  `log_level: "debug"` 下用 `request_shape` 事件筛
  `user_message_count: 0` 且 `system_instruction_present: true`，与
  `upstream_affinity_selected.projection_mode` 关联，判断该路径是否值得
  保留。

### 决策

| 结果 | 决策 |
| --- | --- |
| 独立轮臂过早停止率显著更高（复现插件结论） | 修改 `request-core.ts`：无用户轮时不再 `unshift`，改为并入第一条非指令消息之前最近的用户文本；若历史中完全没有可并入的用户消息，则以 `unsupported_instruction_projection` 拒绝并在 `PROTOCOL_COMPATIBILITY.md` 记录。同步更新 `history-builder` 相关测试。 |
| 无显著差异 | 保持 `unshift`；在 `request-core.ts` 注释与 `PROTOCOL_COMPATIBILITY.md` 记录探针结论，关闭该项。 |
| `request_shape` 统计显示该路径在真实流量中几乎不出现 | 无论 A/B 结果如何，优先选择"拒绝"方案以缩小 legacy 模式表面，并按计划在 legacy 模式移除时一并删除。 |
