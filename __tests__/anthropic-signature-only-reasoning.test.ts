import { describe, expect, test } from "bun:test";
import { collectSdkResponse } from "../src/kiro/transform/sdk-collector.js";
import {
  CANONICAL_OUTPUT_VERSION,
  type CanonicalCompletion,
  parseCanonicalCompletion,
  parseCanonicalOutputEvent,
} from "../src/protocol/output.js";
import { anthropicMessageResponse } from "../src/server/anthropic/response-adapter.js";
import { makeSdkResponse } from "./sdk-stream-test-helpers.js";

const MODEL = "claude-sonnet-5";

describe("Anthropic non-stream signature-only reasoning", () => {
  test("collects late GPT signature-only reasoning before buffered text", async () => {
    const completion = await collectSdkResponse(
      makeSdkResponse([
        { assistantResponseEvent: { content: "answer" } },
        { reasoningContentEvent: { signature: "late-native-signature" } },
      ]),
      "gpt-5.6-sol",
      "late-gpt-non-stream",
      undefined,
      {
        emitAnthropicReasoningMetadata: true,
        emitEncryptedReasoning: true,
        bufferLateGptReasoning: true,
        captureReasoning: () => "kr2_late-non-stream-replay",
      },
    );

    expect(completion).toMatchObject({
      text: "answer",
      reasoning: {
        text: "",
        signature: "late-native-signature",
        encryptedContent: "kr2_late-non-stream-replay",
      },
    });
    const response = anthropicMessageResponse(completion, "gpt-5.6-sol", {
      thinkingDisplay: "omitted",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      content: [
        { type: "thinking", thinking: "", signature: "kr2_late-non-stream-replay" },
        { type: "text", text: "answer" },
      ],
    });
  });

  test("preserves signed empty thinking for a parallel tool turn", async () => {
    const captures: Array<{ text: string; signature?: string }> = [];
    const completion = await collectSdkResponse(
      makeSdkResponse([
        { reasoningContentEvent: { signature: "native-signature" } },
        {
          toolUseEvent: {
            name: "first_task",
            toolUseId: "tool-a",
            input: '{"task":"a"}',
            stop: true,
          },
        },
        {
          toolUseEvent: {
            name: "second_task",
            toolUseId: "tool-b",
            input: '{"task":"b"}',
            stop: true,
          },
        },
      ]),
      MODEL,
      "parallel-subagent-turn",
      undefined,
      {
        emitAnthropicReasoningMetadata: true,
        emitEncryptedReasoning: true,
        captureReasoning: (capture) => {
          captures.push(capture);
          return "kr2_test-replay";
        },
      },
    );

    expect(captures).toEqual([{ text: "", signature: "native-signature" }]);
    expect(completion.reasoning).toEqual({
      text: "",
      signature: "native-signature",
      encryptedContent: "kr2_test-replay",
    });

    const parsed = parseCanonicalCompletion(JSON.parse(JSON.stringify(completion)));
    expect(parsed?.reasoning).toEqual(completion.reasoning);

    const response = anthropicMessageResponse(parsed as CanonicalCompletion, MODEL);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      content: [
        { type: "thinking", thinking: "", signature: "native-signature" },
        { type: "tool_use", id: "tool-a", name: "first_task", input: { task: "a" } },
        { type: "tool_use", id: "tool-b", name: "second_task", input: { task: "b" } },
      ],
      stop_reason: "tool_use",
    });
  });

  test("still rejects a signature without an explicit empty thinking field", async () => {
    const malformed: CanonicalCompletion = {
      canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
      conversationId: "malformed",
      model: MODEL,
      createdAt: 1_700_000_000,
      text: "",
      reasoning: { signature: "orphan-signature" },
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };

    const parsed = parseCanonicalCompletion(JSON.parse(JSON.stringify(malformed)));
    expect(parsed?.reasoning).toEqual({ signature: "orphan-signature" });

    const response = anthropicMessageResponse(parsed as CanonicalCompletion, MODEL);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { message: "Upstream returned incomplete signed reasoning metadata" },
    });
  });

  test("accepts an empty reasoning marker on the canonical stream boundary", () => {
    expect(
      parseCanonicalCompletion({
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        conversationId: "unsigned-empty",
        model: MODEL,
        createdAt: 1_700_000_000,
        text: "answer",
        reasoning: { text: "" },
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
    ).toBeUndefined();
    expect(
      parseCanonicalOutputEvent({
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "reasoning_delta",
        text: "",
      }),
    ).toEqual({
      canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
      type: "reasoning_delta",
      text: "",
    });
    expect(
      parseCanonicalOutputEvent({
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "reasoning_delta",
        text: 0,
      }),
    ).toBeUndefined();
    expect(
      parseCanonicalOutputEvent({
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "reasoning_delta",
        text: "",
        extra: true,
      }),
    ).toBeUndefined();
    expect(
      parseCanonicalOutputEvent({
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "text_delta",
        text: "",
      }),
    ).toBeUndefined();
  });

  test("keeps concurrent signature-only subagent turns isolated", async () => {
    const results = await Promise.all(
      Array.from({ length: 16 }, async (_, index) => {
        const signature = `native-signature-${index}`;
        const toolId = `tool-${index}`;
        const completion = await collectSdkResponse(
          makeSdkResponse([
            { reasoningContentEvent: { signature } },
            {
              toolUseEvent: {
                name: "subagent_task",
                toolUseId: toolId,
                input: JSON.stringify({ index }),
                stop: true,
              },
            },
          ]),
          MODEL,
          `parallel-subagent-${index}`,
          undefined,
          { emitAnthropicReasoningMetadata: true },
        );
        const parsed = parseCanonicalCompletion(JSON.parse(JSON.stringify(completion)));
        const response = anthropicMessageResponse(parsed as CanonicalCompletion, MODEL);
        return { index, signature, toolId, response };
      }),
    );

    for (const { index, signature, toolId, response } of results) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        content: [
          { type: "thinking", thinking: "", signature },
          {
            type: "tool_use",
            id: toolId,
            name: "subagent_task",
            input: { index },
          },
        ],
      });
    }
  });
});
