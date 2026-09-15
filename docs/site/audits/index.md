---
title: Validation evidence
description: Dated, sanitized probes and acceptance records for kiro-provider.
aside: false
---

# Validation evidence

These records capture what was observed at a specific date, client version, model,
account, or release. They are useful when a compatibility claim needs evidence,
but they do not replace the current [protocol contract](../../PROTOCOL_COMPATIBILITY.md),
[configuration reference](../../CONFIGURATION.md), or
[troubleshooting guide](../../TROUBLESHOOTING.md).

## Start with the current evidence

- [Responses replay and delivery](../../audits/responses-replay-delivery-2026-09-14.zh.md)
- [Responses usage and context](../../audits/responses-usage-2026-09-14.zh.md)
- [Stream delivery and recovery](../../audits/stream-delivery-recovery-2026-09-13.md)
- [V3 Responses validation](../../audits/kiro-provider-v3-openai-responses-validation-2026-09-05.md)
- [Projection optimization](../../audits/kiro-provider-projection-optimization-2026-09-05.md)

## Read older records carefully

A later probe may supersede an earlier result. Dated records remain append-only;
when behavior changes, a newer record states the relationship instead of rewriting
history. The source repository's full [audit index](https://github.com/sunerpy/kiro-provider/blob/main/docs/audits/README.md)
lists every retained probe and validation report.
