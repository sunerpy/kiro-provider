import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createConnection, type Socket } from "node:net";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import type {
  PipelineAccountManager,
  PipelineClientFactory,
  PipelineSdkClient,
  PipelineTokenRefresher,
} from "../src/core/pipeline.js";
import type {
  SdkStreamEvent,
  SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import * as serverApp from "../src/server/app.js";

const API_KEY = "sk-slow-reader";
const PAYLOAD_BYTES = 8 * 1024 * 1024;
const HEADER_BOUND_MS = 4_000;
const SOCKET_OBSERVATION_MS = 300;
const SOCKET_CLEANUP_WINDOW_MS = 1_000;
const MAX_HEADER_BYTES = 64 * 1024;

interface RequestIdleTimeoutLease {
  disable(): void;
  restore(): void;
}

type RequestIdleTimeoutLeaseMaker = (
  request: Request,
  server: Bun.Server<undefined>,
) => RequestIdleTimeoutLease | undefined;

type FutureAppDependencies = Parameters<typeof serverApp.createApp>[1] & {
  readonly createRequestIdleTimeoutLease?: RequestIdleTimeoutLeaseMaker;
};

type BuildServeOptions = (
  config: Config,
  dependencies: FutureAppDependencies,
) => Bun.Serve.Options<undefined>;

type CreateRequestIdleTimeoutLease = (
  request: Request,
  server: Bun.Server<undefined>,
) => RequestIdleTimeoutLease;

interface ServerInfrastructure {
  readonly buildServeOptions: BuildServeOptions;
  readonly createRequestIdleTimeoutLease: CreateRequestIdleTimeoutLease;
}

interface SocketLifecycle {
  ended: boolean;
  closed: boolean;
  errored: boolean;
  closedWithError: boolean;
}

interface SocketObservation {
  readonly windowMs: number;
  readonly ended: boolean;
  readonly closed: boolean;
  readonly errored: boolean;
  readonly closedWithError: boolean;
  readonly destroyed: boolean;
  readonly readableEnded: boolean;
  readonly writableEnded: boolean;
  readonly readyState: Socket["readyState"];
}

interface ArmResult {
  readonly headerElapsedMs: number;
  readonly statusLine: string;
  readonly contentType: string | undefined;
  readonly initialBodyBytes: number;
  readonly socket: SocketObservation;
}

interface TrackedSocket {
  readonly socket: Socket;
  readonly closed: Promise<void>;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function trackSocket(socket: Socket): TrackedSocket {
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  if (!resolveClosed) throw new TypeError("Socket close resolver was not initialized");
  socket.once("close", resolveClosed);
  return { socket, closed };
}

async function destroySocketAndWait(tracked: TrackedSocket): Promise<void> {
  if (!tracked.socket.destroyed) tracked.socket.destroy();
  await withTimeout(
    tracked.closed,
    SOCKET_CLEANUP_WINDOW_MS,
    "non-streaming raw TCP socket close cleanup",
  );
}

async function cleanupTrackedSockets(activeSockets: Set<TrackedSocket>): Promise<void> {
  const sockets = [...activeSockets];
  const results = await Promise.allSettled(sockets.map((tracked) => destroySocketAndWait(tracked)));
  for (const tracked of sockets) activeSockets.delete(tracked);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Raw TCP socket cleanup failed");
  }
}

function isBuildServeOptions(value: unknown): value is BuildServeOptions {
  return typeof value === "function";
}

function isCreateRequestIdleTimeoutLease(value: unknown): value is CreateRequestIdleTimeoutLease {
  return typeof value === "function";
}

function requireServerInfrastructure(): ServerInfrastructure {
  const buildServeOptions: unknown = Reflect.get(serverApp, "buildServeOptions");
  const createRequestIdleTimeoutLease: unknown = Reflect.get(
    serverApp,
    "createRequestIdleTimeoutLease",
  );
  const hasBuildServeOptions = isBuildServeOptions(buildServeOptions);
  const hasCreateRequestIdleTimeoutLease = isCreateRequestIdleTimeoutLease(
    createRequestIdleTimeoutLease,
  );
  const missing: string[] = [];
  if (!hasBuildServeOptions) missing.push("buildServeOptions");
  if (!hasCreateRequestIdleTimeoutLease) {
    missing.push("createRequestIdleTimeoutLease");
  }
  if (!hasBuildServeOptions || !hasCreateRequestIdleTimeoutLease) {
    throw new TypeError(
      `Section 13 server infrastructure missing from src/server/app.ts: ${missing.join(", ")}`,
    );
  }
  return { buildServeOptions, createRequestIdleTimeoutLease };
}

function testConfig(): Config {
  return ConfigSchema.parse({
    host: "127.0.0.1",
    port: 0,
    api_keys: [API_KEY],
    enable_legacy_chat_completions: true,
    request_timeout_ms: 10_000,
    stream_idle_timeout_ms: 10_000,
    max_request_body_bytes: 16_384,
  });
}

function account(): ManagedAccount {
  return {
    id: "slow-reader-account",
    email: "slow-reader@example.com",
    authMethod: "desktop",
    region: "us-east-1",
    refreshToken: "refresh-token",
    accessToken: "access-token",
    expiresAt: Date.now() + 3_600_000,
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

function sdkResponse(events: readonly SdkStreamEvent[]): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
        for (const event of events) yield event;
      },
    },
  };
}

function payloadClient(payload: () => string): PipelineSdkClient {
  return {
    async send(): Promise<SdkStreamResponse> {
      return sdkResponse([
        { assistantResponseEvent: { content: payload() } },
        {
          metadataEvent: {
            tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        },
      ]);
    },
  };
}

function startLoopbackServer(
  buildServeOptions: BuildServeOptions,
  config: Config,
  dependencies: FutureAppDependencies,
): ReturnType<typeof Bun.serve> {
  const options = buildServeOptions(config, dependencies);
  expect(options.hostname).toBe("127.0.0.1");
  expect(options.port).toBe(0);
  expect(Object.hasOwn(options, "idleTimeout")).toBe(false);
  return Bun.serve(options);
}

function serverPort(server: ReturnType<typeof Bun.serve>): number {
  const { port } = server;
  if (!Number.isInteger(port) || port === undefined || port <= 0) {
    throw new TypeError(`Bun server did not expose an ephemeral port: ${port}`);
  }
  return port;
}

function rawRequest(port: number): string {
  const body = JSON.stringify({
    model: "auto",
    messages: [{ role: "user", content: "return the deterministic payload" }],
    stream: false,
  });
  return [
    "POST /v1/chat/completions HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    `Authorization: Bearer ${API_KEY}`,
    "Content-Type: application/json",
    "Accept: application/json",
    "Connection: close",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n");
}

function parseHeaders(headerBytes: Buffer): {
  readonly statusLine: string;
  readonly headers: ReadonlyMap<string, string>;
} {
  const lines = headerBytes.toString("latin1").split("\r\n");
  const statusLine = lines.shift();
  if (!statusLine) throw new TypeError("HTTP response omitted its status line");
  const headers = new Map<string, string>();
  for (const line of lines) {
    if (line.length === 0) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new TypeError(`Malformed HTTP response header: ${line}`);
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    const previous = headers.get(name);
    headers.set(name, previous ? `${previous}, ${value}` : value);
  }
  return { statusLine, headers };
}

function readHeadersAndPause(
  socket: Socket,
  request: string,
): Promise<{
  readonly elapsedMs: number;
  readonly statusLine: string;
  readonly contentType: string | undefined;
  readonly initialBodyBytes: number;
}> {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onConnect = (): void => {
      socket.write(request, (error?: Error | null) => {
        if (error) fail(new Error(`Request write failed: ${error.message}`));
      });
    };
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const boundary = buffered.indexOf("\r\n\r\n");
      if (boundary < 0) {
        if (buffered.length > MAX_HEADER_BYTES) {
          fail(new Error("HTTP response headers exceeded 64 KiB"));
        }
        return;
      }
      settled = true;
      socket.pause();
      cleanup();
      try {
        const parsed = parseHeaders(buffered.subarray(0, boundary));
        resolve({
          elapsedMs: performance.now() - startedAt,
          statusLine: parsed.statusLine,
          contentType: parsed.headers.get("content-type"),
          initialBodyBytes: buffered.length - boundary - 4,
        });
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error: Error): void => {
      fail(new Error(`Socket failed before response headers: ${error.message}`));
    };
    const onClose = (): void => {
      fail(new Error("Socket closed before complete response headers arrived"));
    };
    const timer = setTimeout(
      () => fail(new Error(`Response headers were not received within ${HEADER_BOUND_MS}ms`)),
      HEADER_BOUND_MS,
    );
    socket.once("connect", onConnect);
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function observeSocket(socket: Socket, lifecycle: SocketLifecycle): Promise<SocketObservation> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        windowMs: SOCKET_OBSERVATION_MS,
        ended: lifecycle.ended,
        closed: lifecycle.closed,
        errored: lifecycle.errored,
        closedWithError: lifecycle.closedWithError,
        destroyed: socket.destroyed,
        readableEnded: socket.readableEnded,
        writableEnded: socket.writableEnded,
        readyState: socket.readyState,
      });
    }, SOCKET_OBSERVATION_MS);
  });
}

function connectionRemainedOpen(observation: SocketObservation): boolean {
  return (
    !observation.ended &&
    !observation.closed &&
    !observation.errored &&
    !observation.destroyed &&
    !observation.readableEnded
  );
}

async function runArm(
  server: ReturnType<typeof Bun.serve>,
  activeSockets: Set<TrackedSocket>,
): Promise<ArmResult> {
  const port = serverPort(server);
  const socket = createConnection({ host: "127.0.0.1", port });
  const trackedSocket = trackSocket(socket);
  activeSockets.add(trackedSocket);
  const lifecycle: SocketLifecycle = {
    ended: false,
    closed: false,
    errored: false,
    closedWithError: false,
  };
  socket.on("end", () => {
    lifecycle.ended = true;
  });
  socket.on("close", (hadError) => {
    lifecycle.closed = true;
    lifecycle.closedWithError = hadError;
  });
  socket.on("error", () => {
    lifecycle.errored = true;
  });
  try {
    const headers = await readHeadersAndPause(socket, rawRequest(port));
    const observation = await observeSocket(socket, lifecycle);
    return {
      headerElapsedMs: headers.elapsedMs,
      statusLine: headers.statusLine,
      contentType: headers.contentType,
      initialBodyBytes: headers.initialBodyBytes,
      socket: observation,
    };
  } finally {
    await destroySocketAndWait(trackedSocket);
    activeSockets.delete(trackedSocket);
  }
}

test("non-streaming slow readers preserve header progress and treatment restores its request lease", async () => {
  const servers: Array<ReturnType<typeof Bun.serve>> = [];
  const activeSockets = new Set<TrackedSocket>();
  let payload: string | undefined = "x".repeat(PAYLOAD_BYTES);
  let testFailure: unknown;
  let testFailed = false;
  try {
    const infrastructure = requireServerInfrastructure();
    const config = testConfig();
    const makeClient: PipelineClientFactory = () =>
      payloadClient(() => {
        if (payload === undefined) {
          throw new TypeError("Deterministic payload was released too early");
        }
        return payload;
      });
    const commonDependencies = {
      accountManager: new FakeAccountManager(),
      tokenRefresher: new FakeTokenRefresher(),
      makeClient,
    };
    const baselineDependencies: FutureAppDependencies = {
      ...commonDependencies,
      createRequestIdleTimeoutLease: () => undefined,
    };
    let disableCount = 0;
    let restoreCount = 0;
    const observedMaker: RequestIdleTimeoutLeaseMaker = (request, server) => {
      const real = infrastructure.createRequestIdleTimeoutLease(request, server);
      return {
        disable: () => {
          real.disable();
          disableCount += 1;
        },
        restore: () => {
          real.restore();
          restoreCount += 1;
        },
      };
    };
    const treatmentDependencies: FutureAppDependencies = {
      ...commonDependencies,
      createRequestIdleTimeoutLease: observedMaker,
    };

    const baselineServer = startLoopbackServer(
      infrastructure.buildServeOptions,
      config,
      baselineDependencies,
    );
    servers.push(baselineServer);
    const treatmentServer = startLoopbackServer(
      infrastructure.buildServeOptions,
      config,
      treatmentDependencies,
    );
    servers.push(treatmentServer);

    const baseline = await runArm(baselineServer, activeSockets);
    const treatment = await runArm(treatmentServer, activeSockets);

    expect(baseline.statusLine).toBe("HTTP/1.1 200 OK");
    expect(treatment.statusLine).toBe("HTTP/1.1 200 OK");
    expect(baseline.contentType).toContain("application/json");
    expect(treatment.contentType).toContain("application/json");
    expect(baseline.headerElapsedMs).toBeLessThanOrEqual(HEADER_BOUND_MS);
    expect(treatment.headerElapsedMs).toBeLessThanOrEqual(HEADER_BOUND_MS);
    expect(baseline.socket.windowMs).toBe(SOCKET_OBSERVATION_MS);
    expect(treatment.socket.windowMs).toBe(SOCKET_OBSERVATION_MS);

    const baselineRemainedOpen = connectionRemainedOpen(baseline.socket);
    const treatmentRemainedOpen = connectionRemainedOpen(treatment.socket);
    expect(treatmentRemainedOpen && !baselineRemainedOpen).toBe(false);
    expect(treatment.socket.errored && !baseline.socket.errored).toBe(false);

    expect(disableCount).toBe(1);
    expect(restoreCount).toBe(1);
  } catch (error) {
    testFailed = true;
    testFailure = error;
  }

  const cleanupResults = await Promise.allSettled([
    cleanupTrackedSockets(activeSockets),
    ...servers.map((server) => server.stop(true)),
  ]);
  payload = undefined;
  const cleanupFailures = cleanupResults.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (testFailed && cleanupFailures.length > 0) {
    throw new AggregateError(
      [testFailure, ...cleanupFailures],
      "Non-streaming raw TCP test and cleanup failed",
    );
  }
  if (testFailed) throw testFailure;
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "Non-streaming raw TCP test cleanup failed");
  }
}, 15_000);
