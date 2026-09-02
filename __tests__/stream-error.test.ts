import { describe, expect, test } from "bun:test";
import {
  normalizeStreamFailure,
  streamErrorAuditFields,
  streamFailure,
} from "../src/core/stream-error.js";
import { MissingSdkOutputStreamError } from "../src/kiro/transform/streaming/sdk-output-transformer.js";
import {
  SdkStreamProtocolError,
  SemanticStreamTruncationError,
  ToolCallViolation,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import { anthropicSseAdapter } from "../src/server/anthropic/response-adapter.js";
import { canonicalOutputToChatSse } from "../src/server/chat-output.js";
import { responsesSseAdapter } from "../src/server/responses/sse-adapter.js";

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

function failingResponse(error: unknown): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(error);
      },
    }),
  );
}

function malformedToolViolation(): ToolCallViolation {
  return new ToolCallViolation(
    "private malformed arguments detail",
    "malformed_upstream_tool_arguments",
    "malformed_arguments",
    {
      toolUseId: "secret-tool-id",
      toolName: "secret-tool-name",
      argumentsText: '{"secret":"unterminated"',
      fragmentCount: 18,
    },
  );
}

describe("stream error contract", () => {
  test("preserves typed transient and fatal provider codes", () => {
    expect(normalizeStreamFailure(new SemanticStreamTruncationError())).toEqual({
      code: "upstream_stream_incomplete",
      disposition: "retryable",
      message: "Upstream stream ended before completion",
    });
    expect(
      normalizeStreamFailure(
        new SdkStreamProtocolError("private protocol detail", "invalid_upstream_tool_call"),
      ),
    ).toEqual({
      code: "invalid_upstream_tool_call",
      disposition: "fatal",
      message: "Upstream returned an invalid tool call",
    });
    expect(normalizeStreamFailure(new MissingSdkOutputStreamError())).toEqual({
      code: "missing_upstream_stream",
      disposition: "fatal",
      message: "Upstream response did not include a stream",
    });
    expect(normalizeStreamFailure(malformedToolViolation())).toEqual({
      code: "malformed_upstream_tool_arguments",
      disposition: "retryable",
      message: "Upstream returned malformed tool arguments",
    });
  });

  test("maps unknown SDK reader failures to a bounded retryable code", () => {
    expect(normalizeStreamFailure(new TypeError("decoder rejected a frame"))).toEqual({
      code: "upstream_stream_error",
      disposition: "retryable",
      message: "Upstream stream error",
    });
  });

  test("recovers a known code from one wrapped cause", () => {
    const cause = Object.assign(new Error("socket stalled"), {
      code: "upstream_stream_idle_timeout",
    });
    const wrapper = new TypeError("SDK wrapper", { cause });

    expect(normalizeStreamFailure(wrapper)).toEqual(streamFailure("upstream_stream_idle_timeout"));
  });

  test("logs stable diagnostics without logging raw exception prose", () => {
    const cause = Object.assign(new Error("Bearer secret-token"), {
      code: "ECONNRESET",
    });
    const wrapper = new TypeError("decoder included private payload", {
      cause,
    });
    const fields = streamErrorAuditFields(wrapper);

    expect(fields).toMatchObject({
      error_type: "TypeError",
      error_code: "upstream_stream_error",
      error_disposition: "retryable",
      error_cause_type: "Error",
      error_cause_code: "ECONNRESET",
    });
    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain("private payload");
    expect(serialized).not.toContain("secret-token");
  });

  test("maps retryable failures to Anthropic overloaded_error", async () => {
    const error = Object.assign(new Error("typed timeout"), {
      code: "upstream_stream_idle_timeout",
    });
    let finalized = 0;
    const response = anthropicSseAdapter(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(error);
          },
        }),
      ),
      {
        model: "claude-opus-5",
        inputTokens: 1,
        signals: activeSignals(),
        finalize: () => {
          finalized += 1;
        },
      },
    );

    const text = await response.text();
    expect(text).toContain('"type":"overloaded_error"');
    expect(text).toContain("Upstream stream idle timeout");
    expect(finalized).toBe(1);
  });

  test("maps malformed tool arguments as retryable across all streaming surfaces", async () => {
    const responsesText = await responsesSseAdapter(failingResponse(malformedToolViolation()), {
      model: "claude-opus-5",
      signals: activeSignals(),
      finalize: () => undefined,
      configuration: {
        instructions: null,
        maxOutputTokens: null,
        metadata: {},
        reasoningEffort: null,
        toolChoice: "auto",
        tools: [],
      },
      includeEncryptedReasoning: false,
    }).text();
    expect(responsesText).toContain('"code":"malformed_upstream_tool_arguments"');
    expect(responsesText).not.toContain('"type":"function_call"');

    const chatText = await canonicalOutputToChatSse(
      failingResponse(malformedToolViolation()),
      activeSignals(),
      () => undefined,
      { expectedModel: "claude-opus-5" },
    ).text();
    expect(chatText).toContain('"type":"upstream_error"');
    expect(chatText).toContain('"code":"malformed_upstream_tool_arguments"');
    expect(chatText).not.toContain('"tool_calls"');

    const anthropicText = await anthropicSseAdapter(failingResponse(malformedToolViolation()), {
      model: "claude-opus-5",
      inputTokens: 1,
      signals: activeSignals(),
      finalize: () => undefined,
    }).text();
    expect(anthropicText).toContain('"type":"overloaded_error"');
    expect(anthropicText).toContain("Upstream returned malformed tool arguments");
    expect(anthropicText).not.toContain('"type":"tool_use"');
  });

  test("keeps structural tool-call violations fatal across all streaming surfaces", async () => {
    const violation = (): ToolCallViolation =>
      new ToolCallViolation(
        "private structural detail",
        "invalid_upstream_tool_call",
        "name_changed",
        {
          toolUseId: "tool-id",
          toolName: "tool-name",
          argumentsText: "{}",
          fragmentCount: 2,
        },
      );

    const responsesText = await responsesSseAdapter(failingResponse(violation()), {
      model: "claude-opus-5",
      signals: activeSignals(),
      finalize: () => undefined,
      configuration: {
        instructions: null,
        maxOutputTokens: null,
        metadata: {},
        reasoningEffort: null,
        toolChoice: "auto",
        tools: [],
      },
      includeEncryptedReasoning: false,
    }).text();
    expect(responsesText).toContain('"code":"invalid_upstream_tool_call"');

    const chatText = await canonicalOutputToChatSse(
      failingResponse(violation()),
      activeSignals(),
      () => undefined,
      { expectedModel: "claude-opus-5" },
    ).text();
    expect(chatText).toContain('"type":"upstream_protocol_error"');
    expect(chatText).toContain('"code":"invalid_upstream_tool_call"');

    const anthropicText = await anthropicSseAdapter(failingResponse(violation()), {
      model: "claude-opus-5",
      inputTokens: 1,
      signals: activeSignals(),
      finalize: () => undefined,
    }).text();
    expect(anthropicText).toContain('"type":"api_error"');
    expect(anthropicText).toContain("Upstream returned an invalid tool call");
  });
});
