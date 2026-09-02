import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultOpenCodeDatabasePath, runImportAccounts } from "../src/cli/import-accounts.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

const temporaryDirectories: string[] = [];
const openDatabases: AccountsDatabase[] = [];

const LEGACY_ACCOUNTS_SCHEMA = `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, auth_method TEXT NOT NULL,
    region TEXT NOT NULL, oidc_region TEXT, client_id TEXT, client_secret TEXT,
    profile_arn TEXT, start_url TEXT, refresh_token TEXT NOT NULL,
    access_token TEXT NOT NULL, expires_at INTEGER NOT NULL,
    rate_limit_reset INTEGER DEFAULT 0, is_healthy INTEGER DEFAULT 1,
    unhealthy_reason TEXT, recovery_time INTEGER, fail_count INTEGER DEFAULT 0,
    last_used INTEGER DEFAULT 0, used_count INTEGER DEFAULT 0,
    limit_count INTEGER DEFAULT 0, last_sync INTEGER DEFAULT 0,
    overage_count INTEGER DEFAULT 0
  )
`;

type SourceRow = {
  readonly id: string;
  readonly email: string;
  readonly expiresAt: number;
  readonly lastSync: number;
  readonly refreshToken?: string;
};

function temporaryPath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), "kiro-provider-import-force-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

function createSource(rows: readonly SourceRow[]): string {
  const sourcePath = temporaryPath("opencode-kiro.db");
  const source = new Database(sourcePath, { create: true });
  source.exec(LEGACY_ACCOUNTS_SCHEMA);
  for (const row of rows) {
    source
      .query(`
        INSERT INTO accounts (
          id, email, auth_method, region, oidc_region, client_id, client_secret,
          profile_arn, start_url, refresh_token, access_token, expires_at,
          rate_limit_reset, is_healthy, fail_count, last_used, used_count,
          limit_count, last_sync, overage_count
        ) VALUES (?, ?, 'desktop', 'us-east-1', NULL, NULL, NULL, NULL, NULL, ?, 'source-access', ?, 0, 1, 0, 0, 1, 100, ?, 0)
      `)
      .run(row.id, row.email, row.refreshToken ?? "source-refresh", row.expiresAt, row.lastSync);
  }
  source.close();
  return sourcePath;
}

function localAccount(overrides: Partial<ManagedAccount>): ManagedAccount {
  return {
    id: "acct",
    email: "dev@example.com",
    authMethod: "desktop",
    region: "us-east-1",
    refreshToken: "local-refresh",
    accessToken: "local-access",
    expiresAt: 1_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 9,
    limitCount: 100,
    lastSync: 1_000,
    overageCount: 0,
    ...overrides,
  };
}

function openTarget(): AccountsDatabase {
  const target = new AccountsDatabase(temporaryPath("provider-accounts.db"));
  openDatabases.push(target);
  return target;
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runImportAccounts newer-local protection", () => {
  test("skips a row whose local access token expires later", () => {
    const sourcePath = createSource([
      { id: "acct", email: "dev@example.com", expiresAt: 1_000, lastSync: 1_000 },
    ]);
    const target = openTarget();
    target.insertAccount(localAccount({ expiresAt: 2_000 }));
    const output: string[] = [];

    const result = runImportAccounts(
      { from: sourcePath },
      { database: target, stdout: (line) => output.push(line) },
    );

    expect(result).toEqual({ imported: 0, skipped: 1, total: 1 });
    expect(output).toEqual([
      "Skipped dev@example.com: local copy is newer (use --force to overwrite)",
      "Imported 0, skipped 1, total in DB now 1",
    ]);
    expect(target.getById("acct")).toMatchObject({
      refreshToken: "local-refresh",
      accessToken: "local-access",
      expiresAt: 2_000,
      generation: 1,
    });
  });

  test("skips a row whose local usage sync is newer", () => {
    const sourcePath = createSource([
      { id: "acct", email: "dev@example.com", expiresAt: 1_000, lastSync: 1_000 },
    ]);
    const target = openTarget();
    target.insertAccount(localAccount({ lastSync: 5_000 }));

    const result = runImportAccounts(
      { from: sourcePath },
      { database: target, stdout: () => undefined },
    );

    expect(result).toEqual({ imported: 0, skipped: 1, total: 1 });
    expect(target.getById("acct")?.usedCount).toBe(9);
  });

  test("overwrites a newer local row when --force is given", () => {
    const sourcePath = createSource([
      { id: "acct", email: "dev@example.com", expiresAt: 1_000, lastSync: 1_000 },
    ]);
    const target = openTarget();
    target.insertAccount(localAccount({ expiresAt: 2_000, lastSync: 5_000 }));
    const output: string[] = [];

    const result = runImportAccounts(
      { from: sourcePath, force: true },
      { database: target, stdout: (line) => output.push(line) },
    );

    expect(result).toEqual({ imported: 1, skipped: 0, total: 1 });
    expect(output[0]).toBe("Imported dev@example.com\tdesktop\tus-east-1");
    expect(target.getById("acct")).toMatchObject({
      refreshToken: "source-refresh",
      accessToken: "source-access",
      expiresAt: 1_000,
      generation: 2,
    });
  });

  test("imports rows that are newer than or equal to the local copy, and new rows", () => {
    const sourcePath = createSource([
      { id: "newer", email: "newer@example.com", expiresAt: 3_000, lastSync: 3_000 },
      { id: "equal", email: "equal@example.com", expiresAt: 1_000, lastSync: 1_000 },
      { id: "fresh", email: "fresh@example.com", expiresAt: 10, lastSync: 10 },
    ]);
    const target = openTarget();
    target.insertAccount(
      localAccount({ id: "newer", email: "newer@example.com", expiresAt: 1_000 }),
    );
    target.insertAccount(
      localAccount({ id: "equal", email: "equal@example.com", expiresAt: 1_000 }),
    );

    const result = runImportAccounts(
      { from: sourcePath },
      { database: target, stdout: () => undefined },
    );

    expect(result).toEqual({ imported: 3, skipped: 0, total: 3 });
    expect(target.getById("newer")?.refreshToken).toBe("source-refresh");
    expect(target.getById("equal")?.refreshToken).toBe("source-refresh");
    expect(target.getById("fresh")?.refreshToken).toBe("source-refresh");
  });

  test("still reports unusable rows before comparing against the local copy", () => {
    const sourcePath = createSource([
      {
        id: "acct",
        email: "dev@example.com",
        expiresAt: 1_000,
        lastSync: 1_000,
        refreshToken: "",
      },
    ]);
    const target = openTarget();
    target.insertAccount(localAccount({ expiresAt: 2_000 }));
    const output: string[] = [];

    const result = runImportAccounts(
      { from: sourcePath },
      { database: target, stdout: (line) => output.push(line) },
    );

    expect(result).toEqual({ imported: 0, skipped: 1, total: 1 });
    expect(output[0]).toBe("Skipped dev@example.com: missing refresh token");
  });
});

describe("defaultOpenCodeDatabasePath", () => {
  test("uses APPDATA on win32 and XDG_CONFIG_HOME elsewhere", () => {
    expect(
      defaultOpenCodeDatabasePath({ APPDATA: "/appdata", XDG_CONFIG_HOME: "/xdg" }, "win32"),
    ).toBe(join("/appdata", "opencode", "kiro.db"));
    expect(
      defaultOpenCodeDatabasePath({ APPDATA: "/appdata", XDG_CONFIG_HOME: "/xdg" }, "linux"),
    ).toBe(join("/xdg", "opencode", "kiro.db"));
  });
});
