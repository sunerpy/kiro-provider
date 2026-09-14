# 在 Zuno 中使用 kiro-provider

简体中文 · [English](../ZUNO.md)

由凭据所属的系统用户运行一个长期存活的 kiro-provider 编译版服务，然后让
Zuno 使用原生 OpenAI Responses transport。Zuno 不需要额外 Node 包、自动拉起
Provider 的 hook，也不需要私有请求 Header。

## 配置

```json
{
  "model": "kiro/auto",
  "small_model": "kiro/auto",
  "provider": {
    "kiro": {
      "name": "Local kiro-provider",
      "transport": "openai",
      "surface": "responses",
      "env": ["KIRO_GATEWAY_API_KEY"],
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "maxTokens": null
      },
      "models": {
        "auto": {
          "name": "Kiro Auto",
          "reasoning": true,
          "tool_call": true
        }
      }
    }
  }
}
```

把 `KIRO_GATEWAY_API_KEY` 设置为 Provider `api_keys` 中的一项，然后核对 Zuno
解析后的配置与 Provider 鉴权后的 readiness：

```bash
export KIRO_GATEWAY_API_KEY='sk-your-private-key'
curl -fsS http://127.0.0.1:8787/ready \
  -H "Authorization: Bearer $KIRO_GATEWAY_API_KEY"
zuno debug config
zuno models kiro --verbose
```

保持 `surface: "responses"`。选择 `chat` 必须另行开启旧版 Chat Completions
接口，而且不会携带 Responses 会话元数据。除非所选 Kiro 模型与传输路径已经
验证可强制执行输出 token 上限，否则保持 `maxTokens: null`；Provider 会明确
拒绝不支持的限制，不会静默删除。

`responses_fidelity_mode`、`responses_instruction_lift` 和
`responses_native_tool_bridge` 是 **kiro-provider 自身的配置字段**，不能放入
Zuno Provider options 或请求参数。确有需要时，只在 kiro-provider 的
`config.json` 中设置。

## 会话与传输行为

Zuno 的 OpenAI Responses transport 会在主回合与工具续轮中，把持久 Zuno
会话 ID 映射到 `metadata.zuno_session_id`。这是路由元数据，不会加入 input、
instructions、messages 或工具描述。内部标题与摘要请求也不会加入主 Provider
会话。

应保持 kiro-provider 默认的 `protocol_projection_mode: "v3-auto"`。它把可无损
表达的请求发送到 KiroRuntime 原生 Responses；请求需要 `store: false`、max
effort、加密 reasoning、custom/namespace 工具或 Codex/Zuno 协作 item 时，会
自动选择 canonical stateless 通道。不要因为 Zuno 请求带 instructions 就强制
使用 `legacy-user-prefix`；当前 V3 路由会通过合适的通道保留这些请求形状。

只有当前声明的工具才授权新调用。已存储的 Responses 续接可以恢复私有历史别名，
使旧工具调用和结果保持可读，但历史身份不会重新开放已经撤下的工具。

## 验收边界

变更验收应使用独立的 Zuno 配置和状态目录、Provider 数据库/密钥环副本与本机
测试端口。完整冒烟必须核对工具副作用或结果、最终答复、已存储续接，以及恢复后
工具没有重复执行；只看到 HTTP 200 不算端到端通过。

仓库内最新的脱敏证据覆盖 Zuno 0.10.39 的 max-effort shell 工具循环和冷启动
续接，也覆盖当前上下文与累计用量的区分。这些版本和结果是带日期的验收证据，
不是对未来 Zuno 请求形状的永久承诺。

## 相关文档

- [协议兼容范围](PROTOCOL_COMPATIBILITY.zh-CN.md)
- [Responses 用量与上下文统计](RESPONSES_USAGE.zh-CN.md)
- [历史工具调用与当前授权](../HISTORICAL_TOOLS.md)
- [流错误协议契约](../STREAM_ERROR_CONTRACT.md)
- [审计与验收记录](../audits/README.md)
