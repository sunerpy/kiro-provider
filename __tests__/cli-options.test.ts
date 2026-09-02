import { afterEach, describe, expect, test } from "bun:test";
import { CLI_USAGE, type CliDependencies, main, parseCliArgs } from "../src/cli/main.js";
import { ConfigSchema } from "../src/config/schema.js";
import { getAuditLogLevel, resetAuditLogLevel } from "../src/core/audit-log.js";
import type { StoredAccount } from "../src/storage/accounts-db.js";

function account(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id: "account-1",
    email: "dev@example.com",
    authMethod: "idc",
    region: "us-east-1",
    refreshToken: "refresh-secret",
    accessToken: "access-secret",
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 4,
    limitCount: 100,
    generation: 1,
    ...overrides,
  };
}

function createDependencies(logLevel: "debug" | "info" | "warn" | "error"): {
  readonly deps: CliDependencies;
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: CliDependencies = {
    loadConfig: (options) =>
      ConfigSchema.parse({
        api_keys: ["sk-test"],
        log_level: logLevel,
        ...options.overrides,
      }),
    startServer: (config) => ({ hostname: config.host, port: config.port }),
    runLogin: async (_config, options) => ({
      account: options.replaceAccount ?? account(),
      removedDuplicateIds: [],
    }),
    runAccountRefresh: async () => ({
      startedAt: 1,
      completedAt: 2,
      totalAccounts: 0,
      tokenRenewed: 0,
      usageUpdated: 0,
      failed: 0,
      timedOut: false,
      accounts: [],
    }),
    runImportAccounts: () => undefined,
    openDb: () => ({
      getAccounts: () => [account()],
      insertAccount: (managed) => ({ ...managed, generation: 1 }),
      removeAccount: () => undefined,
      close: () => undefined,
    }),
    confirm: async () => true,
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  };
  return { deps, stdout, stderr };
}

afterEach(() => {
  resetAuditLogLevel();
});

describe("CLI usage text", () => {
  test("contains no literal tab characters", () => {
    expect(CLI_USAGE).not.toContain("\t");
  });

  test("documents --force and no longer documents --config for accounts import", () => {
    expect(CLI_USAGE).toContain("accounts import [--from <path>] [--force]");
    expect(CLI_USAGE).not.toContain("accounts import [--from <path>] [--config");
  });
});

describe("login --help", () => {
  test.each([["--help"], ["-h"]])("parses %s as the help command", (flag) => {
    expect(parseCliArgs(["login", flag])).toEqual({ kind: "help" });
  });

  test("prints usage and exits 0 without loading config", async () => {
    const { deps, stdout } = createDependencies("info");
    let loaded = 0;
    const dependencies: CliDependencies = {
      ...deps,
      loadConfig: (options) => {
        loaded += 1;
        return deps.loadConfig(options);
      },
    };

    const exitCode = await main(["login", "--help"], dependencies);

    expect(exitCode).toBe(0);
    expect(stdout).toEqual([CLI_USAGE]);
    expect(loaded).toBe(0);
  });
});

describe("accounts import options", () => {
  test("rejects the removed --config option", () => {
    expect(() => parseCliArgs(["accounts", "import", "--config", "/tmp/config.json"])).toThrow(
      "Unknown option '--config'",
    );
  });

  test("passes --force through to the importer", async () => {
    const { deps } = createDependencies("info");
    const imports: Array<{ from?: string; force?: boolean }> = [];
    const dependencies: CliDependencies = {
      ...deps,
      runImportAccounts: (options) => {
        imports.push(options);
      },
    };

    expect(
      await main(["accounts", "import", "--from", "/tmp/kiro.db", "--force"], dependencies),
    ).toBe(0);
    expect(await main(["accounts", "import"], dependencies)).toBe(0);

    expect(imports).toEqual([{ from: "/tmp/kiro.db", force: true }, { force: false }]);
  });
});

describe("serve --port", () => {
  test.each(["0x1f90", "1e3", "8787abc", " "])("rejects the non-decimal port %s", (port) => {
    expect(() => parseCliArgs(["serve", "--port", port])).toThrow(`Invalid port: ${port}`);
  });

  test("accepts a plain decimal port", () => {
    expect(parseCliArgs(["serve", "--port", "8080"])).toEqual({
      kind: "serve",
      port: 8080,
    });
  });
});

describe("log_level wiring", () => {
  test.each([
    { argv: ["serve"], level: "warn" as const },
    { argv: ["login"], level: "error" as const },
    { argv: ["accounts", "refresh", "--all"], level: "debug" as const },
    { argv: ["accounts", "relogin", "account-1"], level: "warn" as const },
  ])("applies config.log_level after loading config for $argv", async ({ argv, level }) => {
    const { deps } = createDependencies(level);
    expect(getAuditLogLevel()).toBe("info");

    const exitCode = await main(argv, deps);

    expect(exitCode).toBe(0);
    expect(getAuditLogLevel()).toBe(level);
  });

  test("leaves the audit level untouched for commands that do not load config", async () => {
    const { deps } = createDependencies("error");

    await main(["accounts", "list"], deps);
    await main(["accounts", "import", "--from", "/tmp/kiro.db"], deps);
    await main(["accounts", "remove", "account-1", "--yes"], deps);
    await main(["--help"], deps);

    expect(getAuditLogLevel()).toBe("info");
  });
});
