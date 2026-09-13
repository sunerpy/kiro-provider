import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import {
  type PipelineAccountManager,
  type PipelineClientFactory,
  type PipelineTokenRefresher,
  runChatCompletion,
} from "../src/core/pipeline.js";
import type {
  SdkStreamEvent,
  SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import { canonicalRequest, message } from "./canonical-test-helpers.js";

/**
 * Once upstream accepts a stream, failures must terminate that generation.
 * Non-stream collection retains its separate pre-publication retry budget.
 */

const BODY = canonicalRequest([message("user", "hello")], { model: "auto" });
const COMPLETION: SdkStreamEvent = {
  metadataEvent: { tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
};

function account(id: string): ManagedAccount {
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
  };
}

/** Honors the preferred account like the production selector; otherwise first selectable. */
class PreferredAccountManager implements PipelineAccountManager {
  readonly rateLimited: string[] = [];
  readonly unhealthy: string[] = [];

  constructor(readonly accounts: ManagedAccount[]) {}

  reconcileFromDb(): readonly ManagedAccount[] {
    return this.accounts;
  }

  selectHealthyAccount(
    preferredAccountId?: string,
    eligibleAccountIds?: ReadonlySet<string>,
  ): ManagedAccount | null {
    const now = Date.now();
    const selectable = this.accounts.filter(
      (candidate) =>
        candidate.isHealthy &&
        candidate.rateLimitResetTime <= now &&
        (eligibleAccountIds?.has(candidate.id) ?? true),
    );
    return (
      selectable.find((candidate) => candidate.id === preferredAccountId) ?? selectable[0] ?? null
    );
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

  markRateLimited(selected: ManagedAccount): void {
    this.rateLimited.push(selected.id);
  }

  markUnhealthy(selected: ManagedAccount): void {
    this.unhealthy.push(selected.id);
  }
}

const refresher: PipelineTokenRefresher = {
  refreshIfNeeded: async (selected) => selected,
  forceRefresh: async (selected) => selected,
};

function config(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    api_keys: ["sk-test"],
    request_timeout_ms: 5_000,
    stream_idle_timeout_ms: 1_000,
    rate_limit_retry_delay_ms: 1,
    rate_limit_max_retries: 0,
    ...overrides,
  });
}

function eventsResponse(events: readonly SdkStreamEvent[]): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
        for (const event of events) yield event;
      },
    },
  };
}

function okResponse(text = "answer"): SdkStreamResponse {
  return eventsResponse([{ assistantResponseEvent: { content: text } }, COMPLETION]);
}

/** Clean EOF without any event: `upstream_stream_incomplete` (retryable). */
function eofResponse(): SdkStreamResponse {
  return eventsResponse([]);
}

/** The SDK reader rejects before producing any event: `upstream_stream_error` (retryable). */
function rejectingResponse(): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      [Symbol.asyncIterator](): AsyncIterator<SdkStreamEvent> {
        return {
          next: () => Promise.reject(new TypeError("socket hang up")),
          return: () => Promise.resolve({ done: true, value: undefined }),
        };
      },
    },
  };
}

function failAfterTextResponse(): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
        yield { assistantResponseEvent: { content: "partial" } };
        throw new TypeError("socket hang up");
      },
    },
  };
}

function stalledResponse(): {
  readonly response: SdkStreamResponse;
  readonly state: { returns: number };
} {
  const state = { returns: 0 };
  return {
    state,
    response: {
      generateAssistantResponseResponse: {
        [Symbol.asyncIterator](): AsyncIterator<SdkStreamEvent> {
          return {
            next: () => new Promise<IteratorResult<SdkStreamEvent>>(() => undefined),
            return: () => {
              state.returns += 1;
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      },
    },
  };
}

function scriptedClient(scripts: readonly (() => SdkStreamResponse)[]): {
  readonly makeClient: PipelineClientFactory;
  readonly sends: string[];
  readonly sendSignals: AbortSignal[];
} {
  const sends: string[] = [];
  const sendSignals: AbortSignal[] = [];
  const makeClient: PipelineClientFactory = (
    _auth,
    _region,
    _effort,
    _endpoint,
    _proxy,
    accountId,
  ) => ({
    async send(_command, options) {
      const script = scripts[Math.min(sends.length, scripts.length - 1)];
      sends.push(accountId ?? "");
      sendSignals.push(options.abortSignal);
      if (!script) throw new TypeError("no scripted response");
      return script();
    },
  });
  return { makeClient, sends, sendSignals };
}

async function errorBody(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  return body.error;
}

let audit: ReturnType<typeof captureAuditEvents>;

beforeEach(() => {
  audit = captureAuditEvents();
});

afterEach(() => {
  audit.restore();
});

describe("accepted stream failures never replay generation", () => {
  for (const maxAttempts of [1, 3]) {
    test(`EOF after acceptance does not retry with stream_max_attempts=${maxAttempts}`, async () => {
      const scripted = scriptedClient([() => eofResponse(), () => okResponse("must not appear")]);
      const manager = new PreferredAccountManager([account("account-a"), account("account-b")]);
      const response = await runChatCompletion({
        body: BODY,
        model: "auto",
        stream: true,
        config: config({ stream_max_attempts: maxAttempts }),
        accountManager: manager,
        tokenRefresher: refresher,
        makeClient: scripted.makeClient,
      });
      expect(response.status).toBe(200);
      await expect(response.text()).rejects.toMatchObject({ code: "upstream_stream_incomplete" });
      expect(scripted.sends).toEqual(["account-a"]);
      expect(scripted.sendSignals[0]?.aborted).toBe(true);
      expect(audit.events("sdk_stream_attempt_retry")).toEqual([]);
      expect(manager.rateLimited).toEqual([]);
      expect(manager.unhealthy).toEqual([]);
    });
  }

  test("a decoder error after HTTP acceptance remains an observable stream failure", async () => {
    const scripted = scriptedClient([() => rejectingResponse(), () => okResponse()]);
    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: true,
      config: config(),
      accountManager: new PreferredAccountManager([account("account-a")]),
      tokenRefresher: refresher,
      makeClient: scripted.makeClient,
    });
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toMatchObject({ message: "socket hang up" });
    expect(scripted.sends).toEqual(["account-a"]);
    expect(audit.events("sdk_stream_attempt_retry")).toEqual([]);
  });

  test("partial text is never concatenated with a replacement generation", async () => {
    const scripted = scriptedClient([() => failAfterTextResponse(), () => okResponse()]);
    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: true,
      config: config(),
      accountManager: new PreferredAccountManager([account("account-a"), account("account-b")]),
      tokenRefresher: refresher,
      makeClient: scripted.makeClient,
    });
    const reader = response.body?.getReader();
    if (!reader) throw new TypeError("streaming response must have a body");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"started"');
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("partial");
    await expect(reader.read()).rejects.toMatchObject({ message: "socket hang up" });
    expect(scripted.sends).toEqual(["account-a"]);
  });

  test("a fatal embedded event keeps its code without retrying", async () => {
    const scripted = scriptedClient([
      () => eventsResponse([{ invalidStateEvent: { reason: "x" } }, COMPLETION]),
      () => okResponse(),
    ]);
    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: true,
      config: config(),
      accountManager: new PreferredAccountManager([account("account-a")]),
      tokenRefresher: refresher,
      makeClient: scripted.makeClient,
    });
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toMatchObject({ code: "upstream_invalid_state" });
    expect(scripted.sends).toEqual(["account-a"]);
  });

  test("a deadline after acceptance terminates and cleans the stream without retrying", async () => {
    const stalled = stalledResponse();
    const scripted = scriptedClient([() => stalled.response, () => okResponse()]);
    const deadline = new AbortController();
    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: true,
      config: config(),
      accountManager: new PreferredAccountManager([account("account-a")]),
      tokenRefresher: refresher,
      deadlineSignal: deadline.signal,
      makeClient: scripted.makeClient,
    });
    const reading = response.text();
    deadline.abort(new DOMException("Request deadline exceeded", "TimeoutError"));
    expect(response.status).toBe(200);
    await expect(reading).rejects.toMatchObject({ name: "TimeoutError" });
    await Bun.sleep(1);
    expect(scripted.sends).toEqual(["account-a"]);
    expect(scripted.sendSignals[0]?.aborted).toBe(true);
    expect(stalled.state.returns).toBe(1);
    expect(audit.events("sdk_stream_attempt_retry")).toEqual([]);
  });

  test("transport idle after acceptance is explicit and never retries", async () => {
    const stalled = stalledResponse();
    const scripted = scriptedClient([() => stalled.response, () => okResponse()]);
    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: true,
      config: config({ stream_idle_timeout_ms: 20 }),
      accountManager: new PreferredAccountManager([account("account-a")]),
      tokenRefresher: refresher,
      makeClient: scripted.makeClient,
    });
    await expect(response.text()).rejects.toMatchObject({ code: "upstream_stream_idle_timeout" });
    await Bun.sleep(1);
    expect(scripted.sends).toEqual(["account-a"]);
    expect(stalled.state.returns).toBe(1);
    expect(audit.events("sdk_stream_attempt_retry")).toEqual([]);
    expect(audit.events("sdk_stream_idle_timeout")).toEqual([
      expect.objectContaining({ idle_timeout_ms: 20 }),
    ]);
  });
});

describe("pre-publication stream retry (non-stream)", () => {
  test("retries a failure before any semantic event then returns the replacement", async () => {
    const scripted = scriptedClient([() => rejectingResponse(), () => okResponse("recovered")]);

    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: new PreferredAccountManager([account("account-a")]),
      tokenRefresher: refresher,
      makeClient: scripted.makeClient,
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { text: string }).text).toBe("recovered");
    expect(scripted.sends).toEqual(["account-a", "account-a"]);
    expect(audit.events("sdk_stream_attempt_retry")).toEqual([
      expect.objectContaining({ same_account: true, mode: "non-stream" }),
    ]);
  });

  test("returns the failure code once stream_max_attempts is exhausted", async () => {
    const scripted = scriptedClient([() => rejectingResponse()]);

    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: false,
      config: config({ stream_max_attempts: 2 }),
      accountManager: new PreferredAccountManager([account("account-a")]),
      tokenRefresher: refresher,
      makeClient: scripted.makeClient,
    });

    expect(response.status).toBe(502);
    expect(await errorBody(response)).toMatchObject({
      type: "upstream_error",
      code: "upstream_stream_error",
      message: "Upstream stream error",
    });
    expect(scripted.sends).toHaveLength(2);
    expect(audit.events("sdk_stream_attempts_exhausted")).toHaveLength(1);
  });

  test("a failure after semantic output keeps the rate_limit_max_retries bound", async () => {
    const scripted = scriptedClient([() => failAfterTextResponse(), () => okResponse()]);

    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: false,
      config: config({ rate_limit_max_retries: 0 }),
      accountManager: new PreferredAccountManager([account("account-a")]),
      tokenRefresher: refresher,
      makeClient: scripted.makeClient,
    });

    expect(response.status).toBe(500);
    expect(scripted.sends).toHaveLength(1);
    expect(audit.events("sdk_stream_attempt_retry")).toEqual([]);
  });
});
