# Kiro Claude Opus 5.5 目录与请求字段探测

日期：2026-09-26（Asia/Shanghai）

## 结论

Kiro 上游新增 wire 模型 `claude-opus-5.5`，可作为一等目录模型接入：

- 公开 ID `claude-opus-5-5` 映射到 wire ID `claude-opus-5.5`。与不带点的
  `claude-opus-5` 不同，它保留带点的小版本号。
- 上下文 1,000,000 input / 128,000 output；`rateMultiplier` 为 2（2.0x）；
  `supportedInputTypes` 为 `TEXT`、`IMAGE`；`promptCaching.supportsPromptCaching`
  为 true。
- `output_config.effort` 支持完整 `low|medium|high|xhigh|max` 五档，默认
  `medium`，因此进入 `XHIGH_CAPABLE_MODELS`。
- `max_tokens` 支持 1,024 到 128,000，因此进入
  `PROBE_CONFIRMED_MAX_TOKENS_MODELS`。`max_output_tokens` 仍被拒绝。
- Kiro 自身把该模型描述为 “Experimental preview”。

未验证项见文末「已知限制」。

## 方法

- 源码版本：本记录所在提交的工作区。
- 上游操作：`GenerateAssistantResponse`（KiroRuntime，`us-east-1`，
  `origin=AI_EDITOR`，带 profile），以及管理面
  `ListAvailableModels`（`management.us-east-1.kiro.dev`）。
- 隔离边界：`~/.config/kiro-provider/accounts.db` 以 `readonly` 打开，不刷新
  token、不写库；不触碰已安装服务、生产配置和 replay keyring。请求经本机
  `http://127.0.0.1:1080` 代理出网 —— 直连出网时该账号的管理面目录只返回 8 个
  非 Claude 模型，且所有 Claude 模型（含已知可用的 `claude-opus-5`）都返回
  `400 INVALID_MODEL_ID`，所以**不带代理的结果不能作为模型能力证据**。
- 请求正文全部为合成文本，不含用户内容；产物只保留枚举、计数、长度和哈希。
- 可复现命令（账号 access token 剩余有效期需超过 30 分钟）：

```sh
bun run scripts/probe-v3-request-fields.ts --confirm \
  --model claude-opus-5.5 --proxy http://127.0.0.1:1080 \
  --cases control,effort_xhigh,thinking_summarized,thinking_omitted,max_tokens,max_tokens_upper,max_output_tokens
```

## 结果

### 管理面目录

完整条目见
[`evidence/opus-5-5-catalog-probe-2026-09-26/management-catalog.json`](evidence/opus-5-5-catalog-probe-2026-09-26/management-catalog.json)。
其 `additionalModelRequestFieldsSchema` 显式声明：

- `output_config.effort`：`enum = [low, medium, high, xhigh, max]`，`default = medium`
- `max_tokens`：`integer`，`minimum = 1024`，`maximum = 128000`
- `thinking`：`type = adaptive`，`display = summarized | omitted`
- `additionalProperties: false`

同一账号在同一次调用中同时公布 `claude-opus-5.5` 与 `claude-opus-5`，共 21 个
模型，因此 5.5 不是替换 5，而是新增。

### 请求字段

见
[`evidence/opus-5-5-catalog-probe-2026-09-26/request-fields.json`](evidence/opus-5-5-catalog-probe-2026-09-26/request-fields.json)。

| 用例 | 字段 | 结果 |
| --- | --- | --- |
| `control` | 无 | 200 |
| `effort_xhigh` | `output_config.effort=xhigh` | 200 |
| `thinking_summarized` | `thinking=adaptive/summarized` + `max_tokens` + `effort=high` | 200 |
| `thinking_omitted` | `thinking=adaptive/omitted` + `max_tokens` + `effort=xhigh` | 200 |
| `max_tokens` | `max_tokens=1024` | 200 |
| `max_output_tokens` | `max_output_tokens=64` | 400 `REQUEST_BODY_INVALID` |

`max_output_tokens` 的拒绝原因是 schema 不允许该属性，与 `claude-opus-5` 表现
一致。

### 输出 token 范围

见
[`evidence/opus-5-5-catalog-probe-2026-09-26/output-token-bounds.json`](evidence/opus-5-5-catalog-probe-2026-09-26/output-token-bounds.json)。

| `max_tokens` | 结果 |
| ---: | --- |
| 1,024 | 200 |
| 128,000 | 200 |
| 128,001 | 400 `REQUEST_BODY_INVALID`：`must have a maximum value of 128000.0` |

两端均为活体验证，与 `KIRO_OUTPUT_TOKEN_LIMIT_MIN` / `KIRO_OUTPUT_TOKEN_LIMIT_MAX`
一致。

### effort 分档观测

见
[`evidence/opus-5-5-catalog-probe-2026-09-26/effort-levels.json`](evidence/opus-5-5-catalog-probe-2026-09-26/effort-levels.json)。
同一需要推理的合成提问，同一账号，`claude-opus-5` 作对照：

| 模型 | 用例 | reasoning 事件 | reasoning 字符 | 签名 |
| --- | --- | ---: | ---: | ---: |
| `claude-opus-5.5` | 无 effort | 14 | 56 | 1 |
| `claude-opus-5.5` | `effort=low` | 16 | 83 | 1 |
| `claude-opus-5.5` | `effort=max` | 21 | 201 | 1 |
| `claude-opus-5.5` | adaptive summarized + `effort=max` | 14 | 144 | 1 |
| `claude-opus-5` | 无 effort | 12 | 110 | 1 |
| `claude-opus-5` | `effort=low` | 11 | 84 | 1 |
| `claude-opus-5` | `effort=max` | 15 | 107 | 1 |
| `claude-opus-5` | adaptive summarized + `effort=max` | 18 | 164 | 1 |

5.5 上 reasoning 体量随 effort 单调上升，两次独立运行方向一致（首轮为
50 → 69 → 150 字符）。这是单次配对观测而非统计结论；接入 effort 五档的依据是
上游 schema 明确声明的枚举加上 xhigh 返回 200，不依赖该观测。

注意：用极简提问（“Think briefly, then reply …”）时 5.5 在各档都返回 0 个
reasoning 字符，与其 control 一致，容易误判为 effort 无效。必须用真正需要推理的
提问才能观察到差异。

### 已安装客户端

`bun scripts/probe-client-context.mjs --claude-bin "$(which claude)"` 全部 8 个
用例通过（合成 loopback，不打真实模型）。`launcher-opus` 的 `initModel` 为
`claude-opus-5-5[1m]`、上报窗口 1,000,000，客户端发出的 wire 模型为
`claude-opus-5-5`；新增的 `launcher-opus5` 用例覆盖 `claude-opus-5[1m]`，同样为
1,000,000。启动器能发出的七个不同 1M 模型 ID 均已核对。

## 已知限制

- **跨账号 reasoning replay 待探测（本次被限流阻塞）。** `src/core/pipeline.ts` 的
  `VERIFIED_PORTABLE_REPLAY_CELLS` 未包含
  `anthropic-messages:claude-opus-5-5:us-east-1:kiro-runtime:profile:reasoning_text`，
  因此在默认 `reasoning_replay_account_failover: "verified"` 下，Opus 5.5 的
  签名 reasoning 回放保持 owner-bound，不会迁移到其他账号。这是 fail-closed 的
  正确行为，但由于启动器的内置 Opus 行已改指 5.5，默认 kiroclaude 会话相比
  Opus 5 失去了这项跨账号 failover。

  这不是有意排除。补入该 cell 的工具是现成的
  `scripts/probe-replay-portability.ts`，它要求「同区域两个健康账号」做 A→B：

  ```sh
  bun run scripts/probe-replay-portability.ts --confirm \
    --model claude-opus-5.5 --effort max
  ```

  探测时 50 个账号中 49 个处于限流，只有 1 个可用，下一批恢复在约 4.4 小时后，
  因此本次无法运行。账号恢复后按 Opus 5 的同一标准（2026-09-16 的 3/3 通过）
  重跑，通过即可补入该 cell 并更新本记录与
  [`docs/CONFIGURATION.md`](../CONFIGURATION.md) 的说明。
- **未做满 1M 输入验收。** 目录声明 1,000,000 input，本次未做长输入分级探测，
  参考 `claude-opus-5` 的既有结论。
- **原生 Responses 通道未验证。** `RESPONSES_CAPABILITY_EVIDENCE` 未收录该模型，
  因此 Responses 走无状态通道，属 fail-closed。本次经 `/v1/responses` 的尝试返回
  上游 `403 access_denied`，该账号未获 v3 `CreateResponse` 授权，因此无法从这一
  结果推断模型能力。
- **静态 modalities 为家族约定。** `MODEL_CATALOG` 对该模型沿用
  `PDF_MODALITIES`，与整个 opus 家族一致；上游 `supportedInputTypes` 只有
  `TEXT`、`IMAGE`（该枚举本身不含 PDF）。仅在 `dynamic_model_catalog` 为 false
  时可观测，启用动态目录时会被上游值收窄为 text+image。
- **账号覆盖面窄。** 探测期间 50 个账号中 49 个处于限流，因此结果来自单一账号。
  其余账号是否同样公布该模型未逐一核对；provider 的 `eligibleAccounts` 已按各
  账号目录快照过滤调度，未公布该模型的账号不会被选中。
