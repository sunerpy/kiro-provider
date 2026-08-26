# Architecture

English only — a Chinese translation was left out to keep this contribution focused on the README/config docs; contributions to `docs/readme/ARCHITECTURE.zh.md` are welcome.

## Request flow

```
OpenAI Responses / Anthropic Messages / explicitly enabled legacy Chat
        │
        ▼
API-key gate (Bearer; Anthropic routes also accept x-api-key)
        │
        ▼
Route dispatch (/v1/responses, /v1/messages, optional /v1/chat/completions)
        │
        ▼
CanonicalRequest (roles, content blocks, tools, reasoning, source paths)
        │
        ▼
Capability validation + safe/explicit legacy Kiro projection
        │
        ▼
Standard-field session affinity (tenant-isolated hash → persisted account
and Kiro conversationId)
        │
        ▼
Session queue + account selection (preferred binding first, then sticky /
round-robin / lowest-usage)
        │
        ▼
Account queue + token refresh if near expiry (shared OpenCode auth runtime by
default, via optional proxy)
        │
        ▼
Cached AWS CodeWhisperer Streaming SDK client and account-scoped keep-alive
transport (conversationState built without provider-owned prompt text)
        │
        ▼
Kiro / CodeWhisperer event stream
        │
        ▼
Protocol-specific response translation (typed Responses SSE, Anthropic
Messages SSE, or explicitly enabled legacy Chat SSE)
```

The gateway's own HTTP surface (`src/server/app.ts`) is a small `fetch`-style
handler: it checks the Bearer key, dispatches on method + path, and delegates
to a route handler. There is no framework in the middle — request handling,
account selection, and the upstream call are explicit function calls, which
keeps the retry/failover logic (see below) easy to follow.

Protocol adapters do not add model-visible instructions. Client system text,
messages, tool descriptions, and tool results are carried as client data.
Opaque replayed reasoning is not converted into plaintext. A capability that
cannot be represented structurally (for example Anthropic forced tool choice)
is rejected rather than approximated with a hidden prompt.

## Transport

Upstream calls go through `@aws/codewhisperer-streaming-client`, AWS's
generated SDK for the CodeWhisperer streaming API — this is the same
transport Kiro's own clients use. When `proxy_url` is configured, the SDK's
HTTP handler is built with an `https-proxy-agent` wrapping that URL, so proxy
support is a transport-layer concern applied uniformly to every SDK call
(chat requests, token refresh, and device-code login all reuse the same
resolution).

SDK clients are cached by account, region, endpoint, proxy, and effort. Their
token provider is mutable, so an access-token refresh does not discard the
client. Effort-specific clients for one account share one `NodeHttpHandler`
and its keep-alive agents. This maximizes socket reuse but does not promise a
specific physical TCP connection; remote and network lifecycle decisions
still apply.

## Authentication authority and provider state

The production default is `auth_source: "opencode-shared"`. Authentication
facts remain in OpenCode's Kiro database
(`~/.config/opencode/kiro.db` by default):

- The provider validates the account/tombstone schema and fails closed on an
  incompatible version. It does not run migrations against an OpenCode-owned
  database.
- Account additions, re-logins, rotated tokens, tombstones, health, and usage
  are reconciled from the live shared database.
- Refresh uses the same per-account lock path and bounded wait contract as
  `opencode-kiro-auth` v0.20.7. The provider re-reads the account after taking
  the lock, persists before publishing, and uses a complete token/login
  snapshot as a compare-and-swap guard.
- This is a protocol-compatible implementation, not an import or copy of the
  GPL plugin's private package internals; the provider remains MIT.

The provider still owns `~/.config/kiro-provider/accounts.db`, but in shared
mode it is the affinity/state database:

- `session_affinity` stores only a tenant-isolated request fingerprint,
  account ID, Kiro conversation ID, and timestamps. It never stores the
  original client session value or prompt.
- The database file and its WAL/SHM siblings are created with `0600`
  permissions.

The explicit `auth_source: "local"` compatibility mode uses the provider
database for OAuth credentials as well. It retains generation-based
compare-and-swap updates and tombstones. `kiro-provider login` and
`accounts import` are local-mode tools; an import is a one-time snapshot, not
the default production authentication path.

The selected account manager layers strategy (`sticky` / `round-robin` /
`lowest-usage`) and failover on top of the configured authority. When a
request's chosen account fails or is rate-limited, the pipeline retries with
the next eligible account (up to `max_request_iterations`) rather than
failing the whole request.

The scheduler has two independent keyed queues:

- a logical-session queue prevents overlapping turns for one conversation;
- an account queue protects one Kiro account while allowing different
  accounts to run concurrently.

The account lease remains owned by a committed stream until that stream
finishes, errors, times out, or is cancelled. On account failover, the
persisted session binding and Kiro conversation ID are rotated together.
SQLite bindings work across processes, while queue and socket-pool ownership
remain process-local.

Authenticated `GET /ready` verifies that the configured authority can be
read and has at least one active account. `GET /health` remains a liveness
check only.

## Where to look in the code

- `src/server/app.ts` — HTTP entry point and route dispatch.
- `src/server/routes/` — per-endpoint handlers (`responses.ts`, `messages.ts`,
  `chat-completions.ts`, `models.ts`, `health.ts`, `readiness.ts`).
- `src/server/anthropic/` — Anthropic request, response, and SSE adapters.
- `src/server/session-affinity.ts` — standard-field affinity extraction and
  tenant-isolated hashing.
- `src/auth/opencode-auth-store.ts`,
  `src/auth/opencode-refresh-lock.ts` — shared OpenCode schema, transactions,
  refresh-lock compatibility, and persistence.
- `src/core/opencode-auth-runtime.ts` — live reconciliation, selection, health,
  and refresh orchestration for shared mode.
- `src/core/account-manager.ts` — selection strategy and failover.
- `src/core/pipeline-runtime.ts` — session/account keyed queue ownership.
- `src/core/sdk-client.ts` — mutable-token SDK cache and keep-alive transports.
- `src/core/token-refresher.ts`, `src/core/proxy.ts` — token refresh and
  proxy resolution.
- `src/storage/accounts-db.ts` — provider affinity/state and local-mode account
  store.
- `src/cli/` — the `serve` / `login` / `accounts` command-line surface.
