import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogin } from "../src/cli/login.ts";
import { ConfigSchema } from "../src/config/schema.ts";
import { AccountMaintenanceService } from "../src/core/account-maintenance.ts";
import { AccountManager } from "../src/core/account-manager.ts";
import { credentialRefreshBufferMs } from "../src/core/credential-state.ts";
import { TokenRefresher } from "../src/core/token-refresher.ts";
import { pollKiroIDCToken } from "../src/kiro/oauth-idc.ts";
import type { ManagedAccount } from "../src/kiro/types.ts";
import { createApp } from "../src/server/app.ts";
import { SqliteResponseStore } from "../src/server/responses/store.ts";
import { AccountsDatabase } from "../src/storage/accounts-db.ts";
import { captureAuditEvents } from "./audit-test-helpers.ts";
import { makeSdkResponse } from "./sdk-stream-test-helpers.ts";

// Synthetic credentials only. This harness runs maintenance and authenticated
// protocol requests against a reopened local database; it never contacts Kiro.
const originalFetch = globalThis.fetch;
const databases: AccountsDatabase[] = [];
const directories: string[] = [];
let now: number;
let clock: { mockRestore(): void };
let audit: ReturnType<typeof captureAuditEvents>;

beforeEach(() => {
  now = 1_700_000_000_000;
  clock = spyOn(Date, "now").mockImplementation(() => now);
  audit = captureAuditEvents();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clock.mockRestore();
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  audit.restore();
});

function open(path: string) {
  const database = new AccountsDatabase(path);
  databases.push(database);
  const manager = new AccountManager(database.getAccounts(), "lowest-usage", database);
  return { database, manager, refresher: new TokenRefresher(manager, 300_000) };
}

function fixture(overrides: Partial<ManagedAccount> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "kiro-short-refresh-"));
  directories.push(directory);
  const path = join(directory, "accounts.db");
  const database = new AccountsDatabase(path);
  databases.push(database);
  database.insertAccount({
    id: "synthetic-account",
    email: "fixture@example.invalid",
    authMethod: "idc",
    region: "us-east-1",
    oidcRegion: "us-east-1",
    clientId: "synthetic-client",
    clientSecret: "synthetic-client-secret",
    profileArn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/synthetic",
    startUrl: "https://synthetic.awsapps.com/start",
    refreshToken: "synthetic-refresh",
    accessToken: "synthetic-access",
    expiresAt: now - 1,
    lastRefreshAt: now - 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 1,
    limitCount: 10_000,
    lastSync: now,
    ...overrides,
  });
  return { path, ...open(path) };
}

function maintenance(f: ReturnType<typeof open>) {
  return new AccountMaintenanceService({
    enabled: true,
    intervalMs: 60_000,
    timeoutMs: 1000,
    concurrency: 1,
    tokenExpiryBufferMs: 300_000,
    accountManager: f.manager,
    tokenRefresher: f.refresher,
    usageRefresher: {
      async recheckDueAccounts() {},
      async syncDueAccounts() {},
    },
  });
}

function installRefresh(seconds: number) {
  let calls = 0;
  globalThis.fetch = Object.assign(
    async () => {
      calls++;
      return Response.json({
        accessToken: `synthetic-rotated-access-${calls}`,
        refreshToken: `synthetic-rotated-refresh-${calls}`,
        expiresIn: seconds,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  return () => calls;
}

async function request(
  f: ReturnType<typeof open>,
  protocol: "messages" | "responses" | "native-responses",
  stream = false,
) {
  let dispatches = 0;
  let nativeDispatches = 0;
  const native = protocol === "native-responses";
  const app = createApp(
    ConfigSchema.parse({
      api_keys: ["synthetic-local-key"],
      protocol_projection_mode: native ? "v3-auto" : "safe",
      responses_native_tool_bridge: "off",
      dynamic_model_catalog: false,
      account_maintenance_enabled: false,
      request_timeout_ms: 1000,
      stream_idle_timeout_ms: 500,
    }),
    {
      accountManager: f.manager,
      tokenRefresher: f.refresher,
      affinityStore: f.database,
      responseStore: new SqliteResponseStore(f.database),
      nativeResponsesFetch: async () => {
        dispatches++;
        nativeDispatches++;
        return Response.json({
          id: "resp_synthetic_short",
          object: "response",
          created_at: Math.floor(now / 1000),
          status: "completed",
          model: "gpt-5.6-sol",
          output: [],
          usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
        });
      },
      makeClient: () => ({
        async send() {
          dispatches++;
          return makeSdkResponse([{ assistantResponseEvent: { content: "SYNTHETIC_OK" } }]);
        },
      }),
    },
  );
  const body =
    protocol === "messages"
      ? {
          model: "claude-opus-5-5",
          max_tokens: 1024,
          messages: [{ role: "user", content: "Synthetic short session" }],
          stream,
        }
      : {
          model: "gpt-5.6-sol",
          input: "Synthetic short session",
          stream,
          ...(native ? {} : { store: false }),
        };
  const response = await app(
    new Request(
      `http://synthetic.invalid/v1/${protocol === "messages" ? "messages" : "responses"}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer synthetic-local-key",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    ),
  );
  await response.arrayBuffer();
  return { status: response.status, dispatches, nativeDispatches };
}

for (const seconds of [11, 51]) {
  for (const protocol of ["messages", "responses"] as const) {
    for (const stream of [false, true]) {
      test(`${protocol} stream=${stream} reuses a ${seconds}s refreshed token after maintenance and database reopen`, async () => {
        const f = fixture();
        const calls = installRefresh(seconds);
        await maintenance(f).runOnce();
        const first = f.database.getById("synthetic-account");
        expect(first?.lastRefreshAt).toBe(now);
        expect(first?.expiresAt).toBe(now + seconds * 1000);

        // A new manager/refresher must retain the short lifetime observation;
        // keeping it only in a refresher-local map does not fix a service restart.
        const restarted = open(f.path);
        now += 1000;
        await maintenance(restarted).runOnce();
        const result = await request(restarted, protocol, stream);
        expect(result.status).toBe(200);
        expect(result.dispatches).toBe(1);
        expect(calls()).toBe(1);
        expect(
          restarted.database.getById("synthetic-account")?.refreshFailureCount,
        ).toBeUndefined();
        expect(audit.events("account_maintenance_pass_completed").at(-1)?.token_due_count).toBe(0);
      });
    }
  }
}

test("short-lived credentials are refreshed in advance once half their lifetime has elapsed", async () => {
  const f = fixture();
  const calls = installRefresh(51);
  await maintenance(f).runOnce();
  now += 25_499;
  await maintenance(f).runOnce();
  expect(calls()).toBe(1);
  now += 1;
  await maintenance(f).runOnce();
  expect(calls()).toBe(2);
  expect(f.database.getById("synthetic-account")?.expiresAt).toBe(now + 51_000);
});

test("the configured five-minute margin still refreshes normal one-hour tokens", async () => {
  const f = fixture();
  const calls = installRefresh(3600);
  await maintenance(f).runOnce();
  now += 3_299_999;
  await maintenance(f).runOnce();
  expect(calls()).toBe(1);
  now += 1;
  await maintenance(f).runOnce();
  expect(calls()).toBe(2);
});

test("an upstream authentication rejection may still force rotation of a freshly minted short token", async () => {
  const f = fixture();
  const calls = installRefresh(51);
  await maintenance(f).runOnce();
  const current = f.database.getById("synthetic-account");
  if (!current) throw new Error("Synthetic account unexpectedly disappeared");
  await f.refresher.forceRefresh(current);
  expect(calls()).toBe(2);
});

test("native Responses keeps a short token minted by maintenance across a database reopen", async () => {
  const f = fixture();
  const calls = installRefresh(51);
  await maintenance(f).runOnce();
  const restarted = open(f.path);
  now += 1000;
  const result = await request(restarted, "native-responses");
  expect(result.status).toBe(200);
  expect(result.dispatches).toBe(1);
  expect(calls()).toBe(1);
  expect(result.nativeDispatches).toBe(1);
});

test("a short successful grant is usable without immediately hitting a following invalid_request", async () => {
  const f = fixture();
  let calls = 0;
  globalThis.fetch = Object.assign(
    async () => {
      calls++;
      return calls === 1
        ? Response.json({
            accessToken: "synthetic-short-access",
            refreshToken: "synthetic-short-refresh",
            expiresIn: 11,
          })
        : Response.json({ error: "invalid_request" }, { status: 400 });
    },
    { preconnect: originalFetch.preconnect },
  );
  await maintenance(f).runOnce();
  const restarted = open(f.path);
  now += 1000;
  await maintenance(restarted).runOnce();
  const result = await request(restarted, "messages");
  expect(result.status).toBe(200);
  expect(result.dispatches).toBe(1);
  expect(calls).toBe(1);
  expect(restarted.database.getById("synthetic-account")?.refreshRetryAt).toBeUndefined();
});

test("late refresh failure adopts a concurrent short-lived rotation without poisoning its persisted credentials", async () => {
  const f = fixture();
  const current = f.database.getById("synthetic-account");
  if (!current) throw new Error("Synthetic account unexpectedly disappeared");
  let started!: () => void;
  const hasStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = Object.assign(
    async () => {
      started();
      await released;
      return Response.json({ error: "invalid_request" }, { status: 400 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const pending = f.refresher.refreshIfNeeded(current, f.manager.toAuthDetails(current)).then(
    () => true,
    () => false,
  );
  await hasStarted;
  const replacement = open(f.path).database.insertAccount({
    ...current,
    accessToken: "synthetic-replacement-access",
    refreshToken: "synthetic-replacement-refresh",
    expiresAt: now + 51_000,
    lastRefreshAt: now,
  });
  release();
  expect(await pending).toBe(true);
  const row = f.database.getById("synthetic-account");
  expect(row?.generation).toBe(replacement.generation);
  expect(row?.refreshFailureCount).toBeUndefined();
  expect(row?.isHealthy).toBe(true);
});

test("an actually expired short token still fails closed and persists its OAuth backoff", async () => {
  const f = fixture({ expiresAt: now - 1, lastRefreshAt: now - 51_000 });
  let calls = 0;
  globalThis.fetch = Object.assign(
    async () => {
      calls++;
      return Response.json({ error: "invalid_request" }, { status: 400 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const result = await request(f, "messages");
  expect(result.status).toBe(503);
  expect(result.dispatches).toBe(0);
  expect(calls).toBe(1);
  const row = f.database.getById("synthetic-account");
  expect(row?.refreshFailureCount).toBe(1);
  expect(row?.refreshRetryAt).toBe(now + 30_000);
  expect(row?.isHealthy).toBe(true);
  expect(row?.unhealthyReason).toBeUndefined();
});

test("fresh short tokens never bypass an authentication backoff or force-refresh it again", async () => {
  const f = fixture({
    expiresAt: now + 51_000,
    lastRefreshAt: now,
    refreshFailureCount: 1,
    refreshFailureCode: "invalid_request",
    refreshFailedAt: now,
    refreshRetryAt: now + 30_000,
  });
  const calls = installRefresh(51);
  const current = f.database.getById("synthetic-account");
  if (!current) throw new Error("Synthetic account unexpectedly disappeared");
  await expect(
    f.refresher.refreshIfNeeded(current, f.manager.toAuthDetails(current)),
  ).rejects.toMatchObject({
    code: "REFRESH_BACKOFF",
  });
  await expect(f.refresher.forceRefresh(current)).rejects.toMatchObject({
    code: "REFRESH_BACKOFF",
  });
  expect(calls()).toBe(0);
});

test.each([
  { label: "legacy", lastRefreshAt: undefined, expiresAt: 1_700_000_051_000 },
  { label: "unknown", lastRefreshAt: 0, expiresAt: 1_700_000_051_000 },
  { label: "invalid-issued", lastRefreshAt: Number.NaN, expiresAt: 1_700_000_051_000 },
  {
    label: "invalid-expiry",
    lastRefreshAt: 1_700_000_000_000,
    expiresAt: Number.POSITIVE_INFINITY,
  },
  { label: "reversed", lastRefreshAt: 1_700_000_051_001, expiresAt: 1_700_000_051_000 },
])("$label issuance metadata does not invent a shorter refresh margin", (account) => {
  expect(credentialRefreshBufferMs(account, 300_000)).toBe(300_000);
});

test("a configured zero margin stays zero for an observed short token", () => {
  expect(credentialRefreshBufferMs({ lastRefreshAt: now, expiresAt: now + 51_000 }, 0)).toBe(0);
});

for (const flow of ["login", "relogin"] as const) {
  for (const protocol of ["messages", "responses", "native-responses"] as const) {
    for (const seconds of [11, 51]) {
      test(`${flow} with a ${seconds}s token survives SQLite reopen and its first ${protocol} request`, async () => {
        const profileArn = "arn:aws:codewhisperer:eu-central-1:000000000000:profile/synthetic";
        const f = fixture({
          region: "eu-central-1",
          profileArn,
          refreshFailureCount: 12,
          refreshFailureCode: "invalid_request",
          refreshFailedAt: now - 1,
          refreshRetryAt: now + 30_000,
        });
        const previous = f.database.getById("synthetic-account");
        if (!previous) throw new Error("Synthetic account unexpectedly disappeared");
        if (flow === "login") f.database.removeAccount(previous.id);
        const issuedAt = now;
        let deviceGrants = 0;
        let refreshGrants = 0;
        globalThis.fetch = Object.assign(
          async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            if (path === "/client/register") {
              return Response.json({
                clientId: "synthetic-login-client",
                clientSecret: "synthetic-login-secret",
              });
            }
            if (path === "/device_authorization") {
              return Response.json({
                verificationUri: "https://synthetic.test/verify",
                verificationUriComplete: "https://synthetic.test/verify",
                userCode: "synthetic",
                deviceCode: "synthetic",
                interval: 1,
                expiresIn: 60,
              });
            }
            if (path === "/token") {
              const body = JSON.parse(String(init?.body)) as { grantType?: string };
              if (body.grantType === "urn:ietf:params:oauth:grant-type:device_code") {
                deviceGrants++;
                return Response.json({
                  accessToken: "synthetic-login-access",
                  refreshToken: "synthetic-login-refresh",
                  expiresIn: seconds,
                });
              }
              refreshGrants++;
              return Response.json({ error: "invalid_request" }, { status: 400 });
            }
            throw new Error("Unexpected synthetic authentication endpoint");
          },
          { preconnect: originalFetch.preconnect },
        );
        const result = await runLogin(
          ConfigSchema.parse({ api_keys: ["synthetic-local-key"], proxy_url: "" }),
          flow === "relogin"
            ? { replaceAccount: previous }
            : { startUrl: previous.startUrl, region: previous.oidcRegion, profileArn },
          {
            poll: (client, secret, device, interval, expires, region, _sleep, proxy) =>
              pollKiroIDCToken(
                client,
                secret,
                device,
                interval,
                expires,
                region,
                async () => {},
                proxy,
              ),
            listProfiles: async () => [{ arn: profileArn }],
            fetchUsage: async (auth) => {
              expect(auth.region).toBe("eu-central-1");
              expect(auth.oidcRegion).toBe("us-east-1");
              // Discovery/identity validation is later than the successful poll;
              // admission time must not be substituted for token receipt time.
              now += 1000;
              return { email: previous.email, usedCount: 1, limitCount: 10_000, overageCount: 0 };
            },
            openDb: () => new AccountsDatabase(f.path),
            stdout: () => {},
            stderr: () => {},
          },
        );
        const restarted = open(f.path);
        const response = await request(restarted, protocol);
        expect(response.status).toBe(200);
        expect(response.dispatches).toBe(1);
        expect(deviceGrants).toBe(1);
        expect(refreshGrants).toBe(0);
        const row = restarted.database.getById(result.account.id);
        expect(row?.lastRefreshAt).toBe(issuedAt);
        expect(row?.expiresAt).toBe(issuedAt + seconds * 1000);
        expect(row?.profileArn).toBe(profileArn);
        expect(row?.oidcRegion).toBe("us-east-1");
        expect(row?.region).toBe("eu-central-1");
        expect(row?.refreshFailureCount).toBeUndefined();
        expect(row?.refreshRetryAt).toBeUndefined();
        if (flow === "relogin") expect(row?.id).toBe(previous.id);
      });
    }
  }
}
