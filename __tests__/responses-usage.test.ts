import { expect, test } from "bun:test";
import Ajv from "ajv";
import OpenAI from "openai";
import { transformSdkOutputStream } from "../src/kiro/transform/streaming/sdk-output-transformer.js";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import {
  CANONICAL_OUTPUT_JSON_CONTENT_TYPE,
  CANONICAL_OUTPUT_STREAM_CONTENT_TYPE,
} from "../src/protocol/output.js";
import { normalizeNativeUsage, responseUsage } from "../src/server/responses/state.js";
import { handleResponses, handleStoredResponse } from "../src/server/routes/responses.js";
import usageSchema from "./fixtures/openai-response-usage.schema.json";
import { fidelityFixture } from "./responses-fidelity-helpers.js";

const validateUsage = new Ajv().compile(usageSchema);
// Codex 0.154.0 codex-api/src/sse/responses.rs: optional objects, required inner fields.
const validateCodexUsage = new Ajv().compile({
  type: "object",
  required: ["input_tokens", "output_tokens", "total_tokens"],
  properties: {
    input_tokens: { type: "integer" },
    output_tokens: { type: "integer" },
    total_tokens: { type: "integer" },
    input_tokens_details: {
      type: "object",
      required: ["cached_tokens"],
      properties: { cached_tokens: { type: "integer" }, cache_write_tokens: { type: "integer" } },
    },
    output_tokens_details: {
      type: "object",
      required: ["reasoning_tokens"],
      properties: { reasoning_tokens: { type: "integer" } },
    },
  },
});
const measured = {
  uncachedInputTokens: 20,
  cacheReadInputTokens: 100,
  cacheWriteInputTokens: 10,
  outputTokens: 50,
  reasoningTokens: 30,
  totalTokens: 180,
};

async function canonicalEvents(events: readonly SdkStreamEvent[]) {
  return Array.fromAsync(
    transformSdkOutputStream(
      {
        generateAssistantResponseResponse: (async function* () {
          yield* events;
        })(),
      },
      "gpt-5.6-sol",
      "usage-test",
    ),
  );
}

type RunPipeline = NonNullable<ReturnType<typeof fidelityFixture>["dependencies"]["runPipeline"]>;

function sdk(f: ReturnType<typeof fidelityFixture>, runPipeline?: RunPipeline) {
  const dependencies = runPipeline ? { ...f.dependencies, runPipeline } : f.dependencies;
  return new OpenAI({
    apiKey: "synthetic",
    baseURL: "http://usage.test/v1",
    maxRetries: 0,
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      if (request.method === "POST") return handleResponses(request, f.config, dependencies);
      return handleStoredResponse(
        request,
        dependencies,
        new URL(request.url).pathname.split("/")[3] ?? "",
        "retrieve",
      );
    },
  });
}

test.each([false, true])(
  "standard usage includes cache read/write and reasoning exactly once (stream=%s)",
  async (stream) => {
    const events = await canonicalEvents([
      { assistantResponseEvent: { content: "OK" } },
      { metadataEvent: { tokenUsage: measured } },
    ]);
    const completed = events.find((event) => event.type === "completed");
    if (!completed || completed.type !== "completed") throw new Error("Missing completion");
    const f = fidelityFixture();
    const runPipeline: RunPipeline = async () =>
      stream
        ? new Response(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
            headers: { "Content-Type": CANONICAL_OUTPUT_STREAM_CONTENT_TYPE },
          })
        : new Response(
            JSON.stringify({
              canonicalOutputVersion: 1,
              conversationId: "usage-test",
              model: "gpt-5.6-sol",
              createdAt: 1,
              text: "OK",
              toolCalls: [],
              finishReason: "stop",
              usage: completed.usage,
            }),
            { headers: { "Content-Type": CANONICAL_OUTPUT_JSON_CONTENT_TYPE } },
          );
    try {
      const client = sdk(f, runPipeline);
      const body = {
        model: "gpt-5.6-sol",
        input: "Hi",
        reasoning: { effort: "max" as const },
        store: true,
      };
      const response = stream
        ? await client.responses.stream(body).finalResponse()
        : await client.responses.create(body);
      expect(response.status).toBe("completed");
      expect(response.usage).toEqual({
        input_tokens: 130,
        input_tokens_details: { cached_tokens: 100, cache_write_tokens: 10 },
        output_tokens: 50,
        output_tokens_details: { reasoning_tokens: 30 },
        total_tokens: 180,
      });
      expect(validateUsage(response.usage)).toBe(true);
      expect((await client.responses.retrieve(response.id)).usage).toEqual(response.usage);
    } finally {
      f.database.close();
    }
  },
);

test.each([false, true])(
  "strict mode does not publish context percentage or credits as measured token usage (stream=%s)",
  async (stream) => {
    const events = await canonicalEvents([
      { assistantResponseEvent: { content: "OK" } },
      { contextUsageEvent: { contextUsagePercentage: 45 } },
      { meteringEvent: { usage: 0.25, unit: "credit" } },
    ]);
    const completed = events.find((event) => event.type === "completed");
    if (!completed || completed.type !== "completed") throw new Error("Missing completion");
    const f = fidelityFixture({ config: { responses_fidelity_mode: "strict" } });
    const runPipeline: RunPipeline = async () =>
      stream
        ? new Response(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
            headers: { "Content-Type": CANONICAL_OUTPUT_STREAM_CONTENT_TYPE },
          })
        : new Response(
            JSON.stringify({
              canonicalOutputVersion: 1,
              conversationId: "usage-test",
              model: "gpt-5.6-sol",
              createdAt: 1,
              text: "OK",
              toolCalls: [],
              finishReason: "stop",
              usage: completed.usage,
            }),
            { headers: { "Content-Type": CANONICAL_OUTPUT_JSON_CONTENT_TYPE } },
          );
    try {
      const client = sdk(f, runPipeline);
      const body = {
        model: "gpt-5.6-sol",
        input: "Hi",
        reasoning: { effort: "max" as const },
        store: true,
      };
      const response = stream
        ? await client.responses.stream(body).finalResponse()
        : await client.responses.create(body);
      expect(response.status).toBe("completed");
      expect(response.output_text).toBe("OK");
      expect(Object.hasOwn(response, "usage")).toBe(false);
      expect(Object.hasOwn(await client.responses.retrieve(response.id), "usage")).toBe(false);
    } finally {
      f.database.close();
    }
  },
);

test("tool-only output has a nonzero compatibility estimate without claiming measured usage", async () => {
  const events = await canonicalEvents([
    {
      toolUseEvent: {
        toolUseId: "call_usage",
        name: "read_marker",
        input: '{"key":"usage"}',
        stop: true,
      },
    },
    { meteringEvent: { usage: 0.017, unit: "credit" } },
  ]);
  const completed = events.find((event) => event.type === "completed");
  if (!completed || completed.type !== "completed") throw new Error("Missing completion");
  expect(completed.usage.outputTokens).toBeGreaterThan(0);
});

test("unknown detail objects remain decodable by Codex instead of provoking stream retries", () => {
  expect(
    validateCodexUsage({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: {},
      output_tokens_details: {},
    }),
  ).toBe(false);
  const estimates = responseUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  expect(validateCodexUsage(estimates)).toBe(true);
  expect(estimates).not.toHaveProperty("input_tokens_details");
  expect(estimates).not.toHaveProperty("output_tokens_details");
  const partial = normalizeNativeUsage({
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
    input_tokens_details: { cache_write_tokens: 10, image_tokens: 5 },
  });
  expect(validateCodexUsage(partial)).toBe(true);
  expect(partial).not.toHaveProperty("input_tokens_details");
  expect(partial?.metadata).toMatchObject({
    kiro: {
      reported: { cacheWriteInputTokens: 10 },
      upstream_input_tokens_details: { cache_write_tokens: 10, image_tokens: 5 },
    },
  });
});
