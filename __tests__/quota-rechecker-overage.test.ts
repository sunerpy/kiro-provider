import { describe, expect, test } from "bun:test";
import { toAuthDetails } from "../src/core/account-manager.js";
import { QuotaRechecker } from "../src/core/quota-rechecker.js";
import {
  DEFAULT_OVERAGE_POLICY,
  isQuotaExhausted,
  isRefreshTokenDead,
  type OveragePolicy,
} from "../src/kiro/health.js";
import type { KiroAuthDetails, KiroUsageSnapshot, ManagedAccount } from "../src/kiro/types.js";

const NOW = 1_000_000;
const OFF: OveragePolicy = { stopOnOverage: false, overageThreshold: 0 };
const THRESHOLD_TWO: OveragePolicy = { stopOnOverage: true, overageThreshold: 2 };

function account(id = "account-a", overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    authMethod: "desktop",
    region: "us-east-1",
    refreshToken: `${id}-refresh`,
    accessToken: `${id}-access`,
    expiresAt: NOW + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 10,
    limitCount: 100,
    overageCount: 1,
    lastSync: 1,
    ...overrides,
  };
}

/** Mirrors AccountManager: same policy for scheduling and usage updates, real toAuthDetails. */
class FakeManager {
  readonly unhealthy: string[] = [];

  constructor(
    readonly accounts: ManagedAccount[],
    private readonly policy: OveragePolicy = DEFAULT_OVERAGE_POLICY,
  ) {}

  getOveragePolicy(): OveragePolicy {
    return this.policy;
  }

  toAuthDetails(selected: ManagedAccount): KiroAuthDetails {
    return toAuthDetails(selected);
  }

  markUnhealthy(selected: ManagedAccount, reason: string): ManagedAccount | undefined {
    const current = this.accounts.find(({ id }) => id === selected.id);
    if (!current) return undefined;
    current.isHealthy = false;
    current.unhealthyReason = reason;
    current.failCount = 10;
    this.unhealthy.push(reason);
    return current;
  }

  scheduleQuotaRecheck(selected: ManagedAccount, recheckAfter: number): ManagedAccount | undefined {
    const current = this.accounts.find(({ id }) => id === selected.id);
    if (!current) return undefined;
    if (isQuotaExhausted(current, this.policy)) {
      current.rateLimitResetTime = Math.max(current.rateLimitResetTime, recheckAfter);
    }
    return current;
  }

  updateQuotaUsage(
    selected: ManagedAccount,
    usage: KiroUsageSnapshot & { readonly lastSync: number },
    nextRecheckAt: number,
  ): ManagedAccount | undefined {
    const current = this.accounts.find(({ id }) => id === selected.id);
    if (!current) return undefined;
    const wasExhausted = isQuotaExhausted(current, this.policy);
    const snapshotExhausted = isQuotaExhausted(usage, this.policy);
    current.usedCount = usage.usedCount;
    current.limitCount = usage.limitCount;
    current.overageCount = usage.overageCount;
    current.lastSync = usage.lastSync;
    current.rateLimitResetTime = snapshotExhausted
      ? Math.max(current.rateLimitResetTime, nextRecheckAt)
      : wasExhausted
        ? 0
        : current.rateLimitResetTime;
    return current;
  }
}

class FakeRefresher {
  async refreshIfNeeded(selected: ManagedAccount): Promise<ManagedAccount> {
    return selected;
  }

  async forceRefresh(selected: ManagedAccount): Promise<ManagedAccount> {
    return selected;
  }
}

function rechecker(
  manager: FakeManager,
  fetchUsage: (auth: KiroAuthDetails) => Promise<KiroUsageSnapshot>,
  overagePolicy?: OveragePolicy,
): QuotaRechecker {
  return new QuotaRechecker({
    accountManager: manager,
    tokenRefresher: new FakeRefresher(),
    intervalMs: 60_000,
    usageRefreshIntervalMs: 60_000,
    timeoutMs: 1_000,
    concurrency: 2,
    now: () => NOW,
    fetchUsage,
    ...(overagePolicy ? { overagePolicy } : {}),
  });
}

describe("QuotaRechecker overage policy", () => {
  test("mirrors the account manager's policy unless one is given explicitly", () => {
    const manager = new FakeManager([], OFF);

    expect(
      rechecker(manager, async () => ({
        usedCount: 0,
        limitCount: 100,
        overageCount: 0,
      })).getOveragePolicy(),
    ).toEqual(OFF);
    expect(
      rechecker(
        manager,
        async () => ({ usedCount: 0, limitCount: 100, overageCount: 0 }),
        THRESHOLD_TWO,
      ).getOveragePolicy(),
    ).toEqual(THRESHOLD_TWO);
    expect(
      new QuotaRechecker({
        accountManager: {
          toAuthDetails,
          markUnhealthy: () => undefined,
          scheduleQuotaRecheck: () => undefined,
          updateQuotaUsage: () => undefined,
        },
        tokenRefresher: new FakeRefresher(),
        intervalMs: 1,
        usageRefreshIntervalMs: 1,
        timeoutMs: 1,
        concurrency: 1,
      }).getOveragePolicy(),
    ).toEqual(DEFAULT_OVERAGE_POLICY);
  });

  test("with the gate on an overage account is recheck-due and recovers on an overage-free sync", async () => {
    const parked = account("account-a", { overageCount: 1 });
    const manager = new FakeManager([parked]);
    let calls = 0;
    const probe = rechecker(manager, async () => {
      calls += 1;
      return { usedCount: 12, limitCount: 100, overageCount: 0 };
    });

    await probe.recheckDueAccounts([parked], new AbortController().signal);

    expect(calls).toBe(1);
    expect(parked).toMatchObject({ overageCount: 0, rateLimitResetTime: 0 });
    expect(isQuotaExhausted(parked, manager.getOveragePolicy())).toBe(false);
  });

  test("with the gate on a still-overage sync keeps the account parked until the next recheck", async () => {
    const parked = account("account-a", { overageCount: 1 });
    const manager = new FakeManager([parked]);
    const probe = rechecker(manager, async () => ({
      usedCount: 12,
      limitCount: 100,
      overageCount: 2,
    }));

    const summary = await probe.refreshAccounts([parked], new AbortController().signal);

    expect(parked).toMatchObject({ overageCount: 2, rateLimitResetTime: NOW + 60_000 });
    expect(summary.accounts[0]?.quotaStatus).toBe("exhausted");
  });

  test("with the knob off an overage account is a usage-refresh candidate, not a quota recheck", async () => {
    const relaxed = account("account-a", { overageCount: 5, lastSync: 0 });
    const manager = new FakeManager([relaxed], OFF);
    let calls = 0;
    const probe = rechecker(manager, async () => {
      calls += 1;
      return { usedCount: 15, limitCount: 100, overageCount: 6 };
    });

    await probe.recheckDueAccounts([relaxed], new AbortController().signal);
    expect(calls).toBe(0);

    await probe.syncDueAccounts([relaxed], new AbortController().signal);
    expect(calls).toBe(1);
    expect(relaxed).toMatchObject({ overageCount: 6, rateLimitResetTime: 0 });

    const summary = await probe.refreshAccounts([relaxed], new AbortController().signal);
    expect(summary.accounts[0]?.quotaStatus).toBe("available");
  });

  test("the threshold decides the reported quota status exactly as selection does", async () => {
    const atThreshold = account("account-a", { overageCount: 2 });
    const aboveThreshold = account("account-b", { overageCount: 3 });
    const manager = new FakeManager([atThreshold, aboveThreshold], THRESHOLD_TWO);
    const probe = rechecker(manager, async (auth) => ({
      usedCount: 12,
      limitCount: 100,
      overageCount: auth.access === atThreshold.accessToken ? 2 : 3,
    }));

    const summary = await probe.refreshAccounts(
      [atThreshold, aboveThreshold],
      new AbortController().signal,
    );

    expect(summary.accounts.map(({ accountId, quotaStatus }) => [accountId, quotaStatus])).toEqual([
      ["account-a", "available"],
      ["account-b", "exhausted"],
    ]);
    expect(atThreshold.rateLimitResetTime).toBe(0);
    expect(aboveThreshold.rateLimitResetTime).toBe(NOW + 60_000);
  });

  test("an IdC row without its client secret is marked needs-relogin instead of failing opaquely", async () => {
    const corrupted = account("account-idc", {
      authMethod: "idc",
      clientId: "client-id",
      overageCount: 0,
    });
    const manager = new FakeManager([corrupted]);
    let calls = 0;
    const probe = rechecker(manager, async () => {
      calls += 1;
      return { usedCount: 0, limitCount: 100, overageCount: 0 };
    });

    const summary = await probe.refreshAccounts([corrupted], new AbortController().signal);

    expect(calls).toBe(0);
    expect(manager.unhealthy).toEqual(["MISSING_CREDENTIALS: Missing credentials"]);
    expect(corrupted.isHealthy).toBe(false);
    expect(isRefreshTokenDead(corrupted.unhealthyReason)).toBe(true);
    expect(summary.accounts[0]).toMatchObject({
      tokenStatus: "failed",
      usageStatus: "skipped",
      error: "MISSING_CREDENTIALS: Missing credentials",
    });
  });
});
