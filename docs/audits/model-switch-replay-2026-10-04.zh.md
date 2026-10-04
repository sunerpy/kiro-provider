# 模型切换与图片保序验收（2026-10-04）

基线为 `7bf593b644f08f812e4e5715ba2ab986891a293b`。本记录覆盖模型切换修复，
不是完整 Claude 模型矩阵或跨账号可移植性认证。源码与各份消毒证据的
SHA-256 见 [validation.json](evidence/model-switch-replay-2026-10-04/validation.json)；
运行时文件逐一与活体服务加载的源码快照核对。后续探针修改仅收紧错误输出，
没有更改已验证的推理、图片或客户端请求路径。

## 修复与复审边界

新 token 使用 v4/AAD，认证稳定的 wire model identity、租户、完整可见
assistant 输出、来源、key 与 TTL。同一 wire model 的 base/effort/thinking
别名共享身份；v3 仍以原 AAD 在服务器维护的有限别名集中认证。

compatible 模式先完整认证批次，再省略不同 wire model 的 opaque reasoning，
保留可见消息、tool call/result 与冻结指令投影。省略项不授予账号或会话绑定。
公开头为 `x-kiro-reasoning-model-replay-mode: incompatible-omitted`，对应审计只有
`replay_count`。strict 和严格 Responses fidelity 在派发前 typed-reject。
历史工具仍不能授权当前请求未声明的工具。Codex `models` 只展示 base，标准
OpenAI `data` 保留别名；Ultra 的目录字段与推理 effort 规则保持不变。

完整 ingress、加密 reasoning、可见 assistant 和工具历史的修复前回归有
6 个对照通过、15 个切换失败；失败为目标 400。修复后回归进入常规测试套件，
同时覆盖错误租户、输出篡改、严格模式、移除当前工具声明和流式终止。

## 真实入口证据

| 入口 | 验收 | 消毒证据 |
| --- | --- | --- |
| OpenAI SDK | 36/36：v4/v3、base/后缀/跨模型、stream/非 stream、签名 reasoning、工具历史、精确标记与兼容头 | [SDK 矩阵](evidence/model-switch-replay-2026-10-04/sdk-matrix.json) |
| Codex 0.159.3 | capture 门禁通过；5 组首轮与 resume，共 10 轮成功且保留标记 | [CLI](evidence/model-switch-replay-2026-10-04/codex-cli.json) |
| Codex `/model` | 网关目录实际加载；显示 Opus 5.5，选择 low 后真实 Responses 返回标记 | [picker](evidence/model-switch-replay-2026-10-04/codex-picker.json) |
| Claude Code 2.1.285 | Opus 5.5 max→low、Fable→Opus 5.5，共 4 轮成功；首轮已有 signed thinking 与完成的工具回合 | [effort](evidence/model-switch-replay-2026-10-04/claude-effort.json)、[跨模型](evidence/model-switch-replay-2026-10-04/claude-cross-model.json) |
| 图片拆分 | Opus 5.5/Fable，stream/非 stream 与 signed replay，8/8；模型实际返回相同标记/颜色顺序 | [图片顺序](evidence/model-switch-replay-2026-10-04/image-order.json) |

v3 活体只用探针自己的 key 重新封装刚返回的真实签名材料，没有复制生产 token
或伪造上游签名。隔离 gateway 使用独立端口、key 与状态副本；宿主生产策略未
修改。Claude 的 managed policy 在临时容器内保留限制，只把临时副本 endpoint
指向 capture。门禁证明请求到达指定端口后才允许转发生成。

Claude 会先尝试消息级 `output_config`；网关在派发前拒绝该不支持形状，客户端
回退后成功。证据保留这项预检 400 计数。图片探针使用 16000 输出预算与 max
effort；它只证明表中模型和请求形状。SDK 中一次过期隔离凭据、一项不合法的
生成工具参数及较小图片预算的未完成样本没有被当作通过；最终矩阵使用合法
schema 与有效的只读凭据快照重新完成，没有弱化网关断言。

复审后 `make pre-ci` 为 2756 PASS / 0 FAIL，行覆盖率 95.52%（门槛 93%）。
本地编译二进制另用合成 AWS EventStream 上游验证同一完整 SDK 矩阵：
36/36 切换单元、42 次派发、36 次工具历史保留断言通过，另有 4 个 signed
prefix 边界回归通过；这些验证的真实上游请求数为 0。
见 [编译后二进制矩阵](evidence/model-switch-replay-2026-10-04/packaged-model-switch.json)
与 [前缀边界](evidence/model-switch-replay-2026-10-04/packaged-prefix.json)。

## 仍 OPEN 的上游问题

Claude Opus 5.5→Opus 5 不再出现 replay context mismatch，但 Opus 5 的已完成
工具历史可能收到 `upstream_stream_incomplete`。独立同模型探针复现：首轮
signed thinking+tool call 为 200，当前 tool result 续接为 200；追加 assistant
最终回答与下一轮用户消息后，保留或移除 signed thinking 都是 502。
见 [同模型对照](evidence/model-switch-replay-2026-10-04/opus5-completed-history-open.json)。

相同完整请求在 Opus 5.5 成功；已排除单纯旧 token 认证、会话 binding、当前
工具 schema、中间 system、单轮预算、legacy projection 和未探测的 native
capability。可见证据不能确定上游内部原因。没有删除历史、降低 effort 或扩大
签名兼容范围来规避；Claude 全矩阵仍未通过。

可重复入口为 `scripts/probe-model-switch-replay.ts`、
`scripts/probe-client-model-switch.ts` 与 `scripts/probe-image-run-order.ts`。
参数见 [Codex](../CODEX.md#model-and-effort-switching) 与
[Claude Code](../CLAUDE_CODE.md)。所有探针拒绝生产端口，证据输出必须位于仓库外；
这里仅保留经核对的枚举、计数、布尔结果、SHA-256 和合成标记。
