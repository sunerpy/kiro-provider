# Zuno 接入 kiro-provider v0.5.0 流错误恢复说明

本文是提供给 Zuno 的正式接入说明。适用 Provider 版本为
`kiro-provider v0.5.0` 及以后版本。

## 1. 问题与修复边界

SSE 响应开始后，HTTP 状态和响应头已经发送。后续上游流故障只能通过终止事件
表达，因此 Zuno 看到 `status=None` 是正常现象，不能单独据此判定为不可恢复。

Provider v0.5.0 不再把所有流故障压缩成通用
`code="upstream_error"`，而是保留可恢复流故障与不可恢复协议故障的结构化
错误码。Provider 不会在已经输出 SSE 字节后自行重试，以避免重复文本或重复
执行工具；attempt 级重试属于 Zuno。

2026-08-29 18:05 的现场异常是 SDK 顶层 `TypeError`，对应
`upstream_stream_error`。只有流干净 EOF、但缺少 token usage 或有效
`meteringEvent` 完成凭证时，才对应 `upstream_stream_incomplete`。

## 2. Responses 终止事件

可恢复流截断示例：

```json
{
  "type": "response.failed",
  "response": {
    "status": "failed",
    "error": {
      "code": "upstream_stream_incomplete",
      "message": "Upstream stream ended before completion"
    }
  }
}
```

Zuno 必须读取 `response.failed.response.error.code`，不要解析英文错误文本。

## 3. 错误分类

### 可恢复

| code | 含义 |
| --- | --- |
| `upstream_stream_error` | SDK reader、decoder、transport 或上游嵌入错误终止流 |
| `upstream_stream_incomplete` | 流结束但没有权威完成凭证 |
| `upstream_stream_idle_timeout` | 上游事件空闲超时 |
| `request_deadline_exceeded` | Provider 请求截止时间先到 |

### 不可机械重试

- `upstream_protocol_error`
- `upstream_invalid_state`
- `unsupported_upstream_event`
- `invalid_upstream_reasoning`
- `invalid_upstream_tool_call`
- `incomplete_upstream_tool_call`
- `missing_upstream_stream`

旧版本通用 `upstream_error` 曾混合上述两类故障，迁移期间不得把它全局声明为
可重试。

## 4. Zuno 最小代码改动

当前分类入口：

```text
crates/zuno-provider-compatible/src/stream.rs::classify
```

在现有 generic fatal fallback 之前，优先按结构化 code 分类：

```rust
if matches!(
    error.code_str(),
    Some(
        "upstream_stream_error"
            | "upstream_stream_incomplete"
            | "upstream_stream_idle_timeout"
            | "request_deadline_exceeded"
    )
) {
    return ProviderError::Transient {
        status: None,
        source: Some(Box::new(ReportedWireError::new(provider, error))),
    };
}
```

这样 `ProviderError::recovery()` 会返回 `Recovery::Retry { after: None }`。
协议错误不加入该集合，继续进入 `ProviderError::Fatal`。

## 5. attempt 与持久化要求

只修改 `Fatal`/`Transient` 分类仍不完整。Zuno 的重试调度还必须满足：

1. 先持久化失败 attempt、结构化错误码和已收到部分输出的事实；
2. 重试创建新的 attempt 记录；
3. 新 attempt 的输出替换失败 attempt 的部分输出，不能拼接；
4. 重发原始 turn，并复用原 session-affinity key；
5. 不把失败流中的部分 assistant 文本加入下一次 conversation history；
6. 默认最多三次总尝试，可采用约 `0.5s`、`1.5s` 的指数退避并加入 jitter；
7. 所有重试受 turn 的整体 deadline 约束；
8. 工具副作用已经发出时，除非存在 idempotency key 或等价去重保证，否则
   不自动重试。

## 6. 必须增加的测试

在 `crates/zuno-provider-compatible/src/stream.rs` 的现有结构化错误测试附近增加：

- 四个可恢复 code 分别得到 `Recovery::Retry { after: None }`；
- `upstream_protocol_error`、`invalid_upstream_tool_call`、
  `invalid_upstream_reasoning` 分别得到 `Recovery::Fail`；
- `code="upstream_error"` 不被新规则误判为可恢复。

引擎集成测试还应注入一次“先输出部分文本、再
`upstream_stream_incomplete`、第二 attempt 成功”的场景，并验证：

- 数据库存在两个 attempt；
- 第一个 attempt 标记失败且保留错误码；
- 最终用户可见输出只来自第二个 attempt；
- 账号和 Kiro conversation 亲和键保持不变；
- 不发生重复工具副作用。

另注入一个 `invalid_upstream_tool_call`，确认不创建重试 attempt。

## 7. 发布顺序与验收

1. 先部署 `kiro-provider v0.5.0`；
2. 再发布 Zuno 的结构化错误分类与 attempt 重试改动；
3. 分别注入一个可恢复流错误和一个致命协议错误；
4. 核对退避、attempt 记录、部分输出替换、会话亲和和工具幂等；
5. 保留 Zuno 现有 `legacy-user-prefix`、`maxTokens: null` 与旧 Chat 关闭策略。

Provider 的完整跨协议定义见
[STREAM_ERROR_CONTRACT.md](STREAM_ERROR_CONTRACT.md)。本次 Provider 正式版
不修改 Zuno 仓库、配置或数据库。

## 8. Provider v0.5.0 发布门禁

stream 实现合并到主工作区后执行的源码门禁：

- `make ci`：`891 pass / 0 fail`；
- `make coverage-gate`：`13775/14720 = 93.58%`，高于 `93%` 门槛；
- `make fmt-check`：通过；
- `make coverage-parity`：通过；
- `make security`：`7/7` 通过；
- `make codex-smoke-security`：通过；
- `bun run build`、`bun run build:binary`、`bun run build:npm`：全部通过；
- CodeGraph：`173` files、`2677` nodes、`10847` edges，无待同步文件。

受限沙箱内的 Bun 临时端口测试会统一返回 `EADDRINUSE`；同一主工作区、同一
提交在正常本机网络命名空间原样重跑后为上述 `891/891` 全部通过。该现象是
测试执行环境限制，不是 Provider 端口竞争或产品回归。
