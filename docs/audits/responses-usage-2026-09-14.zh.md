# Responses 用量与上下文修复验收（2026-09-14）

## 结论与范围

基线为已发布的 `v3.1.3 / a703d3c`。本次修复 Responses 的用量语义、JSON/SSE/Retrieve
一致性，以及客户端压缩所依赖的当前上下文统计。未修改 Codex、Zuno 源码、生产账号、
replay 密钥或模型窗口/思考等级默认值。

已验证的效果：工具调用不再因为没有可见文字而被统计成零输出；缓存、推理不与其所属
总量重复相加；GPT 旧百分比分母不再混用公开窗口；百分比封顶后仍能统计较长输入；
Codex 的真实自动压缩与 Zuno 的当前上下文、累计用量保持区分。

当前 Kiro Generate 实测没有提供精确 input/output/cache/reasoning token 计数。
默认兼容模式返回标明来源的估算，严格模式省略不完整的 usage。这是有边界的兼容，
不宣称恢复了上游没有公开的测量数据或账单。

[脱敏验收记录](evidence/responses-usage-2026-09-14/validation.json)包含具体响应 ID、usage、
SDK 版本和验收二进制 SHA256；[字段契约](../readme/RESPONSES_USAGE.zh-CN.md)说明客户端用法。

## 修复前后对照

| 问题 | v3.1.3 行为 | 修复后的行为与证据 |
| --- | --- | --- |
| 百分比分母混用 | GPT 百分比直接乘公开的 872K | 使用对应账号模型的原始分母 272K；目录仍保留公开预算 |
| 百分比封顶 | 300K 和 790K 都报 100%，无法反映真实长度差异 | 100% 仅作下界，按实际投影内容进行 BPE 估算 |
| 工具输出漏计 | 只统计回复文字，纯 tool call 可以是 0 | 工具名称、参数、可取得的 reasoning 也参与输出估算 |
| 未知值补零 | 缓存和 reasoning 明细被当成 0 | 未知字段省略，并在 metadata 中登记；明确零值保留 |
| 缓存归属 | 真实缓存分项在公共 usage 中丢失 | input 包含缓存，cache read/write 是其子项，保留原始明细 |
| 推理归属 | 可见文字与隐藏推理缺少一致的归属 | output 包含 reasoning；未知推理数不会从“没有推理文字”推导为 0 |
| 部分快照 | 后续快照缺项可能继承前一个快照的旧值 | 每次 metadata 快照替换计数，避免跨快照拼造完整值 |
| 无效上游统计 | 矛盾值可能被夹紧、补零后成功返回 | `invalid_upstream_usage`，已发布流失败恰好一次，不重试生成 |
| 状态接口漂移 | 多处分别组装统计、可能丢失来源 | 统一映射，JSON/SSE/Retrieve 保持同一 usage 与来源 |
| Codex 重复估算 | 客户端可能再次估算已回放的历史 reasoning | stateless 返回 `X-Reasoning-Included`；native 保留上游标志 |
| 初始/失败状态 | 可能用零值或上一个进度快照伪装终止统计 | 未知时不发布 usage；网关生成的失败不复用旧快照 |

### 一次响应的标准计数示例

回归夹具提供真实计数：普通输入 400、缓存读取 400、缓存写入 200、输出 120，
其中推理 90。预期 JSON/SSE/Retrieve 一致：

```json
{
  "input_tokens": 1000,
  "input_tokens_details": { "cached_tokens": 400, "cache_write_tokens": 200 },
  "output_tokens": 120,
  "output_tokens_details": { "reasoning_tokens": 90 },
  "total_tokens": 1120
}
```

不会把缓存或推理再次加到 1120 上。该完整对象通过锁定官方 OpenAPI `ResponseUsage`
结构验证。兼容估算的示例与来源字段另见字段契约；它不会冒充上述完整测量对象。

### 为什么之前出现 43,972,581 token

原 pt-tools 会话的 97 个独立响应累计为 input 43,966,940、output 5,641；没有重复响应
ID 被重复相加。这里是多次请求累计，并非一次装入 4,397 万 token。

但旧算法存在实质偏差：上述百分比分母错误会放大输入估算；75 个响应的输出为零，
工具参数输出被漏计。因此旧累计不能被当作精确实耗或费用依据。本次不修改历史
rollout、存量响应或客户端已累计的数值；新响应开始采用修复后的契约。

## 协议与独立 SDK 验证

参照官方 OpenAPI 固定修订 `4bb21ba8e9213c3d955b69dc3f76dd7537439828`，使用
`openai@7.13.0`、`@ai-sdk/openai@4.0.66`、`ai@7.0.99`。依赖版本已锁定。

离线契约覆盖明确零值、缺失字段、部分真实计数、缓存写入、reasoning、非法计数、
JSON/SSE、流失败、存储重建、压缩前后上下文、图片与 Unicode、原始模型分母。

真实 OpenAI SDK 验证 JSON 和 SSE 两条路径：

1. Sol `max` 调用 namespace `check.echo`，公开工具身份正确，参数正确。
2. 工具结果经 `previous_response_id` 续接；当前工具声明移除后仍可使用历史结果。
3. 最终回复为 `SDK_USAGE_OK`，Create 与 Retrieve 的 usage 完全一致。
4. 工具响应和最终文字响应均有正数输出估算；未知 reasoning/cache 明细保持缺失。

真实 AI SDK JSON、流式各执行一个 echo 工具循环，均为两步：

- 最后一步上下文为 **1,670**。
- 两步累计为 **3,316**。
- `result.finalStep.usage` 是最后一步；AI SDK 7 的 `result.usage` 是累计。
- 每步 `usage.raw.metadata.kiro` 保留估算来源；累计对象不会保留各步 raw metadata。

真实 Codex 联调发现并修复了一个仅靠 OpenAI SDK 不易发现的问题：
`input_tokens_details: {}` 会被 Codex 拒绝，报 `missing field cached_tokens`。
现在未知时省略整个 detail 对象，不补造零；其独立解码约束已纳入回归测试。
同理处理 `output_tokens_details.reasoning_tokens`。

## 真实上下文与压缩

使用安装的 Codex 0.154.0 / `9ba1d9eb5b` 和 `kirocodex`，独立临时任务、合成输入，
每个场景仅执行一次 printf。测试显式选择 low 以控制验证成本，不改变日常 Ultra 默认。
保留 1M 配置及模型目录安全预算，自动压缩阈值仍为 784,800。

| 场景 | 实际 response.total_tokens | 压缩行为 | 工作结果 |
| --- | --- | --- | --- |
| 300K padding，第一步 | 337,719 | 不压缩 | 单次 printf 成功 |
| 300K padding，工具结果后 | 423,759 | 不压缩 | 正确返回标记 |
| 790K padding，第一步 | 829,595 | 随后自动压缩一次 | 单次 printf 成功 |
| 790K 的压缩请求 | 808,702 | 正常完成压缩 | 保留任务与工具结果 |
| 压缩后下一步 | 199,257 | 没有反复压缩 | 正确返回标记 |

这些是 Provider 明确标注的上下文估算，不是上游精确计费用量。
Codex 的后续请求还会加入工具信息，不能只用最初的用户 padding 推算每一轮大小。

最初 790K 测试使用 158 万字符的低密度文本，被 Codex 单条输入 1,048,576 字符限制
拦截，尚未请求 Provider。改用同等 BPE token 数的较短合成文本后完成上述验收。
没有提高字符限制、压缩阈值或模型预算来使测试通过。

另以真实 Kiro Generate 验证 300K、790K 的独立随机首尾标记均被保留，排除百分比
100% 实际意味着截断到 272K 的解释。此次没有将这些结果推广为其他模型的极限容量。

## Zuno 验收

使用已安装 Zuno 0.10.39，保留
`ZUNO_CONFIG_DIR=/config/.config/zuno/profiles/kiro`，在隔离 XDG 目录和数据库中覆写
Provider 地址至测试端口。模型为 `kiro-local/gpt-5.6-sol`，思考等级 max。

- 第一轮实际调用一次 shell，取得 `ZUNO_USAGE_REPLAY_OK`，再正确返回该标记。
- 第二轮冷启动 CLI、恢复同一测试会话，只从历史回答标记，没有再次调用工具。
- 两轮最后上下文分别为 **19,109**、**18,992**。
- 第二轮累计输入 **56,033**、输出 **982**，合计 **57,015**，没有当作当前上下文。
- Zuno `context_usage.usedTokens` 与对应 Provider 最终 usage 相等；缓存与推理明细
  在逐请求事件中为 null，没有重复计入。

第一次英文提示的工具确实完成、下一轮也正确回忆，但第一轮最终文字没有按要求只
返回标记。该结果作为行为偏差保留；改用明确中文验收指令后的两轮检查通过。本补丁
不把一次格式偏差归因于 usage，也不声称可以保证模型始终遵循输出格式。

Zuno 会把已收到的 Provider 数值标为 `confirmed`，目前没有消费本 Provider 的来源
metadata；这表示已接收响应，不证明计数来自上游精确测量。无需修改 Zuno 才能使用本次
修复；若 UI 需要显示“估算”，仍需客户端读取来源扩展。未在本批修改 Zuno。

## 模型、严格模式与能力边界

Sol、Terra、Luna、Opus 5、Sonnet 5 的小请求均完成，usage 加法关系、正数输入/输出及
未知明细检查通过。GPT 三模型没有返回可见 reasoning，不能因此认定 effort 无效；
请求 effort 的选择、replay 机制与现有实现保持一致。

严格模式另起隔离服务验证 Sol max 的 JSON、SSE、Retrieve，均完成且省略未知 usage。
当前依赖 usage 自动压缩的 Codex/Zuno 应保留默认 compatible；strict 的未知值不应
被解释成零上下文。

被测账号的原生 `/v1/responses` 返回 `403 access_denied`；因此原生完整 usage 的字段
保留与失败处理由契约夹具验证，未宣称该账号已经通过真实 native 用量测量。

原始 Generate 事件也在 SDK 反序列化之前检查：本次 legacy/modern 通道没有被 SDK
悄悄丢弃的 input/output 计数；存在的 context percentage 和 credits 单独记录。
不做在线额外探针，也不根据一款模型的一次成功扩大其他模型的能力名单。

## 运维与回滚

最终本地门禁通过：1,757 项测试、7,437 次断言，行覆盖率 94.07%（要求 93%）；
typecheck、lint、格式、脚本语法、覆盖率配置一致性、安全/取消测试、二进制和 npm
构建均通过。冻结源码重新构建验收二进制，SHA256 与真实联调使用的文件一致。

无存储版本升级、账号迁移或 replay 密钥变更。新响应保存完整 usage 来源，老快照保持
原样。关闭兼容估算可使用现有 `responses_fidelity_mode=strict`，但须接受上述客户端
上下文观测限制；不新增第四组配置开关。

本地替换前保存二进制和数据库一致性备份，核验配置/密钥未变、进程实际执行文件 SHA、
`/ready` 与真实 SDK 工具循环。回滚使用配套的旧二进制和备份；公共发布与本地构建的
状态在交付记录中分别说明。
