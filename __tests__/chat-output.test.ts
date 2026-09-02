import { describe, expect, test } from "bun:test";
import {
  CANONICAL_OUTPUT_VERSION,
  type CanonicalCompletion,
  type CanonicalOutputEvent,
} from "../src/protocol/output.js";
import {
  canonicalCompletionToChat,
  canonicalOutputToChatSse,
} from "../src/server/chat-output.js";

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

function canonicalStream(
  events: readonly CanonicalOutputEvent[],
  finalNewline = true,
): Response {
  const body = events.map((event) => JSON.stringify(event)).join("\n");
  return new Response(`${body}${finalNewline ? "\n" : ""}`);
}

function started(model = "claude-sonnet-5"): CanonicalOutputEvent {
  return {
    canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
    type: "started",
    conversationId: "conversation-1",
    model,
    createdAt: 1_700_000_000,
  };
}

function completed(
  finishReason: "stop" | "tool_calls",
): CanonicalOutputEvent {
  return {
    canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
    type: "completed",
    finishReason,
    usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
  };
}

function dataFrames(text: string): string[] {
  return text
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => frame.slice("data: ".length));
}

describe("canonical Chat output", () => {
  test("encodes non-streaming reasoning, tools, finish reason, and usage", async () => {
    const completion: CanonicalCompletion = {
      canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
      conversationId: "conversation-1",
      model: "claude-sonnet-5",
      createdAt: 1_700_000_000,
      text: "answer",
      reasoning: {
        text: "reason",
        signature: "signature",
        redactedContent: "redacted",
        encryptedContent: "kr1_token",
      },
      toolCalls: [{ id: "call-1", name: "lookup", input: "{\"q\":\"x\"}" }],
      finishReason: "tool_calls",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    };

    const payload = (await canonicalCompletionToChat(completion).json()) as {
      choices: Array<{
        message: Record<string, unknown>;
        finish_reason: string;
      }>;
      usage: Record<string, number>;
    };

    expect(payload.choices[0]?.message).toEqual({
      role: "assistant",
      content: "answer",
      reasoning_content: "reason",
      reasoning_signature: "signature",
      reasoning_redacted_content: "redacted",
      reasoning_encrypted_content: "kr1_token",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "lookup", arguments: "{\"q\":\"x\"}" },
        },
      ],
    });
    expect(payload.choices[0]?.finish_reason).toBe("tool_calls");
    expect(payload.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    });
  });

  test("returns null content for a tool-call-only completion like OpenAI", async () => {
    const toolOnly: CanonicalCompletion = {
      canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
      conversationId: "conversation-1",
      model: "claude-sonnet-5",
      createdAt: 1_700_000_000,
      text: "",
      toolCalls: [{ id: "call-1", name: "lookup", input: "{}" }],
      finishReason: "tool_calls",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    };
    const emptyText: CanonicalCompletion = { ...toolOnly, toolCalls: [], finishReason: "stop" };

    const toolPayload = (await canonicalCompletionToChat(toolOnly).json()) as {
      choices: Array<{ message: Record<string, unknown> }>;
    };
    const emptyPayload = (await canonicalCompletionToChat(emptyText).json()) as {
      choices: Array<{ message: Record<string, unknown> }>;
    };

    expect(toolPayload.choices[0]?.message).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call-1", type: "function" }],
    });
    expect(emptyPayload.choices[0]?.message).toMatchObject({ role: "assistant", content: "" });
  });

  test("encodes every canonical delta and one separate usage frame", async () => {
    let finalized = 0;
    const events: CanonicalOutputEvent[] = [
      started(),
      {
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "reasoning_delta",
        text: "reason",
      },
      {
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "reasoning_signature",
        signature: "signature",
      },
      {
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "reasoning_redacted",
        data: "redacted",
      },
      {
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "reasoning_encrypted",
        encryptedContent: "kr1_token",
      },
      {
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "text_delta",
        text: "answer",
      },
      {
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "tool_call_delta",
        index: 0,
        id: "call-1",
        name: "lookup",
        arguments: "{\"q\":",
      },
      {
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "tool_call_delta",
        index: 0,
        arguments: "\"x\"}",
      },
      completed("tool_calls"),
    ];

    const text = await canonicalOutputToChatSse(
      canonicalStream(events),
      activeSignals(),
      () => {
        finalized += 1;
      },
      { expectedModel: "claude-sonnet-5", includeUsage: true },
    ).text();
    const frames = dataFrames(text);
    const payloads = frames.slice(0, -1).map((frame) => JSON.parse(frame));

    expect(frames.at(-1)).toBe("[DONE]");
    expect(payloads.map((payload) => payload.choices?.[0]?.delta)).toContainEqual({
      reasoning_content: "reason",
    });
    expect(payloads.map((payload) => payload.choices?.[0]?.delta)).toContainEqual({
      reasoning_signature: "signature",
    });
    expect(payloads.map((payload) => payload.choices?.[0]?.delta)).toContainEqual({
      reasoning_redacted_content: "redacted",
    });
    expect(payloads.map((payload) => payload.choices?.[0]?.delta)).toContainEqual({
      reasoning_encrypted_content: "kr1_token",
    });
    expect(payloads.map((payload) => payload.choices?.[0]?.delta)).toContainEqual({
      content: "answer",
    });
    expect(
      payloads.filter((payload) => Array.isArray(payload.choices) && payload.choices.length === 0),
    ).toEqual([
      {
        id: "conversation-1",
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model: "claude-sonnet-5",
        choices: [],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 2,
          total_tokens: 5,
        },
      },
    ]);
    expect(finalized).toBe(1);
  });

  test("rejects a wrong model and conflicting tool fragments", async () => {
    const wrongModel = await canonicalOutputToChatSse(
      canonicalStream([started("other-model"), completed("stop")]),
      activeSignals(),
      () => undefined,
      { expectedModel: "claude-sonnet-5" },
    ).text();
    expect(wrongModel).toContain('"type":"upstream_protocol_error"');
    expect(wrongModel).not.toContain("[DONE]");

    const conflictingTool = await canonicalOutputToChatSse(
      canonicalStream([
        started(),
        {
          canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
          type: "tool_call_delta",
          index: 0,
          id: "call-1",
          name: "lookup",
          arguments: "",
        },
        {
          canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
          type: "tool_call_delta",
          index: 0,
          id: "call-2",
          arguments: "{}",
        },
        completed("tool_calls"),
      ]),
      activeSignals(),
      () => undefined,
      { expectedModel: "claude-sonnet-5" },
    ).text();
    expect(conflictingTool).toContain('"type":"upstream_protocol_error"');
    expect(conflictingTool).not.toContain("[DONE]");
  });

  test("rejects incomplete and malformed unterminated streams", async () => {
    const incomplete = await canonicalOutputToChatSse(
      canonicalStream([started()], false),
      activeSignals(),
      () => undefined,
      { expectedModel: "claude-sonnet-5" },
    ).text();
    expect(incomplete).toContain('"type":"upstream_error"');
    expect(incomplete).toContain('"code":"upstream_stream_incomplete"');

    const malformed = await canonicalOutputToChatSse(
      new Response("{"),
      activeSignals(),
      () => undefined,
      { expectedModel: "claude-sonnet-5" },
    ).text();
    expect(malformed).toContain('"type":"upstream_protocol_error"');
    expect(malformed).toContain('"code":"upstream_protocol_error"');
  });

  test("preserves a typed reader failure code", async () => {
    const error = Object.assign(new Error("typed failure"), {
      code: "upstream_stream_idle_timeout",
    });
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(error);
        },
      }),
    );

    const text = await canonicalOutputToChatSse(
      response,
      activeSignals(),
      () => undefined,
      { expectedModel: "claude-sonnet-5" },
    ).text();

    expect(text).toContain('"type":"upstream_error"');
    expect(text).toContain('"code":"upstream_stream_idle_timeout"');
  });

  test("uses safe default abort reasons for non-Error signal values", async () => {
    const deadline = new AbortController();
    const deadlineClient = new AbortController();
    deadline.abort("deadline");
    const deadlineText = await canonicalOutputToChatSse(
      canonicalStream([started(), completed("stop")]),
      {
        combined: AbortSignal.any([deadline.signal, deadlineClient.signal]),
        deadline: deadline.signal,
        client: deadlineClient.signal,
      },
      () => undefined,
      { expectedModel: "claude-sonnet-5" },
    ).text();
    expect(deadlineText).toContain("Request deadline exceeded");

    const client = new AbortController();
    const clientDeadline = new AbortController();
    client.abort("client");
    const clientText = await canonicalOutputToChatSse(
      canonicalStream([started(), completed("stop")]),
      {
        combined: AbortSignal.any([clientDeadline.signal, client.signal]),
        deadline: clientDeadline.signal,
        client: client.signal,
      },
      () => undefined,
      { expectedModel: "claude-sonnet-5" },
    ).text();
    expect(clientText).toBe("");
  });
});
