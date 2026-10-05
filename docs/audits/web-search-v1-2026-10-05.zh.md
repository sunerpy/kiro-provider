# 联网搜索 v1 实现验收（2026-10-05）

基线为 `0691fafd3b665bd556baf4a40368f84c2ef3a785`（3.7.3）。活体证据绑定的源码树指纹
（`src`、`scripts`、`__tests__`、`package.json`、`bun.lock`、`tsconfig.json`、
`config.example.json`，不含文档）、打包 binary 输入的指纹与 binary 的 SHA-256 见
[validation.json](evidence/web-search-v1-2026-10-05/validation.json)。行为与配置见
[Web search](../CONFIGURATION.md#web-search)。本记录不是发布证明。

## 范围

provider 自行通过 KiroRuntime `InvokeMCP` 执行实时搜索，覆盖 OpenAI Responses
（`web_search`、`web_search_2025_08_26`）与 Anthropic Messages（`web_search_20250305`）：
多轮执行循环、canonical v2、引用、租户绑定的加密快照、按生成分段的 reasoning 回放、
mixed 与 `pause_turn` 续接、当前声明授权、预算、取消与 lease 清理。默认关闭；缓存搜索、
preview、地理位置、图片搜索与 Fast 继续 typed rejection。能力单元为两种协议 ×
`gpt-5.6-sol` / `claude-opus-5.5` × `us-east-1`，四个单元均通过下文的真实验收。

## 证据

| 项目 | 结果 | 消毒证据 |
| --- | --- | --- |
| 修改前回归 | 同一个 reproducer（`scripts/reproduce-web-search-baseline.ts`，只静态引用基线已有模块）在 `git archive` 导出的基线树上 4 个完整入口用例全部 400，0 次生成、0 次 MCP 调用；在实现上 4 个全部 200，各 2 次生成、1 次搜索 | [baseline-failure](evidence/web-search-v1-2026-10-05/baseline-failure.json) |
| 后端 RPC | `tools/list` 与 2 次搜索通过；超长查询为 JSON-RPC `-32602`，映射 `invalid_tool_input`；空白查询本地拒绝不派发 | [rpc](evidence/web-search-v1-2026-10-05/rpc.json) |
| OpenAI SDK / HTTP 矩阵（打包 binary） | 首轮 12/12：双协议 × 双模型 × stream/非 stream/mixed，四个 mixed 用例都真实产生了“搜索 + 客户端调用”同组，续接成功；重启后 36/36：下一用户轮、Codex 形状回放、effort 别名、跨模型（`incompatible-omitted`）与篡改拒绝 | [首轮](evidence/web-search-v1-2026-10-05/sdk-matrix-first.json)、[重启后](evidence/web-search-v1-2026-10-05/sdk-matrix-resume.json) |
| Codex 0.159.3（`web_search="live"`） | capture 门禁通过；搜索轮带 `url_citation`；两个会话中都有响应同时含 `web_search_call` 与 shell `function_call`，Codex 回放该组与输出后 200，client-tool 会话最终答案含版本与本地 marker；网关重启后两个会话的 resume、effort 切换与切到 Opus 5.5 均成功 | [首轮](evidence/web-search-v1-2026-10-05/codex-first.json)、[续接](evidence/web-search-v1-2026-10-05/codex-resume.json) |
| Claude Code 2.1.285（WebSearch，未加 `--bare`） | capture 门禁通过；WebSearch 子请求由 provider 执行并返回结果与引用；主循环 signed thinking 与 WebSearch tool turn 持续回放；重启后 resume、effort 切换与切到 GPT 5.6 Sol 均成功 | [首轮](evidence/web-search-v1-2026-10-05/claude-first.json)、[续接](evidence/web-search-v1-2026-10-05/claude-resume.json) |
| 旧 binary | 3.7.3 打开 v8 数据库副本：`/health`、`/ready`、普通 Messages 均成功，托管工具仍 400；`user_version` 保持 8，快照行数不变 | [old-binary](evidence/web-search-v1-2026-10-05/old-binary.json) |
| 本地质量 gate | `make pre-ci` 全部通过，测试数与行覆盖率见索引（门槛 93%） | [validation.json](evidence/web-search-v1-2026-10-05/validation.json) |

隔离网关使用独立端口与配置、新 keyring、`account_maintenance_enabled:false`，账户库只含
只读复制的访问 token，refresh token 替换为占位值，隔离网关无法轮换原有凭据。网关重启前用
`--refresh-existing` 把已刷新的访问 token 复制进同一份隔离状态。Claude Code 在隔离的命名空间中
运行，只指向 capture 端口。所有证据只含枚举、计数、布尔值与哈希，不含查询、URL、标题、摘录、
提示词或 token。

## 验收与审查中发现并修复的缺陷

每个缺陷都有常规 suite 中的回归测试，修复前失败、修复后通过；修复后用重建的打包 binary
重跑了上表的全部活体验收。

- 真实 Codex 续接搜索轮时返回 400 `reasoning_replay_context_mismatch`
  （[修复前记录](evidence/web-search-v1-2026-10-05/codex-resume-before-fix.json)）。Codex 按
  `output_item.done` 的到达顺序记录 item，按位置切分会把每代 reasoning 归入下一代。现在同一代
  的 Responses item id 共享生成密钥，回放按密钥切分。
- mixed 续接：Messages 未校验组内每个客户端调用都有结果；Responses 把同一代的搜索与 function
  call 投成不同 assistant 轮。现在缺少结果即拒绝且不派发，同一代按 Kiro 实际生成的一轮回放。
- 取消：consumer cancel 未中止进行中的搜索却释放 lease；首次读取前取消 body 时第一代上游未关闭。
  现在取消先中止搜索与生成、等待退出并把未落定的调用记为 uncertain，然后才释放 lease。
- owner 绑定：只有 pending 调用固定 owner。现在任何已认证的搜索历史都固定账户、区域、profile
  与 conversation，不同 owner 的历史被拒绝。
- 快照生命周期：同组调用逐个记录与 claim，失败或并发续接可能拆开一组，已执行的搜索无法回滚；
  TTL 延长失败被忽略。现在整组在一个事务中 claim 后才执行，无法回滚的调用转为 uncertain，
  TTL 延长失败返回 typed 503。
- `count_tokens` 还原历史时绕过共享请求字节预算，现已计入。
- 一次 GPT 非 stream Messages 请求的第三代上游 122 秒后才返回响应头，harness 的隐式 fetch 超时
  先放弃。harness 改为与网关请求期限一致的显式上限并按用例记录失败；表中为重跑结果。

## 已知限制与 OPEN 项

- Claude Code 首个请求携带消息级 `output_config`，网关在派发前拒绝，客户端回退后
  成功；这是既有行为，与搜索无关，证据保留该 400 计数。
- 模型可能输出指向同一站点但未被检索的页面链接；按设计这类链接不生成引用。
- Messages 历史依赖 provider 快照，超过 `web_search_replay_ttl_ms` 的历史被拒绝，
  与 Anthropic 自包含的加密内容不同。
- 搜索历史固定在记录它的 owner（账户、区域、profile、conversation）上；owner 不可用时返回
  `web_search_replay_owner_unavailable`，不会迁移到其他账户。
- 回滚到不含联网搜索的版本前须删除配置中的 `web_search_*` 键，旧版严格校验会拒绝启动。
- Opus 5 完成工具历史后的下一用户轮可能出现上游 `upstream_stream_incomplete`，
  仍为 OPEN（见 [2026-10-04 记录](model-switch-replay-2026-10-04.zh.md)）；Opus 5
  不是本期能力单元。
- 原生 KiroRuntime Responses lane 在验收账户上仍返回 403；托管搜索固定走 stateless lane。

可重复入口：`scripts/reproduce-web-search-baseline.ts`（修改前与实现对照）、
`scripts/prepare-web-search-gateway.ts`（隔离状态）、`scripts/probe-web-search-live.ts`
（SDK/HTTP 矩阵）、`scripts/probe-web-search-clients.ts`（真实客户端）、
`scripts/probe-web-search-rpc.ts`（后端 RPC）。全部拒绝生产端口与仓库内输出路径。
