import { describe, expect, test } from "bun:test";
import { leastQueuedAccountIds } from "../src/core/account-capacity.js";
import { accountQueueDepth, acquireAccountQueue } from "../src/core/pipeline-runtime.js";
import type { ManagedAccount } from "../src/kiro/types.js";

function account(id: string, overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id,
    email: "fixture@example.invalid",
    accessToken: "fixture",
    refreshToken: "fixture",
    expiresAt: Date.now() + 60000,
    authMethod: "desktop",
    region: "us-east-1",
    isHealthy: true,
    rateLimitResetTime: 0,
    failCount: 0,
    usedCount: 0,
    limitCount: 100,
    ...overrides,
  };
}

describe("account capacity eligibility", () => {
  test("never trades health, quota, cooldown, overage or model eligibility for an idle slot", () => {
    const accounts = [
      account("capacity-eligible"),
      account("capacity-unhealthy", { isHealthy: false }),
      account("capacity-quota", { usedCount: 100 }),
      account("capacity-cooldown", { rateLimitResetTime: Date.now() + 60000 }),
      account("capacity-overage", { overageCount: 1 }),
      account("capacity-wrong-model"),
    ];
    const eligible = new Set(accounts.slice(0, -1).map((item) => item.id));
    expect([...leastQueuedAccountIds(accounts, eligible)]).toEqual(["capacity-eligible"]);
    expect([...leastQueuedAccountIds(accounts, new Set())]).toEqual([]);
    expect([
      ...leastQueuedAccountIds(accounts, eligible, { stopOnOverage: false, overageThreshold: 0 }),
    ]).toEqual(["capacity-eligible", "capacity-overage"]);
  });

  test("counts reservations before yielding and includes waiters when every account is busy", async () => {
    const a = account("capacity-depth-a");
    const b = account("capacity-depth-b");
    const signal = new AbortController().signal;
    const first = acquireAccountQueue(a.id, signal);
    expect(accountQueueDepth(a.id)).toBe(1);
    const releaseA = await first;
    const queued = acquireAccountQueue(a.id, signal);
    const releaseB = await acquireAccountQueue(b.id, signal);
    try {
      expect(accountQueueDepth(a.id)).toBe(2);
      expect([...leastQueuedAccountIds([a, b])]).toEqual([b.id]);
      releaseA();
      const releaseNext = await queued;
      expect(accountQueueDepth(a.id)).toBe(1);
      releaseNext();
      releaseNext();
      expect(accountQueueDepth(a.id)).toBe(0);
      expect([...leastQueuedAccountIds([a, b])]).toEqual([a.id]);
    } finally {
      releaseA();
      (await queued)();
      releaseB();
    }
    expect(accountQueueDepth(b.id)).toBe(0);
  });

  test("removes a cancelled reservation without exposing the active lease as free", async () => {
    const a = account("capacity-cancel");
    const release = await acquireAccountQueue(a.id, new AbortController().signal);
    const controller = new AbortController();
    const queued = acquireAccountQueue(a.id, controller.signal);
    const rejected = queued.catch((error: unknown) => error);
    controller.abort();
    try {
      expect(await rejected).toMatchObject({ name: "AbortError" });
      expect(accountQueueDepth(a.id)).toBe(1);
    } finally {
      release();
    }
    expect(accountQueueDepth(a.id)).toBe(0);
  });
});
