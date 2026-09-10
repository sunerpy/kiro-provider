# Responses 实测对照：协议修复是否改善了实际调用

> **日期**：2026-09-10（UTC） · **基线**：v3.0.1 / d3ce4cd
> **范围**：隔离 Kiro 实测、官方 OpenAI SDK、Codex 与 Zuno；不涉及生产替换。

## 验收结果

最终官方 SDK 的 38 个案例全部通过，Codex/Zuno 的 12 个案例全部通过。检查覆盖工具参数、call_id 关联、工具结果计算、完整 output 回放、原生与本地 reasoning token、失败恢复、Plan 尾部指令和 effort。只收到 HTTP 200 或 `response.completed` 不算通过。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 官方 TypeScript SDK 7.13.0 | 38/38 | [SDK 请求与响应](evidence/responses-fidelity-2026-09-10/sdk-acceptance.json) |
| Codex 0.153.4 / Zuno 0.10.29 | 12/12 | [客户端结果](evidence/responses-fidelity-2026-09-10/clients-acceptance.json) |
| strict 模式 | 五个模型组，35/35 断言 | [精确拒绝与正常对照](evidence/responses-fidelity-2026-09-10/sdk-strict.json) |
| 服务重启与缓存丢失 | native opaque 与 kr1 两条链均恢复 | [重启 SDK 验证](evidence/responses-fidelity-2026-09-10/restart-sdk.json) |
| 原失败账号的 custom JSON/SSE | 三轮、六组通过 | [第 1 轮](evidence/responses-fidelity-2026-09-10/sdk-pinned-fixed-1.json)、[第 2 轮](evidence/responses-fidelity-2026-09-10/sdk-pinned-fixed-2.json)、[第 3 轮](evidence/responses-fidelity-2026-09-10/sdk-pinned-fixed-3.json) |
| namespace/custom 能力矩阵 | 60 个工具案例通过 | [JSON 矩阵](evidence/responses-fidelity-2026-09-10/full-matrix-experimental.json)、[SSE 矩阵](evidence/responses-fidelity-2026-09-10/full-matrix-stream.json) |

SDK 矩阵共执行 85 次成功生成：27 次 native、54 次 native-adapted、4 次 stateless。满足 native 限制的 81 次全部进入 CreateResponse。其余四次明确请求 `store:false` 和 max reasoning，继续采用 stateless。这一比例只描述该请求集合，不代表所有 Codex/Zuno 请求都会变为 native。

实现、回滚要求和配置说明见[主验证报告](kiro-provider-responses-fidelity-2026-09-10.zh.md)。最终检查和构建身份见 [validation.json](evidence/responses-fidelity-2026-09-10/validation.json)。

重启测试在生成有效 native opaque 和签名 kr1 之后清除该 native 会话的亲和缓存，再重启隔离服务。两条链均通过真实 SDK 使用原工具结果继续，分别返回预设的正确 marker，证明恢复依据来自持久状态。

## 1. 标准请求和 SDK 回放

同一类请求在旧版首先被本地 schema 拒绝：

```json
{
  "model": "gpt-5.6-sol",
  "input": [{"role": "user", "content": "Reply exactly SDK_OK"}],
  "instructions": null,
  "previous_response_id": null,
  "temperature": null,
  "max_output_tokens": null
}
```

旧版返回 `400 invalid_request`。候选版本返回 `SDK_OK`，并通过 Retrieve/output 一致、input_items 内容块类型及重复查询 ID 稳定性检查。null 在路由前归一化；显式 false 和空字符串仍保留。

官方 SDK 的流助手还会在 output 中加入 `parsed`、`parsed_arguments` 辅助字段。旧 stateless 入口拒绝这些字段，使“把完整 output 放进 next.input”的标准使用方式中断。现在保留这些辅助元数据，以原始文本和 arguments 为生成输入，不把辅助字段当成控制参数。未知控制字段仍返回 400。

[旧版 SDK 对照](evidence/responses-fidelity-2026-09-10/sdk-baseline-final.json)保留了 nullable、历史与回放失败；[SDK 契约测试](../../__tests__/responses-openai-sdk.test.ts)直接使用官方流累积器返回的完整 message/function output。

## 2. 工具调用必须得到正确的工作结果

namespace 案例先要求调用 `catalog.lookup`，参数为 `{"sku":"p42"}`。测试程序实际检查工具身份、参数及调用数量，然后按该 call_id 返回：

```json
{"sku":"p42","price_cents":1267}
```

下一轮移除工具，并要求计算七件商品加 13% 税、四舍五入到整数分。正确结果是：

```text
1267 × 7 = 8869
round(8869 × 0.13) = 1153
总计 = 10022
```

候选版本五个模型在 JSON/SSE 下都使用工具结果算出了 **10022**，且没有再次调用已移除的工具。Sonnet 的部分结果附带了计算说明，未完全遵循“只返回整数”的文风要求；这记录为模型行为观察，没有误报成计算错误，也没有宣称获得结构化输出约束。

旧版相同 namespace 续接在移除声明后返回 `missing_tool_declaration`；显式 `custom.format:{"type":"text"}` 也被旧入口拒绝。[旧版工具对照](evidence/responses-fidelity-2026-09-10/sdk-baseline-tools.json)保留了这些结果。

custom 案例检查以下原始字符串的完整字节，并使用真实 call_id 返回随机 marker：

```text
alpha\beta
{"quote":"x"}
雪🌐
```

检查同时覆盖 previous ID 续接和完整 `output → next.input` 手动回放。反斜线、引号、换行和 Unicode 必须全部一致。

## 3. “已经 completed”仍可能无法正确续接

### Claude：previous ID 回显不代表历史恢复

第一轮要求记住随机测试 marker，只回答 ACK；第二轮只提供 previous_response_id 并询问 marker。旧版 Opus/Sonnet 没有找回 marker。工具结果轮还可能因缺少前置 tool_use 而失败。

修复后，同一逻辑请求通过完整 wire 历史继续调用 CreateResponse，恢复了 marker。后续响应保存自己的完整快照，因此删除祖先镜像后，仍可通过已经提交的后代 ID 继续；直接使用已删除 ID 则返回 `response_not_found`。

### Sol：opaque reasoning 与工具续接

扩展测试中，Sol 的一次 custom SSE 首轮完成且工具输入正确，但使用该 ID 提交工具结果得到：

```json
{"error":{"message":"Improperly formed request.","type":"invalid_request_error"}}
```

这个失败没有被成功终止事件掩盖。固定原账号后复现了问题，抓取确认工具名、call_id、参数都正确到达上游。保留原始 opaque token 和完整 wire output 的显式历史回放则成功：[精确 wire 对照](evidence/responses-fidelity-2026-09-10/exact-wire-replay-control.json)。

该形状现在使用保存的精确快照，发给 Kiro 的请求示意如下：

```json
{
  "model": "gpt-5.6-sol",
  "input": [
    {"role":"user","content":"原始工具请求"},
    {"type":"reasoning","encrypted_content":"<原值不变>","summary":[]},
    {"type":"function_call","name":"<保存的 wire 名称>","call_id":"call_A","arguments":"<原始 wrapper 字节>"},
    {"type":"function_call_output","call_id":"call_A","output":"TOOL_RESULT"}
  ]
}
```

公开接口仍使用 `custom_tool_call/custom_tool_call_output`，仍返回客户端的 previous_response_id。内部省略失效的上游 previous ID，`X-Kiro-Transport` 标为 `native-adapted`。不能通过删除 reasoning 来换取成功。

对手动传回的 native opaque token，Provider 从同租户持久记录恢复账号和模型归属。跨租户、不同模型、冲突归属或已无法恢复的记录会明确拒绝；不会把 token 发给轮询选出的另一个账号，也不会送进 `kr1_` 解码器。

固定原失败账号的三轮 JSON/SSE 共六组随后通过，其中四组实际包含 opaque reasoning。[修复前 SDK 失败](evidence/responses-fidelity-2026-09-10/sdk-before-opaque-fix.json)继续保留。

## 4. Reasoning 与 effort 的判断方法

Opus 的复杂 max 工具轮返回了真实签名 envelope。`store:false` 未传 include 时，候选版本仍返回 `kr1_`；完整 output 连同工具结果回放后，模型正确得到 10022。Zuno 的多轮工具请求也实际携带了本地 replay token。

简单 Claude 工具轮可能没有 reasoning，Sonnet 本轮也没有稳定返回可验证的签名 envelope。此时不生成假 token，不把该次普通历史回放描述为“已验证签名回放”。

GPT 不需要返回可见推理文字。Terra/Luna 可以返回不可见的原生 encrypted_content；它与本地 `kr1_` 是不同通道。验收检查显式 effort 覆盖 `-xhigh` 后缀、真实上游参数、工作答案与 usage，不以是否展示推理来判断成功。

同一计数题的正确答案为 126。本次实际观测如下：

| 模型 | 显式 low / high | low / high 的 reasoning_tokens | 两次答案 |
| --- | --- | --- | --- |
| Sol | 上游分别为 low / high | 0 / 0 | 均为 126 |
| Terra | 上游分别为 low / high | 32 / 39 | 均为 126 |
| Luna | 上游分别为 low / high | 0 / 36 | 均为 126 |

这些是协议与任务检查，不是推理质量排名，也不承诺较高 effort 在每道题上都会增加可见输出或 token 数。旧版的确定缺陷是同一个显式 low 因 `store:false` 而变回 xhigh；归一化后两条通道采用同一优先级。

## 5. 使用真实 Zuno kiro-local 配置

客户端测试读取原 profile，并在隔离的配置与状态目录中使用 `kiro-local`。原配置没有 Terra 声明，首轮因此在发请求前失败；测试副本从网关 `/v1/models` 补齐 Terra，未修改原配置。

显式 `--model` 时，首轮 Zuno 请求没有携带 preset 中的 effort。最终测试明确指定 `--variant max`，每个 Zuno 模型的抓取记录均包含 max。不能把客户端未发送的参数归因于 Provider 丢弃。

| 模型 | exit 23 后恢复并计算账本 | Plan 工具结果后尾部指令 | 请求 effort |
| --- | --- | --- | --- |
| Opus 5 | 通过 | 通过 | max |
| Sonnet 5 | 通过 | 通过 | max |
| Sol | 通过 | 通过 | max |
| Terra | 通过 | 通过 | max |
| Luna | 通过 | 通过 | max |

恢复任务先执行一次独立的 `exit 23`，再读取 ledger.json，计算已入账销售减已入账退款，排除 pending/voided。测试程序独立计算 **11302 分**，核对落盘文件和最终答复；该数值没有预先给模型。

Plan 用例读取文件，在工具结果之后由测试代理注入一条尾部 developer 指令，检查模型继续完成计划答复且未修改输入文件。Codex 另外执行真实 apply_patch，自定义工具调用及文件结果都通过。

Zuno/Codex 的许多请求仍因 store:false、max effort、additional_tools 或指令形状使用 stateless。保留这些语义优先于扩大 native 数字。

## 6. 23 条审查观察与兼容边界

原始观察保存在 [original-audit-observations.json](evidence/responses-fidelity-2026-09-10/original-audit-observations.json)。同条件复测只修正了正常流对照的完整生命周期，并将 429 探针设为零重试以单独观察退避信息；两端应用相同调整：

- [v3.0.1 对照](evidence/responses-fidelity-2026-09-10/audit-baseline-contract.json)
- [候选版本对照](evidence/responses-fidelity-2026-09-10/audit-candidate-contract.json)

| 观察组 | 旧行为 | 新行为与回归 |
| --- | --- | --- |
| 断流、坏帧、错误 Content-Type、正常对照 | 断流或坏帧可能正常 EOF | 正常完成保留；错误在发布前返回 JSON，发布后发一次 failed；SDK 能识别 |
| kr1 未带 include、stateless previous ID | 误入 native 或丢失 reasoning | 本地解析；完整逻辑 item 与私有 replay 引用恢复 |
| 原账号限流 | 可改选其他账号 | 绑定持久归属，429/503 明确返回 |
| 五种 nullable、标准 reasoning text | schema 拒绝 | 入口接受并归一化，保留 false/空字符串 |
| phase 的两条通道 | native 透传，stateless 拒绝 | 保存 phase；旧上游无法执行时报告损失，strict 拒绝 |
| 无工具的 parallel=false | 无谓 fallback，丢失可用 token 控制 | 保持 native 并回显 false |
| 有工具的 parallel=false | 接受但不保证串行，无诊断 | compatible 明示未兑现；strict 在派发前拒绝 |
| 已接受后丢弃的控制、effort 冲突 | 未知控制可消失，通道优先级不同 | 统一校验；登记兼容损失；显式 effort 优先 |
| Retry-After 缺失/15 秒 | 缺失被视为零，响应头丢失 | 使用有效回退、转交等待信息，不等待到超过总 deadline |
| input_items 便捷消息 | type/content 不规范 | message 与内容块归一化，ID 稳定 |
| 中间指令 | 提前到第一条 user | 附着到原位置之后的输入边界，不加入确认句 |

回归集中在 [responses-fidelity.test.ts](../../__tests__/responses-fidelity.test.ts)、[native-replay.test.ts](../../__tests__/native-replay.test.ts)、[native-responses-adaptation.test.ts](../../__tests__/native-responses-adaptation.test.ts) 与官方 SDK 契约测试。

仍关闭或受限的能力：

- 指令提升没有通过复杂作用域续接门禁，auto 关闭，experimental 只接受限定形状。
- Opus/Sonnet 的对抗指令探针有四次未遵守顶层指令优先级。compatible 报告不确定性，strict 拒绝该范围内的顶层指令请求。
- Grammar、strict schema、structured outputs 和原生 store:false 不因本轮普通调用成功而放行。
- 没有签名或完整 envelope 时不生成 replay token。外部或已失去持久归属的 native opaque token 不会被猜测账号后转发。
- V2 native 旧记录没有完整归属，Retrieve 可用，ID 续接明确失败；V1 stateless 只恢复实际保存的信息。回滚须使用匹配数据库备份。

首次测试中发现的探针假设错误和模型文风偏离保存在 [sdk-initial-observations.json](evidence/responses-fidelity-2026-09-10/sdk-initial-observations.json)。它们与已修复的 Provider 缺陷分开说明，没有把失败记录改写成成功。
