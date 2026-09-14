# Using kiro-provider with Zuno

[简体中文](readme/ZUNO.zh-CN.md) · English

Run one compiled kiro-provider service as the credential-owning OS user, then
configure Zuno's native OpenAI Responses transport. Zuno does not need a Node
package, a provider-spawn hook, or private request headers.

## Configuration

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

Set `KIRO_GATEWAY_API_KEY` to one of the provider's `api_keys`, then verify the
resolved Zuno configuration and the provider's authenticated readiness:

```bash
export KIRO_GATEWAY_API_KEY='sk-your-private-key'
curl -fsS http://127.0.0.1:8787/ready \
  -H "Authorization: Bearer $KIRO_GATEWAY_API_KEY"
zuno debug config
zuno models kiro --verbose
```

Keep `surface: "responses"`. Selecting `chat` requires the separately enabled
legacy Chat Completions route and does not carry Responses session metadata.
Keep `maxTokens: null` unless the selected Kiro model and route have a verified,
enforced output-token control; the provider fails closed rather than silently
dropping an unsupported limit.

`responses_fidelity_mode`, `responses_instruction_lift`, and
`responses_native_tool_bridge` are **provider configuration fields**. Do not put
them in Zuno's provider options or request parameters. Configure them only in
kiro-provider's `config.json` when needed.

## Session and transport behavior

Zuno's OpenAI Responses transport maps the durable Zuno session ID to
`metadata.zuno_session_id` on main turns and tool continuations. That identifier
is routing metadata: it is not added to input, instructions, messages, or tool
descriptions. Internal title and summary requests do not join the main provider
conversation.

The default kiro-provider `protocol_projection_mode: "v3-auto"` should remain
enabled. It sends losslessly supported requests to native KiroRuntime Responses
and selects the canonical stateless lane when the request requires it, including
`store: false`, max effort, encrypted reasoning, custom or namespace tools, or
Codex/Zuno collaboration items. Do not force `legacy-user-prefix` merely because
a Zuno request contains instructions; current routing preserves those request
shapes through the appropriate V3 lane.

Current declarations alone authorize new tool calls. Stored Responses
continuations may restore private historical aliases so old tool call/results
remain readable, but historical identities never re-enable a retired tool.

## Validation boundary

Validate changes with an isolated Zuno configuration and state directory, a
copied provider database/keyring, and a loopback test port. A complete smoke must
check the tool side effect or result, the final answer, the stored continuation,
and that the tool was not executed again on resume. HTTP 200 alone is not an
end-to-end pass.

The latest checked-in evidence covers Zuno 0.10.39 with a max-effort shell tool
loop and cold continuation, plus separate current-context and cumulative-usage
checks. Treat those versions and results as dated evidence, not a promise about
future Zuno request shapes.

## Related documentation

- [Protocol compatibility](PROTOCOL_COMPATIBILITY.md)
- [Responses usage and context accounting](RESPONSES_USAGE.md)
- [Historical tool calls and current authorization](HISTORICAL_TOOLS.md)
- [Streaming error contract](STREAM_ERROR_CONTRACT.md)
- [Audit and validation records](audits/README.md)
