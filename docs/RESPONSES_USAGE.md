# Responses usage and context accounting

This contract covers JSON Create, streaming terminal responses, and Retrieve on
`/v1/responses`. It follows the OpenAI usage fields and is tested with the official
OpenAI SDK and `@ai-sdk/openai`.

## Token fields

- `input_tokens` includes uncached input, cache reads, and cache writes.
- `input_tokens_details.cached_tokens` and `cache_write_tokens` are subdivisions
  of input, not additional tokens to add to the total.
- `output_tokens` includes generated text, tool calls, and reasoning.
- `output_tokens_details.reasoning_tokens` is a subdivision of output.
- `total_tokens = input_tokens + output_tokens`.

Explicit zeros are preserved. Missing fields are not automatically converted to
zero. A missing bucket can be derived only when the other measured buckets
determine it exactly. Invalid or contradictory reported counts fail with
`invalid_upstream_usage`; generation is not retried to repair accounting.

## Measured values and compatibility estimates

Kiro does not always provide token usage. The tested GenerateAssistantResponse
transports return a context percentage and metered credits without input/output,
cache, or reasoning-token counts. These are distinct quantities.

The existing `responses_fidelity_mode` controls this boundary:

| Mode                   | Complete measured usage                   | Missing measurements                                                                                  |
| ---------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `compatible` (default) | Preserve measured totals and breakdowns   | Return usable estimates for context management, label their source, and omit unknown breakdown fields |
| `strict`               | Return the complete standard usage object | Omit `usage` rather than fabricate required counts                                                    |

OpenAI's response schema makes the `usage` property optional. A complete measured
object is validated against the pinned official `ResponseUsage` schema, including
cache-write tokens.

Compatibility metadata is an additive provider extension, not an OpenAI-defined
measurement field:

```json
{
  "usage": {
    "input_tokens": 301000,
    "output_tokens": 30,
    "total_tokens": 301030,
    "metadata": {
      "kiro": {
        "source": "estimated",
        "estimated_fields": ["input_tokens", "output_tokens", "total_tokens"],
        "unknown_fields": [
          "input_tokens_details.cached_tokens",
          "input_tokens_details.cache_write_tokens",
          "output_tokens_details.reasoning_tokens"
        ],
        "context": {
          "tokens": 301030,
          "source": "tokenizer",
          "percentage": 100,
          "percentage_window": 272000,
          "percentage_saturated": true
        }
      }
    }
  }
}
```

Partially measured values remain available in `metadata.kiro.reported`. When
metering is provided, `metadata.kiro.metering` contains its reported value and unit.
Credits are not converted to tokens or money. Estimates are not billing records.
`X-Kiro-Usage-Policy` identifies the stateless response policy.

Unknown detail objects are omitted, not emitted as `{}`: Codex requires
`cached_tokens` or `reasoning_tokens` whenever their parent detail object is
present. The source metadata is also mirrored in
`response.usage_metadata.metadata` for Codex's raw-response observations.

Some SDKs display zero for missing breakdowns. Inspect AI SDK 7's
`result.finalStep.usage.raw` (or each `result.steps[i].usage.raw`), the original
response, and `metadata.kiro.unknown_fields` before interpreting such zeros as
measured cache misses or an absence of reasoning.

## Current context is not cumulative consumption

Each response reports only that generation's usage. Clients may sum response
usage for accounting; that sum must not be used as the current context size.
After a successful compaction, the next request establishes a new context
baseline instead of adding the pre-compaction context again.

AI SDK 7 uses different names from earlier versions:

```ts
const result = await generateText(options);

const currentContext = result.finalStep.usage.totalTokens;
const cumulativeConsumption = result.usage.totalTokens;
// result.totalUsage is the deprecated alias of result.usage in AI SDK 7.
```

The cumulative object does not retain per-step raw metadata.
For `streamText`, await `result.finalStep` and `result.usage`. For the official
OpenAI SDK, `response.usage` belongs to that response. A client-side thread total
is a separate aggregation.

Codex uses the last response's `usage.total_tokens` plus subsequently appended
items for its current context. Stateless responses set `X-Reasoning-Included`
because their context accounting includes replayed reasoning; this prevents
Codex from estimating it a second time. Native responses preserve that upstream
header when present.

Clients relying on usage for automatic compaction should keep compatible mode
when Kiro does not provide complete measured usage. An absent strict-mode usage
is unknown, not zero or an instruction to reset the context.

## Percentage saturation and rendering

The public prompt capacity and Kiro's percentage denominator are separate.
For the tested Sol Generate transports:

- The management denominator remains 272,000.
- The public GPT-5.6 prompt budget remains 872,000.
- A 260K-padding request reports approximately 96.17%.
- Both 300K and 790K-padding requests report 100%, while retaining independent
  random markers at both ends.

Multiplying this old percentage by 872K inflates unsaturated context estimates
about 3.2 times. Multiplying a saturated percentage by 272K undercounts long
requests. The provider therefore keeps the raw per-account model denominator
separate, uses valid unsaturated observations, and treats 100% only as a lower
bound.

The fallback tokenizer counts the projected model content: instructions, retained
messages, tool declarations, call arguments, and results. Profile/conversation
identifiers are excluded. Pixel payloads are estimated as images, not tokenized
as base64 text. Opaque reasoning is estimated separately. Count caches retain
hashes and counts, not prompt text.

The fallback uses `o200k_base` BPE data through `js-tiktoken`. It remains an estimate
of Kiro's rendering, particularly for non-OpenAI models, images, hidden framing,
and opaque reasoning. Existing model headroom and compaction margins remain in
place; no exact hidden-token or billing guarantee is made.

## Storage and references

Create, terminal SSE, and Retrieve retain the same usage and provenance. Legacy
stored responses remain historical snapshots; existing client cumulative totals
are not rewritten or retroactively certified as accurate. No account or replay
key migration is required. Keep a matching database/binary backup for rollback.

- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Official usage schema, revision 4bb21ba](https://github.com/openai/openai-openapi/blob/4bb21ba8e9213c3d955b69dc3f76dd7537439828/openapi.json)
- [Prompt-cache accounting](https://developers.openai.com/api/docs/guides/prompt-caching#monitor-cache-performance)
- [Reasoning tokens](https://developers.openai.com/api/docs/guides/reasoning#how-reasoning-works)
- [AI SDK 7 usage types](https://github.com/vercel/ai/blob/main/packages/ai/src/types/usage.ts)

[中文说明](readme/RESPONSES_USAGE.zh-CN.md)
