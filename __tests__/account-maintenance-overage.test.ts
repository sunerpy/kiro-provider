import { describe, expect, test } from "bun:test";
import { AccountMaintenanceService } from "../src/core/account-maintenance.js";
import { toAuthDetails } from "../src/core/account-manager.js";
import type { PipelineQuotaRechecker } from "../src/core/quota-rechecker.js";
import { DEFAULT_OVERAGE_POLICY, type OveragePolicy } from "../src/kiro/health.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";

const OFF: OveragePolicy = { stopOnOverage: false, overageThreshold: 0 };

function account(id: string, overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    authMethod: "desktop",
    region: "us-east-1",
    refreshToken: `${id}-refresh`,
    accessToken: `${id}-access`,
    expiresAt: 0,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 10,
    limitCount: 100,
    overageCount: 0,
    lastSync: 0,
    ...overrides,
  };
}

/** Mirrors AccountManager: exposes its policy and uses the real toAuthDetails. */
class FakeManager {
  readonly unhealthy: string[] = [];

  constructor(
    readonly accounts: ManagedAccount[],
    private readonly policy: OveragePolicy = DEFAULT_OVERAGE_POLICY,
  ) {}

  getOveragePolicy(): OveragePolicy {
    return this.policy;
  }

  reconcileFromDb(): readonly ManagedAccount[] {
    return this.accounts.map((candidate) => ({ ...candidate }));
  }

  toAuthDetails(selected: ManagedAccount): KiroAuthDetails {
    const current = this.accounts.find(({ id }) => id === selected.id) ?? selected;
    return toAuthDetails(current);
  }

  markUnhealthy(selected: ManagedAccount, reason: string): void {
    const current = this.accounts.find(({ id }) => id === selected.id);
    if (current) {
      current.isHealthy = false;
      current.unhealthyReason = reason;
      current.failCount = 10;
    }
    this.unhealthy.push(reason);
  }
}

class FakeRefresher {
  readonly calls: string[] = [];

  async refreshIfNeeded(selected: ManagedAccount): Promise<ManagedAccount> {
    this.calls.push(selected.id);
    return selected;
  }
}

class FakeUsageRefresher implements PipelineQuotaRechecker {
  readonly recheckAccounts: string[][] = [];
  readonly syncAccounts: string[][] = [];

  async recheckDueAccounts(accounts: readonly ManagedAccount[]): Promise<void> {
    this.recheckAccounts.push(accounts.map(({ id }) => id));
  }

  async syncDueAccounts(accounts: readonly ManagedAccount[]): Promise<void> {
    this.syncAccounts.push(accounts.map(({ id }) => id));
  }
}

function service(
  manager: FakeManager,
  refresher: FakeRefresher,
  usageRefresher: FakeUsageRefresher,
  overagePolicy?: OveragePolicy,
): AccountMaintenanceService {
  return new AccountMaintenanceService({
    enabled: true,
    intervalMs: 60_000,
    timeoutMs: 5_000,
    concurrency: 2,
    tokenExpiryBufferMs: 0,
    accountManager: manager,
    tokenRefresher: refresher,
    usageRefresher,
    ...(overagePolicy ? { overagePolicy } : {}),
  });
}

describe("AccountMaintenanceService overage policy", () => {
  test("agrees with selection: the gate decides whether an overage account gets its token refreshed", async () => {
    const gatedRefresher = new FakeRefresher();
    await service(
      new FakeManager([account("overage", { overageCount: 1 }), account("plain")]),
      gatedRefresher,
      new FakeUsageRefresher(),
    ).runOnce();

    const relaxedRefresher = new FakeRefresher();
    await service(
      new FakeManager([account("overage", { overageCount: 1 }), account("plain")], OFF),
      relaxedRefresher,
      new FakeUsageRefresher(),
    ).runOnce();

    expect(gatedRefresher.calls).toEqual(["plain"]);
    expect(relaxedRefresher.calls.sort()).toEqual(["overage", "plain"]);
  });

  test("an explicit policy option overrides the manager's", async () => {
    const refresher = new FakeRefresher();
    await service(
      new FakeManager([account("overage", { overageCount: 1 })], OFF),
      refresher,
      new FakeUsageRefresher(),
      DEFAULT_OVERAGE_POLICY,
    ).runOnce();

    expect(refresher.calls).toEqual([]);
  });

  test("an IdC row without its client secret is marked needs-relogin and does not abort the pass", async () => {
    const corrupted = account("idc", { authMethod: "idc", clientId: "client-id" });
    const healthy = account("desktop");
    const manager = new FakeManager([corrupted, healthy]);
    const refresher = new FakeRefresher();
    const usageRefresher = new FakeUsageRefresher();

    await service(manager, refresher, usageRefresher).runOnce();

    expect(manager.unhealthy).toEqual(["MISSING_CREDENTIALS: Missing credentials"]);
    expect(manager.accounts[0]).toMatchObject({
      id: "idc",
      isHealthy: false,
      failCount: 10,
      unhealthyReason: "MISSING_CREDENTIALS: Missing credentials",
    });
    expect(refresher.calls).toEqual(["desktop"]);
    expect(usageRefresher.recheckAccounts).toHaveLength(1);
    expect(usageRefresher.syncAccounts).toHaveLength(1);
  });
});
