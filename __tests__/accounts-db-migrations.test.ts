import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedAccount } from "../src/kiro/types.js";
import {
  ACCOUNTS_DB_SCHEMA_VERSION,
  AccountsDatabase,
  type ReasoningReplayRecord,
} from "../src/storage/accounts-db.js";

const temporaryDirectories: string[] = [];
const openDatabases: AccountsDatabase[] = [];

function account(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: "account-1",
    email: "builder@example.com",
    authMethod: "desktop",
    region: "us-east-1",
    refreshToken: "refresh-token-1",
    accessToken: "access-token-1",
    expiresAt: 2_000_000_000_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    ...overrides,
  };
}

function replayRecord(overrides: Partial<ReasoningReplayRecord> = {}): ReasoningReplayRecord {
  return {
    tokenHash: "token-hash-1",
    chatLookupHash: "chat-hash-1",
    fingerprintHash: "fingerprint-1",
    tenantId: "tenant-1",
    accountId: "account-a",
    conversationId: "conversation-a",
    model: "claude-opus-5",
    keyId: "rk_test",
    nonce: new Uint8Array(12),
    ciphertext: new Uint8Array([1, 2, 3]),
    authTag: new Uint8Array(16),
    createdAt: 1_000,
    lastSeen: 1_000,
    expiresAt: 100_000,
    ...overrides,
  };
}

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "kiro-provider-migrations-"));
  temporaryDirectories.push(directory);
  return join(directory, "accounts.db");
}

function open(path: string): AccountsDatabase {
  const database = new AccountsDatabase(path);
  openDatabases.push(database);
  return database;
}

function rawUserVersion(path: string): number {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? -1;
  } finally {
    raw.close();
  }
}

function rawTables(path: string): string[] {
  const raw = new Database(path, { readonly: true });
  try {
    return raw
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map(({ name }) => name);
  } finally {
    raw.close();
  }
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("AccountsDatabase schema versioning", () => {
  test("stamps user_version and creates every table on a fresh database", () => {
    const path = temporaryDatabasePath();
    const database = open(path);

    expect(ACCOUNTS_DB_SCHEMA_VERSION).toBeGreaterThan(0);
    expect(database.schemaVersion()).toBe(ACCOUNTS_DB_SCHEMA_VERSION);
    expect(rawUserVersion(path)).toBe(ACCOUNTS_DB_SCHEMA_VERSION);
    expect(rawTables(path)).toEqual([
      "accounts",
      "output_lineage",
      "reasoning_replay",
      "removed_accounts",
      "session_affinity",
    ]);
  });

  test("brings a column-probe era database forward and stamps its version", () => {
    const path = temporaryDatabasePath();
    const legacy = new Database(path, { create: true });
    legacy.exec(`
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
      );
      CREATE TABLE removed_accounts (
        id TEXT PRIMARY KEY, removed_at INTEGER NOT NULL, last_generation INTEGER NOT NULL
      );
      CREATE TABLE session_affinity (
        key_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      INSERT INTO accounts (id, email, auth_method, region, refresh_token, access_token, expires_at)
      VALUES ('legacy-1', 'legacy@example.com', 'desktop', 'eu-west-1', 'r', 'a', 2000000000000);
      INSERT INTO session_affinity VALUES ('key-1', 'legacy-1', 'conv-1', 1, 1, 9999999999999);
    `);
    legacy.close();
    expect(rawUserVersion(path)).toBe(0);

    const database = open(path);

    expect(database.schemaVersion()).toBe(ACCOUNTS_DB_SCHEMA_VERSION);
    expect(rawTables(path)).toContain("output_lineage");
    expect(rawTables(path)).toContain("reasoning_replay");
    expect(database.getById("legacy-1")).toMatchObject({ region: "eu-west-1", generation: 1 });
    expect(database.getSessionAffinity("key-1", 2)).toMatchObject({ accountId: "legacy-1" });
  });

  test("reopening a versioned database is idempotent and leaves a newer version untouched", () => {
    const path = temporaryDatabasePath();
    open(path);
    open(path);
    expect(rawUserVersion(path)).toBe(ACCOUNTS_DB_SCHEMA_VERSION);

    const future = ACCOUNTS_DB_SCHEMA_VERSION + 7;
    const raw = new Database(path);
    raw.run(`PRAGMA user_version = ${future}`);
    raw.close();

    const reopened = open(path);
    expect(reopened.schemaVersion()).toBe(future);
    expect(reopened.getAccounts()).toEqual([]);
  });
});

describe("AccountsDatabase account removal cascade", () => {
  test("removes output lineage and reasoning replay rows owned by the account only", () => {
    const database = open(temporaryDatabasePath());
    database.insertAccount(account({ id: "account-a" }));
    database.insertAccount(account({ id: "account-b", refreshToken: "refresh-token-2" }));
    database.claimSessionAffinity("session-a", "account-a", "conversation-a", 1_000, 100_000, 100);
    database.recordOutputLineage("lineage-a", "account-a", "conversation-a", 1_000, 100_000, 100);
    database.recordOutputLineage("lineage-b", "account-b", "conversation-b", 1_000, 100_000, 100);
    database.insertReasoningReplay(
      replayRecord({ tokenHash: "token-a", accountId: "account-a" }),
      100,
      1_000,
    );
    database.insertReasoningReplay(
      replayRecord({
        tokenHash: "token-b",
        chatLookupHash: "chat-hash-b",
        accountId: "account-b",
        conversationId: "conversation-b",
        keyId: "rk_other",
      }),
      100,
      1_000,
    );

    database.removeAccount("account-a");

    expect(database.getSessionAffinity("session-a", 2_000)).toBeUndefined();
    expect(database.resolveOutputLineage("lineage-a", 2_000)).toBeUndefined();
    expect(database.getReasoningReplayRecord("token-a")).toBeUndefined();
    expect(
      database.findReasoningReplayByChatHash("tenant-1", "claude-opus-5", "chat-hash-1", 2_000),
    ).toEqual([]);
    expect(database.activeReasoningReplayKeyIds(2_000)).toEqual(["rk_other"]);
    expect(database.resolveOutputLineage("lineage-b", 2_000)).toMatchObject({
      accountId: "account-b",
    });
    expect(database.getReasoningReplayRecord("token-b")).toMatchObject({ accountId: "account-b" });
    expect(database.getAccounts().map((row) => row.id)).toEqual(["account-b"]);
  });
});

describe("AccountsDatabase file permissions", () => {
  test("creates the database 0600 before SQLite opens it so WAL sidecars inherit the mode", () => {
    const path = temporaryDatabasePath();
    const database = open(path);
    database.insertAccount(account());

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}-wal`)).toBe(true);
    for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
      if (existsSync(sidecar)) expect(statSync(sidecar).mode & 0o777).toBe(0o600);
    }
  });

  test("tightens a pre-existing world-readable database at open", () => {
    const path = temporaryDatabasePath();
    const loose = new Database(path, { create: true });
    loose.close();
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);

    open(path);

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
