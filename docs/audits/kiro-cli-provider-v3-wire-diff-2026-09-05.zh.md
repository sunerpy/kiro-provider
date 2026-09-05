# Kiro CLI 与 kiro-provider V3 脱敏 wire diff

> **作者**：kiro-provider 维护者 · **日期**：2026-09-05 · **版本**：v3.0
> **受众**：Provider 开发者与安全评审

## TL;DR

最新 Kiro CLI 与 Provider 使用相同的 `runtime.<region>.kiro.dev` 服务域，但
存在两套 operation：CLI 主交互流使用 GenerateAssistantResponse，KAS 私有
模型另有 OpenAI 风格 CreateResponse。V3 普通请求直接使用 CreateResponse；
需要 Codex 扩展或 stateless 语义时，使用经过验证的
GenerateAssistantResponse canonical pipeline。

## 1. 脱敏原则

本报告只保留：

- endpoint 与 operation 名；
- 非敏感 header 名；
- JSON 字段名、枚举、计数与结构；
- body 长度与 SHA-256 截断哈希；
- 合成 marker 是否出现。

以下内容不进入报告：

- Authorization、access token、refresh token、client secret；
- profile ARN 原值、账号 ID 原值与 session ID 原值；
- reasoning signature、redacted bytes、`kr1_` token；
- prompt、completion、工具参数与工具输出正文；
- 原始 HTTPS capture。

## 2. Operation 对比

| 维度 | Kiro CLI 主交互流 | Provider V3 原生通道 | Provider V3 fallback |
| --- | --- | --- | --- |
| Host | `runtime.<region>.kiro.dev` | 相同 | 相同 |
| Operation | `KiroRuntimeService.GenerateAssistantResponse` | `POST /v1/responses` / CreateResponse | GenerateAssistantResponse |
| 请求协议 | AWS/Smithy event stream | `application/json` + OpenAI SSE | AWS/Smithy event stream |
| 核心状态 | `conversationState` | `previous_response_id` | `conversationState` |
| History | `history` + `currentMessage` | OpenAI `input` / upstream state | canonical history + current input |
| 指令 | 旧路径无普遍可用字段 | 原生 `instructions` | 显式 legacy prefix |
| 工具 | Kiro tool specifications/results | 原生 function tools | function/custom/namespace bridge |
| Effort | `additionalModelRequestFields` | `reasoning.effort` | model/effort mapping |
| Origin | `AI_EDITOR` | `x-amzn-kiro-origin` | `AI_EDITOR` |
| Profile | 请求级 profile | `x-amzn-kiro-profile` | 请求级 profile |

## 3. 字段映射

| OpenAI 字段 | CreateResponse | Fallback | 结论 |
| --- | --- | --- | --- |
| `model` | 原生 | 映射 | 可移植 |
| `input` | 原生 | canonical messages | 可移植 |
| `instructions` | 原生 | 保序前缀 | 可移植，但 fallback 不是原生角色 |
| `tools` function | 原生 | 原生 Kiro tool spec | 可移植 |
| custom / namespace | 不支持 | 私有 alias bridge | 仅 fallback |
| `tool_choice:auto/none` | 原生 | canonical control | 有界支持 |
| `previous_response_id` | 原生 | 本地 canonical expansion | 可移植 |
| `store:false` | 上游忽略并报告 true | 不写本地镜像 | 仅 fallback |
| `reasoning.effort:xhigh` | 原生 | 映射 | 可移植 |
| `reasoning.effort:max` | 上游拒绝 | 映射 | 仅 fallback |
| `reasoning.encrypted_content` | 未验证可用 | `kr1_` replay | 仅 fallback |
| `temperature` | Claude 可用 | 拒绝或按模型控制 | 模型相关 |
| `top_p` | 上游 500 | 拒绝 | 不可移植 |
| `truncation:auto` | GPT 可用 | 不可保真 | GPT 原生限定 |
| Structured Outputs | 上游忽略 | 拒绝 | 不可移植 |

## 4. 隐藏字段与 feature

KAS 中存在：

- `system_field_injection`；
- `system_prompt_migration`。

当前账号的 GetFeatureConfiguration 响应没有公开这两个 feature。Amazon Q
Developer 设置页与已加载前端 bundle 中也没有客户可操作的开关。

决策：

- 不通过本地环境变量伪造 feature；
- `native-context-safe` 继续等待服务端 advertisement；
- V3 使用 CreateResponse `instructions` 解决普通原生指令；
- 不修改 Kiro CLI 安装二进制。

## 5. 扩展方法探针

| 路径 | HTTP | 脱敏结构 | 可移植性 |
| --- | ---: | --- | --- |
| `/v1/responses/{id}` | 404 | 非 OpenAI 响应 | 不可移植 |
| `/v1/responses/{id}/input_items` | 404 | 非 OpenAI 响应 | 不可移植 |
| `DELETE /v1/responses/{id}` | 404 | 非 OpenAI 响应 | 不可移植 |
| `/v1/responses/input_tokens` | 200 | `Output{__type,message}/Version` | 不可移植 |
| `/v1/responses/compact` | 200 | `Output{__type,message}/Version` | 不可移植 |

`input_tokens` 与 `compact` 返回完全相同的 160 字节包装与相同 body hash。它们
不是 OpenAI Responses 对象，不能作为兼容端点使用。

## 6. 最终决策

1. CreateResponse 的核心字段可直接移植到 V3 原生通道。
2. CLI 主交互流的 history/current-message/tool-result 结构继续作为 fallback
   兼容证据。
3. `systemPrompt` 依赖服务端 feature，当前不可启用。
4. Retrieve、delete、input-items、compact 与 input-tokens 不可从 KiroRuntime
   复现；V3 对前三者使用本地镜像，对后两者返回明确 HTTP 501。
5. 没有证据表明核心能力依赖 CLI 私有本地状态，因此 CreateResponse 方案可以
   独立实现；Mantle 路由由 KiroRuntime 服务端负责。

相关报告：

- [V3 验证报告](kiro-provider-v3-openai-responses-validation-2026-09-05.zh.md)
- [V3 协议兼容范围](../readme/PROTOCOL_COMPATIBILITY.zh.md)
