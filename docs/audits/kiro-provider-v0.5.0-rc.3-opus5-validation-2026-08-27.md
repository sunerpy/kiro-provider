# kiro-provider v0.5.0-rc.3 Opus 5 验收审计

日期：2026-08-27

结论：**允许发布预发布版 `v0.5.0-rc.3`；不允许发布稳定版
`v0.5.0`。**

本报告覆盖 Claude Opus 5 模型目录、effort、输出上限、三种协议入口、真实
OpenCode 工具循环，以及当前 Codex/Claude Code 的字段级边界。所有客户端只
配置标准 base URL、API key、模型及客户端自身公开的 effort/权限选项；没有
私有 Header、请求补丁、字段剥离或客户端提示词补偿。Zuno 项目没有读取、
修改、构建或重跑。

## 1. 上游同步基线

- `opencode-kiro-auth` 远端 `main`：`bae3e14fd179b9bddbe4d934fdd2838403fafa73`
  （`0.20.7`）。
- 远端与本地父项目 HEAD 一致。
- 上游 Opus 5 定义：
  - Kiro wire ID：`claude-opus-5`；
  - 内部兼容映射：`claude-opus-5-thinking` → `claude-opus-5`；
  - 公开模型：base、`low`、`medium`、`high`、`xhigh`、`max`；
  - context：1,000,000；
  - `xhigh` 能力：启用。

本项目只同步认证项目中经过验证的模型 ID、effort 和上下文事实。没有复制
其历史提示词修补逻辑，也没有新增提示词拼接、消息合并、内容删除、工具补偿
文本或模型文本解析。

## 2. RC.3 公开模型目录

`GET /v1/models` 的编译后二进制实测公开以下 6 个 ID：

```text
claude-opus-5
claude-opus-5-low
claude-opus-5-medium
claude-opus-5-high
claude-opus-5-xhigh
claude-opus-5-max
```

六项均返回：

- wire ID：`claude-opus-5`；
- context limit：1,000,000；
- output limit：128,000；
- 输入模态：text/image/pdf；
- Codex reasoning levels：low/medium/high/xhigh/max；
- `base_instructions`：空字符串。

`claude-opus-5-thinking` 仅保留内部兼容解析，不作为新的公开目录项；这与
最新 `opencode-kiro-auth` 的公开集合一致。

## 3. Kiro 原生 effort 探针

使用同一健康 Kiro 账号、相同脱敏推理任务、独立 conversation，并以相反顺序
执行两轮 `low/medium/high/xhigh/max`。五档请求均：

- HTTP 200；
- 返回 `reasoningContentEvent`；
- 返回 `meteringEvent`；
- clean EOF。

两轮平均观测：

| effort | 平均 credit | 平均 reasoning 字符 | 平均延迟 |
| --- | ---: | ---: | ---: |
| low | 0.289 | 324 | 13.1 秒 |
| medium | 0.762 | 1,681 | 35.2 秒 |
| high | 1.233 | 2,544 | 53.4 秒 |
| xhigh | 0.940 | 2,314 | 40.3 秒 |
| max | 1.428 | 3,449 | 62.1 秒 |

单次相邻档位可能交叉，符合动态/自适应推理行为；不能把一次请求的 token 或
延迟当作固定预算。但低档与高档/最大档的多次观测存在明显工作量差异，且
五个枚举都被 Kiro schema 接受。因此结论是：**effort 确实生效，但不是固定
token 配额或逐次严格单调保证。**

仓库内可复现探针：

```text
bun scripts/probe-sdk.ts
# exit 0；Plain Opus 5、Opus 5 output_config.effort、GPT reasoning.effort 均 PASS
```

真实 OpenCode 工具循环的 Provider 日志也连续三轮记录
`"effort":"max"`，证明公开 `claude-opus-5-max` 变体经 Responses 适配器抵达
Kiro SDK。

## 4. Kiro 原生输出上限探针

直接 Kiro SDK 探测结果：

| 请求 | 结果 |
| --- | --- |
| Opus 5 `max_tokens=1024` | HTTP 200 |
| Opus 5 `max_tokens=128000` | HTTP 200 |
| Opus 5 `max_tokens=128001` | HTTP 400，`must have a maximum value of 128000.0` |

仓库探针同时复验 Sonnet 5、Opus 5 和 GPT：

```text
bun scripts/probe-sdk.ts --output-token-limit
# exit 1（预期）；Opus 5 两项均 PASS，整体非零仅因为 GPT 的所有候选字段仍被拒绝
```

因此 RC.3 只为 `claude-sonnet-5` 与 `claude-opus-5` 家族投影原生
`additionalModelRequestFields.max_tokens`，范围为 1,024–128,000。GPT 和其他
未探针确认的模型继续返回 `unsupported_output_token_limit`。

## 5. 官方 OpenAI JavaScript SDK 7.5.0 与直接 Messages

使用最终编译后二进制、隔离 Provider 状态和官方 SDK，单个套件退出码为 0：

```text
OPUS5_CATALOG_OK
OPUS5_RESPONSE_NONSTREAM_OK
OPUS5_RESPONSE_STREAM_OK
OPUS5_FUNCTION_TOOL_OK
OPUS5_CHAT_OK
OPUS5_MESSAGES_NONSTREAM_OK
OPUS5_MESSAGES_STREAM_OK
OPUS5_OUTPUT_BOUNDARY_OK
```

覆盖：

- Responses 非流式：base 模型、显式 `reasoning.effort=low`、`max_output_tokens=1024`；
- Responses SSE：`claude-opus-5-xhigh`；
- Responses function 工具两轮：`claude-opus-5-max`；
- 显式开启的 Chat：`claude-opus-5-high` 与 `reasoning_effort=high`；
- Anthropic Messages JSON：Opus 5 `output_config.effort=xhigh`；
- Anthropic Messages SSE：`claude-opus-5-low`；
- `max_output_tokens=128001` 在调用 Kiro 前精确返回
  `invalid_output_token_limit`。

## 6. OpenCode 1.18.18 真实工具循环

隔离 OpenCode 配置只包含：

- `npm: "@ai-sdk/openai"`；
- 标准 `baseURL` 与 API key；
- 模型 `claude-opus-5-max`；
- 模型公开 option `reasoningEffort: "max"`；
- 本地临时目录的 bash/read 权限。

Provider 显式使用迁移模式 `legacy-user-prefix`，因为当前 OpenCode 会发送
developer 指令；默认 `safe` 行为没有改变。

真实命令退出码为 0，执行顺序：

1. bash 写入无换行的 22 bytes：`OPENCODE_OPUS5_TOOL_OK`；
2. read 工具读回相同内容；
3. 最终文本精确返回 `OPENCODE_OPUS5_TOOL_OK`。

三个模型回合均使用：

```json
{"account_hash":"346335f3182f25dd","conversation_hash":"eccfd5684a78335a","effort":"max"}
```

后两轮均为 `transport_pool_hit=true`、`sdk_client_pool_hit=true`。这证明同一
标准 `prompt_cache_key` 会话复用同一账号、Kiro conversation 与进程内对象；
不宣称固定物理 TCP socket。

OpenCode 还发起过一个辅助 reasoning-summary 请求，Provider 以
`unsupported_reasoning_summary` 明确拒绝；客户端继续完成主工具命令。该字段
没有被静默丢弃。

## 7. 当前 Codex 与 Claude Code 边界

### Codex CLI 0.150.0-alpha.9

隔离 `CODEX_HOME` 只配置标准 Responses base URL、API key、
`claude-opus-5-max` 和 high effort。进程退出码为 1。

模型已通过 Provider 校验；第一个精确错误为：

```json
{"code":"unsupported_reasoning_summary","param":"reasoning.summary"}
```

因此本次修复了 Opus 5 模型缺失，但 Codex 稳定门禁仍未通过。Provider 不会
丢弃该字段或用提示词模拟。

### Claude Code 2.1.209

隔离 HOME/XDG，只设置标准 `ANTHROPIC_BASE_URL`、API key、
`claude-opus-5`、max effort，并启用客户端自身的 bare/safe mode。进程退出码
为 1。

模型已通过 Provider 校验；第一个精确错误为：

```json
{"code":"unsupported_parameter","param":"context_management"}
```

直接 Messages 子集已经通过 Opus 5 JSON/SSE，但该 Claude Code 版本仍未通过
稳定门禁。Provider 不会丢弃 `context_management`。

## 8. 自动化与构建门禁

| 门禁 | 结果 |
| --- | --- |
| `bun run fmt` | 通过 |
| `make fmt-check` | 通过 |
| `bun run lint` | 通过 |
| `bun run typecheck` | 通过 |
| `bun test` | 724 pass，0 fail，3,194 expect calls |
| `make coverage-gate` | 通过；10,755 / 11,496 lines，93.55%（门槛 93%） |
| `make coverage-parity` | 通过 |
| `bun run build` | 通过 |
| `bun run build:binary` | 通过 |
| `make security` | 通过；7 项安全断言 |
| `make codex-smoke-security` | 通过 |
| `codegraph check -p . -j` | 通过；无新增结构问题 |

第一次沙箱内 `bun test` 因网络命名空间中的 `Bun.serve(port: 0)`
`EADDRINUSE` 发生级联失败；在授权的正常网络命名空间直接重跑后全部 724 项
通过。失败只涉及临时监听端口，不涉及 Opus 5 断言。

最终本机 Linux 二进制：

- 路径：`dist/kiro-provider`；
- 大小：95,225,984 bytes；
- 权限：`0755`；
- SHA-256：
  `80c9eb07885f1fc20aefb94f80872af8e0559cea1a6e1b3a653510fe9fe19ee5`。

GitHub Release 资产由发布工作流重新构建，最终校验值以 Release 中的
`SHA256SUMS` 为准。

## 9. 发布决策

`v0.5.0-rc.3` 适合作为 Opus 5 预发布版：

- 与最新 `opencode-kiro-auth` 同步 Opus 5 wire ID、公开 effort 变体和上下文；
- 原生 effort、1,024–128,000 输出上限均有 Kiro 实时证据；
- Responses、显式 Chat、Messages、SSE 和真实 OpenCode 工具循环通过；
- 同会话账号、conversation 与进程内连接对象复用有结构化日志证据；
- 没有新增提示词拼接、消息改写或字段静默丢弃。

稳定版 `v0.5.0` 继续阻塞于：

- Codex 0.150.0-alpha.9 的 `reasoning.summary`；
- Claude Code 2.1.209 的 `context_management`；
- OpenCode Chat 的既有非标准 `messages.0.cache_control`；
- 本次按范围未重跑的 Zuno 稳定门禁。

因此只创建 prerelease 标签，不更新 npm `latest`，也不通过请求补丁、私有
Header、字段剥离或模型可见补偿文本换取表面兼容。
