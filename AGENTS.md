# Repository instructions

This file is the canonical instruction source for coding agents in this repository. `CLAUDE.md` must remain a relative symbolic link to `AGENTS.md`; do not maintain a second copy.

## Project shape

- `kiro-provider` is a Bun/TypeScript ESM CLI and loopback HTTP gateway. The executable enters through `src/cli/bin.ts` and `src/cli/main.ts`.
- Public protocol routes live under `src/server/routes/`; shared ingress, authentication, lifecycle, and dispatch live under `src/server/`.
- OpenAI Responses has two deliberate lanes under `src/server/responses/`: native KiroRuntime when semantics are lossless, and the canonical stateless pipeline otherwise.
- Canonical request/output contracts live under `src/protocol/`; Kiro transport and transformations live under `src/kiro/`; account scheduling and retries live under `src/core/`.
- Provider-owned durable state is implemented in `src/storage/accounts-db.ts`; encrypted reasoning replay is under `src/reasoning/`.
- Tests are flat under `__tests__/` and normally mirror the affected module or behavior. Operator documentation is under `docs/`; `README.md` is the public quick-start surface.

## Code navigation

When `.codegraph/` exists, verify it before code research:

```bash
codegraph status . --json
```

If it is usable, start broad investigations with `codegraph explore "<question>" -p .`, locate known symbols with `codegraph search "<symbol>" -p .`, and read a symbol or indexed source file with `codegraph node "<target>" -p .`. Do not infer readiness from the directory alone, and do not initialize or rebuild the index unless requested or `status` explicitly requires it. If `.codegraph/` is absent, do not create it merely to complete an unrelated change.

## Non-negotiable behavior

- Preserve protocol fidelity. Never fabricate hidden prompts, flatten Responses or Messages through a Chat-shaped intermediary, silently drop unsupported semantics, or expose private upstream fields. Reject unsupported behavior with the existing typed error contract.
- Keep native and stateless Responses routing evidence-based and fail closed. Stored continuation must preserve tenant isolation, durable owner account/region/profile binding, opaque reasoning, and stable historical tool identities.
- Historical tool mappings are replay data, not authorization for the current turn. Current declarations alone authorize current output calls.
- Treat multiple reasoning envelopes for one historical assistant message as ambiguous. Exact duplicates may collapse; only multiple distinct empty direct Anthropic `thinking` blocks may recover by omitting every conflicting replay envelope while preserving visible assistant/tool history, and that loss must emit `x-kiro-reasoning-replay-mode: conflict-omitted` plus a sanitized count-only audit. Non-empty, provider-token, redacted, or mixed conflicts remain fail-closed.
- Keep retries and failover causally safe: do not replay an accepted stream, move a continuation to a guessed account, release an account lease before terminal cleanup, or let an upstream request survive cancellation/timeout.
- Treat credentials, refresh/access tokens, API keys, replay keys/tokens, prompts, tool names/arguments, session identifiers, and copied databases as secrets. Logs and committed evidence may contain only approved enums, counts, lengths, hashes, and sanitized fixtures.
- Preserve the provider-owned local authentication boundary. Do not reintroduce a live shared credential database or weaken single-instance, key-file, database, WAL/SHM, or tenant-bound protections.
- Keep direct login self-contained. `kiro-provider login --start-url` must discover and persist the Kiro profile through the provider's own authenticated control-plane client before usage or inference; never depend on a Kiro CLI executable, database, or runtime state. Missing, unavailable, or ambiguous profiles fail before credentials are written; multiple-profile identities use `--profile-arn`. The OIDC region and profile region are independent: persist the token issuer as `oidcRegion`, derive runtime `region` from the selected profile ARN, and query the evidenced commercial profile control planes in `us-east-1` and `eu-central-1` when no ARN is explicit. Re-login may fill a missing profile but must never rebind an existing account ID to a different profile, because persisted affinity, lineage, and reasoning replay ownership use that ID.
- Configuration precedence is CLI (supported `serve` flags), environment, JSON file, then schema default. New or changed fields must update `src/config/schema.ts`, loader/env handling, `config.example.json`, `docs/CONFIGURATION.md`, `docs/readme/CONFIGURATION.zh-CN.md`, and parity tests together.
- Do not edit generated `dist/` or `coverage/` outputs. Do not commit local databases, logs, raw wire captures, credentials, or unsanitized probe evidence.
- Live probes must use isolated configuration, ports, accounts/state copies, and test endpoints. Never mutate the installed binary, user service, production config, replay keyring, or production database without explicit authorization.

## Implementation and tests

Use Bun and the checked-in lockfile. Pin new dependencies to an exact version and update `bun.lock` with the canonical npm registry configured in `bunfig.toml`.

Dependabot is intentionally limited to GitHub Actions. Its npm updater changes
`package.json` without regenerating Bun's `bun.lock`, so those PRs cannot pass
the frozen-lockfile gate. Upgrade runtime or development dependencies in a
maintainer PR with `bun update <packages>`, review both `package.json` and
`bun.lock`, then run `make pre-ci`. Do not re-enable npm Dependabot until a real
PR proves it updates the Bun lockfile atomically.

Start with the smallest relevant regression test, then expand validation to the affected boundary. Typical commands are:

```bash
bun install --frozen-lockfile
bun test __tests__/<target>.test.ts
bun run typecheck
make lint
make docs-links
make scripts-syntax
make ci
make fmt-check
make security
make codex-smoke-security
make coverage-gate
make coverage-parity
bun run build
bun run build:binary
```

`make fmt-check` and Markdown/YAML/JSON formatting require the CI-pinned `oxfmt` version documented in `README.md`. Format only files owned by the change; do not rewrite unrelated files in a dirty worktree.

Apply these coverage expectations:

- Protocol or route changes: test streaming and non-streaming output, authentication, typed errors, cancellation/timeout, and relevant official-client shapes.
- Responses changes: cover native/stateless selection, stored continuation, tool replay/authorization, opaque reasoning, SSE ordering/terminal events, and usage semantics where applicable.
- Storage/auth changes: cover migrations, restart persistence, concurrent writers/refresh, tenant isolation, file permissions, and backward-compatible reads.
- Logging/diagnostic changes: assert that no model-visible or secret payload crosses the audit boundary.
- Documentation/config changes: run the config/docs parity tests and verify all linked English/Chinese references remain consistent.
- Model catalog or launcher changes: verify both client projections, not only the OpenAI `data` list. `kiroclaude` must display and switch the model with its expected effort settings; `kirocodex /model` consumes `models[].supported_reasoning_levels`, so it must also display and switch the model in a real Responses request. For `claude-fable-5.1`, `gpt-5.6-sol`, and `gpt-5.6-terra`, Codex Ultra requires `ultra`, `multi_agent_version: "v2"`, and `multi_agent_reasoning_effort: "max"` in the catalog. Ultra is a Codex orchestration preset that resolves inference effort to `max`; never add a Kiro `-ultra` model alias or send upstream `reasoning.effort: "ultra"`.

Coverage is a release policy, not an informational report:

- `make coverage-gate` enforces the repository-owned 93% line floor and
  `make coverage-parity` keeps local exclusions identical to `codecov.yml`.
- Branch protection must require `CI Success`, `codecov/project`, and
  `codecov/patch`. Both Codecov statuses use a 93% target with zero threshold;
  pending, missing, errored, or failed statuses block merge and release.
- The Codecov upload step must use `fail_ci_if_error: true`. A green local
  coverage job does not waive an uploader/configuration failure, and a green
  `CI Success` does not waive either external Codecov status.
- Generated Release Please PRs may use the repository's strict metadata-only
  fast lane, but they still run the coverage gate, parity check, upload a report,
  and satisfy both required Codecov statuses. Never merge a release PR while a
  required coverage status is absent or red.
- Do not lower the floor, add an exclusion, or add Codecov tolerance merely to
  make CI pass. Such policy changes require an explicit rationale, matching
  local/remote configuration, and regression coverage for the affected code.

Do not claim live client, platform, release, or packaged-binary support from unit tests alone. State which checks were run and which environment-specific checks remain.

## Git and release discipline

- Preserve unrelated user or agent work. Inspect `git status` before editing; do not reset, clean, overwrite, or reformat files outside the task.
- Use Conventional Commits and semantic PR titles. Normal project subjects use concise Chinese imperative wording with a lowercase scope, for example `fix(responses): 修复续接回放`; release automation uses `chore: release x.y.z`. Do not add AI attribution trailers.
- Keep feature/fix PRs focused. Release Please owns the package version, release manifest, changelog entry, tag, and draft release unless a specifically authorized recovery requires otherwise.
- A green workflow is not release proof. Bind acceptance to the exact PR/head SHA and required jobs, then to the exact tag/release assets and checksums; smoke-test downloaded public bytes before declaring publication complete.
- For standalone-binary releases and local cutovers, the verified GitHub Release is authoritative. After the exact release run's `Publish to npm` job succeeds, a temporary npm `E404` is registry-index propagation delay: do not block the GitHub Release verification or local binary cutover, and never rerun or republish merely to clear that `E404`. When npm verification is explicitly required, poll it separately with a bound and verify the eventual metadata, tarball integrity, contents, and provenance.
- Before merging any feature or generated release PR, verify all three required
  contexts (`CI Success`, `codecov/project`, and `codecov/patch`) on the exact
  current head. Do not publish from a commit whose Codecov gate failed or never
  reported.
- Never push directly to `main`, bypass required checks, publish npm/GitHub releases, or replace a locally installed service unless the user explicitly requested that action.
