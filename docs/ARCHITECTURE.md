# Architecture

English only — a Chinese translation was left out to keep this contribution focused on the README/config docs; contributions to `docs/readme/ARCHITECTURE.zh.md` are welcome.

## Request flow

```
OpenAI Responses / Anthropic Messages / explicitly enabled legacy Chat
        │
        ▼
API-key gate (Authorization: Bearer or x-api-key, accepted on every route)
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
Explicit-only session affinity when a key is present (tenant-isolated hash →
persisted account and Kiro conversationId); otherwise a fresh conversation
        │
        ▼
Session queue + account selection (preferred binding first, then sticky /
round-robin / lowest-usage)
        │
        ▼
Account queue + token refresh if near expiry (provider-owned local auth runtime
by default, via optional proxy)
        │
        ▼
Cached AWS CodeWhisperer Streaming SDK client and account-scoped transport
(model-call sockets fresh by default; no provider-owned prompt text)
        │
        ▼
Kiro / CodeWhisperer event stream
        │
        ▼
CanonicalCompletion / CanonicalEvent
(strict versioned internal JSON / NDJSON media types)
        │
        ▼
Protocol-specific JSON/SSE encoders (Responses, Anthropic Messages, or
explicitly enabled legacy Chat)
```

Responses and Messages never traverse an internal Chat-shaped output. Both
non-streaming and streaming paths consume the same canonical completion/event
contract, so protocol-specific encoders cannot silently reinterpret Kiro
events through another public API's semantics.

The gateway's own HTTP surface (`src/server/app.ts`) is a small `fetch`-style
handler: it checks the API key, dispatches on method + path, and delegates
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

SDK clients are cached by account, region, endpoint, proxy, and the current
access token. Token rotation invalidates the credential-bound client
immediately while retaining the account-scoped `NodeHttpHandler`; the client
is configured with a single SDK attempt (`maxAttempts: 1`) because the
pipeline owns retries. Effort is no longer part of the cache key: it is merged
into each command's `additionalModelRequestFields`, so one client per account
transport serves every effort level. When an account disappears from the
store its clients and transport are evicted. By default the direct and proxy
agents use fresh sockets (`sdk_http_keep_alive: false`); setting the option
to `true` explicitly opts into pooled socket reuse. Transport reuse therefore
survives token refresh, but no mode promises a specific physical TCP
connection. On idle timeout, consumer cancel, or a failed non-stream
collection the pipeline aborts the upstream request and destroys the response
body (Bun drops the SDK's own abort listener once a response starts), so a
released account lease never leaves a Kiro stream running.

## Authentication authority and provider state

The production default is `auth_source: "local"`.
`~/.config/kiro-provider/accounts.db` (`%APPDATA%\kiro-provider\accounts.db`
on Windows) is the single authority for credentials, usage, health, and
provider state. Operators may authenticate directly with
`kiro-provider login` or copy existing `opencode-kiro-auth` accounts once with
`kiro-provider accounts import`. Import does not establish a live database
link or shared lock.

The local runtime uses generation-based compare-and-swap persistence for token
rotation and tombstones. A provider-owned background maintenance loop:

- proactively refreshes access tokens near expiry;
- rebuilds token-bound SDK clients while preserving transports;
- refreshes stale usage through Kiro `getUsageLimits`;
- keeps exhausted accounts out of model attempts until a due authoritative
  probe confirms a new quota window;
- marks permanently dead refresh credentials unhealthy; and
- deduplicates account probes with bounded concurrency and pass deadlines.

The same database also stores provider state:

- `session_affinity` stores only a tenant-isolated request fingerprint,
  account ID, Kiro conversation ID, and timestamps. It never stores the
  original client session value or prompt.
- A row is created only for an explicit affinity key in the default mode.
  Requests without one receive a fresh Kiro conversation and do not collide
  merely because their prompt text is identical.
- The database file and its WAL/SHM siblings are created with `0600`
  permissions on POSIX only; Windows has no equivalent mode bits, so the
  per-user profile directory provides the isolation there.

The former `auth_source: "opencode-shared"` compatibility mode (a live reader of
OpenCode's database with a shared per-account refresh lock) was removed in
0.7.0. It reintroduced cross-process credential ownership and, because
`bun:sqlite` is synchronous, could block the whole event loop for up to 30
seconds while another process held the write lock. The one-time
`kiro-provider accounts import` command is the supported migration path; a
configuration that still selects the removed mode fails at startup with that
instruction.

The selected account manager layers strategy (`sticky` / `round-robin` /
`lowest-usage`) and failover on top of the configured authority. When a
request's chosen account fails or is rate-limited, the pipeline retries with
the next eligible account (up to `max_request_iterations`) rather than
failing the whole request.

The scheduler has two independent keyed queues:

- a logical-session queue prevents overlapping turns when an explicit
  conversation key exists;
- an account queue protects one Kiro account while allowing different
  accounts to run concurrently.

The account lease remains owned by a committed stream until that stream
finishes, errors, times out, or is cancelled. On account failover, the
persisted session binding and Kiro conversation ID are rotated together.
Bindings persist across service restarts, while queue and socket-pool ownership
remain process-local. The default single-instance lock prevents a second
provider process from splitting those owners.

The default `session_affinity_mode: "explicit-only"` accepts Responses
`metadata.zuno_session_id`, `metadata.kiro_provider_session_id`,
compatibility `client_metadata`, or `prompt_cache_key`; Chat accepts only
`prompt_cache_key`, and Anthropic has no verified explicit affinity field.
The migration-only `legacy-initial-input` mode restores old fingerprint
heuristics without changing model-visible content. Tool declarations,
public/upstream aliases, and result correlation stay request-local so
concurrent sessions cannot share a mutable tool map.

Authenticated `GET /ready` verifies that the configured authority can be
read and has at least one active account. `GET /health` remains a liveness
check only.

## HTTP surface details

- Route dispatch tolerates one trailing slash. A known path with the wrong
  method returns `405` with an `Allow` header in the protocol's error envelope;
  `OPTIONS` is treated the same way (CORS is out of scope for a loopback
  gateway). `HEAD /health` returns `200` without a body.
- `401` responses carry `WWW-Authenticate: Bearer`; the `Bearer` scheme is
  matched case-insensitively and `x-api-key` is accepted on every route.
- `Bun.serve` runs with `development: false`, `maxRequestBodySize` equal to
  `max_request_body_bytes` (Bun answers oversized bodies with a plain `413`
  before the JSON envelope), and a fixed `500` envelope for unhandled errors.
  Internal exception text is never returned; responses carry a `request_id`
  that is also written to the audit log with a hashed detail.
- Request-body failures are classified: a client that disconnects mid-upload
  ends the request without a response (`499` internally), a malformed body is
  `400 malformed_request_body`, and a genuine read error is the fixed `500`.
- `429` responses include `Retry-After` when the upstream delay is known. On
  `/v1/messages`, quota exhaustion maps to `429 rate_limit_error` (a retryable
  class) with the structured code preserved in the message.
- `GET /ready` distinguishes `authentication_store_unavailable`,
  `reasoning_replay_store_unavailable`, and `model_catalog_unavailable`.

## Process lifecycle

- The single-instance lock uses `stale: 15s` / `update: 5s`. Acquisition
  retries for up to 20 × 1s so a restart after `SIGKILL` succeeds once the stale
  window passes; the final error names the lock path and the stale window.
- If the lock is compromised (for example the lock directory is deleted), the
  provider fails closed: it logs `single_instance_lock_compromised`, stops
  accepting requests, drains in-flight requests for up to 10s, stops
  maintenance, and exits with code 1 so the service manager restarts it. It
  never keeps serving without the lock.
- `SIGTERM` / `SIGINT` run the same shutdown routine and exit 0. Repeated
  signals join the in-progress shutdown.

## Where to look in the code

- `src/server/app.ts` — HTTP entry point and route dispatch.
- `src/server/ingress.ts` — shared request ingress: body-size limit, request
  deadlines, and the abort signals handed to every route.
- `src/server/routes/` — per-endpoint handlers (`responses.ts`, `messages.ts`,
  `chat-completions.ts`, `models.ts`, `health.ts`, `readiness.ts`).
- `src/protocol/output.ts` — strict, versioned canonical completion/event
  schema and internal media types.
- `src/kiro/transform/streaming/sdk-output-transformer.ts` — direct Kiro SDK
  event-to-canonical transformation.
- `src/server/chat-output.ts`, `src/server/responses/sse-adapter.ts`, and
  `src/server/anthropic/response-adapter.ts` — protocol-specific encoders that
  consume canonical output without a Chat wire intermediary.
- `src/server/anthropic/` — Anthropic request, response, and SSE adapters.
- `src/server/session-affinity.ts` — standard-field affinity extraction and
  tenant-isolated hashing.
- `src/core/account-manager.ts` — selection strategy and failover.
- `src/core/pipeline-runtime.ts` — session/account keyed queue ownership.
- `src/core/sdk-client.ts` — mutable-token SDK cache and configurable HTTP transports.
- `src/core/token-refresher.ts`, `src/core/proxy.ts` — token refresh and
  proxy resolution.
- `src/storage/accounts-db.ts` — provider affinity/state and local-mode account
  store.
- `src/cli/` — the `serve` / `login` / `accounts` command-line surface.
