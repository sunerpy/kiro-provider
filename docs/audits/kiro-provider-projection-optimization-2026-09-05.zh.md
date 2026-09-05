# 请求投影优化与研究工具

日期：2026-09-05

状态：实现候选。静态、单元、集成门禁与首个真实保真决策记录如下。

## 已确认缺陷与修复

Provider matrix 中的失败属于新的请求形态错误：旧
`legacy-user-prefix` 把尾部调和指令移到先前 assistant 结果之前，并向 Kiro
发送空 current user。

候选现在：

- 开头/中间指令仍在首个 user 边界迁移；
- 连续尾部指令保留在 current boundary；
- 当前 tool result、image、document 不移动；
- assistant 历史之后创建非空 synthetic user；
- 真正以 assistant 结束的请求返回 `missing_current_input`；
- 任意非空文本字节（包括纯空白）均属于输入；
- 空内容的结构化 tool result 仍有效；
- 空 text part 与结构化输入并存时不添加多余分隔符。

Responses 与 Chat 保留 OpenAI 兼容的 `code` 和 `param`；Anthropic Messages
转换为原生 `invalid_request_error`。被拒绝的请求不会创建 SDK client。

## 不含正文的请求关联

每个公开请求生成一个随机 `request_id`，贯穿：

1. `request_shape`；
2. `request_projection_completed`；
3. `request_history_built`；
4. 每次真实 `sdk_dispatch_started`；
5. completion witness；
6. `sdk_stream_terminal`。

`attempt` 只计算真实 SDK send。新增字段全部是计数、枚举、长度或哈希，不记录
请求正文、工具名称/参数、签名或凭据。

## 研究工具

- `scripts/probe-projection-fidelity.ts` 生成 native context 与
  legacy-current-boundary 的受控矩阵。默认真实运行 400 个请求，必须显式
  `--confirm`；`--dry` 不消耗额度。
- `scripts/effort-study.ts` 生成固定 72-cell max/xhigh AB/BA 计划，并直接从
  `request_id`、`sdk_dispatch_started` 和 terminal 事件分析结果。
- `scripts/responses-effort-study.ts` 通过标准 OpenAI Responses 路由串行执行
  同一套 72-cell 计划，并使用六个可机器评分的合成 implementation/debugging
  任务；这是不依赖 Zuno 的主要 effort 门禁。
- `scripts/kiro-cli-wire-diff.ts` 对 Kiro CLI/IDE 与 provider command dump
  生成脱敏结构差异；输出前移除凭据、签名、ID、工具名、正文和二进制内容。

新的 CLI 拦截只作为兜底。应优先利用已有 Kiro 日志与捕获。启用临时 CA、
HTTPS 拦截或附加调试器仍需要单独授权。

## 兼容策略

只有 native-context 矩阵中的全部模型、effort、案例都保持内容、顺序、优先级
与工具行为，`safe` 才能启用原生映射。显式 `legacy-user-prefix` 继续弃用，
但删除改为证据门控，不再绑定已经过去的 v0.7.0 日期。

首个真实 stop-gate 使用 GPT-5.6 Sol / xhigh，对五种案例各运行一次。
原生 `additionalContext` 为 0/5；legacy-current-boundary 对照为 5/5，且没有
传输错误。由于启用门禁要求全部 native 案例通过，该结果已经足以保持 `safe`
默认拒绝，因此没有继续消耗剩余 390 个请求。

CLI 兜底也已推进：

- Kiro CLI 从 2.12.0 升级到 2.21.1；新二进制 SHA-256 为
  `6880acd76a902afb4f0ba3c5d29134e6608c0b359632227105d08a0756357e21`。
- 合成非交互请求成功并精确返回标记。
- CLI session 记录显示实际模型为 `claude-opus-5`；CLI 同时提示非交互模型
  设置方法不可用。
- 当前 CLI session 文件只包含 prompt/response 与计量元数据，没有序列化的
  `GenerateAssistantResponse` command；未获得单独授权前没有安装 CA、执行
  MITM 或附加调试器。

## 验证命令

```sh
bun test
bun run lint
bun run typecheck
bun run build:binary
git diff --check
```

涉及 loopback 的测试必须在允许监听 `127.0.0.1` 的环境运行。生产 8787、
安装二进制和生产账户库不属于候选写入范围。

当前候选证据：

- 1,494 个测试通过，0 失败；
- lint、TypeScript typecheck 与 `git diff --check` 通过；
- 编译二进制 SHA-256：
  `f9891266866f816b13a24d4f8a3fd3322e5d2284f4788f4e8f38a78eb662744b`。

隔离 18787 smoke 使用 SQLite `.backup`，其 `PRAGMA integrity_check`
结果为 `ok`：

| 单元 | 分数 / exit | request / dispatch / terminal | witnessed | Provider 错误 |
| --- | --- | --- | --- | --- |
| Plan debugging Claude xhigh | 90 / 0 | 14 / 14 / 14 | 14/14 | 0 |
| Plan debugging Claude max | 100 / 0 | 16 / 16 / 16 | 16/16 | 0 |
| Build debugging Claude xhigh 控制 | 100 / 0 | 12 / 12 / 12 | 12/12 | 0 |

由于本轮 Zuno 持续更新，这些 Zuno 结果只作为兼容性证据，不作为最终门禁。

xhigh Plan 的 90 分属于答案质量波动：所有诊断分类均通过，进程正常退出，
且不存在投影或 provider 错误。原来的 malformed request 没有再出现。

标准 Responses 黑盒探针还确认：工具描述缺失时，Kiro 会返回 HTTP 400
`Invalid tool use format`；给同一个工具补充非空描述后，tool-result 加尾部
指令的形态即可成功。候选现在会在本地返回 `missing_tool_description`，不会
编造描述，也不会把无效声明发送到上游。

## 标准 Responses 最终证据

最终候选二进制只在隔离端口 18787 启动，并使用 SQLite 备份。最终八请求边界
回归为 8/8：

| 案例 | 状态 | SDK dispatch / terminal | 结果 |
| --- | --- | --- | --- |
| assistant + 尾部指令 | 200 | 1 / 1 witnessed | `synthetic_user` |
| tool result + 尾部指令 | 200 | 1 / 1 witnessed | `append_tool` |
| 空文本 + image + document + 尾部指令 | 200 | 1 / 1 witnessed | `append_user` |
| assistant 结束 | 400 | 0 / 0 | `missing_current_input`、`input.0` |
| GPT max / xhigh 控制 | 200 / 200 | 各 1 / 1 | effort 精确 |
| Claude max / xhigh 控制 | 200 / 200 | 各 1 / 1 | effort 精确 |

最终 72-cell Responses 研究完成全部 36 个 AB/BA 配对：

- 72/72 请求均为一次 SDK dispatch、一个 witnessed terminal、精确 model 与
  effort、同一个 account hash，且 provider error 为 0。
- 安全评分 72/72；机器任务质量 70/72。
- GPT-5.6 Sol 质量 36/36。max 中位墙钟 2,351.5 ms，xhigh 为
  2,209.5 ms；xhigh 改善 6.04%，配对获胜率 50%，均未达到 15% 与 70%
  门槛。建议：`no-change`。
- Claude Opus 5 质量 34/36；两个 max 样本在同一个合成算术题上给出错误答案。
  max 中位墙钟 3,004 ms，xhigh 为 3,152 ms；xhigh 慢 4.93%，配对获胜率
  44.44%。由于“质量零退化”失败，建议：`no-change`。
- 两模型、两 effort 的 SDK dispatch 中位数均为 1。

首轮 72-cell 结果单独保留，因为两个合成评分题允许语义等价的标签或标点。
修正为无歧义题目后完整重跑了整个矩阵，没有直接篡改首轮分数。

证据文件：

- `/tmp/kiro-provider-optimization-e2e-20260905/responses-live-e2e-final-candidate.json`
- `/tmp/kiro-provider-optimization-e2e-20260905/responses-effort-study-72-final.json`
- `/tmp/kiro-provider-optimization-e2e-20260905/responses-effort-study-72-initial.json`

关闭后，隔离端口 18787 已不可连接，备份账户库仍为
`PRAGMA integrity_check=ok`，生产 8787 仍返回 `{"status":"ok"}`。
