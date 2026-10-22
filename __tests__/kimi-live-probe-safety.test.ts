import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConfigSchema } from "../src/config/schema.js";
import { AccountManager } from "../src/core/account-manager.js";
import { TokenRefresher } from "../src/core/token-refresher.js";
import { decodeRefreshToken } from "../src/kiro/auth.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

const script = resolve(import.meta.dir, "../scripts/probe-kimi-k3-live.ts");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const runWithEnvironment = (env: NodeJS.ProcessEnv, ...args: string[]) =>
  Bun.spawnSync({
    cmd: [process.execPath, script, ...args],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
const run = (...args: string[]) => runWithEnvironment(process.env, ...args);

function fakeFixture() {
  const root = mkdtempSync(join(tmpdir(), "kiro-k3-probe-fake-"));
  directories.push(root);
  const store = join(root, "xdg", "kiro-provider");
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const db = new AccountsDatabase(join(store, "accounts.db"));
  try {
    db.insertAccount({
      id: "synthetic-fake-account",
      email: "fixture@example.invalid",
      authMethod: "desktop",
      region: "us-east-1",
      profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/fixture",
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      expiresAt: Date.now() + 3_600_000,
      rateLimitResetTime: 0,
      isHealthy: true,
      failCount: 0,
    });
  } finally {
    db.close();
  }
  writeFileSync(
    join(store, "config.json"),
    JSON.stringify(
      ConfigSchema.parse({
        api_keys: ["synthetic-probe-key"],
        reasoning_replay_keys: [`fake:${Buffer.alloc(32, 7).toString("base64url")}`],
      }),
    ),
    { mode: 0o600 },
  );
  writeFileSync(
    join(root, "prepared.json"),
    JSON.stringify({
      copied_accounts: 1,
      fresh_tenant: true,
      fresh_replay_keyring: true,
    }),
    { mode: 0o600 },
  );
  const binary = join(root, "never-executed-fake-candidate");
  writeFileSync(binary, "fake provider fixture only", { mode: 0o600 });
  const sha = createHash("sha256").update(readFileSync(binary)).digest("hex");
  return {
    root,
    store,
    args: [
      "--execute",
      "--fake-provider",
      "--state-dir",
      root,
      "--binary",
      binary,
      "--sha256",
      sha,
    ],
  };
}

describe("K3 live probe execution boundary", () => {
  test("fake-provider proves both platform state roots remain private with inherited outside APPDATA", () => {
    const f = fakeFixture();
    const result = runWithEnvironment(
      { ...process.env, APPDATA: "C:\\Users\\synthetic\\AppData\\Roaming" },
      ...f.args,
      "--cases",
      "low",
      "--max-requests",
      "1",
    );
    expect(result.exitCode).toBe(0);
    const ledger = JSON.parse(result.stdout.toString());
    expect(ledger.private_state_for_all_platforms).toBe(true);
    expect(ledger.fake_provider).toBe(true);
    expect(ledger.phase).toBe("completed");
    expect(ledger.reserved_requests).toBe(1);
  });

  test("defaults to a dry run without reading account state or sending requests", () => {
    const result = run();
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      phase: "dry_run",
      generation_calls: 0,
      cases: ["tool-roundtrip", "low", "high-image", "stored-default"],
      planned_requests: 5,
      request_budget: 5,
    });
  });

  test("rejects a matrix larger than its explicitly authorized request budget", () => {
    const result = run("--max-requests", "4");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("exceeds the explicit request budget");
  });

  test("fake-provider exercises all five reservations and keeps K3 stored-default on verified stateless", () => {
    const f = fakeFixture();
    const result = run(...f.args);
    expect(result.exitCode).toBe(0);
    const ledger = JSON.parse(result.stdout.toString());
    expect(ledger.fake_provider).toBe(true);
    expect(ledger.phase).toBe("completed");
    expect(ledger.reserved_requests).toBe(5);
    expect(ledger.records.map((record: Record<string, unknown>) => record.transport)).toEqual([
      "stateless",
      "stateless",
      "stateless",
      "stateless",
      "stateless",
    ]);
    expect(ledger.records.map((record: Record<string, unknown>) => record.sdk_attempts)).toEqual([
      1, 1, 1, 1, 1,
    ]);
    expect(
      JSON.parse(readFileSync(join(f.store, "config.json"), "utf8")).protocol_projection_mode,
    ).toBe("v3-auto");
    const before = readFileSync(join(f.root, "kimi-k3-live-ledger.json"), "utf8");
    const configBefore = readFileSync(join(f.store, "config.json"), "utf8");
    const repeated = run(...f.args);
    expect(repeated.exitCode).not.toBe(0);
    expect(repeated.stderr.toString()).toContain("EEXIST");
    expect(readFileSync(join(f.root, "kimi-k3-live-ledger.json"), "utf8")).toBe(before);
    expect(readFileSync(join(f.store, "config.json"), "utf8")).toBe(configBefore);
  });

  test("ignores external credential/key/lock paths and makes fresh private keys after the ledger claim", () => {
    const f = fakeFixture();
    const external = join(f.root, "external-secret-material");
    writeFileSync(external, "synthetic external file must remain unchanged", { mode: 0o644 });
    const before = statSync(external);
    const old = JSON.parse(readFileSync(join(f.store, "config.json"), "utf8"));
    const malicious = {
      ...old,
      auth_source: "opencode-shared",
      opencode_auth_db_path: external,
      instance_lock_path: external,
      reasoning_replay_key_path: external,
      test_upstream_endpoint: "http://127.0.0.1:9/must-not-send",
      proxy_url: "http://127.0.0.1:9",
    };
    writeFileSync(join(f.store, "config.json"), JSON.stringify(malicious), { mode: 0o600 });
    const result = run(...f.args, "--cases", "low", "--max-requests", "1");
    expect(result.exitCode).toBe(0);
    const actual = JSON.parse(readFileSync(join(f.store, "config.json"), "utf8"));
    expect(actual.auth_source).toBe("local");
    expect(actual.opencode_auth_db_path).toBeNull();
    expect(actual.proxy_url).toBeNull();
    expect(actual.test_upstream_endpoint).toBeUndefined();
    expect(actual.api_keys).not.toEqual(old.api_keys);
    expect(actual.reasoning_replay_keys).not.toEqual(old.reasoning_replay_keys);
    for (const path of [actual.instance_lock_path, actual.reasoning_replay_key_path]) {
      expect(String(path).startsWith(join(f.root, "probe-private-"))).toBe(true);
    }
    expect(readFileSync(external, "utf8")).toBe("synthetic external file must remain unchanged");
    expect(statSync(external).mode).toBe(before.mode);
    expect(statSync(external).mtimeMs).toBe(before.mtimeMs);
  });

  for (const authMethod of ["desktop", "idc"] as const) {
    test(`access-only ${authMethod} fixture cannot rotate original refresh credentials even through forceRefresh`, async () => {
      const f = fakeFixture();
      const original = new Database(join(f.store, "accounts.db"), { strict: true });
      original
        .query(
          "UPDATE accounts SET auth_method = ?, client_id = 'original-synthetic-client-id', client_secret = 'original-synthetic-client-secret'",
        )
        .run(authMethod);
      original.close();
      expect(run(...f.args, "--cases", "low", "--max-requests", "1").exitCode).toBe(0);
      const database = new AccountsDatabase(join(f.store, "accounts.db"));
      try {
        const account = database.getAccounts()[0];
        if (!account) throw new Error("Expected synthetic account");
        expect(account.refreshToken).toBe("");
        expect(account.accessToken).toBe("synthetic-access");
        const manager = new AccountManager([account], "sticky", database);
        const auth = manager.toAuthDetails(account);
        const parts = decodeRefreshToken(auth.refresh);
        expect(parts.refreshToken).toBe("");
        if (authMethod === "idc") {
          expect(parts.clientId).toBe("synthetic-probe-client-id");
          expect(parts.clientSecret).toBe("synthetic-probe-client-secret");
        }
        const bodies: unknown[] = [];
        const rejectRefresh = Object.assign(
          async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            bodies.push(JSON.parse(String(init?.body)));
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          },
          { preconnect: globalThis.fetch.preconnect },
        );
        const network = spyOn(globalThis, "fetch").mockImplementation(rejectRefresh);
        try {
          const refresher = new TokenRefresher(manager, 1);
          await expect(refresher.refreshIfNeeded(account, auth)).resolves.toBeDefined();
          expect(bodies).toHaveLength(0);
          await expect(refresher.forceRefresh(account)).rejects.toBeInstanceOf(Error);
          expect(bodies).toHaveLength(1);
          expect(JSON.stringify(bodies)).not.toContain("synthetic-refresh");
          expect(JSON.stringify(bodies)).not.toContain("original-synthetic-client");
          expect((bodies[0] as { refreshToken: string }).refreshToken).toBe("");
        } finally {
          network.mockRestore();
        }
      } finally {
        database.close();
      }
    });
  }

  test("fake-provider stored-default consumes exactly one new reservation and sends no explicit effort", () => {
    const f = fakeFixture();
    const result = run(...f.args, "--cases", "stored-default", "--max-requests", "1");
    expect(result.exitCode).toBe(0);
    const ledger = JSON.parse(result.stdout.toString());
    expect(ledger.reserved_requests).toBe(1);
    expect(ledger.records[0]).toMatchObject({
      case: "stored-default",
      transport: "stateless",
      sdk_attempts: 1,
      requested_effort: "unspecified",
      completed: true,
    });
  });

  for (const kind of [
    "config-symlink",
    "db-symlink",
    "config-hardlink",
    "db-hardlink",
    "parent-xdg-symlink",
  ]) {
    test(`refuses unsafe isolated fixture ${kind} before a binary or account read`, () => {
      const root = mkdtempSync(join(tmpdir(), "kiro-k3-probe-safety-"));
      directories.push(root);
      const state = join(root, "isolated");
      const outside = join(root, "outside");
      mkdirSync(state, { mode: 0o700 });
      mkdirSync(outside, { mode: 0o700 });
      const targetConfig = join(outside, "config.json");
      const targetDb = join(outside, "accounts.db");
      writeFileSync(targetConfig, "synthetic untouched config", { mode: 0o600 });
      writeFileSync(targetDb, "synthetic untouched database", { mode: 0o600 });
      let store: string;
      if (kind === "parent-xdg-symlink") {
        mkdirSync(join(outside, "kiro-provider"));
        writeFileSync(join(outside, "kiro-provider", "config.json"), "synthetic", { mode: 0o600 });
        writeFileSync(join(outside, "kiro-provider", "accounts.db"), "synthetic", { mode: 0o600 });
        symlinkSync(outside, join(state, "xdg"));
        store = join(state, "xdg", "kiro-provider");
      } else {
        store = join(state, "xdg", "kiro-provider");
        mkdirSync(store, { recursive: true, mode: 0o700 });
        for (const [name, target] of [
          ["config.json", targetConfig],
          ["accounts.db", targetDb],
        ]) {
          const selected =
            (kind.startsWith("config") && name === "config.json") ||
            (kind.startsWith("db") && name === "accounts.db");
          if (selected) {
            if (kind.endsWith("symlink"))
              symlinkSync(target as string, join(store, name as string));
            else linkSync(target as string, join(store, name as string));
          } else writeFileSync(join(store, name as string), "synthetic", { mode: 0o600 });
        }
      }
      const result = run(
        "--execute",
        "--state-dir",
        state,
        "--binary",
        join(root, "must-not-read-candidate"),
        "--sha256",
        "0".repeat(64),
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("Unsafe isolated fixture file");
      expect(result.stderr.toString()).not.toContain("must-not-read-candidate");
      expect(readFileSync(targetConfig, "utf8")).toBe("synthetic untouched config");
      expect(readFileSync(targetDb, "utf8")).toBe("synthetic untouched database");
    });
  }
});
