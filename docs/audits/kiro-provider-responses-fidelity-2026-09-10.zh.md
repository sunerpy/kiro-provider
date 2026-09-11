# Responses 原生保真改进与验证

> **日期**：2026-09-10（UTC） · **基线**：v3.0.1 / d3ce4cd
> **范围**：Provider 实现、协议契约、隔离真实验证；交付到 PR。

## 摘要

本次修复请求归一化、原生流终止、reasoning 回放、账号绑定和中间指令投影，并增加严格模式与经过证据门控的原生工具桥接。真实验证还发现，当前 us-east-1 的 Opus 5、Sonnet 5 会回显 `previous_response_id`，却没有将历史恢复给模型；Provider 现为这些模型恢复完整历史后继续调用 CreateResponse。

五个模型的 namespace function 与自由文本 custom 工具，在 JSON 和 SSE 下分别完成三次完整往返。指令提升仍未通过复杂作用域续接门禁，默认不启用。对抗指令探针的失败也保留在证据中，没有以 HTTP 200 作为指令优先级成立的依据。

最终官方 SDK 验收为 **38/38**，真实 Codex/Zuno 验收为 **12/12**，严格模式五个模型组的 **35 项断言全部通过**。请求、响应、工作结果及失败前后差异见[实测对照报告](kiro-provider-responses-before-after-2026-09-10.zh.md)。

## 目录

- [1. 行为变化](#1-行为变化)
- [2. 原生能力证据](#2-原生能力证据)
- [3. 状态与迁移](#3-状态与迁移)
- [4. 验证与复现](#4-验证与复现)

## 1. 行为变化

| 问题 | 实现后的行为 |
| --- | --- |
| 合法 nullable 参数被拒绝 | 在路由前归一化 null，保持 false 与空字符串的区别。 |
| 两条通道 effort 优先级不同 | Responses 显式 effort 优先于模型后缀，再采用配置和模型缺省。 |
| `reasoning.content` 字段错误、phase 无法保存 | 使用标准 `text` 字段，保存 assistant phase；旧传输不能表达 phase 时报告兼容损失，严格模式拒绝。 |
| Native EOF 被当成正常结束 | 发布前返回类型明确的 HTTP 错误；发布后发出一次 `response.failed`。真实 incomplete 保留原因。 |
| SSE 内容类型、JSON 和生命周期缺少检查 | 检查成功响应类型、帧解析、身份、序号和终止状态，支持分片、CRLF 和无尾部空行。 |
| `kr1_` 未带 include 时误入 native | 由输入 token 归属决定传输；Provider token 本地解析，上游 opaque token 不进入 kr1 解码器。 |
| Stateless 续接遗漏 reasoning | 保存完整逻辑 item 序列和私有 replay 引用，按原位置恢复。可用的 store=false replay token 默认返回。 |
| Native 续接改选其他账号 | 持久化账号、区域、profile 和 Response ID；所属账号不可用时明确失败。亲和缓存失效不覆盖持久归属。 |
| 中间指令提前到首个 user | 兼容投影在原有会话边界附着原始指令，不添加确认句或其他提示词。角色降级继续显式报告。 |
| 串行工具开关导致无工具请求退化 | 没有可调用工具时保持 native；存在工具但无法保证串行时，兼容模式报告损失，严格模式拒绝。 |
| 429 冷却和响应头不正确 | 区分缺失、零、秒数和 HTTP 日期，保留 Retry-After，重试有界。 |
| input-items 返回便捷输入原形 | 统一为 message/content-block 结构，保持稳定 ID 和现有分页范围。 |
| 持久化失败后仍返回完成 | 先提交必要的续接状态，再发布完成结果；失败不伪装成可存储成功。 |

配置默认值：

```json
{
  "responses_fidelity_mode": "compatible",
  "responses_instruction_lift": "auto",
  "responses_native_tool_bridge": "auto"
}
```

`responses_fidelity_mode` 可以改为 `strict`。两个增强开关支持 `auto`、`off`、`experimental`；experimental 不绕过存储、账号和 reasoning 约束。

响应头 `X-Kiro-Transport` 区分 native、native-adapted、stateless。`X-Kiro-Compatibility` 列出本次已发生或尚未证实可兑现的语义，例如指令角色投影、未保证串行、verbosity/context 未执行，以及已观察到的原生指令优先级不确定性。该头不包含提示词或凭据。

严格模式保证 Provider 不接受已登记的语义损失；它不是对模型任意自然语言行为的保证。

## 2. 原生能力证据

### 工具桥接

以下模型在 us-east-1 的两个工具能力均通过 JSON 三次、SSE 三次验证：

| 模型 | Namespace function | 自由文本 custom |
| --- | --- | --- |
| Claude Opus 5 | 通过，auto 启用 | 通过，auto 启用 |
| Claude Sonnet 5 | 通过，auto 启用 | 通过，auto 启用 |
| GPT-5.6 Sol | 通过，auto 启用 | 通过，auto 启用 |
| GPT-5.6 Terra | 通过，auto 启用 | 通过，auto 启用 |
| GPT-5.6 Luna | 通过，auto 启用 | 通过，auto 启用 |

验证覆盖公开工具身份、参数或原始字符串字节、结果回传、声明重排、工具移除、后续上下文，以及响应中没有私有别名。共 60 个工具能力案例通过。

映射使用稳定身份并随会话保存。Wire 描述保留客户端提供的公开工具名称，原始参数 schema 不因名为 `encrypted` 的属性而被删改。关闭开关后，已有会话仍使用保存的映射续接。

未验证的模型或区域继续使用兼容路径。Grammar custom、strict schema、structured outputs 不在这次自动放行范围内。

### Claude previous_response_id

原生字段基线使用随机 marker：第一轮只回答 ACK，第二轮仅通过 previous ID 询问 marker。Opus 5、Sonnet 5 没有找回 marker，尽管返回体回显了 previous ID；Sol/Terra/Luna 找回了 marker。

Claude 的工具结果续接同时出现上游错误：tool_result 没有对应的前置 tool_use。将完整输入及工具调用历史显式发送给 CreateResponse 后，调用成功。

因此，仅在已记录的受影响模型/区域，Provider 恢复 wire 历史并省略上游 previous ID；对外仍提供标准的 previous ID 续接语义，响应头标为 native-adapted。新的完整快照使后续会话不依赖祖先镜像仍然存在。GPT 保留经过验证的上游续接。

扩展 SDK 验收还复现了 Sol 在含原生 opaque reasoning 的工具续接上返回 400。固定同一账号后，保留 opaque 原值的完整 wire 回放成功。因此，该模型/区域的这一形状也使用完整快照。适配过的工具输出另外保存原始 wire 字节，避免重新编码 custom JSON wrapper。手动传回 opaque token 时，从同租户的持久记录恢复账号和模型归属；缺失、冲突或不匹配的归属明确拒绝。

### 指令边界

15 个顶层指令对抗探针中，GPT 三个模型各通过三次，Opus 通过两次、Sonnet 未通过。其余四次模型按冲突的 user 输入回答；这些结果保留为失败，不宣称上游一定丢弃了字段，也不宣称其优先级已经得到可靠验证。

在该范围内，compatible 继续原样转发并报告 `native_instruction_priority_unverified`；strict 在生成前拒绝。单条指令提升的有限场景完成了六次验证，但它仍不能等价处理之后新增顶层指令、混合角色等复杂作用域，因此 auto 保持关闭。

## 3. 状态与迁移

- 新记录使用私有 V3 续接 envelope，读取器兼容 V1/V2，不批量改写旧记录。
- Native 保存原始公开输入、响应、账号归属和适配映射。需要本地补齐的 native 会话额外保存精确 wire 快照。
- Stateless 保存完整逻辑输入与输出；私有 replay 附件不会因为未向客户端公开而丢失。
- 旧记录只有在已有信息足够时恢复。未知版本、缺失祖先、循环引用或缺失精确加密历史会明确拒绝续接，不补造数据；未知版本不会被自动当作损坏数据删除。
- V1 stateless 记录中的已知 canonical 历史会随新响应保存在 V3 中；缺少 reasoning 原始位置时拒绝回放。V2 native 记录没有保存完整账号/区域/profile 归属，仍可 Retrieve，但通过该 ID 续接会返回 `response_context_unavailable`。亲和缓存不能补造这些字段。
- 部分生成的输出可以保存和读取，但未完成的工具参数不能被当作完整调用重放。
- 保留现有 Response 30 天、最多 10,000 条，以及可配置的 reasoning replay 保留策略。过期的必需 token 不会被静默忽略。
- `store:false` 继续采用 stateless，不写本地 Response 镜像；本次没有放行未经验证的原生 store=false。
- DELETE 仍仅删除网关镜像。它不宣称已经物理删除 Kiro 服务端状态。

旧二进制不承诺能够读取新的续接记录。将来部署后的回滚必须使用匹配的数据库备份；本批没有替换生产服务。

## 4. 验证与复现

离线测试将审查观察变为回归用例，并使用锁定的官方 TypeScript SDK `openai@7.13.0` 检查完整输出回放和流失败识别。仓库原有格式、类型、安全、覆盖率和构建门禁继续执行，阈值不变。

证据位于 `evidence/responses-fidelity-2026-09-10/`：

- `full-matrix-experimental.json`：51 个 JSON 案例，47 个通过；四个指令优先级失败完整保留。
- `full-matrix-stream.json`：30 个 SSE 工具案例全部通过。
- `native-previous-field-baseline.json`：原生 previous ID 随机 marker 基线。
- `sdk-acceptance.json`：38 个 SDK 案例，包含完整 output 回放、工具工作结果与 effort。
- `clients-acceptance.json`：真实 Codex/Zuno 的 12 个工具、计算、恢复和 Plan 案例。
- `sdk-strict.json`：五个模型分别通过一项可支持请求和六项精确拒绝检查。
- `audit-baseline-contract.json` / `audit-candidate-contract.json`：23 条审查观察的同条件对照。

真实客户端验证使用 Codex CLI 0.153.4、Zuno 0.10.29、独立配置/状态目录、账号库与密钥材料副本、新 API key 和 loopback 端口。Zuno 使用原 `kiro-local` profile，隔离配置只替换 endpoint，并从网关目录补齐原配置未声明的 Terra。显式选择模型时另外传入 `--variant max`，抓取的请求确认 effort 为 max。Zuno Plan 用例在工具结果之后注入一条明确标记的尾部 developer 指令，验证边界处理。

运行前准备好隔离的 Provider 配置、SQLite 一致性备份及 replay key 副本，关闭副本的后台维护。不要指向当前生产服务。

```bash
bun run scripts/probe-responses-fidelity.ts --confirm \
  --config /absolute/isolated/config.json --n 3 \
  --out /absolute/evidence/responses-json.json

bun run scripts/probe-responses-fidelity.ts --confirm \
  --config /absolute/isolated/config.json --stream --n 3 \
  --features namespace_functions,custom_freeform \
  --out /absolute/evidence/responses-sse.json

python3 scripts/probe-responses-clients.py --confirm \
  --config /absolute/isolated/config.json \
  --work-dir /absolute/isolated/client-runs \
  --codex-state-root /absolute/private/codex-state \
  --codex-bin /absolute/codex --zuno-bin /absolute/zuno \
  --zuno-profile-dir /absolute/zuno/profiles/kiro \
  --zuno-models claude-opus-5,claude-sonnet-5,gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna \
  --zuno-variant max \
  --out /absolute/evidence/clients.json

bun run scripts/probe-responses-sdk.ts --confirm \
  --config /absolute/isolated/config.json \
  --out /absolute/evidence/sdk.json
```

客户端脚本保留私有 stdout/stderr 与脱敏请求形状，结果报告使用文件 hash、退出码、工具结果及文件 marker 验证，不能以进程退出 0 代替工具实际执行。发布证据时排除账号库、密钥、配置和完整客户端上下文。
