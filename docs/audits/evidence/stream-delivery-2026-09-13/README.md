# Sanitized stream-delivery evidence

These files contain synthetic test inputs only. Real request IDs are replaced by
stable probe identifiers. Original private artifacts remain local; each exported
run includes its source SHA-256.

| File | Contents |
| --- | --- |
| [responses.json](responses.json) | Five-model function/replay matrix, namespace, custom, cancellation, and actual native permission denials |
| [replay-and-effort.json](replay-and-effort.json) | Requested/dispatched effort and required account-binding checks; no real account IDs |
| [latencies.json](latencies.json) | Three-sample medians for Responses function-call delivery |
| [chat-before-rpc.json](chat-before-rpc.json) | Four real pre-fix RPC decoder failures |
| [chat-after-rpc.json](chat-after-rpc.json) | Corresponding successful controls and unchanged GPT output-cap rejection |
| [chat-primary.json](chat-primary.json) | Sol/Opus Chat tool loops, three repetitions each |
| [chat-additional.json](chat-additional.json) | Sonnet/Terra/Luna Chat tool loops, one repetition each |
| [zuno.json](zuno.json) | Six isolated Zuno single turns, wire event counts, one-request guard and zero tool execution |

The SDK probe is `scripts/probe-stream-delivery.ts`. It uses OpenAI SDK 7.13.0
with automatic retries disabled. It never executes tools. Explicit second turns
use a fixed synthetic result; they are not autonomous recovery or agent loops.
Native CreateResponse 403 cases must not be counted as successful native generation.
