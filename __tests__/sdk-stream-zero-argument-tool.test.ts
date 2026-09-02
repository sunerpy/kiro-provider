import { describe, expect, test } from "bun:test";
import { collectSdkResponse } from "../src/kiro/transform/sdk-collector.js";
import { transformSdkOutputStream } from "../src/kiro/transform/streaming/sdk-output-transformer.js";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import { ToolCallViolation } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import {
  CANONICAL_OUTPUT_STREAM_CONTENT_TYPE,
  type CanonicalOutputEvent,
} from "../src/protocol/output.js";
import { anthropicSseAdapter } from "../src/server/anthropic/response-adapter.js";
import { parseResponsesRequest } from "../src/server/request-schema.js";
import { adaptResponsesRequest } from "../src/server/responses/request-adapter.js";
import { responsesSseAdapter } from "../src/server/responses/sse-adapter.js";
import { collectSdkEvents, makeSdkResponse } from "./sdk-stream-test-helpers.js";

const MODEL = "claude-sonnet-5";
const CONVERSATION = "conversation-zero-args";
const COMPLETION: SdkStreamEvent = {
  metadataEvent: { tokenUsage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
};

// Exact shape observed from Kiro on 2026-09-02 for a tool declared with an
// empty `properties` object: neither event carries an `input` key.
const ZERO_ARGUMENT_CALL: readonly SdkStreamEvent[] = [
  { toolUseEvent: { toolUseId: "tool-zero", name: "ping" } },
  { toolUseEvent: { toolUseId: "tool-zero", name: "ping", stop: true } },
];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ndjson(events: readonly CanonicalOutputEvent[]): Response {
  return new Response(events.map((event) => JSON.stringify(event)).join("\n"), {
    headers: { "Content-Type": CANONICAL_OUTPUT_STREAM_CONTENT_TYPE },
  });
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

function parseSse(text: string): Array<Readonly<Record<string, unknown>>> {
  return text
    .split("\n\n")
    .filter((frame) => frame.length > 0)
    .map((frame) => {
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      if (!data) throw new TypeError("SSE frame has no data line");
      const parsed: unknown = JSON.parse(data.slice("data: ".length));
      if (!isRecord(parsed)) throw new TypeError("SSE payload must be an object");
      return parsed;
    });
}

describe("zero-argument Kiro tool calls (B20 evidence)", () => {
  test("the stream transformer projects a stop without any input fragment as {}", async () => {
    const events = await collectSdkEvents([...ZERO_ARGUMENT_CALL, COMPLETION], MODEL, CONVERSATION);
    const toolDelta = events.find((event) => event.type === "tool_call_delta");

    expect(toolDelta).toMatchObject({
      type: "tool_call_delta",
      index: 0,
      id: "tool-zero",
      name: "ping",
      arguments: "{}",
    });
    expect(events.at(-1)).toMatchObject({ type: "completed", finishReason: "tool_calls" });
  });

  test("the non-stream collector projects the same call as {}", async () => {
    const completion = await collectSdkResponse(
      makeSdkResponse([...ZERO_ARGUMENT_CALL, COMPLETION]),
      MODEL,
      CONVERSATION,
    );

    expect(completion.toolCalls).toEqual([{ id: "tool-zero", name: "ping", input: "{}" }]);
    expect(completion.finishReason).toBe("tool_calls");
  });

  test.each([
    ["a partial JSON fragment", '{"a":'],
    ["an explicit empty fragment", ""],
    ["a whitespace-only fragment", "  "],
  ])("%s followed by stop remains malformed_upstream_tool_arguments", async (_label, input) => {
    const events: readonly SdkStreamEvent[] = [
      { toolUseEvent: { toolUseId: "tool-bad", name: "ping", input } },
      { toolUseEvent: { toolUseId: "tool-bad", name: "ping", stop: true } },
      COMPLETION,
    ];
    let caught: unknown;
    try {
      await collectSdkEvents(events, MODEL, CONVERSATION);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ToolCallViolation);
    expect(caught).toMatchObject({
      code: "malformed_upstream_tool_arguments",
      violationKind: "malformed_arguments",
    });
  });

  test("a call that never stopped is still incomplete even without input", async () => {
    let caught: unknown;
    try {
      await collectSdkEvents(
        [{ toolUseEvent: { toolUseId: "tool-open", name: "ping" } }, COMPLETION],
        MODEL,
        CONVERSATION,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "incomplete_upstream_tool_call" });
  });

  test("Responses SSE emits the zero-argument call with {} arguments end to end", async () => {
    const canonical: CanonicalOutputEvent[] = [];
    for await (const event of transformSdkOutputStream(
      makeSdkResponse([...ZERO_ARGUMENT_CALL, COMPLETION]),
      MODEL,
      CONVERSATION,
    )) {
      canonical.push(event);
    }
    const parsed = parseResponsesRequest({
      model: MODEL,
      input: "ping it",
      tools: [
        {
          type: "function",
          name: "ping",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    });
    if (!parsed.ok) throw new TypeError("Expected a valid Responses request");
    const adapted = adaptResponsesRequest(parsed.value);
    if (!adapted.ok) throw new TypeError(`Expected a bridge, received ${adapted.code}`);

    const response = responsesSseAdapter(ndjson(canonical), {
      model: MODEL,
      signals: signals(),
      finalize: () => undefined,
      bridge: adapted.bridge,
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
    const frames = parseSse(await response.text());

    expect(frames.at(-1)).toMatchObject({
      type: "response.completed",
      response: {
        output: [
          {
            type: "function_call",
            call_id: "tool-zero",
            name: "ping",
            arguments: "{}",
            status: "completed",
          },
        ],
      },
    });
    expect(
      frames.find((frame) => frame.type === "response.function_call_arguments.done"),
    ).toMatchObject({ arguments: "{}" });
  });

  test("Anthropic SSE emits the zero-argument call as an empty tool_use input end to end", async () => {
    const canonical: CanonicalOutputEvent[] = [];
    for await (const event of transformSdkOutputStream(
      makeSdkResponse([...ZERO_ARGUMENT_CALL, COMPLETION]),
      MODEL,
      CONVERSATION,
    )) {
      canonical.push(event);
    }

    const response = anthropicSseAdapter(ndjson(canonical), {
      model: MODEL,
      inputTokens: 3,
      signals: signals(),
      finalize: () => undefined,
    });
    const frames = parseSse(await response.text());

    expect(frames.map((frame) => frame.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(frames[1]).toMatchObject({
      content_block: { type: "tool_use", id: "tool-zero", name: "ping", input: {} },
    });
    expect(frames[2]).toMatchObject({
      delta: { type: "input_json_delta", partial_json: "{}" },
    });
    expect(frames[4]).toMatchObject({ delta: { stop_reason: "tool_use" } });
  });
});
