import { describe, expect, test } from "bun:test";
import { transformSdkOutputStream } from "../src/kiro/transform/streaming/sdk-output-transformer.js";
import {
  appendReasoningCapture,
  createReasoningCaptureState,
  resolveReasoningCapture,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import {
  collectSdkEvents,
  completionOf,
  contentOf,
  makeSdkResponse,
  reasoningOf,
  toolCallOf,
  toolCallStarts,
} from "./sdk-stream-test-helpers.js";

describe("SDK stream protocol fidelity", () => {
  test("preserves thinking-like tags as ordinary assistant text", async () => {
    const exact = "intro <thinking>literal</thinking>\r\n{";
    const chunks = await collectSdkEvents([
      { assistantResponseEvent: { content: "intro <thin" } },
      { assistantResponseEvent: { content: "king>literal</thinking>\r\n{" } },
    ]);

    expect(contentOf(chunks)).toBe(exact);
    expect(reasoningOf(chunks)).toBe("");
  });

  test("preserves XML, DSML, and bracket pseudo-tool text without tool events", async () => {
    const exact =
      '<invoke name="read"><parameter name="path">/x</parameter></invoke>' +
      '<｜DSML｜function_calls name="grep" {"q":"x"}' +
      '[Called shell with args: {"cmd":"pwd"}]';
    const chunks = await collectSdkEvents([{ assistantResponseEvent: { content: exact } }]);

    expect(contentOf(chunks)).toBe(exact);
    expect(toolCallStarts(chunks)).toEqual([]);
  });

  test("uses only native reasoningContentEvent for reasoning deltas", async () => {
    const chunks = await collectSdkEvents([
      { reasoningContentEvent: { text: "native reasoning", signature: "sig" } },
      { assistantResponseEvent: { content: "answer" } },
    ]);

    expect(reasoningOf(chunks)).toBe("native reasoning");
    expect(contentOf(chunks)).toBe("answer");
  });

  test("accepts a trailing signature event without concatenating repeated signatures", () => {
    const state = createReasoningCaptureState();
    appendReasoningCapture(state, { text: "native reasoning" });
    appendReasoningCapture(state, { signature: "sig" });
    appendReasoningCapture(state, { signature: "sig" });

    expect(resolveReasoningCapture(state)).toEqual({
      text: "native reasoning",
      signature: "sig",
    });
  });

  test("does not publish incomplete or ambiguous reasoning replay material", () => {
    const signatureOnly = createReasoningCaptureState();
    appendReasoningCapture(signatureOnly, { signature: "sig" });
    expect(resolveReasoningCapture(signatureOnly)).toEqual({ text: "" });

    const conflicting = createReasoningCaptureState();
    appendReasoningCapture(conflicting, { text: "native reasoning", signature: "sig-a" });
    appendReasoningCapture(conflicting, { signature: "sig-b" });
    expect(resolveReasoningCapture(conflicting)).toEqual({ text: "native reasoning" });

    const mixed = createReasoningCaptureState();
    appendReasoningCapture(mixed, { text: "native reasoning", signature: "sig" });
    appendReasoningCapture(mixed, { redactedContent: Uint8Array.from([1, 2, 3]) });
    expect(resolveReasoningCapture(mixed)).toEqual({ text: "native reasoning" });
  });

  test("emits only a complete reasoning signature before assistant text", async () => {
    const chunks = [];
    for await (const chunk of transformSdkOutputStream(
      makeSdkResponse([
        { reasoningContentEvent: { text: "native reasoning" } },
        { reasoningContentEvent: { signature: "sig" } },
        { assistantResponseEvent: { content: "answer" } },
      ]),
      "claude-sonnet-5",
      "conversation",
      undefined,
      { emitAnthropicReasoningMetadata: true },
    )) {
      chunks.push(chunk);
    }
    const signatureIndex = chunks.findIndex(
      (event) => event.type === "reasoning_signature" && event.signature === "sig",
    );
    const textIndex = chunks.findIndex(
      (event) => event.type === "text_delta" && event.text === "answer",
    );
    expect(signatureIndex).toBeGreaterThanOrEqual(0);
    expect(signatureIndex).toBeLessThan(textIndex);

    const signatureOnly = [];
    for await (const chunk of transformSdkOutputStream(
      makeSdkResponse([
        { reasoningContentEvent: { signature: "sig-only" } },
        { assistantResponseEvent: { content: "answer" } },
      ]),
      "claude-sonnet-5",
      "conversation",
      undefined,
      { emitAnthropicReasoningMetadata: true },
    )) {
      signatureOnly.push(chunk);
    }
    expect(signatureOnly.some((event) => event.type === "reasoning_signature")).toBe(false);
  });

  test("classifies contradictory reasoning metadata as a protocol error", async () => {
    const drain = async (): Promise<void> => {
      for await (const _event of transformSdkOutputStream(
        makeSdkResponse([
          { reasoningContentEvent: { text: "reason", signature: "sig-a" } },
          { reasoningContentEvent: { signature: "sig-b" } },
        ]),
        "claude-opus-5",
        "conversation",
        undefined,
        { emitAnthropicReasoningMetadata: true },
      )) {
        // Drain until the structural protocol error is raised.
      }
    };

    await expect(drain()).rejects.toMatchObject({
      name: "SdkStreamProtocolError",
      code: "invalid_upstream_reasoning",
    });
  });
});

describe("SDK stream structural tool events", () => {
  test("aggregates fragmented native tool input by toolUseId", async () => {
    const chunks = await collectSdkEvents([
      { toolUseEvent: { name: "write", toolUseId: "tid", input: '{"path":"a",' } },
      { toolUseEvent: { name: "write", toolUseId: "tid", input: '"content":"b"}' } },
      { toolUseEvent: { name: "write", toolUseId: "tid", input: "", stop: true } },
    ]);

    const calls = chunks.map(toolCallOf).filter((call) => call !== undefined);
    expect(toolCallStarts(chunks)).toHaveLength(1);
    expect(calls.map((call) => call.function?.arguments ?? "").join("")).toBe(
      '{"path":"a","content":"b"}',
    );
  });
});

describe("SDK stream usage and finalization", () => {
  test("uses direct metadata token counts when provided", async () => {
    const chunks = await collectSdkEvents([
      { assistantResponseEvent: { content: "answer" } },
      { metadataEvent: { tokenUsage: { inputTokens: 12, outputTokens: 3 } } },
    ]);

    expect(completionOf(chunks)?.usage).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
    });
  });

  test("treats token-usage metadata as terminal without waiting for transport EOF", async () => {
    let closed = false;
    const completions: string[] = [];
    const response = {
      generateAssistantResponseResponse: (async function* () {
        try {
          yield { assistantResponseEvent: { content: "answer" } };
          yield { metadataEvent: { tokenUsage: { inputTokens: 2, outputTokens: 1 } } };
          await new Promise<void>(() => undefined);
          yield { assistantResponseEvent: { content: "late content" } };
        } finally {
          closed = true;
        }
      })(),
    };
    const chunks = [];
    for await (const chunk of transformSdkOutputStream(
      response,
      "auto",
      "completion-metadata",
      undefined,
      {
        onCompletionWitness: (kind) => {
          completions.push(kind);
        },
      },
    )) {
      chunks.push(chunk);
    }

    await Bun.sleep(0);

    expect(contentOf(chunks)).toBe("answer");
    expect(completionOf(chunks)?.finishReason).toBe("stop");
    expect(completions).toEqual(["token-usage-metadata"]);
    expect(closed).toBe(true);
  });

  test("requires clean EOF after a valid metering completion witness", async () => {
    const completions: string[] = [];
    const response = {
      generateAssistantResponseResponse: (async function* () {
        yield { assistantResponseEvent: { content: "answer" } };
        yield { metadataEvent: {} };
        yield { contextUsageEvent: { contextUsagePercentage: 0.01 } };
        yield {
          meteringEvent: {
            usage: 0.03,
            unit: "credit",
            unitPlural: "credits",
          },
        };
      })(),
    };
    const chunks = [];
    for await (const chunk of transformSdkOutputStream(
      response,
      "auto",
      "completion-metering",
      undefined,
      {
        onCompletionWitness: (kind) => {
          completions.push(kind);
        },
      },
    )) {
      chunks.push(chunk);
    }

    expect(contentOf(chunks)).toBe("answer");
    expect(completionOf(chunks)?.finishReason).toBe("stop");
    expect(completions).toEqual(["metering-clean-eof"]);
  });

  test("does not treat context-only metadata as completion", async () => {
    const chunks = await collectSdkEvents([
      { assistantResponseEvent: { content: "before" } },
      { metadataEvent: { contextUsagePercentage: 10 } },
      { assistantResponseEvent: { content: " after" } },
    ]);

    expect(contentOf(chunks)).toBe("before after");
  });

  test("reports only raw SDK event discriminator names", async () => {
    const observed: string[][] = [];
    const response = makeSdkResponse([
      { assistantResponseEvent: { content: "answer" } },
      { metadataEvent: { tokenUsage: { inputTokens: 2, outputTokens: 1 } } },
    ]);

    for await (const _chunk of transformSdkOutputStream(
      response,
      "auto",
      "event-types",
      undefined,
      {
        onRawEvent: (eventTypes) => {
          observed.push([...eventTypes]);
        },
      },
    )) {
      // Drain the transformed stream.
    }

    expect(observed).toEqual([["assistantResponseEvent"], ["metadataEvent"]]);
  });

  test("sets finish reason from native tool events", async () => {
    const withTool = await collectSdkEvents([
      { toolUseEvent: { name: "x", toolUseId: "t", input: "{}", stop: true } },
    ]);
    const withoutTool = await collectSdkEvents([{ assistantResponseEvent: { content: "hi" } }]);

    expect(completionOf(withTool)?.finishReason).toBe("tool_calls");
    expect(completionOf(withoutTool)?.finishReason).toBe("stop");
  });

  test("rejects an SDK response without an event stream", async () => {
    const { transformSdkOutputStream } = await import(
      "../src/kiro/transform/streaming/sdk-output-transformer.js"
    );

    await expect(async () => {
      for await (const chunk of transformSdkOutputStream({}, "auto", "id")) {
        void chunk;
      }
    }).toThrow("SDK response has no event stream");
  });
});
