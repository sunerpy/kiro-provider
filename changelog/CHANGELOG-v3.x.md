# Changelog

## 3.0.0 (2026-09-05)

### Features

- Add the native KiroRuntime OpenAI Responses transport.
- Add stateless fallback for max effort, `store:false`, encrypted reasoning,
  custom grammar, namespace tools, and Codex collaboration.
- Add tenant-isolated response retrieval, deletion, input-items pagination,
  and `previous_response_id` continuation.
- Add payload-free request/attempt telemetry and sanitized Kiro CLI
  differential probes.

### Breaking changes

- Change the default `protocol_projection_mode` to `v3-auto`.
- Treat unsupported hosted OpenAI capabilities as explicit typed errors.
- Recognize `/v1/responses/compact` and `/v1/responses/input_tokens` as
  unsupported HTTP 501 operations instead of generic routes.
