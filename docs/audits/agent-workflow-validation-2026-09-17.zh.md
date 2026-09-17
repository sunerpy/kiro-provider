# 并发 Agent 工作流修复与验收

## 范围与状态

调查基线为 `v3.5.3`（`ac3260c57d280f37c3e0c4632b3fb977a4949efb`）。
使用 Claude Code 2.1.270、Codex 0.154.0 和合成开发任务验证。
本文不记录凭据、原始会话 ID、真实项目提示词、工具参数或数据库副本。

本地完整预检通过：2212 个测试、0 失败，行覆盖率
95.04%（24768/26061）。UTC 2026-09-17 16:40 已将候选切换到本地服务，
运行中可执行文件 SHA-256 为
`40dc93cf3493bffe29866b4523444d6aba192c67e16afae469a80fd22b7a2ed2`，
health／ready 均为 200。正式发布仍需独立验收。

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

同一服务进程内，每账号推理并发仍为 1。没有取消所有锁，没有放宽 native continuation 的
owner／region／profile，也没有把历史工具声明当作本轮工具授权。

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

切换后 UTC 16:57:18–16:59:02 的实际服务入口验收，四个客户端均正常退出，
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
