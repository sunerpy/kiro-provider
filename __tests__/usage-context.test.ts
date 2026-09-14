import { expect, test } from "bun:test";
import {
  resolveUsage,
  type UsageState,
  updateUsageState,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import {
  estimateSdkInputTokens,
  estimateTextTokens,
} from "../src/kiro/transform/usage-estimator.js";
import { normalizeReportedUsage } from "../src/protocol/usage.js";
import { responseUsage } from "../src/server/responses/state.js";

function request(text: string) {
  return {
    conversationState: {
      conversationId: "not-model-content",
      chatTriggerType: "MANUAL" as const,
      currentMessage: {
        userInputMessage: { modelId: "gpt-5.6-sol", origin: "AI_EDITOR" as const, content: text },
      },
    },
  };
}

test("input estimator counts repeated token padding consistently beyond 272k", () => {
  const overhead = estimateSdkInputTokens(request("prefix\n<padding></padding>"));
  for (const tokens of [1000, 300_000, 790_000]) {
    const estimated = estimateSdkInputTokens(
      request(`prefix\n<padding>${" a".repeat(tokens)}</padding>`),
    );
    expect(Math.abs(estimated - overhead - tokens)).toBeLessThanOrEqual(2);
  }
});

test("Unicode and code are tokenized, not divided by four characters", () => {
  const text = "这是一个中文工具结果。\nconst value = JSON.stringify({结果: '成功'});";
  expect(estimateTextTokens(text)).toBeGreaterThan(Math.ceil(text.length / 4));
  expect(estimateTextTokens(text)).toBe(estimateTextTokens(text));
});

test("profile and conversation identifiers do not affect context tokens", () => {
  const base = request("hello");
  expect(
    estimateSdkInputTokens({
      ...base,
      conversationState: { ...base.conversationState, conversationId: "private".repeat(50_000) },
    }),
  ).toBe(estimateSdkInputTokens(base));
});

test("pixel payload bytes are not treated as text tokens", () => {
  const image = (size: number) => {
    const data = new Uint8Array(size);
    new DataView(data.buffer).setUint32(16, 1024);
    new DataView(data.buffer).setUint32(20, 1024);
    const base = request("describe");
    return {
      conversationState: {
        ...base.conversationState,
        currentMessage: {
          userInputMessage: {
            ...base.conversationState.currentMessage.userInputMessage,
            images: [{ format: "png" as const, source: { bytes: data } }],
          },
        },
      },
    };
  };
  expect(estimateSdkInputTokens(image(24))).toBe(estimateSdkInputTokens(image(1_000_000)));
});

test("raw percentage basis is separate from the model's corrected prompt capacity", () => {
  // Real Sol probe: 260k padding succeeds at 96.17463684% of the old 272k basis.
  const result = resolveUsage({ contextUsagePercentage: 96.17463684082031 }, "OK", "gpt-5.6-sol", {
    inputTokenEstimate: 260_030,
    contextUsageWindow: 272_000,
  });
  expect(result.totalTokens).toBe(261_595);
  expect(result.totalTokens).toBeLessThan(784_800);
  expect(result.accounting?.context).toBe("percentage");
  expect(responseUsage(result)?.metadata).toMatchObject({ kiro: { source: "estimated" } });
});

test("a calibrated unsaturated observation outranks an opaque-content rendering estimate", () => {
  const result = resolveUsage({ contextUsagePercentage: 25 }, "OK", "gpt-5.6-sol", {
    inputTokenEstimate: 600_000,
    contextUsageWindow: 272_000,
  });
  expect(result.totalTokens).toBe(68_000);
  expect(result.accounting?.context).toBe("percentage");
});

test("100 percent is a lower bound, not a 272k cap or an 872k observation", () => {
  for (const tokens of [300_030, 790_030]) {
    const result = resolveUsage({ contextUsagePercentage: 100 }, "OK", "gpt-5.6-sol", {
      inputTokenEstimate: tokens,
      contextUsageWindow: 272_000,
    });
    expect(result.totalTokens).toBe(tokens + estimateTextTokens("OK"));
    expect(result.accounting).toMatchObject({ context: "tokenizer", percentageSaturated: true });
    expect(result.totalTokens >= 784_800).toBe(tokens > 784_800);
  }
});

test("a new compacted request replaces the active context baseline", () => {
  const before = resolveUsage({}, "OK", "gpt-5.6-sol", { inputTokenEstimate: 800_000 });
  const after = resolveUsage({}, "OK", "gpt-5.6-sol", { inputTokenEstimate: 12_000 });
  expect(before.totalTokens).toBeGreaterThan(784_800);
  expect(after.totalTokens).toBeLessThan(784_800);
  expect(after.totalTokens).toBe(12_001);
});

test("upstream snapshots replace counts and retain explicit zeros", () => {
  const state: UsageState = {};
  updateUsageState(state, {
    metadataEvent: {
      tokenUsage: {
        uncachedInputTokens: 20,
        cacheReadInputTokens: 100,
        cacheWriteInputTokens: 10,
        outputTokens: 50,
        reasoningTokens: 30,
        totalTokens: 180,
      },
    },
  });
  updateUsageState(state, {
    metadataEvent: {
      tokenUsage: {
        uncachedInputTokens: 0,
        cacheReadInputTokens: 80,
        cacheWriteInputTokens: 0,
        outputTokens: 20,
        reasoningTokens: 0,
        totalTokens: 100,
      },
    },
  });
  const result = resolveUsage(state, "ignored estimate", "gpt-5.6-sol", {
    inputTokenEstimate: 999_999,
  });
  expect(result.inputTokens).toBe(80);
  expect(result.outputTokens).toBe(20);
  expect(result.totalTokens).toBe(100);
  expect(responseUsage(result, "strict")).toMatchObject({
    input_tokens_details: { cached_tokens: 80, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  });
});

test("missing detail fields in a later snapshot do not inherit old cache counts", () => {
  const state: UsageState = {};
  updateUsageState(state, {
    metadataEvent: {
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
        cacheReadInputTokens: 80,
      },
    },
  });
  updateUsageState(state, {
    metadataEvent: {
      tokenUsage: {
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
      },
    },
  });
  const result = resolveUsage(state, "hello", "gpt-5.6-sol");
  expect(result.reported?.cacheReadInputTokens).toBeUndefined();
  expect(responseUsage(result)).not.toHaveProperty("input_tokens_details");
});

test("derives only mathematically determined zero/detail counts", () => {
  expect(normalizeReportedUsage({ inputTokens: 0, outputTokens: 0 })).toMatchObject({
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  });
  expect(
    normalizeReportedUsage({
      inputTokens: 100,
      uncachedInputTokens: 20,
      cacheReadInputTokens: 80,
      outputTokens: 5,
    }),
  ).toMatchObject({ cacheWriteInputTokens: 0 });
  expect(
    normalizeReportedUsage({ inputTokens: 100, outputTokens: 5 }).cacheReadInputTokens,
  ).toBeUndefined();
});

test("partial measured sub-buckets bound estimates without negative cache or text counts", () => {
  const usage = resolveUsage(
    { cacheReadInputTokens: 500, reasoningTokens: 100 },
    "OK",
    "gpt-5.6-sol",
    {
      inputTokenEstimate: 10,
    },
  );
  expect(usage.inputTokens).toBeGreaterThanOrEqual(500);
  expect(usage.outputTokens).toBeGreaterThanOrEqual(100);
  expect(() =>
    normalizeReportedUsage({
      totalTokens: 500,
      cacheReadInputTokens: 400,
      reasoningTokens: 200,
    }),
  ).toThrow();
});

test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid upstream token counts: %s",
  (inputTokens) => {
    expect(() => normalizeReportedUsage({ inputTokens })).toThrow();
  },
);

test("rejects contradictory totals and double-counted sub-buckets", () => {
  expect(() =>
    normalizeReportedUsage({ inputTokens: 10, outputTokens: 2, totalTokens: 13 }),
  ).toThrow();
  expect(() => normalizeReportedUsage({ inputTokens: 10, cacheReadInputTokens: 11 })).toThrow();
  expect(() => normalizeReportedUsage({ outputTokens: 5, reasoningTokens: 6 })).toThrow();
  expect(() =>
    normalizeReportedUsage({
      inputTokens: 100,
      uncachedInputTokens: 100,
      cacheReadInputTokens: 20,
      cacheWriteInputTokens: 10,
    }),
  ).toThrow();
});
