import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAccountRefresh } from "../src/cli/refresh-accounts.js";
import { ConfigSchema } from "../src/config/schema.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

function account(id: string): ManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    authMethod: "idc",
    region: "us-east-1",
    oidcRegion: "us-east-1",
    clientId: `${id}-client`,
    clientSecret: `${id}-client-secret`,
    refreshToken: `${id}-refresh-secret`,
    accessToken: `${id}-access-secret`,
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 10,
    limitCount: 100,
    lastSync: Date.now(),
    overageCount: 0,
  };
}

async function maxInFlight(
  quotaRecheckConcurrency: number,
  accountMaintenanceConcurrency: number,
): Promise<number> {
  const directory = mkdtempSync(join(tmpdir(), "kiro-provider-refresh-concurrency-"));
  const databasePath = join(directory, "accounts.db");
  try {
    const database = new AccountsDatabase(databasePath);
    for (const id of ["a", "b", "c", "d"]) database.insertAccount(account(id));
    database.close();
    let inFlight = 0;
    let peak = 0;
    const summary = await runAccountRefresh(
      ConfigSchema.parse({
        api_keys: ["sk-test"],
        auth_source: "local",
        account_maintenance_timeout_ms: 5_000,
        quota_recheck_timeout_ms: 1_000,
        quota_recheck_concurrency: quotaRecheckConcurrency,
        account_maintenance_concurrency: accountMaintenanceConcurrency,
      }),
      {},
      {
        openDb: () => new AccountsDatabase(databasePath),
        fetchUsage: async (auth) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 15));
          inFlight -= 1;
          return { email: auth.email, usedCount: 1, limitCount: 100, overageCount: 0 };
        },
      },
    );
    expect(summary.failed).toBe(0);
    expect(summary.totalAccounts).toBe(4);
    return peak;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("runAccountRefresh concurrency", () => {
  test("is bounded by quota_recheck_concurrency, matching the server", async () => {
    expect(await maxInFlight(1, 4)).toBe(1);
  });

  test("is not bounded by account_maintenance_concurrency", async () => {
    expect(await maxInFlight(4, 1)).toBeGreaterThan(1);
  });
});
