import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createConnection, type Socket } from "node:net";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import type {
  PipelineAccountManager,
  PipelineClientFactory,
  PipelineTokenRefresher,
} from "../src/core/pipeline.js";
import type {
  SdkStreamEvent,
  SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import type { AppDependencies } from "../src/server/app.js";
import * as appModule from "../src/server/app.js";

const HOST = "127.0.0.1";
const API_KEY = "sk-pipeline-slow-reader";
const REQUEST_TIMEOUT_MS = 400;
const STREAM_IDLE_TIMEOUT_MS = 5_000;
const FIRST_CHUNK_READ_TIMEOUT_MS = 1_000;
const QUEUED_REQUEST_DELAY_MS = 100;
const QUEUE_ACQUIRE_WINDOW_MS = 1_500;
const CLEANUP_WINDOW_MS = 1_500;
const SECOND_RESPONSE_WINDOW_MS = 1_000;
const SOCKET_OBSERVATION_WINDOW_MS = 200;
const SOCKET_CLEANUP_WINDOW_MS = 1_000;
const FILLER_EVENT_COUNT = 128;
const FILLER_TEXT = "x".repeat(256 * 1_024);
const ACCOUNT_EXPIRES_AT = 4_102_444_800_000;

type RequestIdleTimeoutLease = {
  disable(): void;
  restore(): void;
};

type RequestIdleTimeoutLeaseMaker = (
  request: Request,
  server: Bun.Server<undefined>,
) => RequestIdleTimeoutLease | undefined;

type LeaseAwareAppDependencies = AppDependencies & {
  readonly createRequestIdleTimeoutLease: RequestIdleTimeoutLeaseMaker;
};

type Section13Infrastructure = {
  readonly buildServeOptions: (
    config: Config,
    dependencies: LeaseAwareAppDependencies,
  ) => Bun.Serve.Options<undefined>;
  readonly createRequestIdleTimeoutLease: (
    request: Request,
    server: Bun.Server<undefined>,
  ) => RequestIdleTimeoutLease;
};

type Deferred = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

type SocketState = {
  readonly socket: Socket;
  readonly closedPromise: Promise<void>;
  closed: boolean;
  errored: boolean;
};

type ObservedPromise<T> = {
  readonly settlement: Promise<PromiseSettledResult<T>>;
};

type PausedResponse = {
  readonly statusLine: string;
  readonly headers: string;
  readonly firstChunk: Buffer;
};

type ArmKind = "baseline" | "treatment";

type ArmResult = {
  readonly kind: ArmKind;
  readonly statusLine: string;
  readonly headers: string;
  readonly firstChunk: string;
  readonly iteratorReturnCalls: number;
  readonly queueAcquireElapsedMs: number;
  readonly socketTerminatedDuringWindow: boolean;
  readonly socketErroredDuringWindow: boolean;
  readonly baselineSlowMakerCalls?: number;
  readonly treatmentDisableCount?: number;
  readonly treatmentRestoreCount?: number;
};

const activeServers = new Set<ReturnType<typeof Bun.serve>>();
const activeSockets = new Set<SocketState>();
const activeTimers = new Set<ReturnType<typeof setTimeout>>();

afterEach(async () => {
  try {
    await cleanupResources([...activeSockets], [...activeServers], []);
  } finally {
    for (const timer of activeTimers) clearTimeout(timer);
    activeTimers.clear();
  }
});

function deferred(): Deferred {
  let resolver: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolver = resolve;
  });
  if (!resolver) throw new TypeError("Deferred resolver was not initialized");
  return { promise, resolve: resolver };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isRequestIdleTimeoutLease(value: unknown): value is RequestIdleTimeoutLease {
  return (
    isRecord(value) &&
    typeof Reflect.get(value, "disable") === "function" &&
    typeof Reflect.get(value, "restore") === "function"
  );
}

function requireSection13Infrastructure(): Section13Infrastructure {
  const exports: object = appModule;
  const buildServeOptions = Reflect.get(exports, "buildServeOptions");
  const createRequestIdleTimeoutLease = Reflect.get(exports, "createRequestIdleTimeoutLease");
  const missing = [
    ...(typeof buildServeOptions === "function" ? [] : ["buildServeOptions"]),
    ...(typeof createRequestIdleTimeoutLease === "function"
      ? []
      : ["createRequestIdleTimeoutLease"]),
  ];
  if (missing.length > 0) {
    throw new TypeError(
      `Missing Section 13 production exports from src/server/app.ts: ${missing.join(", ")}`,
    );
  }

  return {
    buildServeOptions(config, dependencies) {
      const options: unknown = Reflect.apply(buildServeOptions, undefined, [config, dependencies]);
      if (!isRecord(options) || typeof Reflect.get(options, "fetch") !== "function") {
        throw new TypeError("buildServeOptions must return Bun serve options with a fetch handler");
      }
      return options as unknown as Bun.Serve.Options<undefined>;
    },
    createRequestIdleTimeoutLease(request, server) {
      const lease: unknown = Reflect.apply(createRequestIdleTimeoutLease, undefined, [
        request,
        server,
      ]);
      if (!isRequestIdleTimeoutLease(lease)) {
        throw new TypeError("createRequestIdleTimeoutLease must return a RequestIdleTimeoutLease");
      }
      return lease;
    },
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      activeTimers.delete(timer);
      reject(new Error(`${label} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    activeTimers.add(timer);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        activeTimers.delete(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        activeTimers.delete(timer);
        reject(error);
      },
    );
  });
}

function observePromise<T>(promise: Promise<T>): ObservedPromise<T> {
  return {
    settlement: promise.then(
      (value): PromiseFulfilledResult<T> => ({ status: "fulfilled", value }),
      (reason: unknown): PromiseRejectedResult => ({ status: "rejected", reason }),
    ),
  };
}

async function unwrapObserved<T>(observed: ObservedPromise<T>): Promise<T> {
  const result = await observed.settlement;
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

async function destroySocketAndWait(state: SocketState): Promise<void> {
  if (!state.closed) state.socket.destroy();
  await withTimeout(state.closedPromise, SOCKET_CLEANUP_WINDOW_MS, "raw TCP socket close cleanup");
  activeSockets.delete(state);
}

async function stopServerAndWait(server: ReturnType<typeof Bun.serve>): Promise<void> {
  try {
    await server.stop(true);
  } finally {
    activeServers.delete(server);
  }
}

async function cleanupResources(
  sockets: readonly SocketState[],
  servers: readonly ReturnType<typeof Bun.serve>[],
  observedPromises: readonly ObservedPromise<unknown>[],
): Promise<void> {
  const results = await Promise.allSettled([
    ...sockets.map((state) => destroySocketAndWait(state)),
    ...observedPromises.map((observed) => observed.settlement.then(() => undefined)),
    ...servers.map((server) => stopServerAndWait(server)),
  ]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Raw TCP test resource cleanup failed");
  }
}

function testConfig(): Config {
  return ConfigSchema.parse({
    host: HOST,
    port: 0,
    api_keys: [API_KEY],
    enable_legacy_chat_completions: true,
    request_timeout_ms: REQUEST_TIMEOUT_MS,
    stream_idle_timeout_ms: STREAM_IDLE_TIMEOUT_MS,
    max_request_body_bytes: 16_384,
  });
}

function account(): ManagedAccount {
  return {
    id: "slow-reader-account",
    email: "slow-reader@example.com",
    authMethod: "desktop",
    region: "us-east-1",
    refreshToken: "slow-reader-refresh-token",
    accessToken: "slow-reader-access-token",
    expiresAt: ACCOUNT_EXPIRES_AT,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
  };
}

class FakeAccountManager implements PipelineAccountManager {
  readonly selected = account();

  reconcileFromDb(): readonly ManagedAccount[] {
    return [this.selected];
  }

  selectHealthyAccount(): ManagedAccount {
    return this.selected;
  }

  getAccountCount(): number {
    return 1;
  }

  toAuthDetails(selected: ManagedAccount): KiroAuthDetails {
    return {
      refresh: selected.refreshToken,
      access: selected.accessToken,
      expires: selected.expiresAt,
      authMethod: selected.authMethod,
      region: selected.region,
    };
  }

  markRateLimited(): void {}

  markUnhealthy(): void {}
}

class FakeTokenRefresher implements PipelineTokenRefresher {
  async refreshIfNeeded(selected: ManagedAccount): Promise<ManagedAccount> {
    return selected;
  }

  async forceRefresh(selected: ManagedAccount): Promise<ManagedAccount> {
    return selected;
  }
}

function trackedBackpressuredResponse(): {
  readonly response: SdkStreamResponse;
  readonly state: { returnCalls: number; readonly returned: Promise<void> };
} {
  const returnedSignal = deferred();
  const state = { returnCalls: 0, returned: returnedSignal.promise };
  const firstEvent: SdkStreamEvent = {
    assistantResponseEvent: { content: "first slow-reader chunk" },
  };
  const fillerEvent: SdkStreamEvent = {
    assistantResponseEvent: { content: FILLER_TEXT },
  };

  return {
    state,
    response: {
      generateAssistantResponseResponse: {
        [Symbol.asyncIterator](): AsyncIterator<SdkStreamEvent> {
          let nextCalls = 0;
          let iteratorReturned = false;
          return {
            next(): Promise<IteratorResult<SdkStreamEvent>> {
              if (iteratorReturned) {
                return Promise.resolve({ done: true, value: undefined });
              }
              nextCalls += 1;
              if (nextCalls === 1) {
                return Promise.resolve({ done: false, value: firstEvent });
              }
              if (nextCalls <= FILLER_EVENT_COUNT + 1) {
                if (nextCalls === 2) {
                  return Bun.sleep(0).then(() => ({
                    done: false as const,
                    value: fillerEvent,
                  }));
                }
                return Promise.resolve({ done: false, value: fillerEvent });
              }
              return new Promise<IteratorResult<SdkStreamEvent>>(() => undefined);
            },
            return(): Promise<IteratorResult<SdkStreamEvent>> {
              iteratorReturned = true;
              state.returnCalls += 1;
              returnedSignal.resolve();
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      },
    },
  };
}

function finiteResponse(): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
        yield {
          assistantResponseEvent: { content: "queued request acquired pipeline" },
        };
        yield {
          metadataEvent: {
            tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        };
      },
    },
  };
}

function rawStreamingRequest(testRequest: "slow" | "queued"): string {
  const body = JSON.stringify({
    model: "auto",
    messages: [{ role: "user", content: testRequest }],
    stream: true,
  });
  return [
    "POST /v1/chat/completions HTTP/1.1",
    `Host: ${HOST}`,
    `Authorization: Bearer ${API_KEY}`,
    "Content-Type: application/json",
    "Accept: text/event-stream",
    "Connection: keep-alive",
    `X-Test-Request: ${testRequest}`,
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n");
}

function serverPort(server: ReturnType<typeof Bun.serve>): number {
  if (typeof server.port !== "number") {
    throw new TypeError("Loopback Bun server did not expose a TCP port");
  }
  return server.port;
}

async function openSocket(port: number): Promise<SocketState> {
  const socket = createConnection({ host: HOST, port });
  const closedSignal = deferred();
  const state: SocketState = {
    socket,
    closedPromise: closedSignal.promise,
    closed: false,
    errored: false,
  };
  activeSockets.add(state);
  socket.setNoDelay(true);
  socket.on("close", () => {
    state.closed = true;
    closedSignal.resolve();
  });
  socket.on("error", () => {
    state.errored = true;
  });
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const onConnect = (): void => {
          socket.off("error", onConnectError);
          resolve();
        };
        const onConnectError = (error: Error): void => {
          socket.off("connect", onConnect);
          reject(error);
        };
        socket.once("connect", onConnect);
        socket.once("error", onConnectError);
      }),
      FIRST_CHUNK_READ_TIMEOUT_MS,
      "loopback TCP connect",
    );
    return state;
  } catch (error) {
    await destroySocketAndWait(state);
    throw error;
  }
}

async function writeRequest(socket: Socket, request: string): Promise<void> {
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      socket.write(request, (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    }),
    FIRST_CHUNK_READ_TIMEOUT_MS,
    "raw HTTP request write",
  );
}

function readHeadersAndFirstChunk(socket: Socket): Promise<PausedResponse> {
  return withTimeout(
    new Promise<PausedResponse>((resolve, reject) => {
      let received = Buffer.alloc(0);
      const cleanup = (): void => {
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error("slow-reader socket closed before headers and one chunk"));
      };
      const onData = (chunk: Buffer): void => {
        received = Buffer.concat([received, chunk]);
        const headerEnd = received.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;

        const headers = received.subarray(0, headerEnd).toString("latin1");
        if (!/\r\ntransfer-encoding:\s*chunked\r\n/i.test(`\r\n${headers}\r\n`)) {
          cleanup();
          reject(
            new TypeError(
              "Expected Bun streaming response to use HTTP/1.1 chunked transfer encoding",
            ),
          );
          return;
        }

        const chunkSizeStart = headerEnd + 4;
        const chunkSizeEnd = received.indexOf("\r\n", chunkSizeStart);
        if (chunkSizeEnd < 0) return;
        const chunkSizeToken = received
          .subarray(chunkSizeStart, chunkSizeEnd)
          .toString("ascii")
          .split(";", 1)[0];
        const chunkSize = Number.parseInt(chunkSizeToken ?? "", 16);
        if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
          cleanup();
          reject(new TypeError(`Invalid first HTTP chunk size: ${chunkSizeToken}`));
          return;
        }
        const chunkStart = chunkSizeEnd + 2;
        const chunkEnd = chunkStart + chunkSize;
        if (received.length < chunkEnd + 2) return;
        if (received.subarray(chunkEnd, chunkEnd + 2).toString("ascii") !== "\r\n") {
          cleanup();
          reject(new TypeError("First HTTP chunk is missing its CRLF terminator"));
          return;
        }

        cleanup();
        socket.pause();
        resolve({
          statusLine: headers.split("\r\n", 1)[0] ?? "",
          headers,
          firstChunk: received.subarray(chunkStart, chunkEnd),
        });
      };
      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);
    }),
    FIRST_CHUNK_READ_TIMEOUT_MS,
    "slow-reader headers and first HTTP chunk",
  );
}

function readUntilText(socket: Socket, expected: string): Promise<string> {
  return withTimeout(
    new Promise<string>((resolve, reject) => {
      let received = "";
      const cleanup = (): void => {
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const onData = (chunk: Buffer): void => {
        received += chunk.toString("utf8");
        if (!received.includes(expected)) return;
        cleanup();
        socket.pause();
        resolve(received);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error(`Socket closed before receiving ${expected}`));
      };
      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);
    }),
    SECOND_RESPONSE_WINDOW_MS,
    `queued response containing ${expected}`,
  );
}

function makeDependencies(
  kind: ArmKind,
  infrastructure: Section13Infrastructure,
  sdk: ReturnType<typeof trackedBackpressuredResponse>,
  secondAcquired: Deferred,
  slowRestored: Deferred,
): {
  readonly dependencies: LeaseAwareAppDependencies;
  readonly counts: {
    baselineSlowMakerCalls: number;
    treatmentDisableCount: number;
    treatmentRestoreCount: number;
  };
} {
  let sendCalls = 0;
  const counts = {
    baselineSlowMakerCalls: 0,
    treatmentDisableCount: 0,
    treatmentRestoreCount: 0,
  };
  const makeClient: PipelineClientFactory = () => ({
    async send(): Promise<SdkStreamResponse> {
      sendCalls += 1;
      if (sendCalls === 1) return sdk.response;
      secondAcquired.resolve();
      return finiteResponse();
    },
  });

  const baselineMaker: RequestIdleTimeoutLeaseMaker = (request) => {
    if (request.headers.get("X-Test-Request") === "slow") {
      counts.baselineSlowMakerCalls += 1;
    }
    return undefined;
  };
  const treatmentMaker: RequestIdleTimeoutLeaseMaker = (request, server) => {
    const real = infrastructure.createRequestIdleTimeoutLease(request, server);
    const observed = request.headers.get("X-Test-Request") === "slow";
    return {
      disable(): void {
        real.disable();
        if (observed) counts.treatmentDisableCount += 1;
      },
      restore(): void {
        real.restore();
        if (observed) {
          counts.treatmentRestoreCount += 1;
          slowRestored.resolve();
        }
      },
    };
  };

  return {
    counts,
    dependencies: {
      accountManager: new FakeAccountManager(),
      tokenRefresher: new FakeTokenRefresher(),
      makeClient,
      createRequestIdleTimeoutLease: kind === "baseline" ? baselineMaker : treatmentMaker,
    },
  };
}

async function runArm(kind: ArmKind, infrastructure: Section13Infrastructure): Promise<ArmResult> {
  const sdk = trackedBackpressuredResponse();
  const secondAcquired = deferred();
  const slowRestored = deferred();
  const assembled = makeDependencies(kind, infrastructure, sdk, secondAcquired, slowRestored);
  const serveOptions = infrastructure.buildServeOptions(testConfig(), assembled.dependencies);
  if (Object.hasOwn(serveOptions, "idleTimeout")) {
    throw new TypeError(`${kind} buildServeOptions must omit Bun's global idleTimeout`);
  }
  const server = Bun.serve(serveOptions);
  activeServers.add(server);
  const port = serverPort(server);
  const armSockets: SocketState[] = [];
  const observedPromises: ObservedPromise<unknown>[] = [];

  try {
    const slowSocket = await openSocket(port);
    armSockets.push(slowSocket);
    const pausedResponsePromise = observePromise(readHeadersAndFirstChunk(slowSocket.socket));
    observedPromises.push(pausedResponsePromise);
    await writeRequest(slowSocket.socket, rawStreamingRequest("slow"));
    const pausedResponse = await unwrapObserved(pausedResponsePromise);

    await Bun.sleep(QUEUED_REQUEST_DELAY_MS);
    const queuedSocket = await openSocket(port);
    armSockets.push(queuedSocket);
    const queuedResponsePromise = observePromise(
      readUntilText(queuedSocket.socket, "data: [DONE]"),
    );
    observedPromises.push(queuedResponsePromise);
    const queueWaitStartedAt = performance.now();
    await writeRequest(queuedSocket.socket, rawStreamingRequest("queued"));
    await withTimeout(
      secondAcquired.promise,
      QUEUE_ACQUIRE_WINDOW_MS,
      `${kind} second request pipeline queue acquisition`,
    );
    const queueAcquireElapsedMs = performance.now() - queueWaitStartedAt;
    await unwrapObserved(queuedResponsePromise);

    await withTimeout(sdk.state.returned, CLEANUP_WINDOW_MS, `${kind} SDK iterator return cleanup`);
    if (kind === "treatment") {
      await withTimeout(
        slowRestored.promise,
        CLEANUP_WINDOW_MS,
        "treatment idle-timeout lease restoration",
      );
    }

    await Bun.sleep(SOCKET_OBSERVATION_WINDOW_MS);
    return {
      kind,
      statusLine: pausedResponse.statusLine,
      headers: pausedResponse.headers,
      firstChunk: pausedResponse.firstChunk.toString("utf8"),
      iteratorReturnCalls: sdk.state.returnCalls,
      queueAcquireElapsedMs,
      socketTerminatedDuringWindow:
        slowSocket.closed || slowSocket.errored || slowSocket.socket.destroyed,
      socketErroredDuringWindow: slowSocket.errored,
      ...(kind === "baseline"
        ? {
            baselineSlowMakerCalls: assembled.counts.baselineSlowMakerCalls,
          }
        : {
            treatmentDisableCount: assembled.counts.treatmentDisableCount,
            treatmentRestoreCount: assembled.counts.treatmentRestoreCount,
          }),
    };
  } finally {
    secondAcquired.resolve();
    slowRestored.resolve();
    await cleanupResources(armSockets, [server], observedPromises);
  }
}

function assertCommonApplicationBehavior(result: ArmResult): void {
  expect(result.statusLine).toStartWith("HTTP/1.1 200");
  expect(result.headers.toLowerCase()).toContain("content-type: text/event-stream");
  expect(result.firstChunk).toContain("data: ");
  expect(result.iteratorReturnCalls).toBe(1);
  expect(result.queueAcquireElapsedMs).toBeLessThan(QUEUE_ACQUIRE_WINDOW_MS);
}

describe("raw TCP streaming slow-reader application-resource release", () => {
  test("treatment preserves baseline socket behavior while releasing the queue, cleaning the iterator, and restoring its lease", async () => {
    const infrastructure = requireSection13Infrastructure();
    const baseline = await runArm("baseline", infrastructure);
    const treatment = await runArm("treatment", infrastructure);

    assertCommonApplicationBehavior(baseline);
    assertCommonApplicationBehavior(treatment);
    expect(baseline.baselineSlowMakerCalls).toBe(1);
    expect(treatment.treatmentDisableCount).toBe(1);
    expect(treatment.treatmentRestoreCount).toBe(1);

    if (baseline.socketTerminatedDuringWindow && !treatment.socketTerminatedDuringWindow) {
      throw new Error(
        `Treatment regressed finite-window socket behavior: ${JSON.stringify({
          baseline: {
            terminated: baseline.socketTerminatedDuringWindow,
            errored: baseline.socketErroredDuringWindow,
          },
          treatment: {
            terminated: treatment.socketTerminatedDuringWindow,
            errored: treatment.socketErroredDuringWindow,
          },
        })}`,
      );
    }
  }, 10_000);
});
