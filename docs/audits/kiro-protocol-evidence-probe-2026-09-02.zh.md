# Kiro 协议取证探针（2026-09-02）

针对 [全面代码审视报告](kiro-provider-full-code-review-2026-09-02.zh.md) 第 4 节"待取证清单"中的 B12、B20、B21、B25 四项，用真实 Kiro 账户做了小流量探针。B26 需要生产流量统计，本次只落地类型化错误码，不在此文范围。

## 结论

| 条目 | 结论 | 对实现的影响 |
| --- | --- | --- |
| B12 | `getUsageLimits` 返回顶层 `nextDateReset`（epoch 秒）、`daysUntilReset`，`usageBreakdownList[i].nextDateReset` 亦存在 | 解析 `nextDateReset` 进入用量快照，配额耗尽后的复查时间取 `max(resetAt, lastSync + interval)`，并保留每日兜底探测 |
| B20 | 零参数工具的 `toolUseEvent` 完全不带 `input` 键（首帧与 `stop: true` 帧均无），不是 `""` 也不是 `"{}"` | 运行时在"从未收到 input 且已 stop"时把参数视为 `{}`；空白或不完整片段仍判 `malformed_upstream_tool_arguments`；删除适配层不可达的 `""→"{}"` 归一化 |
| B21 | 当前拆分投影（连续多条 assistant 条目分别携带 toolUses、toolResults 拆到两条 user 条目）与 Kiro 原生形态一样返回 200 且精确回显两个标记 | 不需要合并 item；保持 never-merge 投影；在 PROTOCOL_COMPATIBILITY 记录证据 |
| B25 | Kiro 自身校验 thinking 签名：篡改签名 → 400 `ValidationException: Invalid signature in thinking block`；有效签名在同会话、新会话、**另一账户 + 新会话**下均被接受；完全省略 reasoning 块也被接受 | `anthropic-direct` 回放不再要求已有账户/会话绑定；上游 400 签名错误映射为客户端 400 `invalid_reasoning_signature`，不重试、不切换账户 |

## 环境

- 日期：2026-09-02（Asia/Shanghai）
- 认证：本地 `~/.config/kiro-provider/accounts.db`，只读打开，选取用量最低且 access token 剩余有效期 ≥ 10 分钟的健康账户；B25 跨账户探针另取第二个账户。探针不写库、不刷新 token。
- 区域：`us-east-1`；模型：`claude-sonnet-5`（wire id 同名）；B25 附加 `additionalModelRequestFields.output_config.effort = "high"`
- SDK：`@aws/codewhisperer-streaming-client` 1.0.45，运行时端点 `runtime.us-east-1.kiro.dev`
- 命令：
  - `bun run scripts/probe-evidence.ts --out /tmp/kiro-evidence.json`
  - `bun run scripts/probe-evidence.ts --only b25 --effort high --out /tmp/kiro-evidence-b25.json`
- 请求量：1 次 `getUsageLimits`，19 次 `generateAssistantResponse`，分布在 2 个账户
- 脱敏：探针不打印 access token、refresh token、client secret 或原始签名；签名只输出 SHA-256 前 16 位；用量响应中的 email、ARN、id 字段以长度占位

## B12：用量接口的 reset 字段

`GET https://q.us-east-1.amazonaws.com/getUsageLimits?isEmailRequired=true&origin=AI_EDITOR&resourceType=AGENTIC_REQUEST&profileArn=…` 返回 HTTP 200，顶层键：

```
daysUntilReset, limits, nextDateReset, overageConfiguration,
subscriptionInfo, totalUsage, usageBreakdown, usageBreakdownList, userInfo
```

与重置相关的字段：

| 路径 | 值 | 说明 |
| --- | --- | --- |
| `$.nextDateReset` | `1790812800` | epoch 秒，即 2026-10-01T00:00:00Z |
| `$.daysUntilReset` | `0` | 与 `nextDateReset` 不一致，不可单独依赖 |
| `$.usageBreakdownList[0].nextDateReset` | `1790812800` | 与顶层一致 |

当前 `src/kiro/usage-client.ts` 的 schema 只解析 `currentUsage/usageLimit/currentOverages/freeTrialInfo/userInfo`，`nextDateReset` 被 `passthrough` 丢弃。实现时以顶层 `nextDateReset` 为准，缺失时回退到 `usageBreakdownList` 中的最小值，均缺失时保持现有固定间隔；`daysUntilReset` 只作参考不作调度依据。

## B20：零参数工具的事件形态

工具声明：

```json
{
  "toolSpecification": {
    "name": "get_probe_time",
    "description": "Returns the current probe time. Takes no parameters.",
    "inputSchema": { "json": { "type": "object", "properties": {}, "additionalProperties": false } }
  }
}
```

提示："Call the get_probe_time tool now. Do not answer in text." 返回 HTTP 200，事件序列：

| 序号 | 事件 | 关键字段 |
| --- | ---: | --- |
| 1 | `reasoningContentEvent` | `text` 0 字节，`signature` 416 字符 |
| 2 | `toolUseEvent` | `toolUseId`、`name` 存在；`"input" in event === false` |
| 3 | `toolUseEvent` | `toolUseId`、`name`、`stop: true`；`"input" in event === false` |
| 4 | `metadataEvent` / `contextUsageEvent` / `meteringEvent` | 常规收尾 |

对照：B25 中带参数的调用 `probe_tool_sig({marker:"S"})` 收到两个 input 片段 `{"marker": "` 与 `S"}`，再收到 `stop: true` 帧。因此"从未收到 input 键"是零参数调用的确定形态，可安全归一化为 `{}`；而"收到片段但无法解析"仍应作为损坏参数处理。

## B21：连续同角色工具历史

工具 `probe_tool_a`、`probe_tool_b` 各接受 `{marker}`；首轮 user 提示要求两个都调用并原样重复两个工具结果。三种历史形态均在新 conversationId 下发送，当前消息为工具结果：

| 形态 | history | currentMessage | HTTP | 回复 |
| --- | --- | --- | ---: | --- |
| 原生 | `U`, `A{content, toolUses:[a,b]}` | `U{toolResults:[ra, rb]}` | 200 | `RESULT_A_7F3C RESULT_B_9E1D` |
| 当前拆分投影 | `U`, `A{content}`, `A{toolUses:[a]}`, `A{toolUses:[b]}`, `U{toolResults:[ra]}` | `U{toolResults:[rb]}` | 200 | `RESULT_A_7F3C RESULT_B_9E1D` |
| 拆分调用 + 合并结果 | `U`, `A{content}`, `A{toolUses:[a]}`, `A{toolUses:[b]}` | `U{toolResults:[ra, rb]}` | 200 | `RESULT_A_7F3C RESULT_B_9E1D` |

三种形态都被接受且模型能正确关联两个工具结果。审计报告 B21 担心的"Kiro 拒绝或错配"没有发生，因此不实施合并方案，避免破坏 item 顺序、签名指纹与回放语义。

## B25：thinking 签名回放

首轮为工具调用（Claude 在工具调用轮次会产生签名、文本为空的 `reasoningContentEvent`）：`probe_tool_sig({marker:"S"})`，签名 372 字符，`text` 0 字节。随后把 `A{content:"", reasoningContent:{reasoningText:{text:"", signature}}, toolUses:[…]}` 放入 history，当前消息为工具结果 `RESULT_S_3C9A`：

| 回放场景 | conversationId | 账户 | 签名 | HTTP | 回复 |
| --- | --- | --- | --- | ---: | --- |
| 同会话 | 同首轮 | 同首轮 | 有效 | 200 | `RESULT_S_3C9A` |
| 新会话 | 新 UUID | 同首轮 | 有效 | 200 | `RESULT_S_3C9A` |
| 同会话 | 同首轮 | 同首轮 | 末 4 字符篡改 | 400 | `ValidationException: messages.1.content.0: Invalid \`signature\` in \`thinking\` block` |
| 同会话，省略 reasoning 块 | 同首轮 | 同首轮 | 无 | 200 | `RESULT_S_3C9A` |
| 新会话 | 新 UUID | **第二个账户** | 有效 | 200 | `RESULT_S_3C9A` |

结论：

1. Kiro 在服务端校验签名完整性，错误路径为同步 400 `ValidationException`，不是流内错误。
2. 签名不绑定 conversationId，也不绑定账户（至少同区域内）。因此 `anthropic-direct` 回放不需要 `resolveOutputLineage` 命中，也不需要把请求锁定到特定账户；审计报告 B25 提出的"24 小时后必现 400"问题通过取消绑定要求即可消除，无需静默换会话的降级。
3. 篡改签名的 400 应映射为客户端 400 `invalid_reasoning_signature`，不重试、不切换账户、不标记账户健康状态。
4. 省略 reasoning 块被接受，说明客户端在拿到上述 400 后丢弃 thinking 块重发是可行的恢复路径，但这是客户端决策，网关不做静默降级。

## 复现

```bash
bun run scripts/probe-evidence.ts --out /tmp/kiro-evidence.json
bun run scripts/probe-evidence.ts --only b25 --effort high --out /tmp/kiro-evidence-b25.json
```

脚本只读取本地账户库，选取用量最低的健康账户，不写库、不刷新 token，不打印凭据与原始签名。
