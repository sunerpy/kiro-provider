import { describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import {
  type PipelineAccountManager,
  type PipelineSdkClient,
  type PipelineTokenRefresher,
  runChatCompletion,
} from "../src/core/pipeline.js";
import type {
  SdkStreamEvent,
  SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import { canonicalRequest, message } from "./canonical-test-helpers.js";

/**
 * B3: the classifier's accountCount must count SELECTABLE alternatives, and
 * when nothing is selectable only because of short rate limits the request
 * waits for the earliest reset (within its deadline) instead of failing 503.
 */

const BODY = canonicalRequest([message("user", "hello")], { model: "auto" });

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
      selectable.find((candidate) => candidate.id === preferredAccountId) ??
      selectable[0] ??
      null
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

  markRateLimited(selected: ManagedAccount, resetTime: number): void {
    selected.rateLimitResetTime = resetTime;
    this.rateLimited.push(selected.id);
  }

  markUnhealthy(selected: ManagedAccount, reason: string): void {
    selected.isHealthy = false;
    selected.unhealthyReason = reason;
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
    ...overrides,
  });
}

function responseFrom(events: readonly SdkStreamEvent[]): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
        for (const event of events) yield event;
        yield {
          metadataEvent: { tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        };
      },
    },
  };
}

function sdkError(status: number, message: string, retryAfterSeconds?: string): unknown {
  return {
    name: "SdkError",
    message,
    $metadata: { httpStatusCode: status },
    ...(retryAfterSeconds === undefined
      ? {}
      : { $response: { headers: { "retry-after": retryAfterSeconds } } }),
  };
}

function clientFor(
  handler: (auth: KiroAuthDetails) => Promise<SdkStreamResponse>,
): (auth: KiroAuthDetails) => PipelineSdkClient {
  return (auth) => ({ send: () => handler(auth) });
}

async function errorBody(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  return body.error;
}

describe("rate-limit aware failover (B3)", () => {
  test("a 429 retries the same account when the only other account is rate-limited", async () => {
    // Given: B is rate-limited for a long time, so A has no real alternative
    const first = account("account-a");
    const second = account("account-b", { rateLimitResetTime: Date.now() + 600_000 });
    const manager = new FakeAccountManager([first, second]);
    const sent: string[] = [];

    // When: A is throttled once with a tiny retry-after, then succeeds
    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: manager,
      tokenRefresher: refresher,
      makeClient: clientFor(async (auth) => {
        sent.push(auth.email ?? "missing");
        if (sent.length === 1) throw sdkError(429, "rate limited", "0");
        return responseFrom([{ assistantResponseEvent: { content: "ok" } }]);
      }),
    });

    // Then: no switch, no 503, the same account served the retry
    expect(response.status).toBe(200);
    expect(sent).toEqual([first.email, first.email]);
    expect(manager.rateLimited).toEqual([]);
  });

  test("waits for the shortest rate-limit reset instead of returning 503", async () => {
    // Given: every account is rate-limited, the earliest reset is ~60ms away
    const first = account("account-a", { rateLimitResetTime: Date.now() + 60 });
    const second = account("account-b", { rateLimitResetTime: Date.now() + 5_000 });
    const manager = new FakeAccountManager([first, second]);
    const sent: string[] = [];
    const startedAt = Date.now();

    // When
    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: manager,
      tokenRefresher: refresher,
      makeClient: clientFor(async (auth) => {
        sent.push(auth.email ?? "missing");
        return responseFrom([{ assistantResponseEvent: { content: "after wait" } }]);
      }),
    });

    // Then
    expect(response.status).toBe(200);
    expect(sent).toEqual([first.email]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
  });

  test("returns 503 when the shortest reset does not fit the request deadline", async () => {
    // Given
    const only = account("account-a", { rateLimitResetTime: Date.now() + 60_000 });
    let sends = 0;

    // When
    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: false,
      config: config({ request_timeout_ms: 500 }),
      accountManager: new FakeAccountManager([only]),
      tokenRefresher: refresher,
      makeClient: clientFor(async () => {
        sends += 1;
        return responseFrom([]);
      }),
    });

    // Then
    expect(response.status).toBe(503);
    expect(sends).toBe(0);
    expect(await errorBody(response)).toMatchObject({ code: "no_healthy_accounts" });
  });

  test("does not wait for an account that is unhealthy rather than rate-limited", async () => {
    // Given
    const dead = account("account-a", {
      isHealthy: false,
      rateLimitResetTime: Date.now() + 50,
      unhealthyReason: "InvalidTokenException: dead",
    });
    const startedAt = Date.now();

    // When
    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([dead]),
      tokenRefresher: refresher,
      makeClient: clientFor(async () => responseFrom([])),
    });

    // Then
    expect(response.status).toBe(503);
    expect(Date.now() - startedAt).toBeLessThan(40);
  });

  test("prefers the manager's own selectable count when it is provided", async () => {
    // Given: the manager reports zero alternatives even though a second account row exists
    const first = account("account-a");
    const second = account("account-b");
    const manager = new FakeAccountManager([first, second]);
    let countCalls = 0;
    const counting: PipelineAccountManager = Object.assign(manager, {
      countSelectableAccounts: (eligible: ReadonlySet<string>) => {
        countCalls += 1;
        expect([...eligible].sort()).toEqual(["account-a", "account-b"]);
        return 1;
      },
    });
    const sent: string[] = [];

    // When
    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: counting,
      tokenRefresher: refresher,
      makeClient: clientFor(async (auth) => {
        sent.push(auth.email ?? "missing");
        if (sent.length === 1) throw sdkError(429, "rate limited", "0");
        return responseFrom([{ assistantResponseEvent: { content: "ok" } }]);
      }),
    });

    // Then: classified as single-account retry, not switch
    expect(response.status).toBe(200);
    expect(countCalls).toBe(1);
    expect(sent).toEqual([first.email, first.email]);
  });
});
