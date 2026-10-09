# Explicit thinking display recovery

The production regression appeared after Opus 5.5 summarized display became
accepted in 3.8.3. Existing Paseo clients explicitly requested summarized/max;
failed attempts contained nonempty reasoning and distinct signatures. The
pre-existing empty-prefix recovery could not safely omit those outputs.

The recovery is an operator setting, `anthropic_thinking_display_mode: omitted`.
It is applied after the original request and historical replay are validated.
Current output uses omitted display and opaque replay; original history, model,
effort and budget remain intact. Converted responses report
`x-kiro-thinking-display-mode: forced-omitted`. The default is `preserve`, and
nonempty/redacted/mixed/late/oversized conflicts remain fatal.

## Acceptance

- [validation.json](validation.json) binds the implementation-input digest and
  candidate binary to the pre-fix failure and full pre-ci gate: 3137 passing
  tests and 95.69% line coverage against the 93% floor.
- [client-recovery.json](client-recovery.json) runs real Claude Code 2.1.294 in a
  private network namespace with synthetic SDK responses. Its recovery case
  sends explicit summarized/max, verifies omitted/max SDK dispatch, executes a
  harmless printf tool, replays its signed result and completes. Shared settings
  are unchanged. The launcher implementation is passed directly because the
  installed outer wrapper resolves its implementation through HOME.
- [packaged-recovery.json](packaged-recovery.json) runs the compiled candidate
  against synthetic AWS EventStream frames. JSON and SSE recover empty-prefix
  conflicts, report both compatibility markers, keep max, and reject nonempty
  conflicts without publication or an extra upstream call.
- [live-recovery.json](live-recovery.json) uses a read-only production account
  source and an isolated state copy without refresh credentials or maintenance.
  Real Kiro handles an explicit summarized/max JSON tool turn, its opaque signed
  history and tool result at max over SSE, plus the existing Goal JSON/SSE gate.
- [local-runtime.json](local-runtime.json) verifies the installed/process digest,
  health/readiness/authentication and the live database integrity. Local cutover
  required a sequencing and trailing-escape configuration correction. The file
  records two operator restarts and at least 26 observed automatic startup
  retries before correction; its zero restart count describes the corrected
  process only. The rollback preserves the current database and keyring.
- [runtime-recovery.json](runtime-recovery.json) counts naturally arriving
  existing-client requests after the corrected start, including preserved max
  dispatches, normal completions and reasoning failures. No messages were sent
  to users' agents to trigger this observation.

## Root-cause boundary

[signature-shape.json](signature-shape.json) comes from the retained direct SDK
probe. Three synthetic summarized/max turns, including replayed signed history,
each returned one complete signature. This control does not reproduce the real
long-session conflict and does not establish signature fragmentation.

`sdk_reasoning_signature_observed` records positions, lengths, relation enums
and thinking character counts. Values, signature hashes and thinking text never
enter the evidence. Distinct and prefix-related signatures stay fatal unless
the existing empty-prefix omission applies. No signature concatenation was
introduced.

```sh
bun scripts/probe-claude-thinking-display.ts \
  --claude-bin /path/to/claude --before-launcher /path/to/launcher-implementation \
  --out /private/client-recovery.json
bun scripts/probe-opus-prefix.mjs \
  --binary /private/kiro-provider --thinking-display-mode omitted
bun scripts/probe-claude-compatibility-live.ts --confirm \
  --binary /private/kiro-provider --thinking-display-mode omitted \
  --out /private/live-recovery.json
bun scripts/probe-reasoning-signatures.ts --confirm --turns 3 \
  --out /private/signature-shape.json
```

All committed files contain synthetic fixture results or approved enums,
counts, lengths, statuses and digests. Private account copies, raw histories,
configuration, keyrings and provider logs are excluded.
