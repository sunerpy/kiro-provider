# Fable 回放、旧工具历史与请求资源准入验收

日期：2026-09-20 UTC。基线：`e7ac0bd` / 3.5.5。以下为修复候选验证，不是 Release 发布证明。

## 修复范围

- Messages 历史调用不再要求本轮仍声明原工具；当前 tools/schema 仍独立授权新输出。
- Fable 启用 thinking、effective omitted 的冲突空签名前缀，有界整组省略后继续原请求；不捕获 reasoning、不铸造 token、不重试。
- 全局请求数/请求体预算覆盖上传、解析、账号等待、生成和清理；超额请求在 dispatch 前返回 503。
- 真实客户端断开后，Bun 不消费的 499 错误响应由 Provider 先读取并解除对旧请求的引用，仍给直接调用者保留可读错误信封，避免预算永久占用。

## 回归结果

历史工具场景先得到 5 pass / 8 fail，修复后 13 pass，相关组 81 pass。
Fable 冲突组先得到 7 pass / 19 fail，修复后 26 pass；随后补充前缀超时、
取消、字节/事件边界、当前工具授权、并发隔离及错误传播。

首轮完整 gate 发现并修复：499 响应体过早取消、完成见证后的内嵌错误被错误
抑制、数值配置测试表缺项。随后完整 gate 为 2352 pass / 0 fail，覆盖率
25499/26727（95.41%）。再经真实压力探针发现 499 无消费者时的预算占用问题，
保留真实 loopback 先红后绿回归；对应四文件组 38 pass。

包含该断连修复的最终本地 `make pre-ci`：2353 pass / 0 fail，
25511/26739 行（95.41%）。构建、类型、lint、文档链接、脚本安全检查和 coverage parity
均通过。

没有降低覆盖率门槛、增加排除项或削弱原回归断言。最后一次全量 gate 及发布链
以本修复 PR/Release 的 exact-head 记录为准。

## 实际 Claude 客户端

隔离假端点、空用户配置、无 MCP、不持久化 session：

| 版本 | 工具数 | TaskOutput 声明 | 正常退出 |
| --- | ---: | --- | --- |
| 2.1.275 | 21 | 有 | 是 |
| 2.1.278 | 20 | 无 | 是 |

证据：[客户端目录](evidence/fable-recovery-2026-09-20/client-tool-catalog.json)。
可执行 harness：`scripts/probe-claude-tool-catalog.py --claude PATH --claude PATH`。

## 真实 Kiro 签名与工具往返

两个隔离端口、两个不同账号、同一个 us-east-1 profile；独立状态和 synthetic tenant/keyring。
每份初始账号数据库约 120 KiB；生产数据库、配置、服务未用于测试写入。

三组试验（stream / non-stream / stream）均得到：

| 对照 | 结果 |
| --- | --- |
| 首轮生成 TaskOutput 工具调用与 kr2 token | 3/3 成功 |
| 同账号、稳定工具前缀续接 | 3/3 成功，结果正确 |
| 换账号、新 conversation、同 profile 续接 | 3/3 成功，结果正确 |
| 迁移后再续一轮 | 3/3 成功，结果正确 |
| 修改原生签名后重新加密成测试 token | 3/3 被 Kiro 以签名错误拒绝 |
| 撤下 TaskOutput，但保留旧签名 | 3/3 被 Kiro 以签名错误拒绝 |
| 撤下 TaskOutput，显式仅回传可见历史 | 3/3 成功，结果正确 |

证据：[真实签名对照](evidence/fable-recovery-2026-09-20/live-signed-replay.json)。
可执行 harness：`scripts/probe-fable-recovery.ts`，要求两个已经运行的隔离网关。
反例只篡改 synthetic fixture 的签名，不涉及生产会话，也不修改 Provider 正常回放策略。

这证明有效签名在已验证单元可迁移，不能外推任意工具前缀变化。旧会话的本地
`missing_tool_declaration` 已解决；若 Kiro 仍拒绝旧签名前缀，应保留原上下文，
或显式交接可见状态到新会话。Provider 不会猜签名、恢复已撤销工具权限或自动删正常 reasoning。

本次真实生成未自然出现多签名冲突；其精确危险时序由完整 Messages→pipeline→SDK
fixture 覆盖，不能把正常上游请求成功写成“真实冲突已出现并恢复”。

## 独立二进制资源压力

在 MemoryMax=2 GiB、MemoryHigh=1.5 GiB 的独立 transient unit 中，向候选二进制
同时发送 12 个未结束的 9 MiB 上传，使用默认 16 名额 / 128 MiB 总预算。

| 检查 | 修复前 | 修复后 |
| --- | --- | --- |
| 三种 POST 接口超额请求 | 503 + Retry-After 1 | 503 + Retry-After 1 |
| health / ready | 200 / 200 | 200 / 200 |
| 上游 dispatch | 0 | 0 |
| 中止全部上传后 token-count | 503，预算未释放 | 200 |
| 剩余请求/字节预算 | 未释放 | 0 / 0 |
| 候选服务峰值 RSS | 约 195 MiB | 约 198 MiB |
| 整个测试 unit memory peak | 约 360 MiB | 约 352 MiB |
| unit OOM kill | 0 | 0 |

证据：[反例](evidence/fable-recovery-2026-09-20/admission-before-disconnect-fix.json)、
[修复后](evidence/fable-recovery-2026-09-20/admission-after-disconnect-fix.json)。
可执行 harness：`scripts/probe-request-admission.ts`，不 dispatch 推理。

断连修复前候选 SHA256：
`68a4b770d2e2cdfd377014091711efb40928c2c90dd612eb0d67183eb6320919`。
断连修复后候选 SHA256：
`031d921d79fb1aa478b95b07e230b400ca4e0da688bd20af7379c72eab2edfc5`。
真实签名对照在前一候选完成，断连修复后的二进制通过资源复验；最终公开 Release
还需独立下载、校验和运行验证。

此负载验证的是上传准入与断连释放，不是所有解析/推理负载的 heap 上限。
宿主其他任务仍可能造成全局内存压力；不能用这组数据宣称系统永远不会 OOM。

同一服务进程又连续完成了 5 轮相同负载，每轮结束后的请求/字节预算均为 0，
token-count 均恢复 200，没有任何推理 dispatch 或 OOM。服务 RSS 约为
198、299、309、331、334 MiB，测试 unit 总峰值约 658 MiB；增长趋缓，但这不是
长期 heap 泄漏的排除证明。详见
[重复负载证据](evidence/fable-recovery-2026-09-20/admission-repeated-cycles.json)。
