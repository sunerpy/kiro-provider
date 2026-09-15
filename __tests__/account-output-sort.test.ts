import { describe, expect, test } from "bun:test";
import {
  ACCOUNT_SORT_FIELDS,
  type AccountListSort,
  type AccountSortField,
  DEFAULT_ACCOUNT_SORT,
  formatAccountList,
  sortAccounts,
} from "../src/cli/account-output.js";
import type { OveragePolicy } from "../src/kiro/health.js";
import type { StoredAccount } from "../src/storage/accounts-db.js";

const NOW = 1_700_000_000_000;
const OFF: OveragePolicy = { stopOnOverage: false, overageThreshold: 0 };

function stored(id: string, overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id,
    email: `${id}@example.com`,
    authMethod: "idc",
    region: "us-east-1",
    refreshToken: `${id}-refresh`,
    accessToken: `${id}-access`,
    expiresAt: NOW + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 10,
    limitCount: 100,
    overageCount: 0,
    generation: 1,
    ...overrides,
  };
}

function ids(accounts: readonly StoredAccount[]): string[] {
  return accounts.map(({ id }) => id);
}

function sortedIds(
  accounts: readonly StoredAccount[],
  field: AccountSortField,
  order: "asc" | "desc" = "asc",
): string[] {
  return ids(sortAccounts(accounts, { field, order }, OFF, NOW));
}

function emailsFromJson(lines: string[]): string[] {
  const parsed = JSON.parse(lines.join("\n")) as Array<{ email: string }>;
  return parsed.map(({ email }) => email);
}

describe("sortAccounts", () => {
  test("defaults to email ascending, case-insensitively, with an id tiebreak", () => {
    const accounts = [
      stored("z2", { email: "Beta@example.com" }),
      stored("z1", { email: "beta@example.com" }),
      stored("a", { email: "alpha@example.com" }),
    ];
    expect(ids(sortAccounts(accounts))).toEqual(["a", "z1", "z2"]);
    expect(DEFAULT_ACCOUNT_SORT).toEqual({ field: "email", order: "asc" });
  });

  test("does not mutate the input array", () => {
    const accounts = [stored("b"), stored("a")];
    const snapshot = ids(accounts);
    sortAccounts(accounts, { field: "email", order: "desc" });
    expect(ids(accounts)).toEqual(snapshot);
  });

  test("ranks availability from most to least usable", () => {
    const accounts = [
      stored("dead", { unhealthyReason: "invalid_grant", isHealthy: false }),
      stored("exhausted", { usedCount: 100 }),
      stored("ok"),
      stored("limited", { rateLimitResetTime: NOW + 60_000 }),
      stored("sick", { isHealthy: false }),
    ];
    expect(sortedIds(accounts, "availability")).toEqual([
      "ok",
      "limited",
      "sick",
      "exhausted",
      "dead",
    ]);
    expect(sortedIds(accounts, "availability", "desc")).toEqual([
      "dead",
      "exhausted",
      "sick",
      "limited",
      "ok",
    ]);
  });

  test("sorts usage by ratio rather than by the raw counter", () => {
    const accounts = [
      stored("small", { usedCount: 9, limitCount: 10 }),
      stored("big", { usedCount: 50, limitCount: 1000 }),
    ];
    expect(sortedIds(accounts, "usage")).toEqual(["big", "small"]);
    expect(sortedIds(accounts, "usage", "desc")).toEqual(["small", "big"]);
  });

  test("keeps accounts without a value for the column last in both directions", () => {
    const accounts = [
      stored("unknown-quota", { limitCount: 0 }),
      stored("busy", { usedCount: 80 }),
      stored("idle", { usedCount: 1 }),
    ];
    expect(sortedIds(accounts, "usage")).toEqual(["idle", "busy", "unknown-quota"]);
    expect(sortedIds(accounts, "usage", "desc")).toEqual(["busy", "idle", "unknown-quota"]);
  });

  test("treats a zero or missing timestamp as no value", () => {
    const accounts = [
      stored("never", { lastUsed: 0 }),
      stored("absent"),
      stored("recent", { lastUsed: NOW - 1_000 }),
      stored("old", { lastUsed: NOW - 100_000 }),
    ];
    expect(sortedIds(accounts, "last-used")).toEqual(["old", "recent", "absent", "never"]);
    expect(sortedIds(accounts, "last-used", "desc")).toEqual(["recent", "old", "absent", "never"]);
  });

  test("sorts health, region, auth, overage, generation, and ids", () => {
    const health = [stored("sick", { isHealthy: false }), stored("ok")];
    expect(sortedIds(health, "health")).toEqual(["ok", "sick"]);
    expect(sortedIds(health, "health", "desc")).toEqual(["sick", "ok"]);

    const regions = [stored("eu", { region: "eu-west-1" }), stored("us", { region: "us-east-1" })];
    expect(sortedIds(regions, "region", "desc")).toEqual(["us", "eu"]);

    const auth = [stored("idc"), stored("desktop", { authMethod: "desktop" })];
    expect(sortedIds(auth, "auth")).toEqual(["desktop", "idc"]);

    const overage = [stored("paid", { overageCount: 7 }), stored("free")];
    expect(sortedIds(overage, "overage", "desc")).toEqual(["paid", "free"]);

    const generation = [stored("new", { generation: 9 }), stored("old", { generation: 2 })];
    expect(sortedIds(generation, "generation")).toEqual(["old", "new"]);

    const byId = [
      stored("b", { email: "same@example.com" }),
      stored("a", { email: "same@example.com" }),
    ];
    expect(sortedIds(byId, "id")).toEqual(["a", "b"]);
  });

  test("sorts token-expires and last-sync oldest first when ascending", () => {
    const accounts = [
      stored("later", { expiresAt: NOW + 7_200_000, lastSync: NOW - 10 }),
      stored("sooner", { expiresAt: NOW + 60_000, lastSync: NOW - 5_000 }),
    ];
    expect(sortedIds(accounts, "token-expires")).toEqual(["sooner", "later"]);
    expect(sortedIds(accounts, "last-sync")).toEqual(["sooner", "later"]);
  });

  test("every documented field produces a total order", () => {
    const accounts = [stored("b", { limitCount: 0 }), stored("a"), stored("c", { lastSync: NOW })];
    for (const field of ACCOUNT_SORT_FIELDS) {
      for (const order of ["asc", "desc"] as const) {
        const sort: AccountListSort = { field, order };
        expect(ids(sortAccounts(accounts, sort, OFF, NOW)).sort()).toEqual(["a", "b", "c"]);
      }
    }
  });
});

describe("formatAccountList sorting", () => {
  const accounts = [
    stored("b", { email: "b@example.com", usedCount: 90 }),
    stored("a", { email: "a@example.com", usedCount: 5 }),
  ];

  test("applies the sort to table rows", () => {
    const [, , ...rows] = formatAccountList(accounts, "table", OFF, {
      field: "usage",
      order: "desc",
    });
    expect(rows[0]).toContain("b@example.com");
    expect(rows[1]).toContain("a@example.com");
  });

  test("applies the sort to details rows", () => {
    const [, , ...rows] = formatAccountList(accounts, "details", OFF, {
      field: "usage",
      order: "desc",
    });
    expect(rows[0]).toContain("b@example.com");
    expect(rows[1]).toContain("a@example.com");
  });

  test("applies the sort to json output", () => {
    expect(
      emailsFromJson(formatAccountList(accounts, "json", OFF, { field: "usage", order: "desc" })),
    ).toEqual(["b@example.com", "a@example.com"]);
    expect(emailsFromJson(formatAccountList(accounts, "json", OFF))).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  test("keeps email ascending when no sort is given", () => {
    const [, , ...rows] = formatAccountList(accounts, "table");
    expect(rows[0]).toContain("a@example.com");
    expect(rows[1]).toContain("b@example.com");
  });

  test("uses the injected clock for availability and rate-limit ordering", () => {
    const rateLimited = [stored("limited", { rateLimitResetTime: NOW + 60_000 }), stored("ready")];
    expect(
      formatAccountList(rateLimited, "table", OFF, { field: "availability", order: "asc" }, NOW)[2],
    ).toContain("ready@example.com");
    // Past the reset instant the rate limit no longer applies, so the stable
    // email tiebreak decides the order instead.
    expect(
      formatAccountList(
        rateLimited,
        "table",
        OFF,
        { field: "availability", order: "asc" },
        NOW + 120_000,
      )[2],
    ).toContain("limited@example.com");
  });
});
