import { describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import type {
  PipelineAccountManager,
  PipelineClientFactory,
  PipelineTokenRefresher,
  RunChatCompletionOptions,
} from "../src/core/pipeline.js";
import type {
  SdkStreamEvent,
  SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import * as appModule from "../src/server/app.js";
import { type AppDependencies, createApp } from "../src/server/app.js";
import { handleChatCompletions } from "../src/server/routes/chat-completions.js";
import { handleResponses } from "../src/server/routes/responses.js";

const API_KEY = "sk-request-timeout-lease";
const AUTHORIZATION = { Authorization: `Bearer ${API_KEY}` };

type RequestIdleTimeoutLease = {
  disable(): void;
  restore(): void;
};

type RequestIdleTimeoutLeaseMaker = (
  request: Request,
  server: Bun.Server<undefined>,
) => RequestIdleTimeoutLease | undefined;

type RequiredRequestIdleTimeoutLeaseMaker = (
  request: Request,
  server: Bun.Server<undefined>,
) => RequestIdleTimeoutLease;

type LeaseEnabledDependencies = AppDependencies & {
  readonly createRequestIdleTimeoutLease?: RequestIdleTimeoutLeaseMaker;
};

type RouteOwnershipDependencies = {
  readonly accountManager: PipelineAccountManager;
  readonly tokenRefresher: PipelineTokenRefresher;
  readonly makeClient?: PipelineClientFactory;
  readonly createRequestIdleTimeoutLease?: () => RequestIdleTimeoutLease | undefined;
  readonly runPipeline?: (options: RunChatCompletionOptions) => Promise<Response>;
};

type TimeoutCall = {
  readonly request: Request;
  readonly seconds: number;
};

function isRequestIdleTimeoutLease(value: unknown): value is RequestIdleTimeoutLease {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "disable") === "function" &&
    typeof Reflect.get(value, "restore") === "function"
  );
}

function requireLeaseExports(): {
  readonly createRequestIdleTimeoutLease: RequiredRequestIdleTimeoutLeaseMaker;
  readonly RESTORED_IDLE_TIMEOUT_SECONDS: number;
} {
  const exports: object = appModule;
  const maker = Reflect.get(exports, "createRequestIdleTimeoutLease");
  const restoredSeconds = Reflect.get(exports, "RESTORED_IDLE_TIMEOUT_SECONDS");
  if (typeof maker !== "function") {
    throw new TypeError(
      "Missing production export createRequestIdleTimeoutLease from src/server/app.ts",
    );
  }
  if (typeof restoredSeconds !== "number") {
    throw new TypeError(
      "Missing production export RESTORED_IDLE_TIMEOUT_SECONDS from src/server/app.ts",
    );
  }
  return {
    createRequestIdleTimeoutLease(request, server) {
      const lease: unknown = Reflect.apply(maker, undefined, [request, server]);
      if (!isRequestIdleTimeoutLease(lease)) {
        throw new TypeError("createRequestIdleTimeoutLease must return a RequestIdleTimeoutLease");
      }
      return lease;
    },
    RESTORED_IDLE_TIMEOUT_SECONDS: restoredSeconds,
  };
}

function fakeBunServer(calls: TimeoutCall[]): Bun.Server<undefined> {
  const server = {
    timeout(request: Request, seconds: number): void {
      calls.push({ request, seconds });
    },
  } satisfies Pick<Bun.Server<undefined>, "timeout">;
  return server as unknown as Bun.Server<undefined>;
}

function testConfig(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    api_keys: [API_KEY],
    enable_legacy_chat_completions: true,
    request_timeout_ms: 1_000,
    stream_idle_timeout_ms: 1_000,
    max_request_body_bytes: 16_384,
    ...overrides,
  });
}

function account(): ManagedAccount {
  return {
    id: "lease-test-account",
    email: "lease-test@example.com",
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

function localClientFactory(events?: string[]): PipelineClientFactory {
  return () => ({
    async send(): Promise<SdkStreamResponse> {
      events?.push("pipeline");
      return sdkResponse([{ assistantResponseEvent: { content: "local deterministic answer" } }]);
    },
  });
}

function dependencies(
  maker?: RequestIdleTimeoutLeaseMaker,
  events?: string[],
): LeaseEnabledDependencies {
  return {
    accountManager: new FakeAccountManager(),
    tokenRefresher: new FakeTokenRefresher(),
    makeClient: localClientFactory(events),
    ...(maker ? { createRequestIdleTimeoutLease: maker } : {}),
  };
}

function chatRequest(
  options: { readonly authorized?: boolean; readonly body?: string } = {},
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.authorized !== false) headers.set("Authorization", AUTHORIZATION.Authorization);
  return new Request("http://test/v1/chat/completions", {
    method: "POST",
    headers,
    body:
      options.body ??
      JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
  });
}

function responsesRequest(body?: string): Request {
  return new Request("http://test/v1/responses", {
    method: "POST",
    headers: { ...AUTHORIZATION, "Content-Type": "application/json" },
    body:
      body ??
      JSON.stringify({
        model: "gpt-5.6-sol",
        input: "hello",
        stream: false,
      }),
  });
}

async function invokeWithServer(
  app: ReturnType<typeof createApp>,
  request: Request,
  server: Bun.Server<undefined>,
): Promise<Response> {
  const result: unknown = Reflect.apply(app, undefined, [request, server]);
  const response: unknown = await Promise.resolve(result);
  if (!(response instanceof Response)) {
    throw new TypeError("createApp fetch handler must resolve to a Response");
  }
  return response;
}

async function consume(response: Response): Promise<string> {
  return response.text();
}

describe("RequestIdleTimeoutLease state machine (Group A Red)", () => {
  test("disable is idempotent and calls server.timeout(request, 0) exactly once", () => {
    const { createRequestIdleTimeoutLease } = requireLeaseExports();
    const calls: TimeoutCall[] = [];
    const request = new Request("http://test/lease-disable");
    const lease = createRequestIdleTimeoutLease(request, fakeBunServer(calls));

    lease.disable();
    lease.disable();

    expect(calls).toEqual([{ request, seconds: 0 }]);
  });

  test("restore is idempotent and restores the project idle-timeout policy exactly once", () => {
    const { createRequestIdleTimeoutLease, RESTORED_IDLE_TIMEOUT_SECONDS } = requireLeaseExports();
    const calls: TimeoutCall[] = [];
    const request = new Request("http://test/lease-restore");
    const lease = createRequestIdleTimeoutLease(request, fakeBunServer(calls));

    lease.disable();
    lease.restore();
    lease.restore();

    expect(RESTORED_IDLE_TIMEOUT_SECONDS).toBe(10);
    expect(calls).toEqual([
      { request, seconds: 0 },
      { request, seconds: RESTORED_IDLE_TIMEOUT_SECONDS },
    ]);
  });

  test("restore before disable is a no-op and does not consume the later lifecycle", () => {
    const { createRequestIdleTimeoutLease, RESTORED_IDLE_TIMEOUT_SECONDS } = requireLeaseExports();
    const calls: TimeoutCall[] = [];
    const request = new Request("http://test/lease-early-restore");
    const lease = createRequestIdleTimeoutLease(request, fakeBunServer(calls));

    lease.restore();
    expect(calls).toEqual([]);
    lease.disable();
    lease.restore();

    expect(calls).toEqual([
      { request, seconds: 0 },
      { request, seconds: RESTORED_IDLE_TIMEOUT_SECONDS },
    ]);
  });
});

describe("createApp lease-maker selection (Group A Red)", () => {
  test("an omitted maker uses the real lease implementation with Bun's request-scoped server", async () => {
    const calls: TimeoutCall[] = [];
    const request = chatRequest();
    const app = createApp(testConfig(), dependencies());

    const response = await invokeWithServer(app, request, fakeBunServer(calls));
    await consume(response);

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      { request, seconds: 0 },
      { request, seconds: 10 },
    ]);
  });

  test("an explicitly supplied maker returning undefined suppresses the real implementation", async () => {
    const calls: TimeoutCall[] = [];
    let makerCalls = 0;
    const explicitBaselineMaker: RequestIdleTimeoutLeaseMaker = () => {
      makerCalls += 1;
      return undefined;
    };
    const app = createApp(testConfig(), dependencies(explicitBaselineMaker));

    const response = await invokeWithServer(app, responsesRequest(), fakeBunServer(calls));
    await consume(response);

    expect(response.status).toBe(200);
    expect(makerCalls).toBe(1);
    expect(calls).toEqual([]);
  });
});

describe("Chat and Responses unified lease ownership (Group A Red)", () => {
  test.each([
    { label: "Chat", makeRequest: () => chatRequest() },
    { label: "Responses", makeRequest: () => responsesRequest() },
  ])(
    "$label invokes the maker after validation and restores once on non-streaming completion",
    async ({ makeRequest }) => {
      const events: string[] = [];
      let makerRequest: Request | undefined;
      let makerServer: Bun.Server<undefined> | undefined;
      const maker: RequestIdleTimeoutLeaseMaker = (request, server) => {
        events.push("maker");
        makerRequest = request;
        makerServer = server;
        return {
          disable(): void {
            events.push("disable");
          },
          restore(): void {
            events.push("restore");
          },
        };
      };
      const request = makeRequest();
      const server = fakeBunServer([]);
      const app = createApp(testConfig(), dependencies(maker, events));

      const response = await invokeWithServer(app, request, server);
      await consume(response);

      expect(response.status).toBe(200);
      expect(makerRequest).toBe(request);
      expect(makerServer).toBe(server);
      expect(events).toEqual(["maker", "disable", "pipeline", "restore"]);
    },
  );

  type RouteCase = readonly [
    label: string,
    makeRequest: () => Request,
    invoke: (
      request: Request,
      config: Config,
      dependencies: RouteOwnershipDependencies,
    ) => Promise<Response>,
  ];
  const routeCases: RouteCase[] = [
    [
      "Chat",
      () => chatRequest(),
      (request, config, dependencies) => handleChatCompletions(request, config, dependencies),
    ],
    [
      "Responses",
      () => responsesRequest(),
      (request, config, dependencies) => handleResponses(request, config, dependencies),
    ],
  ];

  test.each(routeCases)(
    "%s invokes a throwing maker once and never invokes the pipeline",
    async (_label, makeRequest, invoke) => {
      let makerCalls = 0;
      let pipelineCalls = 0;
      const dependencies: RouteOwnershipDependencies = {
        accountManager: new FakeAccountManager(),
        tokenRefresher: new FakeTokenRefresher(),
        createRequestIdleTimeoutLease(): RequestIdleTimeoutLease {
          makerCalls += 1;
          throw new Error("maker failed");
        },
        async runPipeline(): Promise<Response> {
          pipelineCalls += 1;
          return Response.json({});
        },
      };

      await expect(invoke(makeRequest(), testConfig(), dependencies)).rejects.toThrow(
        "maker failed",
      );
      expect(makerCalls).toBe(1);
      expect(pipelineCalls).toBe(0);
    },
  );

  test.each(routeCases)(
    "%s restores once when disable throws and never invokes the pipeline",
    async (_label, makeRequest, invoke) => {
      const calls: string[] = [];
      const dependencies: RouteOwnershipDependencies = {
        accountManager: new FakeAccountManager(),
        tokenRefresher: new FakeTokenRefresher(),
        createRequestIdleTimeoutLease: () => ({
          disable(): void {
            calls.push("disable");
            throw new Error("disable failed");
          },
          restore(): void {
            calls.push("restore");
          },
        }),
        async runPipeline(): Promise<Response> {
          calls.push("pipeline");
          return Response.json({});
        },
      };

      await expect(invoke(makeRequest(), testConfig(), dependencies)).rejects.toThrow(
        "disable failed",
      );
      expect(calls).toEqual(["disable", "restore"]);
    },
  );

  test.each(routeCases)(
    "%s restores once when the pipeline rejects",
    async (_label, makeRequest, invoke) => {
      const calls: string[] = [];
      const dependencies: RouteOwnershipDependencies = {
        accountManager: new FakeAccountManager(),
        tokenRefresher: new FakeTokenRefresher(),
        createRequestIdleTimeoutLease: () => ({
          disable(): void {
            calls.push("disable");
          },
          restore(): void {
            calls.push("restore");
          },
        }),
        async runPipeline(): Promise<Response> {
          calls.push("pipeline");
          throw new Error("pipeline failed");
        },
      };

      await expect(invoke(makeRequest(), testConfig(), dependencies)).rejects.toThrow(
        "pipeline failed",
      );
      expect(calls).toEqual(["disable", "pipeline", "restore"]);
    },
  );
});

describe("lease-maker short circuits and compatibility (Group B characterization)", () => {
  test.each([
    {
      label: "authentication failure",
      makeRequest: () => chatRequest({ authorized: false }),
    },
    {
      label: "oversized body",
      makeRequest: () =>
        chatRequest({
          body: JSON.stringify({
            model: "auto",
            messages: [{ role: "user", content: "x".repeat(512) }],
          }),
        }),
    },
    {
      label: "invalid JSON",
      makeRequest: () => chatRequest({ body: "{" }),
    },
    {
      label: "Chat schema failure",
      makeRequest: () => chatRequest({ body: JSON.stringify({ model: "auto" }) }),
    },
    {
      label: "Responses adapter empty-input failure",
      makeRequest: () =>
        responsesRequest(JSON.stringify({ model: "gpt-5.6-sol", input: [], stream: false })),
    },
  ])("$label does not invoke the maker", async ({ makeRequest }) => {
    let makerCalls = 0;
    const maker: RequestIdleTimeoutLeaseMaker = () => {
      makerCalls += 1;
      return {
        disable(): void {},
        restore(): void {},
      };
    };
    const app = createApp(testConfig({ max_request_body_bytes: 256 }), dependencies(maker));

    const response = await invokeWithServer(app, makeRequest(), fakeBunServer([]));
    await consume(response);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(makerCalls).toBe(0);
  });

  test("single-argument createApp(config, deps)(request) remains supported", async () => {
    const app = createApp(testConfig(), dependencies());

    const response = await app(chatRequest());
    await consume(response);

    expect(response.status).toBe(200);
  });
});
