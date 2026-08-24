# Kiro 原生 Web Search 探针（2026-08-23）

## 结论

当前 Kiro `GenerateAssistantResponse` 链路不支持 AWS Bedrock Responses
风格的原生 `web_search` 托管工具。

本次探针使用现有 OpenCode 共享 Kiro 认证和 `gpt-5.6-sol`，直接调用
`https://q.<region>.amazonaws.com`。没有通过 provider 的 Responses
适配器，因此结论来自 Kiro 上游本身。

## 对照实验

### 控制组

- 请求：普通 GPT-5.6 Sol 请求，不携带 Web Search 字段。
- 结果：HTTP 200、clean EOF。
- 原始事件：`reasoningContentEvent`、`assistantResponseEvent`、
  `contextUsageEvent`、`meteringEvent`。
- citation、document citation、supplementary web link 均为 0。

控制组返回了错误的 npm 版本，因此模型文字中自称的 URL 或“已搜索”不能作为
Web Search 成功证据。

### AWS-style `web_search`

请求通过 `additionalModelRequestFields` 携带：

```json
{
  "tools": [{ "type": "web_search" }]
}
```

结果为 HTTP 400：

```text
ValidationException: Invalid additionalModelRequestFields:
property 'tools' is not defined in the schema and the schema does not allow
additional properties
```

设置 `external_web_access: false` 后结果相同。

### Kiro harness-style 工具

通过 `userInputMessageContext.tools` 声明普通 `toolSpecification`，工具名为
`web_search`。

结果：

- HTTP 200、clean EOF；
- 返回 `toolUseEvent`；
- 没有 assistant 文本；
- citation、document citation、supplementary web link 均为 0。

这证明该形态只是让模型请求客户端执行 `web_search`。Kiro 服务端没有代替
客户端执行搜索，也没有返回托管搜索结果或引用。

## 决策

不在当前 Kiro/OpenCode 认证链路中宣称或开启原生 Web Search：

- 不把 `supports_search_tool` 改成 `true`；
- 不把工具说明拼入 system/developer/user 提示词；
- 不把普通 `toolUseEvent` 冒充 Responses `web_search_call`；
- 保持未知 hosted tool 的现有兼容过滤行为。

若未来需要 AWS 原生 Web Search，应新增显式开启的 Bedrock Mantle 后端。该
路径需要独立 AWS 凭证、区域、权限和计费，不能伪装成复用 Kiro 账号。

## 复现

```bash
bun run scripts/probe-sdk.ts --web-search
```

退出码：

- `0`：捕获到 citation 或 supplementary web-link 证据；
- `1`：控制组成功，但 Kiro 拒绝 Web Search 或没有搜索证据；
- `2`：认证、账号或控制组未建立有效对照。

探针不会打印 access token、refresh token 或 client secret。只有 token
临近过期时，才会沿用现有逻辑刷新并持久化选中账号。
