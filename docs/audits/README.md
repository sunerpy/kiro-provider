# Audit and validation records

This directory contains dated, append-only evidence for kiro-provider changes.
Use the [current documentation index](../README.md) for the supported contract;
use these records to answer what was tested, with which client/build, and where
a later result superseded an earlier one.

Sanitized machine-readable artifacts live under [`evidence/`](evidence/). Audit
records and artifacts must not contain credentials, raw prompts, private
reasoning, account databases, or unsanitized wire captures.

## V3 Responses and current clients

| Date | Record | Scope |
| --- | --- | --- |
| 2026-09-26 | [Claude Opus 5.5 catalog and request fields](opus-5-5-catalog-probe-2026-09-26.zh.md) | New `claude-opus-5.5` wire model: catalog schema, five-level effort, probed 1,024–128,000 `max_tokens` bounds, installed-client windows, and the unverified cross-account replay cell; [sanitized evidence](evidence/opus-5-5-catalog-probe-2026-09-26/). |
| 2026-09-14 | [Responses usage and context](responses-usage-2026-09-14.zh.md) | Usage normalization, current context versus cumulative consumption, Codex compaction, and Zuno context validation; [sanitized evidence](evidence/responses-usage-2026-09-14/validation.json). |
| 2026-09-14 | [Responses replay and interrupted delivery](responses-replay-delivery-2026-09-14.zh.md) | Parent/child reasoning boundaries, tool completion ordering, Codex 0.154.0 compaction and Ultra, and Zuno continuation. |
| 2026-09-13 | [Historical tool scope](historical-tool-scope-2026-09-13.zh.md) | Separates historical tool replay from current authorization, including stored namespace/custom aliases. |
| 2026-09-13 | [Stream delivery and recovery](stream-delivery-recovery-2026-09-13.md) · [简体中文](stream-delivery-recovery-2026-09-13.zh.md) | Response-header delivery, tool argument deltas, causal diagnostics, and SDK/Chat/Zuno acceptance. |
| 2026-09-10 | [Responses fidelity validation](kiro-provider-responses-fidelity-2026-09-10.zh.md) | Native/native-adapted/stateless gates, storage migration, strict mode, SDK matrix, and real Codex/Zuno validation. |
| 2026-09-10 | [Responses before/after report](kiro-provider-responses-before-after-2026-09-10.zh.md) | Concrete request/output comparisons and the accepted/failed capability cells behind the fidelity change. |
| 2026-09-06 | [GPT-5.6 Sol 1M context probe](kiro-gpt56-sol-1m-context-probe-2026-09-06.zh.md) | Probe-backed Sol prompt/output limits and the bounded catalog correction; Terra/Luna remain product-family inference. |
| 2026-09-05 | [V3 OpenAI Responses validation](kiro-provider-v3-openai-responses-validation-2026-09-05.md) · [简体中文](kiro-provider-v3-openai-responses-validation-2026-09-05.zh.md) | Initial native Responses, stateless fallback, local Response lifecycle, KiroRuntime endpoints, and Codex validation. |
| 2026-09-05 | [Kiro CLI/provider wire diff](kiro-cli-provider-v3-wire-diff-2026-09-05.zh.md) | Sanitized differences among Kiro CLI, KiroRuntime CreateResponse, and provider transport lanes. |
| 2026-09-05 | [Projection optimization](kiro-provider-projection-optimization-2026-09-05.md) · [简体中文](kiro-provider-projection-optimization-2026-09-05.zh.md) | Request-boundary correction, payload-free telemetry, and reproducible native-context/effort research tooling. |
| 2026-09-05 | [Production provider design v0.8 snapshot](production-provider-design-v0.8-2026-09-05.zh.md) | Historical pre-V3 design baseline. Keep for decisions and provenance, not as the current protocol contract. |

## Protocol and authentication foundations

| Date | Record | Scope |
| --- | --- | --- |
| 2026-09-03 | [Kiro A/B probes](kiro-ab-probes-2026-09-03.zh.md) | Signature-only replay and standalone instruction-turn experiments; neither showed a significant improvement. |
| 2026-09-03 | [Probe backlog and decision tables](pending-probes.zh.md) | Original P1/P2 methodology, now closed by the A/B record above. |
| 2026-09-02 | [Protocol evidence probe](kiro-protocol-evidence-probe-2026-09-02.zh.md) | Usage reset fields, zero-parameter tool events, same-role tool history, and thinking-signature replay. |
| 2026-09-02 | [Full code review](kiro-provider-full-code-review-2026-09-02.zh.md) | Prioritized v0.5.1 findings, remediation phases, and test backlog. Later implementation records supersede resolved conclusions. |
| 2026-08-30 | [v0.5.1 malformed tool arguments](kiro-provider-v0.5.1-malformed-tool-arguments-validation-2026-08-30.md) | Retryable malformed completed arguments versus structural tool-call violations. |
| 2026-08-29 | [RC.5 account management](kiro-provider-v0.5.0-rc.5-account-management-validation-2026-08-29.md) | Provider-owned account list, refresh, relogin, remove, and live usage operations. |
| 2026-08-29 | [RC.4 local authentication](kiro-provider-v0.5.0-rc.4-local-auth-maintenance-validation-2026-08-29.md) | Provider-owned authentication store and autonomous token/usage/quota maintenance. |
| 2026-08-29 | [Authentication refresh and quota](kiro-provider-auth-refresh-and-quota-validation-2026-08-29.md) | Early shared-auth evidence, superseded by the RC.4 provider-owned local-auth record. |
| 2026-08-29 | [Stream error hardening](kiro-provider-stream-error-hardening-2026-08-29.md) | Initial typed in-stream failures across Responses, Chat Completions, and Anthropic Messages. |
| 2026-08-28 | [Runtime model and session validation](kiro-provider-runtime-model-and-session-validation-2026-08-28.md) | Runtime endpoint, live model catalog, and session-isolation observations. |
| 2026-08-27 | [RC.3 Opus 5 validation](kiro-provider-v0.5.0-rc.3-opus5-validation-2026-08-27.md) | Opus catalog/effort/limits and then-current client blockers. |
| 2026-08-27 | [RC.2 validation](kiro-provider-v0.5.0-rc.2-validation-2026-08-27.md) | Canonical output refactor and reasoning continuation compatibility. |
| 2026-08-27 | [Instruction projection re-probe](kiro-protocol-projection-reprobe-2026-08-27.md) | Valid `additionalContext` was accepted but did not preserve instruction content or priority. |
| 2026-08-26 | [RC.1 validation](kiro-provider-v0.5.0-rc.1-validation-2026-08-26.md) | Protocol-fidelity fixes, native capability probes, automation gates, and compiled-service client runs. |
| 2026-08-26 | [Initial projection probe](kiro-protocol-projection-probe-2026-08-26.md) | Early instruction, reasoning, output-limit, and same-role tests; instruction conclusions are superseded by the 2026-08-27 re-probe. |
| 2026-08-23 | [Kiro Web Search probe](kiro-web-search-probe-2026-08-23.zh.md) | Controlled evidence for rejecting unsupported upstream Web Search instead of fabricating tool events. |
| 2026-08-22 | [Three-client E2E validation](kiro-provider-e2e-validation-2026-08-22.zh.md) | Historical OpenCode, Codex, Claude Code, legacy Chat, and shared-auth baseline before the current provider-owned/V3 architecture. |

## Adding a record

1. Name the Markdown file with a topic and ISO date.
2. State the exact source revision, client/build versions, isolation boundary,
   test result, and known limitations.
3. Put sanitized JSON or manifests in `evidence/<record>/` and link them from the
   report. Keep machine-generated artifacts separate from prose.
4. Add one row to this index. If the result supersedes an older conclusion,
   say so in both rows; do not rewrite the older record.
