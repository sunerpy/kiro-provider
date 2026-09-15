import { describe, expect, spyOn, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import { auditHash } from "../src/core/audit-log.js";
import {
  type PipelineAccountManager,
  type PipelineClientFactory,
  type PipelineReasoningReplayStore,
  type PipelineSdkClient,
  type PipelineTokenRefresher,
  runChatCompletion,
} from "../src/core/pipeline.js";
import { createPipelineStreamResponse } from "../src/core/pipeline-stream.js";
import { AccountUnavailableError } from "../src/core/token-refresher.js";
import { KiroTokenRefreshError } from "../src/kiro/errors.js";
import { ModelCapabilityService } from "../src/kiro/model-capabilities.js";
import type {
  SdkStreamEvent,
  SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import { assistantOutputFingerprint, type CanonicalRequest } from "../src/protocol/canonical.js";
import {
  CANONICAL_OUTPUT_JSON_MEDIA_TYPE,
  CANONICAL_OUTPUT_STREAM_MEDIA_TYPE,
  parseCanonicalCompletion,
  parseCanonicalOutputEventLine,
} from "../src/protocol/output.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
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
    profileArn: `arn:aws:codewhisperer:us-east-1:123456789012:profile/${id}`,
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
      ...(selected.profileArn ? { profileArn: selected.profileArn } : {}),
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
  const hasCompletion = events.some((event) => event.metadataEvent?.tokenUsage !== undefined);
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
    projectionMode: "v3-auto",
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

function anthropicReasoningReplayRequest(): CanonicalRequest {
  const base = reasoningReplayRequest();
  const replay = base.reasoningReplays[0];
  if (!replay) throw new TypeError("missing replay fixture");
  return {
    ...base,
    protocol: "anthropic-messages",
    model: "claude-sonnet-5",
    reasoningReplays: [
      {
        ...replay,
        lookup: { kind: "anthropic-token", signature: "kr1_test" },
      },
    ],
  };
}

function reasoningReplayStore(
  accountId: string,
  conversationId: string,
  portableProtocol?: "responses" | "anthropic-messages",
  provenanceOverrides: Partial<{
    protocol: "responses" | "anthropic-messages";
    region: string;
    profileArn: string;
    runtimeProtocol: "codewhisperer" | "kiro-runtime";
    upstreamOperation: "GenerateAssistantResponse";
  }> = {},
  legacyPortable = false,
  databaseLegacy = false,
): PipelineReasoningReplayStore {
  return {
    readiness: () => ({ writable: true, keyringAvailable: true, missingKeyIds: [] }),
    store: () => undefined,
    resolveResponses: (_token, _context, insertBeforeMessage) => ({
      accountId,
      conversationId,
      ...(portableProtocol
        ? {
            portable: true as const,
            provenance: {
              protocol: portableProtocol,
              region: "us-east-1",
              profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/source-account",
              runtimeProtocol: "kiro-runtime" as const,
              upstreamOperation: "GenerateAssistantResponse" as const,
              issuedAt: Date.now() - 1_000,
              expiresAt: Date.now() + 60_000,
              ...provenanceOverrides,
            },
          }
        : {}),
      ...(legacyPortable ? { legacyPortable: true as const } : {}),
      ...(databaseLegacy ? { databaseLegacy: true as const } : {}),
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
    expect(response.headers.get("Content-Type")).toContain(CANONICAL_OUTPUT_JSON_MEDIA_TYPE);
    expect(completion?.text).toBe("answer");
    expect(completion?.reasoning?.text).toBe("reason");
    expect(completion?.finishReason).toBe("stop");
    // The send signal is a per-attempt composite that follows the ingress signal.
    expect(sendSignal).toBeInstanceOf(AbortSignal);
    expect(sendSignal?.aborted).toBe(false);
    controller.abort();
    expect(sendSignal?.aborted).toBe(true);
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
      .map((event) => (event?.type === "text_delta" ? event.text : ""))
      .join("");
    expect(response.headers.get("Content-Type")).toContain(CANONICAL_OUTPUT_STREAM_MEDIA_TYPE);
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
    let prefetchedTypes: readonly string[] | undefined;
    // The pipeline prefetches to the first semantic event before hand-off, so
    // the SDK stream must produce one; it then stalls like a live upstream.
    const sdkResponse: SdkStreamResponse = {
      generateAssistantResponseResponse: {
        [Symbol.asyncIterator](): AsyncIterator<SdkStreamEvent> {
          iteratorAcquisitions += 1;
          let emitted = false;
          return {
            next: () => {
              if (!emitted) {
                emitted = true;
                return Promise.resolve({
                  done: false,
                  value: { assistantResponseEvent: { content: "prefetched" } },
                });
              }
              return new Promise<IteratorResult<SdkStreamEvent>>(() => undefined);
            },
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
        prefetchedTypes = result.prepared?.prefetched.map((event) => event.type);
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

      // Then: the abandoned attempt is torn down by the pipeline (its send
      // signal aborts with the construction error), never by the deadline.
      const sendReason: unknown = firstSendSignal?.reason;
      expect({
        constructorCalls,
        iteratorAcquisitions,
        prefetchedTypes,
        firstStatus: firstResponse.status,
        secondStatus: secondResponse.status,
        secondSendCalls,
        attemptAborted: firstSendSignal?.aborted ?? null,
        deadlineFired: sendReason instanceof DOMException && sendReason.name === "TimeoutError",
      }).toEqual({
        constructorCalls: 1,
        iteratorAcquisitions: 1,
        prefetchedTypes: ["started"],
        firstStatus: 500,
        secondStatus: 200,
        secondSendCalls: 1,
        attemptAborted: true,
        deadlineFired: false,
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

  test("bounds 5xx retries by the shared budget without marking a healthy account unavailable", async () => {
    const failing = account("account-a");
    const manager = new FakeAccountManager([failing, account("account-b")], "sticky");
    const sentAccounts: string[] = [];
    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config({ rate_limit_max_retries: 1, request_timeout_ms: 5_000 }),
      accountManager: manager,
      tokenRefresher: new FakeTokenRefresher(),
      makeClient: (auth) =>
        clientWith(async () => {
          sentAccounts.push(auth.email ?? "missing");
          throw sdkError(500, "server error");
        }),
    });
    expect(response.status).toBe(500);
    expect(sentAccounts).toEqual([failing.email, failing.email]);
    expect(failing.rateLimitResetTime).toBe(0);
    expect(failing.isHealthy).toBe(true);
  });

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
  test("migrates a verified portable Sol replay to a healthy same-region account", async () => {
    const selectedAccountIds: Array<string | undefined> = [];
    const conversations: string[] = [];
    const response = await runChatCompletion({
      body: reasoningReplayRequest(),
      model: "gpt-5.6-sol",
      stream: false,
      config: config({ reasoning_replay_account_failover: "verified" }),
      accountManager: new PreferredAccountManager([
        account("account-a", { usedCount: 10_000, limitCount: 10_000 }),
        account("account-b", { usedCount: 1, limitCount: 10_000 }),
      ]),
      tokenRefresher: new FakeTokenRefresher(),
      tenantId: "tenant-a",
      reasoningReplayStore: reasoningReplayStore("account-a", "conversation-a", "responses"),
      makeClient: (...factoryArgs) => {
        selectedAccountIds.push(factoryArgs[5]);
        return {
          async send(command): Promise<SdkStreamResponse> {
            conversations.push(
              String(
                (command.input.conversationState as { conversationId?: string }).conversationId,
              ),
            );
            return responseFrom([
              { assistantResponseEvent: { content: "migrated" } },
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
    expect(selectedAccountIds).toEqual(["account-b"]);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).not.toBe("conversation-a");
  });

  test("uses authenticated mint region even when the origin account row later drifts", async () => {
    const selectedAccountIds: Array<string | undefined> = [];
    const response = await runChatCompletion({
      body: reasoningReplayRequest(),
      model: "gpt-5.6-sol",
      stream: false,
      config: config({ reasoning_replay_account_failover: "verified" }),
      accountManager: new PreferredAccountManager([
        account("account-a", {
          region: "eu-west-1",
          profileArn: "arn:aws:codewhisperer:eu-west-1:123456789012:profile/account-a",
          usedCount: 10_000,
          limitCount: 10_000,
        }),
        account("account-b"),
      ]),
      tokenRefresher: new FakeTokenRefresher(),
      tenantId: "tenant-a",
      reasoningReplayStore: reasoningReplayStore("account-a", "conversation-a", "responses"),
      makeClient: (...factoryArgs) => {
        selectedAccountIds.push(factoryArgs[5]);
        return clientWith(async () =>
          responseFrom([{ assistantResponseEvent: { content: "mint region" } }]),
        );
      },
    });

    expect(response.status).toBe(200);
    expect(selectedAccountIds).toEqual(["account-b"]);
  });

  test("does not cross protocols when the presentation differs from authenticated mint provenance", async () => {
    let clientCalls = 0;
    const response = await runChatCompletion({
      body: anthropicReasoningReplayRequest(),
      model: "claude-sonnet-5",
      stream: false,
      config: config({ reasoning_replay_account_failover: "verified" }),
      accountManager: new PreferredAccountManager([
        account("account-a", { usedCount: 10_000, limitCount: 10_000 }),
        account("account-b"),
      ]),
      tokenRefresher: new FakeTokenRefresher(),
      tenantId: "tenant-a",
      reasoningReplayStore: reasoningReplayStore("account-a", "conversation-a", "responses"),
      makeClient: () => {
        clientCalls += 1;
        return clientWith(async () => responseFrom([]));
      },
    });

    expect(response.status).toBe(402);
    expect(clientCalls).toBe(0);
  });

  test("fails closed when the current request would use a different upstream operation", async () => {
    let clientCalls = 0;
    const response = await runChatCompletion({
      body: { ...reasoningReplayRequest(), projectionMode: "safe" },
      model: "gpt-5.6-sol",
      stream: false,
      config: config({ reasoning_replay_account_failover: "verified" }),
      accountManager: new PreferredAccountManager([
        account("account-a", { usedCount: 10_000, limitCount: 10_000 }),
        account("account-b"),
      ]),
      tokenRefresher: new FakeTokenRefresher(),
      tenantId: "tenant-a",
      reasoningReplayStore: reasoningReplayStore("account-a", "conversation-a", "responses"),
      makeClient: () => {
        clientCalls += 1;
        return clientWith(async () => responseFrom([]));
      },
    });

    expect(response.status).toBe(400);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "reasoning_replay_context_mismatch" },
    });
    expect(clientCalls).toBe(0);
  });

  test("keeps a legacy replay owner-bound even when verified failover is enabled", async () => {
    const affinityStore = new AccountsDatabase(":memory:");
    try {
      affinityStore.claimSessionAffinity(
        "fork-affinity",
        "account-a",
        "conversation-a",
        Date.now(),
        60_000,
        100,
      );
      const selectedAccountIds: Array<string | undefined> = [];
      const response = await runChatCompletion({
        body: reasoningReplayRequest(),
        model: "gpt-5.6-sol",
        stream: false,
        config: config({ reasoning_replay_account_failover: "verified" }),
        accountManager: new PreferredAccountManager([
          account("account-a", { usedCount: 10_000, limitCount: 10_000 }),
          account("account-b", { usedCount: 1, limitCount: 10_000 }),
        ]),
        tokenRefresher: new FakeTokenRefresher(),
        tenantId: "tenant-a",
        reasoningReplayStore: reasoningReplayStore(
          "account-a",
          "conversation-a",
          undefined,
          {},
          true,
        ),
        affinity: { keyHash: "fork-affinity", source: "responses.client_metadata.thread_id" },
        affinityStore,
        makeClient: (...factoryArgs) => {
          selectedAccountIds.push(factoryArgs[5]);
          return clientWith(async () =>
            responseFrom([{ assistantResponseEvent: { content: "affinity migrated" } }]),
          );
        },
      });

      expect(response.status).toBe(402);
      expect(selectedAccountIds).toEqual([]);
      expect(affinityStore.getSessionAffinity("fork-affinity")).toMatchObject({
        accountId: "account-a",
        conversationId: "conversation-a",
      });
    } finally {
      affinityStore.close();
    }
  });

  test("migrates an opted-in pre-release kr2 replay in the verified Responses cell", async () => {
    const selectedAccountIds: Array<string | undefined> = [];
    const response = await runChatCompletion({
      body: reasoningReplayRequest(),
      model: "gpt-5.6-sol",
      stream: false,
      config: config({
        reasoning_replay_account_failover: "verified",
        reasoning_replay_legacy_account_failover: "verified-current-cell",
      }),
      accountManager: new PreferredAccountManager([
        account("account-a", { usedCount: 10_000, limitCount: 10_000 }),
        account("account-b", { usedCount: 1, limitCount: 10_000 }),
      ]),
      tokenRefresher: new FakeTokenRefresher(),
      tenantId: "tenant-a",
      reasoningReplayStore: reasoningReplayStore(
        "account-a",
        "conversation-a",
        undefined,
        {},
        true,
      ),
      makeClient: (...factoryArgs) => {
        selectedAccountIds.push(factoryArgs[5]);
        return clientWith(async () =>
          responseFrom([{ assistantResponseEvent: { content: "legacy portable migrated" } }]),
        );
      },
    });

    expect(response.status).toBe(200);
    expect(selectedAccountIds).toEqual(["account-b"]);
  });

  test.each([
    { protocol: "responses", body: reasoningReplayRequest(), stream: false },
    { protocol: "responses", body: reasoningReplayRequest(), stream: true },
    { protocol: "anthropic-messages", body: anthropicReasoningReplayRequest(), stream: false },
    { protocol: "anthropic-messages", body: anthropicReasoningReplayRequest(), stream: true },
  ])(
    "migrates authenticated database kr1 $protocol replay unchanged with stream=$stream",
    async ({ body, stream }) => {
      const selectedAccountIds: Array<string | undefined> = [];
      const commands: unknown[] = [];
      const database = new AccountsDatabase(":memory:");
      const replayConfig = config({
        reasoning_replay_token_format: "database-v1",
        reasoning_replay_legacy_account_failover: "verified-current-cell",
        reasoning_replay_keys: [`test:${Buffer.alloc(32, 7).toString("base64url")}`],
      });
      const store = new ReasoningReplayStore(database, replayConfig);
      const replay = body.reasoningReplays[0];
      if (!replay) throw new TypeError("missing replay fixture");
      const token = store.store(
        { text: "signed reasoning", signature: "native signature" },
        {
          tenantId: "tenant-a",
          model: body.model,
          accountId: "account-a",
          conversationId: "conversation-a",
          outputFingerprint: replay.outputFingerprint,
          protocol: body.protocol === "responses" ? "responses" : "anthropic-messages",
          region: "us-east-1",
          profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/account-a",
          runtimeProtocol: "kiro-runtime",
          upstreamOperation: "GenerateAssistantResponse",
        },
      );
      if (!token?.startsWith("kr1_")) throw new TypeError("expected database kr1 token");
      try {
        const response = await runChatCompletion({
          body: {
            ...body,
            stream,
            reasoningReplays: [
              {
                ...replay,
                lookup:
                  body.protocol === "responses"
                    ? { kind: "responses-token", encryptedContent: token }
                    : { kind: "anthropic-token", signature: token },
              },
            ],
          },
          model: body.model,
          stream,
          config: replayConfig,
          accountManager: new PreferredAccountManager([
            account("account-a", { usedCount: 10_000, limitCount: 10_000 }),
            account("wrong-region", {
              region: "eu-west-1",
              profileArn: "arn:aws:codewhisperer:eu-west-1:123456789012:profile/wrong-region",
            }),
            account("missing-profile", { profileArn: undefined }),
            account("account-b", { usedCount: 1, limitCount: 10_000 }),
          ]),
          tokenRefresher: new FakeTokenRefresher(),
          tenantId: "tenant-a",
          reasoningReplayStore: store,
          makeClient: (...factoryArgs) => {
            selectedAccountIds.push(factoryArgs[5]);
            return {
              async send(command): Promise<SdkStreamResponse> {
                commands.push(command.input);
                return responseFrom([{ assistantResponseEvent: { content: "legacy continued" } }]);
              },
            };
          },
        });

        expect(response.status).toBe(200);
        expect(await response.text()).toContain("legacy continued");
        expect(selectedAccountIds).toEqual(["account-b"]);
        expect(commands).toHaveLength(1);
        expect(commands[0]).toMatchObject({
          conversationState: {
            conversationId: expect.not.stringContaining("conversation-a"),
            history: expect.arrayContaining([
              {
                assistantResponseMessage: {
                  content: "prior answer",
                  reasoningContent: {
                    reasoningText: { text: "signed reasoning", signature: "native signature" },
                  },
                },
              },
            ]),
          },
        });
      } finally {
        database.close();
      }
    },
  );

  test.each([
    { label: "legacy strict default", settings: {} },
    {
      label: "global strict overrides legacy opt-in",
      settings: {
        reasoning_replay_account_failover: "strict" as const,
        reasoning_replay_legacy_account_failover: "verified-current-cell" as const,
      },
    },
  ])("keeps authenticated database kr1 owner-bound under $label", async ({ settings }) => {
    let clientCalls = 0;
    const response = await runChatCompletion({
      body: reasoningReplayRequest(),
      model: "gpt-5.6-sol",
      stream: false,
      config: config(settings),
      accountManager: new PreferredAccountManager([
        account("account-a", { usedCount: 10_000, limitCount: 10_000 }),
        account("account-b"),
      ]),
      tokenRefresher: new FakeTokenRefresher(),
      tenantId: "tenant-a",
      reasoningReplayStore: reasoningReplayStore(
        "account-a",
        "conversation-a",
        undefined,
        {},
        false,
        true,
      ),
      makeClient: () => {
        clientCalls += 1;
        return clientWith(async () => responseFrom([]));
      },
    });

    expect(response.status).toBe(402);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "reasoning_replay_account_quota_exhausted" },
    });
    expect(clientCalls).toBe(0);
  });

  test.each([
    { label: "unverified model", model: "gpt-5.6-terra" },
    {
      label: "unverified owner region",
      owner: {
        region: "eu-west-1",
        profileArn: "arn:aws:codewhisperer:eu-west-1:123456789012:profile/account-a",
      },
    },
    { label: "owner without profile", owner: { profileArn: undefined } },
    { label: "legacy projection", projectionMode: "safe" as const },
    { label: "redacted reasoning", redacted: true },
    { label: "token prefix without authenticated database marker", databaseLegacy: false },
  ])("keeps opted-in kr1 owner-bound for $label", async (scenario) => {
    const body = {
      ...reasoningReplayRequest(),
      model: scenario.model ?? "gpt-5.6-sol",
      projectionMode: scenario.projectionMode ?? ("v3-auto" as const),
    };
    const store = reasoningReplayStore(
      "account-a",
      "conversation-a",
      undefined,
      {},
      false,
      scenario.databaseLegacy ?? true,
    );
    const replayStore: PipelineReasoningReplayStore = scenario.redacted
      ? {
          ...store,
          resolveResponses: (token, context, insertBeforeMessage) => ({
            ...store.resolveResponses(token, context, insertBeforeMessage),
            replay: {
              insertBeforeMessage,
              content: { kind: "redacted_content", bytes: Uint8Array.from([1, 2, 3]) },
            },
          }),
        }
      : store;
    let clientCalls = 0;
    const response = await runChatCompletion({
      body,
      model: body.model,
      stream: false,
      config: config({
        reasoning_replay_legacy_account_failover: "verified-current-cell",
      }),
      accountManager: new PreferredAccountManager([
        account("account-a", {
          usedCount: 10_000,
          limitCount: 10_000,
          ...scenario.owner,
        }),
        account("account-b"),
      ]),
      tokenRefresher: new FakeTokenRefresher(),
      tenantId: "tenant-a",
      reasoningReplayStore: replayStore,
      makeClient: () => {
        clientCalls += 1;
        return clientWith(async () => responseFrom([]));
      },
    });

    expect(response.status).toBe(402);
    expect(clientCalls).toBe(0);
  });

  test("fails over opted-in kr1 after an upstream quota rejection before acceptance", async () => {
    const selectedAccountIds: Array<string | undefined> = [];
    const manager = new PreferredAccountManager([account("account-a"), account("account-b")]);
    const response = await runChatCompletion({
      body: reasoningReplayRequest(),
      model: "gpt-5.6-sol",
      stream: false,
      config: config({ reasoning_replay_legacy_account_failover: "verified-current-cell" }),
      accountManager: manager,
      tokenRefresher: new FakeTokenRefresher(),
      tenantId: "tenant-a",
      reasoningReplayStore: reasoningReplayStore(
        "account-a",
        "conversation-a",
        undefined,
        {},
        false,
        true,
      ),
      makeClient: (...factoryArgs) => {
        selectedAccountIds.push(factoryArgs[5]);
        return clientWith(async () => {
          if (factoryArgs[5] === "account-a") throw sdkError(402, "quota exhausted");
          return responseFrom([{ assistantResponseEvent: { content: "continued after quota" } }]);
        });
      },
    });

    expect(response.status).toBe(200);
    expect(selectedAccountIds).toEqual(["account-a", "account-b"]);
    expect(manager.quotaExhausted).toEqual(["account-a"]);
  });

  test("never retries opted-in kr1 after a stream was accepted and then reports quota", async () => {
    const selectedAccountIds: Array<string | undefined> = [];
    const response = await runChatCompletion({
      body: { ...reasoningReplayRequest(), stream: true },
      model: "gpt-5.6-sol",
      stream: true,
      config: config({ reasoning_replay_legacy_account_failover: "verified-current-cell" }),
      accountManager: new PreferredAccountManager([account("account-a"), account("account-b")]),
      tokenRefresher: new FakeTokenRefresher(),
      tenantId: "tenant-a",
      reasoningReplayStore: reasoningReplayStore(
        "account-a",
        "conversation-a",
        undefined,
        {},
        false,
        true,
      ),
      makeClient: (...factoryArgs) => {
        selectedAccountIds.push(factoryArgs[5]);
        return clientWith(async () => ({
          generateAssistantResponseResponse: {
            async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
              yield { assistantResponseEvent: { content: "accepted output" } };
              throw sdkError(402, "quota exhausted");
            },
          },
        }));
      },
    });

    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toBeDefined();
    expect(selectedAccountIds).toEqual(["account-a"]);
  });

  test("keeps opted-in pre-release kr2 owner-bound outside the verified model cell", async () => {
    let clientCalls = 0;
    const response = await runChatCompletion({
      body: { ...reasoningReplayRequest(), model: "gpt-5.6-terra" },
      model: "gpt-5.6-terra",
      stream: false,
      config: config({
        reasoning_replay_account_failover: "verified",
        reasoning_replay_legacy_account_failover: "verified-current-cell",
      }),
      accountManager: new PreferredAccountManager([
        account("account-a", { usedCount: 10_000, limitCount: 10_000 }),
        account("account-b"),
      ]),
      tokenRefresher: new FakeTokenRefresher(),
      tenantId: "tenant-a",
      reasoningReplayStore: reasoningReplayStore(
        "account-a",
        "conversation-a",
        undefined,
        {},
        true,
      ),
      makeClient: () => {
        clientCalls += 1;
        return clientWith(async () => responseFrom([]));
      },
    });

    expect(response.status).toBe(402);
    expect(clientCalls).toBe(0);
  });

  test("keeps opted-in pre-release kr2 owner-bound on the legacy upstream operation", async () => {
    let clientCalls = 0;
    const response = await runChatCompletion({
      body: { ...reasoningReplayRequest(), projectionMode: "safe" },
      model: "gpt-5.6-sol",
      stream: false,
      config: config({
        reasoning_replay_account_failover: "verified",
        reasoning_replay_legacy_account_failover: "verified-current-cell",
      }),
      accountManager: new PreferredAccountManager([
        account("account-a", { usedCount: 10_000, limitCount: 10_000 }),
        account("account-b"),
      ]),
      tokenRefresher: new FakeTokenRefresher(),
      tenantId: "tenant-a",
      reasoningReplayStore: reasoningReplayStore(
        "account-a",
        "conversation-a",
        undefined,
        {},
        true,
      ),
      makeClient: () => {
        clientCalls += 1;
        return clientWith(async () => responseFrom([]));
      },
    });

    expect(response.status).toBe(402);
    expect(clientCalls).toBe(0);
  });

  test("strict replay replaces stale affinity with the signed owner conversation", async () => {
    const affinityStore = new AccountsDatabase(":memory:");
    try {
      affinityStore.claimSessionAffinity(
        "strict-affinity",
        "account-b",
        "conversation-b",
        Date.now(),
        60_000,
        100,
      );
      const conversations: string[] = [];
      const response = await runChatCompletion({
        body: reasoningReplayRequest(),
        model: "gpt-5.6-sol",
        stream: false,
        config: config({ reasoning_replay_account_failover: "strict" }),
        accountManager: new PreferredAccountManager([account("account-b"), account("account-a")]),
        tokenRefresher: new FakeTokenRefresher(),
        tenantId: "tenant-a",
        reasoningReplayStore: reasoningReplayStore("account-a", "conversation-a"),
        affinity: { keyHash: "strict-affinity", source: "responses.client_metadata.thread_id" },
        affinityStore,
        makeClient: () => ({
          async send(command): Promise<SdkStreamResponse> {
            conversations.push(
              String(
                (command.input.conversationState as { conversationId?: string }).conversationId,
              ),
            );
            return responseFrom([{ assistantResponseEvent: { content: "strict owner" } }]);
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(conversations).toEqual(["conversation-a"]);
      expect(affinityStore.getSessionAffinity("strict-affinity")).toMatchObject({
        accountId: "account-a",
        conversationId: "conversation-a",
      });
    } finally {
      affinityStore.close();
    }
  });

  test("does not infer Sol migration provenance from a legacy replay", async () => {
    const selectedAccountIds: Array<string | undefined> = [];
    const response = await runChatCompletion({
      body: reasoningReplayRequest(),
      model: "gpt-5.6-sol",
      stream: false,
      config: config({ reasoning_replay_account_failover: "verified" }),
      accountManager: new PreferredAccountManager([
        account("account-a", { usedCount: 10_000, limitCount: 10_000 }),
        account("account-b", { usedCount: 1, limitCount: 10_000 }),
      ]),
      tokenRefresher: new FakeTokenRefresher(),
      tenantId: "tenant-a",
      reasoningReplayStore: reasoningReplayStore("account-a", "conversation-a"),
      makeClient: (...factoryArgs) => {
        selectedAccountIds.push(factoryArgs[5]);
        return clientWith(async () =>
          responseFrom([{ assistantResponseEvent: { content: "legacy migrated" } }]),
        );
      },
    });

    expect(response.status).toBe(402);
    expect(selectedAccountIds).toEqual([]);
  });

  test("migrates provenance-authenticated Claude Messages replay in its verified cell", async () => {
    const selectedAccountIds: Array<string | undefined> = [];
    const response = await runChatCompletion({
      body: anthropicReasoningReplayRequest(),
      model: "claude-sonnet-5",
      stream: false,
      config: config({ reasoning_replay_account_failover: "verified" }),
      accountManager: new PreferredAccountManager([
        account("account-a", { usedCount: 10_000, limitCount: 10_000 }),
        account("account-b", { usedCount: 1, limitCount: 10_000 }),
      ]),
      tokenRefresher: new FakeTokenRefresher(),
      tenantId: "tenant-a",
      reasoningReplayStore: reasoningReplayStore(
        "account-a",
        "conversation-a",
        "anthropic-messages",
      ),
      makeClient: (...factoryArgs) => {
        selectedAccountIds.push(factoryArgs[5]);
        return clientWith(async () =>
          responseFrom([{ assistantResponseEvent: { content: "messages migrated" } }]),
        );
      },
    });

    expect(response.status).toBe(200);
    expect(selectedAccountIds).toEqual(["account-b"]);
  });

  test("migrates an opted-in pre-release kr2 Messages replay in its verified cell", async () => {
    const selectedAccountIds: Array<string | undefined> = [];
    const response = await runChatCompletion({
      body: anthropicReasoningReplayRequest(),
      model: "claude-sonnet-5",
      stream: false,
      config: config({
        reasoning_replay_account_failover: "verified",
        reasoning_replay_legacy_account_failover: "verified-current-cell",
      }),
      accountManager: new PreferredAccountManager([
        account("account-a", { usedCount: 10_000, limitCount: 10_000 }),
        account("account-b", { usedCount: 1, limitCount: 10_000 }),
      ]),
      tokenRefresher: new FakeTokenRefresher(),
      tenantId: "tenant-a",
      reasoningReplayStore: reasoningReplayStore(
        "account-a",
        "conversation-a",
        undefined,
        {},
        true,
      ),
      makeClient: (...factoryArgs) => {
        selectedAccountIds.push(factoryArgs[5]);
        return clientWith(async () =>
          responseFrom([{ assistantResponseEvent: { content: "messages legacy migrated" } }]),
        );
      },
    });

    expect(response.status).toBe(200);
    expect(selectedAccountIds).toEqual(["account-b"]);
  });

  test("keeps an unverified Terra legacy replay owner-bound", async () => {
    const body = { ...reasoningReplayRequest(), model: "gpt-5.6-terra" };
    let clientCalls = 0;
    const response = await runChatCompletion({
      body,
      model: "gpt-5.6-terra",
      stream: false,
      config: config({ reasoning_replay_account_failover: "verified" }),
      accountManager: new PreferredAccountManager([
        account("account-a", { usedCount: 10_000, limitCount: 10_000 }),
        account("account-b", { usedCount: 1, limitCount: 10_000 }),
      ]),
      tokenRefresher: new FakeTokenRefresher(),
      tenantId: "tenant-a",
      reasoningReplayStore: reasoningReplayStore("account-a", "conversation-a"),
      makeClient: () => {
        clientCalls += 1;
        return clientWith(async () => responseFrom([]));
      },
    });

    expect(response.status).toBe(402);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "reasoning_replay_account_quota_exhausted" },
    });
    expect(clientCalls).toBe(0);
  });

  test("returns a typed 402 when the replay-bound account exhausted quota", async () => {
    let clientCalls = 0;
    const response = await runChatCompletion({
      body: reasoningReplayRequest(),
      model: "gpt-5.6-sol",
      stream: false,
      config: config({ reasoning_replay_account_failover: "strict" }),
      accountManager: new PreferredAccountManager([
        account("account-a", { usedCount: 10_000, limitCount: 10_000 }),
        account("account-b", { usedCount: 1, limitCount: 10_000 }),
      ]),
      tokenRefresher: new FakeTokenRefresher(),
      tenantId: "tenant-a",
      reasoningReplayStore: reasoningReplayStore("account-a", "conversation-a"),
      makeClient: () => {
        clientCalls += 1;
        return clientWith(async () => responseFrom([]));
      },
    });

    expect(response.status).toBe(402);
    expect(await errorBody(response)).toMatchObject({
      error: {
        type: "insufficient_quota",
        code: "reasoning_replay_account_quota_exhausted",
      },
    });
    expect(clientCalls).toBe(0);
  });

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
      config: config({ reasoning_replay_account_failover: "strict" }),
      accountManager: new PreferredAccountManager([account("account-b"), account("account-a")]),
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

  test("waits the replay-bound account then returns a typed 429 without switching", async () => {
    const selectedAccountIds: Array<string | undefined> = [];
    const response = await runChatCompletion({
      body: reasoningReplayRequest(),
      model: "gpt-5.6-sol",
      stream: false,
      config: config({ reasoning_replay_account_failover: "strict" }),
      accountManager: new PreferredAccountManager([account("account-b"), account("account-a")]),
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

    expect(response.status).toBe(429);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "reasoning_replay_account_rate_limited" },
    });
    expect(new Set(selectedAccountIds)).toEqual(new Set(["account-a"]));
  });

  test("returns typed authentication failure when replay owner rejects a forced refresh", async () => {
    const manager = new PreferredAccountManager([account("account-b"), account("account-a")]);
    const selectedAccountIds: Array<string | undefined> = [];
    const response = await runChatCompletion({
      body: reasoningReplayRequest(),
      model: "gpt-5.6-sol",
      stream: false,
      config: config({ reasoning_replay_account_failover: "strict" }),
      accountManager: manager,
      tokenRefresher: new FakeTokenRefresher(),
      tenantId: "tenant-a",
      reasoningReplayStore: reasoningReplayStore("account-a", "conversation-a"),
      makeClient: (...factoryArgs) => {
        selectedAccountIds.push(factoryArgs[5]);
        return clientWith(async () => {
          throw sdkError(401, "expired bearer token");
        });
      },
    });

    expect(response.status).toBe(403);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "reasoning_replay_account_reauthentication_required" },
    });
    expect(new Set(selectedAccountIds)).toEqual(new Set(["account-a"]));
    expect(manager.unhealthy).toEqual(["account-a"]);
  });

  test("returns typed authentication failure when replay owner forced refresh itself fails", async () => {
    const manager = new PreferredAccountManager([account("account-b"), account("account-a")]);
    const refresher = new FakeTokenRefresher();
    refresher.forceHandler = async () => {
      throw new KiroTokenRefreshError("Refresh failed: invalid_grant", "invalid_grant");
    };
    let sends = 0;
    const response = await runChatCompletion({
      body: reasoningReplayRequest(),
      model: "gpt-5.6-sol",
      stream: false,
      config: config({ reasoning_replay_account_failover: "strict" }),
      accountManager: manager,
      tokenRefresher: refresher,
      tenantId: "tenant-a",
      reasoningReplayStore: reasoningReplayStore("account-a", "conversation-a"),
      makeClient: () =>
        clientWith(async () => {
          sends += 1;
          throw sdkError(401, "expired bearer token");
        }),
    });

    expect(response.status).toBe(403);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "reasoning_replay_account_reauthentication_required" },
    });
    expect(sends).toBe(1);
    expect(refresher.forceSignals).toHaveLength(1);
    expect(manager.unhealthy).toEqual(["account-a"]);
  });

  test("returns typed refresh failure after the replay owner exhausts its network retry", async () => {
    const refresher = new FakeTokenRefresher();
    refresher.refreshHandler = async () => {
      throw new KiroTokenRefreshError("Token refresh failed: fetch failed", "NETWORK_ERROR");
    };
    let sends = 0;
    const response = await runChatCompletion({
      body: reasoningReplayRequest(),
      model: "gpt-5.6-sol",
      stream: false,
      config: config({
        reasoning_replay_account_failover: "strict",
        rate_limit_retry_delay_ms: 1,
      }),
      accountManager: new PreferredAccountManager([account("account-b"), account("account-a")]),
      tokenRefresher: refresher,
      tenantId: "tenant-a",
      reasoningReplayStore: reasoningReplayStore("account-a", "conversation-a"),
      makeClient: () => {
        sends += 1;
        return clientWith(async () => responseFrom([]));
      },
    });

    expect(response.status).toBe(503);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "reasoning_replay_account_refresh_failed" },
    });
    expect(refresher.refreshSignals).toHaveLength(2);
    expect(sends).toBe(0);
  });

  test("keeps forced-refresh transport failure distinct from owner unavailability", async () => {
    const refresher = new FakeTokenRefresher();
    refresher.forceHandler = async () => {
      throw new KiroTokenRefreshError("Token refresh failed: fetch failed", "NETWORK_ERROR");
    };
    let sends = 0;
    const response = await runChatCompletion({
      body: reasoningReplayRequest(),
      model: "gpt-5.6-sol",
      stream: false,
      config: config({ reasoning_replay_account_failover: "strict" }),
      accountManager: new PreferredAccountManager([account("account-b"), account("account-a")]),
      tokenRefresher: refresher,
      tenantId: "tenant-a",
      reasoningReplayStore: reasoningReplayStore("account-a", "conversation-a"),
      makeClient: () =>
        clientWith(async () => {
          sends += 1;
          throw sdkError(401, "expired bearer token");
        }),
    });

    expect(response.status).toBe(503);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "reasoning_replay_account_refresh_failed" },
    });
    expect(sends).toBe(1);
    expect(refresher.forceSignals).toHaveLength(1);
  });

  test("reports a replay owner removed during forced refresh as unavailable", async () => {
    const refresher = new FakeTokenRefresher();
    refresher.forceHandler = async (selected) => {
      throw new AccountUnavailableError(selected.id);
    };
    const response = await runChatCompletion({
      body: reasoningReplayRequest(),
      model: "gpt-5.6-sol",
      stream: false,
      config: config({ reasoning_replay_account_failover: "strict" }),
      accountManager: new PreferredAccountManager([account("account-b"), account("account-a")]),
      tokenRefresher: refresher,
      tenantId: "tenant-a",
      reasoningReplayStore: reasoningReplayStore("account-a", "conversation-a"),
      makeClient: () =>
        clientWith(async () => {
          throw sdkError(401, "expired bearer token");
        }),
    });

    expect(response.status).toBe(503);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "reasoning_replay_account_unavailable" },
    });
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

    // Then: the per-attempt send signal fires together with the ingress signal
    expect(capturedSignal?.aborted).toBe(true);
    expect(capturedSignal).not.toBe(controller.signal);
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
        clientWith(async () => exactResponse([{ assistantResponseEvent: { content: "partial" } }])),
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
    const capabilities = new ModelCapabilityService(config(), async (details) => ({
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
    }));
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
      accountManager: new FakeAccountManager([account("account-a"), account("account-b")]),
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
      const manager = new PreferredAccountManager([account("account-a"), account("account-b")]);
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

  test("switches to another account when token refresh fails before the upstream call", async () => {
    // Given
    const dead = account("account-a");
    const healthy = account("account-b");
    const manager = new FakeAccountManager([dead, healthy], "sticky");
    const refresher = new FakeTokenRefresher();
    refresher.refreshHandler = async (selected) => {
      if (selected.id === dead.id) {
        throw new KiroTokenRefreshError("Refresh failed: invalid_grant", "invalid_grant");
      }
      return selected;
    };
    const sentAccounts: string[] = [];

    // When
    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: manager,
      tokenRefresher: refresher,
      makeClient: (auth) =>
        clientWith(async () => {
          sentAccounts.push(auth.email ?? "missing");
          return responseFrom([{ assistantResponseEvent: { content: "fallback" } }]);
        }),
    });

    // Then
    expect(response.status).toBe(200);
    expect(sentAccounts).toEqual([healthy.email]);
    expect(manager.unhealthy).toEqual([dead.id]);
    expect(dead.unhealthyReason).toContain("invalid_grant");
    expect(manager.rateLimited).toEqual([]);
  });

  test("returns 503 when the only account's token refresh fails", async () => {
    // Given
    const refresher = new FakeTokenRefresher();
    refresher.refreshHandler = async () => {
      throw new KiroTokenRefreshError("Refresh failed: invalid_grant", "invalid_grant");
    };
    let clientCalls = 0;

    // When
    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([account("account-a")]),
      tokenRefresher: refresher,
      makeClient: () => {
        clientCalls += 1;
        return clientWith(async () => responseFrom([]));
      },
    });

    // Then
    expect(response.status).toBe(503);
    expect(clientCalls).toBe(0);
    expect(await errorBody(response)).toEqual({
      error: {
        message: "Token refresh failed for every usable Kiro account",
        type: "service_unavailable",
        code: "upstream_token_refresh_failed",
      },
    });
  });

  test("retries a transient refresh network error once on the same account", async () => {
    // Given
    const only = account("account-a");
    const manager = new FakeAccountManager([only]);
    const refresher = new FakeTokenRefresher();
    let refreshCalls = 0;
    refresher.refreshHandler = async (selected) => {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        throw new KiroTokenRefreshError("Token refresh failed: fetch failed", "NETWORK_ERROR");
      }
      return selected;
    };

    // When
    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: manager,
      tokenRefresher: refresher,
      makeClient: () =>
        clientWith(async () => responseFrom([{ assistantResponseEvent: { content: "ok" } }])),
    });

    // Then
    expect(response.status).toBe(200);
    expect(refreshCalls).toBe(2);
    expect(manager.rateLimited).toEqual([]);
    expect(manager.unhealthy).toEqual([]);
  });

  test("rate-limits, not kills, an account whose refresh keeps failing on the network and switches", async () => {
    // Given
    const flaky = account("account-a");
    const healthy = account("account-b");
    const manager = new FakeAccountManager([flaky, healthy], "sticky");
    const refresher = new FakeTokenRefresher();
    refresher.refreshHandler = async (selected) => {
      if (selected.id === flaky.id) {
        throw new KiroTokenRefreshError("Token refresh failed: fetch failed", "NETWORK_ERROR");
      }
      return selected;
    };
    const sentAccounts: string[] = [];

    // When
    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: manager,
      tokenRefresher: refresher,
      makeClient: (auth) =>
        clientWith(async () => {
          sentAccounts.push(auth.email ?? "missing");
          return responseFrom([{ assistantResponseEvent: { content: "fallback" } }]);
        }),
    });

    // Then
    expect(response.status).toBe(200);
    expect(sentAccounts).toEqual([healthy.email]);
    expect(manager.rateLimited).toEqual([flaky.id]);
    expect(manager.unhealthy).toEqual([]);
    expect(flaky.isHealthy).toBe(true);
    expect(flaky.rateLimitResetTime).toBeGreaterThan(Date.now() - 1_000);
  });

  test("switches accounts when the forced refresh after an invalid bearer fails", async () => {
    // Given
    const stale = account("account-a");
    const healthy = account("account-b");
    const manager = new FakeAccountManager([stale, healthy], "sticky");
    const refresher = new FakeTokenRefresher();
    refresher.forceHandler = async () => {
      throw new KiroTokenRefreshError("Refresh failed: invalid_grant", "invalid_grant");
    };
    const sentAccounts: string[] = [];

    // When
    const response = await runChatCompletion({
      body: REQUEST_BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: manager,
      tokenRefresher: refresher,
      makeClient: (auth) =>
        clientWith(async () => {
          sentAccounts.push(auth.email ?? "missing");
          if (auth.email === stale.email) {
            throw sdkError(403, "The bearer token included in the request is invalid");
          }
          return responseFrom([{ assistantResponseEvent: { content: "fallback" } }]);
        }),
    });

    // Then
    expect(response.status).toBe(200);
    expect(sentAccounts).toEqual([stale.email, healthy.email]);
    expect(refresher.forceSignals).toHaveLength(1);
    expect(manager.unhealthy).toEqual([stale.id]);
  });

  test("maps an unexpected internal error to a fixed message with an audited request id", async () => {
    // Given
    const refresher = new FakeTokenRefresher();
    refresher.refreshHandler = async () => {
      throw new RangeError("refresh state is corrupt /home/op/.config/kiro-provider/accounts.db");
    };
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);

    // When
    let response: Response;
    let events: Record<string, unknown>[];
    try {
      response = await runChatCompletion({
        body: REQUEST_BODY,
        model: "auto",
        stream: false,
        config: config(),
        accountManager: new FakeAccountManager([account("account-a")]),
        tokenRefresher: refresher,
        makeClient: () => clientWith(async () => responseFrom([])),
      });
      events = consoleError.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .filter((event) => event.event === "pipeline_internal_error");
    } finally {
      consoleError.mockRestore();
    }

    // Then: the client sees a fixed message, a stable code, and a correlation id
    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      error: { message: string; type: string; code?: string; request_id?: string };
    };
    expect(body.error).toEqual({
      message: expect.stringMatching(/^Internal server error \(request_id: req_/),
      type: "internal_error",
      code: "internal_error",
      request_id: expect.stringMatching(/^req_[0-9a-f-]{36}$/),
    });
    expect(body.error.message).not.toContain("accounts.db");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: "error",
      request_id: body.error.request_id,
      error_type: "RangeError",
      error_code: "RangeError",
      error_message_hash: auditHash(
        "refresh state is corrupt /home/op/.config/kiro-provider/accounts.db",
      ),
    });
    expect(JSON.stringify(events[0])).not.toContain("accounts.db");
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
