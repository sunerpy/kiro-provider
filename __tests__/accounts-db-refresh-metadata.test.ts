import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedAccount } from "../src/kiro/types.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function path() {
  const root = mkdtempSync(join(tmpdir(), "kiro-refresh-metadata-"));
  roots.push(root);
  return join(root, "accounts.db");
}
function account(): ManagedAccount {
  return {
    id: "synthetic-owner",
    email: "synthetic@example.test",
    authMethod: "idc",
    region: "us-east-1",
    oidcRegion: "eu-central-1",
    profileArn: "synthetic-profile",
    clientId: "synthetic-client",
    clientSecret: "synthetic-secret",
    refreshToken: "synthetic-refresh",
    accessToken: "synthetic-access",
    expiresAt: 2_000_000_000_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
  };
}
const fields = [
  "client_id_issued_at",
  "client_secret_expires_at",
  "refresh_failure_count",
  "refresh_failure_code",
  "refresh_failed_at",
  "refresh_retry_at",
  "last_refresh_at",
];
const metadata = {
  clientIdIssuedAt: 1_700_000_000_000,
  clientSecretExpiresAt: 1_800_000_000_000,
  refreshFailureCount: 2,
  refreshFailureCode: "invalid_request" as const,
  refreshFailedAt: 1_750_000_000_000,
  refreshRetryAt: 1_750_000_060_000,
  lastRefreshAt: 1_740_000_000_000,
};

test("v8 to v9 migration adds nullable metadata without replacing credentials, owner or replay state", () => {
  const file = path();
  let db = new AccountsDatabase(file);
  const original = db.insertAccount(account());
  db.claimSessionAffinity(
    "synthetic-affinity",
    original.id,
    "synthetic-conversation",
    10,
    10000,
    10,
  );
  db.recordOutputLineage("synthetic-lineage", original.id, "synthetic-conversation", 10, 10000, 10);
  db.insertReasoningReplay(
    {
      tokenHash: "synthetic-token",
      chatLookupHash: null,
      fingerprintHash: "synthetic-fingerprint",
      tenantId: "synthetic-tenant",
      accountId: original.id,
      conversationId: "synthetic-conversation",
      model: "kimi-k3",
      keyId: "synthetic-key",
      nonce: new Uint8Array(12),
      ciphertext: new Uint8Array([1, 2]),
      authTag: new Uint8Array(16),
      createdAt: 10,
      lastSeen: 10,
      expiresAt: 10000,
    },
    10,
    20,
  );
  db.close();
  // The v8 tables are unchanged by v9 apart from these added account columns.
  const raw = new Database(file);
  const names = (raw.query("PRAGMA table_info(accounts)").all() as { name: string }[]).map(
    (x) => x.name,
  );
  for (const field of fields)
    if (names.includes(field)) raw.run(`ALTER TABLE accounts DROP COLUMN ${field}`);
  raw.run("PRAGMA user_version=8");
  raw.close();
  db = new AccountsDatabase(file);
  try {
    expect(db.schemaVersion()).toBe(9);
    expect(db.getById(original.id)).toEqual(original);
    expect(db.getSessionAffinity("synthetic-affinity", 20)?.accountId).toBe(original.id);
    expect(db.resolveOutputLineage("synthetic-lineage", 20)?.accountId).toBe(original.id);
    expect(db.getReasoningReplayRecord("synthetic-token")?.ciphertext).toEqual(
      new Uint8Array([1, 2]),
    );
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  } finally {
    db.close();
  }
});

test("all seven fields persist across reopen and CAS updates reject a stale credential epoch", () => {
  const file = path();
  let db = new AccountsDatabase(file);
  const first = db.insertAccount({ ...account(), ...metadata });
  db.close();
  db = new AccountsDatabase(file);
  try {
    expect(db.getById(first.id)).toMatchObject(metadata);
    expect(
      db.updateExistingAccounts([
        { ...first, refreshFailureCount: 3, refreshRetryAt: metadata.refreshRetryAt + 1 },
      ]),
    ).toBe(1);
    const newer = db.getById(first.id)!;
    expect(newer).toMatchObject({
      ...metadata,
      refreshFailureCount: 3,
      refreshRetryAt: metadata.refreshRetryAt + 1,
    });
    expect(
      db.updateExistingAccounts([{ ...first, ...metadata, accessToken: "stale-access" }]),
    ).toBe(0);
    expect(db.getById(first.id)).toEqual(newer);
    const reset = db.insertAccount(account());
    for (const key of Object.keys(metadata)) expect(reset).not.toHaveProperty(key);
    expect(db.getById(first.id)).toEqual(reset);
  } finally {
    db.close();
  }
});

test("v9 tolerates already-present metadata columns without overwriting their values", () => {
  const file = path();
  let db = new AccountsDatabase(file);
  const original = db.insertAccount({ ...account(), ...metadata });
  db.close();
  const raw = new Database(file);
  for (const column of fields.slice(2)) raw.run(`ALTER TABLE accounts DROP COLUMN ${column}`);
  raw.run("PRAGMA user_version=8");
  raw.close();
  db = new AccountsDatabase(file);
  try {
    expect(db.schemaVersion()).toBe(9);
    expect(db.getById(original.id)).toMatchObject({
      clientIdIssuedAt: metadata.clientIdIssuedAt,
      clientSecretExpiresAt: metadata.clientSecretExpiresAt,
      refreshToken: original.refreshToken,
      generation: original.generation,
    });
    expect(db.getById(original.id)).not.toHaveProperty("refreshFailureCount");
  } finally {
    db.close();
  }
});

test("invalid optional metadata and failure enums cannot partially replace a stored credential row", () => {
  const db = new AccountsDatabase(":memory:");
  try {
    const original = db.insertAccount(account());
    for (const value of [-1, NaN, Infinity, 1e20, 1.5]) {
      expect(() => db.insertAccount({ ...account(), clientSecretExpiresAt: value })).toThrow(
        "Invalid account",
      );
      expect(db.getById(original.id)).toEqual(original);
    }
    expect(() =>
      db.insertAccount({
        ...account(),
        refreshFailureCode: "untrusted-code" as ManagedAccount["refreshFailureCode"],
      }),
    ).toThrow("Invalid account");
    expect(db.getById(original.id)).toEqual(original);
  } finally {
    db.close();
  }
});
