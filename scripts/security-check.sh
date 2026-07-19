#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

for dependency in bun curl openssl ss stat; do
  command -v "$dependency" >/dev/null || {
    printf 'security-check: missing dependency: %s\n' "$dependency" >&2
    exit 1
  }
done

PORT=$(bun -e 'const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(){return new Response()}});console.log(server.port);server.stop(true)')
MOCKPORT=$(bun -e 'const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(){return new Response()}});console.log(server.port);server.stop(true)')
APIKEY="sk-test-$(openssl rand -hex 8)"
WORK=$(mktemp -d)
export XDG_CONFIG_HOME="$WORK"
LOGFILE="$WORK/serve.log"
SEED_ACCESS="SEED-ACCESS-$(openssl rand -hex 8)"
SEED_REFRESH="SEED-REFRESH-$(openssl rand -hex 8)"
SVPID=""
MOCKPID=""
MOCK_SCRIPT="$ROOT/scripts/.security-check-mock.$$.ts"
MOCK_MODE_FILE="$WORK/mock-mode"
if [[ -x ./dist/kiro-provider ]]; then
  PROVIDER_COMMAND=(./dist/kiro-provider)
else
  PROVIDER_COMMAND=(bun run src/cli/main.ts)
fi

cleanup() {
  if [[ -n "$SVPID" ]]; then kill "$SVPID" 2>/dev/null || true; fi
  if [[ -n "$MOCKPID" ]]; then kill "$MOCKPID" 2>/dev/null || true; fi
  rm -f "$MOCK_SCRIPT"
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  printf 'security-check: FAIL: %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'security-check: PASS: %s\n' "$1"
}

wait_for_listener() {
  local port=$1
  local pid=$2
  for _ in $(seq 1 100); do
    kill -0 "$pid" 2>/dev/null || return 1
    if ss -ltn | grep -Eq ":${port}[[:space:]]"; then return 0; fi
    sleep 0.05
  done
  return 1
}

stop_provider() {
  if [[ -n "$SVPID" ]]; then
    kill "$SVPID" 2>/dev/null || true
    wait "$SVPID" 2>/dev/null || true
    SVPID=""
  fi
}

write_config() {
  local path=$1
  local request_timeout_ms=$2
  local stream_idle_timeout_ms=$3
  cat >"$path" <<JSON
{
  "port": $PORT,
  "api_keys": ["$APIKEY"],
  "default_region": "us-east-1",
  "request_timeout_ms": $request_timeout_ms,
  "stream_idle_timeout_ms": $stream_idle_timeout_ms,
  "max_request_body_bytes": 10485760,
  "test_upstream_endpoint": "http://127.0.0.1:$MOCKPORT"
}
JSON
}

start_provider() {
  local config=$1
  : >"$LOGFILE"
  "${PROVIDER_COMMAND[@]}" serve --config "$config" >"$LOGFILE" 2>&1 &
  SVPID=$!
  wait_for_listener "$PORT" "$SVPID" || {
    sed -n '1,120p' "$LOGFILE" >&2
    fail "provider did not listen on port $PORT"
  }
}

request_body() {
  local stream=$1
  printf '{"model":"auto","messages":[{"role":"user","content":"security check"}],"stream":%s}' "$stream"
}

cat >"$MOCK_SCRIPT" <<'BUN'
import { EventStreamCodec } from "@smithy/core/event-streams";
import { fromUtf8, toUtf8 } from "@smithy/core/serde";
import { readFileSync } from "node:fs";

const port = Number(Bun.env.MOCK_PORT);
const modeFile = Bun.env.MOCK_MODE_FILE ?? "";
const codec = new EventStreamCodec(toUtf8, fromUtf8);
const event = codec.encode({
  headers: {
    ":message-type": { type: "string", value: "event" },
    ":event-type": { type: "string", value: "assistantResponseEvent" },
    ":content-type": { type: "string", value: "application/json" },
  },
  body: fromUtf8(JSON.stringify({ content: "mock response" })),
});

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch() {
    const mode = readFileSync(modeFile, "utf8").trim();
    if (mode === "delayed") {
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve(
              new Response(event, {
                headers: {
                  "Content-Type": "application/vnd.amazon.eventstream",
                  "x-amzn-codewhisperer-conversation-id": "security-check",
                },
              }),
            ),
          2_000,
        ),
      );
    }
    if (mode === "idle") {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(event);
          },
        }),
        {
          headers: {
            "Content-Type": "application/vnd.amazon.eventstream",
            "x-amzn-codewhisperer-conversation-id": "security-check",
          },
        },
      );
    }
    return new Response(event, {
      headers: {
        "Content-Type": "application/vnd.amazon.eventstream",
        "x-amzn-codewhisperer-conversation-id": "security-check",
      },
    });
  },
});
BUN

printf 'success\n' >"$MOCK_MODE_FILE"
MOCK_PORT="$MOCKPORT" MOCK_MODE_FILE="$MOCK_MODE_FILE" bun "$MOCK_SCRIPT" >"$WORK/mock.log" 2>&1 &
MOCKPID=$!
wait_for_listener "$MOCKPORT" "$MOCKPID" || {
  sed -n '1,120p' "$WORK/mock.log" >&2
  fail "mock upstream did not start"
}

mkdir -p "$XDG_CONFIG_HOME/kiro-provider"
SEED_ACCESS="$SEED_ACCESS" SEED_REFRESH="$SEED_REFRESH" bun -e '
import { AccountsDatabase } from "./src/storage/accounts-db.ts";
const database = new AccountsDatabase();
database.insertAccount({
  id: "security-check-account",
  email: "security-check@example.com",
  authMethod: "desktop",
  region: "us-east-1",
  refreshToken: Bun.env.SEED_REFRESH ?? "",
  accessToken: Bun.env.SEED_ACCESS ?? "",
  expiresAt: Date.now() + 3_600_000,
  rateLimitResetTime: 0,
  isHealthy: true,
  failCount: 0,
  usedCount: 0,
  limitCount: 0,
});
database.close();
'

printf '{"api_keys":[]}\n' >"$WORK/c.json"
if "${PROVIDER_COMMAND[@]}" serve --config "$WORK/c.json" >"$WORK/fail-closed.stdout" 2>"$WORK/fail-closed.stderr"; then
  fail "empty api_keys configuration started successfully"
fi
grep -qi 'api_keys' "$WORK/fail-closed.stderr" || fail "fail-closed stderr did not mention api_keys"
pass "empty api_keys fail closed"

write_config "$WORK/normal.json" 5000 1000
start_provider "$WORK/normal.json"
LISTENERS=$(ss -ltn | grep -E ":${PORT}[[:space:]]" || true)
grep -q '127.0.0.1' <<<"$LISTENERS" || fail "listener is not bound to 127.0.0.1"
if grep -q "0.0.0.0:${PORT}" <<<"$LISTENERS"; then fail "listener is exposed on 0.0.0.0"; fi
pass "default bind is 127.0.0.1"

HTTP_CODE=$(curl -sS --max-time 5 -o "$WORK/success.json" -w '%{http_code}' \
  -H "Authorization: Bearer $APIKEY" \
  -H 'Content-Type: application/json' \
  --data "$(request_body false)" \
  "http://127.0.0.1:$PORT/v1/chat/completions")
[[ "$HTTP_CODE" == "200" ]] || fail "mock-backed request returned HTTP $HTTP_CODE"
if grep -qE "$APIKEY|$SEED_ACCESS|$SEED_REFRESH" "$LOGFILE"; then
  fail "gateway key or seeded account token appeared in logs"
fi
pass "secrets are absent from logs"

DB="$XDG_CONFIG_HOME/kiro-provider/accounts.db"
DB_MODE=$(stat -c '%a' "$DB")
[[ "$DB_MODE" == "600" || "$DB_MODE" == "400" ]] || fail "accounts.db mode is $DB_MODE"
for sidecar in "$DB-wal" "$DB-shm"; do
  if [[ -e "$sidecar" ]]; then
    MODE=$(stat -c '%a' "$sidecar")
    (( (8#$MODE & 077) == 0 )) || fail "$(basename "$sidecar") mode is $MODE"
  fi
done
pass "database and sidecar permissions are owner-only"

BODY_CODE=$(printf '%*s' 11000000 x | curl -sS --max-time 10 -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $APIKEY" \
  -H 'Content-Type: application/json' \
  --data-binary @- \
  "http://127.0.0.1:$PORT/v1/chat/completions")
[[ "$BODY_CODE" == "413" ]] || fail "oversized body returned HTTP $BODY_CODE"
pass "body limit returns 413"
stop_provider

printf 'delayed\n' >"$MOCK_MODE_FILE"
write_config "$WORK/delayed.json" 150 1000
start_provider "$WORK/delayed.json"
DELAYED_CODE=$(curl -sS --max-time 5 -o "$WORK/delayed.json.response" -w '%{http_code}' \
  -H "Authorization: Bearer $APIKEY" \
  -H 'Content-Type: application/json' \
  --data "$(request_body false)" \
  "http://127.0.0.1:$PORT/v1/chat/completions")
[[ "$DELAYED_CODE" == "504" ]] || fail "delayed pre-commit request returned HTTP $DELAYED_CODE"
pass "pre-commit timeout returns 504"
stop_provider

printf 'idle\n' >"$MOCK_MODE_FILE"
write_config "$WORK/idle.json" 5000 150
start_provider "$WORK/idle.json"
set +e
curl -sS --max-time 3 --no-buffer \
  -H "Authorization: Bearer $APIKEY" \
  -H 'Content-Type: application/json' \
  --data "$(request_body true)" \
  "http://127.0.0.1:$PORT/v1/chat/completions" >"$WORK/idle.sse" 2>"$WORK/idle.curl.err"
set -e
grep -q '^data: ' "$WORK/idle.sse" || fail "idle stream emitted no valid SSE event before stalling"
grep -qE '^data: .*"error"' "$WORK/idle.sse" || fail "idle stream emitted no observable error frame"
if grep -qF 'data: [DONE]' "$WORK/idle.sse"; then fail "idle stream emitted a DONE sentinel"; fi
pass "idle stream emits an error frame without data: [DONE]"

printf 'security-check: all seven assertions passed\n'
