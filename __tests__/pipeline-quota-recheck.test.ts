import { describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import {
  type PipelineAccountManager,
  type PipelineQuotaRechecker,
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
 * B6: the authoritative quota recheck runs in the background whenever the
 * request has a usable account; it is awaited only when nothing selectable
 * remains (or a replay-locked account is exhausted).
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
  constructor(readonly accounts: ManagedAccount[]) {}

  reconcileFromDb(): readonly ManagedAccount[] {
    return this.accounts;
  }

  selectHealthyAccount(
    _preferredAccountId?: string,
    eligibleAccountIds?: ReadonlySet<string>,
  ): ManagedAccount | null {
    const now = Date.now();
    return (
      this.accounts.find(
        (candidate) =>
          candidate.isHealthy &&
          candidate.rateLimitResetTime <= now &&
          (eligibleAccountIds?.has(candidate.id) ?? true),
      ) ?? null
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

function responseFrom(text: string): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
        yield { assistantResponseEvent: { content: text } };
        yield {
          metadataEvent: { tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        };
      },
    },
  };
}

function client(sent: string[]): (auth: KiroAuthDetails) => PipelineSdkClient {
  return (auth) => ({
    async send() {
      sent.push(auth.email ?? "missing");
      return responseFrom("answer");
    },
  });
}

function exhausted(id: string): ManagedAccount {
  return account(id, { usedCount: 100, limitCount: 100, rateLimitResetTime: 0 });
}

function restore(target: ManagedAccount): void {
  target.usedCount = 0;
  target.overageCount = 0;
  target.rateLimitResetTime = 0;
}

describe("quota recheck placement (B6)", () => {
  test("a hanging usage probe does not delay a request when a healthy account exists", async () => {
    // Given: one due exhausted account and one healthy account
    const stuck = exhausted("account-a");
    const healthy = account("account-b");
    let recheckCalls = 0;
    let recheckSignal: AbortSignal | undefined;
    const rechecker: PipelineQuotaRechecker = {
      recheckDueAccounts(_accounts, signal): Promise<void> {
        recheckCalls += 1;
        recheckSignal = signal;
        return new Promise<void>(() => undefined);
      },
      async syncDueAccounts(): Promise<void> {},
    };
    const sent: string[] = [];
    const startedAt = Date.now();

    // When
    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([stuck, healthy]),
      tokenRefresher: refresher,
      quotaRechecker: rechecker,
      makeClient: client(sent),
    });

    // Then: served by B immediately, probe still running in the background
    expect(response.status).toBe(200);
    expect(sent).toEqual([healthy.email]);
    expect(recheckCalls).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    // The background probe is detached from the request lifetime.
    expect(recheckSignal?.aborted).toBe(false);
  });

  test("a rejected background probe is absorbed without failing the request", async () => {
    const stuck = exhausted("account-a");
    const healthy = account("account-b");
    const rechecker: PipelineQuotaRechecker = {
      async recheckDueAccounts(): Promise<void> {
        throw new Error("usage endpoint exploded");
      },
      async syncDueAccounts(): Promise<void> {},
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const response = await runChatCompletion({
        body: BODY,
        model: "auto",
        stream: false,
        config: config(),
        accountManager: new FakeAccountManager([stuck, healthy]),
        tokenRefresher: refresher,
        quotaRechecker: rechecker,
        makeClient: client([]),
      });
      await Bun.sleep(5);
      expect(response.status).toBe(200);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("awaits the probe when every account is exhausted and uses the restored one", async () => {
    // Given: nothing selectable until the authoritative probe restores A
    const stuck = exhausted("account-a");
    const sent: string[] = [];
    let probeSignal: AbortSignal | undefined;
    const rechecker: PipelineQuotaRechecker = {
      async recheckDueAccounts(_accounts, signal): Promise<void> {
        probeSignal = signal;
        await Bun.sleep(40);
        restore(stuck);
      },
      async syncDueAccounts(): Promise<void> {},
    };
    const startedAt = Date.now();

    // When
    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([stuck]),
      tokenRefresher: refresher,
      quotaRechecker: rechecker,
      makeClient: client(sent),
    });

    // Then
    expect(response.status).toBe(200);
    expect(sent).toEqual([stuck.email]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(35);
    // The awaited probe is bound to the request deadline signal.
    expect(probeSignal).toBeInstanceOf(AbortSignal);
  });

  test("also awaits the probe when only rate-limited accounts remain", async () => {
    const stuck = exhausted("account-a");
    const throttled = account("account-b", { rateLimitResetTime: Date.now() + 60_000 });
    let awaited = false;
    const rechecker: PipelineQuotaRechecker = {
      async recheckDueAccounts(): Promise<void> {
        await Bun.sleep(20);
        restore(stuck);
        awaited = true;
      },
      async syncDueAccounts(): Promise<void> {},
    };
    const sent: string[] = [];

    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([stuck, throttled]),
      tokenRefresher: refresher,
      quotaRechecker: rechecker,
      makeClient: client(sent),
    });

    expect(response.status).toBe(200);
    expect(awaited).toBe(true);
    expect(sent).toEqual([stuck.email]);
  });
});
