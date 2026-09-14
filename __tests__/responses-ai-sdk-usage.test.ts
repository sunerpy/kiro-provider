import { expect, test } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, jsonSchema, stepCountIs, streamText, tool } from "ai";
import {
  CANONICAL_OUTPUT_JSON_CONTENT_TYPE,
  CANONICAL_OUTPUT_STREAM_CONTENT_TYPE,
  type CanonicalOutputUsage,
} from "../src/protocol/output.js";
import { handleResponses } from "../src/server/routes/responses.js";
import { fidelityFixture } from "./responses-fidelity-helpers.js";

test.each([false, true])(
  "AI SDK distinguishes final context from cumulative tool-loop usage (stream=%s)",
  async (stream) => {
    const f = fidelityFixture();
    let requests = 0;
    let executions = 0;
    const dependencies = {
      ...f.dependencies,
      runPipeline: async (input: Parameters<NonNullable<typeof f.dependencies.runPipeline>>[0]) => {
        requests++;
        const first = requests === 1;
        const usage: CanonicalOutputUsage = first
          ? {
              inputTokens: 130,
              outputTokens: 50,
              totalTokens: 180,
              reported: {
                inputTokens: 130,
                outputTokens: 50,
                totalTokens: 180,
                cacheReadInputTokens: 100,
                cacheWriteInputTokens: 10,
                reasoningTokens: 30,
              },
            }
          : {
              inputTokens: 210,
              outputTokens: 20,
              totalTokens: 230,
              reported: {
                inputTokens: 210,
                outputTokens: 20,
                totalTokens: 230,
                cacheReadInputTokens: 150,
                cacheWriteInputTokens: 0,
                reasoningTokens: 10,
              },
            };
        const name = input.body.tools[0]?.wireName ?? "echo";
        if (!stream)
          return new Response(
            JSON.stringify({
              canonicalOutputVersion: 1,
              conversationId: "ai-sdk-usage",
              model: input.model,
              createdAt: 1,
              text: first ? "" : "hello",
              toolCalls: first ? [{ id: "call_echo", name, input: '{"q":"hello"}' }] : [],
              finishReason: first ? "tool_calls" : "stop",
              usage,
            }),
            { headers: { "Content-Type": CANONICAL_OUTPUT_JSON_CONTENT_TYPE } },
          );
        const events = [
          { type: "started", model: input.model, conversationId: "ai-sdk-usage", createdAt: 1 },
          first
            ? {
                type: "tool_call_delta",
                index: 0,
                id: "call_echo",
                name,
                arguments: '{"q":"hello"}',
              }
            : { type: "text_delta", text: "hello" },
          { type: "completed", finishReason: first ? "tool_calls" : "stop", usage },
        ];
        return new Response(
          `${events
            .map((event) => JSON.stringify({ canonicalOutputVersion: 1, ...event }))
            .join("\n")}\n`,
          {
            headers: { "Content-Type": CANONICAL_OUTPUT_STREAM_CONTENT_TYPE },
          },
        );
      },
    };
    const provider = createOpenAI({
      apiKey: "synthetic",
      baseURL: "http://ai-sdk.test/v1",
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const request =
            input instanceof Request ? new Request(input, init) : new Request(String(input), init);
          return handleResponses(request, f.config, dependencies);
        },
        { preconnect() {} },
      ),
    });
    const options = {
      model: provider.responses("gpt-5.6-sol"),
      prompt: "Call echo once, then answer with its result.",
      maxRetries: 0,
      stopWhen: stepCountIs(2),
      providerOptions: {
        openai: { store: false, reasoningEffort: "max", strictJsonSchema: false },
      },
      tools: {
        echo: tool({
          description: "Echo a synthetic string",
          inputSchema: jsonSchema<{ q: string }>({
            type: "object",
            properties: { q: { type: "string" } },
            required: ["q"],
            additionalProperties: false,
          }),
          execute: async ({ q }) => {
            executions++;
            return q;
          },
        }),
      },
    };
    try {
      const result = stream ? streamText(options) : await generateText(options);
      expect(await result.text).toBe("hello");
      const usage = (await result.finalStep).usage;
      const total = await result.usage;
      expect(await result.totalUsage).toEqual(total);
      expect(requests).toBe(2);
      expect(executions).toBe(1);
      expect(usage).toMatchObject({
        inputTokens: 210,
        outputTokens: 20,
        totalTokens: 230,
        inputTokenDetails: { noCacheTokens: 60, cacheReadTokens: 150, cacheWriteTokens: 0 },
        outputTokenDetails: { textTokens: 10, reasoningTokens: 10 },
      });
      expect(total).toMatchObject({
        inputTokens: 340,
        outputTokens: 70,
        totalTokens: 410,
        inputTokenDetails: { noCacheTokens: 80, cacheReadTokens: 250, cacheWriteTokens: 10 },
        outputTokenDetails: { textTokens: 30, reasoningTokens: 40 },
      });
    } finally {
      f.database.close();
    }
  },
);
