import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OpenCodeAuthStore, sameTokenSnapshot } from "../src/auth/opencode-auth-store.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import { rowToManagedAccount } from "../src/storage/account-record.js";

const stores: OpenCodeAuthStore[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** An opencode-kiro-auth database whose bookkeeping columns were never written. */
function createSparseDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "kiro-provider-sparse-rows-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "opencode", "kiro.db");
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath, { create: true, strict: true });
  db.run(`
		CREATE TABLE accounts (
			id TEXT PRIMARY KEY,
			email TEXT NOT NULL,
			auth_method TEXT NOT NULL,
			region TEXT NOT NULL,
			oidc_region TEXT,
			client_id TEXT,
			client_secret TEXT,
			profile_arn TEXT,
			start_url TEXT,
			refresh_token TEXT NOT NULL,
			access_token TEXT NOT NULL,
			expires_at INTEGER NOT NULL,
			rate_limit_reset INTEGER,
			is_healthy INTEGER,
			unhealthy_reason TEXT,
			recovery_time INTEGER,
			fail_count INTEGER,
			last_used INTEGER,
			used_count INTEGER,
			limit_count INTEGER,
			overage_count INTEGER,
			last_sync INTEGER
		)
	`);
  db.run("CREATE TABLE removed_accounts (id TEXT PRIMARY KEY, removed_at INTEGER NOT NULL)");
  db.query(`
		INSERT INTO accounts (id, email, auth_method, region, refresh_token, access_token, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run("sparse", "sparse@example.invalid", "desktop", "us-east-1", "refresh", "access", 1_000);
  db.query(`
		INSERT INTO accounts (
			id, email, auth_method, region, oidc_region, client_id, client_secret, profile_arn,
			start_url, refresh_token, access_token, expires_at, rate_limit_reset, is_healthy,
			unhealthy_reason, recovery_time, fail_count, last_used, used_count, limit_count,
			overage_count, last_sync
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
    "dense",
    "dense@example.invalid",
    "idc",
    "us-east-1",
    "us-east-1",
    "client",
    "secret",
    "arn:aws:codewhisperer:us-east-1:1:profile/x",
    "https://start.example.invalid",
    "refresh",
    "access",
    2_000,
    5,
    0,
    "Invalid refresh token",
    6,
    10,
    7,
    8,
    9,
    1,
    11,
  );
  db.close();
  return databasePath;
}

function credentials(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: "shared",
    email: "shared@example.invalid",
    authMethod: "idc",
    region: "us-east-1",
    clientId: "client",
    clientSecret: "secret",
    profileArn: "arn",
    startUrl: "https://start.example.invalid",
    refreshToken: "refresh",
    accessToken: "access",
    expiresAt: 1_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    ...overrides,
  };
}

describe("OpenCode auth store row mapping", () => {
  test("defaults NULL bookkeeping columns to a healthy, unused account", () => {
    const store = new OpenCodeAuthStore(createSparseDatabase());
    stores.push(store);

    expect(store.getById("sparse")).toEqual({
      id: "sparse",
      email: "sparse@example.invalid",
      authMethod: "desktop",
      region: "us-east-1",
      oidcRegion: undefined,
      clientId: undefined,
      clientSecret: undefined,
      profileArn: undefined,
      startUrl: undefined,
      refreshToken: "refresh",
      accessToken: "access",
      expiresAt: 1_000,
      rateLimitResetTime: 0,
      isHealthy: true,
      unhealthyReason: undefined,
      recoveryTime: undefined,
      failCount: 0,
      lastUsed: 0,
      usedCount: 0,
      limitCount: 0,
      lastSync: 0,
      overageCount: 0,
    });
  });

  test("maps a fully populated row exactly like the local row mapper", () => {
    const store = new OpenCodeAuthStore(createSparseDatabase());
    stores.push(store);

    expect(store.getById("dense")).toEqual(
      rowToManagedAccount({
        id: "dense",
        email: "dense@example.invalid",
        auth_method: "idc",
        region: "us-east-1",
        oidc_region: "us-east-1",
        client_id: "client",
        client_secret: "secret",
        profile_arn: "arn:aws:codewhisperer:us-east-1:1:profile/x",
        start_url: "https://start.example.invalid",
        refresh_token: "refresh",
        access_token: "access",
        expires_at: 2_000,
        rate_limit_reset: 5,
        is_healthy: 0,
        unhealthy_reason: "Invalid refresh token",
        recovery_time: 6,
        fail_count: 10,
        last_used: 7,
        used_count: 8,
        limit_count: 9,
        last_sync: 11,
        overage_count: 1,
      }),
    );
    expect(store.getById("dense")).toMatchObject({
      isHealthy: false,
      unhealthyReason: "Invalid refresh token",
      recoveryTime: 6,
      failCount: 10,
    });
  });

  test("sameTokenSnapshot compares every credential field and nothing else", () => {
    const base = credentials();
    expect(sameTokenSnapshot(base, credentials())).toBe(true);
    expect(
      sameTokenSnapshot(
        base,
        credentials({ usedCount: 99, lastUsed: 5, isHealthy: false, rateLimitResetTime: 7 }),
      ),
    ).toBe(true);
    const rotated: readonly Partial<ManagedAccount>[] = [
      { refreshToken: "other" },
      { accessToken: "other" },
      { expiresAt: 2_000 },
      { authMethod: "desktop" },
      { clientId: "other" },
      { clientSecret: "other" },
      { profileArn: "other" },
      { email: "other@example.invalid" },
      { startUrl: "https://other.example.invalid" },
    ];
    for (const change of rotated) {
      expect(sameTokenSnapshot(base, credentials(change))).toBe(false);
    }
  });
});
