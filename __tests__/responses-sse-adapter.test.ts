import { describe, expect, test } from "bun:test";
import { parseResponsesRequest } from "../src/server/request-schema.js";
import { responsesToInternalChat } from "../src/server/responses/request-adapter.js";
import { responsesSseAdapter } from "../src/server/responses/sse-adapter.js";
import type { ResponsesToolBridge } from "../src/server/responses/tool-bridge.js";

type ParsedEvent = {
  readonly type: string;
  readonly sequenceNumber: number;
  readonly body: Readonly<Record<string, unknown>>;
};

type HarnessState = {
  cancelAttempts: unknown[];
  cancelReasons: unknown[];
  finalizeCount: number;
};

type IngressSignals = {
  readonly combined: AbortSignal;
  readonly deadline: AbortSignal;
  readonly client: AbortSignal;
};

type ControlledReadResult<T> =
  | { readonly done: false; readonly value: T }
  | { readonly done: true; readonly value: undefined };

type ResponsesSseAdapterWithSignals = (
  pipelineResponse: Response,
  options: {
    readonly model: string;
    readonly signals: IngressSignals;
    readonly finalize: () => void;
    readonly bridge?: ResponsesToolBridge;
  },
) => Response;

const responsesSseAdapterWithSignals = responsesSseAdapter as ResponsesSseAdapterWithSignals;

const encoder = new TextEncoder();

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolver: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolver = resolve;
  });
  if (!resolver) throw new TypeError("deferred resolver was not initialized");
  return { promise, resolve: resolver };
}

function deferredValue<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolver: ((value: T) => void) | undefined;
  let rejecter: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolver = resolve;
    rejecter = reject;
  });
  if (!resolver || !rejecter) throw new TypeError("deferred value was not initialized");
  return { promise, resolve: resolver, reject: rejecter };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TypeError(`Timed out waiting for ${label}`)), 250);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEvents(text: string): ParsedEvent[] {
  return text
    .split("\n\n")
    .filter((frame) => frame.length > 0)
    .map((frame) => {
      const lines = frame.split("\n");
      const eventLine = lines.find((line) => line.startsWith("event: "));
      const dataLine = lines.find((line) => line.startsWith("data: "));
      if (!eventLine || !dataLine) throw new TypeError("invalid SSE frame");
      const body: unknown = JSON.parse(dataLine.slice("data: ".length));
      if (
        !isRecord(body) ||
        typeof body.type !== "string" ||
        typeof body.sequence_number !== "number"
      ) {
        throw new TypeError("invalid Responses event");
      }
      expect(eventLine).toBe(`event: ${body.type}`);
      return {
        type: body.type,
        sequenceNumber: body.sequence_number,
        body,
      };
    });
}

function chunk(
  delta: Readonly<Record<string, unknown>>,
  finishReason: "stop" | "tool_calls" | null = null,
): string {
  const base = {
    id: "chatcmpl_test",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "gpt-5.6-sol",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (finishReason === null) return JSON.stringify(base);
  return JSON.stringify({
    ...base,
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });
}

function makeHarness(
  parts: readonly Uint8Array[],
  end: "abort" | "close" | "stall" | "error" = "close",
): {
  readonly response: Response;
  readonly state: HarnessState;
  readonly finalized: Promise<void>;
  readonly finalize: () => void;
} {
  const state: HarnessState = { cancelAttempts: [], cancelReasons: [], finalizeCount: 0 };
  const finalized = deferred();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      if (end === "close") controller.close();
      if (end === "error") controller.error(new TypeError("upstream read failed"));
      if (end === "abort") controller.error(new DOMException("deadline exceeded", "AbortError"));
    },
    cancel(reason) {
      state.cancelReasons.push(reason);
    },
  });
  const response = new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson" },
  });
  const body = response.body;
  if (!body) throw new TypeError("harness response has no body");
  const getReader = body.getReader.bind(body);
  Object.defineProperty(body, "getReader", {
    value() {
      const reader = getReader();
      const cancel = reader.cancel.bind(reader);
      Object.defineProperty(reader, "cancel", {
        value(reason?: unknown) {
          state.cancelAttempts.push(reason);
          return cancel(reason);
        },
      });
      return reader;
    },
  });
  return {
    response,
    state,
    finalized: finalized.promise,
    finalize() {
      state.finalizeCount += 1;
      finalized.resolve();
    },
  };
}

function makeControlledHarness(options: { readonly cancelThrows?: boolean } = {}): {
  readonly response: Response;
  readonly state: HarnessState & { readonly order: string[]; readCount: number };
  readonly finalized: Promise<void>;
  readonly readStarted: Promise<void>;
  readonly finalize: () => void;
  readonly resolveRead: (value: ControlledReadResult<Uint8Array>) => void;
  readonly rejectRead: (reason?: unknown) => void;
  readonly cleanup: () => Promise<void>;
} {
  const state = {
    cancelAttempts: [] as unknown[],
    cancelReasons: [] as unknown[],
    finalizeCount: 0,
    order: [] as string[],
    readCount: 0,
  };
  const finalized = deferred();
  const readStarted = deferred();
  const readResult = deferredValue<ControlledReadResult<Uint8Array>>();
  const response = new Response(new ReadableStream<Uint8Array>({}), {
    headers: { "Content-Type": "application/x-ndjson" },
  });
  const body = response.body;
  if (!body) throw new TypeError("controlled harness response has no body");
  const getReader = body.getReader.bind(body);
  let nativeCancel: ((reason?: unknown) => Promise<void>) | undefined;
  let readerCreated = false;
  Object.defineProperty(body, "getReader", {
    value() {
      if (readerCreated) throw new TypeError("controlled harness reader requested twice");
      readerCreated = true;
      const reader = getReader();
      nativeCancel = reader.cancel.bind(reader);
      Object.defineProperty(reader, "read", {
        value() {
          state.readCount += 1;
          readStarted.resolve();
          return readResult.promise;
        },
      });
      Object.defineProperty(reader, "cancel", {
        value(reason?: unknown) {
          state.cancelAttempts.push(reason);
          state.cancelReasons.push(reason);
          state.order.push("upstream-cancel");
          if (options.cancelThrows) throw new TypeError("synchronous reader.cancel failure");
          return nativeCancel?.(reason) ?? Promise.resolve();
        },
      });
      return reader;
    },
  });
  return {
    response,
    state,
    finalized: finalized.promise,
    readStarted: readStarted.promise,
    finalize() {
      state.finalizeCount += 1;
      state.order.push("finalize");
      finalized.resolve();
    },
    resolveRead: readResult.resolve,
    rejectRead: readResult.reject,
    async cleanup() {
      await nativeCancel?.("test cleanup").catch(() => undefined);
    },
  };
}

function ingressSignals(deadline: AbortController, client: AbortController): IngressSignals {
  return {
    combined: AbortSignal.any([deadline.signal, client.signal]),
    deadline: deadline.signal,
    client: client.signal,
  };
}

function activeIngressSignals(): IngressSignals {
  return ingressSignals(new AbortController(), new AbortController());
}

type AbortListenerProbe = {
  readonly addedCount: () => number;
  readonly removedCount: () => number;
  readonly activeCount: () => number;
  restore(): void;
};

type IngressSignalProbe = {
  readonly signals: IngressSignals;
  readonly deadline: AbortListenerProbe;
  readonly client: AbortListenerProbe;
  assertRemoved(): void;
  restore(): void;
};

function instrumentAbortListeners(signal: AbortSignal): AbortListenerProbe {
  const nativeAdd = signal.addEventListener.bind(signal);
  const nativeRemove = signal.removeEventListener.bind(signal);
  type AbortListener = Parameters<AbortSignal["addEventListener"]>[1];
  type AddArguments = Parameters<AbortSignal["addEventListener"]>;
  type RemoveArguments = Parameters<AbortSignal["removeEventListener"]>;
  const active = new Set<AbortListener>();
  let addedCount = 0;
  let removedCount = 0;

  Object.defineProperty(signal, "addEventListener", {
    configurable: true,
    value(...args: AddArguments): void {
      const [type, listener] = args;
      if (type === "abort" && listener !== null) {
        addedCount += 1;
        active.add(listener);
      }
      Reflect.apply(nativeAdd, signal, args);
    },
  });
  Object.defineProperty(signal, "removeEventListener", {
    configurable: true,
    value(...args: RemoveArguments): void {
      const [type, listener] = args;
      if (type === "abort" && listener !== null && active.delete(listener)) {
        removedCount += 1;
      }
      Reflect.apply(nativeRemove, signal, args);
    },
  });

  return {
    addedCount: () => addedCount,
    removedCount: () => removedCount,
    activeCount: () => active.size,
    restore() {
      Reflect.deleteProperty(signal, "addEventListener");
      Reflect.deleteProperty(signal, "removeEventListener");
    },
  };
}

function observeIngressSignals(
  deadline: AbortController,
  client: AbortController,
): IngressSignalProbe {
  const signals = ingressSignals(deadline, client);
  const deadlineProbe = instrumentAbortListeners(deadline.signal);
  const clientProbe = instrumentAbortListeners(client.signal);
  return {
    signals,
    deadline: deadlineProbe,
    client: clientProbe,
    assertRemoved() {
      expect({
        deadline: {
          added: deadlineProbe.addedCount(),
          removed: deadlineProbe.removedCount(),
          active: deadlineProbe.activeCount(),
        },
        client: {
          added: clientProbe.addedCount(),
          removed: clientProbe.removedCount(),
          active: clientProbe.activeCount(),
        },
      }).toEqual({
        deadline: { added: 1, removed: 1, active: 0 },
        client: { added: 1, removed: 1, active: 0 },
      });
    },
    restore() {
      deadlineProbe.restore();
      clientProbe.restore();
    },
  };
}

function adaptControlled(
  harness: ReturnType<typeof makeControlledHarness>,
  signals: IngressSignals,
): Response {
  return responsesSseAdapterWithSignals(harness.response, {
    model: "gpt-5.6-sol",
    signals,
    finalize: harness.finalize,
  });
}

function resolveTerminalChunk(harness: ReturnType<typeof makeControlledHarness>): void {
  harness.resolveRead({ done: false, value: encoder.encode(`${chunk({}, "stop")}\n`) });
}

function resolveLateTextAndToolChunk(harness: ReturnType<typeof makeControlledHarness>): void {
  const lateLines = [
    chunk({ content: "late text must not escape" }),
    chunk({
      tool_calls: [
        {
          index: 0,
          id: "call_late",
          type: "function",
          function: { name: "late_tool", arguments: '{"late":true}' },
        },
      ],
    }),
    chunk({}, "tool_calls"),
  ];
  harness.resolveRead({
    done: false,
    value: encoder.encode(`${lateLines.join("\n")}\n`),
  });
}

function bridgeFor(tools: readonly Record<string, unknown>[]): ResponsesToolBridge {
  const parsed = parseResponsesRequest({
    model: "gpt-5.6-sol",
    input: "run",
    tools,
  });
  if (!parsed.ok) throw new TypeError("Expected a valid bridge request");
  const adapted = responsesToInternalChat(parsed.value);
  if (!adapted.ok) throw new TypeError(`Expected a bridge, received ${adapted.code}`);
  return adapted.bridge;
}

async function adapt(
  harness: ReturnType<typeof makeHarness>,
  bridge?: ResponsesToolBridge,
): Promise<ParsedEvent[]> {
  const response = responsesSseAdapter(harness.response, {
    model: "gpt-5.6-sol",
    signals: activeIngressSignals(),
    finalize: harness.finalize,
    ...(bridge ? { bridge } : {}),
  });
  expect(response.headers.get("Content-Type")).toStartWith("text/event-stream");
  return parseEvents(await response.text());
}

function terminalTypes(events: readonly ParsedEvent[]): string[] {
  return events
    .map((event) => event.type)
    .filter((type) => type === "response.completed" || type === "response.failed");
}

function expectSingleFailureWithoutLateOutput(events: readonly ParsedEvent[]): void {
  expect(terminalTypes(events)).toEqual(["response.failed"]);
  expect(events.filter((event) => event.type === "response.output_text.delta")).toHaveLength(0);
  expect(
    events.filter(
      (event) =>
        event.type === "response.output_item.done" &&
        isRecord(event.body.item) &&
        (event.body.item.type === "function_call" || event.body.item.type === "custom_tool_call"),
    ),
  ).toHaveLength(0);
  expect(events.filter((event) => event.type === "response.completed")).toHaveLength(0);
}

describe("responsesSseAdapter", () => {
  test("emits a complete text response with added before delta and terminal usage", async () => {
    const input = `${chunk({ content: "Hel" })}\n${chunk({ content: "lo" })}\n${chunk({}, "stop")}\n`;
    const harness = makeHarness([encoder.encode(input)], "stall");

    const events = await adapt(harness);

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events.find((event) => event.type === "response.output_item.done")?.body).toMatchObject({
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello" }],
      },
    });
    expect(events.at(-1)?.body).toMatchObject({
      response: {
        status: "completed",
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      },
    });
    expect(events.at(-1)?.body).toHaveProperty("response.id", expect.stringMatching(/^resp_/));
    expect(events.map((event) => event.sequenceNumber)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(terminalTypes(events)).toEqual(["response.completed"]);
    expect(harness.state.cancelReasons).toHaveLength(1);
    expect(harness.state.finalizeCount).toBe(1);
  });

  test("does not synthesize completed when EOF arrives before a terminal chunk", async () => {
    const harness = makeHarness([encoder.encode(`${chunk({ content: "partial" })}\n`)]);

    const events = await adapt(harness);

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.failed",
    ]);
    expect(terminalTypes(events)).toEqual(["response.failed"]);
    expect(harness.state.finalizeCount).toBe(1);
  });

  test("aggregates split function calls into a standard added, arguments, done lifecycle", async () => {
    const lines = [
      chunk({
        tool_calls: [
          { index: 0, id: "call_1", type: "function", function: { name: "shell", arguments: "" } },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }),
      chunk({}, "tool_calls"),
    ].join("\n");

    const events = await adapt(makeHarness([encoder.encode(`${lines}\n`)], "stall"));

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events[1]?.body).toMatchObject({
      item: {
        type: "function_call",
        call_id: "call_1",
        name: "shell",
        arguments: "",
      },
    });
    expect(events[2]?.body).toMatchObject({
      delta: '{"command":"ls"}',
    });
    expect(events[3]?.body).toMatchObject({
      item: {
        type: "function_call",
        call_id: "call_1",
        name: "shell",
        arguments: '{"command":"ls"}',
        status: "completed",
      },
    });
  });

  test("normalizes a no-argument function call before streaming and replay", async () => {
    const lines = [
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_no_args",
            type: "function",
            function: { name: "list_resources", arguments: "" },
          },
        ],
      }),
      chunk({}, "tool_calls"),
    ].join("\n");

    const events = await adapt(makeHarness([encoder.encode(`${lines}\n`)], "stall"));

    expect(events[1]?.body).toMatchObject({
      item: {
        type: "function_call",
        call_id: "call_no_args",
        name: "list_resources",
        arguments: "",
      },
    });
    expect(events[2]?.body).toMatchObject({ delta: "{}" });
    expect(events[3]?.body).toMatchObject({
      item: {
        type: "function_call",
        call_id: "call_no_args",
        name: "list_resources",
        arguments: "{}",
        status: "completed",
      },
    });
    expect(events.at(-1)?.body).toMatchObject({
      response: {
        output: [
          {
            type: "function_call",
            call_id: "call_no_args",
            arguments: "{}",
            status: "completed",
          },
        ],
      },
    });
  });

  test("restores custom and namespaced tool calls before emitting done items", async () => {
    const bridge = bridgeFor([
      { type: "custom", name: "exec" },
      {
        type: "namespace",
        name: "collaboration",
        tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object" } }],
      },
    ]);
    const lines = [
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_exec",
            type: "function",
            function: { name: "kiro_custom_0", arguments: JSON.stringify({ input: "printf ok" }) },
          },
          {
            index: 1,
            id: "call_spawn",
            type: "function",
            function: { name: "kiro_ns_0", arguments: '{"task_name":"review"}' },
          },
        ],
      }),
      chunk({}, "tool_calls"),
    ].join("\n");

    const events = await adapt(makeHarness([encoder.encode(`${lines}\n`)], "stall"), bridge);
    const doneItems = events
      .filter((event) => event.type === "response.output_item.done")
      .map((event) => event.body.item);

    expect(doneItems).toEqual([
      {
        id: expect.any(String),
        type: "custom_tool_call",
        call_id: "call_exec",
        name: "exec",
        input: "printf ok",
        status: "completed",
      },
      {
        id: expect.any(String),
        type: "function_call",
        call_id: "call_spawn",
        namespace: "collaboration",
        name: "spawn_agent",
        arguments: '{"task_name":"review"}',
        status: "completed",
      },
    ]);
    expect(events.at(-1)?.body).toMatchObject({
      response: { output: doneItems },
    });
  });

  test("fails atomically when a valid call precedes an invalid custom wrapper", async () => {
    const bridge = bridgeFor([{ type: "custom", name: "exec" }]);
    const lines = [
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_plain",
            type: "function",
            function: { name: "plain", arguments: "{}" },
          },
          {
            index: 1,
            id: "call_exec",
            type: "function",
            function: { name: "kiro_custom_0", arguments: '{"input":1}' },
          },
        ],
      }),
      chunk({}, "tool_calls"),
    ].join("\n");

    const events = await adapt(makeHarness([encoder.encode(`${lines}\n`)], "stall"), bridge);

    expect(events.filter((event) => event.type === "response.output_item.done")).toHaveLength(0);
    expect(terminalTypes(events)).toEqual(["response.failed"]);
    expect(events.some((event) => event.type === "response.completed")).toBe(false);
    expect(events.at(-1)?.body).toMatchObject({
      response: { error: { code: "upstream_protocol_error" } },
    });
  });

  test("keeps tool-call id and name from the first fragment that provides them", async () => {
    const lines = [
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_first",
            type: "function",
            function: { name: "first", arguments: "{" },
          },
        ],
      }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_later",
            type: "function",
            function: { name: "later", arguments: "}" },
          },
        ],
      }),
      chunk({}, "tool_calls"),
    ].join("\n");

    const events = await adapt(makeHarness([encoder.encode(`${lines}\n`)], "stall"));

    expect(events.find((event) => event.type === "response.output_item.done")?.body).toMatchObject({
      item: { type: "function_call", call_id: "call_first", name: "first", arguments: "{}" },
    });
  });

  test("emits reasoning added, deltas, accumulated done, and item done in order", async () => {
    const input = `${chunk({ reasoning_content: "Plan " })}\n${chunk({ reasoning_content: "first" })}\n${chunk({}, "stop")}\n`;

    const events = await adapt(makeHarness([encoder.encode(input)], "stall"));

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events[4]?.body).toMatchObject({ text: "Plan first", summary_index: 0 });
    expect(events[5]?.body).toMatchObject({
      item: { type: "reasoning", summary: [{ type: "summary_text", text: "Plan first" }] },
    });
  });

  test("fails and cancels upstream on malformed NDJSON", async () => {
    const harness = makeHarness([encoder.encode("{not-json}\n")], "stall");

    const events = await adapt(harness);

    expect(terminalTypes(events)).toEqual(["response.failed"]);
    expect(events.some((event) => event.type === "response.completed")).toBe(false);
    expect(harness.state.cancelReasons).toHaveLength(1);
    expect(harness.state.finalizeCount).toBe(1);
  });

  test("fails and finalizes once when reader.read rejects", async () => {
    const harness = makeHarness([], "error");

    const events = await adapt(harness);

    expect(events.map((event) => event.type)).toEqual(["response.created", "response.failed"]);
    expect(harness.state.cancelAttempts).toHaveLength(1);
    expect(harness.state.cancelReasons).toHaveLength(0);
    expect(harness.state.finalizeCount).toBe(1);
  });

  test("fails, attempts wrapped cancellation, and finalizes once on deadline abort", async () => {
    const harness = makeHarness([], "abort");

    const events = await adapt(harness);

    expect(terminalTypes(events)).toEqual(["response.failed"]);
    expect(harness.state.cancelAttempts).toHaveLength(1);
    expect(harness.state.finalizeCount).toBe(1);
  });

  test("propagates downstream cancellation without a terminal event", async () => {
    const harness = makeHarness([encoder.encode(`${chunk({ content: "partial" })}\n`)], "stall");
    const response = responsesSseAdapter(harness.response, {
      model: "gpt-5.6-sol",
      signals: activeIngressSignals(),
      finalize: harness.finalize,
    });
    const reader = response.body?.getReader();
    if (!reader) throw new TypeError("adapter response has no body");

    const first = await reader.read();
    const observed = first.done ? [] : parseEvents(new TextDecoder().decode(first.value));
    await reader.cancel("consumer stopped");

    expect(terminalTypes(observed)).toEqual([]);
    expect(harness.state.cancelReasons).toEqual(["consumer stopped"]);
    expect(harness.state.finalizeCount).toBe(1);
  });

  test.each([
    ["two lines in one read", (text: string) => [encoder.encode(text)]],
    [
      "a line split across reads",
      (text: string) => [encoder.encode(text.slice(0, 41)), encoder.encode(text.slice(41))],
    ],
  ])("frames %s", async (_name, split) => {
    const input = `${chunk({ content: "framed" })}\n${chunk({}, "stop")}\n`;

    const events = await adapt(makeHarness(split(input), "stall"));

    expect(events.find((event) => event.type === "response.output_text.delta")?.body).toMatchObject(
      { delta: "framed" },
    );
    expect(terminalTypes(events)).toEqual(["response.completed"]);
  });

  test("preserves a UTF-8 code point split across byte reads", async () => {
    const bytes = encoder.encode(`${chunk({ content: "你" })}\n${chunk({}, "stop")}\n`);
    const utf8Start = bytes.indexOf(0xe4);
    expect(utf8Start).toBeGreaterThanOrEqual(0);

    const events = await adapt(
      makeHarness([bytes.slice(0, utf8Start + 1), bytes.slice(utf8Start + 1)], "stall"),
    );

    expect(events.find((event) => event.type === "response.output_text.delta")?.body).toMatchObject(
      { delta: "你" },
    );
  });

  test("parses an unterminated final NDJSON line", async () => {
    const input = `${chunk({ content: "final" })}\n${chunk({}, "stop")}`;

    const events = await adapt(makeHarness([encoder.encode(input)]));

    expect(terminalTypes(events)).toEqual(["response.completed"]);
    expect(events.find((event) => event.type === "response.output_item.done")?.body).toMatchObject({
      item: { content: [{ text: "final" }] },
    });
  });

  test("orders mixed reasoning, text, and multiple tool-call completion events", async () => {
    const lines = [
      chunk({ reasoning_content: "think " }),
      chunk({ reasoning_content: "carefully" }),
      chunk({ content: "answer " }),
      chunk({ content: "ready" }),
      chunk({
        tool_calls: [
          { index: 0, id: "call_a", type: "function", function: { name: "alpha", arguments: "{" } },
        ],
      }),
      chunk({
        tool_calls: [
          { index: 1, id: "call_b", type: "function", function: { name: "beta", arguments: "[" } },
        ],
      }),
      chunk({
        tool_calls: [
          { index: 0, function: { arguments: "}" } },
          { index: 1, function: { arguments: "]" } },
        ],
      }),
      chunk({}, "tool_calls"),
    ].join("\n");

    const events = await adapt(makeHarness([encoder.encode(`${lines}\n`)], "stall"));

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_item.done",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.output_item.done",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events[5]?.body).toMatchObject({ item: { type: "reasoning" } });
    expect(events[9]?.body).toMatchObject({ item: { type: "message" } });
    expect(events[12]?.body).toMatchObject({
      item: { type: "function_call", call_id: "call_a", name: "alpha", arguments: "{}" },
    });
    expect(events[15]?.body).toMatchObject({
      item: { type: "function_call", call_id: "call_b", name: "beta", arguments: "[]" },
    });
    expect(events.map((event) => event.sequenceNumber)).toEqual(
      events.map((_event, index) => index),
    );
  });

  test("defers reasoning that resumes after text so output items never overlap", async () => {
    const lines = [
      chunk({ reasoning_content: "first" }),
      chunk({ content: "answer " }),
      chunk({ reasoning_content: "later" }),
      chunk({ content: "done" }),
      chunk({}, "stop"),
    ].join("\n");

    const events = await adapt(makeHarness([encoder.encode(`${lines}\n`)], "stall"));
    const reasoningDone = events.filter(
      (event) =>
        event.type === "response.output_item.done" &&
        isRecord(event.body.item) &&
        event.body.item.type === "reasoning",
    );

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_item.done",
      "response.output_item.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(reasoningDone).toHaveLength(2);
    expect(reasoningDone[0]?.body).toMatchObject({
      output_index: 0,
      item: { type: "reasoning", summary: [{ type: "summary_text", text: "first" }] },
    });
    expect(reasoningDone[1]?.body).toMatchObject({
      output_index: 2,
      item: { type: "reasoning", summary: [{ type: "summary_text", text: "later" }] },
    });
    const firstReasoningItem = reasoningDone[0]?.body.item;
    const secondReasoningItem = reasoningDone[1]?.body.item;
    if (!isRecord(firstReasoningItem) || !isRecord(secondReasoningItem)) {
      throw new TypeError("reasoning done event omitted its item");
    }
    expect(firstReasoningItem.id).not.toBe(secondReasoningItem.id);
    expect(events.at(-1)?.body).toMatchObject({
      response: {
        output: [
          { type: "reasoning", summary: [{ text: "first" }] },
          { type: "message", content: [{ text: "answer done" }] },
          { type: "reasoning", summary: [{ text: "later" }] },
        ],
      },
    });
    expect(events.map((event) => event.sequenceNumber)).toEqual(
      events.map((_event, index) => index),
    );
  });

  test("keeps one Codex message active across text-reasoning-text Kiro ordering", async () => {
    const lines = [
      chunk({ content: "STREA" }),
      chunk({ reasoning_content: "late reasoning" }),
      chunk({ content: "M_ORDER_OK" }),
      chunk({}, "stop"),
    ].join("\n");

    const events = await adapt(makeHarness([encoder.encode(`${lines}\n`)], "stall"));

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_item.done",
      "response.output_item.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events[4]?.body).toMatchObject({
      output_index: 0,
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "STREAM_ORDER_OK" }],
      },
    });
    expect(events[8]?.body).toMatchObject({
      output_index: 1,
      item: {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "late reasoning" }],
      },
    });
    expect(events.at(-1)?.body).toMatchObject({
      response: {
        output: [
          { type: "message", content: [{ text: "STREAM_ORDER_OK" }] },
          { type: "reasoning", summary: [{ text: "late reasoning" }] },
        ],
      },
    });
  });

  test("releases the upstream slot before a client drains EOF after completed", async () => {
    const input = `${chunk({ content: "done" })}\n${chunk({}, "stop")}\n`;
    const harness = makeHarness([encoder.encode(input)], "stall");
    const response = responsesSseAdapter(harness.response, {
      model: "gpt-5.6-sol",
      signals: activeIngressSignals(),
      finalize: harness.finalize,
    });
    const reader = response.body?.getReader();
    if (!reader) throw new TypeError("adapter response has no body");
    let completedSeen = false;

    while (!completedSeen) {
      const next = await reader.read();
      if (next.done) throw new TypeError("stream ended before response.completed");
      completedSeen = parseEvents(new TextDecoder().decode(next.value)).some(
        (event) => event.type === "response.completed",
      );
    }
    await harness.finalized;

    expect(completedSeen).toBe(true);
    expect(harness.state.cancelReasons).toHaveLength(1);
    expect(harness.state.finalizeCount).toBe(1);
  });

  describe("Section 13 Responses SSE terminal state machine", () => {
    test("[Red item 5] already-aborted deadline wins over an already-aborted client at construction", async () => {
      const harness = makeControlledHarness();
      const deadline = new AbortController();
      const client = new AbortController();
      deadline.abort(new DOMException("deadline", "TimeoutError"));
      client.abort(new DOMException("client", "AbortError"));
      const signalProbe = observeIngressSignals(deadline, client);

      try {
        const response = adaptControlled(harness, signalProbe.signals);
        const text = response.text();
        resolveTerminalChunk(harness);
        const events = parseEvents(await within(text, "already-aborted deadline response"));

        expect(terminalTypes(events)).toEqual(["response.failed"]);
        expect(harness.state.finalizeCount).toBe(1);
        expect(harness.state.cancelAttempts).toHaveLength(1);
        signalProbe.assertRemoved();
      } finally {
        signalProbe.restore();
        await harness.cleanup();
      }
    });

    test("[Red item 5] already-aborted client is checked independently and emits no terminal frame", async () => {
      const harness = makeControlledHarness();
      const deadline = new AbortController();
      const client = new AbortController();
      client.abort(new DOMException("client", "AbortError"));
      const signalProbe = observeIngressSignals(deadline, client);

      try {
        const response = adaptControlled(harness, signalProbe.signals);
        const text = response.text();
        resolveTerminalChunk(harness);
        const events = parseEvents(await within(text, "already-aborted client response"));

        expect(terminalTypes(events)).toEqual([]);
        expect(harness.state.finalizeCount).toBe(1);
        expect(harness.state.cancelAttempts).toHaveLength(1);
        signalProbe.assertRemoved();
      } finally {
        signalProbe.restore();
        await harness.cleanup();
      }
    });

    test("[Red item 7] synchronous reader.cancel failure is contained after exactly-once finalize", async () => {
      const harness = makeControlledHarness({ cancelThrows: true });
      const deadline = new AbortController();
      const client = new AbortController();
      const signalProbe = observeIngressSignals(deadline, client);
      const response = adaptControlled(harness, signalProbe.signals);
      const reader = response.body?.getReader();
      if (!reader) throw new TypeError("adapter response has no body");
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);

      try {
        const first = await within(reader.read(), "created event");
        const events = first.done ? [] : parseEvents(new TextDecoder().decode(first.value));
        await within(harness.readStarted, "upstream read start");
        const cancelResult = await within(
          reader.cancel("consumer stopped").then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          ),
          "consumer cancellation",
        );
        await Promise.resolve();
        await Bun.sleep(0);

        expect(cancelResult).toEqual({ ok: true });
        expect(terminalTypes(events)).toEqual([]);
        expect(harness.state.order).toEqual(["finalize", "upstream-cancel"]);
        expect(harness.state.finalizeCount).toBe(1);
        expect(harness.state.cancelAttempts).toHaveLength(1);
        expect(unhandled).toEqual([]);
        signalProbe.assertRemoved();
      } finally {
        process.off("unhandledRejection", onUnhandled);
        signalProbe.restore();
        harness.resolveRead({ done: true, value: undefined });
        await harness.cleanup();
      }
    });

    test("terminal mapping attempts exactly one failed frame for an upstream rejection", async () => {
      const harness = makeControlledHarness();
      const deadline = new AbortController();
      const client = new AbortController();
      const signalProbe = observeIngressSignals(deadline, client);

      try {
        const text = adaptControlled(harness, signalProbe.signals).text();
        await within(harness.readStarted, "upstream rejection read start");
        harness.rejectRead(new TypeError("upstream rejected"));
        const events = parseEvents(await within(text, "upstream rejection response"));

        expect(terminalTypes(events)).toEqual(["response.failed"]);
        expect(harness.state.finalizeCount).toBe(1);
        expect(harness.state.cancelAttempts).toHaveLength(1);
        signalProbe.assertRemoved();
      } finally {
        signalProbe.restore();
        await harness.cleanup();
      }
    });

    test("terminal mapping attempts exactly one failed frame for a protocol failure", async () => {
      const harness = makeControlledHarness();
      const deadline = new AbortController();
      const client = new AbortController();
      const signalProbe = observeIngressSignals(deadline, client);

      try {
        const text = adaptControlled(harness, signalProbe.signals).text();
        await within(harness.readStarted, "protocol failure read start");
        harness.resolveRead({ done: false, value: encoder.encode("{malformed}\n") });
        const events = parseEvents(await within(text, "protocol failure response"));

        expect(terminalTypes(events)).toEqual(["response.failed"]);
        expect(harness.state.finalizeCount).toBe(1);
        expect(harness.state.cancelAttempts).toHaveLength(1);
        signalProbe.assertRemoved();
      } finally {
        signalProbe.restore();
        await harness.cleanup();
      }
    });

    test("terminal mapping attempts exactly one completed frame for normal completion", async () => {
      const harness = makeControlledHarness();
      const deadline = new AbortController();
      const client = new AbortController();
      const signalProbe = observeIngressSignals(deadline, client);

      try {
        const text = adaptControlled(harness, signalProbe.signals).text();
        await within(harness.readStarted, "normal completion read start");
        resolveTerminalChunk(harness);
        const events = parseEvents(await within(text, "normal completion response"));

        expect(terminalTypes(events)).toEqual(["response.completed"]);
        expect(harness.state.finalizeCount).toBe(1);
        expect(harness.state.cancelAttempts).toHaveLength(1);
        signalProbe.assertRemoved();
      } finally {
        signalProbe.restore();
        await harness.cleanup();
      }
    });

    test("terminal mapping emits no terminal frame for consumer cancellation", async () => {
      const harness = makeControlledHarness();
      const deadline = new AbortController();
      const client = new AbortController();
      const signalProbe = observeIngressSignals(deadline, client);
      const response = adaptControlled(harness, signalProbe.signals);
      const reader = response.body?.getReader();
      if (!reader) throw new TypeError("adapter response has no body");

      try {
        const first = await within(reader.read(), "created event before consumer cancellation");
        const events = first.done ? [] : parseEvents(new TextDecoder().decode(first.value));
        await within(harness.readStarted, "consumer cancellation read start");
        await within(reader.cancel("consumer stopped"), "consumer cancellation");

        expect(terminalTypes(events)).toEqual([]);
        expect(harness.state.finalizeCount).toBe(1);
        expect(harness.state.cancelAttempts).toHaveLength(1);
        signalProbe.assertRemoved();
      } finally {
        signalProbe.restore();
        harness.resolveRead({ done: true, value: undefined });
        await harness.cleanup();
      }
    });

    test("[item 10 classification] deadline wins before a pending read resolves late", async () => {
      const harness = makeControlledHarness();
      const deadline = new AbortController();
      const client = new AbortController();
      const signalProbe = observeIngressSignals(deadline, client);

      try {
        const text = adaptControlled(harness, signalProbe.signals).text();
        await within(harness.readStarted, "late-resolution read start");
        deadline.abort(new DOMException("deadline", "TimeoutError"));
        resolveLateTextAndToolChunk(harness);
        const events = parseEvents(await within(text, "deadline response before late resolution"));

        expectSingleFailureWithoutLateOutput(events);
        expect(harness.state.finalizeCount).toBe(1);
        expect(harness.state.cancelAttempts).toHaveLength(1);
        signalProbe.assertRemoved();
      } finally {
        signalProbe.restore();
        await harness.cleanup();
      }
    });

    test("[item 10 classification] client abort wins before a pending read rejects late", async () => {
      const harness = makeControlledHarness();
      const deadline = new AbortController();
      const client = new AbortController();
      const signalProbe = observeIngressSignals(deadline, client);
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);

      try {
        const text = adaptControlled(harness, signalProbe.signals).text();
        await within(harness.readStarted, "late-rejection read start");
        client.abort(new DOMException("client", "AbortError"));
        harness.rejectRead(new TypeError("late upstream rejection"));
        const events = parseEvents(
          await within(text, "client-abort response before late rejection"),
        );
        await Promise.resolve();
        await Bun.sleep(0);

        expect(terminalTypes(events)).toEqual([]);
        expect(harness.state.finalizeCount).toBe(1);
        expect(harness.state.cancelAttempts).toHaveLength(1);
        expect(unhandled).toEqual([]);
        signalProbe.assertRemoved();
      } finally {
        process.off("unhandledRejection", onUnhandled);
        signalProbe.restore();
        await harness.cleanup();
      }
    });

    test("[item 10 classification] resolve before abort preserves normal completion", async () => {
      const harness = makeControlledHarness();
      const deadline = new AbortController();
      const client = new AbortController();
      const signalProbe = observeIngressSignals(deadline, client);

      try {
        const text = adaptControlled(harness, signalProbe.signals).text();
        await within(harness.readStarted, "resolve-before-abort read start");
        resolveTerminalChunk(harness);
        await within(harness.finalized, "normal finalize before abort");
        deadline.abort(new DOMException("late deadline", "TimeoutError"));
        const events = parseEvents(await within(text, "resolve-before-abort response"));

        expect(terminalTypes(events)).toEqual(["response.completed"]);
        expect(harness.state.finalizeCount).toBe(1);
        expect(harness.state.cancelAttempts).toHaveLength(1);
        signalProbe.assertRemoved();
      } finally {
        signalProbe.restore();
        await harness.cleanup();
      }
    });

    test("[item 10 classification] abort before resolve preserves deadline failure", async () => {
      const harness = makeControlledHarness();
      const deadline = new AbortController();
      const client = new AbortController();
      const signalProbe = observeIngressSignals(deadline, client);

      try {
        const text = adaptControlled(harness, signalProbe.signals).text();
        await within(harness.readStarted, "abort-before-resolve read start");
        deadline.abort(new DOMException("deadline", "TimeoutError"));
        resolveLateTextAndToolChunk(harness);
        const events = parseEvents(await within(text, "abort-before-resolve response"));

        expectSingleFailureWithoutLateOutput(events);
        expect(harness.state.finalizeCount).toBe(1);
        expect(harness.state.cancelAttempts).toHaveLength(1);
        signalProbe.assertRemoved();
      } finally {
        signalProbe.restore();
        await harness.cleanup();
      }
    });

    test("[item 10 classification] deadline then explicit body cancel has no second terminal side effect", async () => {
      const harness = makeControlledHarness();
      const deadline = new AbortController();
      const client = new AbortController();
      const signalProbe = observeIngressSignals(deadline, client);
      const response = adaptControlled(harness, signalProbe.signals);
      const reader = response.body?.getReader();
      if (!reader) throw new TypeError("adapter response has no body");

      try {
        const first = await within(reader.read(), "created event before deadline cancellation");
        const events = first.done ? [] : parseEvents(new TextDecoder().decode(first.value));
        await within(harness.readStarted, "deadline cancellation read start");
        deadline.abort(new DOMException("deadline", "TimeoutError"));
        const deadlineFrame = await within(
          reader.read(),
          "deadline terminal frame before consumer cancellation",
        );
        if (!deadlineFrame.done) {
          events.push(...parseEvents(new TextDecoder().decode(deadlineFrame.value)));
        }
        expect(terminalTypes(events)).toEqual(["response.failed"]);
        expect(events.filter((event) => event.type === "response.completed")).toHaveLength(0);
        expect(harness.state.finalizeCount).toBe(1);
        expect(harness.state.cancelAttempts).toHaveLength(1);
        signalProbe.assertRemoved();
        const beforeLosingCancel = {
          finalizeCount: harness.state.finalizeCount,
          cancelAttempts: harness.state.cancelAttempts.length,
          order: [...harness.state.order],
          terminalTypes: terminalTypes(events),
        };
        await within(
          reader.cancel("consumer cancelled after deadline"),
          "post-deadline body cancellation",
        );
        const afterCancel = await within(
          reader.read(),
          "closed response after losing consumer cancellation",
        );
        if (!afterCancel.done) {
          events.push(...parseEvents(new TextDecoder().decode(afterCancel.value)));
        }
        expect(afterCancel.done).toBe(true);
        expect({
          finalizeCount: harness.state.finalizeCount,
          cancelAttempts: harness.state.cancelAttempts.length,
          order: [...harness.state.order],
          terminalTypes: terminalTypes(events),
        }).toEqual(beforeLosingCancel);
      } finally {
        signalProbe.restore();
        harness.resolveRead({ done: true, value: undefined });
        await harness.cleanup();
      }
    });
  });
});
