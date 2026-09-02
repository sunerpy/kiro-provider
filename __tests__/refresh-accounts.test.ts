import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAccountRefresh } from "../src/cli/refresh-accounts.js";
import { ConfigSchema } from "../src/config/schema.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

function account(id: string, email: string): ManagedAccount {
  return {
    id,
    email,
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

describe("runAccountRefresh", () => {
  test("refreshes a selected account through the production database wiring", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kiro-provider-refresh-"));
    const databasePath = join(directory, "accounts.db");
    try {
      const database = new AccountsDatabase(databasePath);
      database.insertAccount(account("account-a", "a@example.com"));
      database.insertAccount(account("account-b", "b@example.com"));
      database.close();
      const fetched: string[] = [];
      const refreshNow = Date.now() + 1_000;
      const summary = await runAccountRefresh(
        ConfigSchema.parse({
          api_keys: ["sk-test"],
          auth_source: "local",
          account_maintenance_timeout_ms: 5_000,
          quota_recheck_timeout_ms: 1_000,
        }),
        { identifier: "account-b" },
        {
          openDb: () => new AccountsDatabase(databasePath),
          now: () => refreshNow,
          fetchUsage: async (auth) => {
            fetched.push(auth.email ?? "");
            return {
              email: auth.email,
              usedCount: 25,
              limitCount: 100,
              overageCount: 0,
            };
          },
        },
      );

      expect(fetched).toEqual(["b@example.com"]);
      expect(summary).toMatchObject({
        totalAccounts: 1,
        usageUpdated: 1,
        failed: 0,
      });
      const verification = new AccountsDatabase(databasePath);
      try {
        expect(verification.getById("account-a")?.usedCount).toBe(10);
        expect(verification.getById("account-b")).toMatchObject({
          usedCount: 25,
          lastSync: refreshNow,
        });
      } finally {
        verification.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
