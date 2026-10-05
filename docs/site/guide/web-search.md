# Web search

This page covers turning on web search, which models and accounts run it, and what a client gets back.

Both APIs define a hosted web search tool: the client declares it, and the server runs the searches and hands the
results to the model. With web search on, kiro-provider plays that server role itself. It runs each search through
Kiro's search with the account that serves the request, and returns the results and citations in the shape the
client's API defines. It does not start or borrow Kiro CLI, and every search is live; there is no cached search.

Web search is off by default. A request that declares the tool while it is off fails with `web_search_disabled`
before anything runs.

## Turn it on

Add the field to `config.json` and restart the gateway:

```json
{
  "api_keys": ["sk-replace-with-a-private-random-key"],
  "web_search_enabled": true
}
```

| Field                      | Default           | Meaning                                                          |
| -------------------------- | ----------------- | ---------------------------------------------------------------- |
| `web_search_enabled`       | `false`           | Allows new searches.                                             |
| `web_search_max_calls`     | `20`              | Searches one request may run, across all of its model turns.     |
| `web_search_timeout_ms`    | `15000`           | Time for one search; the request's own deadline applies as well. |
| `web_search_replay_ttl_ms` | `86400000` (24 h) | How long the record of a search stays usable in a conversation.  |

The [configuration reference](../../CONFIGURATION.md#web-search) has the remaining limits.

## Which models and accounts

Searches run with `gpt-5.6-sol` and `claude-opus-5.5`, including their effort variants, on accounts whose Kiro
profile is in `us-east-1`. Those are the combinations that were tested end to end. Any other model fails with
`unsupported_web_search_model`, and so does a request when no ready account is in `us-east-1`.

## Responses

Declare the tool with `{"type": "web_search"}` (or `web_search_2025_08_26`):

```sh
curl -s http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer $KIRO_GATEWAY_API_KEY" \
  --json '{"model": "gpt-5.6-sol", "store": false,
           "tools": [{"type": "web_search"}],
           "include": ["web_search_call.action.sources"],
           "input": "Which version of Bun is the latest release? Cite the page you used."}'
```

Each search the model runs appears in `output` as a `web_search_call` item with a `search` action. The URLs it read
are listed in `action.sources` when the request includes `web_search_call.action.sources`. A link in the answer that
points at one of those sources becomes a `url_citation` annotation.

`search_context_size: "low"` keeps the first 3 sources of each search; `medium` and `high` keep all of them, at most
10. `filters.allowed_domains` or `filters.blocked_domains` narrows the results, one list per request.

In Codex CLI, set `web_search = "live"` in the profile that uses kiro-provider.

## Messages

Declare Anthropic's tool by its version and name:

```json
{ "type": "web_search_20250305", "name": "web_search", "max_uses": 5 }
```

The answer carries `server_tool_use` and `web_search_tool_result` blocks, and its text is split at each cited link
with a `web_search_result_location` citation. `max_uses` lowers the search budget for that request, and
`allowed_domains` or `blocked_domains` narrows the results.

Claude Code's WebSearch tool sends exactly this shape, so it works without further setup. Starting Claude Code with
`--bare` turns WebSearch off.

A long request can end with `stop_reason: "pause_turn"` before a search starts, when too little time is left for one
more search or the request has used all of its model turns. Send the assistant message back unchanged, with the same
tools, to continue.

## What is refused

These parts of the tool definitions are rejected before any search or generation, so a client learns about them
immediately instead of getting a weaker search:

- Responses: `external_web_access: false` (cached search), `web_search_preview`, `user_location`,
  `search_content_types`, `return_token_budget`, `include: ["web_search_call.results"]`, and both filter lists at once.
- Messages: tool versions after `web_search_20250305`, `user_location`, code-execution callers, and both domain lists
  at once.
- Both: forcing the tool with a named or `required` tool choice. `auto` works, and `none` never searches.

## Search history

A conversation that contains searches is continued from a record that kiro-provider keeps encrypted in
`accounts.db`, so the model sees exactly the search call and result it saw before. That record belongs to the account
that ran the search: a continuation goes back to that account, and fails with `web_search_replay_owner_unavailable`
rather than moving to another one. After `web_search_replay_ttl_ms` the record expires and the conversation is
refused with `web_search_replay_expired`.

Turning web search off again stops new searches only; conversations that already contain searches keep working.
Before going back to a release older than 3.8.0, remove every `web_search_*` field from `config.json`, because
older releases refuse unknown fields at startup.
