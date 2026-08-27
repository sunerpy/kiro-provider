# kiro-provider v0.5.0-rc.2 验收审计

日期：2026-08-27

结论：**允许发布预发布版 `v0.5.0-rc.2`；不允许发布稳定版
`v0.5.0`。**

本报告覆盖 RC.2 的 Canonical 输出重构、Responses reasoning 标准续轮兼容、
自动化门禁，以及使用最终编译后二进制进行的真实客户端验证。所有客户端只
配置标准 base URL、API key 和模型；没有私有 Header、请求补丁、字段剥离或
客户端提示词补偿。

## 1. 构建身份

- 包版本：`0.5.0-rc.2`。
- 最终本机二进制：`dist/kiro-provider`。
- 大小：95,225,984 bytes。
- POSIX 权限：`0755`。
- SHA-256：
  `b729cc3e7c800192c331bd03e219dded28ca8b1e2ef810865c02109d3cc557fc`。
- 认证来源：OpenCode 共享 Kiro 凭证数据库。
- 验收未保存 access token、refresh token、API key、reasoning、签名或提示词
  正文。

该 SHA 仅标识本次 Linux 本机验收产物。GitHub Release 的平台资产由发布
工作流重新构建，并以发布清单中的校验值为准。

## 2. Canonical 输出边界

RC.2 将 Kiro 输出路径重构为严格、版本化的内部协议：

```text
Kiro SDK events
      │
      ▼
CanonicalCompletion / CanonicalEvent
      │
      ├── OpenAI Responses JSON/SSE
      ├── Anthropic Messages JSON/SSE
      └── explicitly enabled Chat JSON/SSE
```

关键结果：

- `src/protocol/output.ts` 定义 Canonical completion/event schema 与内部
  JSON/NDJSON media type；
- Kiro SDK 事件由 `sdk-output-transformer.ts` 直接转换，不再先生成 Chat
  chunks；
- Responses 与 Messages 的生产输出路径不再依赖内部 Chat wire；
- 流式和非流式路径共享同一状态语义与终态校验；
- 已删除旧 `chat-wire.ts`、`sdk-stream-transformer.ts`、
  `openai-converter.ts`、`stream-state.ts` 与相关遗留类型；
- Responses 输入入口重命名为 `adaptResponsesRequest`，不再表达
  “Responses 转 Chat”的错误架构含义。

默认 `safe` 路径继续确认不存在提示词拼接、指令改写、相邻消息合并、重复
assistant 内容清空、尾部 `"{"` 删除、工具补偿文本或未知字段静默丢弃。

## 3. RC.2 协议修正

### `parallel_tool_calls: false`

- 没有可调用工具时作为无副作用字段接受；
- `tool_choice: none` 时同样接受；
- 存在可调用工具且无法保证仅串行执行时，返回
  `unsupported_parallel_tool_calls`；
- 拒绝发生在创建 Kiro 请求之前。

### Responses `text`

- `text.verbosity` 返回 `unsupported_parameter`，并保留精确
  `param: "text.verbosity"`；
- 非默认结构化格式返回 `unsupported_structured_output`，字段路径为
  `text.format`；
- 其他未知 `text.*` 字段逐字段拒绝。

### Reasoning 标准续轮

按标准 Responses 手工续轮形态，客户端可以把返回的 reasoning item（包括
`summary`、`content` 和 `encrypted_content`）原样放入下一次 input。只有有效
的 `kr1_...` 令牌具有回放权威：

- `summary` / `content` 不投影到 Kiro；
- 可见 reasoning 文本不作为签名缺失时的明文降级；
- 缺失、格式错误、过期、跨租户、跨模型、跨账号、跨 conversation 或篡改的
  令牌仍明确失败；
- 回放命中后锁定原账号与原 Kiro conversation。

Kiro 只有在产生完整合法的 signed/redacted envelope 时才会签发令牌；本次
一次上游响应没有完整 envelope，Provider 正确地没有伪造令牌。使用高 effort
取得完整 envelope 后，跨重启回放通过。

## 4. 自动化门禁

| 门禁 | 结果 |
| --- | --- |
| `bun run fmt` | 通过 |
| `make fmt-check` | 通过 |
| `bun run lint` | 通过 |
| `bun run typecheck` | 通过 |
| `bun test` | 716 pass，0 fail，3,049 expect calls |
| `make coverage-gate` | 通过；10,735 / 11,476 lines，93.54%（门槛 93%） |
| `make coverage-parity` | 通过 |
| `bun run build` | 通过 |
| `bun run build:binary` | 通过 |
| `make security` | 通过；7 项安全断言全部成功 |
| `make codex-smoke-security` | 通过 |
| `codegraph check -p . -j` | 通过；`cycles=[]` |

## 5. 官方 OpenAI JavaScript SDK 7.5.0

使用最终二进制与官方 SDK，单个验收脚本退出码为 0：

```text
SDK_NONSTREAM_OK
SDK_STREAM_OK
SDK_CHAT_OK
SDK_CHAT_STREAM_OK
FUNCTION_TOOL_OK
CUSTOM_TOOL_OK
PARALLEL_TOOL_CALLS_REJECTION_OK
```

覆盖范围：

- Responses 非流式与 SSE；
- 无工具时的 `parallel_tool_calls: false`；
- 显式开启的 Chat 非流式与 SSE；
- Chat `stream_options.include_usage=true` 的单独 usage chunk；
- function 与 custom 工具两轮往返；
- 有可调用工具时 `parallel_tool_calls: false` 的精确 400。

工具续轮通过标准 metadata / `prompt_cache_key` 取得显式亲和，没有使用私有
Header。SDK/transport 缓存命中不等同于固定物理 TCP 连接；本次服务明确使用
`sdk_http_keep_alive=false`。

## 6. Reasoning 跨重启回放

模型：`claude-opus-4-8-thinking`。

脱敏命令与退出码：

```text
bun reasoning-first-final.mjs   # exit 0, REASONING_FIRST_FINAL_OK
# stop and restart the same compiled provider
bun reasoning-replay.mjs        # exit 0, REASONING_REPLAY_OK
```

续轮 input 直接包含首轮 `response.output`，没有重建或提取明文 reasoning。
结构化日志证据：

```json
{"event":"reasoning_replay_hit","account_hash":"346335f3182f25dd","conversation_hash":"bce45e04b52cbd31","model":"claude-opus-4-8-thinking"}
{"event":"upstream_affinity_selected","account_hash":"346335f3182f25dd","conversation_hash":"bce45e04b52cbd31","reasoning_replay_locked":true}
```

密钥文件、Provider 数据库和续轮状态文件权限均为 `0600`。

## 7. OpenCode 1.18.18

### Responses

隔离配置只包含标准 base URL、API key、模型和
`@ai-sdk/openai` provider。由于 OpenCode 会发送 developer 指令，验收显式使用
迁移模式 `legacy-user-prefix` 与 Claude Sonnet 5。

真实工具循环退出码为 0：

1. bash 工具写入精确 21 bytes：`OPENCODE_RC2_FINAL_OK`；
2. read 工具读回完全相同内容；
3. 最终文本为 `OPENCODE_RC2_FINAL_OK`。

三个模型回合使用相同账号哈希 `5bafd91ab936c907` 与 conversation 哈希
`138c321172d90510`。后两轮均为 `transport_pool_hit=true`、
`sdk_client_pool_hit=true`。这证明同一显式会话复用逻辑账号、Kiro
conversation 和进程内对象，不宣称固定 TCP socket。

### 显式 Chat

使用 `@ai-sdk/openai-compatible`，进程退出码为 1。客户端发送非标准字段，
Provider 在 Kiro 前返回：

```json
{"code":"unsupported_message_field","param":"messages.0.cache_control"}
```

Provider 没有静默删除 `cache_control`。

## 8. Codex CLI 0.149.0-alpha.4.1

隔离 `CODEX_HOME` 只配置标准 model、base URL、API key 环境变量与
`wire_api="responses"`。`codex exec` 退出码为 1，第一个精确错误为：

```json
{"code":"unsupported_parameter","param":"text.verbosity"}
```

脱敏 fixture 还包含：

- `reasoning.context: "all_turns"`；
- 有可调用 `additional_tools` 时的 `parallel_tool_calls: false`；
- custom grammar；
- namespace 语义。

这些字段不能通过剥离、改写或提示词模拟来伪装支持。因此本次没有进入真实
shell/tool 循环，Codex 稳定版门禁未通过。

## 9. Claude Code 2.1.209

使用绝对 Claude Code 二进制与隔离 HOME/XDG，只设置标准
`ANTHROPIC_BASE_URL`、token、模型和 `--safe-mode`。进程退出码为 1。

最终 Provider 请求序列：

1. `output_config.format` 以 `unsupported_parameter` 拒绝；
2. 客户端重试并发送非法的 `messages.1.role=system`；
3. Anthropic schema 返回 400，因为角色只允许 `user` 或 `assistant`。

同版本此前的脱敏 wire capture 还包含 `context_management`。Provider 没有
丢弃输出格式、搬移 system 角色或加入提示词补偿，因此 Claude Code 稳定版
门禁未通过。

## 10. Zuno 范围

RC.2 按用户明确范围没有读取、修改、构建或重跑 Zuno 项目。Provider 仓库中
既有 Zuno 配置说明继续作为历史集成指导；RC.1 的 Zuno 证据不被重新标记为
RC.2 通过。

## 11. 并发隔离与无正文 wire evidence

实现仍保留两级串行化：

- 显式会话键队列防止同会话重叠回合；
- 账号队列防止同一账号上的 Kiro 流并发；
- 不同账号可以并行；
- 工具声明、公开名/上游别名与调用结果映射只存在于当前请求，不在会话间共享
  可变状态；
- reasoning 回放进一步锁定原账号与 conversation。

保留的脱敏 Kiro 结构证据只含事件类型与计数，不含正文、参数、reasoning 或
签名：

```json
{"event":"sdk_stream_completed","model":"claude-sonnet-5","raw_event_count":5,"last_event_type":"meteringEvent","event_type_counts":"{\"assistantResponseEvent\":3,\"contextUsageEvent\":1,\"meteringEvent\":1}"}
{"event":"protocol_projection_rejected","protocol":"chat-completions","code":"unsupported_message_field","param":"messages.0.cache_control"}
{"event":"protocol_projection_rejected","protocol":"responses","code":"unsupported_parameter","param":"text.verbosity"}
{"event":"protocol_projection_rejected","protocol":"anthropic-messages","code":"unsupported_parameter","param":"output_config.format"}
```

## 12. 发布决策

`v0.5.0-rc.2` 适合作为协议保真预发布版：

- Canonical 输出层已替代内部 Chat wire；
- 官方 OpenAI SDK 的 Responses、显式 Chat、工具循环和跨重启 reasoning
  回放通过；
- OpenCode Responses 的明确迁移子集通过并证明同会话亲和；
- 不支持能力全部 fail-closed，没有提示词拼接、消息改写或字段静默丢弃。

稳定版 `v0.5.0` 继续阻塞于：

- OpenCode Chat 的非标准 `messages.0.cache_control`；
- Codex 的 `text.verbosity` 及后续未支持控制；
- Claude Code 的 `output_config.format`、非法 system 消息重试，以及此前
  capture 中的 `context_management`；
- 本次未重跑的 Zuno 稳定门禁。

在这些要求通过前，不创建稳定标签，不把 RC 标记为 `latest`，也不通过私有
Header、客户端补丁、字段剥离或模型可见补偿文本换取表面兼容。
