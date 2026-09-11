# 验证证据索引

所有模型输入均为合成任务。没有提交账号库、配置密钥、Authorization、原始加密 token 或完整客户端上下文。SDK trace 中的 token 只保留类型、长度与 SHA-256；reasoning 文本只保留长度。

| 文件 | 用途 |
| --- | --- |
| `validation.json` | 代码、构建、客户端版本和各项门禁结果 |
| `sdk-acceptance.json` | 最终 38 个官方 SDK 案例，含请求、响应、usage 与语义断言 |
| `sdk-strict.json` | 五个模型的 strict 正常请求与精确拒绝 |
| `clients-acceptance.json` | Codex/Zuno 工具、账本计算、失败恢复、Plan、effort 和 token 回放计数 |
| `client-binaries.json` | 使用的客户端二进制 SHA-256 |
| `sdk-baseline-final.json` | v3.0.1 的请求、历史和 SDK helper 字段失败对照 |
| `sdk-baseline-tools.json` | v3.0.1 的 namespace/custom 工具失败对照 |
| `sdk-before-opaque-fix.json` | Sol opaque 工具续接失败时的完整 SDK trace |
| `sdk-pinned-fixed-1.json` 至 `sdk-pinned-fixed-3.json` | 固定原失败账号，三轮 JSON/SSE 工具往返 |
| `exact-wire-replay-control.json` | 同账号保留 opaque 原值的 wire 回放对照；生产修复使用保留 token 的路径 |
| `direct-native-stream-control.json` | 直连 Kiro 的普通 function JSON/SSE 正常对照 |
| `restart-sdk.json` | 清除亲和缓存、重启服务后的 native opaque / kr1 恢复 |
| `full-matrix-experimental.json` | 51 个初始能力案例，47 通过，四个指令优先级失败保留 |
| `full-matrix-stream.json` | 30 个 SSE namespace/custom 案例 |
| `original-audit-observations.json` | 原审查的 23 条观察 |
| `audit-baseline-contract.json` / `audit-candidate-contract.json` | 修正正常流对照形状、关闭重试后，两端同条件复测 23 条观察 |
| `sdk-initial-observations.json` | 初次 SDK 测试记录，保留后来修正的探针假设与文风观察 |
| `sdk-build-c01bef1.json` | 38 项 SDK 与 12 项客户端矩阵使用的实现/二进制身份 |
| `candidate-build.json` | 最终代码构建与重启验证使用的二进制身份 |

最终源码与 SDK 矩阵代码之间只增加了查询未知输出形状时的防护。该防护有回归测试；新构建另外通过了真实 SDK 的重启续接验证。详细解释和前后调用示例见[实测对照报告](../../kiro-provider-responses-before-after-2026-09-10.zh.md)。
