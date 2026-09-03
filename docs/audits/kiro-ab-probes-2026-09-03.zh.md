# Kiro 真机 A/B 探针（2026-09-03）：签名-only 推理回放与独立指令轮

对 [待实测探针清单](pending-probes.zh.md) 的 P1、P2 两项做了受控 A/B。两项均**未观察到显著差异**，按各自决策表保持现状并记录结论。附带得到两条关于 opus-5 过早停止行为的观察，值得后续单独研究。

## 结论

| 项目 | 结论 | 决策 |
| --- | --- | --- |
| P1 签名-only 推理信封回放 | `claude-sonnet-5` 在 4 跳与 10 跳任务上两臂均 30/30 完成（天花板，无法检测收益）；`claude-opus-5` + effort high 在 4 跳任务上完成率回放臂 26/150、对照臂 23/150（17.3% vs 15.3%，Fisher p = 0.76），且 opus 首轮信封为"文本 + 签名"的完整信封，不是签名-only | 保持现状：签名-only 信封不铸造 `kr1_` 令牌。在 `PROTOCOL_COMPATIBILITY.md` 记录"回放被接受但未观察到收益" |
| P2 指令作为独立用户轮 | `claude-opus-5` + effort high，turn-2 停止率 glued 38/120（31.7%）vs split 40/120（33.3%），Fisher p = 0.89，0 次错误，前后半程无时间效应 | 保持 `legacy-user-prefix` 无用户轮时的 `unshift`；在 `request-core.ts` 注释与 `PROTOCOL_COMPATIBILITY.md` 记录 |

插件侧 V8 的效应（独立系统提示轮使 turn-2 停止率升至 34.2%）在 Provider 的 wire 形态下没有复现。差异在于插件 V8 还插入了一条合成的 `[system: conversation continues]` assistant 占位轮（插件 V5 证明该占位文本本身可使停止率升至 95%），而 Provider 的形态只是把指令块作为首个用户轮，没有任何合成 assistant 文本。

## 环境与用量

- 日期：2026-09-03（Asia/Shanghai），区域 us-east-1，运行时端点 `runtime.us-east-1.kiro.dev`，SDK `@aws/codewhisperer-streaming-client` 1.0.45
- 账号：只读打开 `~/.config/kiro-provider/accounts.db`，取用量最低、access token 剩余 ≥ 30 分钟、无超额的健康账号轮询；不写库、不刷新 token；429/5xx 换账号重试一次后仍失败计为 `error` 并从分母剔除（本次 0 次 error）
- 请求总量：约 1,965 次 `generateAssistantResponse`，分布在 35 个账号；每条请求都用新的 `conversationId` 与 `agentContinuationId`，模拟 Provider 的无状态投影
- 脱敏：不记录提示词、凭据、原始签名；账号只保留 SHA-256 前 16 位
- 脚本：`scripts/probe-ab.ts`（`--dry` 只打印 wire 形态；真实运行必须带 `--confirm`）

## 共用夹具

一个 `read_ledger({name})` 工具与一条确定性账本链：`ledger-01` seed 7，之后依次 multiply 6、add 5、subtract 11（4 跳，期望 `FINAL_TOTAL=36`）；10 跳版本延续固定的运算表，期望 190。指令要求每轮只读一个条目、复述全部折叠、"then read `next` on your NEXT turn"、链结束时以 `FINAL_TOTAL=<int>` 收尾。工具结果轮的 `content` 为空字符串，与 Provider 生产投影一致。

判定口径沿用插件的过早停止调查：`continued` 为发出工具调用；`stopped` 为 HTTP 200、无工具调用、有助手文本；`empty200` 为无文本无推理无工具；`error` 剔除。P1 额外记录整段任务是否正确完成、轮次、重复调用与"宣布下一步却停止"的轮次。

## P2：指令块粘合进首个用户轮 vs 作为独立用户轮

单一结构变量，正文完全相同。glued 臂 history 为 `U{指令 + "\n\n" + 任务}`, `A{"I'll start by reading ledger-01." + toolUse}`；split 臂为 `U{指令}`, `U{任务}`, `A{同上}`。当前消息均为 `U{"", toolResults:[ledger-01]}`。模型 `claude-opus-5`，`output_config.effort = "high"`，每臂 120，两臂交替。

| arm | n | error | continued | stopped | empty200 | stopped 率 | 95% CI | 停止时宣布下一步 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| glued | 120 | 0 | 82 | 38 | 0 | 31.7% | 24.0–40.4% | 38 |
| split | 120 | 0 | 80 | 40 | 0 | 33.3% | 25.5–42.2% | 40 |

Fisher 精确检验（stopped，双侧）p = 0.8904。前半程与后半程停止数两臂均为 19/60 与 20/60，无时间效应。中位耗时 3.5 秒；两臂各约 15% 到 19% 的响应含推理事件。

功效说明：在 31.7% 基线、n = 120/臂下，本实验能以 p < 0.05 分辨约 15 个百分点以上的差异；插件报告的 16% → 34% 效应量若存在于 Provider 形态，应当被检出。

## P1：签名-only 推理信封回放

每次试验是一段完整任务：turn 1 发送 `U{指令 + 任务}`，之后每一轮把模型实际返回的文本与工具调用作为 history 的 assistant 条目、工具结果作为当前消息，直到模型不再调用工具或轮次预算耗尽。回放臂在每个 assistant 条目上带回该轮实际返回的 `reasoningContent`（`{text, signature}` 或 `redactedContent`）；对照臂省略（Provider 当前对签名-only 信封的行为）。

### 组 1：`claude-sonnet-5`（默认 effort），4 跳，n = 30/臂

| arm | n | error | 正确完成 | 错误完成 | 过早停止 | 完成率 | 95% CI | 中位轮次 | 签名-only 轮 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| replay | 30 | 0 | 30 | 0 | 0 | 100% | 88.6–100% | 5 | 29 |
| omit | 30 | 0 | 30 | 0 | 0 | 100% | 88.6–100% | 5 | 29 |

### 组 2：`claude-sonnet-5`（默认 effort），10 跳，n = 30/臂

| arm | n | error | 正确完成 | 错误完成 | 过早停止 | 完成率 | 95% CI | 中位轮次 | 签名-only 轮 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| replay | 30 | 0 | 30 | 0 | 0 | 100% | 88.6–100% | 11 | 30 |
| omit | 30 | 0 | 30 | 0 | 0 | 100% | 88.6–100% | 11 | 28 |

sonnet-5 在两种链长上都是 100% 完成、零重复调用、零"宣布后停止"，属于天花板：该夹具无法检测回放收益。观察：签名-only 信封只出现在首轮（对用户提示的响应），工具结果轮共 300 轮里没有任何推理事件；所以即便铸造令牌，也只有首轮 assistant 条目会带上它。

### 组 3：`claude-opus-5` + effort high，4 跳，n = 30/臂 与 n = 120/臂

| 运行 | arm | n | error | 正确完成 | 过早停止 | 完成率 | 95% CI | 中位轮次 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| n=30 | replay | 30 | 0 | 7 | 23 | 23.3% | 11.8–40.9% | 2 |
| n=30 | omit | 30 | 0 | 3 | 27 | 10.0% | 3.5–25.6% | 2 |
| n=120 | replay | 120 | 0 | 19 | 101 | 15.8% | 10.4–23.4% | 2 |
| n=120 | omit | 120 | 0 | 20 | 100 | 16.7% | 11.1–24.3% | 2 |
| 合并 n=150 | replay | 150 | 0 | 26 | 124 | 17.3% | — | 2 |
| 合并 n=150 | omit | 150 | 0 | 23 | 127 | 15.3% | — | 2 |

Fisher 精确检验：n=30 运行 p = 0.299；n=120 运行 p = 1.000；合并 p = 0.755。Mann–Whitney（轮次）p = 0.91。n=30 时看到的 13 个百分点差异在扩大样本后消失。

两点重要说明：

1. opus-5 在 effort high 下的首轮信封是"文本 + 签名"的**完整**信封（150 轮全部如此，签名-only 为 0），因此组 3 实际检验的是"回放完整推理信封"，与 Provider 已对完整信封铸造令牌的行为对应；结论同样是无可检测收益。
2. 所有过早停止都发生在 turn 2（收到第一个工具结果后），且 100% 伴随"宣布下一步"的文本；两臂全部 0 次重复调用。

## 附带观察：opus-5 的 turn-2 过早停止对首轮 assistant 文本高度敏感

同一指令、同一工具、同一空 `content` 的工具结果轮，turn-2 停止率在两种首轮 assistant 文本下差异巨大：

| 首轮 assistant 文本 | 来源 | turn-2 停止率 |
| --- | --- | --- |
| 固定短句 `I'll start by reading ledger-01.` | P2 夹具（人工构造） | 31.7% / 33.3% |
| 模型自己的首轮输出（含复述与 `Next: ledger-02`） | P1 组 3（真实多轮） | 83.3%（回放）/ 84.7%（对照） |

停止时的文本与继续时的文本逐字相同，只差末尾有没有追加 `tool_use`，与插件 2026-08 的观察一致。这不是 Provider 投影缺陷（工具结果轮已是插件 A/B 中最优的空 `content` 形态），而是模型对"on your NEXT turn"这类措辞与自身上一轮文本的敏感性。对使用 opus-5 high/max 的 agent 客户端而言，系统提示中明确"收到工具结果后立即继续调用工具、不要以宣布下一步结束"比网关层任何投影调整都更有效。该现象值得单独立项，本文只记录不下结论。

## 局限

- P1 在 sonnet-5 上是天花板，在 opus-5 上检验的是完整信封而非签名-only 信封；真正的"签名-only 回放"只在 sonnet-5 上可测，而 sonnet-5 在本夹具下没有可改善的空间。若未来出现 sonnet-5 过早停止的真实案例，应以该案例的 wire 形态重做本实验。
- 夹具只有一个工具、固定指令；真实 agent 的系统提示、工具集与历史长度都不同，效应量不能外推。
- 两个实验都只覆盖 turn 2 附近的行为；插件的 turn 3–5 表明更长历史下停止率趋近 0，本实验未在长历史下重复。

## 复现

```bash
bun run scripts/probe-ab.ts p2 --dry
bun run scripts/probe-ab.ts p2 --n 120 --concurrency 6 --accounts 16 --confirm
bun run scripts/probe-ab.ts p1 --n 30 --concurrency 4 --accounts 16 --confirm
bun run scripts/probe-ab.ts p1 --n 30 --concurrency 4 --accounts 16 --hops 10 --confirm
bun run scripts/probe-ab.ts p1 --n 120 --concurrency 4 --accounts 16 --model claude-opus-5 --effort high --confirm
```

每次运行输出脱敏的 trial JSONL 与 `*.summary.md`（含 Fisher 精确检验、Wilson 区间、Mann–Whitney）。
