import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KiroRegion, ManagedAccount } from "../src/kiro/types.js";
import { rowToAccount, validatedRegions } from "../src/storage/account-record.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

const HOSTILE_REGION = "evil.example/";
const temporaryDirectories: string[] = [];
const closers: Array<() => void> = [];

function account(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: "account-1",
    email: "builder@example.com",
    authMethod: "idc",
    region: "us-east-1",
    oidcRegion: "us-west-2",
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshToken: "refresh-token-1",
    accessToken: "access-token-1",
    expiresAt: 2_000_000_000_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    ...overrides,
  };
}

function temporaryPath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), "kiro-provider-region-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

function openLocal(): readonly [AccountsDatabase, string] {
  const path = temporaryPath("accounts.db");
  const database = new AccountsDatabase(path);
  closers.push(() => database.close());
  return [database, path];
}

function corruptColumn(
  path: string,
  id: string,
  column: "region" | "oidc_region",
  value: string,
): void {
  const raw = new Database(path, { strict: true });
  raw.query(`UPDATE accounts SET ${column} = ? WHERE id = ?`).run(value, id);
  raw.close();
}

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("validatedRegions", () => {
  test("accepts known regions and rejects hostname-shaped values with an audit warning", () => {
    const warn = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(validatedRegions({ id: "a", region: "eu-west-1", oidc_region: null })).toEqual({
        region: "eu-west-1",
        oidcRegion: undefined,
      });
      expect(
        validatedRegions({ id: "a", region: "us-east-1", oidc_region: "ap-southeast-1" }),
      ).toEqual({
        region: "us-east-1",
        oidcRegion: "ap-southeast-1",
      });
      expect(
        validatedRegions({ id: "a", region: HOSTILE_REGION, oidc_region: null }),
      ).toBeUndefined();
      expect(
        validatedRegions({ id: "a", region: "us-east-1", oidc_region: HOSTILE_REGION }),
      ).toBeUndefined();
      expect(validatedRegions({ id: "a", region: "", oidc_region: null })).toBeUndefined();

      const events = warn.mock.calls.map(
        (call) => JSON.parse(String(call[0])) as Record<string, unknown>,
      );
      expect(events).toHaveLength(3);
      expect(events[0]).toMatchObject({
        level: "warn",
        event: "account_row_invalid_region",
        column: "region",
        value: HOSTILE_REGION,
      });
      expect(events[1]).toMatchObject({ column: "oidc_region", value: HOSTILE_REGION });
      expect(events.every((event) => !("id" in event))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("rowToAccount skips a row whose region is not a known Kiro region", () => {
    const warn = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(
        rowToAccount({
          id: "a",
          email: "a@example.com",
          auth_method: "desktop",
          region: HOSTILE_REGION,
          oidc_region: null,
          client_id: null,
          client_secret: null,
          profile_arn: null,
          start_url: null,
          refresh_token: "r",
          access_token: "a",
          expires_at: 1,
          rate_limit_reset: 0,
          is_healthy: 1,
          unhealthy_reason: null,
          recovery_time: null,
          fail_count: 0,
          last_used: 0,
          used_count: 0,
          limit_count: 0,
          last_sync: 0,
          overage_count: 0,
          generation: 1,
        }),
      ).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("AccountsDatabase region validation", () => {
  test("does not load a row whose region was rewritten to a hostname", () => {
    const [database, path] = openLocal();
    database.insertAccount(account({ id: "tampered" }));
    database.insertAccount(account({ id: "intact", refreshToken: "refresh-token-2" }));
    corruptColumn(path, "tampered", "region", HOSTILE_REGION);

    const warn = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(database.getAccounts().map((row) => row.id)).toEqual(["intact"]);
      expect(database.getById("tampered")).toBeUndefined();
      expect(database.getById("intact")?.region).toBe("us-east-1");
    } finally {
      warn.mockRestore();
    }
  });

  test("does not load a row whose oidc_region was rewritten to a hostname", () => {
    const [database, path] = openLocal();
    database.insertAccount(account({ id: "tampered" }));
    corruptColumn(path, "tampered", "oidc_region", HOSTILE_REGION);

    const warn = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(database.getAccounts()).toEqual([]);
      expect(database.getById("tampered")).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  test("refuses to persist an account carrying an invalid region", () => {
    const [database] = openLocal();
    const warn = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() =>
        database.insertAccount(account({ id: "bad", region: HOSTILE_REGION as KiroRegion })),
      ).toThrow(/invalid region/);
      expect(database.getAccounts()).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
