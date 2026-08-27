import { describe, expect, test } from "bun:test";
import type { ReadableStreamReadResult } from "node:stream/web";
import { createPipelineStreamResponse } from "../src/core/pipeline-stream.js";
import type {
  SdkStreamEvent,
  SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import { CANONICAL_OUTPUT_VERSION } from "../src/protocol/output.js";
import { canonicalOutputToChatSse } from "../src/server/chat-output.js";

const ASSERTION_BOUND_MS = 100;

type IngressSignals = {
  readonly combined: AbortSignal;
  readonly deadline: AbortSignal;
  readonly client: AbortSignal;
};

type FutureCanonicalToChatSse = (
  response: Response,
  signals: IngressSignals,
  finalize: () => void,
  options: { readonly expectedModel: string },
) => Response;

type Observation<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown }
  | { readonly status: "timeout" };

type ResponseBodyReader = {
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel(reason?: unknown): Promise<void>;
};

function canonicalToChatSseWithSignals(
  response: Response,
  signals: IngressSignals,
  finalize: () => void,
  expectedModel = "auto",
): Response {
  const futureCanonicalToChatSse = canonicalOutputToChatSse as FutureCanonicalToChatSse;
  return futureCanonicalToChatSse(
    response,
    signals,
    finalize,
    { expectedModel },
  );
}

function makeIngressSignals(deadline: AbortController, client: AbortController): IngressSignals {
  return {
    combined: AbortSignal.any([deadline.signal, client.signal]),
    deadline: deadline.signal,
    client: client.signal,
  };
}

function activeIngressSignals(): IngressSignals {
  return makeIngressSignals(new AbortController(), new AbortController());
}

async function observeWithin<T>(
  promise: Promise<T>,
  boundMs = ASSERTION_BOUND_MS,
): Promise<Observation<T>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then<Observation<T>, Observation<T>>(
        (value) => ({ status: "fulfilled", value }),
        (reason: unknown) => ({ status: "rejected", reason }),
      ),
      new Promise<Observation<T>>((resolve) => {
        timeout = setTimeout(() => resolve({ status: "timeout" }), boundMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function responseReader(response: Response): ResponseBodyReader {
  if (!response.body) throw new TypeError("stream response has no body");
  return response.body.getReader();
}

function decodedRead(result: ReadableStreamReadResult<Uint8Array>): string | undefined {
  return result.done ? undefined : new TextDecoder().decode(result.value);
}

function valueDeferred<T>(): {
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
  if (!resolver || !rejecter) throw new TypeError("value deferred was not initialized");
  return { promise, resolve: resolver, reject: rejecter };
}

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

function completedCanonicalStream(): Uint8Array {
  return new TextEncoder().encode(
    `${[
      {
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "started",
        conversationId: "controlled-conversation",
        model: "auto",
        createdAt: 1_700_000_000,
      },
      {
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "completed",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n")}\n`,
  );
}


function stalledSdkResponse(cleanup: Promise<void>): {
  readonly response: SdkStreamResponse;
  readonly state: { returnCalled: boolean };
} {
  const state = { returnCalled: false };
  const first: SdkStreamEvent = {
    assistantResponseEvent: { content: "partial" },
  };
  return {
    state,
    response: {
      generateAssistantResponseResponse: {
        [Symbol.asyncIterator](): AsyncIterator<SdkStreamEvent> {
          let emitted = false;
          return {
            next(): Promise<IteratorResult<SdkStreamEvent>> {
              if (!emitted) {
                emitted = true;
                return Promise.resolve({ done: false, value: first });
              }
              return new Promise<IteratorResult<SdkStreamEvent>>(() => undefined);
            },
            async return(): Promise<IteratorResult<SdkStreamEvent>> {
              state.returnCalled = true;
              await cleanup;
              return { done: true, value: undefined };
            },
          };
        },
      },
    },
  };
}

function failingSdkResponse(): {
  readonly response: SdkStreamResponse;
  readonly state: { returnCalled: boolean };
} {
  const state = { returnCalled: false };
  let emitted = false;
  return {
    state,
    response: {
      generateAssistantResponseResponse: {
        [Symbol.asyncIterator](): AsyncIterator<SdkStreamEvent> {
          return {
            next(): Promise<IteratorResult<SdkStreamEvent>> {
              if (!emitted) {
                emitted = true;
                return Promise.resolve({
                  done: false,
                  value: { assistantResponseEvent: { content: "partial" } },
                });
              }
              return Promise.reject(new Error("SDK stream failed"));
            },
            return(): Promise<IteratorResult<SdkStreamEvent>> {
              state.returnCalled = true;
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      },
    },
  };
}

function controlledUpstream(): {
  readonly response: Response;
  readonly read: ReturnType<typeof valueDeferred<ReadableStreamReadResult<Uint8Array>>>;
  readonly readStarted: ReturnType<typeof deferred>;
  readonly cancelCalled: ReturnType<typeof valueDeferred<unknown>>;
  readonly state: { readCalls: number; cancelCalls: number };
} {
  const read = valueDeferred<ReadableStreamReadResult<Uint8Array>>();
  const readStarted = deferred();
  const cancelCalled = valueDeferred<unknown>();
  const state = { readCalls: 0, cancelCalls: 0 };
  const upstream = new ReadableStream<Uint8Array>();
  Object.defineProperty(upstream, "getReader", {
    configurable: true,
    value: () => ({
      read(): Promise<ReadableStreamReadResult<Uint8Array>> {
        state.readCalls += 1;
        if (state.readCalls === 1) {
          readStarted.resolve();
          return read.promise;
        }
        return Promise.resolve({ done: true, value: undefined });
      },
      cancel(reason?: unknown): Promise<void> {
        state.cancelCalls += 1;
        if (state.cancelCalls === 1) cancelCalled.resolve(reason);
        return Promise.resolve();
      },
    }),
  });
  return {
    response: new Response(upstream, {
      headers: { "Content-Type": "application/x-ndjson" },
    }),
    read,
    readStarted,
    cancelCalled,
    state,
  };
}

function pendingPipelineSdkResponse(cleanup: Promise<void>): {
  readonly response: SdkStreamResponse;
  readonly pendingNext: ReturnType<typeof deferred>;
  readonly settlePendingNext: () => void;
  readonly returnAttempted: ReturnType<typeof deferred>;
  readonly state: { nextCalls: number; returnCalls: number };
} {
  const pendingNext = deferred();
  const pendingResult = valueDeferred<IteratorResult<SdkStreamEvent>>();
  const returnAttempted = deferred();
  const state = { nextCalls: 0, returnCalls: 0 };
  const first: SdkStreamEvent = {
    reasoningContentEvent: { text: "partial reasoning" },
  };
  return {
    state,
    pendingNext,
    settlePendingNext: () => pendingResult.resolve({ done: true, value: undefined }),
    returnAttempted,
    response: {
      generateAssistantResponseResponse: {
        [Symbol.asyncIterator](): AsyncIterator<SdkStreamEvent> {
          return {
            next(): Promise<IteratorResult<SdkStreamEvent>> {
              state.nextCalls += 1;
              if (state.nextCalls === 1) return Promise.resolve({ done: false, value: first });
              pendingNext.resolve();
              return pendingResult.promise;
            },
            async return(): Promise<IteratorResult<SdkStreamEvent>> {
              state.returnCalls += 1;
              returnAttempted.resolve();
              await cleanup;
              return { done: true, value: undefined };
            },
          };
        },
      },
    },
  };
}

describe("pipeline stream route framing", () => {
  test("cancels the upstream reader and finalizes when the downstream consumer cancels", async () => {
    let cancellationReason: unknown;
    let finalized = false;
    const upstream = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancellationReason = reason;
      },
    });
    const sse = canonicalToChatSseWithSignals(
      new Response(upstream, {
        headers: { "Content-Type": "application/x-ndjson" },
      }),
      activeIngressSignals(),
      () => {
        finalized = true;
      },
    );

    await sse.body?.cancel("consumer stopped");

    expect(cancellationReason).toBe("consumer stopped");
    expect(finalized).toBe(true);
  });

  test("emits an SSE error frame before stalled SDK cleanup completes", async () => {
    // Given
    const cleanup = deferred();
    const finalized = deferred();
    const sdk = stalledSdkResponse(cleanup.promise);
    const ndjson = createPipelineStreamResponse(
      {
        sdkResponse: sdk.response,
        model: "claude-opus-4-8",
        conversationId: "route-regression",
      },
      new AbortController().signal,
      15,
      finalized.resolve,
    );
    const sse = canonicalToChatSseWithSignals(
      ndjson,
      activeIngressSignals(),
      () => undefined,
      "claude-opus-4-8",
    );

    // When
    const receivedText = sse.text();
    const beforeCleanup = await Promise.race([
      receivedText.then((text) => ({ kind: "read" as const, text })),
      Bun.sleep(75).then(() => ({ kind: "pending" as const })),
    ]);
    cleanup.resolve();
    const received = await receivedText;
    await finalized.promise;

    // Then
    expect(sdk.state.returnCalled).toBe(true);
    expect(received).toStartWith("data: ");
    expect(received).toContain('data: {"error":');
    expect(received).not.toContain("data: [DONE]");
    expect(beforeCleanup.kind).toBe("read");
  });

  test("emits one SSE error frame and tears down the SDK iterator on a mid-stream error", async () => {
    // Given
    const sdk = failingSdkResponse();
    const ndjson = createPipelineStreamResponse(
      {
        sdkResponse: sdk.response,
        model: "claude-opus-4-8",
        conversationId: "route-mid-stream-error",
      },
      new AbortController().signal,
      1_000,
      () => undefined,
    );

    // When
    const received = await canonicalToChatSseWithSignals(
      ndjson,
      activeIngressSignals(),
      () => undefined,
      "claude-opus-4-8",
    ).text();
    const errorFrames = received.split("\n\n").filter((frame) => frame.includes('"error"'));

    // Then
    expect(errorFrames).toHaveLength(1);
    expect(received).not.toContain("data: [DONE]");
    expect(sdk.state.returnCalled).toBe(true);
  });

  test("[RED §13.6.4] aborts a pending pipeline next and finalizes before bounded iterator cleanup when pulling stops", async () => {
    const externalAbort = new AbortController();
    const cleanup = deferred();
    const finalized = deferred();
    const order: string[] = [];
    let finalizeCalls = 0;
    const sdk = pendingPipelineSdkResponse(cleanup.promise);
    const response = createPipelineStreamResponse(
      {
        sdkResponse: sdk.response,
        model: "claude-opus-4-8",
        conversationId: "pull-independent-abort",
      },
      externalAbort.signal,
      60_000,
      () => {
        finalizeCalls += 1;
        order.push("finalize");
        finalized.resolve();
      },
    );
    const reader = responseReader(response);

    const startedChunk = await observeWithin(reader.read());
    const firstChunk = await observeWithin(reader.read());
    const pendingRead = reader.read();
    const pendingStarted = await observeWithin(sdk.pendingNext.promise);
    externalAbort.abort(new DOMException("deadline", "TimeoutError"));
    const abortedRead = await observeWithin(pendingRead);
    const returnAttempted = await observeWithin(
      sdk.returnAttempted.promise.then(() => order.push("return")),
    );
    const finalizedBeforeCleanup = await observeWithin(finalized.promise);
    const orderBeforeCleanupRelease = [...order];

    cleanup.resolve();
    sdk.settlePendingNext();
    await observeWithin(reader.cancel("test cleanup"));

    expect(firstChunk.status).toBe("fulfilled");
    expect(startedChunk.status).toBe("fulfilled");
    if (startedChunk.status === "fulfilled") {
      expect(decodedRead(startedChunk.value)).toContain('"type":"started"');
    }
    if (firstChunk.status === "fulfilled") {
      expect(firstChunk.value.done).toBe(false);
    }
    expect(pendingStarted.status).toBe("fulfilled");
    expect(returnAttempted.status).toBe("fulfilled");
    expect(abortedRead.status).toBe("rejected");
    expect(finalizedBeforeCleanup.status).toBe("fulfilled");
    expect(orderBeforeCleanupRelease).toEqual(["finalize", "return"]);
    expect(sdk.state.returnCalls).toBe(1);
    expect(finalizeCalls).toBe(1);
  });

  test("[RED §13.6.5] already-aborted ingress signals use deadline precedence", async () => {
    const deadline = new AbortController();
    const client = new AbortController();
    const deadlineReason = new DOMException("deadline won", "TimeoutError");
    deadline.abort(deadlineReason);
    client.abort(new DOMException("client also aborted", "AbortError"));
    const upstream = controlledUpstream();
    let finalizeCalls = 0;
    const sse = canonicalToChatSseWithSignals(
      upstream.response,
      makeIngressSignals(deadline, client),
      () => {
        finalizeCalls += 1;
      },
    );
    const reader = responseReader(sse);

    const first = await observeWithin(reader.read());
    const cancellation = await observeWithin(upstream.cancelCalled.promise);
    await observeWithin(reader.cancel("test cleanup"));

    expect(first.status).toBe("fulfilled");
    if (first.status === "fulfilled") {
      expect(decodedRead(first.value)).toContain('"type":"upstream_error"');
    }
    expect(cancellation).toEqual({
      status: "fulfilled",
      value: deadlineReason,
    });
    expect(finalizeCalls).toBe(1);
  });

  test("[RED §13.6.5] an already-aborted client signal terminates without a frame", async () => {
    const deadline = new AbortController();
    const client = new AbortController();
    const clientReason = new DOMException("client left", "AbortError");
    client.abort(clientReason);
    const upstream = controlledUpstream();
    let finalizeCalls = 0;
    const reader = responseReader(
      canonicalToChatSseWithSignals(upstream.response, makeIngressSignals(deadline, client), () => {
        finalizeCalls += 1;
      }),
    );

    const first = await observeWithin(reader.read());
    const cancellation = await observeWithin(upstream.cancelCalled.promise);
    await observeWithin(reader.cancel("test cleanup"));

    expect(first.status).toBe("fulfilled");
    if (first.status === "fulfilled") expect(first.value.done).toBe(true);
    expect(cancellation).toEqual({
      status: "fulfilled",
      value: clientReason,
    });
    expect(finalizeCalls).toBe(1);
  });

  test("[RED §13.6.7] finalizes before a synchronously throwing reader.cancel and absorbs it", async () => {
    const order: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    const upstream = new ReadableStream<Uint8Array>();
    Object.defineProperty(upstream, "getReader", {
      configurable: true,
      value: () => ({
        read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
        cancel: () => {
          order.push("cancel");
          throw new Error("reader.cancel threw synchronously");
        },
      }),
    });
    const sse = canonicalToChatSseWithSignals(new Response(upstream), activeIngressSignals(), () =>
      order.push("finalize"),
    );
    if (!sse.body) throw new TypeError("SSE response has no body");

    process.on("unhandledRejection", onUnhandled);
    let cancellation: Observation<void>;
    try {
      cancellation = await observeWithin(sse.body.cancel("consumer stopped"));
      await Bun.sleep(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(cancellation.status).toBe("fulfilled");
    expect(order).toEqual(["finalize", "cancel"]);
    expect(unhandled).toEqual([]);
  });

  test("[RED reclassified §13.6.10a] deadline wins over a pending read that resolves late", async () => {
    const deadline = new AbortController();
    const client = new AbortController();
    const upstream = controlledUpstream();
    let finalizeCalls = 0;
    const reader = responseReader(
      canonicalToChatSseWithSignals(upstream.response, makeIngressSignals(deadline, client), () => {
        finalizeCalls += 1;
      }),
    );
    const firstRead = reader.read();
    const readStarted = await observeWithin(upstream.readStarted.promise);
    deadline.abort(new DOMException("deadline", "TimeoutError"));
    upstream.read.resolve({
      done: false,
      value: new TextEncoder().encode('{"late":true}\n'),
    });
    const first = await observeWithin(firstRead);
    const second = await observeWithin(reader.read());
    await observeWithin(reader.cancel("test cleanup"));

    expect(readStarted.status).toBe("fulfilled");
    expect(first.status).toBe("fulfilled");
    if (first.status === "fulfilled") {
      const text = decodedRead(first.value);
      expect(text).toContain('"type":"upstream_error"');
      expect(text).not.toContain('"late":true');
    }
    expect(second.status).toBe("fulfilled");
    if (second.status === "fulfilled") expect(second.value.done).toBe(true);
    expect(finalizeCalls).toBe(1);
  });

  test("[RED reclassified §13.6.10b] client abort wins over a pending read that rejects late", async () => {
    const deadline = new AbortController();
    const client = new AbortController();
    const upstream = controlledUpstream();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    let finalizeCalls = 0;
    const reader = responseReader(
      canonicalToChatSseWithSignals(upstream.response, makeIngressSignals(deadline, client), () => {
        finalizeCalls += 1;
      }),
    );
    const firstRead = reader.read();
    const readStarted = await observeWithin(upstream.readStarted.promise);

    process.on("unhandledRejection", onUnhandled);
    let first: Observation<ReadableStreamReadResult<Uint8Array>>;
    try {
      client.abort(new DOMException("client left", "AbortError"));
      upstream.read.reject(new Error("late upstream rejection"));
      first = await observeWithin(firstRead);
      await Bun.sleep(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await observeWithin(reader.cancel("test cleanup"));
    }

    expect(readStarted.status).toBe("fulfilled");
    expect(first.status).toBe("fulfilled");
    if (first.status === "fulfilled") expect(first.value.done).toBe(true);
    expect(finalizeCalls).toBe(1);
    expect(unhandled).toEqual([]);
  });

  test("[RED reclassified §13.6.10c] resolve and deadline orderings are each first-terminal-wins", async () => {
    const resolvedFirstDeadline = new AbortController();
    const resolvedFirstClient = new AbortController();
    const resolvedFirstUpstream = controlledUpstream();
    let resolvedFirstFinalizeCalls = 0;
    const resolvedFirstReader = responseReader(
      canonicalToChatSseWithSignals(
        resolvedFirstUpstream.response,
        makeIngressSignals(resolvedFirstDeadline, resolvedFirstClient),
        () => {
          resolvedFirstFinalizeCalls += 1;
        },
      ),
    );
    const resolvedFirstRead = resolvedFirstReader.read();
    const resolvedFirstStarted = await observeWithin(resolvedFirstUpstream.readStarted.promise);
    resolvedFirstUpstream.read.resolve({
      done: false,
      value: completedCanonicalStream(),
    });
    const resolvedFirstFrame = await observeWithin(resolvedFirstRead);
    const resolvedFirstDone = await observeWithin(resolvedFirstReader.read());
    const resolvedFirstEnd = await observeWithin(resolvedFirstReader.read());
    resolvedFirstDeadline.abort(new DOMException("too late", "TimeoutError"));
    await observeWithin(resolvedFirstReader.cancel("test cleanup"));

    const abortedFirstDeadline = new AbortController();
    const abortedFirstClient = new AbortController();
    const abortedFirstUpstream = controlledUpstream();
    let abortedFirstFinalizeCalls = 0;
    const abortedFirstReader = responseReader(
      canonicalToChatSseWithSignals(
        abortedFirstUpstream.response,
        makeIngressSignals(abortedFirstDeadline, abortedFirstClient),
        () => {
          abortedFirstFinalizeCalls += 1;
        },
      ),
    );
    const abortedFirstRead = abortedFirstReader.read();
    const abortedFirstStarted = await observeWithin(abortedFirstUpstream.readStarted.promise);
    abortedFirstDeadline.abort(new DOMException("deadline", "TimeoutError"));
    abortedFirstUpstream.read.resolve({ done: true, value: undefined });
    const abortedFirstFrame = await observeWithin(abortedFirstRead);
    const abortedFirstEnd = await observeWithin(abortedFirstReader.read());
    await observeWithin(abortedFirstReader.cancel("test cleanup"));

    expect(resolvedFirstStarted.status).toBe("fulfilled");
    expect(resolvedFirstFrame.status).toBe("fulfilled");
    if (resolvedFirstFrame.status === "fulfilled") {
      expect(decodedRead(resolvedFirstFrame.value)).toContain('"finish_reason":"stop"');
    }
    expect(resolvedFirstEnd.status).toBe("fulfilled");
    if (resolvedFirstEnd.status === "fulfilled") expect(resolvedFirstEnd.value.done).toBe(true);
    expect(resolvedFirstFinalizeCalls).toBe(1);
    expect(resolvedFirstDone.status).toBe("fulfilled");
    if (resolvedFirstDone.status === "fulfilled") {
      expect(decodedRead(resolvedFirstDone.value)).toBe("data: [DONE]\n\n");
    }

    expect(abortedFirstStarted.status).toBe("fulfilled");
    expect(abortedFirstFrame.status).toBe("fulfilled");
    if (abortedFirstFrame.status === "fulfilled") {
      expect(decodedRead(abortedFirstFrame.value)).toContain('"type":"upstream_error"');
    }
    expect(abortedFirstEnd.status).toBe("fulfilled");
    if (abortedFirstEnd.status === "fulfilled") expect(abortedFirstEnd.value.done).toBe(true);
    expect(abortedFirstFinalizeCalls).toBe(1);
  });

  test("[RED reclassified §13.6.10d] deadline remains terminal when the consumer cancels afterward", async () => {
    const deadline = new AbortController();
    const client = new AbortController();
    const deadlineReason = new DOMException("deadline", "TimeoutError");
    const upstream = controlledUpstream();
    let finalizeCalls = 0;
    const reader = responseReader(
      canonicalToChatSseWithSignals(upstream.response, makeIngressSignals(deadline, client), () => {
        finalizeCalls += 1;
      }),
    );
    const outputRead = reader.read();
    const readStarted = await observeWithin(upstream.readStarted.promise);
    deadline.abort(deadlineReason);
    const consumerCancel = await observeWithin(reader.cancel("consumer canceled after deadline"));
    upstream.read.resolve({ done: true, value: undefined });
    const output = await observeWithin(outputRead);
    const upstreamCancel = await observeWithin(upstream.cancelCalled.promise);

    expect(readStarted.status).toBe("fulfilled");
    expect(consumerCancel.status).toBe("fulfilled");
    expect(output.status).toBe("fulfilled");
    expect(upstreamCancel).toEqual({
      status: "fulfilled",
      value: deadlineReason,
    });
    expect(upstream.state.cancelCalls).toBe(1);
    expect(finalizeCalls).toBe(1);
  });
});
