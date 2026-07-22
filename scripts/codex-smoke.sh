#!/usr/bin/env bash
set -euo pipefail

WORK="$(mktemp -d)"
if ! [ -n "$WORK" ] || ! [ -d "$WORK" ]; then
	echo "codex-smoke: ERROR: mktemp did not create an isolated working directory" >&2
	exit 1
fi
trap 'kill "${SVPID:-}" "${MOCKPID:-}" 2>/dev/null || true; rm -rf "$WORK"' EXIT

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

assert_isolated_codex_home() {
	local candidate_real real_codex_home
	candidate_real="$(canonical_path "$1")"
	real_codex_home="$(canonical_path "$HOME/.codex")"
	case "$candidate_real" in
		"$real_codex_home"|"$real_codex_home"/*)
			echo "codex-smoke: ERROR: refusing CODEX_HOME inside real ~/.codex: $candidate_real" >&2
			return 1
			;;
	esac
}

has_expected_model_content() {
	grep -Eq '^[[:space:]]*OK[[:space:]]*$' "$1"
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
		echo "codex-smoke: note: this turn does not test tools; standard function tools are supported, but custom exec/apply_patch and namespace collaboration are unsupported"
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

assert_isolated_codex_home "$WORK"

export CODEX_HOME="$WORK"
mkdir -p "$CODEX_HOME"
echo "codex-smoke: isolated CODEX_HOME=$CODEX_HOME (real ~/.codex untouched)"

if [ "${KIRO_PROVIDER_SMOKE_GUARD_SELF_TEST:-0}" = "1" ]; then
	echo "codex-smoke: testing fail-closed guard against real ~/.codex"
	assert_isolated_codex_home "$HOME/.codex"
	echo "codex-smoke: ERROR: isolation guard unexpectedly accepted real ~/.codex" >&2
	exit 1
fi

if [ "${KIRO_PROVIDER_SMOKE_OUTCOME_SELF_TEST:-0}" = "1" ]; then
	run_outcome_self_test
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

EXPECTED_CODEX_VERSION="${CODEX_SMOKE_EXPECTED_VERSION:-0.144.6}"
CODEX_VERSION="$(codex --version 2>&1)"
RUNNING_CODEX_VERSION="$(printf '%s\n' "$CODEX_VERSION" | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)"
if [ "$RUNNING_CODEX_VERSION" != "$EXPECTED_CODEX_VERSION" ]; then
	echo "codex-smoke: ERROR: expected exact codex version '$EXPECTED_CODEX_VERSION', got: $CODEX_VERSION" >&2
	echo "codex-smoke: the Responses wire contract was verified against codex-cli 0.144.6" >&2
	exit 1
fi
echo "codex-smoke: codex version accepted: $CODEX_VERSION"
echo "codex-smoke: scope: this smoke proves connectivity/reasoning only; it does not test tool capability"
echo "codex-smoke: scope: custom exec/apply_patch and namespace collaboration tools are unsupported"

PORT="${KIRO_PROVIDER_PORT:-8899}"
APIKEY="${KIRO_PROVIDER_SMOKE_KEY:-sk-smoke-$(openssl rand -hex 6)}"
MODEL="${KIRO_PROVIDER_SMOKE_MODEL:-gpt-5.6-sol}"
GATEWAY_CONFIG="$WORK/kiro-provider.json"
GATEWAY_LOG="$WORK/kiro-provider.log"
CODEX_STDOUT="$WORK/codex.stdout.log"
CODEX_STDERR="$WORK/codex.stderr.log"

cat >"$GATEWAY_CONFIG" <<JSON
{
  "host": "127.0.0.1",
  "port": $PORT,
  "api_keys": ["$APIKEY"],
  "log_level": "info"
}
JSON

cat >"$CODEX_HOME/config.toml" <<TOML
model = "$MODEL"
model_provider = "localgw"

[model_providers.localgw]
name = "Local Gateway"
base_url = "http://127.0.0.1:$PORT/v1"
env_key = "LOCALGW_KEY"
wire_api = "responses"
TOML
export LOCALGW_KEY="$APIKEY"

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
		-H "Authorization: Bearer $APIKEY" \
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

set +e
(
	cd "$WORK"
	NO_COLOR=1 TERM=dumb timeout --signal=TERM --kill-after=5 120 \
		codex exec --skip-git-repo-check \
		-c approval_policy=never \
		-c sandbox_mode=workspace-write \
		"Reply with exactly: OK"
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
exit "$OUTCOME_STATUS"
