import { expect, test } from "bun:test";
import OpenAI from "openai";
import { CANONICAL_OUTPUT_STREAM_CONTENT_TYPE } from "../src/protocol/output.js";
import { responsesSseAdapter } from "../src/server/responses/sse-adapter.js";
import { handleResponses, handleStoredResponse } from "../src/server/routes/responses.js";
import { fidelityFixture, nativeResponse, sse, textEvents } from "./responses-fidelity-helpers.js";

function client(f: ReturnType<typeof fidelityFixture>): OpenAI {
  return new OpenAI({
    apiKey: "sk-sdk-fixture",
    baseURL: "http://gateway/v1",
    maxRetries: 0,
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      const path = new URL(request.url).pathname;
      if (request.method === "POST") return handleResponses(request, f.config, f.dependencies);
      const id = path.split("/")[3] ?? "";
      return handleStoredResponse(
        request,
        f.dependencies,
        id,
        path.endsWith("/input_items") ? "input_items" : "retrieve",
      );
    },
  });
}

test("official SDK assembles reasoning completed after its signed message and tool", async () => {
  const sdk = new OpenAI({
    apiKey: "sk-sdk-fixture",
    baseURL: "http://gateway/v1",
    maxRetries: 0,
    fetch: async () => {
      const events = [
        { type: "started", conversationId: "sdk-order", model: "claude-opus-5", createdAt: 1 },
        { type: "reasoning_delta", text: "Inspect the requested value." },
        { type: "text_delta", text: "Checking." },
        { type: "tool_call_delta", index: 0, id: "call_sdk", name: "echo", arguments: "{}" },
        { type: "reasoning_encrypted", encryptedContent: "kr1_complete-output" },
        {
          type: "completed",
          finishReason: "tool_calls",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        },
      ];
      const signal = new AbortController().signal;
      return responsesSseAdapter(
        new Response(
          `${events
            .map((event) => JSON.stringify({ canonicalOutputVersion: 1, ...event }))
            .join("\n")}\n`,
          {
            headers: { "Content-Type": CANONICAL_OUTPUT_STREAM_CONTENT_TYPE },
          },
        ),
        {
          model: "claude-opus-5",
          signals: { combined: signal, deadline: signal, client: signal },
          finalize() {},
          includeEncryptedReasoning: true,
          configuration: {
            instructions: null,
            maxOutputTokens: null,
            metadata: {},
            reasoningEffort: null,
            toolChoice: "auto",
            tools: [],
          },
        },
      );
    },
  });
  const stream = sdk.responses.stream({ model: "claude-opus-5", input: "Check." });
  const doneTypes: string[] = [];
  stream.on("response.output_item.done", (event) => {
    doneTypes.push(event.item.type);
  });
  const response = await stream.finalResponse();
  expect(response.status).toBe("completed");
  expect(doneTypes).toEqual(["message", "function_call", "reasoning"]);
  expect(response.output.map((item) => item.type)).toEqual([
    "reasoning",
    "message",
    "function_call",
  ]);
  expect(response.output[0]).toMatchObject({ encrypted_content: "kr1_complete-output" });
  expect(response.output_text).toBe("Checking.");
});

test("official SDK creates, retrieves, lists input, and replays full output", async () => {
  const f = fidelityFixture();
  try {
    const sdk = client(f);
    const first = await sdk.responses.create({
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: "Hi" }],
      instructions: null,
      previous_response_id: null,
    });
    expect(first.output_text).toBe("OK");
    expect((await sdk.responses.retrieve(first.id)).output).toEqual(first.output);
    const items = await sdk.responses.inputItems.list(first.id);
    expect(items.data[0]?.type).toBe("message");
    const second = await sdk.responses.create({
      model: "gpt-5.6-sol",
      input: [
        ...first.output.map((item) => {
          if (item.type !== "message") throw new Error("Unexpected fixture output");
          return item;
        }),
        { role: "user", content: "Continue" },
      ],
    });
    expect(second.output_text).toBe("OK");
  } finally {
    f.database.close();
  }
});

test("the official SDK stream output replays message and function parse metadata unchanged", async () => {
  const item = {
    type: "function_call",
    id: "fc_sdk",
    call_id: "call_sdk",
    name: "echo",
    arguments: "{}",
    status: "completed",
  };
  const final = nativeResponse("resp_stream");
  final.output = [...(final.output as unknown[]), item];
  const events = [
    ...textEvents().slice(0, -1),
    {
      type: "response.output_item.added",
      sequence_number: 7,
      output_index: 1,
      item: { ...item, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      sequence_number: 8,
      item_id: item.id,
      output_index: 1,
      delta: "{}",
    },
    {
      type: "response.function_call_arguments.done",
      sequence_number: 9,
      item_id: item.id,
      output_index: 1,
      arguments: "{}",
      name: item.name,
    },
    { type: "response.output_item.done", sequence_number: 10, output_index: 1, item },
    { type: "response.completed", sequence_number: 11, response: final },
  ];
  const f = fidelityFixture({
    native: () =>
      new Response(events.map(sse).join(""), { headers: { "Content-Type": "text/event-stream" } }),
  });
  try {
    const sdk = client(f);
    const tools = [
      {
        type: "function" as const,
        name: "echo",
        description: "Echo",
        parameters: { type: "object" },
        strict: false,
      },
    ];
    const first = await sdk.responses
      .stream({ model: "gpt-5.6-sol", input: "Hi", tools })
      .finalResponse();
    const output = first.output.map((value) => {
      if (value.type !== "message" && value.type !== "function_call")
        throw new Error("Unexpected fixture output");
      return value;
    });
    expect(output[1]).toHaveProperty("parsed_arguments", null);
    const next = await sdk.responses.create({
      model: "gpt-5.6-sol",
      store: false,
      tools,
      input: [
        { role: "user", content: "Hi" },
        ...output,
        { type: "function_call_output", call_id: item.call_id, output: "OK" },
        { role: "user", content: "Continue" },
      ],
    });
    expect(next.output_text).toBe("OK");
    expect(
      f.canonical[0]?.messages.some((message) =>
        message.toolCalls.some((call) => call.id === item.call_id),
      ),
    ).toBe(true);
  } finally {
    f.database.close();
  }
});

test.each([true, false])(
  "official SDK distinguishes complete=%s from an incomplete network stream",
  async (complete) => {
    const events = complete ? textEvents() : textEvents().slice(0, 4);
    const f = fidelityFixture({
      native: () =>
        new Response(events.map(sse).join(""), {
          headers: { "Content-Type": "text/event-stream" },
        }),
    });
    try {
      const stream = client(f).responses.stream({ model: "gpt-5.6-sol", input: "Hi" });
      const terminal = await stream.finalResponse();
      expect(terminal.status).toBe(complete ? "completed" : "failed");
      if (complete) expect(terminal.output_text).toBe("OK");
      else expect(String(terminal.error?.code)).toBe("upstream_stream_incomplete");
    } finally {
      f.database.close();
    }
  },
);
