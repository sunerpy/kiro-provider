# Documentation

The root [README](../README.md) is the install and five-minute quickstart. Use
this index for the complete operator, protocol, integration, and evidence set.
Simplified Chinese translations live in [`docs/readme/`](readme/); audit records
keep their original language because they are immutable, dated evidence.

## Start here

| Goal | English | 简体中文 |
| --- | --- | --- |
| Install and first request | [README](../README.md) | [README](readme/README.zh-CN.md) |
| Configure the gateway | [Configuration](CONFIGURATION.md) | [配置参考](readme/CONFIGURATION.zh-CN.md) |
| Run a long-lived service | [Background service](SERVICE.md) | [后台服务](readme/SERVICE.zh-CN.md) |
| Diagnose a failure | [Troubleshooting](TROUBLESHOOTING.md) | [排障手册](readme/TROUBLESHOOTING.zh-CN.md) |

## Client integrations

| Client | Guide | Scope |
| --- | --- | --- |
| Zuno | [English](ZUNO.md) · [简体中文](readme/ZUNO.zh-CN.md) | Native OpenAI Responses configuration, session metadata, transport routing, and isolated validation. |
| Codex CLI | [English](CODEX.md) · [简体中文](readme/CODEX.zh-CN.md) | Isolated profile, supported Responses shapes, tool/compaction smoke, and version boundary. |
| Claude Code | [English](CLAUDE_CODE.md) · [简体中文](readme/CLAUDE_CODE.zh-CN.md) | Anthropic Messages endpoint, isolated `kiroclaude` profile, model picker, and fallback boundary. |

## Protocol and operations

- [Architecture](ARCHITECTURE.md) — request flow, authentication authority,
  scheduling, transport lifecycle, and source map.
- [V3 protocol compatibility](PROTOCOL_COMPATIBILITY.md) ·
  [简体中文](readme/PROTOCOL_COMPATIBILITY.zh-CN.md) — public routes, native versus
  stateless selection, stored Responses, capability matrix, and data retention.
- [Responses usage and context accounting](RESPONSES_USAGE.md) ·
  [简体中文](readme/RESPONSES_USAGE.zh-CN.md) — measured and estimated usage, current
  context versus cumulative consumption, and compaction semantics.
- [Streaming error contract](STREAM_ERROR_CONTRACT.md) — accepted-stream
  boundary, typed failures, retry ownership, and observability.
- [Historical tool calls and current authorization](HISTORICAL_TOOLS.md) — why
  replay history never authorizes new tool calls.
- [Zuno stream-error handoff](readme/ZUNO_STREAM_ERROR_HANDOFF.zh-CN.md) — downstream
  handling details for the Provider streaming contract.

## Evidence and release history

- [Audit and validation index](audits/README.md) — dated probes, compatibility
  matrices, implementation reviews, and sanitized evidence manifests. These
  records explain what was tested at a point in time; the protocol documents
  above define the current contract.
- [Changelog](../changelog/README.md) — per-major release history maintained by
  Release Please.

## Documentation maintenance

- Keep the root README short enough to complete the first successful request;
  put exhaustive configuration, deployment, and client-specific procedures in
  the guides above.
- Update an English contract and its Chinese translation in the same change.
  The configuration parity test intentionally requires every schema field to
  appear exactly once in both configuration references.
- Add dated experiments and acceptance reports under `docs/audits/`; put raw,
  sanitized artifacts under `docs/audits/evidence/<record>/`. Never commit
  credentials, prompts, private reasoning, unsanitized wire captures, or local
  databases.
- Dated audit conclusions are append-only. When later evidence supersedes a
  result, add a newer record and describe the relationship in the audit index
  rather than rewriting history.
- Use relative links and run `make fmt-check` plus `make docs-links` before
  opening a pull request. Prose under `README.md` and `docs/` is intentionally
  hand-wrapped and excluded from automatic formatter rewrites.
