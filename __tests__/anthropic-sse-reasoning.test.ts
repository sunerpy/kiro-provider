import { describe, expect, test } from "bun:test";
import {
  CANONICAL_OUTPUT_STREAM_CONTENT_TYPE,
  CANONICAL_OUTPUT_VERSION,
  type CanonicalCompletion,
} from "../src/protocol/output.js";
import { adaptAnthropicMessagesRequest } from "../src/server/anthropic/request-adapter.js";
import {
  anthropicMessageResponse,
  anthropicSseAdapter,
} from "../src/server/anthropic/response-adapter.js";

const MODEL = "claude-sonnet-5";
const encoder = new TextEncoder();

type Frame = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(event: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ canonicalOutputVersion: CANONICAL_OUTPUT_VERSION, ...event });
}

const started = canonical({
  type: "started",
  conversationId: "conversation-anthropic",
  model: MODEL,
  createdAt: 1_700_000_000,
});
const reasoning = (text: string): string => canonical({ type: "reasoning_delta", text });
const signature = (value: string): string =>
  canonical({ type: "reasoning_signature", signature: value });
const redacted = (data: string): string => canonical({ type: "reasoning_redacted", data });
const text = (value: string): string => canonical({ type: "text_delta", text: value });
const tool = (index: number, id: string, name: string, args: string): string =>
  canonical({ type: "tool_call_delta", index, id, name, arguments: args });
const completed = (finishReason: "stop" | "tool_calls" = "stop"): string =>
  canonical({
    type: "completed",
    finishReason,
    usage: { inputTokens: 41, outputTokens: 9, totalTokens: 50 },
  });

function pipelineResponse(lines: readonly string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${[started, ...lines].join("\n")}\n`));
      },
    }),
    { headers: { "Content-Type": CANONICAL_OUTPUT_STREAM_CONTENT_TYPE } },
  );
}

function signals(): {
  readonly combined: AbortSignal;
  readonly deadline: AbortSignal;
  readonly client: AbortSignal;
} {
  return {
    combined: new AbortController().signal,
    deadline: new AbortController().signal,
    client: new AbortController().signal,
  };
}

function adapter(lines: readonly string[], finalize: () => void = () => undefined): Response {
  return anthropicSseAdapter(pipelineResponse(lines), {
    model: MODEL,
    inputTokens: 3,
    signals: signals(),
    finalize,
  });
}

function parseFrames(body: string): Frame[] {
  return body
    .split("\n\n")
    .filter((frame) => frame.length > 0)
    .map((frame) => {
      const lines = frame.split("\n");
      const eventLine = lines.find((line) => line.startsWith("event: "));
      const dataLine = lines.find((line) => line.startsWith("data: "));
      if (!eventLine || !dataLine) throw new TypeError(`invalid SSE frame: ${frame}`);
      const parsed: unknown = JSON.parse(dataLine.slice("data: ".length));
      if (!isRecord(parsed)) throw new TypeError("SSE payload must be an object");
      expect(eventLine).toBe(`event: ${parsed.type}`);
      return parsed;
    });
}

async function adapt(lines: readonly string[]): Promise<Frame[]> {
  return parseFrames(await adapter(lines).text());
}

type BlockSummary = {
  readonly index: number;
  readonly type: string;
  readonly deltas: readonly string[];
};

// Every delta must target an open block, block indexes must be allocated in
// increasing order, and no two blocks may be open at the same time.
function assertLegalBlockSequence(frames: readonly Frame[]): BlockSummary[] {
  const blocks: Array<{ index: number; type: string; deltas: string[] }> = [];
  let open: number | undefined;
  let nextIndex = 0;
  for (const frame of frames) {
    if (frame.type === "content_block_start") {
      expect(open).toBeUndefined();
      expect(frame.index).toBe(nextIndex);
      nextIndex += 1;
      open = frame.index as number;
      const block = frame.content_block;
      if (!isRecord(block) || typeof block.type !== "string") {
        throw new TypeError("content_block_start without a typed block");
      }
      blocks.push({ index: open, type: block.type, deltas: [] });
      continue;
    }
    if (frame.type === "content_block_delta") {
      expect(frame.index).toBe(open);
      const delta = frame.delta;
      if (!isRecord(delta) || typeof delta.type !== "string") {
        throw new TypeError("content_block_delta without a typed delta");
      }
      blocks.at(-1)?.deltas.push(delta.type);
      continue;
    }
    if (frame.type === "content_block_stop") {
      expect(frame.index).toBe(open);
      open = undefined;
    }
  }
  expect(open).toBeUndefined();
  return blocks;
}

describe("Anthropic SSE thinking block ordering (A7)", () => {
  test("reasoning after text is deferred into a new block and, being unsigned, fails the stream", async () => {
    const frames = await adapt([
      reasoning("first"),
      signature("sig-1"),
      text("answer "),
      reasoning("later"),
      text("done"),
      completed(),
    ]);

    const blocks = assertLegalBlockSequence(frames);
    expect(blocks.map((block) => [block.index, block.type, block.deltas])).toEqual([
      [0, "thinking", ["thinking_delta", "signature_delta"]],
      [1, "text", ["text_delta", "text_delta"]],
      [2, "thinking", ["thinking_delta"]],
    ]);
    expect(frames.at(-1)).toMatchObject({
      type: "error",
      error: {
        type: "api_error",
        message: "Upstream returned incomplete signed reasoning metadata",
      },
    });
    expect(frames.some((frame) => frame.type === "message_stop")).toBe(false);
  });

  test("a late signature is assigned to the deferred thinking block so the stream completes", async () => {
    const frames = await adapt([
      reasoning("first"),
      signature("sig-1"),
      text("answer"),
      reasoning("later"),
      signature("sig-2"),
      completed(),
    ]);

    const blocks = assertLegalBlockSequence(frames);
    expect(blocks.map((block) => [block.index, block.type, block.deltas])).toEqual([
      [0, "thinking", ["thinking_delta", "signature_delta"]],
      [1, "text", ["text_delta"]],
      [2, "thinking", ["thinking_delta", "signature_delta"]],
    ]);
    expect(frames.filter((frame) => frame.type === "content_block_delta").at(-1)).toMatchObject({
      index: 2,
      delta: { type: "signature_delta", signature: "sig-2" },
    });
    expect(frames.map((frame) => frame.type).slice(-2)).toEqual(["message_delta", "message_stop"]);
  });

  test("a redacted envelope that arrives while text is open waits until the text block stops", async () => {
    const frames = await adapt([
      text("answer "),
      redacted("cmVkYWN0ZWQ="),
      text("done"),
      completed(),
    ]);

    const blocks = assertLegalBlockSequence(frames);
    expect(blocks.map((block) => [block.index, block.type, block.deltas])).toEqual([
      [0, "text", ["text_delta", "text_delta"]],
      [1, "redacted_thinking", []],
    ]);
    expect(
      frames.find((frame) => frame.type === "content_block_start" && frame.index === 1),
    ).toMatchObject({
      content_block: { type: "redacted_thinking", data: "cmVkYWN0ZWQ=" },
    });
    expect(frames.map((frame) => frame.type).slice(-2)).toEqual(["message_delta", "message_stop"]);
  });
});

describe("Anthropic unsigned thinking parity (B22)", () => {
  test("a thinking block that completes without any signature fails like the non-stream 502", async () => {
    const frames = await adapt([reasoning("plan"), text("answer"), completed()]);

    assertLegalBlockSequence(frames);
    const streamError = frames.at(-1);
    expect(streamError).toMatchObject({ type: "error", error: { type: "api_error" } });
    expect(frames.some((frame) => frame.type === "message_delta")).toBe(false);

    const completion: CanonicalCompletion = {
      canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
      conversationId: "conversation-anthropic",
      model: MODEL,
      createdAt: 1_700_000_000,
      text: "answer",
      reasoning: { text: "plan" },
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 41, outputTokens: 9, totalTokens: 50 },
    };
    const nonStream = anthropicMessageResponse(completion, MODEL);
    const body: unknown = await nonStream.json();
    expect(nonStream.status).toBe(502);
    expect(body).toMatchObject({ error: { type: "api_error" } });
    const streamMessage = isRecord(streamError?.error) ? streamError.error.message : undefined;
    const nonStreamMessage =
      isRecord(body) && isRecord(body.error) ? body.error.message : undefined;
    expect(streamMessage).toBe(nonStreamMessage);
  });

  test("a signature that arrives after the last thinking delta is still accepted", async () => {
    const frames = await adapt([
      reasoning("plan "),
      reasoning("carefully"),
      signature("sig-late"),
      text("answer"),
      completed(),
    ]);

    const blocks = assertLegalBlockSequence(frames);
    expect(blocks[0]).toEqual({
      index: 0,
      type: "thinking",
      deltas: ["thinking_delta", "thinking_delta", "signature_delta"],
    });
    expect(frames.map((frame) => frame.type).slice(-2)).toEqual(["message_delta", "message_stop"]);
  });

  test("a signature without any thinking block fails instead of completing silently", async () => {
    const frames = await adapt([signature("orphan"), text("answer"), completed()]);

    expect(frames.at(-1)).toMatchObject({ type: "error", error: { type: "api_error" } });
  });
});

describe("Anthropic message_delta usage (B27)", () => {
  test("carries the real input and output tokens from the canonical completion", async () => {
    const frames = await adapt([text("answer"), completed()]);
    const messageDelta = frames.find((frame) => frame.type === "message_delta");

    expect(messageDelta).toMatchObject({
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: {
        input_tokens: 41,
        output_tokens: 9,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    expect(frames[0]).toMatchObject({
      type: "message_start",
      message: { usage: { input_tokens: 3, output_tokens: 0 } },
    });
  });
});

describe("Anthropic SSE backpressure (B17)", () => {
  type Source = Bun.UnderlyingSource<Uint8Array>;

  // Swap the global constructor only while the adapter builds its own stream so
  // the underlying source can be pulled by hand with a controllable desiredSize.
  function captureUnderlyingSource(run: () => Response): Source {
    const NativeReadableStream = globalThis.ReadableStream;
    let captured: Source | undefined;
    class CapturingReadableStream<R> extends NativeReadableStream<R> {
      constructor(source?: Bun.UnderlyingSource<R>, strategy?: QueuingStrategy<R>) {
        super(
          {
            start() {},
            pull() {
              return new Promise<void>(() => undefined);
            },
          },
          strategy,
        );
        if (captured === undefined && source !== undefined) {
          captured = source as unknown as Source;
        }
      }
    }
    globalThis.ReadableStream = CapturingReadableStream as unknown as typeof ReadableStream;
    try {
      run();
    } finally {
      globalThis.ReadableStream = NativeReadableStream;
    }
    if (!captured) throw new TypeError("adapter did not construct a ReadableStream");
    return captured;
  }

  test("enqueues at most one frame per pull and nothing while desiredSize is exhausted", async () => {
    let finalizeCount = 0;
    // Build the upstream body with the native constructor first.
    const upstream = pipelineResponse([
      reasoning("plan"),
      signature("sig"),
      text("answer"),
      tool(0, "tool-1", "read", '{"path":"a"}'),
      tool(1, "tool-2", "search", '{"q":"x"}'),
      completed("tool_calls"),
    ]);
    const source = captureUnderlyingSource(() =>
      anthropicSseAdapter(upstream, {
        model: MODEL,
        inputTokens: 3,
        signals: signals(),
        finalize: () => {
          finalizeCount += 1;
        },
      }),
    );
    const enqueued: Uint8Array[] = [];
    const enqueuedPerPull: number[] = [];
    let desiredSize = 1;
    let closed = false;
    const controller = {
      get desiredSize() {
        return desiredSize;
      },
      enqueue(chunk: Uint8Array) {
        enqueued.push(chunk);
      },
      close() {
        closed = true;
      },
      error() {
        throw new TypeError("adapter must not error the stream in this scenario");
      },
    } as unknown as ReadableStreamDefaultController<Uint8Array>;

    await source.start?.(controller);
    expect(enqueued).toHaveLength(1);

    desiredSize = 0;
    await source.pull?.(controller);
    expect(enqueued).toHaveLength(1);

    desiredSize = 1;
    while (!closed) {
      const before = enqueued.length;
      await source.pull?.(controller);
      enqueuedPerPull.push(enqueued.length - before);
      if (enqueuedPerPull.length > 100) throw new TypeError("stream never drained");
    }

    expect(enqueuedPerPull.every((count) => count <= 1)).toBe(true);
    const frames = parseFrames(new TextDecoder().decode(Buffer.concat(enqueued)));
    expect(frames.map((frame) => frame.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(finalizeCount).toBe(1);
  });

  test("a reader that pulls one chunk at a time still receives the full protocol order", async () => {
    const response = adapter([reasoning("plan"), signature("sig"), text("answer"), completed()]);
    const reader = response.body?.getReader();
    if (!reader) throw new TypeError("adapter response has no body");
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(decoder.decode(next.value));
      // Each pull delivers exactly one SSE frame.
      expect(chunks.at(-1)?.match(/\nevent: |^event: /g)).toHaveLength(1);
    }

    expect(parseFrames(chunks.join("")).map((frame) => frame.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });
});

describe("Anthropic request validation (B22 input, B24)", () => {
  function request(messages: readonly unknown[]): unknown {
    return {
      model: MODEL,
      max_tokens: 1_024,
      tools: [{ name: "read", input_schema: { type: "object" } }],
      messages,
    };
  }

  test("accepts a tool_result without content as an empty result", () => {
    const result = adaptAnthropicMessagesRequest(
      request([
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tool-1", name: "read", input: { path: "a" } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1" }] },
      ]),
      { requireMaxTokens: true },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.body.messages[2]).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", toolCallId: "tool-1", content: [], isError: false }],
    });
  });

  test("rejects a thinking block whose signature is an empty string", () => {
    const result = adaptAnthropicMessagesRequest(
      request([
        { role: "user", content: "plan" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private plan", signature: "" },
            { type: "text", text: "answer" },
          ],
        },
        { role: "user", content: "next" },
      ]),
      { requireMaxTokens: true },
    );

    expect(result).toMatchObject({
      ok: false,
      code: "invalid_reasoning_replay",
      param: "messages.1.content.0.signature",
      message: expect.stringContaining("non-empty signature"),
    });
  });
});
