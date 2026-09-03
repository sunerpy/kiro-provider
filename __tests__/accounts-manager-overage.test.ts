import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountManager } from "../src/core/account-manager.js";
import { DEFAULT_OVERAGE_POLICY, type OveragePolicy } from "../src/kiro/health.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

const OFF: OveragePolicy = { stopOnOverage: false, overageThreshold: 0 };
const THRESHOLD_TWO: OveragePolicy = { stopOnOverage: true, overageThreshold: 2 };

const databases: AccountsDatabase[] = [];
const temporaryDirectories: string[] = [];

function createDatabase(): AccountsDatabase {
  const directory = mkdtempSync(join(tmpdir(), "kiro-provider-overage-"));
  const database = new AccountsDatabase(join(directory, "accounts.db"));
  databases.push(database);
  temporaryDirectories.push(directory);
  return database;
}

function account(id: string, overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id,
    email: `${id.toLowerCase()}@example.com`,
    authMethod: "desktop",
    region: "us-east-1",
    refreshToken: `refresh-${id}`,
    accessToken: `access-${id}`,
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 10,
    limitCount: 100,
    overageCount: 0,
    ...overrides,
  };
}

function manager(
  policy: OveragePolicy | undefined,
  ...accounts: ManagedAccount[]
): { readonly db: AccountsDatabase; readonly manager: AccountManager } {
  const db = createDatabase();
  const stored = accounts.map((candidate) => db.insertAccount(candidate));
  return {
    db,
    manager: new AccountManager(stored, "sticky", db, policy ? { overagePolicy: policy } : {}),
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("AccountManager overage policy", () => {
  test("defaults to the built-in gate and exposes the policy it applies", () => {
    const { manager: defaulted } = manager(undefined, account("A", { overageCount: 1 }));
    const { manager: relaxed } = manager(OFF, account("A", { overageCount: 1 }));

    expect(defaulted.getOveragePolicy()).toEqual(DEFAULT_OVERAGE_POLICY);
    expect(relaxed.getOveragePolicy()).toEqual(OFF);
    expect(defaulted.selectHealthyAccount()).toBeNull();
    expect(relaxed.selectHealthyAccount()?.id).toBe("A");
  });

  test("the threshold admits overage up to and including the configured count", () => {
    const { manager: gated } = manager(
      THRESHOLD_TWO,
      account("A", { overageCount: 2 }),
      account("B", { overageCount: 3 }),
    );

    expect(gated.countSelectableAccounts()).toBe(1);
    expect(gated.selectHealthyAccount()?.id).toBe("A");
    expect(gated.countSelectableAccounts(new Set(["B"]))).toBe(0);
  });

  test("a single overage account is blocked by overage only", () => {
    const { manager: gated } = manager(undefined, account("A", { overageCount: 1 }));

    expect(gated.selectHealthyAccount()).toBeNull();
    expect(gated.blockedByOverageOnly()).toBe(true);
    expect(gated.blockedByOverageOnly(new Set(["A"]))).toBe(true);
    expect(gated.blockedByOverageOnly(new Set())).toBe(false);
    expect(gated.blockedByOverageOnly(new Set(["missing"]))).toBe(false);
  });

  test("blockedByOverageOnly is false once anything is selectable or the knob is off", () => {
    const { manager: mixed } = manager(undefined, account("A", { overageCount: 1 }), account("B"));
    const { manager: relaxed } = manager(OFF, account("A", { overageCount: 1 }));

    expect(mixed.blockedByOverageOnly()).toBe(false);
    expect(mixed.blockedByOverageOnly(new Set(["A"]))).toBe(true);
    expect(relaxed.blockedByOverageOnly()).toBe(false);
  });

  test("blockedByOverageOnly is false when a candidate is exhausted on its included quota", () => {
    const { manager: gated } = manager(
      undefined,
      account("A", { overageCount: 1 }),
      account("B", { usedCount: 100, limitCount: 100 }),
    );

    expect(gated.selectHealthyAccount()).toBeNull();
    expect(gated.blockedByOverageOnly()).toBe(false);
    expect(gated.blockedByOverageOnly(new Set(["A"]))).toBe(true);
  });

  test("blockedByOverageOnly is false when a healthy candidate is merely rate-limited", () => {
    const { manager: gated } = manager(
      undefined,
      account("A", { overageCount: 1 }),
      account("B", { rateLimitResetTime: Date.now() + 60_000 }),
    );

    expect(gated.selectHealthyAccount()).toBeNull();
    expect(gated.blockedByOverageOnly()).toBe(false);
  });

  test("blockedByOverageOnly ignores permanently dead accounts", () => {
    const { manager: gated } = manager(
      undefined,
      account("A", { overageCount: 1 }),
      account("D", {
        isHealthy: false,
        failCount: 10,
        unhealthyReason: "MISSING_CREDENTIALS: Missing credentials",
      }),
    );

    expect(gated.blockedByOverageOnly()).toBe(true);
    expect(gated.blockedByOverageOnly(new Set(["D"]))).toBe(false);
  });

  test("a fresh authoritative sync reporting overageCount 0 re-admits a parked account", () => {
    const recheckAt = Date.now() + 60_000;
    const { db, manager: gated } = manager(
      undefined,
      account("A", { overageCount: 1, rateLimitResetTime: recheckAt, lastSync: 10 }),
    );
    const parked = db.getById("A");
    if (!parked) throw new Error("account A missing");
    expect(gated.selectHealthyAccount()).toBeNull();
    expect(gated.blockedByOverageOnly()).toBe(true);

    const updated = gated.updateQuotaUsage(
      parked,
      { usedCount: 12, limitCount: 100, overageCount: 0, lastSync: 20 },
      0,
    );

    expect(updated).toMatchObject({ overageCount: 0, rateLimitResetTime: 0, lastSync: 20 });
    expect(gated.blockedByOverageOnly()).toBe(false);
    expect(gated.selectHealthyAccount()?.id).toBe("A");
  });

  test("a sync that reports overage above the threshold parks the account until the recheck", () => {
    const recheckAt = Date.now() + 60_000;
    const { db, manager: gated } = manager(THRESHOLD_TWO, account("A", { lastSync: 10 }));
    const stored = db.getById("A");
    if (!stored) throw new Error("account A missing");

    const parked = gated.updateQuotaUsage(
      stored,
      { usedCount: 12, limitCount: 100, overageCount: 3, lastSync: 20 },
      recheckAt,
    );

    expect(parked).toMatchObject({ overageCount: 3, rateLimitResetTime: recheckAt });
    expect(gated.selectHealthyAccount()).toBeNull();
    expect(gated.blockedByOverageOnly()).toBe(true);
  });

  test("with the knob off a sync reporting overage does not park the account", () => {
    const { db, manager: relaxed } = manager(OFF, account("A", { lastSync: 10 }));
    const stored = db.getById("A");
    if (!stored) throw new Error("account A missing");

    const updated = relaxed.updateQuotaUsage(
      stored,
      { usedCount: 12, limitCount: 100, overageCount: 40, lastSync: 20 },
      Date.now() + 60_000,
    );

    expect(updated).toMatchObject({ overageCount: 40, rateLimitResetTime: 0 });
    expect(relaxed.selectHealthyAccount()?.id).toBe("A");
    expect(relaxed.scheduleQuotaRecheck(stored, Date.now() + 120_000)?.rateLimitResetTime).toBe(0);
  });
});
