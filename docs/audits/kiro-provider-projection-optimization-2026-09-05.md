# Request-projection optimization and research tooling

Date: 2026-09-05

Status: implementation candidate. Static/unit/integration gates and the first
live fidelity decision are recorded below.

## Confirmed defect and correction

The provider-matrix failure was a new request-shape failure: released
`legacy-user-prefix` moved trailing reconciliation instructions before an
earlier assistant result, then sent an empty current Kiro user message.

The candidate now:

- keeps leading/intermediate instruction migration at the first-user boundary;
- keeps a trailing contiguous instruction suffix at the current boundary;
- preserves current tool results, images, and documents;
- creates a non-empty synthetic current user after assistant history;
- rejects a true assistant-ending request with `missing_current_input`;
- treats any non-empty text bytes, including whitespace-only text, as input;
- accepts empty-content structured tool results; and
- adds no separator when an empty text part accompanies structured input.

Responses and Chat preserve the OpenAI-compatible `code` and `param`.
Anthropic Messages translates the same rejection to its native
`invalid_request_error` envelope. No rejected request constructs an SDK
client.

## Payload-free request correlation

One random `request_id` now follows each public request through:

1. `request_shape`;
2. `request_projection_completed`;
3. `request_history_built`;
4. every `sdk_dispatch_started` attempt;
5. completion-witness events; and
6. `sdk_stream_terminal`.

`attempt` counts actual SDK sends. All new fields are counts, enums, lengths,
or hashes. Request text, tool names/arguments, signatures, and credentials are
not logged.

## Research tooling

- `scripts/probe-projection-fidelity.ts` generates the controlled native
  context versus legacy-current-boundary matrix. It defaults to 400 live
  requests and requires `--confirm`; `--dry` spends no quota.
- `scripts/effort-study.ts` generates the fixed 72-cell max/xhigh AB/BA plan
  and analyzes completed bundles directly from `request_id`,
  `sdk_dispatch_started`, and terminal events.
- `scripts/responses-effort-study.ts` executes that same 72-cell plan
  sequentially through the standard OpenAI Responses route, with six
  machine-graded synthetic implementation/debugging tasks. This is the
  primary Zuno-independent effort gate.
- `scripts/kiro-cli-wire-diff.ts` produces a sanitized structural diff between
  Kiro CLI/IDE and provider command dumps. It removes credentials, signatures,
  ids, tool names, text, and binary content before output.

Fresh CLI interception is a fallback only. Existing Kiro logs/captures are
first-hand evidence and must be mined first. Enabling a temporary CA, HTTPS
interception, or debugger attachment still requires separate authorization.

## Compatibility decision

`safe` remains fail-closed until every model/effort/case in the native-context
matrix preserves content, order, priority, and tool behavior. The explicit
`legacy-user-prefix` mode remains deprecated, but its removal is
evidence-gated rather than tied to the already-past v0.7.0 date.

The first live stop-gate run used GPT-5.6 Sol / xhigh with one repetition of
all five cases. Native `additionalContext` passed 0/5; the
legacy-current-boundary controls passed 5/5, with zero transport errors.
Because the enablement gate requires every native case to pass, the remaining
390 requests were not spent: this result is already sufficient to keep
`safe` fail-closed.

The CLI fallback was also advanced:

- Kiro CLI was upgraded from 2.12.0 to 2.21.1; the new binary SHA-256 is
  `6880acd76a902afb4f0ba3c5d29134e6608c0b359632227105d08a0756357e21`.
- A synthetic non-interactive request completed and returned its exact marker.
- The CLI session record identified the effective model as `claude-opus-5`;
  the CLI warned that its non-interactive model-setting method was unavailable.
- Current CLI session files contain prompt/response and metering metadata, but
  no serialized `GenerateAssistantResponse` command. CA/MITM or debugger
  interception was therefore not performed without its separate authorization.

## Validation commands

```sh
bun test
bun run lint
bun run typecheck
bun run build:binary
git diff --check
```

Loopback tests must run in an environment that permits binding `127.0.0.1`.
Production port 8787, the installed binary, and the production account
database are outside this candidate's write scope.

Current candidate evidence:

- 1,494 tests passed, 0 failed;
- lint, TypeScript typecheck, and `git diff --check` passed;
- compiled binary SHA-256:
  `f9891266866f816b13a24d4f8a3fd3322e5d2284f4788f4e8f38a78eb662744b`.

Isolated port-18787 smoke results used a SQLite `.backup` whose
`PRAGMA integrity_check` returned `ok`:

| Cell | Score / exit | Requests / dispatches / terminals | Witnessed | Provider errors |
| --- | --- | --- | --- | --- |
| Plan debugging Claude xhigh | 90 / 0 | 14 / 14 / 14 | 14/14 | 0 |
| Plan debugging Claude max | 100 / 0 | 16 / 16 / 16 | 16/16 | 0 |
| Build debugging Claude xhigh control | 100 / 0 | 12 / 12 / 12 | 12/12 | 0 |

These Zuno runs are compatibility evidence only, not the final gate, because
Zuno was changing during this work.

The xhigh Plan score was an answer-quality variation: every diagnosis category
passed, the process exited cleanly, and no projection/provider error occurred.
The original malformed-request failure did not recur.

Standard Responses black-box probing also found that Kiro rejects an omitted
tool description as HTTP 400 `Invalid tool use format`. Supplying the same
tool with a non-empty description makes the tool-result plus trailing
instruction shape succeed. The candidate now returns local
`missing_tool_description` instead of fabricating text or sending the invalid
declaration upstream.

## Standard Responses final evidence

The final candidate binary was started only on isolated port 18787 with the
SQLite backup. A final eight-request boundary run passed 8/8:

| Case | Status | SDK dispatch / terminal | Result |
| --- | --- | --- | --- |
| assistant + trailing instruction | 200 | 1 / 1 witnessed | `synthetic_user` |
| tool result + trailing instruction | 200 | 1 / 1 witnessed | `append_tool` |
| empty text + image + document + trailing instruction | 200 | 1 / 1 witnessed | `append_user` |
| assistant ending | 400 | 0 / 0 | `missing_current_input`, `input.0` |
| GPT max / xhigh controls | 200 / 200 | 1 / 1 each | exact effort |
| Claude max / xhigh controls | 200 / 200 | 1 / 1 each | exact effort |

The final 72-cell Responses study completed all 36 AB/BA pairs:

- 72/72 requests had exactly one SDK dispatch, one witnessed terminal, the
  exact model and effort, one identical account hash, and zero provider errors.
- Safety passed 72/72. Machine-graded task quality passed 70/72.
- GPT-5.6 Sol passed quality 36/36. Median wall time was 2,351.5 ms for max and
  2,209.5 ms for xhigh: xhigh improved 6.04% and won 50% of pairs, below both
  the 15% and 70% gates. Recommendation: `no-change`.
- Claude Opus 5 passed quality 34/36; two max samples returned a wrong answer
  on the same synthetic arithmetic task. Median wall time was 3,004 ms for max
  and 3,152 ms for xhigh; xhigh was 4.93% slower and won 44.44% of pairs.
  Recommendation: `no-change` because the zero-quality-regression gate failed.
- SDK dispatch medians were 1 for both efforts and both models.

An initial 72-cell run was preserved separately because two synthetic grading
prompts allowed semantically equivalent labels or punctuation. Those tasks
were made unambiguous and the entire matrix was rerun; no initial score was
silently rewritten.

Evidence files:

- `/tmp/kiro-provider-optimization-e2e-20260905/responses-live-e2e-final-candidate.json`
- `/tmp/kiro-provider-optimization-e2e-20260905/responses-effort-study-72-final.json`
- `/tmp/kiro-provider-optimization-e2e-20260905/responses-effort-study-72-initial.json`

After shutdown, isolated port 18787 was closed, the backup database still
reported `PRAGMA integrity_check=ok`, and production port 8787 still returned
`{"status":"ok"}`.
