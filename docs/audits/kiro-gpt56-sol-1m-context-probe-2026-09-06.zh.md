# Kiro GPT-5.6 Sol 1M 上下文探测

日期：2026-09-06（Asia/Shanghai）

## 结论

KiroRuntime 中的 `gpt-5.6-sol` 已支持 1,000,000 token 总上下文：

- 最大 prompt：872,000 tokens
- 最大 output：128,000 tokens
- 总窗口：1,000,000 tokens

Kiro 管理模型目录仍返回旧的 `maxInputTokens=272000` 和 “272k context
window” 描述，因此不能把该目录值视为当前运行时上限。

## 方法

- 使用 kiro-provider v3.0.0 原生 `/v1/responses` SSE 通道。
- 请求内容全部为合成文本，不包含用户正文。
- 先用 1,000/2,000 个固定 filler 校准：每个 filler 恰好计为一个 input
  token，固定请求开销为 66 tokens。
- 每个长输入在首尾放置独立随机 marker；只有响应同时准确返回两个 marker
  且 terminal 为 `response.completed`，才判定内容保真。
- `reasoning.effort=low`、`truncation=disabled`。

## 结果

| 客户端 input tokens | 重复 | 结果 |
|---:|---:|---|
| 300,001 | 1 | 成功，首尾 marker 可见 |
| 600,000 | 1 | 成功，首尾 marker 可见 |
| 800,000 | 1 | 成功，首尾 marker 可见 |
| 828,000 | 2 | 2/2 成功，首尾 marker 可见 |
| 871,850 | 2 | 2/2 成功，首尾 marker 可见 |
| 871,860 | 3 | 3/3 `invalid_prompt` |
| 900,000 | 2 | 2/2 `invalid_prompt` |

871,860 的三次错误分别报告 prompt token 为 872,001、872,001 和
872,002，错误中明确给出 `model maximum (872000)`。

客户端输入之外，Kiro 还会加入约 140 tokens 的隐藏提示。对当前请求形状，
871,850 是重复验证通过的安全输入值；一般客户端仍应保留更多余量。

## 超时结论

- provider 的 `request_timeout_ms=900000`（15 分钟）足够覆盖本轮请求。
- native Responses 在路由入口禁用了 Bun request idle timeout，因此
  `stream_idle_timeout_ms=300000` 不是本轮瓶颈。
- 990k 非流式请求约 90 秒后收到 KiroRuntime HTTP 500；同类大输入应使用
  SSE。该 90 秒错误来自上游，放大本地 timeout 无法修复。

## Provider 修复

- 静态 `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna` prompt
  limit 统一更新为 872,000。
- 仅当管理目录仍返回已知旧组合 `272000/128000` 时，动态目录纠正为
  `872000/128000` 并标明 1M total context。
- Sol 的数值来自本报告实测；Terra/Luna 按产品发布决策与同代 GPT-5.6
  家族保持一致，尚未分别执行长上下文探针。
