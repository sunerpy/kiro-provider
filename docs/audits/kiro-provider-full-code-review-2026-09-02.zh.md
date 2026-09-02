# kiro-provider v0.5.1 全面代码审视报告与修复优化方案

- 审查日期：2026-09-02（修订版 2）
- 审查对象：`main` 分支 `4170c95`（chore: release 0.5.1），`src/` 约 20.1k 行，`__tests__/` 约 24.2k 行
- 审查方式：静态通读全部 `src/`、`scripts/`、CI 与文档；对高危结论逐条回读源码或在 Bun 1.3.14 下用探针脚本复现；仓库源码未做任何修改
- 文档定位：问题线索清单与分阶段修复建议。第 2 节每条都标注了核实方式；标注「待取证」的条目在取得真实 Kiro 协议证据前不应进入实施计划或发布门禁

## 修订记录

修订版 2 根据复核意见做了以下调整：

- 严重度重新分级。原 P0 中只保留会导致进程退出或客户端必现不可恢复错误的两项（A5、A6）；A1、A7、A8 与 A2 至 A4 降为 P1 高优先级，理由见各条。
- A1 收窄场景：只在内部空闲超时、消费者取消、以及 transformer 在 socket 仍存活时判定的协议错误下成立；socket 自身报错时连接通常已断开。
- A5 验收标准改为 fail-closed：锁失效后受控退出并交给服务管理器重启，不得继续服务。
- A8 限定为"客户端同时回放多个 reasoning item 时必现"。
- B9 纠正：deadline 信号已传入 SDK `send`，SDK 重试受 abort 约束；"最多 15 次"只是理论乘积。
- B11 限定：30 秒同步等待仅在 `opencode-shared` 路径；本地路径为 5 秒 `busy_timeout`。
- B13 收窄：默认启动先取单实例锁再创建 keyring，CLI 不构造 ReplayStore；竞态只在关闭单实例保护或以库方式嵌入时存在。
- B16 修复方案细化：客户端断开、非法传输、服务端读取错误需分别分类，不能一律 400。
- B19 补充：应用层 10 MiB 检查仍有效，风险是 runtime 已先接收数据占用内存。
- B20、B21、B25、B26 改为「待取证」并写明安全边界：不得在无 Kiro 协议证据时把空参数归一化为 `{}`、合并 reasoning item、静默切换 conversation、或把未知工具错误机械改为可重试。
- B22 表述修正：流开始时空 signature 是正常形态，真正的错误是完成后仍未获得 signature。
- C5 改为"候选"清单，删除前需确认无外部消费者。
- 第 4 节修复顺序按新分级重排。

## 0. 结论摘要

**基线全部通过**：`tsc --noEmit` 无错误，Biome lint 无告警，`bun test` 896 个用例全部通过（20.5 秒），覆盖率门禁 93% 与 codecov 配置一致。项目整体质量明显高于同类：fail-closed 的请求校验、参数化 SQL、CAS + tombstone 的账户持久化、AES-256-GCM + AAD 的推理回放存储、审计日志只输出哈希、时序安全的 API key 比较。

问题集中在四个方面：

1. **两处会导致进程退出或客户端必现不可恢复错误的缺陷**（P0）：单实例锁被破坏时以未捕获异常杀死进程；Responses 流的 reasoning `output_item.done` 缺 `encrypted_content`，依赖 item 级事件组装历史的客户端下一轮会被 400 拒绝。
2. **默认 `auth_source: "local"` 的请求路径鲁棒性不足**（P1 高）：token 刷新失败在同一 attempt 内不切换账户；每次选账户递增 `generation` 使刷新去重失效；去重后的刷新共享首个调用方的 AbortSignal。三者需作为一个原子修复。
3. **上游连接生命周期与账户租约脱节**（P1 高）：内部空闲超时与消费者取消时只调用 `iterator.return()`，Smithy 分块器不会转发到 HTTP body，Kiro 连接可能继续存活而账户队列已释放。
4. **两个 SSE 编码器独立演化产生漂移，以及工程卫生**（P1 / P2）：Anthropic 编码器缺少 Responses 编码器已有的延后 reasoning 与背压；数值配置无边界；`log_level` 无消费方；`scripts/` 未纳入类型检查且有 6 个类型错误；`bun.lock` 中 34 个包指向 npmmirror；安装脚本不校验 `SHA256SUMS`；格式化器关闭导致风格混杂。

**建议实施顺序**：(1) A5 + B15 最小修复；(2) A6 至 A8 的 reasoning item 原子完成与签名一致性；(3) A1；(4) A2 至 A4；(5) B4；(6) B20、B21、B26 等待取证后再定。

## 1. 基线数据

| 项目 | 结果 |
| --- | --- |
| `bun run typecheck` | 通过 |
| `bun run lint` | 通过，168 文件 |
| `bun test` | 896 通过 / 0 失败，76 文件，20.5 秒 |
| 覆盖率门禁 | 93%（`scripts/coverage-gate.ts` 与 `codecov.yml` 一致） |
| 依赖 | 82 包；`@aws/codewhisperer-streaming-client` 1.0.45、`@smithy/node-http-handler` 4.9.7（精确锁定）、`zod` 3.25.76、`typescript` 5.9.3 |
| 过期依赖 | `zod` 4.5.4、`typescript` 7.0.2、`@types/node` 26.x 为主版本升级；`@biomejs/biome` 2.5.11、`@smithy/node-http-handler` 4.12.0 |
| Git | 24 次提交，2026-07-19 至 2026-08-31，单一贡献者 + release bot |
| 仓库卫生 | `dist/`、`coverage/`、`.omo/` 已忽略且未跟踪；`.agents/`、`.codex/` 为空目录未忽略 |
| TODO/FIXME | `src/`、`scripts/` 中为零 |
| 发布形态 | `package.json` 仅声明 `bin`，无 `main`/`exports`；`src/index.ts` 的导出目前不可从 npm 包消费 |

## 2. 发现清单

严重度定义：**P0** 会导致进程退出、数据不一致或客户端必现且不可恢复的错误；**P1 高** 会破坏架构文档承诺的不变量或在常见场景下产生错误响应；**P1** 会导致可观察的错误响应、性能退化或供应链风险；**P2** 代码质量、文档与兼容性打磨。核实方式：「已核实」表示回读源码或探针复现确认；「待取证」表示依赖上游 Kiro 行为，需真实 fixture 验证后才能决定实现。

### 2.1 P0

#### A5. 单实例锁被破坏时以未捕获异常杀死整个网关（已核实，探针复现）

- 位置：`src/server/single-instance.ts:14-19, 79`，`node_modules/proper-lockfile/lib/lockfile.js:213`
- 现象：未传 `onCompromised`，proper-lockfile 默认 `onCompromised: (err) => { throw err; }`。mtime 刷新定时器发现 `.lock` 目录消失（ENOENT）或错过 stale 窗口时，在 `setTimeout` 回调里抛出，成为未捕获异常。
- 复现：获取锁后 `rm -rf` 锁目录，进程约 9 秒后以 `ENOENT ... at onCompromised` 退出。运维清理锁文件（对 ELOCKED 的自然反应）或进程挂起超过 30 秒后被另一实例接管，都会触发。
- 修复（fail-closed）：传入 `onCompromised`，写审计日志 `single_instance_lock_compromised`，调用 `server.stop()` 排水后以非零码退出，交给 systemd 等服务管理器重启。**不得继续服务**，否则锁已失效的情况下可能出现双实例同时运行，破坏账户队列与 socket 池的单一所有权。补测试：删除锁目录后进程在有限时间内受控退出且退出码非零，退出前在途请求完成或收到明确错误帧。

#### A6. Responses SSE：reasoning 的 `output_item.done` 缺少 `encrypted_content`（已核实，探针复现）

- 位置：`src/server/responses/sse-adapter.ts:285-340, 406-409, 415, 455, 543-552`，`src/kiro/transform/streaming/sdk-output-transformer.ts:277`
- 现象：首个 `text_delta` / `tool_call_delta` 触发 `closeReasoning`，此时 `reasoningEncryptedContent` 仍为 `undefined`，因为 transformer 在所有 tool delta 之后才产出 `reasoning_encrypted`。事后补丁循环只改 `completedOutput`，已经发出的帧无法补入。探针输出：`output_item.done` 的 item 为 `{"type":"reasoning","summary":[…]}`，`response.completed` 里的同一 item 才有 `"encrypted_content"`。
- 失败场景：Codex 的 `process_sse` 从 `output_item.done` 组装历史，存下无 token 的 reasoning item；下一轮回传 `{type:"reasoning", summary:[…]}`，被 `request-adapter.ts:730-737` 以 `unsupported_reasoning_plaintext_replay` 拒绝。只要一轮输出同时包含 reasoning 与 text/tool，就必现。现有测试 `responses-sse-adapter.test.ts:936` 只覆盖纯 reasoning 场景所以能过。
- 修复：`includeEncryptedReasoning` 时照常流式输出 `reasoning_summary_text.delta`，但把 `reasoning_summary_text.done` 与 reasoning item 的 `output_item.done` 推迟到 `complete()`，保证 item 完成时 token 已知。与 A7、A8 一起作为"reasoning item 原子完成"修复。

### 2.2 P1 高

#### A1. 内部空闲超时与消费者取消时上游 Kiro 流不会被真正中止（已核实）

- 位置：`src/core/pipeline.ts:633`，`src/core/pipeline-stream.ts:61-62, 112-129`
- 现象：`client.send(command, { abortSignal: signal })` 只绑定入口信号。`createPipelineStreamResponse` 内部创建的 `streamAbort` 只喂给 transformer，到不了 SDK 请求。`idle-timeout`、`consumer-cancel` 与 transformer 判定的协议错误依赖 `transformSdkOutputStream` 的 `finally { iterator.return() }` 关闭 HTTP body。
- 根因：`@smithy/core` 的事件流分块器（`dist-cjs/submodules/event-streams/index.js:412-458`）是没有 `try/finally` 的 `async function*`，对外层调用 `return()` 不会转发给 `sourceIterator`。唯一能销毁 socket 的是 `NodeHttpHandler` 的 abort 监听器（`req.destroy()`），而它只监听入口信号。
- 适用范围：仅当 socket 仍存活时成立，即空闲超时、消费者取消、以及 transformer 在数据仍在流入时判定的协议错误。socket 自身报错（ECONNRESET 等）时连接已断开，不属于此范围。
- 失败场景：流卡住到 `stream_idle_timeout_ms`，`finalize` 释放账户队列与会话队列，路由清掉 deadline 计时器，组合信号不再触发。Kiro 侧可能继续生成并计费，下一条同账户请求并发发出，违反"账户队列保护单个 Kiro 账户"的设计不变量。现有测试用假迭代器只断言 `returnCalled`。
- 分级理由：不会崩溃或损坏数据，但破坏架构承诺的不变量并可能产生额外计费，故为 P1 高。
- 修复：在 `executeLoop` 每次尝试创建独立 `AbortController`，用 `AbortSignal.any([signal, attempt.signal])` 传给 `client.send`；把 controller 放进 `"stream"` 结果，在 `beginTerminal` 里**只对异常结局**（`idle-timeout`、`consumer-cancel`、`upstream-error`、`external-abort`）调用 abort，`normal-complete` 不动；非流式路径在 `collectSdkResponse` 异常结束时 abort。补一个用真实 `NodeHttpHandler` 对本地 mock 服务的测试，断言空闲超时与取消后 socket 被销毁。

#### A7. Anthropic SSE：text 之后再来的 reasoning 写入已 stop 的 block / 打开重叠 block（已核实，探针复现）

- 位置：`src/server/anthropic/response-adapter.ts:275-292, 304-318`
- 现象：`reasoning_delta` 只判断 `!reasoningStarted`，`reasoningStopped` 为 true 时仍向旧 `reasoningIndex` 发 `thinking_delta`。探针序列 reasoning→text→reasoning 产生 `content_block_stop[0] … content_block_delta[1]:text_delta content_block_delta[0]:thinking_delta content_block_stop[1]`。`reasoning_redacted` 在 text block 仍开放时直接打开新 block。Responses 编码器已明确处理这一顺序（`sse-adapter.ts:371-374`，测试 1192/1254），Anthropic 编码器没有。
- 说明：Anthropic 官方增量流协议允许 signature 在流后段到达，因此 block 开始时 signature 为空是正常形态，不能据此判错；本条只针对 block 状态机允许向已 stop 的 block 追加 delta。
- 修复：镜像 Responses 的延后逻辑，text 之后的 reasoning 缓冲到 `complete()` 再以新 index 发出；打开 redacted block 前先 `stopText()`。

#### A8. 加密回放时多个 reasoning item 共享一个 token，客户端同时回放多个 item 时必现 400（已核实，探针复现）

- 位置：`src/server/responses/sse-adapter.ts:543-552`，`src/server/responses/request-adapter.ts:464-511`，`src/kiro/transform/history-builder.ts:153-155`
- 现象：token 被附到每一个 reasoning item；回放时对每个 item 分别做"其后 item"的指纹比对。输出 `[rs1, message, rs2, function_call]` 时探针显示 `input.1: match, input.3: mismatch`，返回 400 `reasoning_replay_context_mismatch`。`history-builder` 用 `insertBeforeMessage` 做 Map key，两个回放解析到同一索引时静默丢一个。
- 适用范围：只在一轮输出产生多个 reasoning item（延后 reasoning 触发）且客户端把它们全部回放时必现；单 reasoning item 的常规轮次不受影响。
- 修复：每轮只把 `encrypted_content` 附到一个 reasoning item；request-adapter 把相邻 reasoning item 视为一组做指纹比对。不采用"合并 item"方案，见 B21 的安全边界。

#### A2 + A3 + A4. 本地模式 token 刷新的三个联动缺陷（已核实，必须作为一个原子修复）

**A2. 刷新失败在同一 attempt 内不切换账户、不标记健康状态**

- 位置：`src/core/pipeline.ts:572-575, 664-672, 707-709`，`src/core/token-refresher.ts:60-69`，`src/kiro/token.ts:126-134`
- 现象：`refreshIfNeeded` 在 `upstreamStarted = true` 之前执行，任何抛出走 `if (!upstreamStarted) throw caught`，最终由 `runChatCompletion` 变成 `500 internal_error`。`refresh-then-retry` 分支的 `forceRefresh` 同样在 catch 里抛出。`TokenRefresher.runRefresh` 没有 catch，不像 `OpenCodeTokenRefresher.runLockedRefresh`（`opencode-auth-runtime.ts:333-349`）会在 `isRefreshTokenDead` 时标记账户死亡。
- 失败场景：账户 A 的 refresh token 被吊销，账户 B 健康。`sticky` 策略下路到 A 的请求返回 500，直到维护循环（首轮 5 秒后，之后每 60 秒）标记 A 死亡。若是 OIDC 端点网络错误或 5xx，A 不会被标记。`__tests__/pipeline.test.ts:1904-1931` 把这个行为固化为预期。
- 分级理由：客户端重试即可恢复，且维护循环最终会收敛，属于可用性问题而非普遍 P0。

**A3. 每次选账户都递增 generation，刷新去重失效，轮换时抛 AccountUnavailableError**

- 位置：`src/core/token-refresher.ts:28-33, 49`，`src/core/account-manager.ts:107-115, 227-249, 262-270`，`src/storage/accounts-db.ts:324`
- 现象：`selectHealthyAccount` 对被选账户做 `patchAccount`（`usedCount + 1`、`lastUsed`），SQL 里 `generation = generation + 1`。in-flight 去重 key 是 `${id}:${generation}`，N 个并发请求持有 N 个不同 generation，不会合并。账户队列串行化后，第二个请求的快照仍显示"已过期"，用旧 refresh token 再刷一次。`updateFromAuth` 首次 CAS 失败，重读后 `isSameLogin` 比较 `refreshToken` 不相等（已被第一次刷新轮换），返回 `undefined`，抛 `AccountUnavailableError`，经 A2 变成 500。
- 影响面：重启后 token 已过期、维护循环被关闭、`GET /v1/models` 对所有账户并发调用 `refreshIfNeeded`（`routes/models.ts:106-114`）时触发。`__tests__/token-refresher.test.ts:250-277` 把"不同 generation 不去重"固化为预期。

**A4. 去重后的刷新共享首个调用方的 AbortSignal**

- 位置：`src/core/token-refresher.ts:53`，`src/kiro/token.ts:89`
- 现象：`startOrJoinRefresh` 把首个调用方的 `signal` 传进共享的 `runRefresh`，`refreshAccessToken` 再把它塞进 `fetch`。首个客户端断开或超时，fetch 被中止，所有 joiner 收到 `AbortError`；joiner 自己的信号未中止，`pipeline.ts:665` 不拦截，走 `throw caught` 变成 500。当前因 A3 几乎不会合并而被掩盖；A3 修好后立刻暴露。

**原子修复方案**：

1. `refreshIfNeeded` 先重读最新行并重新判断是否过期；in-flight 按 `account.id` 去重（`OpenCodeTokenRefresher` 已这样做，见 `opencode-auth-runtime.ts:263`）。
2. 共享刷新拥有独立生命周期，不接收任何单个调用方的信号；调用方已用 `abortable(promise, signal)` 包裹（`pipeline.ts:572`）实现各自超时；如需整体超时用独立 `AbortSignal.timeout`。
3. `isSameLogin` 去掉 `refreshToken` 比较，改用 `email/startUrl/authMethod/clientId`，或通过比较 `accessToken/expiresAt` 识别"别人已刷新"并返回最新行。
4. `TokenRefresher.runRefresh` catch 后计算 `errorReason`，死亡时 `markUnhealthy(toDeadReason)` 再抛；pipeline 对 `upstreamStarted` 之前的 `KiroTokenRefreshError` 执行 `switch`（排除该账户、`continue`），仅在无备选账户时终止；`NETWORK_ERROR` 可做一次有界重试。
5. 更新 `token-refresher.test.ts:250` 与 `pipeline.test.ts:1904` 的旧预期，并新增：两个不同 generation 的并发刷新只发一次网络请求；首个调用方中止不影响 joiner；轮换后不抛 `AccountUnavailableError`；A 刷新 `invalid_grant`、B 健康时请求成功且 A 被标记。

### 2.3 P1

#### 核心与调度

- **B1. 错误分类只处理 500；502/503/504 与常见 socket 错误直接失败**（已核实）。`src/core/error-classifier.ts:170-196` 的 `switch` 只有 `case 500`，其余走 `default → fail`。`NETWORK_ERROR_PATTERN`（第 32-33 行）缺 `ECONNREFUSED`、`EAI_AGAIN`、`EPIPE`、`timed out`。建议按 `error.code` 而非消息文本分类，502/503/504 与 500 同样先重试再切换。
- **B2. 429 重试不受 `rate_limit_max_retries` 约束**（已核实）。`error-classifier.ts:164-169` 单账户时无条件 `retry`，只受 `max_request_iterations` 与 deadline 约束；`retry-after` 缺省 60 秒，默认 120 秒 deadline 下客户端看到 504 而不是 429。
- **B3. `accountCount` 把不可选账户也算进去导致过早 503**。`pipeline.ts:698` 传 `eligibleAccountIds.size`，该集合不排除 unhealthy / rate-limited 账户。A 健康、B 限流 10 分钟时，A 得到 429 → `switch`（count=2）→ A 被限流 → 下一轮无候选 → 503；若正确计数为 1 会按 retry-after 等待重试。`getMinWaitTime()` 目前无人调用，可用于"无候选时在 deadline 内等待"。
- **B4. 非流式路径对可重试的流错误处理不一致**。`stream-error.ts` 把 `upstream_stream_error`、`malformed_upstream_tool_arguments` 标为 retryable，但 `executeLoop` 里 `SdkStreamProtocolError` 一律 502（`pipeline.ts:687-692`），`ToolCallViolation` 不匹配任何 `instanceof`，经 `normalizeSdkError` 变成 500。此时尚未向客户端发送内容，重试安全。建议在非流式 catch 里按 `normalizeStreamFailure(caught).disposition` 分支，让 malformed tool arguments 进入已有的可恢复重试路径。
- **B5. `HTTP_401`/`HTTP_403` 子串即判 refresh token 死亡**。`src/kiro/health.ts:33-34` + `src/kiro/token.ts:32-37`：非 JSON 响应体产出 `HTTP_${status}`，企业代理 / WAF 的 HTML 403 会让维护循环与配额探测把账户永久标记为 unhealthy，必须重新登录。建议只对 JSON 结构化 OIDC 错误（`invalid_grant`、`ExpiredTokenException`）判永久。
- **B6. 配额 recheck 位于请求热路径**（已核实）。`pipeline.ts:377-383` 在会话锁内 `await recheckDueAccounts`；`quota-rechecker.ts:223-248` 有到期账户时 `await runBatch`，超时默认 10 秒。用量端点卡住时每条请求多等最多 10 秒。建议 fire-and-forget，或仅当没有非耗尽候选账户时才等待。
- **B7. SDK effort 中间件每次发送都完整 `JSON.parse` + `JSON.stringify` 请求体**（已核实）。`src/core/sdk-client.ts:166-190`；请求体最大 10 MB 且含 base64 图片/文档。`transformToSdkRequest` 已返回 `additionalModelRequestFields`，可在 `pipeline.ts:618-627` 直接合并。
- **B8. SDK client / transport 缓存从不驱逐**。`sdk-client.ts:25-26, 199-203`，`clearSdkClientCache` 没有调用方。账户删除后其 `NodeHttpHandler` agent 永久存活。建议在 `reconcileFromDb` 发现账户消失时驱逐，或加 LRU 上限。
- **B9. 双层重试叠加**。`sdk-client.ts:71-72` `maxAttempts: 3, retryMode: 'standard'` 让 SDK 先对 5xx / 节流重试，pipeline 再对 500 重试至多 5 次。deadline 信号已通过 `client.send(command, { abortSignal })` 传入 SDK，SDK 重试会被 abort 终止，因此不存在"SDK 不感知 deadline"的问题；"15 次"只是理论乘积上限。实际问题是重试策略分散在两层、退避叠加难以推断。建议 `maxAttempts: 1`，由 pipeline 统一拥有重试。

#### 存储、认证与 Kiro 客户端

- **B10. 模型目录无负缓存**。`src/kiro/model-capabilities.ts:209-243, 288-300`：快照过期后每次都发请求，失败只记录 `failedAt` 用于限流告警日志。管理端点不可达时每条请求在 `ensureAccountModel` 阻塞最多 10 秒。建议失败后在退避窗口内把 stale 快照视为 fresh，或后台刷新。
- **B11. `opencode-shared` 路径的 SQLite 写锁等待阻塞事件循环最长 30 秒**。`src/auth/opencode-auth-store.ts:88-97, 451-491` 用 `Atomics.wait` 在主线程阻塞退避，`WRITE_LOCK_DEADLINE_MS = 30_000`；每条请求都触发写（`recordSelection`）。默认本地路径为 `busy_timeout = 5000`，同样同步等待但上限 5 秒。`bun:sqlite` 的固有限制；建议共享模式缩短到数秒并返回 503，选择计数改为 best-effort。
- **B12. 配额恢复用固定间隔而非上游 reset 时间**（待取证）。`usage-client.ts` 只解析 `currentUsage/usageLimit/...`，无 reset 时间；`nextRecheckAt = lastSync + intervalMs`（15 分钟）。若 `getUsageLimits` 暴露 reset 字段，应解析并取 `max(resetAt, lastSync + intervalMs)`。需先用真实账户确认字段名。
- **B13. Keyring 首启竞争（仅在关闭单实例保护或以库方式嵌入时存在）**。`src/reasoning/keyring.ts:126-154` 用 `existsSync` + `renameSync`，非独占。默认 `startServer` 先取单实例锁再创建 keyring，CLI 的 `login`/`accounts` 不构造 ReplayStore，因此默认部署不会触发。`enforce_single_instance: false` 或外部代码直接调用 `buildServerDeps` 时两个进程可能互相覆盖密钥文件。低成本修复：`openSync(path, 'wx', 0o600)`，EEXIST 时重读。
- **B14. 数据库区域字段未校验即拼入主机名**。`src/storage/account-record.ts:66`、`src/auth/opencode-auth-store.ts:104` 直接把 `row.region` 断言为 `KiroRegion`；`usage-client.ts:136-138`、`management-client.ts:107` 用它拼 URL。属于纵深防御项，建议 `rowToAccount` 内 `isValidRegion`，失败行跳过并告警。

#### HTTP 服务层

- **B15. 三个路由的 ingress 代码三份复制且已漂移**（已核实）。`readRequestBody`、`RequestBodyTooLargeError`、`abortReason`、deadline/`IngressSignals` 构造、`routeFinalize`、`runChatCompletion` 选项展开在 `routes/responses.ts`、`messages.ts`、`chat-completions.ts` 各一份。`responses.ts:95` 用 `void reader.cancel(reason)`，另两处用 `boundedCleanup(() => reader.cancel(...))`。按 Streams 规范，流已 errored 时 `reader.cancel()` 返回 rejected promise；Bun 1.3.14 对未处理 rejection 会终止进程（独立探针确认），端到端时序未复现。最小修复：`responses.ts` 改用 `boundedCleanup`；结构修复见 Phase 4。
- **B16. 内部异常文本原样返回客户端；请求体读取失败统一报 500**（已核实）。`src/server/app.ts:222-228`、`src/core/pipeline.ts:833-834`：任何异常的 `error.message`（含 SQLite 路径、账户 UUID）直接进响应；`__tests__/server-app.test.ts:335-368` 断言 `"body stream failed"` 走 500。修复需分类而非一律 400：客户端中途断开返回 499 或直接放弃响应；非法传输编码、JSON 截断等客户端错误返回 400；服务端读取异常保持 500 但改固定文案 + 关联 id，审计日志记录哈希。
- **B17. Anthropic SSE 编码器无背压**。`src/server/anthropic/response-adapter.ts:173-175, 355-425` 直接 `enqueue`，`complete()` 一次性突发多帧；`chat-output.ts` 与 `responses/sse-adapter.ts` 都是每次 `pull` 刷一帧。没有 `/v1/messages` 的慢读者测试。
- **B18. 非正常退出后 30 秒内重启必失败且不重试**（已核实）。`single-instance.ts:15-17` `stale: 30_000, update: 10_000, retries: 0`；SIGTERM/SIGINT 由 signal-exit 正常清理，但 SIGKILL/OOM 后 `serve` 立刻 ELOCKED 退出。README 推荐的 systemd 单元 `RestartSec=5s` 会连续失败到窗口过去。建议异步 `lockfile.lock` 加 `retries`，缩短 `stale`/`update`，错误信息带锁路径与窗口时长。
- **B19. `Bun.serve` 未显式设置 `development: false` 与 `maxRequestBodySize`；无优雅关停**（已核实）。`src/server/app.ts:371-380` 只传 `hostname/port/fetch`。Bun 的 `development` 默认 `process.env.NODE_ENV !== 'production'`，编译后二进制通常不设 `NODE_ENV`，未捕获错误会渲染带堆栈的错误页。Bun 默认请求体上限 128 MiB；应用层 10 MiB 检查仍然有效，但发生在 runtime 已接收数据之后，风险是提前占用内存而非绕过限制。`src/` 中没有 `SIGTERM`/`SIGINT` 处理，`systemctl stop` 会切断在途流并跳过 `maintenance.stop()`。建议设置 `development: false`、`maxRequestBodySize: config.max_request_body_bytes`、`error` 回调，并注册信号处理调用 `server.stop()` 加排水超时。

#### 协议适配

- **B20. 运行时拒绝零参数工具调用，而适配层的归一化代码不可达**（矛盾已核实；Kiro 是否会发出待取证）。`sdk-stream-runtime.ts:385-399` 对默认 `''` 的 `input` 做 `JSON.parse` 抛出 `malformed_upstream_tool_arguments`；`tool-bridge.ts:182-184`、`sse-adapter.ts:494`、`request-schema.ts:99-101` 的 `""→"{}"` 归一化永远执行不到。**安全边界**：不得在无 Kiro 协议证据时把空白或缺失参数归一化为 `{}`，那会把损坏的工具调用变成真实副作用。当前建议：先用真实 Kiro fixture 确认无参数工具的 `toolUseEvent` 形态；若确认合法再放开，否则删除适配层不可达的归一化并把该错误码从 retryable 改为 fatal（重试结果相同）。
- **B21. 一个 assistant 轮次 / 一组并行工具结果被投影为多个连续同角色 Kiro 条目**（结构已核实；Kiro 接受度待取证）。`responses/request-adapter.ts:767-802, 832-851` 每个 `function_call` / `function_call_output` 各成一条消息，`history-builder.ts:157-167` 不分组。探针产出 `A{text} A{c1} A{c2} U{r1}` 与 current `U{r2}`，而 Kiro 原生形态是单条 `assistantResponseMessage{content, toolUses:[c1,c2]}` 加单条 `userInputMessage{toolResults:[r1,r2]}`。2026-08-26 的探针只测过纯文本连续同角色。**安全边界**：合并会改变 item 顺序、签名 fingerprint 与历史回放语义，与 A8 的指纹比对和加密回放耦合，目前不安全。建议：先用真实 Kiro fixture 验证当前形态是否被接受；若不接受，再设计与回放指纹兼容的分组方案，并更新 PROTOCOL_COMPATIBILITY 中"never merges"的表述。
- **B22. Anthropic 流式与非流式对"完成后仍未签名"的 reasoning 处理不一致**（已核实）。非流式 `response-adapter.ts:102-109` 返回 502；流式 `:275-292` 在 `complete()` 时若仍无 signature 也正常完成，客户端会拿到 `signature: ""` 的 thinking block，回传时 `anthropic/request-adapter.ts:214` 接受并转发给 Kiro。流开始时空 signature 是官方协议允许的正常形态，本条只针对**完成后仍未获得 signature**。建议流式在 `complete()` 时检测并以 `invalid_upstream_reasoning` 失败，与非流式一致；输入侧拒绝空字符串签名。
- **B23. 图片 base64 无效返回 500；media type 未按 Kiro 枚举校验**（已核实）。`image-handler.ts:23-28` 的 `atob` 抛 `DOMException` 而非 `RequestTransformError`，`history-builder.ts:95` 不捕获。`image-handler.ts:75` 的 `mediaType.split('/')[1]` 未校验，SDK 枚举只有 `gif|jpeg|png|webp`，与 `PROTOCOL_COMPATIBILITY.md:31` 的声明不符。`document-handler.ts:117-140` 是正确写法。
- **B24. Anthropic `tool_result` 缺 `content` 被拒**（已核实）。`anthropic/request-adapter.ts:178-185` 对 `undefined` 返回失败，而规范中 `content` 可选。
- **B25. Anthropic 签名 thinking 回放硬耦合 affinity/lineage**（待取证）。`pipeline.ts:223-229` 要求已有 account/conversation 绑定；Anthropic 无显式 affinity key，只能靠 `resolveOutputLineage` 在 `session_affinity_ttl_ms`（24 小时）内命中。超过窗口恢复的会话每条请求 400。**安全边界**：不得静默换 conversation 降级，带签名 reasoning 跨 conversation 回放可能无效且会隐藏问题。建议：返回带明确错误码的 400 并在文档中要求客户端以新 turn 开始（丢弃 thinking block）；是否允许跨 conversation 由 Kiro 验签结果取证后再定。
- **B26. 模型输出类错误被归为 fatal 协议错误**（待取证）。`sse-adapter.ts:506-509` 把 `unknown_tool_alias`（工具名不在声明中）、`invalid_custom_tool_input` 映射为 `upstream_protocol_error`。**安全边界**：不得机械改为可重试，它们可能是确定性协议错误（例如别名表构建缺陷），重试只会重复失败。建议先拆出新的类型化错误码（如 `unknown_upstream_tool`），用真实流量统计其重试成功率后再决定 disposition。
- **B27. Anthropic 流式从不上报真实 `input_tokens`**。`routes/messages.ts:208-210, 302` 用 `JSON.stringify(canonical)/4` 估算写进 `message_start`，`response-adapter.ts:415-422` 的 `message_delta.usage` 只有 `output_tokens`，Kiro `completed` 事件里的真实 `inputTokens` 被丢弃。

#### 配置、CLI、构建与供应链

- **B28. 多个数值字段无边界，空字符串环境变量被静默转成 0**（已核实）。`src/config/schema.ts:47, 88, 89, 128, 141, 142` 的 `port`、`rate_limit_max_retries`、`rate_limit_retry_delay_ms`、`max_request_iterations`、`max_request_body_bytes`、`token_expiry_buffer_ms` 是裸 `z.number()`；`loader.ts:126` 用 `Number(value)`，`Number("") === 0`。实测 `KIRO_PROVIDER_PORT=""` 启动在随机端口、`PORT=70000`/`8787.5`/`0x1f90` 被接受、`MAX_REQUEST_BODY_BYTES=""` 让所有请求 413、`MAX_REQUEST_ITERATIONS=0` 让所有请求失败。
- **B29. `log_level` 在 schema、环境变量、两份 CONFIGURATION 文档与 README 中都有，但没有任何代码读取**（已核实）。`src/core/audit-log.ts:11-29` 无条件 `console.error`，每条请求输出 `upstream_affinity_selected` 等 info 日志。要么接入阈值过滤并收窄为 enum，要么删除字段与文档。
- **B30. 配置文件未知键被静默丢弃**（已核实）。`loader.ts:20, 34` 的 `ConfigSchema.partial()` 为 strip 模式，拼错 `enable_legacy_chat_completion` 不会有提示。
- **B31. `scripts/` 未纳入类型检查，`validate-local-auth-e2e.ts` 有 6 个类型错误**（已核实）。`tsconfig.json:16` 只含 `src`、`__tests__`。加入 `scripts` 后 `tsc` 报第 59、111、127、178、437、438 行，其中 `database.run("... WHERE id <> ?", selected.id)` 传裸字符串而非绑定数组。
- **B32. `bun.lock` 中 34 个包的 tarball 指向 `registry.npmmirror.com`**（已核实）。含 `@aws/codewhisperer-streaming-client`、`zod`、`typescript`、`@biomejs/biome` 及平台二进制。有 integrity 哈希所以篡改会被发现，但可用性、隐私与管辖权不同。建议不带镜像重新生成锁文件，CI 加 grep 门禁，`bunfig.toml`（当前 0 字节）显式写 registry。
- **B33. 安装脚本不校验发布产物的 `SHA256SUMS`**（已核实）。`release.yml:314, 332` 生成并上传校验和，`scripts/install.sh:55-59`、`install.ps1:46-52` 只检查非空，默认跟随 `releases/latest`。
- **B34. 发布流水线：macOS / Windows 二进制在 Ubuntu 交叉编译后从未执行；publish 路径 `npm install -g npm@latest` 未固定**（已核实）。`release.yml:237-251, 370`。
- **B35. 首次 `login` 持久化占位邮箱 `builder-id@aws.amazon.com` 且不去重**（已核实）。`src/kiro/oauth-idc.ts:253`，`src/cli/login.ts:157-182` 只在 `replaceAccount` 时调 `fetchUsage`。同一人登录两次产生两行同占位邮箱记录，`accounts remove <email>` 抛 `AmbiguousAccountError`。

### 2.4 P2：低危与代码质量

#### 代码风格与结构

- **C1. 格式化器关闭，风格混杂**（已核实）。`biome.json` `formatter.enabled: false` 却配置了 `singleQuote/asNeeded/none`。`src/` 中 7 个文件在同一文件内混用 tab 与空格，13 个文件分号风格混杂，21 个文件单引号、51 个文件双引号。建议启用 Biome formatter 一次性格式化，pre-commit 强制。
- **C2. `executeLoop` 约 420 行，十余个可变局部变量，混合三类职责**。建议拆为 `resolveBinding`、`selectAttemptAccount`、`runAttempt`、`applyClassification`。
- **C3. 三处工具历史校验器**：`anthropic/request-adapter.ts:449`、`chat-adapter.ts:351`、`request-core.ts:134`；`sdk-collector.ts` 重新实现了 transformer 的循环且已漂移（缺 `invalid_upstream_reasoning` 与原始事件审计）。建议 collector 直接消费 transformer。
- **C4. local 与 opencode-shared 路径重复**：`sameTokenSnapshot`、`rowToAccount`、`isSelectable`/`selectCandidate` 约 60 行、`markUnhealthy` 语义三处、默认配置目录解析四处（`import-accounts.ts:55-60` 缺 win32 `APPDATA` 分支）、`errorReason` 三处。
- **C5. 疑似未使用代码候选**（删除前需确认无外部消费者）。`package.json` 未声明 `main`/`exports`，`src/index.ts` 目前不可从 npm 包消费，但以源码或 git 依赖方式嵌入的使用方仍可能引用导出符号。候选：`AccountsDatabase.getReasoningReplayByTokenHash`、`KiroQuotaExhaustedError`/`KiroRateLimitError`/`KiroAuthError`、`KIRO_CONSTANTS.AXIOS_TIMEOUT/SDK_VERSION_USAGE/BASE_URL/USAGE_LIMITS_URL`、`isLongContextModel`、`DialectGate`、`findRealTag`、`extractAllImages`、`extractTextFromParts`、`currentAssistantResponse`、`proxy.ts:createProxyAgent`（其 `keepAlive: true` 与 `sdk-client` 默认相反）、`AccountManager.markUnhealthy` 的瞬时分支（生产调用方全部传永久原因，`failCount` 从不重置）、`pipeline.ts:740` 与 `:325` 的无效条件、`request-core.ts:199-200` 的 `_think/_budget`、`keyring.ts:49-55` 的不可达 catch。建议先加 `@deprecated` 标注一个版本，再删除。
- **C6. `classifyError` 有副作用**（修改 `context.forcedRefreshAccountIds`），建议移到调用方。
- **C7. `abortableSleep` 中止后底层 `Bun.sleep` 计时器继续运行**（最长 60 秒）。
- **C8. `accounts-db.ts` 800 行混合四张表；无 `PRAGMA user_version`，迁移靠列探测；`tightenPermissions()` 在每个事务 `finally` 里执行 6 次同步系统调用，且 `chmodSync` EPERM 会掩盖已成功的 COMMIT。**

#### HTTP 兼容性

- **C9.** 已知路径方法不匹配返回 404 而非 405；`HEAD /health` 与 `OPTIONS` 一律 401；不容忍尾部斜杠。均无测试。
- **C10.** `auth-gate.ts` 在所有路由接受 `x-api-key`，而 `ARCHITECTURE.md:12` 说只有 Anthropic 路由；`Bearer ` 前缀大小写敏感；401 无 `WWW-Authenticate`。
- **C11.** Chat：`reasoning_effort` 缺 `none`/`minimal`；`n: 1` 被 adapter 拒绝；tool-only 完成返回 `content: ""` 而 OpenAI 是 `null`；429/503 无 `Retry-After`。
- **C12.** Anthropic：402 `quota_exhausted` 映射为 `invalid_request_error`；`handleReadiness` 把所有异常标为 `authentication_store_unavailable`；`count_tokens` 估算包含内部 `path` 字段。
- **C13.** Responses 非流式 `function_call` 缺 `status: "completed"`；`output_text` 缺 `logprobs: []`；`usage` 缺 `*_tokens_details`；无 `reasoning_summary_part.added/done`；SDK 无 stop reason，截断输出被当作正常完成（应文档化）。
- **C14.** `legacy-initial-input` 模式下 `session-affinity.ts:137-141` 不匹配无 `type` 的 user message item。

#### CLI 与配置

- **C15.** `accounts import --config <path>` 被解析但忽略（`main.ts:199-213`），`CONFIGURATION.md:16` 说的相反；`login --help` 报 `Unknown option`；`arguments.ts:6` 帮助文本 `serve` 行有字面 tab；`refresh-accounts.ts:52` 用 `account_maintenance_concurrency` 而服务端用 `quota_recheck_concurrency`。
- **C16.** `default_region` 是自由字符串（`RegionSchema` 已存在）；空字符串环境变量处理不一致；配置文件（含 `api_keys`）无权限检查；Windows 下配置在 `~/.config` 而 DB/锁/密钥在 `%APPDATA%`，文档只写了前者。
- **C17.** `accounts import` 用 `INSERT OR REPLACE` 无条件覆盖更新的本地凭据；device-code 轮询一次网络错误就整体失败且无每请求超时；回放 keyring 丢失时 24 小时内无法启动且无运维逃生口。

#### 仓库与文档

- **C18.** 8 个 `.gitkeep` 位于非空目录；`bunfig.toml` 为 0 字节；`__tests__/scaffold.test.ts` 是占位；`.oxfmtignore:8, 16` 有遗留协作注释；`.agents/`、`.codex/` 未忽略；`changelog/CHANGELOG-v0.x.md:77-80` 有多余模板尾巴；`release-please-config.json` 与锁文件 workspace 名仍是未加 scope 的 `kiro-provider`。
- **C19.** `build:npm` 的 shebang 去重 `replace` 在 Bun 1.3.14 下永不匹配；`@types/node ^20` 对 CI Node 24；`ci.yml` 无顶层 `permissions:`；无 Dependabot/Renovate、无 CodeQL；`engines.bun >= 1.3.0` 只测了 1.3.14；`make fmt-check` 依赖全局 `oxfmt` 但 README 未提。
- **C20.** README `:89-103` 仍是 RC.4 验收叙事；zh README `:510` 关于 `accounts.db` 的描述是 0.5 之前的语义；Quickstart `cp config.example.json` 对 bunx / 二进制用户不可用；`constants.ts:113-116` 注释引用不存在的 `src/plugin.ts`；`docs/audits/` 11 份 RC 验证日志更适合 `docs/history/`。
- **C21.** `scripts/smoke.ts` 三个请求全部打默认关闭的 `/v1/chat/completions`；`validate-local-auth-e2e.ts:21-23` 写死开发者机器路径；`security-check.sh` 内容扎实但只覆盖 legacy 端点。

## 3. 已验证无问题的部分

以下内容经逐项核对，无需重复检查：

- 所有 SQL 参数化；WAL + `busy_timeout`；每个多语句更新都在 `BEGIN IMMEDIATE` 内；generation CAS + tombstone 有跨连接测试；POSIX 下 WAL/SHM 继承主文件 0600。
- 推理回放：AES-256-GCM、每记录 96 位随机 nonce、AAD 绑定 tenant/model/account/conversation/fingerprint/expiry/key id、认证标签校验、`timingSafeEqual`、密钥文件原子创建 0600、密钥轮换有测试。
- 日志与 CLI 输出无 token / 密钥；`auditLog` 只输出 `auditHash`；`accounts list --json` 不含 token 字段。
- API key 用 `timingSafeEqual` 加长度守卫；Authorization 优先防止 x-api-key 绕过；tenant id 为带域前缀的 SHA-256；无代码路径记录请求头。
- 客户端断开传播链完整（`request.signal` → 组合信号 → pipeline `deadlineSignal` → SDK `abortSignal`），有集成测试；SDK 层重试受同一信号约束；流适配器 first-terminal-wins，`streamClosed` 守卫与 `runCleanupSteps` 防止重复 close/enqueue；Chat 与 Responses 编码器每次 `pull` 刷一帧。
- 会话亲和哈希包含 tenant、protocol、source；同 key 请求由 `acquireSessionQueue` 串行化；SQLite 存储按 TTL 与 `maxEntries` 修剪且保留刚写入的行。
- 应用层请求体上限在每个 chunk 上先于 `JSON.parse` 检查；空闲超时租约在读完 body 后才禁用；`host` 默认 `127.0.0.1`。
- `expires_in` 秒到毫秒换算、过期缓冲比较单位一致；两种模式下 refresh token 轮换都通过 CAS 原子持久化；未在任何地方禁用 TLS 校验；`proxy_url` 限定 http(s)。
- 默认启动顺序：先取单实例锁，再创建数据库、keyring、维护循环；SIGTERM/SIGINT 下 proper-lockfile 通过 signal-exit 正常释放锁。
- CI 引用的所有 Action 主版本 tag 均真实存在；发布流程对 draft-only 发布、prerelease npm dist-tag、dry-run、双触发去重处理正确。
- UTF-8 多字节跨 chunk 切分已处理；sequence number 从 0 单调递增；custom tool 指纹对 bridge 感知；lineage 指纹在捕获与回放两侧一致。

## 4. 修复优化方案

### Phase 0：进程存活与 reasoning 原子完成（1 至 2 天）

| # | 改动 | 涉及文件 | 验收 |
| --- | --- | --- | --- |
| 0.1 | A5：传入 `onCompromised`，审计日志后 `server.stop()` 排水并以非零码退出（fail-closed） | `src/server/single-instance.ts`、`src/server/app.ts` | 新测试：删除锁目录后进程在有限时间内受控退出、退出码非零、不继续接受新请求 |
| 0.2 | B15 最小修复：`responses.ts` 的 `reader.cancel` 改用 `boundedCleanup` | `src/server/routes/responses.ts` | 三路由行为一致；补客户端上传中途中止的测试 |
| 0.3 | A6：`includeEncryptedReasoning` 时推迟 reasoning `output_item.done` 到 `complete()` | `src/server/responses/sse-adapter.ts` | 新测试：reasoning + text + tool 时 `output_item.done` 含 `encrypted_content`，与 `response.completed` 一致 |
| 0.4 | A7：Anthropic 编码器镜像 Responses 的延后逻辑；redacted 前 `stopText()` | `src/server/anthropic/response-adapter.ts` | 新测试：reasoning→text→reasoning 与 redacted-after-text 的 block 顺序合法，signature 允许后到 |
| 0.5 | A8：每轮只给一个 reasoning item 附 token；request-adapter 把相邻 reasoning item 视为一组比对 | `sse-adapter.ts`、`responses/request-adapter.ts`、`history-builder.ts` | 新测试：回放 `[rs1, message, rs2, function_call]` 成功；单 item 场景回归不变 |
| 0.6 | B19：`Bun.serve` 增加 `development: false`、`maxRequestBodySize`、`error` 回调；注册 SIGTERM/SIGINT 调用 `server.stop()` 加排水超时与 `maintenance.stop()` | `src/server/app.ts`、`src/cli/main.ts` | `server-app.test.ts` 断言选项；可注入 process 对象断言调用顺序 |

### Phase 1：上游连接与刷新路径（约 1 周）

| # | 改动 | 涉及文件 | 验收 |
| --- | --- | --- | --- |
| 1.1 | A1：每次尝试独立 `AbortController`，`AbortSignal.any([...])` 传 SDK；`beginTerminal` 仅对异常结局 abort | `src/core/pipeline.ts`、`pipeline-stream.ts`、`pipeline-types.ts` | 新测试：真实 `NodeHttpHandler` 对本地 mock 服务，空闲超时 / 取消后 socket 被销毁；正常完成不触发 abort |
| 1.2 | A2 + A3 + A4 原子修复（见 2.2 节五点方案） | `src/core/token-refresher.ts`、`account-manager.ts`、`pipeline.ts` | 见 2.2 节验收列表；更新 `token-refresher.test.ts:250`、`pipeline.test.ts:1904` |
| 1.3 | B4：非流式 catch 按 `normalizeStreamFailure().disposition` 分支，malformed tool arguments 进入已有可恢复重试 | `pipeline.ts` | 新测试：非流式 `ToolCallViolation` 重试后成功；状态码统一 502 |
| 1.4 | B1 + B2：按 `error.code` 与状态码分类；502/503/504 同 500；补 socket 错误码；429 受 `maxRetries` 约束 | `src/core/error-classifier.ts` | 补 502/503/504、`ECONNREFUSED`、Smithy `TimeoutError`、429 达上限返回 429 的用例；更新 `error-classifier.test.ts:325` |
| 1.5 | B3：`accountCount` 改为可选账户数；无候选时若 `getMinWaitTime()` 在 deadline 内则等待 | `pipeline.ts`、`account-manager.ts` | 新测试："第二账户存在但限流"等待后成功 |
| 1.6 | B6：`recheckDueAccounts` 改为后台执行，或仅在无非耗尽候选时等待 | `pipeline.ts` | 用量端点挂起时请求延迟不增加 |
| 1.7 | B5：`isRefreshTokenDead` 只认 JSON 结构化 OIDC 错误 | `src/kiro/health.ts`、`token.ts` | 新测试：`HTTP_403 <html>` 判为瞬时 |
| 1.8 | B10：模型目录失败后退避窗口内把 stale 当 fresh，或后台刷新 | `src/kiro/model-capabilities.ts` | 连续失败时第二次请求不再等待超时 |
| 1.9 | B7 + B8 + B9：`maxAttempts: 1`；effort 在 `commandInput` 合并并删中间件；缓存驱逐 | `src/core/sdk-client.ts`、`pipeline.ts` | 现有 effort 测试迁移；账户移除后 transport 被 destroy |

### Phase 2：协议一致性、配置与 HTTP 层（1 至 2 周）

| # | 改动 | 验收 |
| --- | --- | --- |
| 2.1 | B22：流式 `complete()` 时无 signature 则以 `invalid_upstream_reasoning` 失败；输入侧拒绝空签名 | 流式与非流式同一输入同一结果；signature 后到的正常流不受影响 |
| 2.2 | B23 + B24：图片 base64 与 media type 在 adapter 层校验并抛 `RequestTransformError`；`tool_result` 缺 `content` 视为 `[]` | 400 而非 500；`anthropic-messages` 新用例 |
| 2.3 | B27：`message_delta.usage` 带真实 `input_tokens` | 合同文档同步 |
| 2.4 | B17：Anthropic SSE 编码器改为 pendingFrames/flushOne 背压 | 新增 `/v1/messages` 慢读者测试 |
| 2.5 | B16：异常分类——客户端断开 499 或放弃响应；客户端传输错误 400；服务端错误固定文案 + 关联 id | 更新 `server-app.test.ts:335-368`；三类各一用例 |
| 2.6 | B28 + B30 + C16：schema 补边界与 enum；空字符串环境变量视为未设；`.strict()` 或未知键告警；`default_region: RegionSchema` | `config.test.ts` 覆盖每个非法值 |
| 2.7 | B29：`log_level` 接入 `auditLog` 阈值过滤，或删除 | `log_level: "warn"` 时无 info 输出 |
| 2.8 | B18：单实例锁异步获取加重试，缩短 stale/update，错误信息带路径 | SIGKILL 模拟后 10 秒内重启成功 |
| 2.9 | B35 + C15：首次 `login` 拉取用量并去重；`import --config` 二选一；`login --help`；并发参数统一 | `cli.test.ts`、`import-accounts.test.ts` |
| 2.10 | B13 + B14：keyring `wx` 独占创建；`rowToAccount` 校验 region | 单元测试 |

### Phase 3：供应链与工程卫生（2 至 3 天，可并行）

1. B32：不带镜像重新生成 `bun.lock`；CI 加 `grep -c npmmirror bun.lock` 必须为 0 的门禁；`bunfig.toml` 写明 registry。
2. B33：`install.sh` / `install.ps1` 下载同 tag `SHA256SUMS` 并校验；README 文档化 `KIRO_PROVIDER_VERSION`。
3. B34 + C19：`release.yml` 固定 npm 版本；新增 macOS / Windows runner 下载产物执行 `--help`；`ci.yml` 加 `permissions: contents: read`；新增 `dependabot.yml` 与 CodeQL。
4. B31：`tsconfig.json` include 加入 `scripts`，修复 6 个类型错误。
5. C1：启用 Biome formatter，一次性格式化全仓；pre-commit 强制。
6. C18：清理 `.gitkeep`、空 `bunfig.toml`、`scaffold.test.ts`、`.oxfmtignore` 注释、`.agents/`/`.codex/` 忽略、changelog 尾巴、`build:npm` 死逻辑。
7. 依赖：评估 `zod` 4 与 TypeScript 7 升级；`@types/node` 对齐 CI Node 版本；`@smithy/node-http-handler` 精确锁定加注释或改 caret。

### Phase 4：结构性重构（按需，每项独立可合并）

1. C2：`executeLoop` 拆分为 `resolveBinding` / `selectAttemptAccount` / `runAttempt` / `applyClassification`。
2. B15 结构修复：抽取 `src/server/ingress.ts`：`createIngress`、`readJsonBody`（按协议参数化错误工厂）、`buildPipelineOptions`。
3. C3：共享工具历史校验器；`sdk-collector` 改为消费 transformer。
4. C4：合并 local / opencode-shared 重复。
5. C5 + C6 + C7：候选未使用代码先 `@deprecated` 一个版本再删；`classifyError` 去副作用；`abortableSleep` 清理计时器。
6. C8：`accounts-db.ts` 引入 `PRAGMA user_version` 有序迁移；`tightenPermissions` 改为打开时一次执行并容忍 EPERM。
7. C20：README 去 RC 叙事、zh 同步、Quickstart 适配 bunx 用户、Windows 路径、`docs/audits` 归档。

### 待取证清单（不进入实施计划，先补证据）

| 条目 | 需要的证据 | 取证方式 |
| --- | --- | --- |
| B12 | `getUsageLimits` 是否返回配额 reset 时间及字段名 | 真实账户调用并记录原始响应（脱敏后存为 fixture） |
| B20 | Kiro 对无参数工具是否发出 `input` 为空或缺失的 `toolUseEvent` | 声明一个无参数工具并触发调用，记录原始事件流 |
| B21 | Kiro 是否接受连续同角色历史条目；拒绝时的错误形态 | 用当前投影形态与 Kiro 原生形态各发一轮多工具并行调用，对比响应 |
| B25 | 带签名 thinking 跨 conversation 回放时 Kiro 是否验签失败 | 在新 conversationId 下回放上一会话的签名 thinking |
| B26 | `unknown_tool_alias` / `invalid_custom_tool_input` 在真实流量中的重试成功率 | 先拆出类型化错误码并记录审计事件，观察一段时间 |

## 5. 测试补齐清单

现有 896 个用例质量高，但以下高风险路径缺少覆盖；其中三处现有用例把缺陷固化为预期，需同步修改：

- 上游 HTTP 请求在空闲超时 / 取消时被真正中止（真实 `NodeHttpHandler`）；正常完成不触发 abort。
- 刷新失败 → 同 attempt 内故障切换与健康标记（更新 `pipeline.test.ts:1904-1931`）。
- 两个不同 generation 的并发刷新 + refresh token 轮换（更新 `token-refresher.test.ts:250-277`）。
- 首个调用方中止时 joiner 的刷新不受影响。
- 502/503/504、`ECONNREFUSED`、Smithy `TimeoutError`；429 受 `rate_limit_max_retries` 约束（更新 `error-classifier.test.ts:325`）。
- 非流式 `ToolCallViolation` / 内嵌错误 `SdkStreamProtocolError` 的状态码与重试。
- "第二账户存在但限流"的分类路径。
- 锁目录被删后受控退出；SIGKILL 后重启。
- reasoning `output_item.done` 在 text/tool 后仍携带 `encrypted_content`；Anthropic reasoning-after-text 与 signature 后到；双 reasoning item 回放。
- 图片 base64 无效 / media type 不支持的状态码；Anthropic `tool_result` 无 `content`。
- `/v1/messages` 慢读者；405 / HEAD / OPTIONS / 尾部斜杠；OpenAI 路由上的 `x-api-key`；Anthropic 信封的 413 / 504 / 499。
- 配置每个数值字段的非法值；空字符串环境变量；未知键。
- `usage-client` 的 429 / 5xx / 超时；`token-network` 的 `expires_in` 换算与 3600 默认。
- `accounts-db` 删除账户时 `output_lineage` / `reasoning_replay` 级联清理。

## 6. 审查方法与修订说明

- 五个模块（核心调度、HTTP 服务层、协议适配与转换、认证存储与 Kiro 客户端、配置 CLI 构建 CI 文档）由并行审查各自通读全部源码与对应测试，输出带行号的发现。
- 主审对全部 P0 与 P1 高结论回读源码逐条核实；对 A5、A6、A7、A8、B15、B20、B21、B23、B28 等在 Bun 1.3.14 下用探针脚本复现；探针脚本位于 `/tmp` 且已删除。
- 修订版 2 依据外部复核意见调整了分级、场景范围与修复边界；复核意见确认 `typecheck`、`lint`、`896 pass` 基线，独立复现了 B31 的 6 个类型错误与 B32 的 34 个镜像 URL。
- 依赖上游 Kiro 行为的结论统一列入第 4 节"待取证清单"，取得证据前不作为实施依据或发布门禁。
