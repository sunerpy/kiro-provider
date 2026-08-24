#!/usr/bin/env bash
set -euo pipefail

# Security: umask 077 guarantees API-key-bearing temp files are owner-only.
# appendFileSync(...,{mode}) cannot fix a file a prior umask already made 0644.
umask 077

WORK="$(mktemp -d)"
if ! [ -n "$WORK" ] || ! [ -d "$WORK" ]; then
	echo "codex-smoke: ERROR: mktemp did not create an isolated working directory" >&2
	exit 1
fi
ORIGINAL_CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
ORIGINAL_CODEX_SQLITE_HOME="${CODEX_SQLITE_HOME:-$ORIGINAL_CODEX_HOME}"
SECURITY_SELF_TEST_PIDS=()

register_security_self_test_pid() {
	local pid="$1"
	SECURITY_SELF_TEST_PIDS+=("$pid")
	if [ -n "${KIRO_PROVIDER_SMOKE_SECURITY_PID_RECORD:-}" ]; then
		printf '%s\n' "$pid" >>"$KIRO_PROVIDER_SMOKE_SECURITY_PID_RECORD"
	fi
}

forget_security_self_test_pid() {
	local forgotten="$1" pid
	local remaining=()
	for pid in "${SECURITY_SELF_TEST_PIDS[@]}"; do
		[ "$pid" = "$forgotten" ] || remaining+=("$pid")
	done
	SECURITY_SELF_TEST_PIDS=("${remaining[@]}")
}

# This global, idempotent primitive is safe from both explicit return paths and
# the top-level EXIT trap; it does not depend on function-local PID variables.
cleanup_security_self_test_processes() {
	local pid
	local pids=("${SECURITY_SELF_TEST_PIDS[@]}")
	SECURITY_SELF_TEST_PIDS=()
	for pid in "${pids[@]}"; do
		kill "$pid" 2>/dev/null || true
	done
	for pid in "${pids[@]}"; do
		wait "$pid" 2>/dev/null || true
	done
}

cleanup_on_exit() {
	cleanup_security_self_test_processes
	kill "${SVPID:-}" "${CAPTUREPID:-}" "${MOCKPID:-}" 2>/dev/null || true
	rm -rf "$WORK"
}
trap cleanup_on_exit EXIT

canonical_path() {
	if command -v realpath >/dev/null 2>&1; then
		realpath -m -- "$1"
	elif [ -d "$1" ]; then
		(
			cd "$1"
			pwd -P
		)
	else
		(
			cd "$(dirname "$1")"
			printf '%s/%s\n' "$(pwd -P)" "$(basename "$1")"
		)
	fi
}

assert_isolated_codex_path() {
	local label="$1"
	local candidate="$2"
	local candidate_real protected protected_real work_real

	candidate_real="$(canonical_path "$candidate")"
	work_real="$(canonical_path "$WORK")"
	for protected in "$HOME/.codex" "$ORIGINAL_CODEX_HOME" "$ORIGINAL_CODEX_SQLITE_HOME"; do
		protected_real="$(canonical_path "$protected")"
		case "$candidate_real" in
			"$protected_real"|"$protected_real"/*)
				echo "codex-smoke: ERROR: refusing $label inside protected Codex state: $candidate_real" >&2
				return 1
				;;
		esac
	done
	case "$candidate_real" in
		"$work_real"/*) ;;
		*)
			echo "codex-smoke: ERROR: refusing $label outside isolated working directory: $candidate_real" >&2
			return 1
			;;
	esac
}

has_expected_model_content() {
	grep -Eq '^[[:space:]]*OK[[:space:]]*$' "$1"
}

has_internal_alias_leak() {
	grep -Eq 'kiro_(custom|ns)_[0-9]+' "$@"
}

has_completed_command_event() {
	grep -Eq '"type"[[:space:]]*:[[:space:]]*"command_execution"' "$1" &&
		grep -Eq '"status"[[:space:]]*:[[:space:]]*"completed"' "$1"
}

has_failed_command_event() {
	grep -Eq '"type"[[:space:]]*:[[:space:]]*"command_execution"' "$1" &&
		grep -Eq '"exit_code"[[:space:]]*:[[:space:]]*[1-9][0-9]*' "$1"
}

has_completed_wait_event() {
	grep -Eq '"type"[[:space:]]*:[[:space:]]*"collab(_agent)?_tool_call"' "$1" &&
		grep -Eq '"tool"[[:space:]]*:[[:space:]]*"wait(_agent)?"' "$1" &&
		grep -Eq '"status"[[:space:]]*:[[:space:]]*"completed"' "$1"
}

write_capture_proxy_script() {
	cat >"$1" <<'TYPESCRIPT'
import { appendFileSync } from 'node:fs'

const upstreamRootRaw = process.env.CAPTURE_UPSTREAM_ROOT
const upstreamBasePath = process.env.CAPTURE_UPSTREAM_BASE_PATH ?? '/v1'
const capturePath = process.env.CAPTURE_PATH
const readyPath = process.env.CAPTURE_READY_PATH
if (!upstreamRootRaw || !capturePath || !readyPath) throw new Error('capture proxy configuration missing')

const upstream = new URL(upstreamRootRaw)
const allowedPath = new URL(`${upstreamBasePath}/responses`, upstream).pathname

const FORWARD_HEADER_ALLOWLIST = ['authorization', 'content-type', 'accept'] as const
const RESPONSE_HEADER_ALLOWLIST = [
  'content-type',
  'cache-control',
  'openai-model',
  'x-request-id',
  'x-reasoning-included',
  'x-codex-turn-state',
  'x-models-etag'
] as const

function projectHeaders(source: Headers, allowlist: readonly string[]): Headers {
  const projected = new Headers()
  for (const name of allowlist) {
    const value = source.get(name)
    if (value !== null) projected.set(name, value)
  }
  return projected
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const sourceUrl = new URL(request.url)

    if (request.method !== 'POST' || sourceUrl.pathname !== allowedPath) {
      return new Response('capture proxy only forwards POST to the fixed Responses endpoint', {
        status: 404
      })
    }

    const target = new URL(upstream.href)
    target.pathname = allowedPath
    target.search = sourceUrl.search
    if (target.origin !== upstream.origin) {
      return new Response('capture proxy refused an off-origin target', { status: 400 })
    }

    const body = new Uint8Array(await request.arrayBuffer())
    const text = new TextDecoder().decode(body)
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { malformed_json_body: text }
    }
    appendFileSync(
      capturePath,
      `${JSON.stringify({ method: request.method, path: sourceUrl.pathname, payload })}\n`,
      { mode: 0o600 }
    )

    const upstreamResponse = await fetch(target, {
      method: 'POST',
      headers: projectHeaders(request.headers, FORWARD_HEADER_ALLOWLIST),
      body,
      redirect: 'manual'
    })
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: projectHeaders(upstreamResponse.headers, RESPONSE_HEADER_ALLOWLIST)
    })
  }
})

await Bun.write(readyPath, `${server.port}\n`)
await new Promise(() => {})
TYPESCRIPT
}

start_capture_proxy() {
	CAPTURE_LOG="$WORK/requests.jsonl"
	CAPTURE_READY="$WORK/capture.ready"
	CAPTURE_PROXY_LOG="$WORK/capture-proxy.log"
	CAPTURE_SCRIPT="$WORK/capture-proxy.ts"
	CAPTURE_VERIFY_SCRIPT="$WORK/verify-capture.ts"
	: >"$CAPTURE_LOG"

	write_capture_proxy_script "$CAPTURE_SCRIPT"

	cat >"$CAPTURE_VERIFY_SCRIPT" <<'TYPESCRIPT'
const path = process.argv[2]
if (!path) throw new Error('capture path missing')
const text = await Bun.file(path).text()
const records = text
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
const items = records.flatMap((record) =>
  Array.isArray(record?.payload?.input) ? record.payload.input : []
)
const spawnIds = new Set(
  items
    .filter(
      (item) =>
        item?.type === 'function_call' &&
        item?.namespace === 'collaboration' &&
        item?.name === 'spawn_agent' &&
        typeof item?.call_id === 'string'
    )
    .map((item) => item.call_id)
)
const outputIds = new Set(
  items
    .filter((item) => item?.type === 'function_call_output' && typeof item?.call_id === 'string')
    .map((item) => item.call_id)
)
const newTasks = items.filter(
  (item) =>
    item?.type === 'agent_message' &&
    typeof item?.author === 'string' &&
    typeof item?.recipient === 'string' &&
    item.author !== item.recipient &&
    JSON.stringify(item.content).includes('Message Type: NEW_TASK')
)
const childAnswer = newTasks.some((task) =>
  items.some(
    (item) =>
      item?.type === 'agent_message' &&
      item?.author === task.recipient &&
      item?.recipient === task.author &&
      JSON.stringify(item.content).includes('NAMESPACE_CHILD_OK') &&
      !JSON.stringify(item.content).includes('Message Type: NEW_TASK')
  )
)
const checks = {
  public_spawn_call: spawnIds.size > 0,
  matching_spawn_output: [...spawnIds].some((id) => outputIds.has(id)),
  directed_child_new_task: newTasks.length > 0,
  child_answer_sentinel: childAnswer
}
const missing = Object.entries(checks)
  .filter(([, passed]) => !passed)
  .map(([name]) => name)
if (missing.length > 0) {
  console.error(`codex-smoke: capture missing namespace evidence: ${missing.join(', ')}`)
  process.exit(1)
}
console.log('codex-smoke: capture verified public spawn/output, directed child task, and child answer')
TYPESCRIPT

	CAPTURE_UPSTREAM_ROOT="http://127.0.0.1:$PORT" \
		CAPTURE_UPSTREAM_BASE_PATH="/v1" \
		CAPTURE_PATH="$CAPTURE_LOG" \
		CAPTURE_READY_PATH="$CAPTURE_READY" \
		bun "$CAPTURE_SCRIPT" >"$CAPTURE_PROXY_LOG" 2>&1 &
	CAPTUREPID=$!
	for _ in $(seq 1 100); do
		if ! kill -0 "$CAPTUREPID" 2>/dev/null; then
			echo "codex-smoke: ERROR: request capture proxy exited during startup" >&2
			cat "$CAPTURE_PROXY_LOG" >&2
			return 1
		fi
		if [ -s "$CAPTURE_READY" ]; then
			CAPTURE_PORT="$(tr -d '[:space:]' <"$CAPTURE_READY")"
			CAPTURE_BASE_URL="http://127.0.0.1:$CAPTURE_PORT/v1"
			return 0
		fi
		sleep 0.1
	done
	echo "codex-smoke: ERROR: request capture proxy did not become ready" >&2
	cat "$CAPTURE_PROXY_LOG" >&2
	return 1
}

has_account_model_failure() {
	grep -Eqi 'no[_ ]healthy[_ ]accounts|no (healthy |available )?accounts?|account[^[:alnum:]]+(unavailable|not found)|insufficient[_ ]quota|invalid[_ ]model([_ ]id)?|INVALID_MODEL_ID|TEMPORARILY_SUSPENDED|model[^[:alnum:]]+(not entitled|not available|access denied)|not entitled[^[:alnum:]]+model|quota[^[:alnum:]]+(exceeded|exhausted)|rate[^[:alnum:]]+limit' "$@"
}

has_pre_stream_account_model_failure() {
	has_account_model_failure "$@" && \
		grep -Eqi 'unexpected status[^[:digit:]]*[45][0-9][0-9]|status([^[:alnum:]]|[_-])*(code[^[:alnum:]]*)?[45][0-9][0-9]|HTTP[^[:digit:]]*[45][0-9][0-9]|service[_ ]unavailable|insufficient[_ ]quota|no[_ ]healthy[_ ]accounts|INVALID_MODEL_ID|TEMPORARILY_SUSPENDED' "$@"
}

classify_turn_outcome() {
	local codex_status="$1"
	local codex_stdout="$2"
	local codex_stderr="$3"
	local gateway_log="$4"

	if [ "$codex_status" -eq 124 ] || [ "$codex_status" -eq 137 ]; then
		echo "codex-smoke: FAIL: codex exec timed out; Responses streaming did not terminate" >&2
		echo "codex-smoke: summary: health=PASS turn=FAIL wiring=FAIL content=NOT_CHECKED" >&2
		return 1
	fi

	if grep -Fqi "stream closed before response.completed" "$codex_stdout" "$codex_stderr"; then
		echo "codex-smoke: FAIL: Responses stream closed before response.completed" >&2
		echo "codex-smoke: summary: health=PASS turn=FAIL wiring=FAIL content=NOT_CHECKED" >&2
		return 1
	fi

	if grep -Fqi "response.failed" "$codex_stdout" "$codex_stderr"; then
		if has_account_model_failure "$codex_stdout" "$codex_stderr" "$gateway_log"; then
			echo "codex-smoke: WIRING OK, UPSTREAM/ACCOUNT NEEDS SETUP: well-formed Responses events ended in response.failed" >&2
			echo "codex-smoke: run 'kiro-provider accounts import', log in, or choose an entitled model, then retry" >&2
			echo "codex-smoke: summary: health=PASS turn=INCOMPLETE wiring=OK upstream_account=NEEDS_SETUP content=NONE exit=2" >&2
			return 2
		fi
		echo "codex-smoke: FAIL: Responses stream ended in response.failed without a recognized account/model cause" >&2
		echo "codex-smoke: summary: health=PASS turn=FAIL wiring=FAIL content=NONE" >&2
		return 1
	fi

	if has_pre_stream_account_model_failure "$codex_stdout" "$codex_stderr" "$gateway_log"; then
		echo "codex-smoke: WIRING OK, UPSTREAM/ACCOUNT NEEDS SETUP: gateway returned a pre-stream account/model HTTP error" >&2
		echo "codex-smoke: run 'kiro-provider accounts import', log in, or choose an entitled model, then retry" >&2
		echo "codex-smoke: summary: health=PASS turn=INCOMPLETE wiring=OK transport=PRE_STREAM_HTTP_ERROR upstream_account=NEEDS_SETUP content=NONE exit=2" >&2
		return 2
	fi

	if [ "$codex_status" -eq 0 ] && has_expected_model_content "$codex_stdout"; then
		echo "codex-smoke: CONNECTIVITY/REASONING PASS: codex observed response.completed and produced expected assistant content"
		echo "codex-smoke: note: this turn does not test tools; use KIRO_PROVIDER_SMOKE_MODE=tools for custom and namespace probes"
		echo "codex-smoke: summary: health=PASS turn=PASS wiring=PASS response.completed=OBSERVED content=PASS tool_capability=NOT_TESTED exit=0"
		return 0
	fi

	if [ "$codex_status" -eq 0 ]; then
		echo "codex-smoke: FAIL: codex completed without the expected assistant content" >&2
		echo "codex-smoke: summary: health=PASS turn=INCOMPLETE wiring=UNKNOWN response.completed=OBSERVED content=MISSING" >&2
		return 1
	fi

	echo "codex-smoke: FAIL: codex did not complete a valid Responses turn (exit $codex_status)" >&2
	echo "codex-smoke: summary: health=PASS turn=FAIL wiring=FAIL content=NONE" >&2
	return 1
}

run_json_turn() {
	local label="$1"
	local prompt="$2"
	local stdout_file="$3"
	local stderr_file="$4"
	local codex_status=0

	if (
		cd "$TOOL_WORKSPACE"
		NO_COLOR=1 TERM=dumb timeout --signal=TERM --kill-after=5 120 \
			codex exec --json --skip-git-repo-check \
			-c approval_policy=never \
			-c "sandbox_mode=$CODEX_SANDBOX_MODE" \
			"$prompt" </dev/null
	) >"$stdout_file" 2>"$stderr_file"; then
		codex_status=0
	else
		codex_status=$?
	fi

	cat "$stdout_file"
	cat "$stderr_file" >&2

	if [ "$codex_status" -eq 124 ] || [ "$codex_status" -eq 137 ]; then
		echo "codex-smoke: FAIL: $label timed out after 120 seconds" >&2
		return 1
	fi
	if [ "$codex_status" -ne 0 ]; then
		if has_account_model_failure "$stdout_file" "$stderr_file" "$GATEWAY_LOG"; then
			echo "codex-smoke: $label INCOMPLETE: upstream account/model needs setup" >&2
			return 2
		fi
		echo "codex-smoke: FAIL: $label exited with status $codex_status" >&2
		return 1
	fi
	if has_internal_alias_leak "$stdout_file" "$stderr_file"; then
		echo "codex-smoke: FAIL: $label leaked an internal tool alias" >&2
		return 1
	fi
	return 0
}

NAMESPACE_PROBE_PROMPT='Your first action must be to call collaboration.spawn_agent exactly once. Do not reason further before that call, and never use exec or any shell command. Instruct that single child agent that its only task is to reply with exactly NAMESPACE_CHILD_OK and nothing else. Then call collaboration.wait_agent for that child until it finishes. After the child returns, reply with exactly this and nothing else: NAMESPACE_OK: NAMESPACE_CHILD_OK'

# Exit contract: 0=verified PASS; 1=hard protocol failure (never retry);
# 2=account/model setup failure (never retry); 3=model non-selection (retriable).
classify_namespace_evidence() {
	local turn_status="$1"
	local ns_stdout="$2"
	local ns_stderr="$3"
	local capture_log="$4"
	local gateway_log="$5"
	local capture_verified="$6"

	if has_internal_alias_leak "$capture_log" "$ns_stdout" "$ns_stderr"; then
		echo "codex-smoke: namespace attempt leaked an internal tool alias" >&2
		return 1
	fi

	if [ "$turn_status" -eq 2 ] || has_account_model_failure "$ns_stdout" "$ns_stderr" "$gateway_log"; then
		echo "codex-smoke: namespace attempt blocked on upstream account/model setup" >&2
		return 2
	fi

	if [ "$turn_status" -eq 124 ] || [ "$turn_status" -eq 137 ]; then
		echo "codex-smoke: namespace attempt timed out without completing collaboration.spawn_agent" >&2
		return 3
	fi

	if [ "$turn_status" -ne 0 ]; then
		echo "codex-smoke: namespace attempt exited $turn_status without a recognized account cause" >&2
		return 1
	fi

	if ! has_completed_wait_event "$ns_stdout" \
		|| ! grep -Fq 'NAMESPACE_OK: NAMESPACE_CHILD_OK' "$ns_stdout" \
		|| [ "$capture_verified" != "1" ]; then
		echo "codex-smoke: namespace attempt completed without full spawn/wait/child-sentinel evidence" >&2
		return 3
	fi

	return 0
}

run_namespace_probe_attempt() {
	local label="$1"
	local prompt="$2"
	local ns_stdout="$3"
	local ns_stderr="$4"
	local codex_status capture_verified classification

	: >"$CAPTURE_LOG"
	: >"$ns_stdout"
	: >"$ns_stderr"

	echo "codex-smoke: starting $label" >&2
	if (
		cd "$TOOL_WORKSPACE"
		NO_COLOR=1 TERM=dumb timeout --signal=TERM --kill-after=5 120 \
			codex exec --json --skip-git-repo-check \
			-c approval_policy=never \
			-c "sandbox_mode=$CODEX_SANDBOX_MODE" \
			"$prompt" </dev/null
	) >"$ns_stdout" 2>"$ns_stderr"; then
		codex_status=0
	else
		codex_status=$?
	fi

	cat "$ns_stdout"
	cat "$ns_stderr" >&2

	capture_verified=0
	if bun "$CAPTURE_VERIFY_SCRIPT" "$CAPTURE_LOG"; then
		capture_verified=1
	fi

	if classify_namespace_evidence \
		"$codex_status" "$ns_stdout" "$ns_stderr" "$CAPTURE_LOG" "$GATEWAY_LOG" "$capture_verified"; then
		classification=0
	else
		classification=$?
	fi
	return "$classification"
}

# NAMESPACE_ATTEMPT_RUNNER is a test seam: the self-test injects a stub runner.
run_namespace_with_retry() {
	local runner="${NAMESPACE_ATTEMPT_RUNNER:-run_namespace_probe_attempt}"
	local attempt classification
	for attempt in 1 2; do
		if "$runner" \
			"namespace collaboration probe (attempt $attempt of 2)" \
			"$NAMESPACE_PROBE_PROMPT" \
			"$WORK/namespace.attempt$attempt.stdout.jsonl" \
			"$WORK/namespace.attempt$attempt.stderr.log"; then
			classification=0
		else
			classification=$?
		fi
		case "$classification" in
			0)
				echo "codex-smoke: PASS (5) namespace collaboration call completed with the child sentinel on attempt $attempt"
				echo "codex-smoke: summary: health=PASS turn=PASS custom_happy=PASS custom_error_recovery=PASS namespace=PASS aliases=NOT_LEAKED exit=0"
				return 0
				;;
			2)
				echo "codex-smoke: namespace INCOMPLETE: upstream account/model needs setup" >&2
				return 2
				;;
			3)
				if [ "$attempt" -eq 1 ]; then
					echo "codex-smoke: namespace model did not drive collaboration.spawn_agent; retrying once in a fresh turn" >&2
					continue
				fi
				echo "codex-smoke: REJECT: namespace model failed to select collaboration.spawn_agent on both bounded attempts" >&2
				echo "codex-smoke: this is a model-selection/reliability blocker, not a verified protocol PASS" >&2
				echo "codex-smoke: retained evidence: $WORK/namespace.attempt1.stdout.jsonl $WORK/namespace.attempt2.stdout.jsonl and matching .stderr.log files" >&2
				echo "codex-smoke: summary: health=PASS turn=PASS custom_happy=PASS custom_error_recovery=PASS namespace=REJECT_MODEL_RELIABILITY aliases=NOT_LEAKED exit=1" >&2
				return 1
				;;
			*)
				echo "codex-smoke: FAIL: namespace probe hit a hard protocol failure on attempt $attempt" >&2
				return 1
				;;
		esac
	done
}

run_tool_probes() {
	local custom_stdout="$WORK/custom-happy.stdout.jsonl"
	local custom_stderr="$WORK/custom-happy.stderr.log"
	local failure_stdout="$WORK/custom-failure.stdout.jsonl"
	local failure_stderr="$WORK/custom-failure.stderr.log"
	local result

	printf '%s\n' 'CUSTOM_BRIDGE_OK' >"$WORK/custom-expected.txt"
	if run_json_turn \
		"custom happy-path probe" \
		"You must use the exec tool to run exactly this shell command in the current workspace: printf 'CUSTOM_BRIDGE_OK\\n' > custom-ok.txt . Do not use apply_patch. After the command succeeds, reply exactly CUSTOM_OK." \
		"$custom_stdout" \
		"$custom_stderr"; then
		result=0
	else
		result=$?
	fi
	[ "$result" -eq 0 ] || return "$result"
	if ! has_completed_command_event "$custom_stdout"; then
		echo "codex-smoke: FAIL: custom happy-path emitted no completed command_execution event" >&2
		return 1
	fi
	if ! [ -f "$TOOL_WORKSPACE/custom-ok.txt" ] || ! cmp -s "$WORK/custom-expected.txt" "$TOOL_WORKSPACE/custom-ok.txt"; then
		echo "codex-smoke: FAIL: custom happy-path did not create the exact sentinel bytes" >&2
		return 1
	fi
	echo "codex-smoke: PASS (3) custom exec round-trip preserved the command and side effect"

	printf '%s\n' 'CUSTOM_RECOVERED_OK' >"$WORK/recovery-expected.txt"
	if run_json_turn \
		"custom failure-recovery probe" \
		"Use the exec tool first to run exactly: sh -c 'exit 7' . Observe that failure. Then use exec again to run exactly: printf 'CUSTOM_RECOVERED_OK\\n' > custom-recovered.txt . Do not stop after the expected first failure. After the second command succeeds, reply exactly CUSTOM_RECOVERY_OK." \
		"$failure_stdout" \
		"$failure_stderr"; then
		result=0
	else
		result=$?
	fi
	[ "$result" -eq 0 ] || return "$result"
	if ! has_failed_command_event "$failure_stdout"; then
		echo "codex-smoke: FAIL: custom failure-recovery emitted no non-zero command_execution event" >&2
		return 1
	fi
	if ! [ -f "$TOOL_WORKSPACE/custom-recovered.txt" ] || ! cmp -s "$WORK/recovery-expected.txt" "$TOOL_WORKSPACE/custom-recovered.txt"; then
		echo "codex-smoke: FAIL: custom failure-recovery did not continue to the exact sentinel" >&2
		return 1
	fi
	echo "codex-smoke: PASS (4) Codex observed a custom-tool error and completed a later custom call"

	run_namespace_with_retry
}

run_outcome_self_test() {
	local stdout_fixture="$WORK/outcome-stdout.log"
	local stderr_fixture="$WORK/outcome-stderr.log"
	local gateway_fixture="$WORK/outcome-gateway.log"
	local result

	printf '%s\n' 'OK' >"$stdout_fixture"
	printf '%s\n' 'response.created' 'response.completed' >"$stderr_fixture"
	: >"$gateway_fixture"
	set +e
	classify_turn_outcome 0 "$stdout_fixture" "$stderr_fixture" "$gateway_fixture"
	result=$?
	set -e
	[ "$result" -eq 0 ] || return 1
	echo "codex-smoke: outcome self-test completed+content: PASS (exit 0)"

	: >"$stdout_fixture"
	printf '%s\n' 'Error: unexpected status 503 Service Unavailable' '{"error":{"code":"no_healthy_accounts","type":"service_unavailable"}}' >"$stderr_fixture"
	printf '%s\n' 'No healthy accounts available' >"$gateway_fixture"
	set +e
	classify_turn_outcome 1 "$stdout_fixture" "$stderr_fixture" "$gateway_fixture"
	result=$?
	set -e
	[ "$result" -eq 2 ] || return 1
	echo "codex-smoke: outcome self-test pre-stream 503 no_healthy_accounts: PASS (exit 2)"

	: >"$stdout_fixture"
	printf '%s\n' 'Error: unexpected status 402 Payment Required' '{"error":{"code":"insufficient_quota","type":"insufficient_quota"}}' >"$stderr_fixture"
	: >"$gateway_fixture"
	set +e
	classify_turn_outcome 1 "$stdout_fixture" "$stderr_fixture" "$gateway_fixture"
	result=$?
	set -e
	[ "$result" -eq 2 ] || return 1
	echo "codex-smoke: outcome self-test pre-stream 402 insufficient_quota: PASS (exit 2)"

	: >"$stdout_fixture"
	printf '%s\n' 'Error: unexpected status 400 Bad Request' '{"error":{"code":"INVALID_MODEL_ID","message":"The requested model is not available"}}' >"$stderr_fixture"
	: >"$gateway_fixture"
	set +e
	classify_turn_outcome 1 "$stdout_fixture" "$stderr_fixture" "$gateway_fixture"
	result=$?
	set -e
	[ "$result" -eq 2 ] || return 1
	echo "codex-smoke: outcome self-test pre-stream INVALID_MODEL_ID: PASS (exit 2)"

	: >"$stdout_fixture"
	printf '%s\n' 'Error: unexpected status 403 Forbidden' '{"error":{"code":"TEMPORARILY_SUSPENDED","message":"Account temporarily suspended"}}' >"$stderr_fixture"
	: >"$gateway_fixture"
	set +e
	classify_turn_outcome 1 "$stdout_fixture" "$stderr_fixture" "$gateway_fixture"
	result=$?
	set -e
	[ "$result" -eq 2 ] || return 1
	echo "codex-smoke: outcome self-test pre-stream TEMPORARILY_SUSPENDED: PASS (exit 2)"

	: >"$stdout_fixture"
	printf '%s\n' 'connection refused before any Responses event' >"$stderr_fixture"
	: >"$gateway_fixture"
	set +e
	classify_turn_outcome 1 "$stdout_fixture" "$stderr_fixture" "$gateway_fixture"
	result=$?
	set -e
	[ "$result" -eq 1 ] || return 1
	echo "codex-smoke: outcome self-test connection refused: PASS (exit 1)"

	: >"$stdout_fixture"
	printf '%s\n' 'stream closed before response.completed' >"$stderr_fixture"
	: >"$gateway_fixture"
	set +e
	classify_turn_outcome 1 "$stdout_fixture" "$stderr_fixture" "$gateway_fixture"
	result=$?
	set -e
	[ "$result" -eq 1 ] || return 1
	echo "codex-smoke: outcome self-test stream closed: PASS (exit 1)"

	: >"$stdout_fixture"
	: >"$stderr_fixture"
	: >"$gateway_fixture"
	set +e
	classify_turn_outcome 124 "$stdout_fixture" "$stderr_fixture" "$gateway_fixture"
	result=$?
	set -e
	[ "$result" -eq 1 ] || return 1
	echo "codex-smoke: outcome self-test hang/timeout: PASS (exit 1)"
}

run_namespace_self_test() {
	local ns_stdout="$WORK/ns-self-stdout.log"
	local ns_stderr="$WORK/ns-self-stderr.log"
	local ns_capture="$WORK/ns-self-capture.log"
	local ns_gateway="$WORK/ns-self-gateway.log"
	local result

	printf '%s\n' \
		'{"type":"collab_agent_tool_call","tool":"wait_agent","status":"completed"}' \
		'NAMESPACE_OK: NAMESPACE_CHILD_OK' >"$ns_stdout"
	: >"$ns_stderr"
	: >"$ns_capture"
	: >"$ns_gateway"
	set +e
	classify_namespace_evidence 0 "$ns_stdout" "$ns_stderr" "$ns_capture" "$ns_gateway" 1
	result=$?
	set -e
	[ "$result" -eq 0 ] || return 1
	echo "codex-smoke: namespace self-test verified PASS: PASS (exit 0)"

	printf '%s\n' 'thinking about the request' >"$ns_stdout"
	: >"$ns_stderr"
	: >"$ns_capture"
	: >"$ns_gateway"
	set +e
	classify_namespace_evidence 124 "$ns_stdout" "$ns_stderr" "$ns_capture" "$ns_gateway" 0
	result=$?
	set -e
	[ "$result" -eq 3 ] || return 1
	echo "codex-smoke: namespace self-test timeout non-selection is retriable: PASS (exit 3)"

	printf '%s\n' 'NAMESPACE_OK: NAMESPACE_CHILD_OK' >"$ns_stdout"
	: >"$ns_stderr"
	: >"$ns_capture"
	: >"$ns_gateway"
	set +e
	classify_namespace_evidence 0 "$ns_stdout" "$ns_stderr" "$ns_capture" "$ns_gateway" 0
	result=$?
	set -e
	[ "$result" -eq 3 ] || return 1
	echo "codex-smoke: namespace self-test completed-without-capture is retriable: PASS (exit 3)"

	: >"$ns_stdout"
	printf '%s\n' 'Error: unexpected status 503 no_healthy_accounts' >"$ns_stderr"
	: >"$ns_capture"
	printf '%s\n' 'No healthy accounts available' >"$ns_gateway"
	set +e
	classify_namespace_evidence 2 "$ns_stdout" "$ns_stderr" "$ns_capture" "$ns_gateway" 0
	result=$?
	set -e
	[ "$result" -eq 2 ] || return 1
	echo "codex-smoke: namespace self-test account/model setup is not retried: PASS (exit 2)"

	printf '%s\n' 'NAMESPACE_OK: NAMESPACE_CHILD_OK' >"$ns_stdout"
	: >"$ns_stderr"
	printf '%s\n' 'kiro_ns_1 leaked into the wire' >"$ns_capture"
	: >"$ns_gateway"
	set +e
	classify_namespace_evidence 0 "$ns_stdout" "$ns_stderr" "$ns_capture" "$ns_gateway" 1
	result=$?
	set -e
	[ "$result" -eq 1 ] || return 1
	echo "codex-smoke: namespace self-test alias leak is a hard failure: PASS (exit 1)"

	run_namespace_orchestration_self_test
}

NAMESPACE_STUB_CALLS=0

_ns_stub_retry_then_pass() {
	NAMESPACE_STUB_CALLS=$((NAMESPACE_STUB_CALLS + 1))
	if [ "$NAMESPACE_STUB_CALLS" -eq 1 ]; then
		return 3
	fi
	return 0
}

_ns_stub_retry_then_reject() {
	NAMESPACE_STUB_CALLS=$((NAMESPACE_STUB_CALLS + 1))
	return 3
}

_ns_stub_first_pass() {
	NAMESPACE_STUB_CALLS=$((NAMESPACE_STUB_CALLS + 1))
	return 0
}

run_namespace_orchestration_self_test() {
	local result

	NAMESPACE_STUB_CALLS=0
	if NAMESPACE_ATTEMPT_RUNNER=_ns_stub_retry_then_pass run_namespace_with_retry >/dev/null 2>&1; then
		result=0
	else
		result=$?
	fi
	[ "$result" -eq 0 ] || return 1
	[ "$NAMESPACE_STUB_CALLS" -eq 2 ] || return 1
	echo "codex-smoke: namespace orchestration self-test attempt1=retry attempt2=pass: PASS (exit 0, 2 attempts)"

	NAMESPACE_STUB_CALLS=0
	if NAMESPACE_ATTEMPT_RUNNER=_ns_stub_retry_then_reject run_namespace_with_retry >/dev/null 2>&1; then
		result=0
	else
		result=$?
	fi
	[ "$result" -eq 1 ] || return 1
	[ "$NAMESPACE_STUB_CALLS" -eq 2 ] || return 1
	echo "codex-smoke: namespace orchestration self-test both attempts retriable: PASS (exit 1, exactly 2 attempts)"

	NAMESPACE_STUB_CALLS=0
	if NAMESPACE_ATTEMPT_RUNNER=_ns_stub_first_pass run_namespace_with_retry >/dev/null 2>&1; then
		result=0
	else
		result=$?
	fi
	[ "$result" -eq 0 ] || return 1
	[ "$NAMESPACE_STUB_CALLS" -eq 1 ] || return 1
	echo "codex-smoke: namespace orchestration self-test first-attempt pass: PASS (exit 0, exactly 1 attempt)"
}

run_security_self_test() {
	if ! command -v bun >/dev/null 2>&1; then
		echo "codex-smoke: ERROR: bun is required for the security self-test" >&2
		return 1
	fi
	if ! command -v curl >/dev/null 2>&1; then
		echo "codex-smoke: ERROR: curl is required for the security self-test" >&2
		return 1
	fi

	local sec_dir="$WORK/security"
	mkdir -p "$sec_dir"
	local proxy_script="$sec_dir/capture-proxy.ts"
	local sink_script="$sec_dir/sink.ts"
	local driver_script="$sec_dir/driver.ts"
	local capture_log="$sec_dir/requests.jsonl"
	local upstream_ready="$sec_dir/upstream.ready"
	local upstream_record="$sec_dir/upstream.record.json"
	local attacker_ready="$sec_dir/attacker.ready"
	local attacker_record="$sec_dir/attacker.record.json"
	local proxy_ready="$sec_dir/proxy.ready"
	local proxy_log="$sec_dir/proxy.log"
	local upstream_log="$sec_dir/upstream.log"
	local attacker_log="$sec_dir/attacker.log"
	local driver_result="$sec_dir/driver.result.json"
	local sec_upstream_pid="" sec_attacker_pid="" sec_proxy_pid=""

	write_capture_proxy_script "$proxy_script"
	: >"$capture_log"

	cat >"$sink_script" <<'TYPESCRIPT'
import { writeFileSync } from 'node:fs'

const readyPath = process.env.SINK_READY_PATH
const recordPath = process.env.SINK_RECORD_PATH
if (!readyPath || !recordPath) throw new Error('sink configuration missing')

let hits = 0
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    hits += 1
    const url = new URL(request.url)
    const headers: Record<string, string> = {}
    for (const [name, value] of request.headers) headers[name.toLowerCase()] = value
    writeFileSync(
      recordPath,
      `${JSON.stringify({ hits, method: request.method, path: url.pathname, headers })}\n`,
      { mode: 0o600 }
    )
    return new Response('{"ok":true}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req-safe',
        'x-smoke-upstream-response': 'SHOULD_NOT_FORWARD'
      }
    })
  }
})
await Bun.write(readyPath, `${server.port}\n`)
await new Promise(() => {})
TYPESCRIPT

	SINK_READY_PATH="$upstream_ready" SINK_RECORD_PATH="$upstream_record" \
		bun "$sink_script" >"$upstream_log" 2>&1 &
	sec_upstream_pid=$!
	register_security_self_test_pid "$sec_upstream_pid"
	SINK_READY_PATH="$attacker_ready" SINK_RECORD_PATH="$attacker_record" \
		bun "$sink_script" >"$attacker_log" 2>&1 &
	sec_attacker_pid=$!
	register_security_self_test_pid "$sec_attacker_pid"

	local upstream_port="" attacker_port="" i
	for i in $(seq 1 100); do
		[ -s "$upstream_ready" ] && [ -s "$attacker_ready" ] && break
		sleep 0.1
	done
	upstream_port="$(tr -d '[:space:]' <"$upstream_ready" 2>/dev/null || true)"
	attacker_port="$(tr -d '[:space:]' <"$attacker_ready" 2>/dev/null || true)"
	if [ -z "$upstream_port" ] || [ -z "$attacker_port" ]; then
		echo "codex-smoke: security self-test: FAIL: loopback sinks did not start" >&2
		cleanup_security_self_test_processes
		return 1
	fi

	CAPTURE_UPSTREAM_ROOT="http://127.0.0.1:$upstream_port" \
		CAPTURE_UPSTREAM_BASE_PATH="/v1" \
		CAPTURE_PATH="$capture_log" \
		CAPTURE_READY_PATH="$proxy_ready" \
		bun "$proxy_script" >"$proxy_log" 2>&1 &
	sec_proxy_pid=$!
	register_security_self_test_pid "$sec_proxy_pid"
	local proxy_port=""
	for i in $(seq 1 100); do
		[ -s "$proxy_ready" ] && break
		sleep 0.1
	done
	proxy_port="$(tr -d '[:space:]' <"$proxy_ready" 2>/dev/null || true)"
	if [ -z "$proxy_port" ]; then
		echo "codex-smoke: security self-test: FAIL: capture proxy did not start" >&2
		cat "$proxy_log" >&2
		cleanup_security_self_test_processes
		return 1
	fi

	cat >"$driver_script" <<'TYPESCRIPT'
const proxyPort = Number(process.env.PROXY_PORT)
const attackerPort = Number(process.env.ATTACKER_PORT)
const resultPath = process.env.DRIVER_RESULT_PATH!
const proxyOrigin = `http://127.0.0.1:${proxyPort}`

async function rawRequest(requestLine: string, headerLines: string[], body: string): Promise<number> {
  const head = [requestLine, `Host: 127.0.0.1:${proxyPort}`, ...headerLines,
    `Content-Length: ${Buffer.byteLength(body)}`, 'Connection: close', '', '']
    .join('\r\n')
  let status = -1
  let buffer = ''
  const conn = await Bun.connect({
    hostname: '127.0.0.1',
    port: proxyPort,
    socket: {
      data(_socket, chunk) {
        buffer += new TextDecoder().decode(chunk)
        const match = buffer.match(/^HTTP\/1\.\d (\d{3})/)
        if (match) status = Number(match[1])
      },
      open(socket) {
        socket.write(head + body)
      }
    }
  })
  await new Promise((resolve) => setTimeout(resolve, 400))
  conn.end()
  return status
}

const networkPathStatus = await rawRequest(
  `POST //127.0.0.1:${attackerPort}/v1/responses HTTP/1.1`,
  ['Authorization: Bearer SENTINEL-SSRF-KEY', 'Content-Type: application/json'],
  '{"probe":true}'
)

const wrongMethodStatus = await fetch(`${proxyOrigin}/v1/responses`, {
  method: 'GET',
  headers: { authorization: 'Bearer SENTINEL-GET' }
}).then((r) => r.status).catch(() => -1)

const wrongPathStatus = await fetch(`${proxyOrigin}/v1/other`, {
  method: 'POST',
  headers: { authorization: 'Bearer SENTINEL-PATH', 'content-type': 'application/json' },
  body: '{"probe":true}'
}).then((r) => r.status).catch(() => -1)

const legitStatus = await rawRequest(`POST /v1/responses HTTP/1.1`, [
  'Authorization: Bearer SENTINEL-LEGIT-KEY',
  'Content-Type: application/json',
  'Accept: text/event-stream',
  'User-Agent: SMOKE-UA-SENTINEL',
  'Forwarded: for=SMOKE-FWD-SENTINEL',
  'X-Forwarded-For: SMOKE-XFF-SENTINEL',
  'Proxy-Authorization: Bearer SMOKE-PROXY-SENTINEL',
  'Cookie: session=SMOKE-COOKIE-SENTINEL',
  'X-Smoke-Sentinel: SMOKE-CUSTOM-SENTINEL'
], '{"input":[]}')

const responseProbe = await fetch(`${proxyOrigin}/v1/responses`, {
  method: 'POST',
  headers: {
    authorization: 'Bearer SENTINEL-LEGIT-KEY',
    'content-type': 'application/json',
    accept: 'text/event-stream'
  },
  body: '{"input":[]}'
})
const responseStatus = responseProbe.status
const responseContentType = responseProbe.headers.get('content-type')
const responseRequestId = responseProbe.headers.get('x-request-id')
const responseLeak = responseProbe.headers.get('x-smoke-upstream-response')
await responseProbe.arrayBuffer()

await Bun.write(
  resultPath,
  JSON.stringify({
    networkPathStatus,
    wrongMethodStatus,
    wrongPathStatus,
    legitStatus,
    responseStatus,
    responseContentType,
    responseRequestId,
    responseLeak
  })
)
TYPESCRIPT

	PROXY_PORT="$proxy_port" ATTACKER_PORT="$attacker_port" DRIVER_RESULT_PATH="$driver_result" \
		bun "$driver_script"
	sleep 0.2

	local failures=0
	fail_check() {
		echo "codex-smoke: security self-test: FAIL: $1" >&2
		failures=$((failures + 1))
	}

	local attacker_hits
	attacker_hits="$(bun -e 'const f=Bun.file(process.argv[1]);const t=await f.exists()?await f.text():"";const l=t.trim().split("\n").filter(Boolean);console.log(l.length?JSON.parse(l[l.length-1]).hits:0)' "$attacker_record" 2>/dev/null || echo 0)"
	[ "$attacker_hits" = "0" ] || fail_check "network-path reference reached the attacker sink ($attacker_hits hits)"

	local ns_status wm_status wp_status legit_status response_status response_content_type response_request_id response_leak
	ns_status="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).networkPathStatus)' "$driver_result" 2>/dev/null || echo -1)"
	wm_status="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).wrongMethodStatus)' "$driver_result" 2>/dev/null || echo -1)"
	wp_status="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).wrongPathStatus)' "$driver_result" 2>/dev/null || echo -1)"
	legit_status="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).legitStatus)' "$driver_result" 2>/dev/null || echo -1)"
	response_status="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).responseStatus)' "$driver_result" 2>/dev/null || echo -1)"
	response_content_type="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).responseContentType ?? "")' "$driver_result" 2>/dev/null || true)"
	response_request_id="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).responseRequestId ?? "")' "$driver_result" 2>/dev/null || true)"
	response_leak="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).responseLeak ?? "")' "$driver_result" 2>/dev/null || true)"
	case "$ns_status" in 400 | 404) ;; *) fail_check "network-path probe not rejected before fetch (status $ns_status)" ;; esac
	case "$wm_status" in 404) ;; *) fail_check "GET method not rejected (status $wm_status)" ;; esac
	case "$wp_status" in 404) ;; *) fail_check "unexpected path not rejected (status $wp_status)" ;; esac
	[ "$legit_status" = "200" ] || fail_check "legitimate POST /v1/responses did not reach fixed upstream (status $legit_status)"
	[ "$response_status" = "200" ] || fail_check "response-header probe failed (status $response_status)"
	[ "$response_content_type" = "application/json" ] || fail_check "allowed content-type response header was not preserved"
	[ "$response_request_id" = "req-safe" ] || fail_check "allowed x-request-id response header was not preserved"
	[ -z "$response_leak" ] || fail_check "unlisted upstream response header was forwarded"

	if [ -s "$upstream_record" ]; then
		local seen
		seen="$(bun -e '
const rec = JSON.parse((await Bun.file(process.argv[1]).text()).trim().split("\n").pop())
const h = rec.headers ?? {}
const present = (n) => (h[n] !== undefined ? "1" : "0")
const val = (n) => h[n] ?? ""
console.log(JSON.stringify({
  authorization: val("authorization"),
  contentType: present("content-type"),
  accept: present("accept"),
  userAgent: val("user-agent"),
  forwarded: val("forwarded"),
  xff: val("x-forwarded-for"),
  proxyAuth: present("proxy-authorization"),
  connection: val("connection"),
  cookie: present("cookie"),
  customSentinel: present("x-smoke-sentinel")
}))
' "$upstream_record" 2>/dev/null || echo '{}')"
		echo "$seen" | grep -q '"authorization":"Bearer SENTINEL-LEGIT-KEY"' || fail_check "upstream did not receive the client authorization header"
		echo "$seen" | grep -q '"contentType":"1"' || fail_check "upstream did not receive content-type"
		echo "$seen" | grep -q '"accept":"1"' || fail_check "upstream did not receive accept"
		echo "$seen" | grep -q 'SMOKE-UA-SENTINEL' && fail_check "client user-agent was forwarded"
		echo "$seen" | grep -q 'SMOKE-FWD-SENTINEL' && fail_check "forwarded header was copied"
		echo "$seen" | grep -q 'SMOKE-XFF-SENTINEL' && fail_check "x-forwarded-for was copied"
		echo "$seen" | grep -q '"proxyAuth":"1"' && fail_check "proxy-authorization was copied"
		echo "$seen" | grep -q '"connection":"close"' && fail_check "client connection hop-by-hop header was copied"
		echo "$seen" | grep -q '"cookie":"1"' && fail_check "cookie was copied"
		echo "$seen" | grep -q '"customSentinel":"1"' && fail_check "custom sentinel header was copied"
	else
		fail_check "upstream sink recorded no legitimate request"
	fi

	if grep -qi 'authorization\|SENTINEL\|"headers"\|SMOKE-' "$capture_log"; then
		fail_check "capture log persisted headers or a secret"
	fi
	grep -q '"path":"/v1/responses"' "$capture_log" || fail_check "capture log did not persist the method/path/body record"

	local mode
	mode="$(stat -c '%a' "$capture_log")"
	[ "$((8#$mode & 077))" -eq 0 ] || fail_check "capture log mode $mode is group/world accessible"

	local sec_config="$sec_dir/curl-health.conf"
	printf 'header = "Authorization: Bearer %s"\n' "SENTINEL-ARGV-KEY" >"$sec_config"
	chmod 600 "$sec_config"
	mode="$(stat -c '%a' "$sec_config")"
	[ "$((8#$mode & 077))" -eq 0 ] || fail_check "curl config mode $mode is group/world accessible"

	local slow_sink="$sec_dir/slow-sink.ts"
	local slow_ready="$sec_dir/slow.ready"
	cat >"$slow_sink" <<'TYPESCRIPT'
const readyPath = process.env.SLOW_READY_PATH!
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch() {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    return new Response('ok')
  }
})
await Bun.write(readyPath, `${server.port}\n`)
await new Promise(() => {})
TYPESCRIPT
	SLOW_READY_PATH="$slow_ready" bun "$slow_sink" >"$sec_dir/slow.log" 2>&1 &
	local slow_pid=$!
	register_security_self_test_pid "$slow_pid"
	for i in $(seq 1 100); do
		[ -s "$slow_ready" ] && break
		sleep 0.1
	done
	local slow_port
	slow_port="$(tr -d '[:space:]' <"$slow_ready" 2>/dev/null || true)"
	if [ "${KIRO_PROVIDER_SMOKE_SECURITY_SELF_TEST_FAIL_STAGE:-}" = "after_all_children_started" ]; then
		echo "codex-smoke: security self-test: injected failure after all loopback children started" >&2
		cleanup_security_self_test_processes
		return 97
	fi
	if [ -n "$slow_port" ]; then
		curl --silent --output /dev/null --config "$sec_config" \
			"http://127.0.0.1:$slow_port/health" &
		local curl_pid=$!
		register_security_self_test_pid "$curl_pid"
		sleep 0.4
		if [ -r "/proc/$curl_pid/cmdline" ]; then
			if tr '\0' ' ' <"/proc/$curl_pid/cmdline" | grep -q 'SENTINEL-ARGV-KEY'; then
				fail_check "health-probe curl exposed the API key in its argv"
			fi
		fi
		wait "$curl_pid" 2>/dev/null || true
		forget_security_self_test_pid "$curl_pid"
	else
		fail_check "slow loopback sink did not start for the argv check"
	fi
	cleanup_security_self_test_processes

	if [ "$failures" -ne 0 ]; then
		echo "codex-smoke: security self-test: FAIL ($failures assertion(s))" >&2
		return 1
	fi
	echo "codex-smoke: security self-test PASS: origin/path fixed, headers minimized, capture header-free, key absent from argv, temp files owner-only"
	return 0
}

run_security_cleanup_failure_self_test() {
	local pid_record="$WORK/security-cleanup-pids"
	local child_stdout="$WORK/security-cleanup-child.stdout"
	local child_stderr="$WORK/security-cleanup-child.stderr"
	local child_status=0 pid recorded=0 alive=0
	: >"$pid_record"

	set +e
	KIRO_PROVIDER_SMOKE_SECURITY_SELF_TEST=1 \
		KIRO_PROVIDER_SMOKE_SECURITY_SELF_TEST_CHILD=1 \
		KIRO_PROVIDER_SMOKE_SECURITY_SELF_TEST_FAIL_STAGE=after_all_children_started \
		KIRO_PROVIDER_SMOKE_SECURITY_PID_RECORD="$pid_record" \
		bash "${BASH_SOURCE[0]}" >"$child_stdout" 2>"$child_stderr"
	child_status=$?
	set -e

	if [ "$child_status" -ne 97 ]; then
		echo "codex-smoke: security cleanup self-test: FAIL: injected child exited $child_status, expected 97" >&2
		cat "$child_stdout" >&2
		cat "$child_stderr" >&2
		return 1
	fi

	while IFS= read -r pid; do
		[ -n "$pid" ] || continue
		recorded=$((recorded + 1))
		if kill -0 "$pid" 2>/dev/null; then
			echo "codex-smoke: security cleanup self-test: FAIL: recorded PID $pid remains alive" >&2
			alive=$((alive + 1))
		fi
	done <"$pid_record"

	if [ "$recorded" -ne 4 ] || [ "$alive" -ne 0 ]; then
		echo "codex-smoke: security cleanup self-test: FAIL: expected 4 terminated loopback PIDs, recorded=$recorded alive=$alive" >&2
		cat "$child_stderr" >&2
		return 1
	fi
	echo "codex-smoke: security cleanup self-test PASS: injected child exit $child_status; all 4 loopback PIDs terminated and reaped"
}

if [ "${KIRO_PROVIDER_SMOKE_SECURITY_SELF_TEST:-0}" = "1" ]; then
	if [ "${KIRO_PROVIDER_SMOKE_SECURITY_SELF_TEST_CHILD:-0}" != "1" ]; then
		run_security_cleanup_failure_self_test
	fi
	run_security_self_test
	exit 0
fi

if [ "${KIRO_PROVIDER_SMOKE_GUARD_SELF_TEST:-0}" = "1" ]; then
	echo "codex-smoke: testing fail-closed guards against real Codex state"
	set +e
	assert_isolated_codex_path "CODEX_HOME" "$HOME/.codex"
	HOME_GUARD_STATUS=$?
	assert_isolated_codex_path "CODEX_SQLITE_HOME" "$ORIGINAL_CODEX_SQLITE_HOME"
	SQLITE_GUARD_STATUS=$?
	set -e
	if [ "$HOME_GUARD_STATUS" -eq 0 ] || [ "$SQLITE_GUARD_STATUS" -eq 0 ]; then
		echo "codex-smoke: ERROR: an isolation guard accepted protected Codex state" >&2
		exit 1
	fi
	echo "codex-smoke: isolation guard self-test PASS"
	exit 0
fi

export CODEX_HOME="$WORK/codex-home"
export CODEX_SQLITE_HOME="$WORK/codex-sqlite-home"
assert_isolated_codex_path "CODEX_HOME" "$CODEX_HOME"
assert_isolated_codex_path "CODEX_SQLITE_HOME" "$CODEX_SQLITE_HOME"
mkdir -p "$CODEX_HOME" "$CODEX_SQLITE_HOME"
echo "codex-smoke: isolated CODEX_HOME=$CODEX_HOME and CODEX_SQLITE_HOME=$CODEX_SQLITE_HOME"

if [ "${KIRO_PROVIDER_SMOKE_OUTCOME_SELF_TEST:-0}" = "1" ]; then
	run_outcome_self_test
	exit 0
fi

if [ "${KIRO_PROVIDER_SMOKE_NAMESPACE_SELF_TEST:-0}" = "1" ]; then
	run_namespace_self_test
	exit 0
fi

if ! command -v codex >/dev/null 2>&1; then
	echo "codex-smoke: ERROR: codex is not installed or not on PATH" >&2
	exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
	echo "codex-smoke: ERROR: openssl is required to generate the temporary API key" >&2
	exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
	echo "codex-smoke: ERROR: curl is required for the gateway health check" >&2
	exit 1
fi
if ! command -v timeout >/dev/null 2>&1; then
	echo "codex-smoke: ERROR: GNU timeout is required to bound codex exec" >&2
	exit 1
fi

EXPECTED_CODEX_VERSION="${CODEX_SMOKE_EXPECTED_VERSION:-0.149.0}"
SMOKE_MODE="${KIRO_PROVIDER_SMOKE_MODE:-connectivity}"
case "$SMOKE_MODE" in
	connectivity|tools) ;;
	*)
		echo "codex-smoke: ERROR: KIRO_PROVIDER_SMOKE_MODE must be connectivity or tools" >&2
		exit 1
		;;
esac
REASONING_EFFORT="${KIRO_PROVIDER_SMOKE_REASONING_EFFORT:-xhigh}"
case "$REASONING_EFFORT" in
	minimal|low|medium|high|xhigh) ;;
	*)
		echo "codex-smoke: ERROR: KIRO_PROVIDER_SMOKE_REASONING_EFFORT must be minimal, low, medium, high, or xhigh" >&2
		exit 1
		;;
esac
CODEX_SANDBOX_MODE="${KIRO_PROVIDER_SMOKE_SANDBOX_MODE:-workspace-write}"
case "$CODEX_SANDBOX_MODE" in
	read-only|workspace-write|danger-full-access) ;;
	*)
		echo "codex-smoke: ERROR: KIRO_PROVIDER_SMOKE_SANDBOX_MODE must be read-only, workspace-write, or danger-full-access" >&2
		exit 1
		;;
esac
CODEX_VERSION="$(codex --version 2>&1)"
RUNNING_CODEX_VERSION="$(printf '%s\n' "$CODEX_VERSION" | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)"
if [ "$RUNNING_CODEX_VERSION" != "$EXPECTED_CODEX_VERSION" ]; then
	echo "codex-smoke: ERROR: expected exact codex version '$EXPECTED_CODEX_VERSION', got: $CODEX_VERSION" >&2
	echo "codex-smoke: the Responses wire contract was verified against codex-cli 0.149.0" >&2
	exit 1
fi
echo "codex-smoke: codex version accepted: $CODEX_VERSION"
echo "codex-smoke: reasoning=$REASONING_EFFORT sandbox=$CODEX_SANDBOX_MODE"
if [ "$SMOKE_MODE" = "tools" ]; then
	echo "codex-smoke: scope: connectivity plus custom exec success/failure and namespace collaboration"
else
	echo "codex-smoke: scope: connectivity/reasoning only; set KIRO_PROVIDER_SMOKE_MODE=tools to test tools"
fi

PORT="${KIRO_PROVIDER_PORT:-8899}"
APIKEY="${KIRO_PROVIDER_SMOKE_KEY:-sk-smoke-$(openssl rand -hex 6)}"
MODEL="${KIRO_PROVIDER_SMOKE_MODEL:-gpt-5.6-sol}"
GATEWAY_CONFIG="$WORK/kiro-provider.json"
GATEWAY_LOG="$WORK/kiro-provider.log"
CODEX_STDOUT="$WORK/codex.stdout.log"
CODEX_STDERR="$WORK/codex.stderr.log"
TOOL_WORKSPACE="$WORK/tool-workspace"
mkdir -p "$TOOL_WORKSPACE"

cat >"$GATEWAY_CONFIG" <<JSON
{
  "host": "127.0.0.1",
  "port": $PORT,
  "api_keys": ["$APIKEY"],
  "log_level": "info"
}
JSON

export LOCALGW_KEY="$APIKEY"

# Keep the gateway key out of every child process argv: curl reads the bearer
# header from an owner-only config file instead of a -H flag on its command line.
CURL_HEALTH_CONFIG="$WORK/curl-health.conf"
(
	umask 077
	printf 'header = "Authorization: Bearer %s"\n' "$APIKEY" >"$CURL_HEALTH_CONFIG"
)
chmod 600 "$CURL_HEALTH_CONFIG"

if [ -x ./dist/kiro-provider ]; then
	GATEWAY_CMD=(./dist/kiro-provider serve --config "$GATEWAY_CONFIG")
else
	if ! command -v bun >/dev/null 2>&1; then
		echo "codex-smoke: ERROR: ./dist/kiro-provider is absent and bun is not on PATH" >&2
		exit 1
	fi
	GATEWAY_CMD=(bun run src/cli/bin.ts serve --config "$GATEWAY_CONFIG")
fi

"${GATEWAY_CMD[@]}" >"$GATEWAY_LOG" 2>&1 &
SVPID=$!

HEALTH_UP=0
for _ in $(seq 1 100); do
	if ! kill -0 "$SVPID" 2>/dev/null; then
		echo "codex-smoke: FAIL (1) gateway exited before becoming healthy" >&2
		cat "$GATEWAY_LOG" >&2
		exit 1
	fi
	HTTP_STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' \
		--config "$CURL_HEALTH_CONFIG" \
		"http://127.0.0.1:$PORT/health" || true)"
	if [ "$HTTP_STATUS" = "200" ]; then
		HEALTH_UP=1
		break
	fi
	sleep 0.1
done

if [ "$HEALTH_UP" -ne 1 ]; then
	echo "codex-smoke: FAIL (1) gateway health did not return HTTP 200 within 10 seconds" >&2
	cat "$GATEWAY_LOG" >&2
	exit 1
fi
echo "codex-smoke: PASS (1) gateway health is up"

CODEX_BASE_URL="http://127.0.0.1:$PORT/v1"
if [ "$SMOKE_MODE" = "tools" ]; then
	if ! command -v bun >/dev/null 2>&1; then
		echo "codex-smoke: ERROR: bun is required for tools-mode request capture" >&2
		exit 1
	fi
	start_capture_proxy
	CODEX_BASE_URL="$CAPTURE_BASE_URL"
	echo "codex-smoke: request-body capture proxy is ready on an isolated loopback port"
fi

cat >"$CODEX_HOME/config.toml" <<TOML
model = "$MODEL"
model_provider = "localgw"
model_reasoning_effort = "$REASONING_EFFORT"

[model_providers.localgw]
name = "Local Gateway"
base_url = "$CODEX_BASE_URL"
env_key = "LOCALGW_KEY"
wire_api = "responses"
TOML

set +e
(
	cd "$WORK"
	NO_COLOR=1 TERM=dumb timeout --signal=TERM --kill-after=5 120 \
		codex exec --skip-git-repo-check \
		-c approval_policy=never \
		-c "sandbox_mode=$CODEX_SANDBOX_MODE" \
		"Reply with exactly: OK" </dev/null
) >"$CODEX_STDOUT" 2>"$CODEX_STDERR"
CODEX_STATUS=$?
set -e

cat "$CODEX_STDOUT"
cat "$CODEX_STDERR" >&2

set +e
classify_turn_outcome "$CODEX_STATUS" "$CODEX_STDOUT" "$CODEX_STDERR" "$GATEWAY_LOG"
OUTCOME_STATUS=$?
set -e
if [ "$OUTCOME_STATUS" -eq 1 ]; then
	echo "codex-smoke: gateway log follows:" >&2
	cat "$GATEWAY_LOG" >&2
fi
if [ "$OUTCOME_STATUS" -ne 0 ]; then
	exit "$OUTCOME_STATUS"
fi
if [ "$SMOKE_MODE" = "connectivity" ]; then
	exit 0
fi

set +e
run_tool_probes
TOOLS_STATUS=$?
set -e
if [ "$TOOLS_STATUS" -eq 1 ]; then
	echo "codex-smoke: gateway log follows:" >&2
	cat "$GATEWAY_LOG" >&2
fi
exit "$TOOLS_STATUS"
