import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { KiroClientImportDependencies } from "../src/cli/import-kiro-client.js";
import { ImportLeaseError } from "../src/cli/import-lease.js";
import { type CliDependencies, main, parseCliArgs } from "../src/cli/main.js";
import { ConfigSchema } from "../src/config/schema.js";
import { AccountManager } from "../src/core/account-manager.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

const originalFetch = globalThis.fetch;
const temporaryRoots: string[] = [];
const PROFILE = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/FIXTURE";
const SECOND_PROFILE = "arn:aws:codewhisperer:us-east-1:123456789012:profile/OTHER";
const BUILDER_ID_PROFILE = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
const config = ConfigSchema.parse({ api_keys: ["sk-fixture"], proxy_url: "" });

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function entry(email = "owner@example.invalid") {
  return {
    email,
    authMethod: "idc",
    oidcRegion: "us-west-2",
    clientId: `fixture-client-${email}`,
    clientSecret: "fixture-client-secret",
    refreshToken: `fixture-refresh-${email}`,
    clientIdIssuedAt: Date.now() - 60_000,
    clientSecretExpiresAt: Date.now() + 86_400_000,
  };
}

function envelope(accounts: readonly unknown[]) {
  return { format: "kiro-provider-accounts", version: 1, accounts };
}

function managed(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: "stable-existing-id",
    email: "owner@example.invalid",
    authMethod: "idc",
    region: "eu-central-1",
    oidcRegion: "us-west-2",
    profileArn: PROFILE,
    clientId: "existing-client",
    clientSecret: "existing-secret",
    accessToken: "newer-existing-access",
    refreshToken: "newer-existing-refresh",
    expiresAt: Date.now() + 86_400_000,
    isHealthy: true,
    rateLimitResetTime: 0,
    failCount: 0,
    ...overrides,
  };
}

function harness(payload: unknown, importOverrides: Partial<KiroClientImportDependencies> = {}) {
  const root = mkdtempSync(join(tmpdir(), "kiro-client-import-test-"));
  temporaryRoots.push(root);
  const sourcePath = join(root, "accounts.json");
  const databasePath = join(root, "accounts.db");
  writeFileSync(sourcePath, typeof payload === "string" ? payload : JSON.stringify(payload));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const loaded: Parameters<CliDependencies["loadConfig"]>[0][] = [];
  let stdinInput: AsyncIterable<Uint8Array> | undefined;
  const deps: CliDependencies = {
    loadConfig: (options) => {
      loaded.push(options);
      return config;
    },
    startServer: () => {
      throw new Error("unexpected server startup");
    },
    runLogin: async () => {
      throw new Error("unexpected interactive login");
    },
    runAccountRefresh: async () => {
      throw new Error("unexpected account refresh command");
    },
    runImportAccounts: () => {
      throw new Error("JSON must not enter the SQLite importer");
    },
    runImportKiroClient: async (loadedConfig, options, io) => {
      const { runKiroClientImport } = await import("../src/cli/import-kiro-client.js");
      return runKiroClientImport(loadedConfig, options, {
        ...io,
        openDb: () => new AccountsDatabase(databasePath),
        input: stdinInput,
        refreshTimeoutMs: 20,
        lockPath: join(root, "accounts.db.import"),
        ...importOverrides,
      });
    },
    openDb: () => {
      throw new Error("JSON importer must own its isolated database lifecycle");
    },
    checkForUpdate: async () => {
      throw new Error("unexpected update check");
    },
    runSelfUpdate: async () => {
      throw new Error("unexpected self update");
    },
    confirm: async () => false,
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  };
  return {
    sourcePath,
    databasePath,
    lockPath: join(root, "accounts.db.import"),
    stdout,
    stderr,
    loaded,
    deps,
    run: (args: readonly string[] = []) =>
      main(["accounts", "import", "--format", "kiro-client", "--from", sourcePath, ...args], deps),
    runStdin: async (chunks: readonly Uint8Array[]) => {
      stdinInput = (async function* () {
        yield* chunks;
      })();
      return main(["accounts", "import", "--format", "kiro-client", "--from", "-"], deps);
    },
    accounts: () => {
      const db = new AccountsDatabase(databasePath);
      try {
        return db.getAccounts();
      } finally {
        db.close();
      }
    },
  };
}

type FetchCall = { url: URL; init?: RequestInit; body?: Record<string, unknown> };

function mockNetwork(
  response?: (call: FetchCall) => Response | Promise<Response | undefined> | undefined,
) {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const call = {
      url,
      init,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const custom = await response?.(call);
    if (custom) return custom;
    if (url.pathname === "/token") {
      return Response.json({
        accessToken: "fixture-verified-access",
        refreshToken: "fixture-rotated-refresh",
        expiresIn: 3600,
      });
    }
    if (url.pathname === "/List-Available-Profiles") {
      return Response.json({
        profiles: url.hostname.includes("eu-central-1") ? [{ arn: PROFILE }] : [],
      });
    }
    if (url.pathname.toLowerCase().includes("usagelimits")) {
      return Response.json({
        userInfo: { email: "owner@example.invalid" },
        usageBreakdownList: [{ currentUsage: 7, usageLimit: 100 }],
      });
    }
    throw new Error("unexpected test endpoint");
  }) as typeof fetch;
  return calls;
}

describe("kiro-client CLI credential admission", () => {
  test("loads an explicit JSON-only network configuration and preserves the SQLite argument contract", async () => {
    const cli = harness(envelope([entry()]));
    mockNetwork();
    expect(await cli.run(["--config", "/fixture/config.json"])).toBe(0);
    expect(cli.loaded).toEqual([{ configPath: "/fixture/config.json" }]);
    expect(() => parseCliArgs(["accounts", "import", "--config", "/fixture/config.json"])).toThrow(
      "Unknown option '--config'",
    );
    expect(() => parseCliArgs(["accounts", "import", "--format", "kiro-client"])).toThrow(
      "requires --from",
    );
    expect(() => parseCliArgs(["accounts", "import", "--from", "-"])).toThrow(
      "stdin import requires",
    );
  });

  test("refreshes the matching OIDC tuple, discovers runtime region, verifies email and persists without leaking credentials", async () => {
    const source = entry();
    const cli = harness(`\uFEFF${JSON.stringify(envelope([source]))}`);
    const calls = mockNetwork();
    const watchingDb = new AccountsDatabase(cli.databasePath);
    const manager = new AccountManager([], "round-robin", watchingDb);
    try {
      expect(await cli.run()).toBe(0);
      expect(calls[0]?.url.hostname).toBe("oidc.us-west-2.amazonaws.com");
      expect(calls[0]?.body).toEqual({
        clientId: source.clientId,
        clientSecret: source.clientSecret,
        refreshToken: source.refreshToken,
        grantType: "refresh_token",
      });
      expect(calls.filter(({ url }) => url.pathname === "/List-Available-Profiles")).toHaveLength(
        2,
      );
      const usageCall = calls.find(({ url }) => url.pathname.toLowerCase().includes("usagelimits"));
      expect(usageCall?.url.hostname).toContain("eu-central-1");
      expect(usageCall?.url.searchParams.get("profileArn")).toBe(PROFILE);
      const persisted = cli.accounts()[0];
      expect(persisted).toMatchObject({
        email: source.email,
        authMethod: "idc",
        oidcRegion: "us-west-2",
        region: "eu-central-1",
        profileArn: PROFILE,
        clientId: source.clientId,
        clientSecret: source.clientSecret,
        refreshToken: "fixture-rotated-refresh",
        accessToken: "fixture-verified-access",
        clientIdIssuedAt: source.clientIdIssuedAt,
        clientSecretExpiresAt: source.clientSecretExpiresAt,
        usedCount: 7,
        limitCount: 100,
      });
      expect(manager.reconcileFromDb()[0]?.id).toBe(persisted?.id);
      const requestCount = calls.length;
      expect(await cli.run()).toBe(0);
      expect(calls).toHaveLength(requestCount);
      expect(cli.accounts()[0]?.generation).toBe(persisted?.generation);
      expect(cli.stdout.join("\n")).toContain("Imported 1, skipped 0, failed 0");
      const output = [...cli.stdout, ...cli.stderr].join("\n");
      for (const secret of [
        source.clientSecret,
        source.refreshToken,
        "fixture-verified-access",
        source.email,
      ]) {
        expect(output).not.toContain(secret);
      }
    } finally {
      watchingDb.close();
    }
  });

  test("imports a legacy Builder ID export without calling its unsupported profile catalog", async () => {
    const source = entry();
    const { authMethod: _authMethod, oidcRegion, ...legacy } = source;
    const cli = harness([]);
    const calls = mockNetwork(({ url }) =>
      url.pathname === "/List-Available-Profiles"
        ? new Response("AWS Builder ID is not supported for this operation", { status: 403 })
        : undefined,
    );
    const payload = new TextEncoder().encode(
      JSON.stringify([
        {
          ...legacy,
          provider: "BuilderId",
          region: oidcRegion,
          password: "fixture-mailbox-password",
          accessToken: "fixture-stale-access",
          sessionToken: "fixture-web-session",
        },
      ]),
    );
    expect(await cli.runStdin([payload.slice(0, 17), payload.slice(17)])).toBe(0);
    expect(calls.filter(({ url }) => url.pathname === "/token")).toHaveLength(1);
    expect(calls.filter(({ url }) => url.pathname === "/List-Available-Profiles")).toEqual([]);
    expect(cli.accounts()).toHaveLength(1);
    expect(cli.accounts()[0]).toMatchObject({
      region: "us-east-1",
      profileArn: BUILDER_ID_PROFILE,
    });
    expect(cli.accounts()[0]).not.toHaveProperty("password");
    expect(JSON.stringify(cli.accounts())).not.toContain("fixture-stale-access");
    expect([...cli.stdout, ...cli.stderr].join("\n")).not.toContain("fixture-web-session");
  });

  test("imports a versioned Builder ID entry through the fixed service profile", async () => {
    const cli = harness(envelope([{ ...entry(), provider: "BuilderId" }]));
    const calls = mockNetwork(({ url }) =>
      url.pathname === "/List-Available-Profiles"
        ? new Response("AWS Builder ID is not supported for this operation", { status: 403 })
        : undefined,
    );

    expect(await cli.run()).toBe(0);
    expect(calls.filter(({ url }) => url.pathname === "/List-Available-Profiles")).toEqual([]);
    expect(cli.accounts()[0]).toMatchObject({
      region: "us-east-1",
      profileArn: BUILDER_ID_PROFILE,
    });
  });

  test("runs the real CLI stdin reader in a separate process using only an isolated config root and mocked upstream", async () => {
    const source = entry();
    const cli = harness(envelope([source]));
    const root = dirname(cli.sourcePath);
    const modulePath = new URL("../src/cli/main.ts", import.meta.url).href;
    const script = `
      import { main } from ${JSON.stringify(modulePath)};
      globalThis.fetch = async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname === "/token") return Response.json({accessToken:"fixture-child-access",refreshToken:"fixture-child-refresh",expiresIn:3600});
        if (url.pathname === "/List-Available-Profiles") return Response.json({profiles:url.hostname.includes("eu-central-1")?[{arn:${JSON.stringify(PROFILE)}}]:[]});
        if (url.pathname.toLowerCase().includes("usagelimits")) return Response.json({userInfo:{email:${JSON.stringify(source.email)}}});
        throw new Error("unexpected fixture endpoint");
      };
      process.exitCode = await main(["accounts","import","--format","kiro-client","--from","-"]);
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: root,
        APPDATA: root,
        KIRO_PROVIDER_API_KEYS: "sk-fixture-child",
        KIRO_PROVIDER_PROXY_URL: "",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(JSON.stringify(envelope([source])));
    child.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Imported 1, skipped 0, failed 0");
    expect(stdout).not.toContain(source.refreshToken);
    const db = new AccountsDatabase(join(root, "kiro-provider", "accounts.db"));
    try {
      expect(db.getAccounts()[0]).toMatchObject({
        email: source.email,
        refreshToken: "fixture-child-refresh",
      });
    } finally {
      db.close();
    }
  });

  test("keeps successful entries but returns failure for a different authoritative email", async () => {
    const cli = harness(envelope([entry(), entry("other@example.invalid")]));
    mockNetwork();
    expect(await cli.run()).toBe(1);
    expect(cli.accounts()).toHaveLength(1);
    expect(cli.stdout).toContain("Entry 2: failed (email_mismatch)");
    expect(cli.stdout.at(-1)).toBe("Imported 1, skipped 0, failed 1, total in DB now 1");
    expect([...cli.stdout, ...cli.stderr].join("\n")).not.toContain("other@example.invalid");
  });

  test.each([
    { reason: "no_profile", profiles: [] },
    { reason: "ambiguous_profile", profiles: [{ arn: PROFILE }, { arn: SECOND_PROFILE }] },
    {
      reason: "invalid_profile",
      profiles: [{ arn: "arn:aws:codewhisperer:eu-west-1:123456789012:profile/UNSUPPORTED" }],
    },
  ])("rejects $reason before usage or persistence", async ({ reason, profiles }) => {
    const cli = harness(envelope([entry()]));
    const calls = mockNetwork(({ url }) =>
      url.pathname === "/List-Available-Profiles" ? Response.json({ profiles }) : undefined,
    );
    expect(await cli.run()).toBe(1);
    expect(cli.accounts()).toEqual([]);
    expect(cli.stdout).toContain(`Entry 1: failed (${reason})`);
    expect(calls.filter(({ url }) => url.pathname.toLowerCase().includes("usagelimits"))).toEqual(
      [],
    );
  });

  test.each([undefined, "", "   ", "builder-id@aws.amazon.com", "not-an-email"])(
    "refuses unavailable authority identity %j",
    async (email) => {
      const cli = harness(envelope([entry()]));
      mockNetwork(({ url }) =>
        url.pathname.toLowerCase().includes("usagelimits")
          ? Response.json({ userInfo: { email } })
          : undefined,
      );
      expect(await cli.run()).toBe(1);
      expect(cli.accounts()).toEqual([]);
      expect(cli.stdout).toContain("Entry 1: failed (identity_unavailable)");
    },
  );

  test.each(["refresh", "profile", "usage"])(
    "redacts upstream %s failures and never stores incomplete credentials",
    async (stage) => {
      const cli = harness(envelope([entry()]));
      mockNetwork(({ url }) => {
        const selected =
          stage === "refresh"
            ? url.pathname === "/token"
            : stage === "profile"
              ? url.pathname === "/List-Available-Profiles"
              : url.pathname.toLowerCase().includes("usagelimits");
        return selected
          ? new Response("fixture-UPSTREAM-SECRET accessToken refreshToken owner@example.invalid", {
              status: 403,
            })
          : undefined;
      });
      expect(await cli.run()).toBe(1);
      expect(cli.accounts()).toEqual([]);
      const output = [...cli.stdout, ...cli.stderr].join("\n");
      for (const value of [
        "fixture-UPSTREAM-SECRET",
        "accessToken",
        "refreshToken",
        "owner@example.invalid",
      ]) {
        expect(output).not.toContain(value);
      }
    },
  );

  test("uses a bounded refresh signal and stops after refresh timeout", async () => {
    const cli = harness(envelope([entry()]));
    const calls = mockNetwork(({ url, init }) => {
      if (url.pathname !== "/token") return undefined;
      return new Promise<Response>((_resolve, reject) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    expect(await cli.run()).toBe(1);
    expect(calls).toHaveLength(1);
    expect(cli.stdout).toContain("Entry 1: failed (refresh_failed)");
    expect(cli.accounts()).toEqual([]);
  });

  test("rejects malformed, expired and delimiter-bearing credentials before refreshing, while continuing valid rows", async () => {
    const cli = harness(
      envelope([
        { ...entry("invalid@example.invalid"), oidcRegion: "cn-north-1" },
        { ...entry("expired@example.invalid"), clientSecretExpiresAt: Date.now() - 1 },
        {
          ...entry("separator@example.invalid"),
          refreshToken: "fixture|wrong-client|wrong-secret|idc",
        },
        { ...entry("missing@example.invalid"), clientSecret: "" },
        entry(),
      ]),
    );
    const calls = mockNetwork();
    expect(await cli.run()).toBe(1);
    expect(calls.filter(({ url }) => url.pathname === "/token")).toHaveLength(1);
    expect(cli.accounts()).toHaveLength(1);
    expect(cli.stdout).toContain("Entry 2: failed (expired_client_registration)");
    expect(cli.stdout.at(-1)).toBe("Imported 1, skipped 0, failed 4, total in DB now 1");
  });

  test("skips normalized duplicate emails and rejects credential tuples relabelled with another email without refreshing twice", async () => {
    const source = entry();
    const cli = harness(
      envelope([
        source,
        { ...source, email: source.email.toUpperCase() },
        { ...source, email: "other@example.invalid" },
      ]),
    );
    const calls = mockNetwork();
    expect(await cli.run()).toBe(1);
    expect(calls.filter(({ url }) => url.pathname === "/token")).toHaveLength(1);
    expect(cli.stdout).toContain("Entry 2: skipped (duplicate_input)");
    expect(cli.stdout).toContain("Entry 3: failed (duplicate_credentials)");
    expect(cli.accounts()).toHaveLength(1);
  });

  test("skips any existing IdC email without rebinding its profile, rotating its tuple or changing its generation", async () => {
    const cli = harness(envelope([{ ...entry(), clientSecretExpiresAt: Date.now() - 1 }]));
    const db = new AccountsDatabase(cli.databasePath);
    const previous = db.insertAccount(managed({ profileArn: SECOND_PROFILE, region: "us-east-1" }));
    db.close();
    const calls = mockNetwork();
    expect(await cli.run()).toBe(0);
    expect(calls).toEqual([]);
    expect(cli.accounts()).toEqual([previous]);
    expect(await cli.run(["--force"])).toBe(1);
    expect(calls).toEqual([]);
    expect(cli.accounts()).toEqual([previous]);
    expect(cli.stderr.at(-1)).toContain("force_unsupported_use_accounts_relogin");
  });

  test("does not overwrite an account inserted and refreshed by another connection during identity verification", async () => {
    const cli = harness(envelope([entry()]));
    let concurrent: ReturnType<AccountsDatabase["insertAccount"]> | undefined;
    mockNetwork(({ url }) => {
      if (!url.pathname.toLowerCase().includes("usagelimits")) return undefined;
      const peer = new AccountsDatabase(cli.databasePath);
      try {
        peer.insertAccount(managed({ profileArn: SECOND_PROFILE, region: "us-east-1" }));
        concurrent = peer.insertAccount(
          managed({ profileArn: SECOND_PROFILE, region: "us-east-1", lastRefreshAt: Date.now() }),
        );
      } finally {
        peer.close();
      }
      return undefined;
    });
    expect(await cli.run()).toBe(0);
    if (concurrent === undefined) throw new Error("the concurrent writer did not run");
    expect(cli.accounts()).toEqual([concurrent]);
    expect(cli.stdout).toContain("Entry 1: skipped (existing_or_changed_account)");
  });

  test("rejects an overlapping CLI import before refreshing and skips the identity after the first lease releases", async () => {
    const cli = harness(envelope([entry()]), { refreshTimeoutMs: 5_000 });
    let releaseRefresh: () => void = () => {};
    let refreshStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshCount = 0;
    const calls = mockNetwork(async ({ url }) => {
      if (url.pathname !== "/token") return undefined;
      refreshCount += 1;
      if (refreshCount === 1) {
        refreshStarted();
        await waiting;
      }
      return Response.json({
        accessToken: "fixture-access",
        refreshToken: `fixture-rotation-${refreshCount}`,
        expiresIn: 3600,
      });
    });
    const first = cli.run();
    await started;
    try {
      expect(await cli.run()).toBe(1);
      expect(cli.stderr.at(-1)).toBe("Kiro-client import rejected: import_in_progress");
      expect(calls.filter(({ url }) => url.pathname === "/token")).toHaveLength(1);
    } finally {
      releaseRefresh();
      expect(await first).toBe(0);
    }
    expect(await cli.run()).toBe(0);
    expect(calls.filter(({ url }) => url.pathname === "/token")).toHaveLength(1);
    expect(cli.accounts()[0]?.refreshToken).toBe("fixture-rotation-1");
  });

  test("rejects a separate importing process with zero refreshes, then permits a post-release retry to skip", async () => {
    const cli = harness(envelope([entry()]));
    const root = dirname(cli.sourcePath);
    const moduleUrl = new URL("../src/cli/main.ts", import.meta.url).href;
    const script = `
      import { main } from ${JSON.stringify(moduleUrl)};
      globalThis.fetch = async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname === "/token") {
          console.log("FIXTURE_REFRESH_STARTED");
          if (process.env.FIXTURE_HOLD_REFRESH === "1") await new Promise(resolve => process.stdin.once("data", resolve));
          return Response.json({accessToken:"fixture-process-access",refreshToken:"fixture-process-refresh",expiresIn:3600});
        }
        if (url.pathname === "/List-Available-Profiles") return Response.json({profiles:url.hostname.includes("eu-central-1")?[{arn:${JSON.stringify(PROFILE)}}]:[]});
        if (url.pathname.toLowerCase().includes("usagelimits")) return Response.json({userInfo:{email:"owner@example.invalid"}});
        throw new Error("unexpected fixture endpoint");
      };
      process.exitCode = await main(["accounts","import","--format","kiro-client","--from",${JSON.stringify(cli.sourcePath)}]);
    `;
    const spawn = (hold: boolean) =>
      Bun.spawn([process.execPath, "-e", script], {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: root,
          APPDATA: root,
          KIRO_PROVIDER_API_KEYS: "sk-fixture",
          KIRO_PROVIDER_PROXY_URL: "",
          FIXTURE_HOLD_REFRESH: hold ? "1" : "0",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    const first = spawn(true);
    try {
      const reader = first.stdout.getReader();
      const firstOutput = await Promise.race([
        reader.read(),
        Bun.sleep(3_000).then(() => {
          throw new Error("first import did not reach refresh");
        }),
      ]);
      expect(new TextDecoder().decode(firstOutput.value)).toContain("FIXTURE_REFRESH_STARTED");
      const remainingOutput = async (): Promise<string> => {
        const decoder = new TextDecoder();
        let output = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          output += decoder.decode(chunk.value, { stream: true });
        }
        reader.releaseLock();
        return output + decoder.decode();
      };
      const second = spawn(false);
      second.stdin.end();
      const [secondCode, secondOut, secondErr] = await Promise.all([
        second.exited,
        new Response(second.stdout).text(),
        new Response(second.stderr).text(),
      ]);
      expect(secondCode).toBe(1);
      expect(secondOut).not.toContain("FIXTURE_REFRESH_STARTED");
      expect(secondErr).toContain("Kiro-client import rejected: import_in_progress");
      first.stdin.write("release\n");
      first.stdin.end();
      const [firstCode, firstOut, firstErr] = await Promise.all([
        first.exited,
        remainingOutput(),
        new Response(first.stderr).text(),
      ]);
      expect(firstCode).toBe(0);
      expect(firstErr).toBe("");
      expect(firstOut).toContain("Imported 1, skipped 0, failed 0");
      const retry = spawn(false);
      retry.stdin.end();
      const [retryCode, retryOut, retryErr] = await Promise.all([
        retry.exited,
        new Response(retry.stdout).text(),
        new Response(retry.stderr).text(),
      ]);
      expect(retryCode).toBe(0);
      expect(retryErr).toBe("");
      expect(retryOut).toContain("Imported 0, skipped 1, failed 0");
      expect(retryOut).not.toContain("FIXTURE_REFRESH_STARTED");
      expect(existsSync(join(root, "kiro-provider", "accounts.db.import.lock"))).toBe(false);
    } finally {
      if (first.exitCode === null) first.kill();
      await first.exited;
    }
  });

  test("refuses persistence if the lock directory is replaced while authoritative identity is being verified", async () => {
    const cli = harness(envelope([entry()]));
    mockNetwork(({ url }) => {
      if (!url.pathname.toLowerCase().includes("usagelimits")) return undefined;
      const replacement = join(dirname(cli.lockPath), "replacement-owner");
      mkdirSync(replacement, { mode: 0o700 });
      rmSync(`${cli.lockPath}.lock`, { recursive: true });
      renameSync(replacement, `${cli.lockPath}.lock`);
      return undefined;
    });
    expect(await cli.run()).toBe(1);
    expect(cli.stderr.at(-1)).toBe("Kiro-client import rejected: import_lock_compromised");
    expect(cli.accounts()).toEqual([]);
    expect(existsSync(`${cli.lockPath}.lock`)).toBe(true);
  });

  test("propagates lease compromise into an in-flight refresh and releases the lease without writing", async () => {
    const controller = new AbortController();
    let releases = 0;
    const cli = harness(envelope([entry()]), {
      acquireLease: async () => ({
        signal: controller.signal,
        assertHeld: () => {
          if (controller.signal.aborted) throw new ImportLeaseError("import_lock_compromised");
        },
        release: async () => {
          releases += 1;
        },
      }),
    });
    mockNetwork(({ url, init }) => {
      if (url.pathname !== "/token") return undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        controller.abort(new ImportLeaseError("import_lock_compromised"));
      });
    });
    expect(await cli.run()).toBe(1);
    expect(cli.stderr.at(-1)).toBe("Kiro-client import rejected: import_lock_compromised");
    expect(cli.accounts()).toEqual([]);
    expect(releases).toBe(1);
  });

  test("does not resurrect an exact account ID removed during verification", async () => {
    const source = entry();
    const id = createHash("sha256")
      .update(`${source.email}:idc:${source.clientId}:${PROFILE}`)
      .digest("hex");
    const cli = harness(envelope([source]));
    mockNetwork(({ url }) => {
      if (!url.pathname.toLowerCase().includes("usagelimits")) return undefined;
      const peer = new AccountsDatabase(cli.databasePath);
      try {
        peer.insertAccount(managed({ id, clientId: source.clientId }));
        peer.removeAccount(id);
      } finally {
        peer.close();
      }
      return undefined;
    });
    expect(await cli.run()).toBe(0);
    expect(cli.accounts()).toEqual([]);
    expect(cli.stdout).toContain("Entry 1: skipped (existing_or_changed_account)");
  });

  test.each([
    { payload: "fixture-PRIVATE-invalid-json", reason: "invalid_json" },
    { payload: "{", reason: "invalid_json" },
    {
      payload: { format: "kiro-provider-accounts", version: 2, accounts: [entry()] },
      reason: "invalid_format",
    },
    { payload: envelope([]), reason: "empty_accounts" },
    { payload: envelope(Array.from({ length: 251 }, () => entry())), reason: "too_many_accounts" },
    { payload: " ".repeat(5 * 1024 * 1024 + 1), reason: "input_too_large" },
  ])(
    "rejects bounded document failure $reason with a fixed sanitized error",
    async ({ payload, reason }) => {
      const cli = harness(payload);
      const calls = mockNetwork();
      expect(await cli.run()).toBe(1);
      expect(cli.stderr.at(-1)).toBe(`Kiro-client import rejected: ${reason}`);
      expect(calls).toEqual([]);
      expect(cli.stderr.join("\n")).not.toContain("fixture-PRIVATE");
    },
  );

  test("accepts exactly 250 entries and rejects oversized or malformed UTF-8 stdin before network use", async () => {
    const source = entry();
    const cli = harness(envelope(Array.from({ length: 250 }, () => source)));
    const calls = mockNetwork();
    expect(await cli.run()).toBe(0);
    expect(cli.stdout.at(-1)).toBe("Imported 1, skipped 249, failed 0, total in DB now 1");
    const requestCount = calls.length;
    expect(await cli.runStdin([new Uint8Array(5 * 1024 * 1024), new Uint8Array(1)])).toBe(1);
    expect(cli.stderr.at(-1)).toContain("input_too_large");
    expect(await cli.runStdin([new Uint8Array([0xff])])).toBe(1);
    expect(cli.stderr.at(-1)).toContain("invalid_json");
    expect(calls).toHaveLength(requestCount);
  });

  test("redacts file and configuration errors and never contacts upstream", async () => {
    const cli = harness(envelope([entry()]));
    const calls = mockNetwork();
    rmSync(cli.sourcePath);
    expect(await cli.run()).toBe(1);
    expect(cli.stderr.at(-1)).toBe("Kiro-client import rejected: input_unreadable");
    const exitCode = await main(
      ["accounts", "import", "--format", "kiro-client", "--from", cli.sourcePath],
      {
        ...cli.deps,
        loadConfig: () => {
          throw new Error("fixture-PRIVATE-config-password");
        },
      },
    );
    expect(exitCode).toBe(1);
    expect(cli.stderr.at(-1)).toBe("Kiro-client import rejected: configuration_unavailable");
    expect(cli.stderr.join("\n")).not.toContain("fixture-PRIVATE");
    expect(calls).toEqual([]);
  });

  test("redacts database-open and database-close failures", async () => {
    const opening = harness(envelope([entry()]), {
      openDb: () => {
        throw new Error("fixture-PRIVATE-db-open");
      },
    });
    mockNetwork();
    expect(await opening.run()).toBe(1);
    expect(existsSync(`${opening.lockPath}.lock`)).toBe(false);
    expect(opening.stderr.at(-1)).toBe(
      "Kiro-client import rejected: authentication_store_unavailable",
    );
    const closing = harness(envelope([entry()]), {
      openDb: () => ({
        getAccounts: () => [],
        insertAccountIfAbsent: () => {
          throw new Error("fixture-PRIVATE-db-write");
        },
        close: () => {
          throw new Error("fixture-PRIVATE-db-close");
        },
      }),
    });
    expect(await closing.run()).toBe(1);
    expect(existsSync(`${closing.lockPath}.lock`)).toBe(false);
    expect(closing.stdout).toContain("Entry 1: failed (account_import_failed)");
    expect(closing.stderr.at(-1)).toBe(
      "Kiro-client import rejected: authentication_store_unavailable",
    );
    expect([...opening.stderr, ...closing.stderr, ...closing.stdout].join("\n")).not.toContain(
      "fixture-PRIVATE",
    );
  });

  test("does not refresh credentials already owned by a different stored email", async () => {
    const source = entry("other@example.invalid");
    const cli = harness(envelope([source]));
    const db = new AccountsDatabase(cli.databasePath);
    db.insertAccount(
      managed({
        clientId: source.clientId,
        clientSecret: source.clientSecret,
        refreshToken: source.refreshToken,
      }),
    );
    db.close();
    const calls = mockNetwork();
    expect(await cli.run()).toBe(1);
    expect(calls).toEqual([]);
    expect(cli.stdout).toContain("Entry 1: failed (credential_identity_conflict)");
    expect(cli.accounts()[0]?.id).toBe("stable-existing-id");
  });
});
