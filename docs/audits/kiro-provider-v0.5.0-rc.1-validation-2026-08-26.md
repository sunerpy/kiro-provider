# kiro-provider v0.5.0-rc.1 验收审计

日期：2026-08-26
结论：**允许发布预发布版 `v0.5.0-rc.1`；不允许发布稳定版 `v0.5.0`。**

本报告覆盖协议保真修缮、Kiro 原生能力探针、自动化门禁，以及使用最终编译
服务进行的真实客户端验收。历史文档
[`../E2E_VALIDATION_2026-08-22.md`](../E2E_VALIDATION_2026-08-22.md) 只代表
v0.4.0，不作为本次 RC 的通过证据。

## 1. 构建身份与边界

- 包版本：`0.5.0-rc.1`。
- 验收主机：Linux 6.17.0-1019-aws x86_64。
- 最终本机二进制：`dist/kiro-provider`，95,217,792 bytes，权限 `0755`。
- 最终本机二进制 SHA-256：
  `02d87333abeed075f577fa367c8069689e6bc18468551c0627ccd328052621ea`。
- 认证来源：复用 OpenCode 的共享 Kiro 凭证数据库；报告不保存 access token、
  refresh token、API key、reasoning、签名或提示词正文。
- 客户端只配置标准 base URL、API key 和模型；没有私有 Header、请求补丁或
  客户端侧提示词补偿。

二进制 SHA 仅标识本次 Linux 本机验收产物。GitHub Release 的各平台资产由
发布工作流独立构建，并通过 `SHA256SUMS` 校验。

## 2. 协议保真结果

默认 `safe` 路径已确认不存在以下行为：

- 把 system/developer/instructions 改写成带标签的 user 文本；
- 合并相邻同角色消息或多个顶层文本块；
- 清空重复 assistant 内容；
- 删除 assistant 尾部的单独 `"{"`；
- 为 orphan tool、图片省略、thinking mode 或未知 item 添加模型可见补偿文本；
- 从调用参数推断工具 schema、描述或历史声明；
- 静默丢弃 reasoning、`author/recipient`、未知字段或不支持的参数。

Responses、Chat 与 Messages 都先进入保留角色、边界、顺序和原始字段路径的
Canonical IR，再由 Kiro 适配器降级。无法等价表达时在创建 Kiro SDK 客户端
前返回 400 和精确 `param`。`legacy-user-prefix` 只保留原始指令块之间的
`\n\n` 迁移投影，不恢复其他改写逻辑，并输出不含正文的启动警告。

新增的多文本块防线也已实测：两个顶层文本块返回
`unsupported_content_block_projection`，`param` 指向第一个无法保真投影的
块；请求没有进入 Kiro。

## 3. Kiro 原生探针

完整脱敏请求和原始事件见
[`kiro-protocol-projection-probe-2026-08-26.md`](kiro-protocol-projection-probe-2026-08-26.md)。

| 探针 | 原始结论 | v0.5.0-rc.1 决策 |
| --- | --- | --- |
| `additionalContext` 承载指令 | 空 `name`/`description` 形态被 Kiro 以 400 拒绝；冲突优先级和工具场景也未取得可用证据 | safe 模式拒绝指令投影；不自动回退到 user 前缀 |
| 连续同角色消息 | 连续 user 与连续 assistant 历史均可按原顺序直接发送 | 不合并、不插入说明文本 |
| Reasoning 捕获 | Claude Sonnet 5 探针取得签名事件；未取得可依赖的可见 text/redacted 组合 | 完整捕获 SDK 的 text/signature/redacted bytes；只在完整合法 envelope 上签发回放令牌 |
| 输出 token 上限 | 仅 Claude Sonnet 5 原生 `max_tokens` 通过，范围 1,024–128,000；GPT 别名均被 Kiro schema 拒绝 | 仅该模型族映射，其他模型逐字段 400 |
| Web Search | 未取得原生搜索调用和引用事件证据 | `unsupported_web_search`；不伪装 `web_search_call` 或引用事件 |

## 4. 自动化与安全门禁

| 门禁 | 结果 |
| --- | --- |
| `bun run lint` | 通过；147 files，0 fixes |
| `bun run typecheck` | 通过 |
| `bun test` / 覆盖率运行 | 693 pass，0 fail，2,952 assertions |
| `make coverage-gate` | 通过；10,258 / 10,979 lines，93.43%（门槛 93%） |
| `make coverage-parity` | 通过；本地与 Codecov 有效排除集一致 |
| `bun run build` | 通过 |
| `bun run build:binary` | 通过 |
| `make security` | 通过；空 API key fail-closed、默认 loopback、日志无密钥、数据库权限、413、504、流错误帧共 7 项 |
| `make codex-smoke-security` | 通过；子进程回收、固定 origin/path、最小 Header、capture 无 Header、API key 不进入 argv、临时目录仅 owner 可读写 |
| `codegraph check -p . -j` | 通过；最终调用图 `cycles=[]`，索引 current，pendingChanges=0 |

覆盖率门禁最初发现一个无调用方的遗留 `sdk-stream-buffer.ts` 和一个未显式
排除的纯类型模块。CodeGraph 证明前者没有依赖方后删除；后者移除无引用常量并
同步到本地/Codecov 排除清单。没有降低覆盖率阈值。

最终结构检查还发现 Responses state/events 的类型反向引用。共享响应类型移动到
state 模块并由 events 兼容重导出后，运行时依赖成为单向，CodeGraph 循环归零；
完整测试、覆盖率和编译后二进制 E2E 随后全部重跑。

## 5. 官方 OpenAI SDK 7.5.0

服务使用最终 `dist/kiro-provider` 启动。脱敏后的执行形态：

```text
./dist/kiro-provider serve --config <safe-config>
bun openai-sdk-e2e.mjs
bun openai-sdk-chat-stream.mjs
bun openai-sdk-tools-e2e.mjs
```

三个客户端进程退出码均为 0：

- Responses 非流式：`SDK_NONSTREAM_OK`，`status=completed`。
- Responses SSE：`SDK_STREAM_OK`；事件依次为 `response.created`、
  `response.in_progress`、item/content-part added、三个 text delta、text done、
  content-part done、item done、`response.completed`。
- 显式开启的 Chat 非流式：`SDK_CHAT_OK`。
- Chat 流式 `stream_options.include_usage=true`：`SDK_CHAT_STREAM_OK`，恰好一个
  usage chunk，且该 chunk 的 choices 为空。
- function 工具循环：`lookup_marker` 调用后返回 `FUNCTION_TOOL_OK`。
- custom 工具循环：`raw_marker` 调用后返回 `CUSTOM_TOOL_OK`。

同一 `prompt_cache_key` 的 function 续轮复用账号哈希
`9e0e6e9aa857355e` 和 conversation 哈希 `a3ea92371eb04c0b`；custom 续轮复用
账号哈希 `c3b8caa532a65e5c` 和 conversation 哈希 `8ae0ed51cbe00df9`。续轮日志
显示 `transport_pool_hit=true`、`sdk_client_pool_hit=true`。

字段级 live 拒绝同样通过：多顶层文本块和 Web Search 都返回明确 400，不产生
SDK 调用或伪造搜索事件。

## 6. 加密 reasoning 跨重启回放

使用官方 SDK、模型 `claude-opus-4-8-thinking`：

```text
REASONING_MODEL=claude-opus-4-8-thinking bun openai-sdk-reasoning-first.mjs
# 停止并重新启动 dist/kiro-provider
bun openai-sdk-reasoning-replay.mjs
```

- 首轮退出码 0：结果 `49403`，输出 item 为 reasoning + message，返回不透明
  `kr1_...`；审计只记录令牌 SHA-256 前缀 `0b6a686169eb1a7d`。
- 服务重启后回放退出码 0：结果 `49410`。
- `reasoning_replay_hit` 使用 key ID `rk_2b72330f65e3d31b`，账号哈希
  `9e0e6e9aa857355e`，conversation 哈希 `d0d82e62d33ae374`。
- 续轮日志为 `reasoning_replay_locked=true`；服务没有切换账号或 conversation。

多进程负向检查同样通过：第二进程若共享数据库却使用不同密钥文件，会在启动
时明确报出缺失的活动 key ID 并拒绝服务；把两个临时进程配置为同一密钥环后
才允许启动。未删除或降级任何未过期回放记录。

SQLite 仅保存令牌/指纹哈希和 AES-256-GCM 密文。自动测试另覆盖重启、轮换、
过期、跨租户、跨模型、跨账号、歧义和篡改；任何 miss/expired/decrypt failure
都明确失败，不降级成明文 reasoning。

## 7. OpenCode 1.18.18

使用隔离 XDG 目录，只在 OpenCode provider 中配置标准 base URL、API key 和
模型。

### Responses

显式 `legacy-user-prefix` + `claude-sonnet-5` 的真实工具循环退出码 0：

1. OpenCode 调用 bash，将 `OPENCODE_FINAL_SHA_OK` 写入隔离临时文件；工具退出
   码为 0。
2. OpenCode 调用 read 读回完全相同的 21 bytes。
3. 最终文本为 `OPENCODE_FINAL_SHA_OK`。

三个带 `prompt_cache_key` 的轮次复用账号哈希 `346335f3182f25dd` 和
conversation 哈希 `b079f87e49cee963`；后续轮次连接池命中为 true。

safe 模式仍会正确拒绝 OpenCode 的 developer 指令，GPT 模型请求还会携带
Kiro 未证实支持的输出 token 上限。因此这里只声明“显式 legacy + Claude
Sonnet 5”通过，不扩大到整个 OpenCode Responses 面。

### 显式 Chat

`kiro-chat/claude-sonnet-5` 进程退出码 1。OpenCode 发送
`messages.0.cache_control`，Provider 在调用 Kiro 前返回：

```json
{"code":"unsupported_message_field","param":"messages.0.cache_control"}
```

未静默删除该非标准字段，因此 Chat 不通过稳定版门禁。

## 8. Codex CLI 0.149.0-alpha.4.1

使用隔离 `CODEX_HOME`，provider 仅含标准 `base_url`、API key 环境变量、模型和
`wire_api="responses"`。基础 `codex exec` 在调用 Kiro 前退出 1：

```json
{"code":"unsupported_parallel_tool_calls","param":"parallel_tool_calls"}
```

客户端固定发送 `parallel_tool_calls=false`，而 Kiro 无法保证串行工具语义。
Provider 没有忽略或改写该字段，因此 Codex 的首轮、shell/tool 续轮与跨重启
reasoning 整体门禁仍未通过。

## 9. Claude Code 2.1.209

safe 与 `legacy-user-prefix` 两种服务都只通过标准 `ANTHROPIC_BASE_URL`、token
和模型配置。两次 `claude -p --output-format json` 均退出 1。

服务日志证明每次运行的请求序列为：

1. 首个请求因 `output_config.format` 以 `unsupported_parameter` 拒绝；
2. Claude Code 自动重试，并把 `system` 放进 `messages.1.role`；Anthropic
   Messages schema 只允许 `user` / `assistant`，因此返回 400。

同版本的先前脱敏 wire capture 还包含 `context_management`。这三种语义均不能
在无损情况下被静默删除或搬移。legacy 模式只允许投影合法的指令输入，不会
绕过输出格式、上下文管理或非法消息角色。因此 Claude Code 2.1.209 不通过
稳定版门禁。

## 10. 发布决策

`v0.5.0-rc.1` 适合作为协议保真 RC 发布：核心 OpenAI SDK 子集、OpenCode
Responses 的明确迁移子集、加密 reasoning 回放、连接池与会话亲和均有编译后
服务证据；不支持能力全部 fail-closed。

稳定版 `v0.5.0` 继续阻塞，直到以下真实客户端在不加私有 Header、请求补丁、
字段剥离或提示词补偿的前提下通过：

- Codex：解决或原生等价支持 `parallel_tool_calls=false`；
- OpenCode Chat：有标准且可保真的 `cache_control` 处理方式，或客户端不再发送；
- Claude Code：请求不再依赖 `output_config.format`、`context_management` 或非法
  `messages[].role=system`，或 Kiro 出现经原始事件证明的等价能力。

在这些门禁通过前，不创建 `v0.5.0` 稳定标签，不把 RC 标记为 latest，也不以
兼容性名义恢复提示词拼接、消息合并、字段删除或模型可见补偿文本。
