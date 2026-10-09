# Claude Goal evaluation verification

`validation.json` records a new Claude Code 2.1.294 verification against the
release candidate based on `99241f3dcc6ce6994452716bea96dbeeec42847e`.
The earlier primary checkout and October 6 evidence used base `5385f24`; their
results are not used as current acceptance evidence.

The complete `/goal` reproducer first used the exact main branch version of
`src/server/anthropic/structured-output.ts` through a read-only mount. The
evaluator returned HTTP 400, the Goal remained visible, and Claude stopped after
one main dispatch without evaluator feedback or a Bash result. Both JSON and
SSE ingress regressions also failed with expected HTTP 200 versus actual 400.

With the candidate, all 86 structured-output regressions passed. Native `/goal`
passed the continue, complete, impossible, invalid-output, and rejected-request
cases; the configured Stop prompt hook also completed its continue loop. The
real Kiro run forwarded only the two evaluator requests to the isolated candidate
gateway. Both returned SSE 200 with `hook-evaluation-v1`: incomplete, then
complete. Claude received the first evaluator's feedback and executed the Bash
check between those decisions. Main-model generation was synthetic.

The executable harness is `scripts/probe-claude-goal.ts`. These runs used
`--native-goal --bind-port 8787` inside a private Linux network namespace, with
`KIRO_GOAL_PROBE_PARENT_NETNS` containing the host namespace identifier. Bubblewrap
mounted the host read-only, provided private PID/IPC namespaces and `/tmp`, and
bound only the evidence output directory writable. For the real evaluator run,
`--live-base-url`, `--provider-config`, and `--live-unix-socket` reached an isolated
single-account gateway through a temporary Unix socket proxy. The proxy was
stopped after verification; temporary client homes and namespaces were removed.

The evidence contains only version strings, hashes, approved enums, counts and
booleans. It contains no copied account state, credentials, prompts, evaluator
reasons, tool arguments, session identifiers or raw wire data. The original user
session was not resumed. Claude's own recovery from evaluator errors remains a
client decision; the provider does not create an approval or retry an accepted
generation. The first message-local `output_config` request remains rejected,
after which the tested client falls back and proceeds.
