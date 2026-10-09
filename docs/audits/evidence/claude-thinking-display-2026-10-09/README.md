# Claude Code thinking display acceptance

The live process investigation found Claude Code 2.1.294 launched by Paseo with
an explicit `--thinking-display summarized`. The user and managed settings had
no `showThinkingSummaries` key. Changing only the launcher's default preference
would therefore leave this session's explicit request unchanged.

`client-before.json` records the real client sending that explicit request to
the uncorrected gateway: HTTP 400, no SDK dispatch, and client exit 1.
`launcher-regression.json` records the failing inherited-preference regression
and the passing launcher suite after the fix.

The executable probe is `scripts/probe-claude-thinking-display.ts`. It launches
the installed client inside a separate bubblewrap network namespace containing
its own loopback 8787. The temporary managed-settings copy preserves policy
restrictions and pins synthetic routing and authentication. The client uses
temporary user settings, file and inline caller overlays, an in-memory replay
store, and the real gateway's authentication, adapter, pipeline, and SSE path.
The upstream SDK is synthetic; these results do not establish live Kiro model
support. All request and transcript bytes stay in memory.

```sh
bun scripts/probe-claude-thinking-display.ts \
  --claude-bin /path/to/installed/claude \
  --before-launcher /path/to/saved/pre-fix/kiroclaude \
  --out /tmp/claude-thinking-evidence.json
```

The after evidence checks the original installed launcher with the explicit
Paseo request, the new launcher's default at xhigh and max, explicit summarized
thinking at max, and rejection of summarized thinking on an unsupported model.
Successful cases include a harmless Bash printf, a tool-result turn, nonempty
summarized thinking when requested, opaque reasoning replay, final client
output, unchanged shared settings, and completed upstream iterator cleanup.

Claude Code may first probe an optional `output_config` field that the gateway
rejects. The probe permits that 400 only with zero SDK dispatches; the client
then retries the preflight with the supported request shape. Accepted requests
must preserve effort and effective thinking display through SDK dispatch.
The launcher disables Claude's automatic `updates` mode for Kiro because that
separate display mode is unsupported. Explicit summarized flags remain intact.

The generated after evidence contains only counts, booleans, approved field
enums, effort/display modes, client versions, and response statuses. It contains
no prompts, tool names or arguments, session IDs, tokens, raw headers, or raw
logs. Temporary policy, client state, and network namespaces are removed when
the probe exits.

The main-based candidate is separately bound in
[local-candidate.json](local-candidate.json), with its binary digest, complete
preflight, health/authentication checks and consistent database backup.
[client-candidate-main.json](client-candidate-main.json) repeats the real-client
gate on that source tree; [installed-launcher.json](installed-launcher.json)
checks the updated installed launcher in the isolated fixture.

[live-candidate.json](live-candidate.json) records four successful real Kiro
requests: summarized/max JSON with a tool call, summarized/xhigh SSE with the
complete signed tool history, and Goal JSON/SSE decisions. The executable
`scripts/probe-claude-compatibility-live.ts` uses a fresh loopback gateway and a
single-account state copy with background maintenance disabled and unusable
refresh credentials. It removes the private provider, configuration, database,
keyring and logs afterward. The original account database is read-only.
The [Goal acceptance](../claude-goal-evaluation-2026-10-09/validation.json)
also verifies the native Claude goal loop with two real Kiro evaluator calls.
