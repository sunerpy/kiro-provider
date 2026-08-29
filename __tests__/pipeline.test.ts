import { describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import {
  type PipelineAccountManager,
  type PipelineClientFactory,
  type PipelineReasoningReplayStore,
  type PipelineSdkClient,
  type PipelineTokenRefresher,
  runChatCompletion,
} from "../src/core/pipeline.js";
import { createPipelineStreamResponse } from "../src/core/pipeline-stream.js";
import { ModelCapabilityService } from "../src/kiro/model-capabilities.js";
import type {
  SdkStreamEvent,
  SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import {
  assistantOutputFingerprint,
  type CanonicalRequest,
} from "../src/protocol/canonical.js";
import {
  CANONICAL_OUTPUT_JSON_MEDIA_TYPE,
  CANONICAL_OUTPUT_STREAM_MEDIA_TYPE,
  parseCanonicalCompletion,
  parseCanonicalOutputEventLine,
} from "../src/protocol/output.js";
import { canonicalSessionLineage } from "../src/server/session-affinity.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";
import { canonicalRequest, message } from "./canonical-test-helpers.js";

function requestBody(model = "auto"): CanonicalRequest {
  return canonicalRequest([message("user", "hello")], { model });
}

const REQUEST_BODY = requestBody();

function account(id: string, overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    authMethod: "desktop",
    region: "us-east-1",
    refreshToken: `${id}-refresh`,
    accessToken: `${id}-access`,
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    ...overrides,
  };
}

class FakeAccountManager implements PipelineAccountManager {
  readonly rateLimited: string[] = [];
  readonly quotaExhausted: string[] = [];
  readonly unhealthy: string[] = [];
  private cursor = 0;
  private stickyId: string | undefined;

  constructor(
    readonly accounts: ManagedAccount[],
    private readonly strategy: "round-robin" | "sticky" = "round-robin",
  ) {}

  reconcileFromDb(): readonly ManagedAccount[] {
    return this.accounts;
  }

  selectHealthyAccount(
    _preferredAccountId?: string,
    eligibleAccountIds?: ReadonlySet<string>,
  ): ManagedAccount | null {
    const now = Date.now();
    const selectable = this.accounts.filter(
      (candidate) =>
        candidate.isHealthy &&
        candidate.rateLimitResetTime <= now &&
        (eligibleAccountIds?.has(candidate.id) ?? true),
    );
    if (selectable.length === 0) return null;
    if (this.strategy === "sticky") {
      const selected =
        selectable.find((candidate) => candidate.id === this.stickyId) ?? selectable[0];
      if (!selected) return null;
      this.stickyId = selected.id;
      return selected;
    }
    const selected = selectable[this.cursor % selectable.length];
    this.cursor += 1;
    return selected ?? null;
  }

  getAccountCount(): number {
    return this.accounts.length;
  }

  toAuthDetails(selected: ManagedAccount): KiroAuthDetails {
    return {
      refresh: selected.refreshToken,
      access: selected.accessToken,
      expires: selected.expiresAt,
      authMethod: selected.authMethod,
      region: selected.region,
      email: selected.email,
    };
  }

  markRateLimited(selected: ManagedAccount, resetTime: number): void {
    selected.rateLimitResetTime = resetTime;
    this.rateLimited.push(selected.id);
  }

  markQuotaExhausted(selected: ManagedAccount, recheckAfter: number): void {
    if ((selected.limitCount ?? 0) > 0) {
      selected.usedCount = Math.max(selected.usedCount ?? 0, selected.limitCount ?? 0);
    }
    selected.rateLimitResetTime = Math.max(selected.rateLimitResetTime, recheckAfter);
    this.quotaExhausted.push(selected.id);
  }

  markUnhealthy(selected: ManagedAccount, reason: string): void {
    selected.failCount += 1;
    selected.isHealthy = selected.failCount < 10 && !reason.includes("InvalidTokenException");
    selected.unhealthyReason = reason;
    this.unhealthy.push(selected.id);
  }
}

class PreferredAccountManager extends FakeAccountManager {
  override selectHealthyAccount(
    preferredAccountId?: string,
    eligibleAccountIds?: ReadonlySet<string>,
  ): ManagedAccount | null {
    const now = Date.now();
    const preferred = this.accounts.find(
      (candidate) =>
        candidate.id === preferredAccountId &&
        candidate.isHealthy &&
        candidate.rateLimitResetTime <= now &&
        (eligibleAccountIds?.has(candidate.id) ?? true),
    );
    return preferred ?? super.selectHealthyAccount(undefined, eligibleAccountIds);
  }
}

class FakeTokenRefresher implements PipelineTokenRefresher {
  readonly refreshSignals: AbortSignal[] = [];
  readonly forceSignals: AbortSignal[] = [];
  refreshHandler?: (selected: ManagedAccount, signal: AbortSignal) => Promise<ManagedAccount>;
  forceHandler?: (selected: ManagedAccount, signal: AbortSignal) => Promise<ManagedAccount>;

  async refreshIfNeeded(
    selected: ManagedAccount,
    _auth: KiroAuthDetails,
    signal?: AbortSignal,
  ): Promise<ManagedAccount> {
    if (!signal) throw new TypeError("pipeline must pass a refresh AbortSignal");
    this.refreshSignals.push(signal);
    return this.refreshHandler ? this.refreshHandler(selected, signal) : selected;
  }

  async forceRefresh(selected: ManagedAccount, signal?: AbortSignal): Promise<ManagedAccount> {
    if (!signal) throw new TypeError("pipeline must pass a force-refresh AbortSignal");
    this.forceSignals.push(signal);
    return this.forceHandler ? this.forceHandler(selected, signal) : selected;
  }
}

function config(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    api_keys: ["sk-test"],
    request_timeout_ms: 5_000,
    stream_idle_timeout_ms: 1_000,
    rate_limit_retry_delay_ms: 10,
    ...overrides,
  });
}

function responseFrom(events: readonly SdkStreamEvent[]): SdkStreamResponse {
  const hasCompletion = events.some(
    (event) => event.metadataEvent?.tokenUsage !== undefined,
  );
  return {
    generateAssistantResponseResponse: {
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
        for (const event of events) yield event;
        if (!hasCompletion) {
          yield {
            metadataEvent: {
              tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            },
          };
        }
      },
    },
  };
}

function exactResponse(events: readonly SdkStreamEvent[]): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
        for (const event of events) yield event;
      },
    },
  };
}

function stalledResponse(first?: SdkStreamEvent): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      [Symbol.asyncIterator](): AsyncIterator<SdkStreamEvent> {
        let emitted = false;
        return {
          next(): Promise<IteratorResult<SdkStreamEvent>> {
            if (!emitted && first) {
              emitted = true;
              return Promise.resolve({ done: false, value: first });
            }
            return new Promise<IteratorResult<SdkStreamEvent>>(() => undefined);
          },
          return(): Promise<IteratorResult<SdkStreamEvent>> {
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    },
  };
}

function trackedStalledResponse(first: SdkStreamEvent): {
  readonly sdkResponse: SdkStreamResponse;
  readonly state: { returnCalled: boolean };
  readonly returnAttempted: Promise<void>;
} {
  const state = { returnCalled: false };
  const returnAttempted = deferred();
  return {
    state,
    returnAttempted: returnAttempted.promise,
    sdkResponse: {
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
            return(): Promise<IteratorResult<SdkStreamEvent>> {
              state.returnCalled = true;
              returnAttempted.resolve();
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      },
    },
  };
}

function rejectingCleanupResponse(
  first: SdkStreamEvent,
  afterFirst: () => Promise<IteratorResult<SdkStreamEvent>>,
): {
  readonly sdkResponse: SdkStreamResponse;
  readonly state: { returnCalls: number };
} {
  const state = { returnCalls: 0 };
  return {
    state,
    sdkResponse: {
      generateAssistantResponseResponse: {
        [Symbol.asyncIterator](): AsyncIterator<SdkStreamEvent> {
          let emitted = false;
          return {
            next(): Promise<IteratorResult<SdkStreamEvent>> {
              if (!emitted) {
                emitted = true;
                return Promise.resolve({ done: false, value: first });
              }
              return afterFirst();
            },
            return(): Promise<IteratorResult<SdkStreamEvent>> {
              state.returnCalls += 1;
              return Promise.reject(new Error("return failed"));
            },
          };
        },
      },
    },
  };
}

function sdkError(status: number, message: string, extras: Record<string, unknown> = {}): unknown {
  return {
    name: "SdkError",
    message,
    $metadata: { httpStatusCode: status },
    ...extras,
  };
}

function clientWith(send: (signal: AbortSignal) => Promise<SdkStreamResponse>): PipelineSdkClient {
  return {
    send(_command: unknown, options: { readonly abortSignal: AbortSignal }) {
      return send(options.abortSignal);
    },
  };
}

function reasoningReplayRequest(): CanonicalRequest {
  const outputFingerprint = assistantOutputFingerprint({ text: "prior answer", toolCalls: [] });
  return {
    canonicalVersion: 1,
    protocol: "responses",
    projectionMode: "safe",
    model: "gpt-5.6-sol",
    stream: false,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "prior answer", path: "input.1.content.0.text" }],
        toolCalls: [],
        path: "input.1",
      },
      {
        role: "user",
        content: [{ type: "text", text: "continue", path: "input.2.content.0.text" }],
        toolCalls: [],
        path: "input.2",
      },
    ],
    tools: [],
    toolChoice: "auto",
    reasoningReplays: [
      {
        lookup: { kind: "responses-token", encryptedContent: "kr1_test" },
        outputFingerprint,
        insertBeforeMessage: 0,
        path: "input.0",
      },
    ],
    includeEncryptedReasoning: true,
  };
}

function reasoningReplayStore(
  accountId: string,
  conversationId: string,
): PipelineReasoningReplayStore {
  return {
    readiness: () => ({ writable: true, keyringAvailable: true, missingKeyIds: [] }),
    store: () => undefined,
    resolveResponses: (_token, _context, insertBeforeMessage) => ({
      accountId,
      conversationId,
      replay: {
        insertBeforeMessage,
        content: {
          kind: "reasoning_text",
          text: "signed reasoning",
          signature: "native signature",
        },
      },
    }),
    resolveChat: () => {
      throw new TypeError("Chat replay is not used by this test");
    },
  };
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

async function errorBody(response: Response): Promise<{
  readonly error: {
    readonly message: string;
    readonly type: string;
    readonly code?: string;
    readonly param?: string;
  };
}> {
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("error" in body) ||
    typeof body.error !== "object" ||
    body.error === null ||
    !("message" in body.error) ||
    typeof body.error.message !== "string" ||
    !("type" in body.error) ||
    typeof body.error.type !== "string"
  ) {
    throw new TypeError("Expected an OpenAI error envelope");
  }
  const code = "code" in body.error ? body.error.code : undefined;
  const param = "param" in body.error ? body.error.param : undefined;
  return {
    error: {
      message: body.error.message,
      type: body.error.type,
      ...(typeof code === "string" ? { code } : {}),
      ...(typeof param === "string" ? { param } : {}),
    },
  };
}

describe("runChatCompletion success paths", () => {
  test.each([
    {
      mode: "kiro-runtime" as const,
      expected: "https://runtime.us-east-1.kiro.dev",
    },
    { mode: "legacy-q" as const, expected: undefined },
  ])("selects the $mode runtime endpoint", async ({ mode, expected }) => {
    const endpoints: Array<string | undefined> = [];
    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config({ runtime_endpoint_mode: mode }),
      accountManager: new FakeAccountManager([account("account-a")]),
      tokenRefresher: new FakeTokenRefresher(),
      makeClient: (...factoryArgs) => {
        endpoints.push(factoryArgs[3]);
        return clientWith(async () =>
          responseFrom([{ assistantResponseEvent: { content: "answer" } }]),
        );
      },
    });

    expect(response.status).toBe(200);
    expect(endpoints).toEqual([expected]);
  });

  test.each([
    {
      label: "configured",
      proxyUrl: "http://p:1080",
      expectedProxyUrl: "http://p:1080",
    },
    { label: "disabled", proxyUrl: null, expectedProxyUrl: undefined },
  ])(
    "passes the $label proxy URL to the SDK client factory",
    async ({ proxyUrl, expectedProxyUrl }) => {
      // Given
      const capturedProxyUrls: Array<string | undefined> = [];

      // When
      const response = await runChatCompletion({
        body: REQUEST_BODY,
        model: "auto",
        stream: false,
        config: config({ proxy_url: proxyUrl }),
        accountManager: new FakeAccountManager([account("account-a")]),
        tokenRefresher: new FakeTokenRefresher(),
        makeClient: (...factoryArgs) => {
          capturedProxyUrls.push(factoryArgs[4]);
          return clientWith(async () =>
            responseFrom([{ assistantResponseEvent: { content: "answer" } }]),
          );
        },
      });

      // Then
      expect(response.status).toBe(200);
      expect(capturedProxyUrls).toEqual([expectedProxyUrl]);
    },
  );

  test.each([false, true])(
    "passes sdk_http_keep_alive=%s to the SDK client factory",
    async (sdkHttpKeepAlive) => {
      const capturedKeepAlive: Array<boolean | undefined> = [];
      const response = await runChatCompletion({
        body: REQUEST_BODY,
        model: "auto",
        stream: false,
        config: config({ sdk_http_keep_alive: sdkHttpKeepAlive }),
        accountManager: new FakeAccountManager([account("account-a")]),
        tokenRefresher: new FakeTokenRefresher(),
        makeClient: (...factoryArgs) => {
          capturedKeepAlive.push(factoryArgs[6]);
          return clientWith(async () =>
            responseFrom([{ assistantResponseEvent: { content: "answer" } }]),
          );
        },
      });

      expect(response.status).toBe(200);
      expect(capturedKeepAlive).toEqual([sdkHttpKeepAlive]);
    },
  );

  test("returns a non-streaming completion with reasoning_content", async () => {
    // Given
    const manager = new FakeAccountManager([account("account-a")]);
    const refresher = new FakeTokenRefresher();
    const controller = new AbortController();
    let sendSignal: AbortSignal | undefined;

    // When
    const response = await runChatCompletion({
      body: requestBody("claude-opus-4-8"),
      model: "claude-opus-4-8",
      stream: false,
      config: config(),
      accountManager: manager,
      tokenRefresher: refresher,
      deadlineSignal: controller.signal,
      makeClient: () =>
        clientWith(async (signal) => {
          sendSignal = signal;
          return responseFrom([
            { reasoningContentEvent: { text: "reason" } },
            { assistantResponseEvent: { content: "answer" } },
          ]);
        }),
    });

    // Then
    const completion = parseCanonicalCompletion(await response.json());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain(
      CANONICAL_OUTPUT_JSON_MEDIA_TYPE,
    );
    expect(completion?.text).toBe("answer");
    expect(completion?.reasoning?.text).toBe("reason");
    expect(completion?.finishReason).toBe("stop");
    expect(sendSignal).toBe(controller.signal);
    expect(refresher.refreshSignals).toEqual([controller.signal]);
  });

  test("returns a raw NDJSON chunk stream without an SSE done sentinel", async () => {
    // Given
    const manager = new FakeAccountManager([account("account-a")]);
    const refresher = new FakeTokenRefresher();

    // When
    const response = await runChatCompletion({
      body: requestBody("claude-opus-4-8"),
      model: "claude-opus-4-8",
      stream: true,
      config: config(),
      accountManager: manager,
      tokenRefresher: refresher,
      makeClient: () =>
        clientWith(async () =>
          responseFrom([{ assistantResponseEvent: { content: "streamed answer" } }]),
        ),
    });
    const body = await response.text();

    // Then
    const events = body
      .trim()
      .split("\n")
      .map((line) => parseCanonicalOutputEventLine(line));
    const content = events
      .filter((event) => event?.type === "text_delta")
      .map((event) => event?.type === "text_delta" ? event.text : "")
      .join("");
    expect(response.headers.get("Content-Type")).toContain(
      CANONICAL_OUTPUT_STREAM_MEDIA_TYPE,
    );
    expect(content).toBe("streamed answer");
    expect(events.at(0)?.type).toBe("started");
    expect(events.at(-1)?.type).toBe("completed");
    expect(body).not.toContain("[DONE]");
  });
});

describe("runChatCompletion resource ownership", () => {
  test("releases queued work and disposes the deadline when stream construction throws", async () => {
    // Given
    const firstRequestTimeoutMs = 25;
    let constructorCalls = 0;
    let iteratorAcquisitions = 0;
    let firstSendSignal: AbortSignal | undefined;
    let secondSendCalls = 0;
    let firstResponse: Response | undefined;
    let secondResponse: Response | undefined;
    const sdkResponse: SdkStreamResponse = {
      generateAssistantResponseResponse: {
        [Symbol.asyncIterator](): AsyncIterator<SdkStreamEvent> {
          iteratorAcquisitions += 1;
          return {
            next: () => new Promise<IteratorResult<SdkStreamEvent>>(() => undefined),
          };
        },
      },
    };
    const firstOptions: Parameters<typeof runChatCompletion>[0] & {
      readonly createStreamResponse: typeof createPipelineStreamResponse;
    } = {
      body: REQUEST_BODY,
      model: "auto",
      stream: true,
      config: config({ request_timeout_ms: firstRequestTimeoutMs }),
      accountManager: new FakeAccountManager([account("account-a")]),
      tokenRefresher: new FakeTokenRefresher(),
      makeClient: () =>
        clientWith(async (signal) => {
          firstSendSignal = signal;
          return sdkResponse;
        }),
      createStreamResponse: (result) => {
        constructorCalls += 1;
        const upstream = result.sdkResponse.generateAssistantResponseResponse;
        if (!upstream) throw new TypeError("SDK response must expose a stream");
        upstream[Symbol.asyncIterator]();
        throw new Error("stream construction failed");
      },
    };

    try {
      // When
      firstResponse = await runChatCompletion(firstOptions);
      secondResponse = await runChatCompletion({
        body: REQUEST_BODY,
        model: "auto",
        stream: false,
        config: config({ request_timeout_ms: 100 }),
        accountManager: new FakeAccountManager([account("account-b")]),
        tokenRefresher: new FakeTokenRefresher(),
        makeClient: () =>
          clientWith(async () => {
            secondSendCalls += 1;
            return responseFrom([{ assistantResponseEvent: { content: "queue released" } }]);
          }),
      });
      await Bun.sleep(firstRequestTimeoutMs * 3);

      // Then
      expect({
        constructorCalls,
        iteratorAcquisitions,
        firstStatus: firstResponse.status,
        secondStatus: secondResponse.status,
        secondSendCalls,
        deadlineAborted: firstSendSignal?.aborted ?? null,
      }).toEqual({
        constructorCalls: 1,
        iteratorAcquisitions: 1,
        firstStatus: 500,
        secondStatus: 200,
        secondSendCalls: 1,
        deadlineAborted: false,
      });
    } finally {
      await firstResponse?.body?.cancel().catch(() => undefined);
      await secondResponse?.body?.cancel().catch(() => undefined);
    }
  });
});

describe("runChatCompletion retry and switching", () => {
  test("marks a 429 account rate-limited and switches to another account", async () => {
    // Given
    const manager = new FakeAccountManager([account("account-a"), account("account-b")]);
    const refresher = new FakeTokenRefresher();
    let calls = 0;

    // When
    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: manager,
      tokenRefresher: refresher,
      makeClient: () =>
        clientWith(async () => {
          calls += 1;
          if (calls === 1) {
            throw sdkError(429, "rate limited", {
              $response: { headers: { "retry-after": "1" } },
            });
          }
          return responseFrom([{ assistantResponseEvent: { content: "second account" } }]);
        }),
    });

    // Then
    expect(response.status).toBe(200);
    expect(manager.rateLimited).toEqual(["account-a"]);
    expect(calls).toBe(2);
  });

  test("force-refreshes once after invalid-bearer 403 then retries", async () => {
    // Given
    const manager = new FakeAccountManager([account("account-a")]);
    const refresher = new FakeTokenRefresher();
    const controller = new AbortController();
    let calls = 0;

    // When
    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: manager,
      tokenRefresher: refresher,
      deadlineSignal: controller.signal,
      makeClient: () =>
        clientWith(async () => {
          calls += 1;
          if (calls === 1) {
            throw sdkError(403, "The bearer token included in the request is invalid");
          }
          return responseFrom([{ assistantResponseEvent: { content: "refreshed" } }]);
        }),
    });

    // Then
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(refresher.forceSignals).toEqual([controller.signal]);
  });

  test("excludes an account whose refreshed bearer is still rejected", async () => {
    const first = account("account-a");
    const second = account("account-b");
    const sentAccounts: string[] = [];
    const refresher = new FakeTokenRefresher();

    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([first, second], "sticky"),
      tokenRefresher: refresher,
      makeClient: (auth) =>
        clientWith(async () => {
          sentAccounts.push(auth.email ?? "missing");
          throw sdkError(403, "The bearer token included in the request is invalid");
        }),
    });

    expect(response.status).toBe(403);
    expect((await errorBody(response)).error).toMatchObject({
      type: "upstream_error",
      code: "SdkError",
    });
    expect(sentAccounts).toEqual([first.email, first.email, second.email, second.email]);
    expect(refresher.forceSignals).toHaveLength(2);
  });

  test("switches immediately after a quota response without retrying that account", async () => {
    const first = account("account-a");
    const second = account("account-b");
    const sentAccounts: string[] = [];
    const manager = new FakeAccountManager([first, second], "sticky");

    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: manager,
      tokenRefresher: new FakeTokenRefresher(),
      makeClient: (auth) =>
        clientWith(async () => {
          sentAccounts.push(auth.email ?? "missing");
          if (auth.email === first.email) throw sdkError(402, "quota exhausted");
          return responseFrom([{ assistantResponseEvent: { content: "replacement" } }]);
        }),
    });

    expect(response.status).toBe(200);
    expect(sentAccounts).toEqual([first.email, second.email]);
    expect(manager.quotaExhausted).toEqual([first.id]);
    expect(first.rateLimitResetTime).toBeGreaterThan(Date.now());
  });

  test("filters locally exhausted accounts before refresh or SDK creation", async () => {
    const exhausted = account("account-a", { usedCount: 10_000, limitCount: 10_000 });
    const available = account("account-b", { usedCount: 9_000, limitCount: 10_000 });
    const selectedAccounts: string[] = [];
    const refresher = new FakeTokenRefresher();

    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([exhausted, available], "sticky"),
      tokenRefresher: refresher,
      makeClient: (auth) => {
        selectedAccounts.push(auth.email ?? "missing");
        return clientWith(async () =>
          responseFrom([{ assistantResponseEvent: { content: "available" } }]),
        );
      },
    });

    expect(response.status).toBe(200);
    expect(selectedAccounts).toEqual([available.email]);
    expect(refresher.refreshSignals).toHaveLength(1);
  });

  test("returns quota exhausted before upstream work when every account is exhausted", async () => {
    let clientCalls = 0;
    const refresher = new FakeTokenRefresher();
    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([
        account("account-a", { usedCount: 10_000, limitCount: 10_000 }),
        account("account-b", { overageCount: 1, limitCount: 10_000 }),
      ]),
      tokenRefresher: refresher,
      makeClient: () => {
        clientCalls += 1;
        return clientWith(async () => responseFrom([]));
      },
    });

    expect(response.status).toBe(402);
    expect((await errorBody(response)).error).toEqual({
      message: "All eligible Kiro accounts have exhausted their quota",
      type: "upstream_error",
      code: "quota_exhausted",
    });
    expect(clientCalls).toBe(0);
    expect(refresher.refreshSignals).toHaveLength(0);
  });

  test("rechecks due exhausted accounts before model selection", async () => {
    const exhausted = account("account-a", {
      usedCount: 10_000,
      limitCount: 10_000,
      rateLimitResetTime: 0,
    });
    const manager = new FakeAccountManager([exhausted]);
    let recheckCalls = 0;
    let clientCalls = 0;

    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: manager,
      tokenRefresher: new FakeTokenRefresher(),
      quotaRechecker: {
        async recheckDueAccounts(accounts, signal): Promise<void> {
          expect(signal).toBeInstanceOf(AbortSignal);
          expect(accounts.map(({ id }) => id)).toEqual([exhausted.id]);
          recheckCalls += 1;
          exhausted.usedCount = 0;
          exhausted.overageCount = 0;
          exhausted.rateLimitResetTime = 0;
        },
        async syncDueAccounts(): Promise<void> {},
      },
      makeClient: () => {
        clientCalls += 1;
        return clientWith(async () =>
          responseFrom([{ assistantResponseEvent: { content: "recovered" } }]),
        );
      },
    });

    expect(response.status).toBe(200);
    expect(recheckCalls).toBe(1);
    expect(clientCalls).toBe(1);
  });

  test("permanently disables a suspended sticky account and sends next with the second account", async () => {
    // Given
    const suspended = account("account-a");
    const replacement = account("account-b");
    const manager = new FakeAccountManager([suspended, replacement], "sticky");
    const sentAccounts: string[] = [];

    // When
    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: manager,
      tokenRefresher: new FakeTokenRefresher(),
      makeClient: (auth) =>
        clientWith(async () => {
          sentAccounts.push(auth.email ?? "missing");
          if (auth.email === suspended.email) {
            throw sdkError(403, "Account is suspended", {
              reason: "TEMPORARILY_SUSPENDED",
            });
          }
          return responseFrom([{ assistantResponseEvent: { content: "replacement" } }]);
        }),
    });

    // Then
    expect(response.status).toBe(200);
    expect(sentAccounts).toEqual([suspended.email, replacement.email]);
    expect(suspended.isHealthy).toBe(false);
    expect(suspended.unhealthyReason).toContain("InvalidTokenException");
  });

  test("excludes a sticky account at the 500 threshold before the next send", async () => {
    // Given
    const failing = account("account-a");
    const replacement = account("account-b");
    const manager = new FakeAccountManager([failing, replacement], "sticky");
    const sentAccounts: string[] = [];

    // When
    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config({
        max_request_iterations: 10,
        request_timeout_ms: 30_000,
      }),
      accountManager: manager,
      tokenRefresher: new FakeTokenRefresher(),
      makeClient: (auth) =>
        clientWith(async () => {
          sentAccounts.push(auth.email ?? "missing");
          if (auth.email === failing.email) {
            throw sdkError(500, "server error");
          }
          return responseFrom([{ assistantResponseEvent: { content: "replacement" } }]);
        }),
    });

    // Then
    expect(response.status).toBe(200);
    expect(sentAccounts).toEqual([
      failing.email,
      failing.email,
      failing.email,
      failing.email,
      failing.email,
      replacement.email,
    ]);
    expect(failing.rateLimitResetTime).toBeGreaterThan(Date.now());
  }, 30_000);

  test("returns an OpenAI error when every account is unhealthy", async () => {
    const unavailable = account("account-a");
    unavailable.isHealthy = false;
    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([unavailable]),
      tokenRefresher: new FakeTokenRefresher(),
      makeClient: () => clientWith(async () => responseFrom([])),
    });

    expect(response.status).toBe(503);
    expect((await errorBody(response)).error.type).toBe("service_unavailable");
  });

  test("returns an authentication status instead of max_request_iterations", async () => {
    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config({ max_request_iterations: 2, rate_limit_max_retries: 10 }),
      accountManager: new FakeAccountManager([account("account-a")]),
      tokenRefresher: new FakeTokenRefresher(),
      makeClient: () => clientWith(async () => Promise.reject(sdkError(401, "unauthorized"))),
    });

    expect(response.status).toBe(401);
    expect((await errorBody(response)).error).toMatchObject({
      message: "unauthorized",
      type: "upstream_error",
      code: "SdkError",
    });
  });
});

describe("runChatCompletion signed reasoning replay lock", () => {
  test("returns a retryable 503 when the replay-bound account is unavailable", async () => {
    let clientCalls = 0;
    const response = await runChatCompletion({
      body: reasoningReplayRequest(),
      model: "gpt-5.6-sol",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([account("account-b")]),
      tokenRefresher: new FakeTokenRefresher(),
      tenantId: "tenant-a",
      reasoningReplayStore: reasoningReplayStore("account-a", "conversation-a"),
      makeClient: () => {
        clientCalls += 1;
        return clientWith(async () => responseFrom([]));
      },
    });

    expect(response.status).toBe(503);
    expect(await errorBody(response)).toMatchObject({
      error: {
        type: "service_unavailable",
        code: "reasoning_replay_account_unavailable",
      },
    });
    expect(clientCalls).toBe(0);
  });

  test("replays only on the bound account and Kiro conversation", async () => {
    const selectedAccountIds: Array<string | undefined> = [];
    const commandInputs: unknown[] = [];
    const response = await runChatCompletion({
      body: reasoningReplayRequest(),
      model: "gpt-5.6-sol",
      stream: false,
      config: config(),
      accountManager: new PreferredAccountManager([
        account("account-b"),
        account("account-a"),
      ]),
      tokenRefresher: new FakeTokenRefresher(),
      tenantId: "tenant-a",
      reasoningReplayStore: reasoningReplayStore("account-a", "conversation-a"),
      makeClient: (...factoryArgs) => {
        selectedAccountIds.push(factoryArgs[5]);
        return {
          async send(command): Promise<SdkStreamResponse> {
            commandInputs.push(command.input);
            return responseFrom([
              { assistantResponseEvent: { content: "continued" } },
              {
                metadataEvent: {
                  tokenUsage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
                },
              },
            ]);
          },
        };
      },
    });

    expect(response.status).toBe(200);
    expect(selectedAccountIds).toEqual(["account-a"]);
    expect(commandInputs).toHaveLength(1);
    expect(commandInputs[0]).toMatchObject({
      conversationState: {
        conversationId: "conversation-a",
        history: [
          {
            assistantResponseMessage: {
              content: "prior answer",
              reasoningContent: {
                reasoningText: {
                  text: "signed reasoning",
                  signature: "native signature",
                },
              },
            },
          },
        ],
      },
    });
  });

  test("does not switch accounts after a replay-locked 429", async () => {
    const selectedAccountIds: Array<string | undefined> = [];
    const response = await runChatCompletion({
      body: reasoningReplayRequest(),
      model: "gpt-5.6-sol",
      stream: false,
      config: config(),
      accountManager: new PreferredAccountManager([
        account("account-b"),
        account("account-a"),
      ]),
      tokenRefresher: new FakeTokenRefresher(),
      tenantId: "tenant-a",
      reasoningReplayStore: reasoningReplayStore("account-a", "conversation-a"),
      makeClient: (...factoryArgs) => {
        selectedAccountIds.push(factoryArgs[5]);
        return clientWith(async () => {
          throw sdkError(429, "rate limited");
        });
      },
    });

    expect(response.status).toBe(503);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "reasoning_replay_account_unavailable" },
    });
    expect(selectedAccountIds).toEqual(["account-a"]);
  });
});

describe("runChatCompletion cancellation", () => {
  test("cancels a request waiting in the serial queue", async () => {
    // Given
    const firstStarted = deferred();
    const firstController = new AbortController();
    const secondController = new AbortController();
    let sendCalls = 0;
    const makeClient = (): PipelineSdkClient =>
      clientWith(async () => {
        sendCalls += 1;
        firstStarted.resolve();
        return new Promise<SdkStreamResponse>(() => undefined);
      });
    const first = runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([account("account-a")]),
      tokenRefresher: new FakeTokenRefresher(),
      deadlineSignal: firstController.signal,
      makeClient,
    });
    await firstStarted.promise;

    // When
    const second = runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([account("account-b")]),
      tokenRefresher: new FakeTokenRefresher(),
      deadlineSignal: secondController.signal,
      makeClient,
    });
    secondController.abort();
    const secondResponse = await second;

    // Then
    expect(secondResponse.status).toBe(504);
    expect(sendCalls).toBe(1);
    firstController.abort();
    expect((await first).status).toBe(504);
  });

  test("cancels token refresh with the same ingress signal", async () => {
    // Given
    const controller = new AbortController();
    const refresher = new FakeTokenRefresher();
    const refreshStarted = deferred();
    refresher.refreshHandler = (_selected, signal) => {
      refreshStarted.resolve();
      return new Promise<ManagedAccount>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    };
    const pending = runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([account("account-a")]),
      tokenRefresher: refresher,
      deadlineSignal: controller.signal,
      makeClient: () => clientWith(async () => responseFrom([])),
    });
    await refreshStarted.promise;

    // When
    controller.abort();
    const response = await pending;

    // Then
    expect(response.status).toBe(504);
    expect(refresher.refreshSignals).toEqual([controller.signal]);
  });

  test.each([
    {
      label: "429 retry-after",
      error: sdkError(429, "rate limited", {
        $response: { headers: { "retry-after": "10" } },
      }),
    },
    { label: "500 backoff", error: sdkError(500, "server error") },
  ])("cancels during $label sleep", async ({ error }) => {
    // Given
    const controller = new AbortController();
    const sendFinished = deferred();
    const pending = runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([account("account-a")]),
      tokenRefresher: new FakeTokenRefresher(),
      deadlineSignal: controller.signal,
      makeClient: () =>
        clientWith(async () => {
          sendFinished.resolve();
          throw error;
        }),
    });
    await sendFinished.promise;
    await Bun.sleep(0);

    // When
    controller.abort();
    const response = await pending;

    // Then
    expect(response.status).toBe(504);
  });

  test("passes the ingress signal to send and maps a pre-commit deadline to 504", async () => {
    // Given
    const controller = new AbortController();
    const sendStarted = deferred();
    let capturedSignal: AbortSignal | undefined;
    const pending = runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([account("account-a")]),
      tokenRefresher: new FakeTokenRefresher(),
      deadlineSignal: controller.signal,
      makeClient: () =>
        clientWith(async (signal) => {
          capturedSignal = signal;
          sendStarted.resolve();
          return new Promise<SdkStreamResponse>(() => undefined);
        }),
    });
    await sendStarted.promise;

    // When
    controller.abort();
    const response = await pending;

    // Then
    expect(capturedSignal).toBe(controller.signal);
    expect(response.status).toBe(504);
    expect((await errorBody(response)).error.type).toBe("timeout_error");
  });

  test("the internally-created deadline cancels a pre-commit send", async () => {
    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config({ request_timeout_ms: 15 }),
      accountManager: new FakeAccountManager([account("account-a")]),
      tokenRefresher: new FakeTokenRefresher(),
      makeClient: () => clientWith(async () => new Promise<SdkStreamResponse>(() => undefined)),
    });

    expect(response.status).toBe(504);
  });

  test("aborts an active stream after commit without emitting a done sentinel", async () => {
    // Given
    const controller = new AbortController();
    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: true,
      config: config(),
      accountManager: new FakeAccountManager([account("account-a")]),
      tokenRefresher: new FakeTokenRefresher(),
      deadlineSignal: controller.signal,
      makeClient: () =>
        clientWith(async () => stalledResponse({ reasoningContentEvent: { text: "partial" } })),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new TypeError("streaming response must have a body");
    await reader.read();
    const first = await reader.read();

    // When
    controller.abort();

    // Then
    await expect(reader.read()).rejects.toBeDefined();
    const partial = new TextDecoder().decode(first.value);
    expect(partial).toContain("partial");
    expect(partial).not.toContain("[DONE]");
  });

  test("errors a stream that exceeds its idle timeout without a done sentinel", async () => {
    // Given
    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: true,
      config: config({ stream_idle_timeout_ms: 15 }),
      accountManager: new FakeAccountManager([account("account-a")]),
      tokenRefresher: new FakeTokenRefresher(),
      makeClient: () =>
        clientWith(async () => stalledResponse({ reasoningContentEvent: { text: "partial" } })),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new TypeError("streaming response must have a body");
    await reader.read();
    const first = await reader.read();

    // When / Then
    await expect(reader.read()).rejects.toMatchObject({
      name: "StreamIdleTimeoutError",
      code: "upstream_stream_idle_timeout",
      message: expect.stringMatching(/idle timeout/i),
    });
    expect(new TextDecoder().decode(first.value)).not.toContain("[DONE]");
  });

  test("finalizes an idle stream before tearing down its stalled SDK iterator", async () => {
    // Given
    const stalled = trackedStalledResponse({
      reasoningContentEvent: { text: "partial" },
    });
    const ingress = new AbortController();
    let finalizeCalls = 0;
    let finalizedBeforeReturn = false;
    const response = createPipelineStreamResponse(
      {
        sdkResponse: stalled.sdkResponse,
        model: "claude-opus-4-8",
        conversationId: "conversation-id",
      },
      ingress.signal,
      15,
      () => {
        finalizeCalls += 1;
        finalizedBeforeReturn = !stalled.state.returnCalled;
      },
    );
    const reader = response.body?.getReader();
    if (!reader) throw new TypeError("streaming response must have a body");
    await reader.read();
    const first = await reader.read();

    // When
    const idleRead = reader.read();

    // Then
    await expect(idleRead).rejects.toThrow(/idle timeout/i);
    await stalled.returnAttempted;
    expect(new TextDecoder().decode(first.value)).not.toContain("[DONE]");
    expect(stalled.state.returnCalled).toBe(true);
    expect(finalizedBeforeReturn).toBe(true);
    expect(finalizeCalls).toBe(1);
    expect(ingress.signal.aborted).toBe(false);
  });

  test("cancelling a stream tears down its SDK iterator and finalizes once", async () => {
    // Given
    const stalled = trackedStalledResponse({
      reasoningContentEvent: { text: "partial" },
    });
    let finalizeCalls = 0;
    const response = createPipelineStreamResponse(
      {
        sdkResponse: stalled.sdkResponse,
        model: "claude-opus-4-8",
        conversationId: "cancelled-conversation",
      },
      new AbortController().signal,
      1_000,
      () => {
        finalizeCalls += 1;
      },
    );
    const reader = response.body?.getReader();
    if (!reader) throw new TypeError("streaming response must have a body");
    await reader.read();
    const first = await reader.read();

    // When
    await reader.cancel("consumer disconnected");

    // Then
    expect(new TextDecoder().decode(first.value)).toContain("partial");
    expect(stalled.state.returnCalled).toBe(true);
    expect(finalizeCalls).toBe(1);
  });

  test("[RED §13.6.7] finalizes before synchronously throwing SDK iterator.return and absorbs it", async () => {
    // Given
    const order: string[] = [];
    const unhandled: unknown[] = [];
    let returnCalls = 0;
    let emitted = false;
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    const sdkResponse: SdkStreamResponse = {
      generateAssistantResponseResponse: {
        [Symbol.asyncIterator](): AsyncIterator<SdkStreamEvent> {
          return {
            next(): Promise<IteratorResult<SdkStreamEvent>> {
              if (!emitted) {
                emitted = true;
                return Promise.resolve({
                  done: false,
                  value: { reasoningContentEvent: { text: "partial" } },
                });
              }
              return new Promise<IteratorResult<SdkStreamEvent>>(() => undefined);
            },
            return(): Promise<IteratorResult<SdkStreamEvent>> {
              returnCalls += 1;
              order.push("return");
              throw new Error("iterator.return threw synchronously");
            },
          };
        },
      },
    };
    const response = createPipelineStreamResponse(
      {
        sdkResponse,
        model: "claude-opus-4-8",
        conversationId: "synchronous-return-cleanup",
      },
      new AbortController().signal,
      1_000,
      () => order.push("finalize"),
    );
    const reader = response.body?.getReader();
    if (!reader) throw new TypeError("streaming response must have a body");
    await reader.read();
    const first = await reader.read();

    // When
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(reader.cancel("consumer disconnected")).resolves.toBeUndefined();
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    // Then
    expect(new TextDecoder().decode(first.value)).toContain("partial");
    expect(returnCalls).toBe(1);
    expect(order).toEqual(["finalize", "return"]);
    expect(unhandled).toEqual([]);
  });

  test("finalizes once when SDK cleanup rejects on the stream error path", async () => {
    // Given
    const secondReadStarted = deferred();
    const stalled = rejectingCleanupResponse(
      {
        reasoningContentEvent: { text: "partial" },
      },
      () => {
        secondReadStarted.resolve();
        return new Promise<IteratorResult<SdkStreamEvent>>(() => undefined);
      },
    );
    let finalizeCalls = 0;
    const response = createPipelineStreamResponse(
      {
        sdkResponse: stalled.sdkResponse,
        model: "claude-opus-4-8",
        conversationId: "rejecting-error-cleanup",
      },
      new AbortController().signal,
      15,
      () => {
        finalizeCalls += 1;
      },
    );
    // When
    const failedRead = response.text();
    await secondReadStarted.promise;

    // Then
    await expect(failedRead).rejects.toThrow(/idle timeout/i);
    expect(stalled.state.returnCalls).toBeGreaterThan(0);
    expect(finalizeCalls).toBe(1);
  });

  test("resolves cancellation and finalizes once when SDK cleanup rejects", async () => {
    // Given
    const stalled = rejectingCleanupResponse(
      {
        reasoningContentEvent: { text: "partial" },
      },
      () => new Promise<IteratorResult<SdkStreamEvent>>(() => undefined),
    );
    let finalizeCalls = 0;
    const response = createPipelineStreamResponse(
      {
        sdkResponse: stalled.sdkResponse,
        model: "claude-opus-4-8",
        conversationId: "rejecting-cancel-cleanup",
      },
      new AbortController().signal,
      1_000,
      () => {
        finalizeCalls += 1;
      },
    );
    const reader = response.body?.getReader();
    if (!reader) throw new TypeError("streaming response must have a body");
    await reader.read();
    await reader.read();

    // When / Then
    await expect(reader.cancel("consumer disconnected")).resolves.toBeUndefined();
    expect(stalled.state.returnCalls).toBeGreaterThan(0);
    expect(finalizeCalls).toBe(1);
  });
});

describe("runChatCompletion projection and terminal errors", () => {
  test("retries a semantically truncated non-stream response then succeeds", async () => {
    let sends = 0;
    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config({
        rate_limit_max_retries: 1,
        rate_limit_retry_delay_ms: 1,
      }),
      accountManager: new FakeAccountManager([account("account-a")]),
      tokenRefresher: new FakeTokenRefresher(),
      makeClient: () =>
        clientWith(async () => {
          sends += 1;
          return sends === 1
            ? exactResponse([{ assistantResponseEvent: { content: "partial" } }])
            : responseFrom([{ assistantResponseEvent: { content: "complete" } }]);
        }),
    });

    expect(response.status).toBe(200);
    expect(sends).toBe(2);
    expect(parseCanonicalCompletion(await response.json())?.text).toBe("complete");
  });

  test("maps persistent semantic truncation to a 502 upstream error", async () => {
    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config({
        rate_limit_max_retries: 0,
        rate_limit_retry_delay_ms: 1,
      }),
      accountManager: new FakeAccountManager([account("account-a")]),
      tokenRefresher: new FakeTokenRefresher(),
      makeClient: () =>
        clientWith(async () =>
          exactResponse([{ assistantResponseEvent: { content: "partial" } }]),
        ),
    });

    expect(response.status).toBe(502);
    expect(await errorBody(response)).toEqual({
      error: {
        message: expect.stringContaining("completion witness"),
        type: "upstream_error",
        code: "upstream_stream_incomplete",
      },
    });
  });

  test("discovers a model on one account and routes only to that account", async () => {
    const first = account("account-a");
    const second = account("account-b");
    const capabilities = new ModelCapabilityService(
      config(),
      async (details) => ({
        models:
          details.access === second.accessToken
            ? [
                {
                  modelId: "future-model",
                  modelName: "Future Model",
                  supportedInputTypes: ["TEXT"],
                  tokenLimits: {
                    maxInputTokens: 100_000,
                    maxOutputTokens: 10_000,
                  },
                },
              ]
            : [
                {
                  modelId: "auto",
                  modelName: "Auto",
                  supportedInputTypes: ["TEXT"],
                  tokenLimits: {
                    maxInputTokens: 100_000,
                    maxOutputTokens: 10_000,
                  },
                },
              ],
      }),
    );
    const selectedAccounts: string[] = [];
    const response = await runChatCompletion({
      body: requestBody("future-model"),
      model: "future-model",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([first, second]),
      tokenRefresher: new FakeTokenRefresher(),
      modelCapabilities: capabilities,
      makeClient: (details) => {
        selectedAccounts.push(details.access);
        return clientWith(async () =>
          responseFrom([{ assistantResponseEvent: { content: "answer" } }]),
        );
      },
    });

    expect(response.status).toBe(200);
    expect(selectedAccounts).toEqual([second.accessToken]);
  });

  test("rejects a model absent from every account before creating an SDK client", async () => {
    const capabilities = new ModelCapabilityService(config(), async () => ({
      models: [
        {
          modelId: "auto",
          modelName: "Auto",
          supportedInputTypes: ["TEXT"],
          tokenLimits: {
            maxInputTokens: 100_000,
            maxOutputTokens: 10_000,
          },
        },
      ],
    }));
    let clientCalls = 0;
    const response = await runChatCompletion({
      body: requestBody("not-a-real-model"),
      model: "not-a-real-model",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([
        account("account-a"),
        account("account-b"),
      ]),
      tokenRefresher: new FakeTokenRefresher(),
      modelCapabilities: capabilities,
      makeClient: () => {
        clientCalls += 1;
        return clientWith(async () => responseFrom([]));
      },
    });

    expect(response.status).toBe(400);
    expect(clientCalls).toBe(0);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "unsupported_model", param: "model" },
    });
  });

  test("returns a field-level 400 for an unknown model without dynamic capabilities", async () => {
    let clientCalls = 0;
    const response = await runChatCompletion({
      body: requestBody("not-a-real-model"),
      model: "not-a-real-model",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([account("account-a")]),
      tokenRefresher: new FakeTokenRefresher(),
      makeClient: () => {
        clientCalls += 1;
        return clientWith(async () => responseFrom([]));
      },
    });

    expect(response.status).toBe(400);
    expect(clientCalls).toBe(0);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "unsupported_model", param: "model" },
    });
  });

  test("reuses the same account and Kiro conversation from standard history lineage", async () => {
    const affinityStore = new AccountsDatabase(":memory:");
    try {
      const manager = new PreferredAccountManager([
        account("account-a"),
        account("account-b"),
      ]);
      const tenantId = "tenant-lineage";
      const firstBody = canonicalRequest([message("user", "first turn")], {
        protocol: "responses",
        model: "gpt-5.6-sol",
      });
      const secondBody = canonicalRequest(
        [
          message("user", "first turn"),
          message("assistant", "first answer"),
          message("user", "follow-up"),
        ],
        { protocol: "responses", model: "gpt-5.6-sol" },
      );
      const firstLineage = canonicalSessionLineage(firstBody, tenantId);
      const secondLineage = canonicalSessionLineage(secondBody, tenantId);
      if (!firstLineage || !secondLineage) {
        throw new TypeError("Expected standard history lineage");
      }
      const selectedAccounts: string[] = [];
      const conversationIds: string[] = [];
      let responseIndex = 0;
      const makeClient: PipelineClientFactory = (auth) => ({
        async send(command): Promise<SdkStreamResponse> {
          selectedAccounts.push(auth.access);
          const input = command.input as {
            conversationState?: { conversationId?: string };
          };
          const conversationId = input.conversationState?.conversationId;
          if (!conversationId) {
            throw new TypeError("Expected a Kiro conversation id");
          }
          conversationIds.push(conversationId);
          responseIndex += 1;
          return responseFrom([
            {
              assistantResponseEvent: {
                content: responseIndex === 1 ? "first answer" : "second answer",
              },
            },
          ]);
        },
      });

      const first = await runChatCompletion({
        body: firstBody,
        model: firstBody.model,
        stream: false,
        config: config(),
        accountManager: manager,
        tokenRefresher: new FakeTokenRefresher(),
        affinityStore,
        lineage: firstLineage,
        tenantId,
        makeClient,
      });
      expect(first.status).toBe(200);
      await first.arrayBuffer();

      const second = await runChatCompletion({
        body: secondBody,
        model: secondBody.model,
        stream: false,
        config: config(),
        accountManager: manager,
        tokenRefresher: new FakeTokenRefresher(),
        affinityStore,
        lineage: secondLineage,
        tenantId,
        makeClient,
      });
      expect(second.status).toBe(200);
      await second.arrayBuffer();

      expect(selectedAccounts).toEqual(["account-a-access", "account-a-access"]);
      expect(conversationIds).toHaveLength(2);
      expect(conversationIds[1]).toBe(conversationIds[0]);
    } finally {
      affinityStore.close();
    }
  });

  test("sends plain-text-only content blocks as exact concatenated bytes", async () => {
    let makeClientCalls = 0;
    let commandInput: unknown;
    const response = await runChatCompletion({
      body: canonicalRequest([
        message("user", [
          { type: "text", text: "first", path: "input.0.content.0" },
          { type: "text", text: "second", path: "input.0.content.1" },
        ]),
      ]),
      model: "gpt-5.6-sol",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([account("account-a")]),
      tokenRefresher: new FakeTokenRefresher(),
      makeClient: () => {
        makeClientCalls += 1;
        return {
          async send(command): Promise<SdkStreamResponse> {
            commandInput = command.input;
            return responseFrom([
              { assistantResponseEvent: { content: "ok" } },
              {
                metadataEvent: {
                  tokenUsage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
                },
              },
            ]);
          },
        };
      },
    });

    expect(response.status).toBe(200);
    expect(makeClientCalls).toBe(1);
    expect(commandInput).toMatchObject({
      conversationState: {
        currentMessage: {
          userInputMessage: {
            content: "firstsecond",
          },
        },
      },
    });
    expect(parseCanonicalCompletion(await response.json())).toMatchObject({
      text: "ok",
    });
  });

  test("rejects mixed content whose text ordering cannot be projected before SDK creation", async () => {
    let makeClientCalls = 0;
    const response = await runChatCompletion({
      body: canonicalRequest([
        message("user", [
          { type: "text", text: "first", path: "input.0.content.0" },
          {
            type: "image",
            url: "data:image/png;base64,AQID",
            path: "input.0.content.1",
          },
          { type: "text", text: "second", path: "input.0.content.2" },
        ]),
      ]),
      model: "gpt-5.6-sol",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([account("account-a")]),
      tokenRefresher: new FakeTokenRefresher(),
      makeClient: () => {
        makeClientCalls += 1;
        return clientWith(async () => responseFrom([]));
      },
    });

    expect(response.status).toBe(400);
    expect(makeClientCalls).toBe(0);
    expect(await errorBody(response)).toEqual({
      error: {
        message: expect.stringContaining("cannot preserve their ordering"),
        type: "invalid_request_error",
        code: "unsupported_content_block_projection",
        param: "input.0.content.2",
      },
    });
  });

  test("marks a suspended single account unhealthy before returning its failure", async () => {
    // Given
    const suspended = account("account-a");
    const manager = new FakeAccountManager([suspended]);

    // When
    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: manager,
      tokenRefresher: new FakeTokenRefresher(),
      makeClient: () =>
        clientWith(async () => {
          throw sdkError(403, "Account is suspended", {
            reason: "TEMPORARILY_SUSPENDED",
          });
        }),
    });

    // Then
    expect(response.status).toBe(403);
    expect(manager.unhealthy).toEqual(["account-a"]);
    expect(suspended.unhealthyReason).toContain("Account Suspended");
  });

  test("maps an unexpected token refresh error to an internal OpenAI error", async () => {
    // Given
    const refresher = new FakeTokenRefresher();
    refresher.refreshHandler = async () => {
      throw new RangeError("refresh state is corrupt");
    };

    // When
    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([account("account-a")]),
      tokenRefresher: refresher,
      makeClient: () => clientWith(async () => responseFrom([])),
    });

    // Then
    expect(response.status).toBe(500);
    expect(await errorBody(response)).toEqual({
      error: {
        message: "refresh state is corrupt",
        type: "internal_error",
        code: "RangeError",
      },
    });
  });

  test("returns the exact status in a standard OpenAI error envelope", async () => {
    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([account("account-a")]),
      tokenRefresher: new FakeTokenRefresher(),
      makeClient: () => clientWith(async () => Promise.reject(sdkError(402, "quota exhausted"))),
    });

    expect(response.status).toBe(402);
    expect(await errorBody(response)).toEqual({
      error: {
        message: "quota exhausted",
        type: "upstream_error",
        code: "SdkError",
      },
    });
  });
});
