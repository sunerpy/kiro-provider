import { describe, expect, test } from "bun:test";
import { ACCOUNT_SORT_FIELDS } from "../src/cli/account-output.js";
import { type CliDependencies, main, parseCliArgs } from "../src/cli/main.js";
import type { StoredAccount } from "../src/storage/accounts-db.js";

function stored(id: string, overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id,
    email: `${id}@example.com`,
    authMethod: "idc",
    region: "us-east-1",
    refreshToken: `${id}-refresh`,
    accessToken: `${id}-access`,
    expiresAt: Date.now() + 3_600_000,
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

function createHarness(accounts: readonly StoredAccount[]): {
  readonly deps: CliDependencies;
  readonly stdout: string[];
  readonly closes: number[];
} {
  const stdout: string[] = [];
  const closes: number[] = [];
  const deps: CliDependencies = {
    loadConfig: () => {
      throw new Error("accounts list must not load the gateway configuration");
    },
    startServer: () => ({}),
    runLogin: async () => {
      throw new Error("runLogin must not be called by this test");
    },
    runAccountRefresh: async () => {
      throw new Error("runAccountRefresh must not be called by this test");
    },
    runImportAccounts: () => undefined,
    checkForUpdate: () => {
      throw new Error("checkForUpdate must not be called by this test");
    },
    runSelfUpdate: () => {
      throw new Error("runSelfUpdate must not be called by this test");
    },
    openDb: () => ({
      getAccounts: () => [...accounts],
      insertAccount: (managedAccount) => ({ ...managedAccount, generation: 1 }),
      removeAccount: () => undefined,
      close: () => {
        closes.push(1);
      },
    }),
    confirm: async () => true,
    stdout: (message) => stdout.push(message),
    stderr: () => undefined,
  };
  return { deps, stdout, closes };
}

/** Emails in the order the command printed them, skipping the table header. */
async function listedEmails(argv: readonly string[], accounts: readonly StoredAccount[]) {
  const harness = createHarness(accounts);
  expect(await main([...argv], harness.deps)).toBe(0);
  expect(harness.closes).toEqual([1]);
  const rows = argv.includes("--json")
    ? (JSON.parse(harness.stdout.join("\n")) as Array<{ email: string }>).map(({ email }) => email)
    : harness.stdout
        .slice(2)
        .map((row) => row.match(/\S+@example\.com/)?.[0] ?? "")
        .filter(Boolean);
  return rows;
}

describe("accounts list --sort parsing", () => {
  test("defaults to email ascending", () => {
    expect(parseCliArgs(["accounts", "list"])).toEqual({
      kind: "accounts-list",
      mode: "table",
      sort: { field: "email", order: "asc" },
    });
  });

  test("accepts every documented field and both orders", () => {
    for (const field of ACCOUNT_SORT_FIELDS) {
      expect(parseCliArgs(["accounts", "list", "--sort", field, "--order", "desc"])).toEqual({
        kind: "accounts-list",
        mode: "table",
        sort: { field, order: "desc" },
      });
    }
  });

  test("normalizes case and underscore spellings", () => {
    expect(parseCliArgs(["accounts", "list", "--sort", "LAST_USED", "--order", "DESC"])).toEqual({
      kind: "accounts-list",
      mode: "table",
      sort: { field: "last-used", order: "desc" },
    });
    expect(parseCliArgs(["accounts", "list", "--sort", " token_expires "])).toEqual({
      kind: "accounts-list",
      mode: "table",
      sort: { field: "token-expires", order: "asc" },
    });
  });

  test("keeps the sort alongside --details and --json", () => {
    expect(parseCliArgs(["accounts", "list", "--details", "--sort", "usage"])).toEqual({
      kind: "accounts-list",
      mode: "details",
      sort: { field: "usage", order: "asc" },
    });
    expect(parseCliArgs(["accounts", "list", "--json", "--order", "desc"])).toEqual({
      kind: "accounts-list",
      mode: "json",
      sort: { field: "email", order: "desc" },
    });
  });

  test("rejects an unknown field or order and lists the supported values", () => {
    expect(() => parseCliArgs(["accounts", "list", "--sort", "quota"])).toThrow(
      "Unknown accounts list sort field: quota",
    );
    expect(() => parseCliArgs(["accounts", "list", "--sort", "quota"])).toThrow("availability");
    expect(() => parseCliArgs(["accounts", "list", "--order", "descending"])).toThrow(
      "Unknown accounts list sort order: descending",
    );
    expect(() => parseCliArgs(["accounts", "list", "--order", "descending"])).toThrow("asc, desc");
  });

  test("still requires a value for the flags", () => {
    expect(() => parseCliArgs(["accounts", "list", "--sort"])).toThrow();
    expect(() => parseCliArgs(["accounts", "list", "--order"])).toThrow();
  });
});

describe("accounts list --sort dispatch", () => {
  const accounts = [
    stored("busy", { email: "busy@example.com", usedCount: 95 }),
    stored("idle", { email: "idle@example.com", usedCount: 2 }),
    stored("mid", { email: "mid@example.com", usedCount: 40 }),
  ];

  test("orders table rows by the requested column", async () => {
    expect(
      await listedEmails(["accounts", "list", "--sort", "usage", "--order", "desc"], accounts),
    ).toEqual(["busy@example.com", "mid@example.com", "idle@example.com"]);
  });

  test("orders json output by the requested column", async () => {
    expect(await listedEmails(["accounts", "list", "--json", "--sort", "usage"], accounts)).toEqual(
      ["idle@example.com", "mid@example.com", "busy@example.com"],
    );
  });

  test("falls back to email ascending with no flags", async () => {
    expect(await listedEmails(["accounts", "list"], accounts)).toEqual([
      "busy@example.com",
      "idle@example.com",
      "mid@example.com",
    ]);
  });

  test("ranks the least usable account last when sorting by availability", async () => {
    const mixed = [
      stored("zz-dead", { email: "zz-dead@example.com", isHealthy: false }),
      stored("aa-ok", { email: "aa-ok@example.com" }),
    ];
    expect(await listedEmails(["accounts", "list", "--sort", "availability"], mixed)).toEqual([
      "aa-ok@example.com",
      "zz-dead@example.com",
    ]);
  });
});
