# Native Claude tool replay shape repair

The reported HTTP 400 was different from the upstream reasoning-signature
conflict. Read-only inspection authenticated the retained tenant, model, key,
ciphertext and provenance, then established two historical-input changes:
Claude inserted the default `replace_all: false` into Edit calls, and removed a
redundant literal `cd` prefix from Bash commands while the launcher retained its
initial normalization scope.

The gateway reconstructs bounded candidates from the complete historical
output. A token header filters candidates only; the normal decoder still checks
tenant/model/output, GCM, expiry and normalization provenance. Authenticated
restorations are applied to upstream tool history, preserving the exact original
ID, name and input. Current declarations remain the authorization for new calls.
No token data, key, prompt, real tool arguments or session identifier is committed.

- [cwd-client-before.json](cwd-client-before.json) runs the real Claude client
  against a private fixture modeling a normalization scope retained from an
  earlier directory. The client removes its redundant Bash prefix and the
  unchanged implementation rejects the next request before another dispatch.
- [edit-client-before.json](edit-client-before.json) runs Read then Edit in a
  private project. Claude inserts false on replay, and the unchanged gateway
  rejects the third request before another dispatch.
- [normalization-client-after.json](normalization-client-after.json) repeats
  both complete native-client paths after repair. The Bash path makes two SDK
  calls; Read/Edit makes three. Signed replay, max effort and cleanup verify.
- [real-session-replay-validation.json](real-session-replay-validation.json)
  contains counts/enums from 14 retained real tokens. Existing unchanged tokens
  keep authenticating; the two affected outputs authenticate after exact-input
  restoration. No production transcript or database was changed by this check.
- [history-client-before.json](history-client-before.json) and
  [history-client-after.json](history-client-after.json) use a synthetic retained
  native session with an earlier literal Bash prefix and no system directory
  hint. Claude removes the newly generated redundant prefix on replay. The
  earlier implementation rejects that continuation; the fix completes both
  SDK calls at max effort and closes both upstream iterators.
- [retained-history-validation.json](retained-history-validation.json) checks
  an isolated real-client resume of a read-only snapshot containing 277
  reasoning envelopes. Before the history-hint fix, the final portable token
  cannot authenticate a candidate; afterward all 11 portable tokens verify,
  including the exact restored original Bash input. This diagnostic omits one
  unrelated assistant metadata field before canonical adaptation and performs
  no upstream generation; it establishes cryptographic replay compatibility,
  not acceptance of that metadata field. The user subsequently confirmed both
  original live sessions recovered after the candidate cutover.

The native fixture is executable:

```sh
bun scripts/probe-claude-thinking-display.ts \
  --claude-bin /path/to/claude \
  --before-launcher /path/to/launcher-implementation \
  --cases replay-cwd-change,replay-history-cwd-change,replay-edit-default \
  --out /private/client-replay.json
```

`__tests__/claude-tool-input-replay.test.ts` reproduces JSON and SSE with signed
history and parallel Edit calls, verifies original SDK inputs, and rejects
changed tenant, directory scope, tool IDs, actual arguments, missing provenance,
missing context and unauthenticatable directory hints. Candidate count and work
are bounded, including oversized IDs and escaped directory prefixes.
The long-history regression retains 266 direct signatures plus 11 portable
tokens and stale system directory hints, reproducing the final HTTP 400 in
JSON and SSE before the fix. Recent literal historical Bash prefixes take
priority within the four-directory candidate limit; they never grant trust.
