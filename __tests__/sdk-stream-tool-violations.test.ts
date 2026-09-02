import { describe, expect, test } from "bun:test";
import { createPipelineStreamResponse } from "../src/core/pipeline-stream.js";
import { streamErrorAuditFields } from "../src/core/stream-error.js";
import { transformSdkOutputStream } from "../src/kiro/transform/streaming/sdk-output-transformer.js";
import {
  type SdkStreamEvent,
  type SdkStreamResponse,
  ToolCallViolation,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { CanonicalOutputEvent } from "../src/protocol/output.js";
import { responsesSseAdapter } from "../src/server/responses/sse-adapter.js";

function malformedFragments(): SdkStreamEvent[] {
  return Array.from({ length: 18 }, (_, index) => ({
    toolUseEvent: {
      name: "secret_tool_name",
      toolUseId: "secret_tool_id",
      input: index === 0 ? '{"secret":"' : index === 17 ? '"' : "x",
      ...(index === 17 ? { stop: true } : {}),
    },
  }));
}

function activeSignals(): {
  readonly combined: AbortSignal;
  readonly deadline: AbortSignal;
  readonly client: AbortSignal;
} {
  const deadline = new AbortController();
  const client = new AbortController();
  return {
    combined: AbortSignal.any([deadline.signal, client.signal]),
    deadline: deadline.signal,
    client: client.signal,
  };
}

function malformedStreamResponse(): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
        yield { assistantResponseEvent: { content: "partial text" } };
        for (const event of malformedFragments()) yield event;
        yield {
          meteringEvent: {
            usage: 0.01,
            unit: "credit",
            unitPlural: "credits",
          },
        };
      },
    },
  };
}

describe("streamed tool-call violations", () => {
  test("keeps an 18-fragment malformed call atomic and emits safe diagnostics", async () => {
    const emitted: CanonicalOutputEvent[] = [];
    let failure: unknown;

    try {
      for await (const event of transformSdkOutputStream(
        malformedStreamResponse(),
        "claude-opus-5",
        "conversation-malformed-tool",
      )) {
        emitted.push(event);
      }
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ToolCallViolation);
    expect(failure).toMatchObject({
      code: "malformed_upstream_tool_arguments",
      violationKind: "malformed_arguments",
      fragmentCount: 18,
    });
    expect(emitted.some((event) => event.type === "text_delta")).toBe(true);
    expect(emitted.some((event) => event.type === "tool_call_delta")).toBe(false);
    expect(emitted.some((event) => event.type === "completed")).toBe(false);

    const fields = streamErrorAuditFields(failure);
    expect(fields).toMatchObject({
      error_type: "ToolCallViolation",
      error_code: "malformed_upstream_tool_arguments",
      error_disposition: "retryable",
      violation_kind: "malformed_arguments",
      tool_fragment_count: 18,
    });
    expect(fields.tool_id_hash).toBeString();
    expect(fields.tool_name_hash).toBeString();
    expect(fields.tool_arguments_hash).toBeString();
    expect(fields.tool_arguments_length).toBeGreaterThan(0);
    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain("secret_tool_id");
    expect(serialized).not.toContain("secret_tool_name");
    expect(serialized).not.toContain('{"secret":"');
  });

  test("surfaces partial text but no tool part through the Responses pipeline", async () => {
    let pipelineFinalized = 0;
    let adapterFinalized = 0;
    const pipeline = createPipelineStreamResponse(
      {
        sdkResponse: malformedStreamResponse(),
        model: "claude-opus-5",
        conversationId: "conversation-malformed-tool",
      },
      new AbortController().signal,
      1_000,
      () => {
        pipelineFinalized += 1;
      },
    );
    const response = responsesSseAdapter(pipeline, {
      model: "claude-opus-5",
      signals: activeSignals(),
      finalize: () => {
        adapterFinalized += 1;
      },
      configuration: {
        instructions: null,
        maxOutputTokens: null,
        metadata: {},
        reasoningEffort: null,
        toolChoice: "auto",
        tools: [],
      },
      includeEncryptedReasoning: false,
    });

    const text = await response.text();

    expect(text).toContain('"delta":"partial text"');
    expect(text).toContain('"code":"malformed_upstream_tool_arguments"');
    expect(text).toContain('"type":"response.failed"');
    expect(text).not.toContain('"type":"response.completed"');
    expect(text).not.toContain('"type":"function_call"');
    expect(text).not.toContain('"type":"custom_tool_call"');
    expect(pipelineFinalized).toBe(1);
    expect(adapterFinalized).toBe(1);
  });
});
