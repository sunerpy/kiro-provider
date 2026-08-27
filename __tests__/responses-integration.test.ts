import { afterEach, describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import type {
  PipelineAccountManager,
  PipelineClientFactory,
  PipelineSdkClient,
  PipelineTokenRefresher,
  RunChatCompletionOptions,
} from "../src/core/pipeline.js";
import type {
  SdkStreamEvent,
  SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import {
  CANONICAL_OUTPUT_JSON_CONTENT_TYPE,
  CANONICAL_OUTPUT_STREAM_CONTENT_TYPE,
  CANONICAL_OUTPUT_VERSION,
} from "../src/protocol/output.js";
import { createApp } from "../src/server/app.js";
import { handleResponses } from "../src/server/routes/responses.js";

const API_KEY = "sk-responses-integration";
const MODEL = "gpt-5.6-sol";

function testConfig(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    api_keys: [API_KEY],
    request_timeout_ms: 1_000,
    stream_idle_timeout_ms: 1_000,
    max_request_body_bytes: 16_384,
    ...overrides,
  });
}

function account(): ManagedAccount {
  return {
    id: "responses-account",
    email: "responses@example.com",
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

function cancellableStalledSdkResponse(): {
  readonly response: SdkStreamResponse;
  readonly state: { cancelled: boolean };
  readonly returnAttempted: Promise<void>;
} {
  const state = { cancelled: false };
  let resolveReturnAttempted: (() => void) | undefined;
  const returnAttempted = new Promise<void>((resolve) => {
    resolveReturnAttempted = resolve;
  });
  let nextCalls = 0;
  return {
    state,
    returnAttempted,
    response: {
      generateAssistantResponseResponse: {
        [Symbol.asyncIterator](): AsyncIterator<SdkStreamEvent> {
          return {
            next(): Promise<IteratorResult<SdkStreamEvent>> {
              nextCalls += 1;
              if (nextCalls === 1) {
                return Promise.resolve({
                  done: false,
                  value: { reasoningContentEvent: { text: "stalled" } },
                });
              }
              return new Promise<IteratorResult<SdkStreamEvent>>(() => undefined);
            },
            return(): Promise<IteratorResult<SdkStreamEvent>> {
              state.cancelled = true;
              resolveReturnAttempted?.();
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      },
    },
  };
}

type TestServer = {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly baseUrl: string;
  readonly capturedCommandInputs: unknown[];
  readonly responseStatuses: number[];
};

type TestServerOptions = {
  readonly prepareRequest?: (request: Request) => Request;
  readonly runPipeline?: (options: RunChatCompletionOptions) => Promise<Response>;
  readonly createRequestIdleTimeoutLease?: RequestIdleTimeoutLeaseMaker;
};

type RequestIdleTimeoutLeaseMaker = (
  request: Request,
  server: Bun.Server<undefined>,
) =>
  | {
      disable(): void;
      restore(): void;
    }
  | undefined;

type LeaseEnabledAppDependencies = Parameters<typeof createApp>[1] & {
  readonly createRequestIdleTimeoutLease?: RequestIdleTimeoutLeaseMaker;
};

const activeServers = new Set<ReturnType<typeof Bun.serve>>();

afterEach(() => {
  for (const server of activeServers) server.stop(true);
  activeServers.clear();
});

function startTestServer(
  makeClient: PipelineClientFactory,
  config: Config = testConfig(),
  options: TestServerOptions = {},
): TestServer {
  const capturedCommandInputs: unknown[] = [];
  const responseStatuses: number[] = [];
  const clientFactory: PipelineClientFactory = (...factoryArgs) => {
    const client = makeClient(...factoryArgs);
    return {
      async send(command, options): Promise<SdkStreamResponse> {
        capturedCommandInputs.push(command.input);
        return client.send(command, options);
      },
    };
  };
  const dependencies: LeaseEnabledAppDependencies = {
    accountManager: new FakeAccountManager(),
    tokenRefresher: new FakeTokenRefresher(),
    makeClient: clientFactory,
    ...(options.runPipeline ? { runPipeline: options.runPipeline } : {}),
    ...(options.createRequestIdleTimeoutLease
      ? { createRequestIdleTimeoutLease: options.createRequestIdleTimeoutLease }
      : {}),
  };
  const app = createApp(config, dependencies);
  const server = Bun.serve({
    port: 0,
    async fetch(request, bunServer): Promise<Response> {
      const preparedRequest = options.prepareRequest?.(request) ?? request;
      const result: unknown = Reflect.apply(app, undefined, [preparedRequest, bunServer]);
      const response: unknown = await Promise.resolve(result);
      if (!(response instanceof Response)) {
        throw new TypeError("createApp fetch handler must resolve to a Response");
      }
      responseStatuses.push(response.status);
      return response;
    },
  });
  activeServers.add(server);
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.port}`,
    capturedCommandInputs,
    responseStatuses,
  };
}

function postPipelineAbortRequest(request: Request, ingressController: AbortController): Request {
  const abortedController = new AbortController();
  abortedController.abort();
  let signalReads = 0;
  Object.defineProperty(request, "signal", {
    get(): AbortSignal {
      signalReads += 1;
      return signalReads <= 2 ? ingressController.signal : abortedController.signal;
    },
  });
  return request;
}

function scriptedServer(
  scripts: readonly (readonly SdkStreamEvent[])[],
  config: Config = testConfig(),
): TestServer {
  let requestIndex = 0;
  const makeClient: PipelineClientFactory = (): PipelineSdkClient => ({
    async send(): Promise<SdkStreamResponse> {
      const events = scripts[requestIndex];
      requestIndex += 1;
      if (!events) throw new TypeError("Missing scripted SDK response");
      return sdkResponse(events);
    },
  });
  return startTestServer(makeClient, config);
}

function postJson(
  server: TestServer,
  path: string,
  body: unknown,
  authorization: string | null = `Bearer ${API_KEY}`,
): Promise<Response> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (authorization !== null) headers.set("Authorization", authorization);
  return fetch(`${server.baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function postResponse(
  server: TestServer,
  body: unknown,
  authorization: string | null = `Bearer ${API_KEY}`,
): Promise<Response> {
  return postJson(server, "/v1/responses", body, authorization);
}

async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TypeError(`Timed out waiting for ${label}`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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

function eventsWith(options: {
  readonly reasoning?: string;
  readonly text?: string;
  readonly tool?: {
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
  };
}): readonly SdkStreamEvent[] {
  return [
    ...(options.reasoning ? [{ reasoningContentEvent: { text: options.reasoning } }] : []),
    ...(options.text ? [{ assistantResponseEvent: { content: options.text } }] : []),
    ...(options.tool
      ? [
          {
            toolUseEvent: {
              name: options.tool.name,
              toolUseId: options.tool.id,
              input: options.tool.arguments,
              stop: true,
            },
          },
        ]
      : []),
    {
      metadataEvent: {
        tokenUsage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 },
      },
    },
  ];
}

function parseSseFrames(text: string): Readonly<Record<string, unknown>>[] {
  return text
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.length > 0)
    .map((frame) => {
      const dataLine = frame
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("data:"));
      const parsed: unknown = JSON.parse(dataLine ? dataLine.slice("data:".length).trim() : frame);
      if (!isReadonlyRecord(parsed)) {
        throw new TypeError("SSE data must be an object");
      }
      if (
        parsed.object === "response" &&
        parsed.status === "completed" &&
        typeof parsed.id === "string"
      ) {
        return { type: "response.completed", response: parsed };
      }
      return parsed;
    });
}

async function expectOpenAiError(response: Response, status: number): Promise<void> {
  const body: unknown = await response.json();
  expect(response.status).toBe(status);
  expect(body).toMatchObject({
    error: { message: expect.any(String), type: expect.any(String) },
  });
}

describe("POST /v1/responses", () => {
  test("streams Responses events with one completed event and an assembled message", async () => {
    // Given
    const server = scriptedServer([eventsWith({ reasoning: "considering", text: "full answer" })]);
    const metadata = { zuno_session_id: "zuno-stream-session" };

    // When
    const response = await postResponse(server, { model: MODEL, input: "hello", stream: true, metadata });
    const frames = parseSseFrames(await response.text());

    // Then
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(frames.find((frame) => frame.type === "response.created")).toMatchObject({ response: { metadata } });
    const completed = frames.filter((frame) => frame.type === "response.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      response: {
        id: expect.any(String),
        metadata,
        usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 },
      },
    });
    expect(
      frames.find(
        (frame) =>
          frame.type === "response.output_item.done" && typeOfNested(frame, "item") === "message",
      ),
    ).toMatchObject({
      item: {
        type: "message",
        content: [{ type: "output_text", text: "full answer" }],
      },
    });
  });

  test("uses the schema default when stream is omitted", async () => {
    // Given
    const server = scriptedServer([eventsWith({ text: "default JSON" })]);
    const metadata = { zuno_session_id: "zuno-json-session" };

    // When
    const response = await postResponse(server, { model: MODEL, input: "hello", metadata });
    const body: unknown = await response.json();

    // Then
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(body).toMatchObject({
      object: "response",
      status: "completed",
      metadata,
    });
    if (!isReadonlyRecord(body) || !Array.isArray(body.output)) {
      throw new TypeError("Responses body must contain output items");
    }
    expect(body.output).toContainEqual({
      type: "message",
      id: expect.any(String),
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "default JSON", annotations: [] }],
    });
  });

  test("rejects an unsupported model before invoking the SDK", async () => {
    // Given
    const server = scriptedServer([eventsWith({ text: "must not run" })]);

    // When
    const response = await postResponse(server, { model: "unsupported-model", input: "hello" });

    // Then
    await expectOpenAiError(response, 400);
    expect(server.capturedCommandInputs).toHaveLength(0);
  });

  test("rejects non-string Responses metadata before invoking the SDK", async () => {
    const server = scriptedServer([eventsWith({ text: "must not run" })]);
    const response = await postResponse(server, {
      model: MODEL,
      input: "hello",
      metadata: { zuno_session_id: 42 },
    });

    await expectOpenAiError(response, 400);
    expect(server.capturedCommandInputs).toHaveLength(0);
  });

  test("cancels a queue-owning pipeline stream before returning 499", async () => {
    // Given
    const stalled = cancellableStalledSdkResponse();
    let sendCalls = 0;
    const makeClient: PipelineClientFactory = () => ({
      async send(): Promise<SdkStreamResponse> {
        sendCalls += 1;
        return sendCalls === 1
          ? stalled.response
          : sdkResponse(eventsWith({ text: "next request" }));
      },
    });
    const ingressController = new AbortController();
    let requestCount = 0;
    const server = startTestServer(makeClient, testConfig(), {
      prepareRequest(request) {
        requestCount += 1;
        return requestCount === 1 ? postPipelineAbortRequest(request, ingressController) : request;
      },
    });

    // When
    const abortedResponse = await postResponse(server, {
      model: MODEL,
      input: "first",
      stream: true,
    });
    const nextResponse = await Promise.race([
      postResponse(server, { model: MODEL, input: "second", stream: false }),
      Bun.sleep(50).then(() => new Response(null, { status: 408 })),
    ]);
    await within(stalled.returnAttempted, 250, "stalled iterator return attempt");

    // Then
    expect(abortedResponse.status).toBe(499);
    expect(server.responseStatuses).toContain(499);
    expect(stalled.state.cancelled).toBe(true);
    expect(nextResponse.status).toBe(200);
  });

  test("cancels an unsupported pipeline response before serving the next request", async () => {
    // Given
    const cancellation = { called: false };
    let pipelineCalls = 0;
    const makeClient: PipelineClientFactory = () => ({
      async send(): Promise<SdkStreamResponse> {
        throw new TypeError("Injected pipeline runner must bypass the SDK client");
      },
    });
    const runPipeline = async (): Promise<Response> => {
      pipelineCalls += 1;
      if (pipelineCalls === 1) {
        return new Response(
          new ReadableStream({
            cancel(): void {
              cancellation.called = true;
            },
          }),
          { headers: { "Content-Type": "application/octet-stream" } },
        );
      }
      return new Response(JSON.stringify({
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        conversationId: "next-conversation",
        model: MODEL,
        createdAt: 1_700_000_000,
        text: "next request",
        reasoning: { text: "queue released" },
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      }), {
        headers: { "Content-Type": CANONICAL_OUTPUT_JSON_CONTENT_TYPE },
      });
    };
    // When
    const routeDependencies = {
      accountManager: new FakeAccountManager(),
      tokenRefresher: new FakeTokenRefresher(),
      makeClient,
      runPipeline,
    };
    const makeRequest = (input: string) =>
      new Request("http://test/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, input, stream: false }),
      });
    const unsupportedResponse = await handleResponses(
      makeRequest("first"),
      testConfig(),
      routeDependencies,
    );
    await Bun.sleep(0);
    const nextResponse = await handleResponses(
      makeRequest("second"),
      testConfig(),
      routeDependencies,
    );

    // Then
    expect(unsupportedResponse.status).toBe(500);
    expect(cancellation.called).toBe(true);
    expect(nextResponse.status).toBe(200);
    expect(pipelineCalls).toBe(2);
  });

  test("restores route resources when Responses adapter construction fails synchronously", async () => {
    // Given
    const order: string[] = [];
    let heldReader: ReturnType<NonNullable<Response["body"]>["getReader"]> | undefined;
    let pipelineOptions: RunChatCompletionOptions | undefined;
    const makeClient: PipelineClientFactory = () => ({
      async send(): Promise<SdkStreamResponse> {
        throw new TypeError("Injected pipeline runner must bypass the SDK client");
      },
    });
    const runPipeline = async (options: RunChatCompletionOptions): Promise<Response> => {
      order.push("runPipeline");
      pipelineOptions = options;
      const pipelineResponse = new Response(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(
              new TextEncoder().encode('{"choices":[{"delta":{"content":"must not escape"}}]}\n'),
            );
          },
        }),
        { headers: { "Content-Type": CANONICAL_OUTPUT_STREAM_CONTENT_TYPE } },
      );
      if (!pipelineResponse.body) {
        throw new TypeError("Injected pipeline response must have a body");
      }
      heldReader = pipelineResponse.body.getReader();
      return pipelineResponse;
    };
    const createRequestIdleTimeoutLease = () => {
      order.push("maker");
      return {
        disable(): void {
          order.push("disable");
        },
        restore(): void {
          order.push("restore");
        },
      };
    };
    try {
      // When
      const result = handleResponses(
        new Request("http://test/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: MODEL,
            input: "exercise every Responses request adapter",
            stream: true,
          }),
        }),
        testConfig(),
        {
          accountManager: new FakeAccountManager(),
          tokenRefresher: new FakeTokenRefresher(),
          makeClient,
          runPipeline,
          createRequestIdleTimeoutLease,
        },
      );

      // Then
      await expect(result).rejects.toThrow(/locked/i);
      expect(pipelineOptions).toMatchObject({
        model: MODEL,
        stream: true,
        body: {
          canonicalVersion: 1,
          protocol: "responses",
          projectionMode: "safe",
          model: MODEL,
          stream: true,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "exercise every Responses request adapter",
                  path: "input",
                },
              ],
              toolCalls: [],
              path: "input",
            },
          ],
          tools: [],
          toolChoice: "auto",
          reasoningReplays: [],
          includeEncryptedReasoning: false,
        },
      });
      expect({ order }).toEqual({
        order: ["maker", "disable", "runPipeline", "restore"],
      });
    } finally {
      if (heldReader) {
        try {
          await heldReader.cancel("adapter construction probe cleanup");
        } finally {
          heldReader.releaseLock();
        }
      }
    }
  });

  test("returns a complete non-stream Responses object", async () => {
    // Given
    const server = scriptedServer([eventsWith({ reasoning: "reason", text: "json answer" })]);

    // When
    const response = await postResponse(server, { model: MODEL, input: "hello", stream: false });
    const body: unknown = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      id: expect.any(String),
      object: "response",
      status: "completed",
      model: MODEL,
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "reason" }] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "json answer" }],
        },
      ],
      usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 },
    });
  });

  test("echoes accepted request configuration and sends the native Claude output limit", async () => {
    const server = scriptedServer(
      [eventsWith({ text: "configured answer" })],
      testConfig({ protocol_projection_mode: "legacy-user-prefix" }),
    );
    const response = await postResponse(server, {
      model: "claude-sonnet-5",
      instructions: "exact instructions",
      input: "hello",
      stream: false,
      max_output_tokens: 4_096,
      reasoning: { effort: "minimal" },
      tool_choice: "none",
      tools: [
        {
          type: "function",
          name: "read",
          parameters: { type: "object" },
          strict: false,
        },
        { type: "custom", name: "shell" },
      ],
    });
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      object: "response",
      status: "completed",
      instructions: "exact instructions",
      max_output_tokens: 4_096,
      max_tool_calls: null,
      reasoning: { effort: "minimal", summary: null },
      tool_choice: "none",
      tools: [
        {
          type: "function",
          name: "read",
          parameters: { type: "object" },
          strict: false,
        },
        { type: "custom", name: "shell" },
      ],
      completed_at: expect.any(Number),
      service_tier: null,
      top_logprobs: null,
      user: null,
    });
    expect(server.capturedCommandInputs).toHaveLength(1);
    expect(server.capturedCommandInputs[0]).toMatchObject({
      additionalModelRequestFields: { max_tokens: 4_096 },
      conversationState: {
        currentMessage: {
          userInputMessage: {
            content: "exact instructions\n\nhello",
          },
        },
      },
    });
    expect(JSON.stringify(server.capturedCommandInputs[0])).not.toContain("toolSpecification");
  });

  test("rejects an unproven GPT output limit before invoking the SDK", async () => {
    const server = scriptedServer([eventsWith({ text: "must not run" })]);
    const response = await postResponse(server, {
      model: MODEL,
      input: "hello",
      max_output_tokens: 4_096,
    });
    const body: unknown = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: "unsupported_output_token_limit",
        param: "max_output_tokens",
      },
    });
    expect(server.capturedCommandInputs).toHaveLength(0);
  });

  test("returns a tool-only completed response with no empty assistant message", async () => {
    // Given
    const tool = {
      id: "call_weather",
      name: "get_weather",
      arguments: '{"city":"Seattle"}',
    };
    const server = scriptedServer([[...eventsWith({ tool })]]);

    // When
    const response = await postResponse(server, {
      model: MODEL,
      input: "weather",
      stream: false,
      tools: [
        {
          type: "function",
          name: tool.name,
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
    });
    const body: unknown = await response.json();

    // Then
    expect(response.status).toBe(200);
    if (!isReadonlyRecord(body) || !Array.isArray(body.output)) {
      throw new TypeError("Responses body must contain output items");
    }
    expect(body.output).toHaveLength(1);
    const item = body.output[0];
    if (!isReadonlyRecord(item) || typeof item.id !== "string") {
      throw new TypeError("Tool item must carry an independent id");
    }
    expect(item.id).toMatch(/^fc_[0-9a-f-]+$/);
    expect(item.id).not.toBe(tool.id);
    expect(item).toEqual({
      id: item.id,
      type: "function_call",
      call_id: tool.id,
      name: tool.name,
      arguments: tool.arguments,
    });
    expect(body.output.some((entry) => isReadonlyRecord(entry) && entry.type === "message")).toBe(
      false,
    );
  });

  test("returns custom and function calls with unique ids and no empty message", async () => {
    const server = scriptedServer([
      [
        {
          toolUseEvent: {
            name: "kiro_custom_0",
            toolUseId: "call_exec",
            input: JSON.stringify({ input: "printf ok" }),
            stop: false,
          },
        },
        {
          toolUseEvent: {
            name: "spawn_agent",
            toolUseId: "call_spawn",
            input: '{"task_name":"review"}',
            stop: true,
          },
        },
        { metadataEvent: { tokenUsage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 } } },
      ],
    ]);
    const response = await postResponse(server, {
      model: MODEL,
      input: "run tools",
      stream: false,
      tools: [
        { type: "custom", name: "exec" },
        {
          type: "function",
          name: "spawn_agent",
          parameters: { type: "object" },
        },
      ],
    });
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    if (!isReadonlyRecord(body) || !Array.isArray(body.output)) {
      throw new TypeError("Responses body must contain output items");
    }
    expect(body.output).toHaveLength(2);
    const [custom, functionCall] = body.output;
    if (
      !isReadonlyRecord(custom) ||
      !isReadonlyRecord(functionCall) ||
      typeof custom.id !== "string" ||
      typeof functionCall.id !== "string"
    ) {
      throw new TypeError("Both tool items must carry independent ids");
    }
    expect(custom.id).toMatch(/^fc_[0-9a-f-]+$/);
    expect(functionCall.id).toMatch(/^fc_[0-9a-f-]+$/);
    expect(custom.id).not.toBe(functionCall.id);
    expect(custom.id).not.toBe("call_exec");
    expect(functionCall.id).not.toBe("call_spawn");
    expect(custom).toEqual({
      id: custom.id,
      type: "custom_tool_call",
      call_id: "call_exec",
      name: "exec",
      input: "printf ok",
    });
    expect(functionCall).toEqual({
      id: functionCall.id,
      type: "function_call",
      call_id: "call_spawn",
      name: "spawn_agent",
      arguments: '{"task_name":"review"}',
    });
    expect(body.output.some((entry) => isReadonlyRecord(entry) && entry.type === "message")).toBe(
      false,
    );
  });

  test("keeps concurrent custom-tool bridges isolated across Zuno sessions", async () => {
    const bothEntered = deferred();
    const affinities: Array<{
      readonly keyHash: string | undefined;
      readonly source: string | undefined;
    }> = [];
    let pipelineCalls = 0;
    const runPipeline = async (options: RunChatCompletionOptions): Promise<Response> => {
      pipelineCalls += 1;
      affinities.push({
        keyHash: options.affinity?.keyHash,
        source: options.affinity?.source,
      });
      if (pipelineCalls === 2) bothEntered.resolve();
      await bothEntered.promise;
      return new Response(JSON.stringify({
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        conversationId: "bridge-conversation",
        model: MODEL,
        createdAt: 1_700_000_000,
        text: "",
        toolCalls: [
          {
            id: "call_shared",
            name: "kiro_custom_0",
            input: '{"input":"ok"}',
          },
        ],
        finishReason: "tool_calls",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      }), { headers: { "Content-Type": CANONICAL_OUTPUT_JSON_CONTENT_TYPE } });
    };
    const routeDependencies = {
      accountManager: new FakeAccountManager(),
      tokenRefresher: new FakeTokenRefresher(),
      tenantId: "tenant-zuno",
      runPipeline,
    };
    const postCustom = (sessionId: string, name: string) =>
      handleResponses(
        new Request("http://test/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: MODEL,
            input: "run",
            stream: false,
            metadata: { zuno_session_id: sessionId },
            tools: [{ type: "custom", name }],
          }),
        }),
        testConfig(),
        routeDependencies,
      );

    const [alphaResponse, betaResponse] = await Promise.all([
      postCustom("session-alpha", "alpha_exec"),
      postCustom("session-beta", "beta_exec"),
    ]);
    const [alphaBody, betaBody]: [unknown, unknown] = await Promise.all([
      alphaResponse.json(),
      betaResponse.json(),
    ]);

    expect([alphaResponse.status, betaResponse.status]).toEqual([200, 200]);
    expect(alphaBody).toMatchObject({
      output: [{ type: "custom_tool_call", name: "alpha_exec", input: "ok" }],
    });
    expect(betaBody).toMatchObject({
      output: [{ type: "custom_tool_call", name: "beta_exec", input: "ok" }],
    });
    expect(affinities.map((affinity) => affinity.source)).toEqual([
      "responses.metadata.zuno_session_id",
      "responses.metadata.zuno_session_id",
    ]);
    expect(new Set(affinities.map((affinity) => affinity.keyHash)).size).toBe(2);
  });

  test("rejects namespace tools before invoking the SDK", async () => {
    const server = scriptedServer([eventsWith({ text: "must not run" })]);
    const response = await postResponse(server, {
      model: MODEL,
      input: "run tool",
      stream: false,
      tools: [
        {
          type: "namespace",
          name: "collaboration",
          tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object" } }],
        },
      ],
    });
    const body: unknown = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: { code: "unsupported_tool_type", param: "tools.0" },
    });
    expect(server.capturedCommandInputs).toHaveLength(0);
  });

  test("returns an atomic 502 when a later custom wrapper is malformed", async () => {
    const server = scriptedServer([
      [
        {
          toolUseEvent: {
            name: "plain",
            toolUseId: "call_plain",
            input: "{}",
            stop: false,
          },
        },
        {
          toolUseEvent: {
            name: "kiro_custom_0",
            toolUseId: "call_exec",
            input: '{"input":1}',
            stop: true,
          },
        },
        { metadataEvent: { tokenUsage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 } } },
      ],
    ]);
    const response = await postResponse(server, {
      model: MODEL,
      input: "run tools",
      stream: false,
      tools: [{ type: "custom", name: "exec" }],
    });
    const body: unknown = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      error: { code: "upstream_protocol_error" },
    });
    expect(body).not.toHaveProperty("output");
  });

  test("preserves an exactly declared function call and tool output in a second-turn SDK request", async () => {
    // Given
    const firstTool = {
      id: "call_lookup",
      name: "lookup",
      arguments: '{"query":"status"}',
    };
    const server = scriptedServer([
      eventsWith({ reasoning: "inspect status", tool: firstTool }),
      eventsWith({ text: "done" }),
    ]);
    const tools = [
      {
        type: "function" as const,
        name: firstTool.name,
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ];
    const first = await postResponse(server, {
      model: MODEL,
      input: "check status",
      stream: true,
      tools,
    });
    expect(first.status).toBe(200);
    const firstFrames = parseSseFrames(await first.text());
    const completed = firstFrames.find((frame) => frame.type === "response.completed");
    const completedResponse = completed?.response;
    if (!isReadonlyRecord(completedResponse) || !Array.isArray(completedResponse.output)) {
      throw new TypeError("Turn one must emit completed response output");
    }
    const emittedReasoning = completedResponse.output.find(
      (item) => isReadonlyRecord(item) && item.type === "reasoning",
    );
    const emittedFunctionCall = completedResponse.output.find(
      (item) => isReadonlyRecord(item) && item.type === "function_call",
    );
    if (!isReadonlyRecord(emittedReasoning) || !isReadonlyRecord(emittedFunctionCall)) {
      throw new TypeError("Turn one must emit reasoning and function call items");
    }
    const emittedCallId = emittedFunctionCall.call_id;
    const emittedCallName = emittedFunctionCall.name;
    if (typeof emittedCallId !== "string" || typeof emittedCallName !== "string") {
      throw new TypeError("Emitted function call must contain call_id and name");
    }

    // When
    const second = await postResponse(server, {
      model: MODEL,
      input: [
        emittedFunctionCall,
        {
          type: "function_call_output",
          call_id: emittedCallId,
          output: "service is healthy",
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "finish" }],
        },
      ],
      stream: false,
      tools,
    });

    // Then
    expect(second.status).toBe(200);
    expect(emittedReasoning).toMatchObject({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "inspect status" }],
    });
    expect(emittedFunctionCall).toMatchObject({
      type: "function_call",
      call_id: firstTool.id,
      name: firstTool.name,
      arguments: firstTool.arguments,
    });
    const secondCommand = JSON.stringify(server.capturedCommandInputs[1]);
    expect(secondCommand).not.toContain("<thinking>inspect status</thinking>");
    expect(secondCommand).not.toContain("inspect status");
    expect(secondCommand).toContain(emittedCallId);
    expect(secondCommand).toContain(emittedCallName);
    expect(secondCommand).toContain("service is healthy");
  });

  test.each([
    ["missing authorization", null],
    ["wrong authorization", "Bearer wrong"],
  ])("returns 401 for %s", async (_label, authorization) => {
    const server = scriptedServer([eventsWith({ text: "unused" })]);
    const response = await postResponse(server, { model: MODEL, input: "hello" }, authorization);
    await expectOpenAiError(response, 401);
  });

  test("returns 404 for an unknown authenticated route", async () => {
    const server = scriptedServer([eventsWith({ text: "unused" })]);
    const response = await postJson(server, "/unknown", {});
    await expectOpenAiError(response, 404);
  });

  test("returns 400 for malformed JSON", async () => {
    const server = scriptedServer([eventsWith({ text: "unused" })]);
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: "{bad-json",
    });
    await expectOpenAiError(response, 400);
  });

  test("rejects an unknown input item without silently skipping it", async () => {
    const server = scriptedServer([eventsWith({ text: "unused" })]);
    const response = await postResponse(server, {
      model: MODEL,
      input: [{ type: "future_item", payload: true }],
    });
    const body: unknown = await response.json();
    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: { code: "unsupported_input_item", param: "input.0" },
    });
    expect(server.capturedCommandInputs).toHaveLength(0);
  });

  test.each([
    ["previous_response_id", { previous_response_id: "resp_previous" }],
    ["conversation", { conversation: "conv_previous" }],
  ])("rejects unsupported stateful Responses field %s explicitly", async (_field, extra) => {
    const server = scriptedServer([eventsWith({ text: "unused" })]);
    const response = await postResponse(server, {
      model: MODEL,
      input: "hello",
      ...extra,
    });
    const body: unknown = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: { code: "unsupported_stateful_responses" },
    });
    expect(server.capturedCommandInputs).toHaveLength(0);
  });

  test("returns 413 for an oversized request body", async () => {
    const server = scriptedServer(
      [eventsWith({ text: "unused" })],
      testConfig({ max_request_body_bytes: 64 }),
    );
    const response = await postResponse(server, { model: MODEL, input: "x".repeat(256) });
    await expectOpenAiError(response, 413);
  });

  test("keeps POST /v1/chat/completions working", async () => {
    const server = scriptedServer(
      [eventsWith({ text: "chat regression" })],
      testConfig({ enable_legacy_chat_completions: true }),
    );
    const response = await postJson(server, "/v1/chat/completions", {
      model: MODEL,
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });
    const body: unknown = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      object: "chat.completion",
      choices: [{ message: { content: "chat regression" } }],
    });
  });
});

function typeOfNested(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const nested = value[key];
  if (!isReadonlyRecord(nested)) return undefined;
  return typeof nested.type === "string" ? nested.type : undefined;
}

function isReadonlyRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
