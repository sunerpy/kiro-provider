# Stream delivery and recovery validation

Baseline: `v3.1.0 / 5c376b00a19cc06a78bdcb8b83926ad05c45212b`.
This change is confined to Kiro Provider. The detailed before/after analysis is
in [the Chinese report](stream-delivery-recovery-2026-09-13.zh.md).

- A real accepted upstream stream now publishes headers and lifecycle before a
  tool call is complete. Function arguments are forwarded incrementally; custom
  wrappers remain buffered until their full string can be restored safely.
- JSON, schema, aggregate size, Unicode and identity checks still gate tool
  completion. A failed accepted generation is never transparently replayed.
- Error evidence preserves the first/last upstream failure, actual status and
  request IDs, plus the eventual deadline or cancellation. Raw activity and
  projectable progress are counted separately; neither resets the total budget.
- Live Chat validation discovered that KiroRuntime RPC initial metadata was
  being decoded with REST JSON. The SDK's own RPC codec fixes this; protocol
  choices have separate client cache entries.

| Real acceptance | Result |
| --- | --- |
| Responses function calls and full-output replay, five models × three repetitions | 15/15 |
| Namespace and custom round trips | 2/2 |
| SDK cancellation after acceptance | 1/1 |
| Chat tool round trips, Sol/Opus × three; Sonnet/Terra/Luna × one | 9/9 |
| Chat ordinary default/max effort controls, Sol/Opus | 4/4 |
| Isolated Zuno 0.10.37 single turns, Sol/Opus × three | 6/6 |
| Native CreateResponse controls, five models | Five actual 403 permission denials; native generation remains unverified under these account conditions |
| GPT explicit 2,048 output-token limit | Still rejected with `unsupported_output_token_limit` |

No tools were executed by live probes. Tool-result turns explicitly supplied a
fixed fixture value and verified the exact response, identity, arguments and
absence of duplicate calls. Eleven of seventeen Responses round trips carried
`kr1_`; every required account binding survived replay. Requested and dispatched
effort remained `max`, independently of visible reasoning.

The controlled HTTP regressions first failed four delivery assertions while a
complete-call control passed. The repaired cases also cover a separate Node peer
with no first frame, cancellation/socket closure, idle versus total budget,
incomplete/malformed/oversized calls, SDK failures and native event consistency.
These tests establish the delivery boundary; small live latency samples are not
a model-performance benchmark.

[Sanitized evidence](evidence/stream-delivery-2026-09-13/README.md) contains stable
probe IDs and source-file checksums. Credentials, original user payloads and
private reasoning are excluded. The PR and release records bind final CI and
public assets to their exact commits.

Final local checks: **1,691 tests pass**, zero failures, **93.83%** line coverage against the unchanged 93% gate. Typecheck, formatting/lint, shell syntax, coverage parity, seven security checks, smoke security and JS/npm/binary builds pass.

No database DDL or timeout/model/reasoning defaults change. Accepted empty streams
are no longer replaced; non-stream recovery retains its existing bounded policy.
The existing body budget also caps accumulated tool arguments. Production Chat
remains disabled if configured that way; it was enabled only in the isolated
acceptance service. Back up the binary, configuration, replay keys and a consistent
account database before cutover, verify public asset bytes, then validate the
installed service and clients. Zuno needs no configuration migration.
