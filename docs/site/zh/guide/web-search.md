# 联网搜索

本页介绍如何开启联网搜索、哪些模型和账号会执行搜索，以及客户端会收到什么。

两种接口都定义了托管的联网搜索工具：客户端声明这个工具，由服务端执行搜索并把结果交给模型。开启联网搜索后，kiro-provider 自己承担服务端的角色：它使用处理该请求的账号，通过 Kiro 的搜索执行每一次搜索，并按客户端所用接口定义的格式返回结果和引用。它不会启动或借用 Kiro CLI，每次搜索都是实时的，没有缓存搜索。

联网搜索默认关闭。关闭时，声明了该工具的请求会在执行任何操作前以 `web_search_disabled` 失败。

## 开启

在 `config.json` 中加入这个字段并重启网关：

```json
{
  "api_keys": ["sk-replace-with-a-private-random-key"],
  "web_search_enabled": true
}
```

| 字段                       | 默认值                | 含义                                         |
| -------------------------- | --------------------- | -------------------------------------------- |
| `web_search_enabled`       | `false`               | 允许执行新的搜索。                           |
| `web_search_max_calls`     | `20`                  | 一个请求在所有模型轮次中最多执行的搜索次数。 |
| `web_search_timeout_ms`    | `15000`               | 单次搜索的时限；请求本身的截止时间同样生效。 |
| `web_search_replay_ttl_ms` | `86400000`（24 小时） | 对话中一次搜索的记录保持可用的时长。         |

其余限制见[配置参考](../../../readme/CONFIGURATION.zh-CN.md#联网搜索)。

## 哪些模型和账号

搜索只在 `gpt-5.6-sol` 和 `claude-opus-5.5`（包括它们按推理等级区分的名称）下、在 Kiro profile 位于 `us-east-1` 的账号上执行，这些是经过端到端测试的组合。其他模型会以 `unsupported_web_search_model` 失败；没有位于 `us-east-1` 的可用账号时，请求也会以同样的错误失败。

## Responses

用 `{"type": "web_search"}`（或 `web_search_2025_08_26`）声明工具：

```sh
curl -s http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer $KIRO_GATEWAY_API_KEY" \
  --json '{"model": "gpt-5.6-sol", "store": false,
           "tools": [{"type": "web_search"}],
           "include": ["web_search_call.action.sources"],
           "input": "Which version of Bun is the latest release? Cite the page you used."}'
```

模型执行的每次搜索都会作为一个 `web_search_call` 条目出现在 `output` 中，其 action 类型为 `search`。请求的 `include` 中包含 `web_search_call.action.sources` 时，`action.sources` 会列出读取的 URL。回答中指向这些来源的链接会成为 `url_citation` 标注。

`search_context_size: "low"` 只保留每次搜索的前 3 个来源；`medium` 和 `high` 保留全部来源，最多 10 个。`filters.allowed_domains` 或 `filters.blocked_domains` 可以缩小结果范围，每个请求只能使用其中一种。

在 Codex CLI 中，在使用 kiro-provider 的 profile 里设置 `web_search = "live"`。

## Messages

按版本和名称声明 Anthropic 的工具：

```json
{ "type": "web_search_20250305", "name": "web_search", "max_uses": 5 }
```

回答中包含 `server_tool_use` 和 `web_search_tool_result` 块，文本会在每个被引用的链接处拆分，并带有 `web_search_result_location` 引用。`max_uses` 可以降低该请求的搜索次数上限，`allowed_domains` 或 `blocked_domains` 可以缩小结果范围。

Claude Code 的 WebSearch 工具发送的正是这种格式，因此无需额外配置。用 `--bare` 启动 Claude Code 会关闭 WebSearch。

耗时较长的请求可能在开始一次搜索之前以 `stop_reason: "pause_turn"` 结束：剩余时间已不够再执行一次搜索，或者请求已用完所有模型轮次。原样发回助手消息、并带上同样的工具，即可继续。

## 会被拒绝的内容

工具定义中的以下内容会在执行任何搜索或生成之前被拒绝，客户端因此能立即知道，而不会得到一个打了折扣的搜索：

- Responses：`external_web_access: false`（缓存搜索）、`web_search_preview`、`user_location`、`search_content_types`、`return_token_budget`、`include: ["web_search_call.results"]`，以及同时提供两种过滤列表。
- Messages：`web_search_20250305` 之后的工具版本、`user_location`、代码执行调用方，以及同时提供两种域名列表。
- 两者：用指定名称或 `required` 的工具选择强制使用该工具。`auto` 可以使用，`none` 不会搜索。

## 搜索历史

包含搜索的对话在继续时，使用 kiro-provider 加密保存在 `accounts.db` 中的记录，模型因此看到的是与之前完全相同的搜索调用和结果。这份记录属于执行搜索的账号：继续对话时会回到该账号；该账号无法处理时，请求以 `web_search_replay_owner_unavailable` 失败，而不会转到其他账号。超过 `web_search_replay_ttl_ms` 后记录过期，对话会以 `web_search_replay_expired` 被拒绝。

再次关闭联网搜索只会阻止新的搜索；已经包含搜索的对话仍可继续。回退到 3.8.0 之前的版本前，请先从 `config.json` 中删除所有 `web_search_*` 字段，因为旧版本在启动时会拒绝未知字段。
