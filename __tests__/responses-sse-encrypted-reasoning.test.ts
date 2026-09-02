import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import {
  CANONICAL_OUTPUT_STREAM_CONTENT_TYPE,
  CANONICAL_OUTPUT_VERSION,
} from "../src/protocol/output.js";
import { parseResponsesRequest } from "../src/server/request-schema.js";
import { adaptResponsesRequest } from "../src/server/responses/request-adapter.js";
import { responsesSseAdapter } from "../src/server/responses/sse-adapter.js";
import type { ResponsesToolBridge } from "../src/server/responses/tool-bridge.js";

type ParsedEvent = {
  readonly type: string;
  readonly sequenceNumber: number;
  readonly body: Readonly<Record<string, unknown>>;
};

const encoder = new TextEncoder();
const MODEL = "gpt-5.6-sol";
const CONFIGURATION = {
  instructions: null,
  maxOutputTokens: null,
  metadata: {},
  reasoningEffort: null,
  toolChoice: "auto",
  tools: [],
} as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(event: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ canonicalOutputVersion: CANONICAL_OUTPUT_VERSION, ...event });
}

function started(): string {
  return canonical({
    type: "started",
    conversationId: "conversation_test",
    model: MODEL,
    createdAt: 1_700_000_000,
  });
}

function reasoning(text: string): string {
  return canonical({ type: "reasoning_delta", text });
}

function text(value: string): string {
  return canonical({ type: "text_delta", text: value });
}

function encrypted(token: string): string {
  return canonical({ type: "reasoning_encrypted", encryptedContent: token });
}

function tool(index: number, id: string, name: string, args: string): string {
  return canonical({ type: "tool_call_delta", index, id, name, arguments: args });
}

function completed(finishReason: "stop" | "tool_calls"): string {
  return canonical({
    type: "completed",
    finishReason,
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
  });
}

function pipelineResponse(lines: readonly string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${[started(), ...lines].join("\n")}\n`));
      },
    }),
    { headers: { "Content-Type": CANONICAL_OUTPUT_STREAM_CONTENT_TYPE } },
  );
}

function parseEvents(body: string): ParsedEvent[] {
  return body
    .split("\n\n")
    .filter((frame) => frame.length > 0)
    .map((frame) => {
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) throw new TypeError("invalid SSE frame");
      const parsed: unknown = JSON.parse(dataLine.slice("data: ".length));
      if (!isRecord(parsed) || typeof parsed.type !== "string") {
        throw new TypeError("invalid Responses event");
      }
      return {
        type: parsed.type,
        sequenceNumber: Number(parsed.sequence_number),
        body: parsed,
      };
    });
}

function bridgeFor(tools: readonly Record<string, unknown>[]): ResponsesToolBridge {
  const parsed = parseResponsesRequest({ model: MODEL, input: "run", tools });
  if (!parsed.ok) throw new TypeError("Expected a valid bridge request");
  const adapted = adaptResponsesRequest(parsed.value);
  if (!adapted.ok) throw new TypeError(`Expected a bridge, received ${adapted.code}`);
  return adapted.bridge;
}

async function adapt(
  lines: readonly string[],
  options: {
    readonly includeEncryptedReasoning?: boolean;
    readonly bridge?: ResponsesToolBridge;
  } = {},
): Promise<ParsedEvent[]> {
  const response = responsesSseAdapter(pipelineResponse(lines), {
    model: MODEL,
    signals: {
      combined: new AbortController().signal,
      deadline: new AbortController().signal,
      client: new AbortController().signal,
    },
    finalize: () => undefined,
    configuration: CONFIGURATION,
    includeEncryptedReasoning: options.includeEncryptedReasoning ?? false,
    ...(options.bridge ? { bridge: options.bridge } : {}),
  });
  return parseEvents(await response.text());
}

function itemDone(events: readonly ParsedEvent[], type: string): ParsedEvent[] {
  return events.filter(
    (event) =>
      event.type === "response.output_item.done" &&
      isRecord(event.body.item) &&
      event.body.item.type === type,
  );
}

function completedOutput(events: readonly ParsedEvent[]): unknown[] {
  const terminal = events.at(-1);
  if (
    !terminal ||
    !isRecord(terminal.body.response) ||
    !Array.isArray(terminal.body.response.output)
  ) {
    throw new TypeError("response.completed did not carry output");
  }
  return [...terminal.body.response.output];
}

function expectMonotonicSequence(events: readonly ParsedEvent[]): void {
  expect(events.map((event) => event.sequenceNumber)).toEqual(events.map((_event, index) => index));
}

describe("Responses SSE encrypted reasoning completion (A6)", () => {
  test("reasoning + text + tool: item-level done carries the same encrypted_content as response.completed", async () => {
    const bridge = bridgeFor([
      { type: "function", name: "lookup", parameters: { type: "object" } },
    ]);
    const events = await adapt(
      [
        reasoning("plan "),
        reasoning("first"),
        text("answer"),
        tool(0, "call_1", "lookup", '{"q":"x"}'),
        encrypted("kr1_turn-token"),
        completed("tool_calls"),
      ],
      { includeEncryptedReasoning: true, bridge },
    );
    const types = events.map((event) => event.type);

    // Reasoning deltas still stream before the text starts.
    expect(types.indexOf("response.reasoning_summary_text.delta")).toBeLessThan(
      types.indexOf("response.output_text.delta"),
    );
    // The reasoning item's done is deferred past the message's added event...
    const messageAdded = events.findIndex(
      (event) =>
        event.type === "response.output_item.added" &&
        isRecord(event.body.item) &&
        event.body.item.type === "message",
    );
    const reasoningDoneIndex = events.findIndex(
      (event) =>
        event.type === "response.output_item.done" &&
        isRecord(event.body.item) &&
        event.body.item.type === "reasoning",
    );
    const messageDoneIndex = events.findIndex(
      (event) =>
        event.type === "response.output_item.done" &&
        isRecord(event.body.item) &&
        event.body.item.type === "message",
    );
    expect(reasoningDoneIndex).toBeGreaterThan(messageAdded);
    // ...but item-level done events still arrive in output order.
    expect(reasoningDoneIndex).toBeLessThan(messageDoneIndex);
    expect(types.indexOf("response.reasoning_summary_text.done")).toBeLessThan(reasoningDoneIndex);

    const reasoningDone = itemDone(events, "reasoning");
    expect(reasoningDone).toHaveLength(1);
    expect(reasoningDone[0]?.body).toMatchObject({ output_index: 0 });
    const doneItem = reasoningDone[0]?.body.item;
    expect(doneItem).toMatchObject({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "plan first" }],
      encrypted_content: "kr1_turn-token",
    });
    const output = completedOutput(events);
    expect(output[0]).toEqual(doneItem);
    expect(output.map((item) => (isRecord(item) ? item.type : undefined))).toEqual([
      "reasoning",
      "message",
      "function_call",
    ]);
    // History assembled from output_item.done matches response.completed.output.
    expect(
      events
        .filter((event) => event.type === "response.output_item.done")
        .map((event) => event.body.item),
    ).toEqual(output);
    expectMonotonicSequence(events);
  });

  test("attaches encrypted_content to exactly one reasoning item when reasoning resumes after text (A8)", async () => {
    const events = await adapt(
      [
        reasoning("first"),
        text("answer"),
        reasoning("later"),
        encrypted("kr1_once"),
        completed("stop"),
      ],
      { includeEncryptedReasoning: true },
    );
    const reasoningDone = itemDone(events, "reasoning");

    expect(reasoningDone).toHaveLength(2);
    expect(reasoningDone[0]?.body).toMatchObject({
      output_index: 0,
      item: {
        summary: [{ type: "summary_text", text: "first" }],
        encrypted_content: "kr1_once",
      },
    });
    expect(reasoningDone[1]?.body).toMatchObject({
      output_index: 2,
      item: { summary: [{ type: "summary_text", text: "later" }] },
    });
    expect(reasoningDone[1]?.body.item).not.toHaveProperty("encrypted_content");
    const tokens = completedOutput(events)
      .filter((item) => isRecord(item) && item.type === "reasoning")
      .map((item) => (isRecord(item) ? item.encrypted_content : undefined));
    expect(tokens).toEqual(["kr1_once", undefined]);
    expectMonotonicSequence(events);
  });

  test("gives the token to the deferred item when reasoning only appears after text", async () => {
    const events = await adapt(
      [text("answer"), reasoning("afterthought"), encrypted("kr1_late"), completed("stop")],
      { includeEncryptedReasoning: true },
    );
    const reasoningDone = itemDone(events, "reasoning");

    expect(reasoningDone).toHaveLength(1);
    expect(reasoningDone[0]?.body).toMatchObject({
      output_index: 1,
      item: {
        summary: [{ type: "summary_text", text: "afterthought" }],
        encrypted_content: "kr1_late",
      },
    });
    expect(completedOutput(events).map((item) => (isRecord(item) ? item.type : undefined))).toEqual(
      ["message", "reasoning"],
    );
  });

  test("keeps eager reasoning completion when encrypted replay was not requested", async () => {
    const events = await adapt([reasoning("plan"), text("answer"), completed("stop")]);
    const types = events.map((event) => event.type);

    expect(types.indexOf("response.output_item.done")).toBeLessThan(
      types.lastIndexOf("response.output_item.added"),
    );
    expect(itemDone(events, "reasoning")[0]?.body.item).not.toHaveProperty("encrypted_content");
    expectMonotonicSequence(events);
  });
});

describe("Responses SSE OpenAI item shape (C13)", () => {
  test("wraps summary deltas in reasoning_summary_part events and mirrors part text", async () => {
    const events = await adapt([reasoning("plan"), text("answer"), completed("stop")]);
    const types = events.map((event) => event.type);

    expect(types.slice(0, 7)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
    ]);
    expect(events[3]?.body).toMatchObject({
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    });
    expect(events[6]?.body).toMatchObject({
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "plan" },
    });
  });

  test("output_text parts carry logprobs, tool items carry status, and usage carries detail objects", async () => {
    const bridge = bridgeFor([
      { type: "function", name: "lookup", parameters: { type: "object" } },
    ]);
    const events = await adapt(
      [text("answer"), tool(0, "call_1", "lookup", "{}"), completed("tool_calls")],
      { bridge },
    );

    const partAdded = events.find((event) => event.type === "response.content_part.added");
    const partDone = events.find((event) => event.type === "response.content_part.done");
    expect(partAdded?.body).toMatchObject({
      part: { type: "output_text", text: "", annotations: [], logprobs: [] },
    });
    expect(partDone?.body).toMatchObject({
      part: { type: "output_text", text: "answer", annotations: [], logprobs: [] },
    });
    expect(itemDone(events, "message")[0]?.body).toMatchObject({
      item: { content: [{ type: "output_text", text: "answer", annotations: [], logprobs: [] }] },
    });
    const toolAdded = events.find(
      (event) =>
        event.type === "response.output_item.added" &&
        isRecord(event.body.item) &&
        event.body.item.type === "function_call",
    );
    expect(toolAdded?.body).toMatchObject({
      item: { type: "function_call", status: "in_progress", arguments: "" },
    });
    expect(itemDone(events, "function_call")[0]?.body).toMatchObject({
      item: { type: "function_call", status: "completed", arguments: "{}" },
    });
    expect(events.at(-1)?.body).toMatchObject({
      response: {
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    });
  });
});

describe("Responses SSE typed tool restoration failures (B26 first step)", () => {
  let errorSpy: Mock<typeof console.error>;

  beforeEach(() => {
    errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  function auditEvents(): Array<Readonly<Record<string, unknown>>> {
    return errorSpy.mock.calls
      .map((call) => call[0])
      .filter((line): line is string => typeof line === "string")
      .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>)
      .filter((entry) => entry.event === "upstream_tool_restore_failed");
  }

  test("an undeclared upstream tool fails with unknown_upstream_tool and a hashed audit event", async () => {
    const bridge = bridgeFor([{ type: "custom", name: "exec" }]);
    const events = await adapt(
      [tool(0, "call_1", "hallucinated_tool", "{}"), completed("tool_calls")],
      { bridge },
    );

    expect(events.at(-1)?.body).toMatchObject({
      type: "response.failed",
      response: {
        error: { code: "unknown_upstream_tool", message: expect.stringContaining("undeclared") },
      },
    });
    expect(events.some((event) => event.type === "response.output_item.done")).toBe(false);
    const audits = auditEvents();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      level: "warn",
      protocol: "responses",
      error_code: "unknown_upstream_tool",
      error_disposition: "fatal",
      bridge_code: "unknown_tool_alias",
      tool_name_hash: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(JSON.stringify(audits[0])).not.toContain("hallucinated_tool");
  });

  test("a malformed custom wrapper fails with invalid_custom_tool_input", async () => {
    const bridge = bridgeFor([{ type: "custom", name: "exec" }]);
    const events = await adapt(
      [tool(0, "call_1", "kiro_custom_0", '{"input":1}'), completed("tool_calls")],
      { bridge },
    );

    expect(events.at(-1)?.body).toMatchObject({
      type: "response.failed",
      response: { error: { code: "invalid_custom_tool_input" } },
    });
    expect(auditEvents()[0]).toMatchObject({
      error_code: "invalid_custom_tool_input",
      bridge_code: "invalid_custom_tool_input",
    });
  });
});
