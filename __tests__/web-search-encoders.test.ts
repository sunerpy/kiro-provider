import { describe, expect, test } from "bun:test";
import type { CanonicalOutputEventV2 } from "../src/protocol/output-v2.js";
import {
  anthropicHostedMessageResponse,
  anthropicHostedSseAdapter,
  HostedMessagesEncoder,
  HostedOutputError,
} from "../src/server/anthropic/hosted-response.js";
import {
  HostedResponsesEncoder,
  HostedResponsesOutputError,
  hostedCompletedResponse,
  hostedResponsesSseAdapter,
} from "../src/server/responses/hosted-output.js";
import { createResponsesToolBridge } from "../src/server/responses/tool-bridge.js";
import { WebSearchError } from "../src/web-search/errors.js";
import { sseData } from "./web-search-test-helpers.js";

// Direct encoder coverage: each public protocol event sequence the hosted loop
// can produce, and every ordering violation it must refuse to publish.

const TOKEN_ONE = `kr2_${"a".repeat(64)}`;
const TOKEN_TWO = `kr2_${"b".repeat(64)}`;
const USAGE = { inputTokens: 10, outputTokens: 4, totalTokens: 14 };

function ev<T extends CanonicalOutputEventV2["type"]>(
  type: T,
  body: Omit<
    Extract<CanonicalOutputEventV2, { readonly type: T }>,
    "canonicalOutputVersion" | "type"
  >,
): CanonicalOutputEventV2 {
  return { canonicalOutputVersion: 2, type, ...body } as CanonicalOutputEventV2;
}

const started = (model = "claude-opus-5-5") =>
  ev("started", { conversationId: "conv", model, createdAt: 1 });
const completed = (finishReason: "stop" | "tool_calls" | "pause" = "stop", webSearchRequests = 1) =>
  ev("completed", { finishReason, usage: USAGE, webSearchRequests });
const sources = [
  {
    ordinal: 0,
    url: "https://docs.example.com/a",
    title: "A",
    pageAge: "2026-09-01",
    encryptedContent: "kws1_a",
  },
];

function collectMessages(events: readonly CanonicalOutputEventV2[], options = {}) {
  const blocks: Array<Record<string, unknown>> = [];
  const deltas: Array<Record<string, unknown>> = [];
  const encoder = new HostedMessagesEncoder(
    { model: "claude-opus-5-5", ...options },
    {
      start: (index, block) => {
        blocks[index] = { ...block };
      },
      delta: (_index, delta) => {
        deltas.push(delta);
      },
      stop: () => {},
    },
  );
  for (const event of events) encoder.push(event);
  return { blocks, deltas, terminal: encoder.terminal };
}

function signals() {
  const deadline = new AbortController();
  const client = new AbortController();
  return {
    deadline,
    client,
    value: {
      combined: AbortSignal.any([deadline.signal, client.signal]),
      deadline: deadline.signal,
      client: client.signal,
    },
  };
}

function ndjson(events: readonly CanonicalOutputEventV2[], tail = ""): Response {
  return new Response(`${events.map((event) => JSON.stringify(event)).join("\n")}\n${tail}`);
}

describe("Messages hosted encoder", () => {
  test("prelude results, redacted reasoning and pending result blocks", () => {
    const { blocks, terminal } = collectMessages([
      started(),
      ev("search_result", { callId: "srvtoolu_pending", sources }),
      ev("search_call_completed", { callId: "srvtoolu_pending" }),
      ev("reasoning_redacted", { data: "cmVkYWN0ZWQ=" }),
      ev("text_delta", { text: "Answer." }),
      completed(),
    ]);
    expect(blocks.map((block) => block.type)).toEqual([
      "web_search_tool_result",
      "redacted_thinking",
      "text",
    ]);
    expect(terminal?.stopReason).toBe("end_turn");
  });

  test("GPT placeholder reasoning becomes an empty signed thinking block", () => {
    const visible = collectMessages(
      [
        started("gpt-5.6-sol"),
        ev("reasoning_delta", { text: "..." }),
        ev("reasoning_signature", { signature: "native-sig" }),
        ev("text_delta", { text: "Hi" }),
        completed("stop", 0),
      ],
      { model: "gpt-5.6-sol" },
    );
    expect(visible.blocks[0]).toEqual({ type: "thinking", thinking: "", signature: "" });
    expect(visible.deltas).toContainEqual({ type: "signature_delta", signature: "native-sig" });
    const omitted = collectMessages(
      [
        started("gpt-5.6-sol"),
        ev("reasoning_delta", { text: "..." }),
        ev("reasoning_signature", { signature: "native-sig" }),
        ev("text_delta", { text: "Hi" }),
        ev("reasoning_encrypted", { encryptedContent: TOKEN_ONE }),
        completed("stop", 0),
      ],
      { model: "gpt-5.6-sol", thinkingDisplay: "omitted" },
    );
    expect(omitted.deltas).toContainEqual({ type: "signature_delta", signature: TOKEN_ONE });
    expect(omitted.blocks.map((block) => block.type)).toEqual(["thinking", "text"]);
  });

  test("late visible reasoning becomes its own signed block in the same segment", () => {
    const { blocks, deltas } = collectMessages([
      started(),
      ev("text_delta", { text: "First " }),
      ev("reasoning_delta", { text: "late thought" }),
      ev("reasoning_signature", { signature: "late-sig" }),
      ev("search_call_started", { callId: "srvtoolu_1", query: "q", deferred: false }),
      ev("search_result", { callId: "srvtoolu_1", sources: [] }),
      ev("search_call_completed", { callId: "srvtoolu_1" }),
      ev("generation_boundary", {}),
      ev("text_delta", { text: "done" }),
      completed(),
    ]);
    expect(blocks.map((block) => block.type)).toEqual([
      "text",
      "thinking",
      "server_tool_use",
      "web_search_tool_result",
      "text",
    ]);
    expect(deltas).toContainEqual({ type: "thinking_delta", thinking: "late thought" });
  });

  test.each([
    ["started twice", [started(), started()]],
    ["a foreign model", [started("gpt-5.6-sol")]],
    ["content before start", [ev("text_delta", { text: "x" })]],
    [
      "text after its tool group",
      [
        started(),
        ev("search_call_started", { callId: "s", query: "q", deferred: true }),
        ev("text_delta", { text: "x" }),
      ],
    ],
    [
      "a citation without its envelope",
      [
        started(),
        ev("citation", {
          text: "x",
          callId: "s",
          ordinal: 0,
          url: "u",
          title: "t",
          citedText: "c",
        }),
      ],
    ],
    [
      "a result without its envelope",
      [
        started(),
        ev("search_call_started", { callId: "s", query: "q", deferred: false }),
        ev("search_result", {
          callId: "s",
          sources: [{ ...sources[0], encryptedContent: undefined }] as never,
        }),
      ],
    ],
    [
      "a result for an unknown call after output",
      [
        started(),
        ev("text_delta", { text: "x" }),
        ev("search_call_failed", { callId: "s", errorCode: "unavailable" }),
      ],
    ],
    [
      "a repeated call identity",
      [
        started(),
        ev("search_call_started", { callId: "s", query: "q", deferred: true }),
        ev("search_call_started", { callId: "s", query: "q", deferred: true }),
      ],
    ],
    [
      "a completion without a result",
      [
        started(),
        ev("search_call_started", { callId: "s", query: "q", deferred: false }),
        ev("search_call_completed", { callId: "s" }),
      ],
    ],
    [
      "a boundary after client calls",
      [
        started(),
        ev("tool_call_delta", { index: 0, id: "t", name: "f", arguments: "{}" }),
        ev("generation_boundary", {}),
      ],
    ],
    [
      "a boundary with an unfinished search",
      [
        started(),
        ev("search_call_started", { callId: "s", query: "q", deferred: false }),
        ev("generation_boundary", {}),
      ],
    ],
    [
      "a malformed client call",
      [started(), ev("tool_call_delta", { index: 0, id: "t", name: "f", arguments: "[1]" })],
    ],
    [
      "tool_calls without client calls",
      [started(), ev("text_delta", { text: "x" }), completed("tool_calls")],
    ],
    [
      "pause without a paused search",
      [started(), ev("text_delta", { text: "x" }), completed("pause")],
    ],
    [
      "unsigned reasoning",
      [
        started(),
        ev("reasoning_delta", { text: "thought" }),
        ev("text_delta", { text: "x" }),
        completed(),
      ],
    ],
    [
      "mixed visible and redacted reasoning",
      [started(), ev("reasoning_delta", { text: "a" }), ev("reasoning_redacted", { data: "cmVk" })],
    ],
    ["events after completion", [started(), completed(), ev("text_delta", { text: "x" })]],
  ])("refuses %s", (_name, events) => {
    expect(() => collectMessages(events as CanonicalOutputEventV2[])).toThrow(HostedOutputError);
  });

  test("an omitted-prefix response refuses any reasoning event", () => {
    expect(() =>
      collectMessages([started(), ev("reasoning_delta", { text: "x" })], {
        outputReasoningOmitted: true,
      }),
    ).toThrow("omitting its conflict");
  });

  test("the JSON body reports encoder failures as 502", async () => {
    const response = anthropicHostedMessageResponse(
      { canonicalOutputVersion: 2, events: [started(), completed("tool_calls")] },
      "claude-opus-5-5",
    );
    expect(response.status).toBe(502);
    const incomplete = anthropicHostedMessageResponse(
      { canonicalOutputVersion: 2, events: [started(), ev("text_delta", { text: "x" })] },
      "claude-opus-5-5",
    );
    expect(incomplete.status).toBe(502);
  });
});

describe("Messages hosted SSE", () => {
  const options = (s: ReturnType<typeof signals>, finalize: () => void) => ({
    model: "claude-opus-5-5",
    inputTokens: 1,
    signals: s.value,
    finalize,
  });

  test.each([
    ["a malformed line", "not json\n", "Malformed upstream stream"],
    ["an incomplete stream", "", "ended before completion"],
  ])("ends with one error event for %s", async (_name, tail, message) => {
    const s = signals();
    let finalized = 0;
    const response = anthropicHostedSseAdapter(
      ndjson([started(), ev("text_delta", { text: "partial" })], tail),
      options(s, () => finalized++),
    );
    const events = sseData(await response.text());
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(JSON.stringify(events.at(-1))).toContain(message);
    expect(finalized).toBe(1);
  });

  test("a pipeline failure keeps its stream failure code", async () => {
    const s = signals();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify(started())}\n`));
        controller.error(new WebSearchError("full", "web_search_cache_full", 503));
      },
    });
    const response = anthropicHostedSseAdapter(
      new Response(body),
      options(s, () => {}),
    );
    const events = sseData(await response.text());
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { type: "overloaded_error", message: "Web search snapshot capacity is exhausted" },
    });
  });

  test("the deadline ends a waiting stream with one error event and pings while waiting", async () => {
    const s = signals();
    let finalized = 0;
    let push: ((line: string) => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (line) => controller.enqueue(new TextEncoder().encode(line));
      },
    });
    const response = anthropicHostedSseAdapter(new Response(body), {
      ...options(s, () => finalized++),
      pingIntervalMs: 5,
    });
    push?.(`${JSON.stringify(started())}\n`);
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const reading = (async () => {
      while (true) {
        const next = await reader?.read();
        if (!next || next.done) return;
        text += decoder.decode(next.value);
        if (text.includes("event: ping"))
          s.deadline.abort(new DOMException("late", "TimeoutError"));
      }
    })();
    await reading;
    expect(text).toContain("event: ping");
    expect(text.match(/event: error/g)).toHaveLength(1);
    expect(finalized).toBe(1);
  });

  test("a client that leaves receives nothing more and releases once", async () => {
    const s = signals();
    let finalized = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify(started())}\n`));
      },
    });
    const response = anthropicHostedSseAdapter(
      new Response(body),
      options(s, () => finalized++),
    );
    const reader = response.body?.getReader();
    await reader?.read();
    s.client.abort();
    const rest = await reader?.read();
    expect(rest?.done).toBe(true);
    expect(finalized).toBe(1);
    await reader?.cancel();
    expect(finalized).toBe(1);
  });
});

function bridge() {
  const result = createResponsesToolBridge(
    {
      model: "gpt-5.6-sol",
      input: [],
      stream: false,
      tools: [
        { type: "function", name: "lookup", description: "d", parameters: { type: "object" } },
        { type: "custom", name: "patch", description: "Apply a patch" },
      ],
    } as never,
    [],
    { stableAliases: true, allowHistoricalWithoutDeclarations: true },
  );
  if (!result.ok) throw new Error(result.message);
  return result.bridge;
}

function responsesOptions(overrides: Record<string, unknown> = {}) {
  return {
    model: "gpt-5.6-sol",
    bridge: bridge(),
    includeEncryptedReasoning: true,
    captureEncryptedReasoning: true,
    includeSources: false,
    ...overrides,
  };
}

const identity = {
  responseId: "resp_fixture",
  createdAt: 1,
  configuration: {
    instructions: null,
    maxOutputTokens: null,
    metadata: {},
    reasoningEffort: null,
    toolChoice: "auto" as const,
    tools: [],
  },
  usageMode: "compatible" as const,
};

describe("Responses hosted encoder", () => {
  test("custom tool calls, failed searches and summarized reasoning", () => {
    const customWire = bridge().declarations.find((tool) => tool.publicName === "patch")?.wireName;
    const state = hostedCompletedResponse(
      {
        canonicalOutputVersion: 2,
        events: [
          started("gpt-5.6-sol"),
          ev("reasoning_delta", { text: "think" }),
          ev("reasoning_delta", { text: "ing" }),
          ev("reasoning_encrypted", { encryptedContent: TOKEN_ONE }),
          ev("search_call_started", { callId: "ws_1", query: "q", deferred: false }),
          ev("search_call_failed", { callId: "ws_1", errorCode: "unavailable" }),
          ev("tool_call_delta", {
            index: 1,
            id: "call_custom",
            name: String(customWire),
            arguments: JSON.stringify({ input: "*** patch" }),
          }),
          completed("tool_calls", 0),
        ],
      },
      responsesOptions(),
      identity,
    );
    expect(state.output.map((item) => item.type)).toEqual([
      "reasoning",
      "web_search_call",
      "custom_tool_call",
    ]);
    expect(state.output[0]).toMatchObject({
      summary: [{ type: "summary_text", text: "thinking" }],
      encrypted_content: TOKEN_ONE,
    });
    expect(state.output[1]).toMatchObject({ status: "failed" });
    expect(state.output[2]).toMatchObject({ name: "patch", input: "*** patch" });
  });

  test("every item of a generation carries that generation's key", () => {
    const encoder = new HostedResponsesEncoder(responsesOptions(), () => {});
    for (const event of [
      started("gpt-5.6-sol"),
      ev("generation_started", { key: "aaaaaaaaaaaaaaaa" }),
      ev("reasoning_delta", { text: "..." }),
      ev("reasoning_encrypted", { encryptedContent: TOKEN_ONE }),
      ev("search_call_started", {
        callId: `ws_${"a".repeat(16)}${"1".repeat(16)}`,
        query: "q",
        deferred: false,
      }),
      ev("search_result", { callId: `ws_${"a".repeat(16)}${"1".repeat(16)}`, sources: [] }),
      ev("search_call_completed", { callId: `ws_${"a".repeat(16)}${"1".repeat(16)}` }),
      ev("generation_boundary", {}),
      ev("generation_started", { key: "bbbbbbbbbbbbbbbb" }),
      ev("text_delta", { text: "Done." }),
      completed("stop", 1),
    ]) {
      encoder.push(event);
    }
    expect(
      encoder.output.map((item) => [
        item.type,
        String(item.id).slice(0, String(item.id).indexOf("_") + 17),
      ]),
    ).toEqual([
      ["reasoning", "rs_aaaaaaaaaaaaaaaa"],
      ["web_search_call", "ws_aaaaaaaaaaaaaaaa"],
      ["message", "msg_bbbbbbbbbbbbbbbb"],
    ]);
  });

  test("reasoning without replay closes before output; late reasoning follows", () => {
    const events: Array<Record<string, unknown>> = [];
    const encoder = new HostedResponsesEncoder(
      responsesOptions({ includeEncryptedReasoning: false, captureEncryptedReasoning: false }),
      (create) => {
        events.push(create(events.length) as never);
      },
    );
    for (const event of [
      started("gpt-5.6-sol"),
      ev("reasoning_delta", { text: "early" }),
      ev("text_delta", { text: "Hello" }),
      ev("reasoning_delta", { text: "late" }),
      completed("stop", 0),
    ]) {
      encoder.push(event);
    }
    expect(encoder.output.map((item) => item.type)).toEqual(["reasoning", "message", "reasoning"]);
    const types = events.map((event) => event.type);
    expect(types.indexOf("response.output_item.done")).toBeLessThan(
      types.indexOf("response.output_text.delta"),
    );
  });

  test("late reasoning in a search generation is announced before the search", () => {
    const encoder = new HostedResponsesEncoder(responsesOptions(), () => {});
    for (const event of [
      started("gpt-5.6-sol"),
      ev("text_delta", { text: "Looking." }),
      ev("reasoning_delta", { text: "late" }),
      ev("reasoning_encrypted", { encryptedContent: TOKEN_ONE }),
      ev("search_call_started", { callId: "ws_1", query: "q", deferred: false }),
      ev("search_result", { callId: "ws_1", sources: [] }),
      ev("search_call_completed", { callId: "ws_1" }),
      ev("generation_boundary", {}),
      ev("reasoning_encrypted", { encryptedContent: TOKEN_TWO }),
      ev("text_delta", { text: "Done." }),
      completed(),
    ]) {
      encoder.push(event);
    }
    expect(encoder.output.map((item) => item.type)).toEqual([
      "message",
      "reasoning",
      "web_search_call",
      "message",
      "reasoning",
    ]);
    expect(encoder.output[1]).toMatchObject({ encrypted_content: TOKEN_ONE });
    expect(encoder.output[4]).toMatchObject({ encrypted_content: TOKEN_TWO });
  });

  test.each([
    ["a deferred search", [ev("search_call_started", { callId: "s", query: "q", deferred: true })]],
    ["a pause", [ev("text_delta", { text: "x" }), completed("pause")]],
    ["a result without a call", [ev("search_result", { callId: "s", sources: [] })]],
    [
      "a completion without a result",
      [
        ev("search_call_started", { callId: "s", query: "q", deferred: false }),
        ev("search_call_completed", { callId: "s" }),
      ],
    ],
    ["a failure without a call", [ev("search_call_failed", { callId: "s", errorCode: "x" })]],
    [
      "output after its group",
      [
        ev("search_call_started", { callId: "s", query: "q", deferred: false }),
        ev("text_delta", { text: "x" }),
      ],
    ],
    [
      "a repeated call identity",
      [
        ev("search_call_started", { callId: "s", query: "q", deferred: false }),
        ev("search_call_started", { callId: "s", query: "q", deferred: false }),
      ],
    ],
    [
      "an unfinished search",
      [ev("search_call_started", { callId: "s", query: "q", deferred: false }), completed()],
    ],
    [
      "a boundary after client calls",
      [
        ev("tool_call_delta", { index: 0, id: "c", name: "lookup", arguments: "{}" }),
        ev("generation_boundary", {}),
      ],
    ],
    ["a mismatched finish reason", [ev("text_delta", { text: "x" }), completed("tool_calls")]],
    [
      "an undeclared tool",
      [ev("tool_call_delta", { index: 0, id: "c", name: "nope", arguments: "{}" })],
    ],
    ["an anonymous tool", [ev("tool_call_delta", { index: 0, name: "lookup", arguments: "{}" })]],
  ])("refuses %s", (_name, events) => {
    const encoder = new HostedResponsesEncoder(responsesOptions(), () => {});
    encoder.push(started("gpt-5.6-sol"));
    expect(() => {
      for (const event of events as CanonicalOutputEventV2[]) encoder.push(event);
    }).toThrow(HostedResponsesOutputError);
  });

  test("refuses events before start, a second start and a foreign model", () => {
    const encoder = new HostedResponsesEncoder(responsesOptions(), () => {});
    expect(() => encoder.push(ev("text_delta", { text: "x" }))).toThrow(HostedResponsesOutputError);
    expect(() => encoder.push(started("claude-opus-5-5"))).toThrow(HostedResponsesOutputError);
    encoder.push(started("gpt-5.6-sol"));
    expect(() => encoder.push(started("gpt-5.6-sol"))).toThrow(HostedResponsesOutputError);
    encoder.push(completed("stop", 0));
    expect(() => encoder.push(ev("text_delta", { text: "x" }))).toThrow(HostedResponsesOutputError);
  });
});

describe("Responses hosted SSE", () => {
  const sseOptions = (
    s: ReturnType<typeof signals>,
    finalize: () => void,
    onCompleted?: () => void,
    overrides: Record<string, unknown> = {},
  ) => ({
    ...responsesOptions(overrides),
    ...identity,
    signals: s.value,
    finalize,
    ...(onCompleted ? { onCompleted } : {}),
  });

  test.each([
    ["a malformed line", "not json\n", "upstream_protocol_error"],
    ["an incomplete stream", "", "upstream_stream_incomplete"],
  ])("fails once for %s", async (_name, tail, code) => {
    const s = signals();
    let finalized = 0;
    const response = hostedResponsesSseAdapter(
      ndjson([started("gpt-5.6-sol"), ev("text_delta", { text: "partial" })], tail),
      sseOptions(s, () => finalized++),
    );
    const events = sseData(await response.text());
    expect(events.filter((event) => event.type === "response.failed")).toHaveLength(1);
    expect(
      ((events.at(-1)?.response as Record<string, unknown>).error as Record<string, unknown>).code,
    ).toBe(code);
    expect(finalized).toBe(1);
  });

  test("a store failure on completion replaces the terminal", async () => {
    const s = signals();
    const response = hostedResponsesSseAdapter(
      ndjson([started("gpt-5.6-sol"), ev("text_delta", { text: "x" }), completed("stop", 0)]),
      sseOptions(
        s,
        () => {},
        () => {
          throw new Error("disk full");
        },
      ),
    );
    const events = sseData(await response.text());
    expect(events.map((event) => event.type)).not.toContain("response.completed");
    expect(JSON.stringify(events.at(-1))).toContain("response_state_store_failed");
  });

  test("private replay tokens stay out of public events", async () => {
    const s = signals();
    let stored: unknown;
    const response = hostedResponsesSseAdapter(
      ndjson([
        started("gpt-5.6-sol"),
        ev("reasoning_delta", { text: "..." }),
        ev("reasoning_encrypted", { encryptedContent: TOKEN_ONE }),
        ev("text_delta", { text: "x" }),
        completed("stop", 0),
      ]),
      sseOptions(s, () => {}, undefined, { includeEncryptedReasoning: false }),
    );
    const text = await response.text();
    expect(text).not.toContain(TOKEN_ONE);
    const withStore = hostedResponsesSseAdapter(
      ndjson([
        started("gpt-5.6-sol"),
        ev("reasoning_delta", { text: "..." }),
        ev("reasoning_encrypted", { encryptedContent: TOKEN_ONE }),
        ev("text_delta", { text: "x" }),
        completed("stop", 0),
      ]),
      {
        ...sseOptions(signals(), () => {}, undefined, { includeEncryptedReasoning: false }),
        onCompleted: (state) => {
          stored = state;
        },
      },
    );
    expect(await withStore.text()).not.toContain(TOKEN_ONE);
    expect(JSON.stringify(stored)).toContain(TOKEN_ONE);
  });

  test("deadline and client aborts end a waiting stream once", async () => {
    for (const kind of ["deadline", "client"] as const) {
      const s = signals();
      let finalized = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(`${JSON.stringify(started("gpt-5.6-sol"))}\n`),
          );
        },
      });
      const response = hostedResponsesSseAdapter(
        new Response(body),
        sseOptions(s, () => finalized++),
      );
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const first = await reader?.read();
      text += decoder.decode(first?.value);
      const pending = reader?.read();
      if (kind === "deadline") s.deadline.abort(new DOMException("late", "TimeoutError"));
      else s.client.abort();
      while (true) {
        const next = await (pending ?? reader?.read());
        if (!next || next.done) break;
        text += decoder.decode(next.value);
        const more = await reader?.read();
        if (!more || more.done) break;
        text += decoder.decode(more.value);
      }
      expect(text.includes("response.failed")).toBe(kind === "deadline");
      expect(finalized).toBe(1);
    }
  });

  test("a consumer cancel releases once", async () => {
    const s = signals();
    let finalized = 0;
    const response = hostedResponsesSseAdapter(
      new Response(new ReadableStream<Uint8Array>({})),
      sseOptions(s, () => finalized++),
    );
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.cancel("gone");
    expect(finalized).toBe(1);
  });
});
