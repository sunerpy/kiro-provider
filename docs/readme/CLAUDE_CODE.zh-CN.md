# 在 Claude Code 中使用 kiro-provider

简体中文 · [English](../CLAUDE_CODE.md)

kiro-provider 提供 Claude Code 所需的两个 Anthropic 兼容端点：

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`——返回估算值，并带有
  `x-kiro-token-count-mode: estimate`

希望长期使用独立 Claude home 时，参见[独立客户端入口示例](CLIENT_LAUNCHERS.zh-CN.md)。
下面介绍的是仓库启动器有意保留的共享状态默认行为。

## 使用共享 Claude 状态启动 Kiro 会话

先确认本地网关正常且已有可用账号：

```bash
curl -fsS http://127.0.0.1:8787/health
curl -fsS -H "Authorization: Bearer $(scripts/kiroclaude-token)" \
  http://127.0.0.1:8787/ready
```

再通过仓库内的启动器运行 Claude Code：

```bash
PATH="$PWD/scripts:$PATH" kiroclaude -p 'Reply with exactly: KIROCLAUDE_OK'
```

默认情况下，`kiroclaude` 不改变 Claude 原生配置解析，通常仍使用 `~/.claude`
和 `~/.claude.json`。原有 settings、skills、commands、plugins、MCP、CLAUDE.md、
历史和会话因此可同时用于 `claude` 与 `kiroclaude`。

启动器只为当前进程传入高优先级 `--settings` overlay。Kiro 模式会明确关闭继承的
Bedrock、Vertex、Foundry 和 Mantle 路由，清空继承的 Anthropic 与 Bedrock bearer
凭据，再选择本地网关与模型别名。它不会修改原生 settings 文件，所以普通
`claude` 进程仍使用原有 provider。

如果编排器在参数末尾追加其他 `--settings` 文件或内联对象，启动器会先
合并其中与路由无关的字段，再应用 Kiro overlay。这样主会话及其子 agent 的路由与
认证始终以启动器配置为准。合并后的文件内容通过仅 owner 可读的匿名文件描述符
传递，不进入进程命令行，避免 caller settings 中的凭据被 `ps` 暴露。

Kiro 模式还在 overlay 中设置 `showThinkingSummaries: false`，防止共享 Claude
设置或 caller settings 文件为不支持摘要的网关模型选择 `thinking.display:
"summarized"`。请求采用 `omitted` 显示，保留所选 effort 与 signed reasoning 回放。
显式 `--thinking-display` 参数与管理员 managed setting 仍优先；若它们选择摘要，
可用 `--thinking-display omitted` 指定兼容显示方式。原生 Bedrock 模式保留 Claude
自身的摘要设置。Kiro 模式还关闭 `CLAUDE_CODE_THINKING_DISPLAY_UPDATES`，
避免 Claude Code 2.1.294 先请求未支持的 `updates` 显示、被拒后再重试。

共享历史不代表 provider 专用签名可以互通。如果旧续轮包含另一个 provider 无法
回放的 signed thinking，在原生 Bedrock 与 Kiro 之间切换时应新建会话。

Release installer 目前不安装这些辅助脚本。临时测试可直接从 checkout 运行；确定
长期使用后再自行复制或建立链接。

### 隔离真实客户端 capture 门禁

`KIROCLAUDE_BASE_URL` 和 `--settings` 不能覆盖管理员 managed settings 中的
`ANTHROPIC_BASE_URL`。活体探针必须先证明 capture proxy 收到了请求，门禁失败
即停止转发推理。保留已安装服务与宿主策略；宿主策略锁定生产端口时，使用
单独容器/namespace，保留策略权限和 provider 限制，仅将临时策略副本的 endpoint
指向 capture 端口。`--managed-policy-copy` 只接受临时目录下无符号链接的真实副本。

```bash
bun scripts/probe-client-model-switch.ts --client claude \
  --claude-bin /absolute/path/to/claude \
  --base-url http://127.0.0.1:TEST_PORT \
  --provider-config /private/probe/config.json --out /private/probe/claude.json
```

使用独立 key/账号状态副本与新的客户端配置目录。脚本在 resume 前验证已返回
signed thinking 和完成的 tool turn；区分原生 signature 与 provider `kr2_`，因为
Claude 切换实际模型时可能过滤旧 thinking。2.1.285 还会探测消息级 `output_config`：
该未支持字段在派发前按 typed error 拒绝，客户端随后发出普通请求。报告保留
拒绝次数，不能把该探测算作推理请求。

`probe-image-run-order.ts` 使用隔离网关检验模型实际观察到的文字/图片顺序，覆盖
stream/非 stream Messages 与 signed reasoning 续接。请以 max effort 和 16000 的输出预算
运行：预算为 2048 时，运行可能在可见输出之前结束。

## 默认值与覆盖方式

| 设置                   | 默认值                                        |
| ---------------------- | --------------------------------------------- |
| 网关根地址             | `http://127.0.0.1:8787`，不能带 `/v1`         |
| Claude 状态            | 共享原生 `~/.claude` 与 `~/.claude.json`      |
| 模型                   | Opus 5.5，客户端上下文窗口 1M                 |
| 推理模式               | Ultra，即 Ultracode：`xhigh` 加 workflow 编排 |
| 思考显示               | `omitted`（`showThinkingSummaries: false`）   |
| 权限模式               | 继承 Claude 原生设置；启动器默认不覆盖        |
| 离开后的 recap         | 关闭                                          |
| 标题、分类等非必要流量 | 关闭                                          |
| Experimental betas     | 开启                                          |

需要调整时，只覆盖当前进程。仅在明确需要隔离 Claude home 时设置
`KIROCLAUDE_CONFIG_DIR`：

```bash
KIROCLAUDE_BASE_URL=http://127.0.0.1:18787 \
KIROCLAUDE_CONFIG_DIR=/tmp/kiroclaude-profile \
KIROCLAUDE_MODEL=sonnet \
KIROCLAUDE_EFFORT=high \
PATH="$PWD/scripts:$PATH" kiroclaude
```

`KIROCLAUDE_EFFORT=ultra` 是默认值，启用 Claude Code 的 Ultracode：以
`output_config.effort: "xhigh"` 运行，并常驻动态 workflow 编排；启动器同时写入
一致的 `effortLevel: "xhigh"`。设置为 `low`、`medium`、`high` 或 `xhigh` 时，
写入对应的 `effortLevel` 并关闭 Ultracode。

`max` 同样关闭 Ultracode，但 Claude Code 2.1.280 的持久化 `effortLevel` 只接受
`low` 到 `xhigh`，其他值会被静默丢弃；此前写入的 `effortLevel: "max"` 因此在
wire 上变成了 `medium`。现在启动器改为在调用参数之前传入会话级参数
`--effort max`。子 agent 继承这一会话档位；命令行里更靠后的显式 `--effort`
仍然优先，因为 Claude 以最后一个为准。任何显式会话 effort 都会关闭 Ultracode，
所以 Ultra 不会附加该参数。已安装客户端的结果见
[修复前后的 effort 矩阵](../audits/evidence/kiroclaude-max-effort-2026-09-26/effort-matrix.json)。

启动器默认不提升权限，而是继承 Claude 原生权限策略。只有显式设置
`KIROCLAUDE_PERMISSION_MODE` 时才覆盖，可选 `acceptEdits`、`auto`、
`bypassPermissions`、`manual`、`dontAsk` 或 `plan`。只有显式选择
`bypassPermissions` 才会跳过危险模式确认。该模式会移除 Claude 审批提示，但不会
创建操作系统沙箱，只应在可信工作区或已有外部隔离时使用。Claude CLI 的
`--permission-mode plan` 等参数仍可覆盖单次启动。

启动器将 `kiroclaude-token` 注册为 Claude Code 的 `apiKeyHelper`。该 helper 从
`${XDG_CONFIG_HOME:-$HOME/.config}/kiro-provider/config.json` 读取第一个非空
`api_keys`，也可通过 `KIROCLAUDE_PROVIDER_CONFIG` 指定其他文件。文件不属于当前
用户或对其他用户开放时，helper 会拒绝读取；API key 也不会进入工具子进程的环境
变量。

## 选择模型

内置 Opus 和 Sonnet 行分别映射到 `claude-opus-5-5[1m]` 与
`claude-sonnet-5[1m]`。Haiku／small-fast 行也有意映射到
`claude-sonnet-5[1m]`：Claude Code 会用该槽位执行 prompt hook，并发送正整数
`max_tokens`，而 Kiro Haiku 4.5 会拒绝所有 `additionalModelRequestFields` 对象。
该映射会消除 Haiku 特有的拒绝。Claude Code 2.1.280 的会话标题生成和 prompt hook
还会发送 `output_config.format`。Messages 识别两个有界本地 profile：会话标题使用
`single-string-object-v1`，`hook_prompt` 和内置 `/goal` 评估器使用
`hook-evaluation-v1`（`ok`／`reason`／`impossible`）。两者均在发布前校验输出；
任意 JSON Schema 仍不支持。Fable 行映射到 `claude-fable-5-1[1m]`，
实际 Kiro wire ID 为 `claude-fable-5.1`。启动器还会在 picker 中加入
`claude-opus-5-5[1m]`、`claude-opus-5[1m]`、`gpt-5.6-sol[1m]`、
`gpt-5.6-terra[1m]` 和 `gpt-5.6-luna[1m]`。

`claude-opus-5-5` 对应的 Kiro wire ID 是 `claude-opus-5.5`，与不带点的 Opus 5
不同，它保留了带点的小版本号。其活体目录条目声明 1M 输入窗口、128K 输出、图像
输入、2.0x 倍率、prompt caching，以及把 `output_config.effort` 声明为完整
`low|medium|high|xhigh|max` 枚举、`max_tokens` 取值 1,024 到 128,000 的
`additionalModelRequestFieldsSchema`。Kiro 仍将其标注为实验性预览版。内置 Opus
行指向它，使 `opus` 家族别名解析到当前旗舰；同一个 ID 还会作为一行标名
`Claude Opus 5.5` 的 picker 行再声明一次，启动器钉住的会话模型也是这一行。两行
指向同一个模型是有意的：正是这一行标名的 picker 行让客户端显示确切版本，而不是
笼统的 Opus 标签。Opus 5 仍可通过自己的 picker 行和 `KIROCLAUDE_OPUS5_MODEL`
访问，`KIROCLAUDE_MODEL=opus` 则选择家族别名。

### 会话标题与 `output_config.format`

Claude Code 2.1.280 通过一个 `/v1/messages` 旁路请求生成会话标题：thinking
关闭、工具列表为空、只有一条 user message，并在 `output_config.format` 中携带
`{ type: "json_schema", schema }`，其根 object 恰好有一个 required string 属性
（`title`）且 `additionalProperties: false`。Messages 将这一形状的
`output_config.format` 识别为有界本地 `single-string-object-v1` profile：根 object、
恰好一个 required string 属性、`additionalProperties: false`，以及本地 1-256
字符边界（显式整数 `minLength`/`maxLength` 必须落在该范围内）。Schema 不会发往
上游，也不会注入任何 prompt。Kiro 仍生成普通文本；Provider 先缓冲、去除首尾
空白、剥掉包住整段输出的单个 Markdown 代码围栏，再包装成 `{"title":"..."}`
（上游若已返回带同名属性的 JSON object 或 JSON string，会归一而不是二次包装），按 `maxLength` 个 code point 截断，本地验证通过后
才发布恰好一个包含该 JSON 的 text block，`stop_reason` 为 `end_turn`。成功响应带
`x-kiro-structured-output: single-string-object-v1`。`output_config.effort` 可与
`format` 同时使用；其他任何 `output_config` 键（例如 `task_budget`）仍返回
`unsupported_parameter`，message 内的 `output_config` 仍返回
`unsupported_message_field`。

该 profile 采取 fail closed。未识别的 Schema 形状、开启 thinking、或与 `format` 同时
出现的强制 `tool_choice` 返回 `400 unsupported_structured_output`。上游工具调用、
thinking 已关闭时仍返回的上游 reasoning、超过 64 KiB 的输出，或无法满足 profile
的空文本返回 `502 structured_output_unexpected_tool_call`、
`structured_output_unexpected_reasoning`、`structured_output_buffer_exceeded`
或 `structured_output_validation_failed`（流已提交后则是 SSE `api_error` 事件）。
验证前不会发布任何部分文本，验证失败也不会触发第二次推理。该 profile 不受
`responses_fidelity_mode` 控制，该配置只作用于 Responses 通道；Claude Code 没有
其他获取标题的途径。若某个会话的输入只有 slash command（例如 `/model`）或不足
10 个字符的提示词，标题仍显示首条输入，因为这种情况下 Claude Code 根本不会请求
标题；升级 Provider 也不会改写既有 transcript。

### Goal 与 prompt hook 评估

Claude Code 2.1.285 的 Stop／Goal 评估请求使用 `/v1/messages`，关闭 thinking、
不声明工具，并在 `output_config.format` 中携带以下 schema：

```json
{
  "type": "json_schema",
  "schema": {
    "type": "object",
    "properties": {
      "ok": { "type": "boolean" },
      "reason": { "type": "string" },
      "impossible": { "type": "boolean" }
    },
    "required": ["ok", "reason"],
    "additionalProperties": false
  }
}
```

Messages 将这个精确形状识别为 `hook-evaluation-v1`，原样转发客户端评估指令，
最多缓冲 64 KiB。完整输出必须是符合这些字段的 JSON object；允许剥掉包住整段
JSON 的单个 Markdown 围栏。Provider 保留两个布尔值、完整 reason，以及
`impossible` 未提供的状态，不将自然语言推测为决策，不补默认值、不做类型转换、
不截断 reason。缺少字段、额外字段、重复 JSON key 或错误类型返回
`structured_output_validation_failed`。标题 profile 的工具、reasoning、取消与超时
保护同样适用。Schema 不发往上游，也不加入新指令或第二次推理。

JSON 和 SSE 成功响应均只包含一个已校验的 text block，并带
`x-kiro-structured-output: hook-evaluation-v1`。根据
[Claude hook 契约](https://code.claude.com/docs/en/hooks#response-schema)，
`ok: false` 让 Stop／Goal 将 reason 传回主模型继续执行；`ok: true` 允许结束；
`ok: false, impossible: true` 允许结束无法满足的条件。后续决策和工具循环由
Claude Code 负责。评估错误仍是明确的 API／SSE 错误，不会被转换成完成判断。

可执行探针 `scripts/probe-claude-goal.ts` 默认使用隔离的 Claude home 和合成上游。
`--native-goal` 验证真实 `/goal` 命令，包括过早停止、评估反馈、Bash 检查及最终
评估。`--live-base-url` 与 `--provider-config` 仅将评估请求转发到隔离 gateway；
宿主 managed settings 需要独立网络环境时，可用 `--live-unix-socket` 连接私有代理。

Claude Code 的 gateway discovery 会过滤掉 ID 中不含 `claude` 或 `anthropic`
的模型，所以这三个 GPT 行需要显式声明。两个 Claude Opus 行本身能通过该过滤，但
仍显式声明，否则自动发现的行会使用默认窗口而不是 `[1m]` 声明的窗口。所有显式声明的 picker
行都以 `behavesAs: "claude-opus-5"` 作为客户端能力模板，从而获得 adaptive
thinking 和左右切换 effort 的能力，无需为每个 effort 档位重复模型。`[1m]` 后缀让
Claude Code 使用声明的 1M 窗口，客户端发请求前会去掉后缀。已用实际安装的客户端
核对它能发出的七个不同 1M 模型 ID（`claude-opus-5-5`、`claude-opus-5`、
`claude-sonnet-5`、`claude-fable-5-1` 和三个 GPT 行），家族别名和钉为会话模型的
确切 ID 两条路径都已核对；small-fast 行继承 Sonnet 的 1M 窗口。仅有服务端模型
目录不会自动改变客户端窗口，输出预留仍会减少可用输入预算。

Kiro overlay 同时设置 `autoCompactWindow: 1000000`，让网关模型主动压缩；
Claude 会按当前模型窗口限制该值，并为输出和压缩保留空间。仍可使用
`--autocompact` 或 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 覆盖单次启动。
原生设置文件与独立 Bedrock overlay 不受影响。

显式 `KIROCLAUDE_*_MODEL` 覆盖值会原样保留；自定义 ID 确实支持更大窗口时，
请在覆盖值中带上 `[1m]`。`KIROCLAUDE_OPUS_MODEL` 会同时改写内置 Opus 行、标名
`Claude Opus 5.5` 的 picker 行和默认会话模型，因此
`KIROCLAUDE_OPUS_MODEL=claude-opus-5[1m]` 可恢复 3.6.0 之前的默认值；
`KIROCLAUDE_OPUS5_MODEL` 只改写 Opus 5 那一行。
`KIROCLAUDE_HAIKU_MODEL` 仍是显式逃生口，但目标模型必须接受 Claude Code 必填的
正整数 `max_tokens`，否则 prompt hook 仍会失败。这一变化仅适用于 Kiro 启动器，
独立 Bedrock 模式不变。

可在 checkout 中运行实际客户端回归探测：

```bash
bun scripts/probe-client-context.mjs --claude-bin /path/to/claude
bun scripts/probe-client-context.mjs --claude-bin /path/to/claude \
  --thresholds --cases 1m-old-threshold,1m-above
bun scripts/probe-client-context.mjs --claude-bin /path/to/claude --tool-loop
bun scripts/probe-client-context.mjs --claude-bin /path/to/claude --effort-matrix
```

脚本使用本地假 API、假凭据和临时 Claude 状态，不调用真实模型；检查模型 ID、
有效窗口、大输入是否完整发出，以及自动压缩事件。输出仅含元数据和计数；
上游实际容量仍需独立实测。
`--tool-loop` 会执行两次无副作用的 `Bash true`，比较已发送前缀与下一轮历史。
`--effort-matrix` 检查每个 `KIROCLAUDE_EFFORT` 取值在 wire 上的 effort 与
Ultracode 状态、命令行 `--effort` 覆盖，以及一个 max 档位的合成子 agent；加上
`--launcher /path/to/kiroclaude` 可检查已安装的副本。

Kiro overlay 使用 `CLAUDE_CODE_TOASTY_THIMBLE=0` 和
`CLAUDE_CODE_GENTLE_PARASOL=0`，关闭 Claude Code 2.1.270 中不保留在后续历史里的
临时批处理提醒和次级提醒。若把它们投影为 Kiro user 文本，后续缺失就会破坏
Fable 的签名前缀。这些设置仅作用于当前进程；升级 Claude Code 时，应重新运行
`--tool-loop` 验证。

启动器还会声明 `claude-code-bash-v1` 兼容模式，并发送工作目录的 SHA-256 哈希，
二者绑定在 provider 的加密回放记录中。Claude 的 Bash 工具会在存储历史前移除
指向相同目录的字面量 `cd` 前缀；网关只比较这个已验证的归一形式，仍绑定命令
后缀、其余参数、工具名称／ID、租户、模型和 replay owner。Header 不发送目录
原文。切换到其他目录、变量展开和未识别的改写仍严格校验；工具执行目录改变时，
客户端须提供对应上下文，网关不会从提示词猜测目录。

Claude Code 还会发送正整数 `max_tokens`（验证过的 GPT 请求为 64,000），但 Kiro
GPT stateless schema 会拒绝已测试的所有上游 output-token 字段。启动器因此发送：

```text
X-Kiro-Output-Token-Limit-Mode: advisory
```

该声明只对三个 GPT-5.6 模型生效。Provider 会在请求 Kiro 前移除 `max_tokens`，
记录 `anthropic_output_token_limit_unenforced`，并返回
`x-kiro-output-token-limit-mode: advisory-unenforced`。缺少或错误的 header、非
GPT 请求仍会 fail closed。它也不会改变 OpenAI Responses、Chat Completions、
其他 Anthropic 客户端或普通 `claude` 命令的行为。

私有模型目录可通过 `KIROCLAUDE_SOL_MODEL`、`KIROCLAUDE_TERRA_MODEL` 和
`KIROCLAUDE_LUNA_MODEL` 覆盖这三个 ID。`KIROCLAUDE_KIRO_FABLE_MODEL` 可覆盖
Kiro Fable 映射，不影响独立的原生 Bedrock 备用后端。

### 通过原生 Bedrock 使用 Fable 5.1

Kiro 已通过 `/v1/responses` 和 `/v1/messages` 提供 Fable 5.1。它使用无状态
Responses 投影，因为 Kiro 原生 `CreateResponse` 当前拒绝该模型；已存储续轮
仍由 Provider 自有 continuation 和 replay 状态支持。

Fable 5.1 与 Opus 5.5 的 Messages adaptive thinking 默认采用原生 `omitted`
显示方式，通常仍保留并通过 opaque signature 回放签名推理。Fable 5.1 与
Opus 5.5 的显式 `thinking.display: "summarized"` 会原样保留，包括所选 effort、
可见摘要与完整原生签名；其他模型继续拒绝摘要显示。
Kiro 可能返回多段分别签名的摘要；
网关会拒绝这个尚不支持的形态，不会拼接签名或丢弃推理来绕过错误。

这两个模型如果只在空签名推理前缀中发生冲突，网关会先完整校验前缀，限额为
128 个事件和 1 MiB，再省略整个冲突前缀。响应带
`x-kiro-reasoning-replay-mode: conflict-omitted`，审计只记录计数。此恢复会丢失该次
输出的不透明推理回放，保留可见文本、工具调用、后续工具结果和 `max` 推理级别。
完全相同的重复签名仍正常回放；非空、redacted、混合、超限或迟到的冲突仍报错，
网关不会通过重试已经接受的生成来恢复。

Kiro 不可用或明确需要 AWS 原生通道时，可使用独立进程启动 Bedrock 备用后端：

```bash
PATH="$PWD/scripts:$PATH" kiroclaude --bedrock-fable
```

该模式使用同一个共享 Claude home、`model: "fable"`、以 `--effort max` 传入的
max effort、
`AWS_PROFILE=us-claude`、`AWS_REGION=us-east-2` 和
`ANTHROPIC_DEFAULT_FABLE_MODEL=us.anthropic.claude-fable-5-1`，不会设置 Kiro token
helper 或 `ANTHROPIC_BASE_URL`。对应覆盖项为 `KIROCLAUDE_AWS_PROFILE`、
`KIROCLAUDE_AWS_REGION`、`KIROCLAUDE_FABLE_MODEL` 和
`KIROCLAUDE_FABLE_EFFORT`。
进程 overlay 会先清除继承的自定义 Anthropic、Vertex、Foundry 和 Mantle 路由，
再启用 Bedrock；skills 等其他原生设置仍然共享。

Kiro 与 Bedrock 之间的切换需要启动新进程；如果之前的 signed thinking 属于特定
provider，还应新建会话，不能在已有会话中当作普通模型切换。Kiro 进程内可以
直接选择内置 `fable` 别名，或设置 `KIROCLAUDE_MODEL=fable`。

## 兼容边界

适配器接受 Claude Code 2.1.270 中已经观察到的请求形态：

- 文本、base64 图片、标准工具、`tool_use`、`tool_result` 和 `is_error`；
- 每条 user message 中一个或多个带图片的 `tool_result`，并保留工具身份、状态、
  文本和图片块顺序；
- 图片或 tool result 两侧构成一个连续文本簇的相邻文本块；
- 顶层及会话中途的 system 文本，按既有 projection mode 投影；
- adaptive thinking、`output_config.effort` 和 Claude 路径支持的 `temperature`；
- GPT effort 投影到 `reasoning.effort`，Claude effort 保持
  `output_config.effort`；
- 通过 opaque `kr2_` signature（兼容读取历史 `kr1_`） 加密回放被隐藏的 signed thinking；
- 隐藏 GPT-5.6 纯省略号 reasoning，包括 `"." + "." + "."` 分片，并在续轮时
  精确恢复已存储的原始块；
- 将 prompt-cache marker 作为性能提示并通过 `x-kiro-prompt-cache-mode` 报告；
  默认使用 server-auto，显式 checkpoint 受能力门控，只返回上游实测 cache 用量；
- 无损的 `clear_thinking_20251015` / `keep: "all"` `context_management`，返回
  `applied_edits: []`；
- Anthropic SSE 顺序、流内错误、背压、上游静默期间的 `ping`，以及
  `x-claude-code-session-id` affinity；
- 启用 `web_search_enabled` 后，WebSearch 工具的一次性子请求
  （`web_search_20250305`、`max_uses`、`tool_choice: auto`）由 provider 自行执行
  搜索，并返回 `server_tool_use`、`web_search_tool_result` 与带引用的文本。
  `claude --bare` 会禁用 WebSearch。见[联网搜索](CONFIGURATION.zh-CN.md#联网搜索)。

Kiro tool result 内容只支持 text/JSON，因此其中的图片会按稳定顺序提升到同一个
Kiro user turn。多个含图结果会保留每个 tool result、状态、文本与图片字节，但 wire
无法编码逐图对应的工具关联；响应会用
`x-kiro-tool-result-image-mode: multiple-lifted` 显式暴露该有界损失，并记录只含数量的
审计事件。普通 user 图片与图片型 tool result 混用仍会被拒绝。
携带 launcher 完整且已认证的归一化上下文时，直接 `text → image → text` 可以
按连续 Kiro 用户消息投影，也支持其前面的一组纯文本工具结果，其后从文字段开始。
总计最多 16 段，包含工具结果组。其他混合交错仍会被拒绝：Kiro 只有一个文本字段。

Destructive context edits、有界 `single-string-object-v1` 与 `hook-evaluation-v1` profile 之外的 Structured
Outputs、强制工具、硬性串行工具要求和未知 beta/tool 字段会返回 Anthropic
`invalid_request_error`，不会被静默删除。Prompt
caching 与 token counting 仍是估算能力，不是 Anthropic 原生服务。

## 排障

| 现象                                     | 处理方式                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Token helper 报文件权限不安全            | 运行 `chmod 600 ~/.config/kiro-provider/config.json`，并确认文件属于当前用户。                   |
| `capability_rejected:context_management` | 客户端请求了支持范围外的 destructive edit。不要用未经审计的删字段代理隐藏错误。                  |
| Picker 中没有 Kiro GPT 模型              | 通过 `kiroclaude` 启动；单靠 gateway discovery 会过滤这些 ID。                                   |
| 普通 `claude` 使用了错误后端             | 检查普通 `~/.claude` 配置；`kiroclaude` 不会修改它。                                             |
| 恢复会话时报 provider 签名无效           | 在 Kiro 与原生 Bedrock 之间切换后新建会话。                                                      |
| 会话从 Opus 5.5 切换到 Opus 5 后回复中断 | Kiro 在这种切换下不会正常结束流，这不是 replay 拒绝。请继续使用 Opus 5.5，或为 Opus 5 新建会话。 |

参考资料：[Messages API](https://platform.claude.com/docs/en/api/messages/create)、
[Claude Code settings](https://code.claude.com/docs/en/settings)、
[Claude Code permissions](https://code.claude.com/docs/en/permissions)、
[Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol) 和
[Claude Code 环境变量](https://code.claude.com/docs/en/env-vars)。

### 原生工具历史改写的认证恢复

Claude Code 回传 Edit 历史时可能补入默认 `replace_all: false`；Bash 切换目录
后，也可能去掉冗余的 `cd` 前缀。不透明推理 token 绑定完整的原始 assistant
输出，这些改写此前可能触发 HTTP 400 回放上下文错误。

在现有 `claude-code-bash-v1` 归一化选项下，网关生成有界的历史输入候选：
只移除 Edit 的布尔 false 默认值，或根据近期 Bash 历史及 system 中的原生
工作目录提示恢复 Bash 的字面目录前缀。近期历史优先于旧 system 提示，
最多检查 256 个历史调用。提示仅用于选择候选，不提供授权。原始输出指纹、
tenant、model、完整 GCM 认证、TTL 和签发时的归一化范围必须全部通过验证，
之后才把认证过的原始输入恢复到上游历史。工具 ID、名称、实际参数和当前
工具授权继续保持绑定。参数、目录或 tenant 改变，缺少来源证明或 token
不合法时，仍会失败。

每个历史输出最多 32 个候选、8 MiB 指纹计算材料和四个目录提示。
`reasoning_replay_client_shape_restored` 审计只记录恢复枚举和调用数量；
`reasoning_replay_rejected` 记录脱敏的拒绝代码。
