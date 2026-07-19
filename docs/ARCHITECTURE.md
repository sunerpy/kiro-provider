# Architecture

English only — a Chinese translation was left out to keep this contribution focused on the README/config docs; contributions to `docs/readme/ARCHITECTURE.zh.md` are welcome.

## Request flow

```
OpenAI-shaped request
        │
        ▼
Bearer auth gate (checkApiKey)  ──▶ 401 on missing/invalid key
        │
        ▼
Route dispatch (POST /v1/chat/completions, GET /v1/models, GET /health)
        │
        ▼
Account selection (AccountManager: sticky / round-robin / lowest-usage)
        │
        ▼
Token refresh if near expiry (TokenRefresher, via optional proxy)
        │
        ▼
AWS CodeWhisperer Streaming SDK call (conversationState built from
the OpenAI messages array)
        │
        ▼
Kiro / CodeWhisperer event stream
        │
        ▼
Response translation back to OpenAI shape (SSE chunks for streaming,
a single JSON body otherwise)
```

The gateway's own HTTP surface (`src/server/app.ts`) is a small `fetch`-style
handler: it checks the Bearer key, dispatches on method + path, and delegates
to a route handler. There is no framework in the middle — request handling,
account selection, and the upstream call are explicit function calls, which
keeps the retry/failover logic (see below) easy to follow.

## Transport

Upstream calls go through `@aws/codewhisperer-streaming-client`, AWS's
generated SDK for the CodeWhisperer streaming API — this is the same
transport Kiro's own clients use. When `proxy_url` is configured, the SDK's
HTTP handler is built with an `https-proxy-agent` wrapping that URL, so proxy
support is a transport-layer concern applied uniformly to every SDK call
(chat requests, token refresh, and device-code login all reuse the same
resolution).

## Account store

Accounts are persisted in a local `bun:sqlite` database
(`~/.config/kiro-provider/accounts.db`), not an ORM or external service:

- Each row tracks OAuth tokens, region, health, usage counters, and a
  **generation** number.
- Removing an account writes a **tombstone** row instead of deleting the row
  outright, so a stale in-memory account list (or a concurrent writer) cannot
  resurrect a removed account on its next reconciliation pass.
- The generation number backs compare-and-swap style updates: a writer that
  loaded generation N only commits if the row is still at generation N,
  which avoids lost updates when multiple requests refresh or update the
  same account concurrently.
- The database file (and its WAL/SHM siblings) is created with `0600`
  permissions.

`AccountManager` layers selection strategy (`sticky` / `round-robin` /
`lowest-usage`) and failover on top of this store: when a request's chosen
account fails or is rate-limited, the pipeline retries with the next
eligible account (up to `max_request_iterations`) rather than failing the
whole request.

## Where to look in the code

- `src/server/app.ts` — HTTP entry point and route dispatch.
- `src/server/routes/` — per-endpoint handlers (`chat-completions.ts`,
  `models.ts`, `health.ts`).
- `src/core/account-manager.ts` — selection strategy and failover.
- `src/core/token-refresher.ts`, `src/core/proxy.ts` — token refresh and
  proxy resolution.
- `src/storage/accounts-db.ts` — the `bun:sqlite` account store.
- `src/cli/` — the `serve` / `login` / `accounts` command-line surface.
