# kiroclaude max effort 失效修复

> **日期**：2026-09-26 · **客户端**：Claude Code 2.1.280（已安装二进制）
> **证据**：[`evidence/kiroclaude-max-effort-2026-09-26/effort-matrix.json`](evidence/kiroclaude-max-effort-2026-09-26/effort-matrix.json)

## 结论

`KIROCLAUDE_EFFORT=max` 此前在 wire 上实际发送 `output_config.effort: "medium"`，
主线程和子 agent 都是如此。启动器把 max 写成了 `--settings` 里的
`effortLevel: "max"`，而 Claude Code 的持久化 `effortLevel` 只接受 `low`、
`medium`、`high`、`xhigh`，其他值会被静默丢弃，于是回落到模型默认档位。修复后
max 改走会话级参数 `--effort max`，已安装客户端实测主线程与子 agent 都发送 `max`。

## 根因证据

- Claude Code 2.1.280 的设置 schema 为
  `effortLevel: enum(["low","medium","high","xhigh"]).optional().catch(undefined)`，
  并注明 “'max' is session-only and is not written”。
- `claude --help` 中 `--effort <level>` 接受 `low, medium, high, xhigh, max`，作用于
  当前会话。
- 同时出现多个 `--effort` 时以最后一个为准；显式会话 effort 会关闭 Ultracode；
  Ultracode 本身固定为 `xhigh`。三条均由证据文件中的矩阵复现。

## 修复

- `max`：不再写 `effortLevel`，改为在调用参数之前插入 `--effort max`，用户在
  命令行显式给出的 `--effort` 仍然优先。
- `ultra`（默认）：写入有效的 `effortLevel: "xhigh"` 并保持 `ultracode: true`，
  不附加 `--effort`，否则会关闭 Ultracode。wire 行为不变，仍是 `xhigh` 加编排。
- `low` 到 `xhigh`：行为不变。
- Bedrock Fable 后端默认的 max 同样改走 `--effort max`；该路径只做了单元测试，
  未对 Bedrock 做实测。

## 验证

| 用例 | 修复前 | 修复后 |
| --- | --- | --- |
| 默认 / `ultra` | `xhigh`，Ultracode 开 | `xhigh`，Ultracode 开 |
| `low` / `medium` / `high` / `xhigh` | 对应档位 | 对应档位 |
| `max` | `medium` | `max` |
| `max` + 命令行 `--effort high` | `high` | `high` |
| `max` + 一个子 agent | 主线程与子 agent 都是 `medium` | 都是 `max` |

矩阵由 `bun scripts/probe-client-context.mjs --effort-matrix` 生成，修复前的一组
通过 `--launcher` 指向 `40645b9` 的启动器。探测使用本地假 API 与临时 Claude
状态，不调用真实模型。回归测试位于 `__tests__/kiroclaude-scripts.test.ts`。
