# 真实客户端端到端验证（2026-08-22）

本记录针对最终的 `opencode-shared` 默认认证模式与编译后二进制，不以 mock
响应或仅文本生成代替工具回合。

## 验证环境

| 组件 | 实测版本/模式 |
| --- | --- |
| kiro-provider | `0.3.0`，`bun build --compile` 二进制 |
| opencode-kiro-auth 基线 | `v0.20.6` / `13c1a648f66fc80fb5f5f766a3ff9b90c2d3474f` |
| OpenCode | `1.18.18` |
| Codex CLI | `0.149.0-alpha.4.1` |
| Claude Code | `2.1.209` |
| 认证 | `auth_source: "opencode-shared"` |
| Responses 测试模型 | `gpt-5.6-luna-low` |
| Messages 测试模型 | `claude-sonnet-4-5` |

所有客户端均使用其标准 Base URL/API Key 配置，没有私有 Header、Cookie、
客户端补丁或 provider 专用会话字段。

## 结果

### OpenCode：Responses、真实工具和同 session 续聊

OpenCode 使用标准 `@ai-sdk/openai` 自定义 provider 指向 `/v1`：

1. 模型调用 OpenCode 自带的 `read` 工具读取仓库 `package.json`。
2. 工具结果作为 `function_call_output` 进入第二次 `/v1/responses` 请求。
3. 最终输出：

```text
FINAL_OPENCODE_PACKAGE=@sunerpy/kiro-provider@0.3.0
```

随后用同一个 OpenCode session 继续一轮，输出：

```text
FINAL_OPENCODE_MULTITURN_OK
```

续聊前后，provider 的 affinity key、账号、Kiro conversation 和
`created_at` 完全一致；只有 `last_seen`/滑动过期时间前进。这证明标准客户端
不增加自定义协议也能复用同一逻辑账号和 Kiro conversation。

### Codex：Responses 与真实 shell 工具

Codex 使用标准自定义 `model_provider`、`wire_api = "responses"`。第一轮返回
`exec_command`，Codex 在仓库中执行命令读取 `package.json`，第二轮把
`function_call` 与 `function_call_output` 回传。最终输出：

```text
FINAL_CODEX_MAX=@sunerpy/kiro-provider@0.3.0
```

脱敏请求捕获确认：

- 首次请求包含 Codex 标准 function/namespace 工具，以及 OpenAI 托管的
  `web_search` 声明。
- Provider 接受但不向 Kiro 暴露无法执行的托管工具；没有用提示词模拟。
- 第二次请求包含合法配对的 `function_call` 和
  `function_call_output`。
- 用户现有 Codex 配置发送 `reasoning.effort: "max"`；最终二进制不再降级或
  拒绝，CLI 明确显示 `reasoning effort: max`。
- Codex 0.149.0 的真实捕获还出现过 `additional_tools`：namespace 子工具省略
  `type: "function"`，并使用 `inputSchema`。该线路按客户端 schema 精确归一化
  为可执行函数声明；最终二进制回放返回 HTTP 200 和
  `DYNAMIC_ADDITIONAL_TOOLS_OK`，没有把工具说明拼成提示词。

测试主机的只读 bwrap 网络命名空间无法创建 loopback，因此本次 Codex
命令工具运行使用 `danger-full-access`。这是本机 sandbox 限制，不是
provider 协议绕过。

### Claude Code：Messages 与真实 Read 工具

Claude Code 使用标准 `ANTHROPIC_BASE_URL`/API Key 指向网关根地址，调用
内置 `Read` 工具读取 `package.json`。结果：

```text
FINAL_CLAUDE_PACKAGE=@sunerpy/kiro-provider@0.3.0
```

Claude Code 报告 `num_turns: 2`，证明工具调用与工具结果续接都经过真实
`/v1/messages` 链路。

### 旧 Chat：默认关闭、显式开启

同一最终二进制验证两种配置：

- 默认配置：`POST /v1/chat/completions` 返回 HTTP 404 和
  `legacy_chat_completions_disabled`。
- 仅设置 `KIRO_PROVIDER_ENABLE_LEGACY_CHAT_COMPLETIONS=true` 的独立实例：
  返回标准 `chat.completion`，内容为：

```text
LEGACY_CHAT_EXPLICIT_OK
```

因此旧接口不会因兼容实现而被意外公开。

## 共享认证证据

测试时 OpenCode `kiro.db` 中有 42 个非墓碑账号，均处于健康状态；另有 5 个
墓碑。Provider 最新 affinity 记录的账号哈希与共享库最近使用账号的哈希
一致，且共享库的 `last_used`/`used_count` 随实际请求更新。未记录账号身份、
邮箱或 token。

自动化回归还覆盖：

- 错误 schema 默认拒绝。
- 墓碑不会重新成为候选账号。
- 外部重新登录/轮换后的新 token 无需网络刷新即可被看到。
- 两个独立 runtime 竞争同一过期账号时，只执行一次网络刷新。
- 旧的在途刷新无法覆盖更晚完成的重新登录。

## 零隐藏提示词结论

Provider 不生成或拼接自己的 system/developer/user 提示词：

- Responses 的 `instructions` 只按客户端原值映射。
- Chat/Messages 的 system、message、tool 文本只来自客户端请求。
- Codex 模型目录返回空 `base_instructions`，并关闭 provider 自有
  skills/plugins/apps 使用说明。
- 无法严格实现的 forced tool choice、signed thinking、OpenAI 托管工具等
  能力会被拒绝或结构化忽略，不用模型可见文本模拟。
- `__tests__/no-synthetic-prompts.test.ts` 对历史上容易出现的 provider 自有
  continuation/thinking/task/tool-error 文本做静态回归保护。

标准客户端本身发送的系统/开发者说明仍会原样参与请求；它们不是 provider
注入。

## 连接复用的边界

本轮证明的是：

- 同一逻辑 session 持久复用账号和 Kiro `conversationId`。
- 同账号请求经过账号队列。
- 同账号、region、endpoint、proxy 的 SDK 客户端共享 keep-alive transport；
  token 刷新只更新 token provider。

不承诺每轮固定一条物理 TCP socket。Node/Smithy agent、代理、远端空闲策略
和网络都可能创建新 socket；多 provider 进程的队列和 socket 池也彼此独立。

## 质量门禁

在上述真实客户端验证之后重新执行：

- `bun test`：787 pass、0 fail，2894 个断言，66 个测试文件。
- lint、TypeScript typecheck、`fmt-check`、`git diff --check`：全部通过。
- Bun JavaScript bundle 与编译二进制：180 个模块，全部通过。
- 覆盖率门禁：7936/8355 行，94.99%，高于 93% 阈值；Codecov 排除规则
  parity 通过。
- 安全门禁：7 项全部通过；Codex smoke 的进程清理、Header、密钥 argv 和
  临时文件权限自检通过。
- CodeGraph：149 个文件，索引 current、无 pending changes，`cycles: []`。
