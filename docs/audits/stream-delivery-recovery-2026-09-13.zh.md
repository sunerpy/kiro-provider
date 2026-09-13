# 流交付、失败因果链和 KiroRuntime 解码修复验收

## 结论与边界

基线为 `v3.1.0 / 5c376b00a19cc06a78bdcb8b83926ad05c45212b`，对照 Codex `9ba1d9eb5bbbd87ba2fc528d91ad239eea975ee9` 的 HTTP 流交付边界。修改仅在 Kiro Provider。

已修复上游持续产生工具参数时下游响应头和参数仍被缓冲的问题，以及先有上游错误、后预算到期时的错误证据丢失。真实 Chat 验收另复现了 KiroRuntime RPC 首帧使用 REST JSON 解码的缺陷，现已通过 SDK 原生 RPC codec 修复。

| 路径 | 本轮真实结果 | 能说明什么 |
| --- | --- | --- |
| Responses stateless，五个模型，function 工具及完整输出回放 | 15/15，每模型重复三次 | 参数、事件、结果回传和历史语义正确 |
| Responses stateless，namespace / custom | 2/2 | 公开工具身份、完整字符串和转义恢复正确 |
| SDK 接纳后取消 | 1/1 | 停止消费并释放 Provider 请求，无替代派发 |
| Chat KiroRuntime Generate，Sol / Opus | 6/6，每模型重复三次 | RPC 首帧、工具增量与工具结果续接正确 |
| Chat KiroRuntime Generate，Sonnet / Terra / Luna | 3/3，每模型一次 | 对应模型的路径可用，不宣称完成三次重复 |
| Chat 普通短回答，Sol / Opus 的默认与 max effort | 4/4 | 角色帧和成功终态各一次 |
| Zuno 0.10.37，Sol / Opus | 6/6，每模型三次 | 原 Responses 客户端能消费响应，每轮只派发一次、无工具执行 |
| Native `/v1/responses` CreateResponse，五模型对照 | 5 次均 HTTP 403 | 当前账户条件未获授权；**不能作为 native 生成通过或模型不支持的证据** |
| GPT 显式输出上限 2,048 | HTTP 400 `unsupported_output_token_limit` | 既有能力门禁仍有效，没有静默删除上限 |

Native CreateResponse 与 KiroRuntime Generate 是不同操作。RPC 解码修复不解除 CreateResponse 权限；本批没有放开未经验证的 native 能力，也没有通过更换模型宣称原路径成功。

## 修复前后

### 1. 工具片段与响应头

匿名化历史样本有 924 个 `toolUseEvent`，但 `canonical_event_count=1`、`tool_count=0`、工具意图未闭合，最终客户端取消。它支持交付边界有问题，不能证明远端模型本来能成功闭合调用。

复现使用真实 loopback HTTP、AWS 二进制 EventStream 和实际 SDK：先发送部分工具参数，故意不发送 stop/完成凭证，等待客户端观测。

| 断言 | 修复前 | 修复后 |
| --- | --- | --- |
| Responses / Chat 在调用未闭合时收到响应头 | 两项失败，250 ms 观察窗口仍阻塞 | 两项通过，完成数据尚未由假上游发送 |
| 已有文本之后继续收到工具参数增量 | 两项失败，仍等整个工具结束 | 两项通过，参数逐段可见 |
| 相同输入补齐 stop 和 metering 后能正常完成 | 原控制通过 | 保持通过，参数逐字节一致 |
| 只有真实 HTTP 接纳、还没有任何 SDK 帧 | 旧 SDK `send()` 等首帧 | 独立 Node 上游证明可以先交付头，取消关闭 peer socket，随后同账户请求可执行 |

代码入口：`sendAcceptedStream`、`prefetchStreamStart`、`transformSdkOutputStream`、Responses SSE adapter 和 Chat adapter。生命周期只能证明连接已接纳；`tool_count` 直到完整校验后才计入，部分参数不能执行。

例如完整工具参数是：

```json
{
  "marker": "STREAM_fixture",
  "payload": "中文 \"quote\" \\backslash\nsecond line"
}
```

修复前这些参数只在全部完成后交付。修复后先出现稳定的 item/call 身份及 arguments deltas，拼接结果必须与最终 arguments 完全一致。测试显式提供 `{"value":41}`，再把**完整原始 response.output**连同工具结果放入下一轮，必须得到 `ACK:STREAM_fixture:41`，并且不能再次调用工具。探针不执行任何工具。

### 2. 半截参数和错误结束

| 输入/上游行为 | 修复后要求 |
| --- | --- |
| 参数持续增长但不停止 | 原始活动刷新 idle；总 deadline 仍终止；没有工具 done 或成功终态 |
| 真正没有上游活动 | `upstream_stream_idle_timeout`，与总预算取消明确区分 |
| 畸形 JSON、孤立 Unicode surrogate、缺少 stop/整体凭证 | 类型化失败，不修补成 `{}` |
| 累计参数/身份超过现有 body budget | `upstream_tool_arguments_too_large` |
| 参数不符合声明 schema | `upstream_tool_schema_violation`，不改写输入 |
| 未声明工具或 `tool_choice:none` 却调用工具 | 在交付该身份前拒绝 |
| Native 身份/索引变化、重复 done、最终参数与 deltas 不一致 | 失败，不透传成完整调用 |
| 已接纳流随后 EOF、SDK 错误或仅 `[DONE]` | 一次明确失败；不重放整次生成 |

已有非流式收集的有界替代策略保留。原来等待“首个完整语义产物”的流重试测试已改为接纳边界测试，同时保留非流式正常对照、取消、慢消费者、终态竞争和账户释放检查。

### 3. 先 503，后 deadline

旧回归只剩最终超时，先前 SDK 503 与请求身份丢失。修复后同一客户端错误保留：

```json
{
  "request_id": "req_fixture",
  "details": {
    "cancel_source": "request_deadline",
    "first_failure": {
      "upstream_status": 503,
      "upstream_code": "ServiceUnavailableException",
      "upstream_request_id": "upstream_fixture"
    },
    "last_failure": {
      "upstream_status": 503,
      "upstream_request_id": "upstream_fixture"
    }
  }
}
```

这是测试字段节选。发布前返回 JSON 504，发布后使用流失败；HTTP 状态不能在 SSE 中途改变。Native error event 的来源也贯穿终止包装器，首末错误不会被本地包装码覆盖。日志只保存脱敏计数、代码、身份关联和消息哈希。

CI 的 CodeQL 检出了脱敏正则在连续未闭合 `{` 上的回溯风险；现改成线性索引截取，并覆盖十万字符对抗输入。Native Content-Type 也改为精确 MIME 校验，真实 `incomplete` 工具终态保留上游原因，不能升级为成功。

`Retry-After` 缺省、数值、小数秒、HTTP 日期分别测试；真实权限 403 不再触发无意义的强制刷新。5xx 遵守已有共享重试预算，最终保留实际状态。

### 4. 验收期间发现的 RPC 首帧问题

真实 Chat 的四个普通对照均先获得 HTTP 200，再因 SDK `TypeError` 失败，尚无 decoded event。原因是 `attachKiroRuntimeRequest` 改写了请求操作，但缓存客户端仍用 `AwsRestJsonProtocol`。KiroRuntime 的合法 `initial-response` 需要 RPC 的 `initialResponseContainer`。

使用固定初始元数据的网络回归先复现失败，再选择 SDK 自带 `AwsJson1_0Protocol`，并在缓存键中区分 RPC/REST。没有修改 node_modules、丢弃未知事件或伪造完成。已有请求字段、工具片段及正常 REST 对照保持正确。独立固定 `@aws-sdk/core` 为锁文件已有的 3.975.3；未升级其他 SDK 依赖。

修复后四个普通 Chat 对照全部通过，另有九组真实工具/结果往返通过。详见 `chat-before-rpc.json`、`chat-after-rpc.json` 和两个 Chat 工具矩阵。

## 真实延迟、reasoning 与 Zuno 工作流

每模型三次 Responses function 首轮的客户端观测中位数：

| 模型 | 响应头 ms | 首个工具参数增量 ms | 工具 done ms |
| --- | ---: | ---: | ---: |
| Sol | 2,466 | 2,657 | 3,088 |
| Opus 5 | 2,552 | 3,476 | 3,797 |
| Sonnet 5 | 3,980 | 4,744 | 4,908 |
| Terra | 2,722 | 2,723 | 2,891 |
| Luna | 2,847 | 2,966 | 3,149 |

这些小样本不是性能基准。严格的“未闭合也交付”由可控制的网络回归证明，不用真机总耗时推断因果，也不宣称修复了远端推理或生成长尾。

17 组 Responses 工具往返中有 11 组实际携带 `kr1_`；所有必需的账号回放绑定均保持一致。原请求与两次 SDK 派发的 effort 都是 `max`。不把 GPT 可见 reasoning 为空判为失败，也不以短 summary 或模型偶尔符合 schema 证明上游推理/strict 约束已生效。

Zuno 使用原 `kiro-local` 定义和 profile 副本，所有可写路径均落入隔离目录；工具/学习关闭，代理拒绝每个用例的第二条生成请求。六次均只发送一条请求、`tools=0`，没有工具 dispatcher 事件，也没有自动后续轮。

首个 Sol 用例在 3,679 ms 收到头、3,682 ms 收到首增量，约 61.2 秒才收到完整终态。它表明长尾可以继续存在，同时连接交付和可消费进展已经发生；不能把 61 秒全部归为响应头等待。

## 验证与操作说明

证据目录：[stream-delivery-2026-09-13](evidence/stream-delivery-2026-09-13/README.md)。原始请求身份替换为稳定的 probe 编号；不提交账号库、令牌、私有 reasoning、原始用户请求和实际业务会话。源证据文件保留 SHA-256。

最终本地结果为 **1,695 pass / 0 fail**，覆盖率 **19,906 / 21,213 = 93.84%**，未降低 93% 门槛。typecheck、lint/格式、脚本语法、覆盖率口径校验、安全 7 项、Codex smoke 安全自测、Bun JS/npm/二进制构建均通过。最终精确提交的 CI 和发布产物身份在 PR/发布记录中，避免把中间构建冒充正式包。

可重跑的真实 SDK 探针：

```bash
bun run scripts/probe-stream-delivery.ts --confirm \
  --config /path/to/isolated/kiro-provider/config.json \
  --endpoint http://127.0.0.1:18791/v1 --out /private/responses.json
bun run scripts/probe-stream-delivery.ts --confirm --chat-only \
  --config /path/to/isolated/kiro-provider/config.json \
  --endpoint http://127.0.0.1:18791/v1 --out /private/chat.json
```

没有新配置项或数据库 DDL。`request_timeout_ms`、`stream_idle_timeout_ms`、模型、reasoning、存储和回放 TTL 默认值不变；`stream_max_attempts` / `retry_empty_completion` 的作用域明确为非流式替代。`max_request_body_bytes` 复用于工具累计输出预算。生产 Chat 关闭开关保持原值，真实 Chat 验收只在隔离副本开启。

发布后本地替换须先保留旧二进制、配置、replay keyring 和一致账号库快照，校验公开资产 SHA-256 后再切换 Provider 服务。回滚使用这套匹配备份；不回滚 Zuno、业务项目或无关进程。重新验证版本、运行 PID/可执行文件、SDK 请求和隔离 Zuno 请求，并保留正式 tag、CI、资产和安装字节的对应关系。
