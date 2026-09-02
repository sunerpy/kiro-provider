import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { OpenCodeAuthStore } from "../src/auth/opencode-auth-store.js";
import { AccountManager, toAuthDetails } from "../src/core/account-manager.js";
import { OpenCodeAccountManager } from "../src/core/opencode-auth-runtime.js";
import { clearSdkClientCache, createSdkClient } from "../src/core/sdk-client.js";
import type { AccountSelectionStrategy, ManagedAccount } from "../src/kiro/types.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

const stores: OpenCodeAuthStore[] = [];
const databases: AccountsDatabase[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  clearSdkClientCache();
  for (const store of stores.splice(0)) store.close();
  for (const database of databases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function account(id: string, overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id,
    email: `${id.toLowerCase()}@example.invalid`,
    authMethod: "desktop",
    region: "us-east-1",
    refreshToken: `refresh-${id}`,
    accessToken: `access-${id}`,
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 0,
    limitCount: 100,
    overageCount: 0,
    lastSync: 0,
    lastUsed: 0,
    ...overrides,
  };
}

function createOpenCodeDatabase(accounts: readonly ManagedAccount[]): string {
  const directory = mkdtempSync(join(tmpdir(), "kiro-provider-runtime-parity-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "opencode", "kiro.db");
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath, { create: true, strict: true });
  db.run(`
		CREATE TABLE accounts (
			id TEXT PRIMARY KEY, email TEXT NOT NULL, auth_method TEXT NOT NULL,
			region TEXT NOT NULL, oidc_region TEXT, client_id TEXT, client_secret TEXT,
			profile_arn TEXT, start_url TEXT, refresh_token TEXT NOT NULL,
			access_token TEXT NOT NULL, expires_at INTEGER NOT NULL,
			rate_limit_reset INTEGER DEFAULT 0, is_healthy INTEGER DEFAULT 1,
			unhealthy_reason TEXT, recovery_time INTEGER, fail_count INTEGER DEFAULT 0,
			last_used INTEGER DEFAULT 0, used_count INTEGER DEFAULT 0,
			limit_count INTEGER DEFAULT 0, overage_count INTEGER DEFAULT 0,
			last_sync INTEGER DEFAULT 0
		)
	`);
  db.run("CREATE TABLE removed_accounts (id TEXT PRIMARY KEY, removed_at INTEGER NOT NULL)");
  const insert = db.query(`
		INSERT INTO accounts (
			id, email, auth_method, region, oidc_region, client_id, client_secret,
			profile_arn, start_url, refresh_token, access_token, expires_at,
			rate_limit_reset, is_healthy, unhealthy_reason, recovery_time,
			fail_count, last_used, used_count, limit_count, overage_count, last_sync
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
  for (const current of accounts) {
    insert.run(
      current.id,
      current.email,
      current.authMethod,
      current.region,
      current.oidcRegion ?? null,
      current.clientId ?? null,
      current.clientSecret ?? null,
      current.profileArn ?? null,
      current.startUrl ?? null,
      current.refreshToken,
      current.accessToken,
      current.expiresAt,
      current.rateLimitResetTime,
      current.isHealthy ? 1 : 0,
      current.unhealthyReason ?? null,
      current.recoveryTime ?? null,
      current.failCount,
      current.lastUsed ?? 0,
      current.usedCount ?? 0,
      current.limitCount ?? 0,
      current.overageCount ?? 0,
      current.lastSync ?? 0,
    );
  }
  db.close();
  return databasePath;
}

function openCodeManager(
  accounts: readonly ManagedAccount[],
  strategy: AccountSelectionStrategy = "sticky",
): {
  readonly manager: OpenCodeAccountManager;
  readonly store: OpenCodeAuthStore;
  readonly path: string;
} {
  const path = createOpenCodeDatabase(accounts);
  const store = new OpenCodeAuthStore(path);
  stores.push(store);
  return { manager: new OpenCodeAccountManager(store, strategy), store, path };
}

function localManager(
  accounts: readonly ManagedAccount[],
  strategy: AccountSelectionStrategy = "sticky",
): AccountManager {
  const directory = mkdtempSync(join(tmpdir(), "kiro-provider-runtime-parity-local-"));
  temporaryDirectories.push(directory);
  const database = new AccountsDatabase(join(directory, "accounts.db"));
  databases.push(database);
  const stored = accounts.map((current) => database.insertAccount(current));
  return new AccountManager(stored, strategy, database);
}

function tombstone(path: string, id: string): void {
  const db = new Database(path, { strict: true });
  try {
    db.query("INSERT INTO removed_accounts (id, removed_at) VALUES (?, ?)").run(id, Date.now());
  } finally {
    db.close();
  }
}

function destroySpy(auth: ManagedAccount): ReturnType<typeof spyOn> {
  const client = createSdkClient(
    toAuthDetails(auth),
    "us-east-1",
    undefined,
    undefined,
    undefined,
    auth.id,
  );
  const handler = client.config.requestHandler;
  if (!(handler instanceof NodeHttpHandler))
    throw new TypeError("expected a NodeHttpHandler transport");
  return spyOn(handler, "destroy");
}

const now = Date.now();
const mixedFleet = [
  account("healthy"),
  account("throttled", { rateLimitResetTime: now + 60_000 }),
  account("exhausted", { usedCount: 100, limitCount: 100 }),
  account("dead", {
    isHealthy: false,
    failCount: 10,
    unhealthyReason: "InvalidGrantException: refresh token revoked",
  }),
  account("bearer", {
    isHealthy: false,
    failCount: 10,
    unhealthyReason: "The bearer token included in the request is invalid",
  }),
  account("recovering", {
    isHealthy: false,
    failCount: 10,
    unhealthyReason: "temporary",
    recoveryTime: now - 1,
  }),
  account("resting", {
    isHealthy: false,
    failCount: 10,
    unhealthyReason: "temporary",
    recoveryTime: now + 60_000,
  }),
];

describe("OpenCodeAccountManager parity with AccountManager", () => {
  test("countSelectableAccounts agrees with the local manager for every eligibility set", () => {
    const { manager } = openCodeManager(mixedFleet);
    const local = localManager(mixedFleet);
    const eligibilitySets: readonly (ReadonlySet<string> | undefined)[] = [
      undefined,
      new Set(mixedFleet.map(({ id }) => id)),
      new Set(["healthy", "throttled"]),
      new Set(["throttled", "exhausted", "dead", "resting"]),
      new Set(["bearer", "recovering"]),
      new Set(["unknown"]),
      new Set(),
    ];

    for (const eligible of eligibilitySets) {
      expect(manager.countSelectableAccounts(eligible)).toBe(
        local.countSelectableAccounts(eligible),
      );
    }
    expect(manager.countSelectableAccounts()).toBe(3);
    expect(manager.countSelectableAccounts(new Set(["healthy", "throttled"]))).toBe(1);
    expect(manager.countSelectableAccounts(undefined, now + 60_000)).toBe(5);
  });

  test("selection sequences match the local manager for every strategy", () => {
    const fleet = [
      account("B", { usedCount: 2, lastUsed: 20 }),
      account("A", { usedCount: 2, lastUsed: 10 }),
      account("C", { usedCount: 1, lastUsed: 30 }),
    ];
    for (const strategy of ["sticky", "round-robin", "lowest-usage"] as const) {
      const { manager } = openCodeManager(fleet, strategy);
      const local = localManager(fleet, strategy);
      const steps: readonly (string | undefined)[] = [
        undefined,
        "B",
        undefined,
        undefined,
        "missing",
        undefined,
      ];
      const sharedPicks = steps.map((preferred) => manager.selectHealthyAccount(preferred)?.id);
      const localPicks = steps.map((preferred) => local.selectHealthyAccount(preferred)?.id);
      expect(sharedPicks).toEqual(localPicks);
    }
  });

  test("reconcileFromDb destroys the SDK transports of accounts another writer removed", () => {
    const removed = account("removed");
    const kept = account("kept");
    const { manager, path } = openCodeManager([removed, kept]);
    expect(manager.selectHealthyAccount()?.id).toBe("kept");
    clearSdkClientCache();
    const removedDestroy = destroySpy(removed);
    const keptDestroy = destroySpy(kept);
    tombstone(path, removed.id);

    const survivors = manager.reconcileFromDb();

    expect(removedDestroy).toHaveBeenCalledTimes(1);
    expect(keptDestroy).not.toHaveBeenCalled();
    expect(survivors.map(({ id }) => id)).toEqual(["kept"]);
    expect(manager.getAccountCount()).toBe(1);
    expect(manager.countSelectableAccounts()).toBe(1);
  });

  test("a health update on a vanished account reconciles and evicts its transport", () => {
    const vanished = account("vanished");
    const { manager, path } = openCodeManager([vanished, account("other")]);
    clearSdkClientCache();
    const destroy = destroySpy(vanished);
    tombstone(path, vanished.id);

    expect(manager.markRateLimited(vanished, Date.now() + 1_000)).toBeUndefined();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(manager.getAccountCount()).toBe(1);
    expect(manager.selectHealthyAccount()?.id).toBe("other");
  });

  test("a refresh-token-dead reason writes the same binary marker in both stores", () => {
    const target = account("A");
    const { manager } = openCodeManager([target]);
    const local = localManager([target]);
    const reason = "InvalidTokenException: Invalid refresh token";

    const shared = manager.markUnhealthy(target, reason);
    const stored = local.markUnhealthy(target, reason);

    const marker = {
      isHealthy: false,
      failCount: 10,
      unhealthyReason: reason,
      recoveryTime: undefined,
    };
    expect(shared).toMatchObject(marker);
    expect(stored).toMatchObject(marker);
    expect(shared?.lastUsed).toBeGreaterThan(0);
    expect(manager.countSelectableAccounts()).toBe(0);
    expect(local.countSelectableAccounts()).toBe(0);
  });

  test("a non-permanent reason keeps opencode-kiro-auth's fail_count ladder in the shared store", () => {
    // The shared schema belongs to the OpenCode plugin, which reads and
    // increments fail_count itself; kiro-provider therefore leaves that
    // ladder intact instead of imposing the local binary marker. No
    // production caller passes a non-permanent reason.
    const target = account("A", { failCount: 8 });
    const { manager } = openCodeManager([target]);
    const recoveryTime = Date.now() + 30_000;

    expect(manager.markUnhealthy(target, "temporary upstream failure", recoveryTime)).toMatchObject(
      {
        isHealthy: true,
        failCount: 9,
        unhealthyReason: "temporary upstream failure",
        recoveryTime: undefined,
      },
    );
    expect(manager.countSelectableAccounts()).toBe(1);
    expect(manager.markUnhealthy(target, "temporary upstream failure", recoveryTime)).toMatchObject(
      {
        isHealthy: false,
        failCount: 10,
        recoveryTime,
      },
    );
    expect(manager.countSelectableAccounts()).toBe(0);
    expect(manager.countSelectableAccounts(undefined, recoveryTime)).toBe(1);
  });
});
