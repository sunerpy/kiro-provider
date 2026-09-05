# Audit and validation records

Index of the probe, validation, and review documents that gate kiro-provider
releases. Files are listed chronologically and are never rewritten after the
fact, so where records overlap the newer one supersedes the older conclusion.

| Document | Summary |
| --- | --- |
| [kiro-protocol-projection-probe-2026-08-26.md](kiro-protocol-projection-probe-2026-08-26.md) | Live Kiro probes of instruction projection, reasoning, output-token limits, and same-role messages; the instruction-projection part is superseded by the 2026-08-27 re-probe. |
| [kiro-provider-v0.5.0-rc.1-validation-2026-08-26.md](kiro-provider-v0.5.0-rc.1-validation-2026-08-26.md) | RC.1 acceptance: protocol-fidelity fixes, native-capability probes, automation gates, and real-client runs against the compiled service. |
| [kiro-protocol-projection-reprobe-2026-08-27.md](kiro-protocol-projection-reprobe-2026-08-27.md) | Re-probe with valid `additionalContext` requests: Kiro accepts the shape but does not preserve instruction content or priority. |
| [kiro-provider-v0.5.0-rc.2-validation-2026-08-27.md](kiro-provider-v0.5.0-rc.2-validation-2026-08-27.md) | RC.2 acceptance: canonical output refactor and Responses reasoning continuation compatibility, verified with the compiled binary. |
| [kiro-provider-v0.5.0-rc.3-opus5-validation-2026-08-27.md](kiro-provider-v0.5.0-rc.3-opus5-validation-2026-08-27.md) | RC.3 acceptance: Claude Opus 5 catalog, effort and output limits, all three protocol entry points, an OpenCode tool loop, and the Codex / Claude Code field-level blockers. |
| [kiro-provider-runtime-model-and-session-validation-2026-08-28.md](kiro-provider-runtime-model-and-session-validation-2026-08-28.md) | Runtime endpoint, live model catalog, and session-isolation acceptance against observed Kiro CLI/SDK behavior. |
| [kiro-provider-auth-refresh-and-quota-validation-2026-08-29.md](kiro-provider-auth-refresh-and-quota-validation-2026-08-29.md) | First-phase access-token refresh and quota-exclusion evidence on the shared-auth path; superseded by the RC.4 local-auth record. |
| [kiro-provider-stream-error-hardening-2026-08-29.md](kiro-provider-stream-error-hardening-2026-08-29.md) | Typed in-stream failure propagation for Responses, Chat Completions, and Anthropic Messages (branch `codex/typed-stream-errors`). |
| [kiro-provider-v0.5.0-rc.4-local-auth-maintenance-validation-2026-08-29.md](kiro-provider-v0.5.0-rc.4-local-auth-maintenance-validation-2026-08-29.md) | RC.4 acceptance: the provider-owned local authentication store becomes the production default, with autonomous token, usage, and quota maintenance. |
| [kiro-provider-v0.5.0-rc.5-account-management-validation-2026-08-29.md](kiro-provider-v0.5.0-rc.5-account-management-validation-2026-08-29.md) | RC.5 acceptance: `accounts list / refresh / relogin / remove` operations and live-usage validation of the local store. |
| [kiro-provider-v0.5.1-malformed-tool-arguments-validation-2026-08-30.md](kiro-provider-v0.5.1-malformed-tool-arguments-validation-2026-08-30.md) | v0.5.1 validation: syntactically malformed completed tool arguments are classified as retryable, separately from structural tool-call violations. |
| [kiro-provider-full-code-review-2026-09-02.zh.md](kiro-provider-full-code-review-2026-09-02.zh.md) | Full v0.5.1 code review (revision 2): prioritized findings, a phased remediation plan, and the test backlog. |
| [kiro-protocol-evidence-probe-2026-09-02.zh.md](kiro-protocol-evidence-probe-2026-09-02.zh.md) | Live evidence probes for review items B12/B20/B21/B25: usage reset fields, zero-parameter tool events, split same-role tool history, and thinking-signature replay validation. |
| [pending-probes.zh.md](pending-probes.zh.md) | Open probe backlog: whether replaying signature-only reasoning envelopes improves tool-loop continuity, and whether the `legacy-user-prefix` standalone-user-turn projection reproduces the plugin's turn-2 early-stop regression. Lists method and the decision each outcome drives. |
| [kiro-ab-probes-2026-09-03.zh.md](kiro-ab-probes-2026-09-03.zh.md) | 真机 A/B：签名-only 推理回放与独立指令轮均无显著差异，两项待探针关闭 |
| [kiro-provider-projection-optimization-2026-09-05.md](kiro-provider-projection-optimization-2026-09-05.md) | Request-boundary correction, payload-free request/attempt telemetry, and runnable native-context, effort, and Kiro CLI differential research tooling. |
| [kiro-provider-projection-optimization-2026-09-05.zh.md](kiro-provider-projection-optimization-2026-09-05.zh.md) | 请求边界修复、无正文 request/attempt 遥测，以及 native-context、effort 与 Kiro CLI 差分研究工具。 |

Older v0.4 evidence lives outside this directory in
[`../E2E_VALIDATION_2026-08-22.md`](../E2E_VALIDATION_2026-08-22.md) and
[`../KIRO_WEB_SEARCH_PROBE_2026-08-23.md`](../KIRO_WEB_SEARCH_PROBE_2026-08-23.md).
