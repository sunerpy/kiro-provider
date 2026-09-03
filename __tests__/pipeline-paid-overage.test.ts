import { describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import {
  type PipelineAccountManager,
  type PipelineSdkClient,
  type PipelineTokenRefresher,
  runChatCompletion,
} from "../src/core/pipeline.js";
import { isQuotaExhausted, toOveragePolicy } from "../src/kiro/health.js";
import type {
  SdkStreamEvent,
  SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import { canonicalRequest, message } from "./canonical-test-helpers.js";

/**
 * Paid overage is a selection gate: with stop_on_overage on, an account whose
 * overage exceeds the threshold is skipped, and when every eligible account is
 * held back only by overage the request ends with 402 paid_overage_blocked
 * instead of the generic quota_exhausted or no_healthy_accounts terminals.
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
    usedCount: 10,
    limitCount: 100,
    ...overrides,
  };
}

class FakeAccountManager implements PipelineAccountManager {
  constructor(
    readonly accounts: ManagedAccount[],
    readonly config: Config,
  ) {}

  private policy() {
    return toOveragePolicy(this.config);
  }

  reconcileFromDb(): readonly ManagedAccount[] {
    return this.accounts;
  }

  getOveragePolicy() {
    return this.policy();
  }

  private selectable(eligibleAccountIds?: ReadonlySet<string>): ManagedAccount[] {
    const now = Date.now();
    return this.accounts.filter(
      (candidate) =>
        candidate.isHealthy &&
        candidate.rateLimitResetTime <= now &&
        !isQuotaExhausted(candidate, this.policy()) &&
        (eligibleAccountIds?.has(candidate.id) ?? true),
    );
  }

  selectHealthyAccount(
    preferredAccountId?: string,
    eligibleAccountIds?: ReadonlySet<string>,
  ): ManagedAccount | null {
    const selectable = this.selectable(eligibleAccountIds);
    return (
      selectable.find((candidate) => candidate.id === preferredAccountId) ?? selectable[0] ?? null
    );
  }

  blockedByOverageOnly(accountIds?: ReadonlySet<string>): boolean {
    const pool = this.accounts.filter((candidate) => accountIds?.has(candidate.id) ?? true);
    if (pool.length === 0 || this.selectable(accountIds).length > 0) return false;
    return pool.every(
      (candidate) =>
        candidate.isHealthy &&
        (candidate.usedCount ?? 0) < (candidate.limitCount ?? 0) &&
        (candidate.overageCount ?? 0) > this.policy().overageThreshold,
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

function clientFor(send: () => Promise<SdkStreamResponse>): () => PipelineSdkClient {
  return () => ({ send: async () => send() }) as unknown as PipelineSdkClient;
}

async function errorBody(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  return body.error;
}

async function run(accounts: ManagedAccount[], cfg: Config) {
  let sends = 0;
  const response = await runChatCompletion({
    body: BODY,
    model: "auto",
    stream: false,
    config: cfg,
    accountManager: new FakeAccountManager(accounts, cfg),
    tokenRefresher: refresher,
    makeClient: clientFor(async () => {
      sends += 1;
      return responseFrom([{ assistantResponseEvent: { content: "ok" } }]);
    }),
  });
  return { response, sends: () => sends };
}

describe("paid overage selection gate", () => {
  test("every eligible account blocked only by overage ends with 402 paid_overage_blocked", async () => {
    const cfg = config();
    const { response, sends } = await run(
      [account("a", { overageCount: 3 }), account("b", { overageCount: 1 })],
      cfg,
    );

    expect(response.status).toBe(402);
    expect(sends()).toBe(0);
    const error = await errorBody(response);
    expect(error.code).toBe("paid_overage_blocked");
    expect(String(error.message)).toContain("stop_on_overage");
  });

  test("stop_on_overage false keeps using accounts in paid overage", async () => {
    const { response, sends } = await run(
      [account("a", { overageCount: 3 })],
      config({ stop_on_overage: false }),
    );

    expect(response.status).toBe(200);
    expect(sends()).toBe(1);
  });

  test("overage at or below overage_threshold is still selectable", async () => {
    const { response, sends } = await run(
      [account("a", { overageCount: 5 })],
      config({ overage_threshold: 5 }),
    );

    expect(response.status).toBe(200);
    expect(sends()).toBe(1);
  });

  test("included-quota exhaustion still reports quota_exhausted, not paid overage", async () => {
    const { response, sends } = await run(
      [account("a", { usedCount: 100, limitCount: 100, overageCount: 2 })],
      config(),
    );

    expect(response.status).toBe(402);
    expect(sends()).toBe(0);
    expect((await errorBody(response)).code).toBe("quota_exhausted");
  });
});
