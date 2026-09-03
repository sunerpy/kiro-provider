import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatAccountList } from "../src/cli/account-output.js";
import { AccountManager } from "../src/core/account-manager.js";
import { TokenRefresher } from "../src/core/token-refresher.js";
import { KiroTokenRefreshError } from "../src/kiro/errors.js";
import { isRefreshTokenDead } from "../src/kiro/health.js";
import { refreshAccessToken } from "../src/kiro/token.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

/**
 * Corrupted stored credentials are permanent. An IdC row without its client
 * secret cannot be serialized into refresh parts; the typed MISSING_CREDENTIALS
 * failure must park the account as needs-relogin instead of surfacing as an
 * opaque 500 on every request.
 */

const realFetch = globalThis.fetch;
const databases: AccountsDatabase[] = [];
const temporaryDirectories: string[] = [];

function corruptedIdcAccount(): ManagedAccount {
  return {
    id: "account-idc",
    email: "idc@example.com",
    authMethod: "idc",
    region: "us-east-1",
    oidcRegion: "us-east-1",
    clientId: "client-id",
    refreshToken: "idc-refresh",
    accessToken: "idc-access",
    expiresAt: Date.now() - 1,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 0,
    limitCount: 100,
    overageCount: 0,
  };
}

function healthyDesktopAccount(): ManagedAccount {
  return {
    id: "account-desktop",
    email: "desktop@example.com",
    authMethod: "desktop",
    region: "us-east-1",
    refreshToken: "desktop-refresh",
    accessToken: "desktop-access",
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 0,
    limitCount: 100,
    overageCount: 0,
  };
}

function createFixture(): {
  readonly database: AccountsDatabase;
  readonly manager: AccountManager;
  readonly corrupted: ReturnType<AccountsDatabase["insertAccount"]>;
  readonly refresher: TokenRefresher;
} {
  const directory = mkdtempSync(join(tmpdir(), "kiro-provider-missing-creds-"));
  const database = new AccountsDatabase(join(directory, "accounts.db"));
  const corrupted = database.insertAccount(corruptedIdcAccount());
  const healthy = database.insertAccount(healthyDesktopAccount());
  const manager = new AccountManager([corrupted, healthy], "sticky", database);
  databases.push(database);
  temporaryDirectories.push(directory);
  return {
    database,
    manager,
    corrupted,
    refresher: new TokenRefresher(manager, 120_000),
  };
}

function placeholderAuth(account: ManagedAccount): KiroAuthDetails {
  return {
    refresh: account.refreshToken,
    access: account.accessToken,
    expires: account.expiresAt,
    authMethod: account.authMethod,
    region: account.region,
  };
}

function expectParked(database: AccountsDatabase, manager: AccountManager): void {
  expect(database.getById("account-idc")).toMatchObject({
    isHealthy: false,
    failCount: 10,
    unhealthyReason: "MISSING_CREDENTIALS: Missing credentials",
  });
  expect(isRefreshTokenDead(database.getById("account-idc")?.unhealthyReason)).toBe(true);
  expect(manager.countSelectableAccounts()).toBe(1);
  expect(manager.countSelectableAccounts(new Set(["account-idc"]))).toBe(0);
  expect(manager.selectHealthyAccount()?.id).toBe("account-desktop");
  const [, , ...rows] = formatAccountList(database.getAccounts(), "table");
  const idcRow = rows.find((row) => row.startsWith("idc@example.com"));
  expect(idcRow).toContain("needs-relogin");
}

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const database of databases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("missing stored credentials", () => {
  test("toAuthDetails raises a typed MISSING_CREDENTIALS error instead of a bare Error", () => {
    const { manager, corrupted } = createFixture();

    let caught: unknown;
    try {
      manager.toAuthDetails(corrupted);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(KiroTokenRefreshError);
    expect(caught).toMatchObject({
      name: "KiroTokenRefreshError",
      code: "MISSING_CREDENTIALS",
      message: "Missing credentials",
    });
  });

  test("refreshIfNeeded parks the row as needs-relogin without touching the network", async () => {
    const { database, manager, corrupted, refresher } = createFixture();
    let fetchCalls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        fetchCalls += 1;
        return new Response("unexpected", { status: 500 });
      },
      { preconnect: realFetch.preconnect },
    );

    const failure = await refresher
      .refreshIfNeeded(corrupted, placeholderAuth(corrupted))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(KiroTokenRefreshError);
    expect(failure).toMatchObject({ code: "MISSING_CREDENTIALS" });
    expect(fetchCalls).toBe(0);
    expectParked(database, manager);
  });

  test("forceRefresh parks the row the same way", async () => {
    const { database, manager, corrupted, refresher } = createFixture();

    const failure = await refresher.forceRefresh(corrupted).catch((error: unknown) => error);

    expect(failure).toMatchObject({ name: "KiroTokenRefreshError", code: "MISSING_CREDENTIALS" });
    expectParked(database, manager);
  });

  test("refreshAccessToken rejects an IdC refresh token without client parts before any request", async () => {
    let fetchCalls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 200 });
      },
      { preconnect: realFetch.preconnect },
    );

    const failure = await refreshAccessToken({
      refresh: "idc-refresh|idc",
      access: "old",
      expires: 0,
      authMethod: "idc",
      region: "us-east-1",
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ name: "KiroTokenRefreshError", code: "MISSING_CREDENTIALS" });
    expect(fetchCalls).toBe(0);
  });
});
