# 并发 Agent 工作流修复与验收

## 范围与状态

调查基线为 `v3.5.3`（`ac3260c57d280f37c3e0c4632b3fb977a4949efb`）。
使用 Claude Code 2.1.270、Codex 0.154.0 和合成开发任务验证。
本文不记录凭据、原始会话 ID、真实项目提示词、工具参数或数据库副本。

最新完整预检通过：2233 个测试、0 失败，行覆盖率
95.07%（24913/26204）。默认十路的新候选 SHA-256 为
`4e03c423feb5860f20cd04df40295d3cd5213a1b819e523d6e107c2d1624857d`，
已完成单账号混合与十子任务隔离验收，并于 UTC 2026-09-17
18:22:51–18:23:03 备份后切换到本地服务。运行中字节、默认十槽及
health／ready 200 均已核对。正式发布仍需独立验收。

## 已修复的行为

| 问题                                  | 修复与约束                                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Claude 主会话和子 Agent 共享队列      | 将有界 `x-claude-code-agent-id` 与租户、协议、family session 一起组成分支键；同一真实分支仍保序                      |
| 多个请求预先选中同一繁忙账号          | 共享容量准入先选空闲合格账号并同步预留；满载时等待任一合格账号释放，不能使用该账号的旧等待者不阻塞其他资格组         |
| 中途指令被搬到历史开头                | 保留原回合位置；支持的 leading system 继续用原生通道，其余明确采用兼容投影；新会话不合成确认                         |
| 已完成 Responses 流重复 close         | 区分流自身关闭和内部 cancel 回调；保持正常完成归因及恰好一次清理                                                     |
| Fable 历史前缀在升级或续轮时变化      | 加密回放记录认证投影版本及旧前缀边界；只保留已签名的历史表示，新指令不前移                                           |
| Claude 临时提醒从下一轮历史消失       | Kiro launcher 用客户端自身开关停用临时 batching／secondary reminders；不在服务端猜测或删改用户指令                   |
| Fable 被默认请求多段签名摘要          | 未请求摘要时使用原生 omitted 显示并保留原生签名；显式 summarized 仍保留，多签名冲突继续拒绝                          |
| Claude Bash 改写历史后 kr2 指纹不匹配 | 客户端显式声明工作目录哈希；加密记录认证该上下文，只归一指向精确当前目录的字面量冗余 cd 前缀，其他参数和身份继续绑定 |
| Claude 网关模型仅采用 200K 窗口       | 已声明的 1M 默认模型使用 `[1m]`，CLI 发请求前剥离后缀；显式设置 1M auto-compact window，仍受各模型窗口约束           |

新增 `account_inference_concurrency`，默认 **10**，可配置为 **1–10**；
环境变量为 `KIRO_PROVIDER_ACCOUNT_INFERENCE_CONCURRENCY`。原先固定为 1
是保守的本地策略，不是 Kiro 上游硬限制。容量限制作用于账号，
不把一个 Claude 进程或主会话家族整体串行。

账号容量与分支顺序是两种约束：多个独立分支可以共享一个账号的多个容量槽；
同一有状态分支仍需保序。native continuation 的 owner／region／profile
绑定也不意味着整个账号只能串行。新候选保留这些身份边界与本轮工具授权。
native 与 stateless Responses 共用显式分支锁；缺少显式键的 native 续接
按租户隔离的 previous response／reasoning origin 保序。

UTC 2026-09-17 17:30–17:32 的有界单账号直接 SDK 探测固定同一凭据，
每个请求使用独立 conversation，按 1／3／5 路逐级执行，共 27 个短请求。
SDK 无重试；全部 HTTP 200、均有完成计量，无限流异常，无其他请求的标记串入。

| 模型      | 1 路内容核验 | 3 路内容核验 | 5 路内容核验 | 5 路批次的回复流重叠峰值 |
| --------- | ------------ | ------------ | ------------ | ------------------------ |
| Opus 5    | 1/1          | 3/3          | 5/5          | 5                        |
| Fable 5.1 | 1/1          | 3/3          | 5/5          | 4                        |
| Sol       | 1/1          | 3/3          | 4/5          | 5                        |

Sol 的一个 5 路回复未匹配严格字符串断言，不能将该批次记为完整通过；
没有保存原始输出，未进一步归因。该探测证明所测账号和模型可以接受多路独立请求，
不证明长期负载上限、所有账号套餐或同一有状态 conversation 内并发安全。
之后 UTC 17:46:08–17:47:39 的 1／10 路对照共 33 个请求：
Sol、Opus 均为 10/10 正确，回复流重叠峰值均为 10；Fable 为 9/10，
一条 `MODEL_TEMPORARILY_UNAVAILABLE`，未见限流或串线。UTC
17:49:01–17:49:20 对同一账号的 Fable 再做 1／10 路对照，11/11 正确，
十路回复流峰值为 10。保留第一轮失败，不把成功样本外推为长期服务保证。

## 账号、缓存与推理回放

UTC 2026-09-17 12:09 的只读核验得到 42 个账号，39 个按仓库策略可选，
39 个令牌具备至少一分钟余量。39 次控制面目录查询均成功，均提供
Opus 5、Sonnet 5、Fable 5.1、Sol、Terra。后续只读核验确认这 39 个账号属于
同一 profile。每次请求仍须按模型、当前健康／额度、区域和 replay owner
重新筛选，不能把这个快照当作永久可调度数。

真实 A→B／新 conversation 对照覆盖 Opus、Sonnet、Fable 的同 profile
签名推理：工具结果、后续历史回忆及原签名字节保持，篡改签名被拒绝。
Fable 新增迁移范围限于认证 mint profile 完全相同的 Messages／KiroRuntime／
`reasoning_text`。未验证的模型、区域、redacted replay 或缺少 mint provenance 的
旧记录不会因此开放。

Sol 两条 runtime 的操作性回放通过，但被改坏的上游签名也被接受，不能据此
宣称上游执行了密码学校验或使用了全部隐藏推理。缓存 token 统计未提供；
同账号与跨账号的 metering 差异仅支持缓存可能按账号隔离的推断，不宣称共享缓存。

## 客户端与上下文

实际 CLI 对假端点的检查覆盖模型 ID、有效窗口、完整大输入及自动压缩事件；
这些检查不调用真实模型。可重复执行：

```bash
bun scripts/probe-client-context.mjs --claude-bin /path/to/claude
bun scripts/probe-client-context.mjs --claude-bin /path/to/claude \
  --thresholds --cases 1m-old-threshold,1m-above
bun scripts/probe-client-context.mjs --claude-bin /path/to/claude --tool-loop
```

六个 1M 默认项采用 1M 窗口，Haiku 保留 200K。`[1m]` 不进入 wire model ID。
200K 模型的默认硬阈值约为 `200000 - 20000 - 13000 = 167000`；预计算和
回合边界会影响实际触发点。明确配置 1M 后，旧 167K 点不再触发压缩，
合成大历史在约 966–967K 出现压缩。不能把一个算式当作所有模式的唯一触发点。

实际 Codex 读取在线目录后报告 950000 有效 tokens，来自声明 1M 的 95%
effective budget。静态回退目录的 Sol 是更保守的 872K，不与在线快照混写。
真实 Sol 的约 900K 本地 `o200k_base` 输入在 CodeWhisperer 通道成功，头、中、
尾三个标记均正确，上游 context usage 为 90.1635%；旧 872K 不能作为当前实测上限。

真实压缩恢复用较低测试触发值控制成本：Fable 和 Opus 分别完成压缩后随机标识及
计算结果恢复，Codex 完成三轮和一次压缩恢复。模型有效窗口仍为 1M／950K。
这些结果与假端点的近 1M 触发检查分别记录。

完整 1M 上游边界尚未证明。Opus／Fable 的部分超大输入返回
`MODEL_TEMPORARILY_UNAVAILABLE`，也有未通过标记正确性检查的样本。
不通过关闭压缩、低报 usage 或强行重放已接受流掩盖这些限制。

## 回归和观测

- 39 个并发无硬绑定请求在合成 SDK 下使用 39 个账号，单账号峰值保持 1。
- 实际开发矩阵包含两 kirocodex、两 kiroclaude，以及 Claude 主任务的两个
  子任务；验证生成的 TypeScript 代码、不可修改的断言、账号分布和终态。
- 真实 Claude 工具运行中接收改优先级指令，最终执行新指令，没有返回旧答案。
- 两种实际客户端在上游出帧后取消：清理各 1 次，没有重放，约 13–14ms 清理，
  同一账号随后约 7ms 进入新请求派发。
- `request_queue_wait` 分别记录 session、capacity、account；另记录选择、准备、
  上游响应头和首帧时长。这些量不被统称为纯排队或纯模型推理时间。

主要回归位于 `account-capacity*.test.ts`、`messages-branch-affinity.test.ts`、
`instruction-turn-boundaries.test.ts`、`responses-pipeline-terminal.test.ts`、
`fable-thinking-defaults.test.ts`、`fable-replay-capacity.test.ts`、
`claude-bash-replay.test.ts` 和 `replay-projection-persistence.test.ts`。
每项缺陷都有可执行反例；原有拒绝、授权和隔离断言继续保留。

新增 `account-concurrency.test.ts` 覆盖默认十路、1／3／5／10 配置、
满载后的下一请求、跨协议共享、同分支保序、跨租户、native owner、
取消／超时／异常及配置优先级。终态通知立即执行，账号和分支租约等
SDK 清理 promise 后释放；不能为了保住快速取消而提前开放容量槽。
旧的 finalize-before-iterator-return 断言继续通过。

默认十路候选的单账号混合验收已完成：两个 Codex、Opus、Fable 和两个
子 Agent 均正常完成开发任务，原测试文件未改动。25 个推理 HTTP 请求、
22 次 SDK dispatch，单账号峰值 4、子任务峰值 2；capacity P95 4ms，
session／account P95 0ms，0 签名错误、0 清理警告、0 活动残留。
Fable 经两次上游暂不可用后恢复，完整任务约 284 秒，不能把该耗时归为本地排队。
UTC 18:12:31–18:16:28 的同一 Claude 主进程十子任务验收通过：
57 HTTP／46 SDK dispatch，只有一个账号，账号峰值和子任务峰值均为 10；
十份模块及 aggregate 集成测试通过，0 客户端错误、0 上游失败码、
0 清理警告、0 残留。刻意只提供一个账号时，capacity P50/P95 为
4/2608ms；session／account P95 0ms。

UTC 18:25:56–18:34:33 的实际服务矩阵包含两 Codex、Opus 和 Fable 十子任务，
四个客户端最终均完成代码及 final marker。86 dispatch 使用 12 个账号，
峰值 12、子任务峰值 10，capacity P95 5ms，0 签名／清理错误及残留。
这次出现上游 `MODEL_TEMPORARILY_UNAVAILABLE`／`serviceUnavailableError`：
严格无客户端 error 的计数为 3/4，一个 Codex 在约 272 秒的上游失败后恢复。
后续单独 Codex 复验也出现一次此类上游错误并恢复，不能称为零错误通过。
这些请求没有本地长队列，也没有重放已接受流；上游可用性仍是实际限制。

新增中英文独立启动器文档的三个安装代码块已原样执行验证：
实际 Claude／Codex 连接假端点，分别使用 Messages／Responses；
Claude 窗口 1M，Codex 未显式覆盖窗口仍从在线目录得到 950K 有效预算。
命令鉴权通过，预置的原生 Claude／Codex 配置文件保持不变，未调用真实模型。
本机原有 wrapper 仍共享原生状态目录；文档示例提供独立 home，二者没有混写。

上一候选（40dc93cf）UTC 16:57:18–16:59:02 的实际服务入口验收，四个客户端均正常退出，
生成代码全部通过断言；24 个推理 HTTP 请求中有 21 次 SDK dispatch，均正常完成，
涉及 4 个账号、峰值 4，包含两个子 Agent。session／account 等待 P95 为 0ms，
capacity P95 为 4ms，0 签名／指纹错误、0 清理警告、0 活动尝试残留。
请求数与 dispatch 数的差异来自客户端的认证和能力协商，不是已接受流重放。

UTC 16:40:53–17:00:00 的自然流量窗口共有 51 次 dispatch、5 个账号、峰值 5；
capacity P50/P95 为 4/6ms，session／account 均为 0ms，0 签名失败或清理警告。
窗口结束时仍有一个活动请求，这不是泄漏指标。该窗口与早先日志的负载不同，
不据此声称严格的性能 A/B 倍数。

启动器参数只在新进程启动时生效；已有 kiroclaude 进程需重新启动才能采用
新的窗口与客户端兼容设置。无法验证的旧历史改写仍会被拒绝，不自动丢弃签名。

## CLIProxyAPI 对照边界

对照固定在主线 `8c664b2fede5c83b919be1df9b01057ec4e4c950`、
Plus `e197b6c0bfd699a54c3ee985c7fcbc6f5ecd8ee0`。这些被检查的路径没有相同的
family-session 整流串行组合，但亲和性仍可能复用同一账号；Plus 的可选 limiter
也不等同于严格的单账号 in-flight=1。不能仅凭 round-robin 宣称充分利用了账号池。

代理端保留 1M beta 也不会自动改变 Claude Code 在发请求前采用的窗口。
原生 Claude 通道、Plus Kiro 通道和本仓库的持久 replay 契约不能混为同一实现。
