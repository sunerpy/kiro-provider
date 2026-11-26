import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config/schema.ts";
import { AccountManager } from "../src/core/account-manager.ts";
import { TokenRefresher } from "../src/core/token-refresher.ts";
import { createApp } from "../src/server/app.ts";
import { AccountsDatabase } from "../src/storage/accounts-db.ts";
import { captureAuditEvents } from "./audit-test-helpers.ts";
import { makeSdkResponse } from "./sdk-stream-test-helpers.ts";

// Synthetic credentials only. Inference rejects one access token while another
// SQLite writer changes the refresh tuple; that change cannot undo the rejection.
const realFetch = globalThis.fetch;
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
  globalThis.fetch = realFetch;
  clock.mockRestore();
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  audit.restore();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "kiro-forced-causality-"));
  directories.push(directory);
  const path = join(directory, "accounts.db");
  const database = new AccountsDatabase(path);
  const external = new AccountsDatabase(path);
  databases.push(database, external);
  const account = database.insertAccount({
    id: "synthetic-account",
    email: "fixture@example.invalid",
    authMethod: "idc",
    region: "us-east-1",
    oidcRegion: "us-east-1",
    clientId: "synthetic-client",
    clientSecret: "synthetic-client-secret",
    profileArn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/synthetic",
    startUrl: "https://synthetic.awsapps.com/start",
    refreshToken: "synthetic-refresh-before",
    accessToken: "synthetic-rejected-access",
    expiresAt: now + 51_000,
    lastRefreshAt: now,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 1,
    limitCount: 10_000,
    lastSync: now,
  });
  const manager = new AccountManager([account], "lowest-usage", database);
  const refresher = new TokenRefresher(manager, 300_000);
  const rotateRefreshOnly = () => {
    const current = external.getById(account.id);
    if (!current) throw new Error("Missing synthetic account");
    return external.insertAccount({ ...current, refreshToken: "synthetic-refresh-after" });
  };
  return { database, external, manager, refresher, account, rotateRefreshOnly };
}

for (const protocol of ["messages", "responses", "native"] as const) {
  for (const status of [401, 403]) {
    for (const phase of ["before-force", "late-rejection", "cas-adoption"] as const) {
      for (const stream of [false, true]) {
        test(`${protocol} ${status} stream=${stream} never reuses rejected access after ${phase}`, async () => {
          const f = fixture();
          let rejectedDispatches = 0;
          let refreshes = 0;
          globalThis.fetch = Object.assign(
            async () => {
              refreshes++;
              f.rotateRefreshOnly();
              return phase === "cas-adoption"
                ? Response.json({
                    accessToken: "synthetic-network-new-access",
                    refreshToken: "synthetic-network-new-refresh",
                    expiresIn: 51,
                  })
                : Response.json({ error: "invalid_request" }, { status: 400 });
            },
            { preconnect: realFetch.preconnect },
          );
          const reject = () => {
            rejectedDispatches++;
            if (rejectedDispatches === 1 && phase === "before-force") f.rotateRefreshOnly();
          };
          const app = createApp(
            ConfigSchema.parse({
              api_keys: ["synthetic-local-key"],
              protocol_projection_mode: protocol === "native" ? "v3-auto" : "safe",
              responses_native_tool_bridge: "off",
              dynamic_model_catalog: false,
              account_maintenance_enabled: false,
              rate_limit_max_retries: 0,
              rate_limit_retry_delay_ms: 1,
              request_timeout_ms: 1000,
              stream_idle_timeout_ms: 500,
            }),
            {
              accountManager: f.manager,
              tokenRefresher: f.refresher,
              makeClient: () => ({
                async send() {
                  reject();
                  throw Object.assign(
                    new Error("The bearer token included in the request is invalid"),
                    {
                      name: "AccessDeniedException",
                      $metadata: { httpStatusCode: status },
                    },
                  );
                },
              }),
              nativeResponsesFetch: async () => {
                reject();
                return Response.json(
                  { message: "The bearer token included in the request is invalid" },
                  { status },
                );
              },
            },
          );
          const body =
            protocol === "messages"
              ? {
                  model: "claude-opus-5-5",
                  max_tokens: 1024,
                  stream,
                  messages: [{ role: "user", content: "Synthetic" }],
                }
              : {
                  model: "gpt-5.6-sol",
                  stream,
                  input: "Synthetic",
                  ...(protocol === "native" ? {} : { store: false }),
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
          const text = await response.text();
          expect(rejectedDispatches).toBe(1);
          expect([502, 503]).toContain(response.status);
          expect(refreshes).toBe(phase === "before-force" ? 0 : 1);
          const current = f.database.getById(f.account.id);
          expect(current?.accessToken === f.account.accessToken).toBe(true);
          expect(current?.refreshToken).toBe("synthetic-refresh-after");
          expect(current?.refreshFailureCount).toBeUndefined();
          expect(text).not.toContain(f.account.accessToken);
          expect(text).not.toContain(f.account.refreshToken);
          expect(text).not.toContain(f.account.clientSecret as string);
        });
      }
    }
  }
}

test("force callers joining an ordinary no-network adoption must obtain a fresh access token", async () => {
  const f = fixture();
  const expired = f.external.insertAccount({
    ...f.account,
    expiresAt: now - 1,
    lastRefreshAt: now - 3_600_000,
  });
  const getLatest = f.manager.getLatestAccount.bind(f.manager);
  let reads = 0;
  const spy = spyOn(f.manager, "getLatestAccount").mockImplementation((id) => {
    reads++;
    if (reads === 2)
      f.external.insertAccount({ ...f.account, refreshToken: "synthetic-refresh-after" });
    return getLatest(id);
  });
  let refreshes = 0;
  globalThis.fetch = Object.assign(
    async () => {
      refreshes++;
      return Response.json({
        accessToken: "synthetic-fresh-access",
        refreshToken: "synthetic-fresh-refresh",
        expiresIn: 51,
      });
    },
    { preconnect: realFetch.preconnect },
  );
  try {
    const ordinary = f.refresher.refreshIfNeeded(expired, f.manager.toAuthDetails(expired));
    const forced = f.refresher.forceRefresh(expired);
    const joined = f.refresher.forceRefresh(expired);
    expect((await ordinary).accessToken === expired.accessToken).toBe(true);
    expect((await forced).accessToken === expired.accessToken).toBe(false);
    expect((await joined).accessToken === expired.accessToken).toBe(false);
    expect(refreshes).toBe(1);
  } finally {
    spy.mockRestore();
  }
});

test("a force operation for A cannot authorize a joiner whose rejected access is adopted B", async () => {
  const f = fixture();
  const b = f.external.insertAccount({
    ...f.account,
    accessToken: "synthetic-rejected-b",
    refreshToken: "synthetic-refresh-b",
  });
  let refreshes = 0;
  globalThis.fetch = Object.assign(
    async () => {
      refreshes++;
      return Response.json({
        accessToken: "synthetic-fresh-c",
        refreshToken: "synthetic-refresh-c",
        expiresIn: 51,
      });
    },
    { preconnect: realFetch.preconnect },
  );
  const aForce = f.refresher.forceRefresh(f.account);
  const bForce = f.refresher.forceRefresh(b);
  expect((await aForce).accessToken === b.accessToken).toBe(true);
  expect((await bForce).accessToken === b.accessToken).toBe(false);
  expect(refreshes).toBe(1);
});

test("a cancelled force waiter never starts a follow-up network refresh after ordinary adoption", async () => {
  const f = fixture();
  const expired = f.external.insertAccount({
    ...f.account,
    expiresAt: now - 1,
    lastRefreshAt: now - 3_600_000,
  });
  const getLatest = f.manager.getLatestAccount.bind(f.manager);
  let reads = 0;
  const spy = spyOn(f.manager, "getLatestAccount").mockImplementation((id) => {
    reads++;
    if (reads === 2)
      f.external.insertAccount({ ...f.account, refreshToken: "synthetic-refresh-after" });
    return getLatest(id);
  });
  let refreshes = 0;
  globalThis.fetch = Object.assign(
    async () => {
      refreshes++;
      return Response.json({ accessToken: "synthetic-fresh-c", expiresIn: 51 });
    },
    { preconnect: realFetch.preconnect },
  );
  try {
    const ordinary = f.refresher.refreshIfNeeded(expired, f.manager.toAuthDetails(expired));
    const controller = new AbortController();
    const forced = f.refresher.forceRefresh(expired, controller.signal);
    controller.abort();
    await expect(forced).rejects.toMatchObject({ name: "AbortError" });
    await ordinary;
    await Promise.resolve();
    await Promise.resolve();
    expect(refreshes).toBe(0);
  } finally {
    spy.mockRestore();
  }
});

test("an authoritative force network response may return the same access to all matching waiters", async () => {
  const f = fixture();
  const started = deferred();
  const release = deferred();
  let refreshes = 0;
  globalThis.fetch = Object.assign(
    async () => {
      refreshes++;
      started.resolve();
      await release.promise;
      return Response.json({
        accessToken: f.account.accessToken,
        refreshToken: "synthetic-authoritative-refresh",
        expiresIn: 51,
      });
    },
    { preconnect: realFetch.preconnect },
  );
  const first = f.refresher.forceRefresh(f.account);
  await started.promise;
  const second = f.refresher.forceRefresh(f.account);
  release.resolve();
  expect((await first).accessToken === f.account.accessToken).toBe(true);
  expect((await second).accessToken === f.account.accessToken).toBe(true);
  expect(refreshes).toBe(1);
});

test("a concurrent CAS row with rejected access is usable only when the actual force grant returned that access", async () => {
  const f = fixture();
  let refreshes = 0;
  globalThis.fetch = Object.assign(
    async () => {
      refreshes++;
      f.rotateRefreshOnly();
      return Response.json({
        accessToken: f.account.accessToken,
        refreshToken: "synthetic-network-refresh",
        expiresIn: 51,
      });
    },
    { preconnect: realFetch.preconnect },
  );
  expect((await f.refresher.forceRefresh(f.account)).accessToken === f.account.accessToken).toBe(
    true,
  );
  expect(refreshes).toBe(1);
});

test("a force waiter accepts an ordinary authoritative network grant returning the same access without a second refresh", async () => {
  const f = fixture();
  const expired = f.external.insertAccount({
    ...f.account,
    expiresAt: now - 1,
    lastRefreshAt: now - 3_600_000,
  });
  const started = deferred();
  const release = deferred();
  let refreshes = 0;
  globalThis.fetch = Object.assign(
    async () => {
      refreshes++;
      if (refreshes === 1) {
        started.resolve();
        await release.promise;
      }
      return refreshes === 1
        ? Response.json({
            accessToken: expired.accessToken,
            refreshToken: "synthetic-network-refresh",
            expiresIn: 51,
          })
        : Response.json({ error: "invalid_request" }, { status: 400 });
    },
    { preconnect: realFetch.preconnect },
  );
  const ordinary = f.refresher.refreshIfNeeded(expired, f.manager.toAuthDetails(expired));
  await started.promise;
  const forced = f.refresher.forceRefresh(expired);
  release.resolve();
  expect((await ordinary).accessToken === expired.accessToken).toBe(true);
  expect((await forced).accessToken === expired.accessToken).toBe(true);
  expect(refreshes).toBe(1);
});

for (const change of [
  {
    label: "profile",
    patch: { profileArn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/other" },
  },
  { label: "issuer", patch: { oidcRegion: "eu-central-1" } },
  { label: "identity", patch: { email: "other@example.invalid" } },
  { label: "start-url", patch: { startUrl: "https://other.awsapps.com/start" } },
] as const) {
  test(`a shared force result cannot cross its waiter's ${change.label} boundary`, async () => {
    const f = fixture();
    const replacement = f.external.insertAccount({
      ...f.account,
      ...change.patch,
      accessToken: "synthetic-other-owner-access",
      refreshToken: "synthetic-other-owner-refresh",
    });
    const started = deferred();
    const release = deferred();
    let refreshes = 0;
    globalThis.fetch = Object.assign(
      async () => {
        refreshes++;
        started.resolve();
        await release.promise;
        return Response.json({
          accessToken: "synthetic-refreshed-other-owner-access",
          refreshToken: "synthetic-refreshed-other-owner-refresh",
          expiresIn: 51,
        });
      },
      { preconnect: realFetch.preconnect },
    );
    const current = f.refresher.forceRefresh(replacement);
    await started.promise;
    const stale = f.refresher.forceRefresh(f.account).then(
      () => true,
      () => false,
    );
    release.resolve();
    expect((await current).accessToken === replacement.accessToken).toBe(false);
    expect(await stale).toBe(false);
    expect(refreshes).toBe(1);
  });
}

test("a cancelled caller does not prevent an active force waiter from starting one shared follow-up", async () => {
  const f = fixture();
  const expired = f.external.insertAccount({
    ...f.account,
    expiresAt: now - 1,
    lastRefreshAt: now - 3_600_000,
  });
  const getLatest = f.manager.getLatestAccount.bind(f.manager);
  let reads = 0;
  const spy = spyOn(f.manager, "getLatestAccount").mockImplementation((id) => {
    reads++;
    if (reads === 2)
      f.external.insertAccount({ ...f.account, refreshToken: "synthetic-refresh-after" });
    return getLatest(id);
  });
  let refreshes = 0;
  globalThis.fetch = Object.assign(
    async () => {
      refreshes++;
      return Response.json({
        accessToken: "synthetic-active-access",
        refreshToken: "synthetic-active-refresh",
        expiresIn: 51,
      });
    },
    { preconnect: realFetch.preconnect },
  );
  try {
    const ordinary = f.refresher.refreshIfNeeded(expired, f.manager.toAuthDetails(expired));
    const controller = new AbortController();
    const cancelled = f.refresher.forceRefresh(expired, controller.signal);
    const active = f.refresher.forceRefresh(expired);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await ordinary;
    expect((await active).accessToken === expired.accessToken).toBe(false);
    expect(refreshes).toBe(1);
  } finally {
    spy.mockRestore();
  }
});

test("an already cancelled force caller never starts a network refresh", async () => {
  const f = fixture();
  let refreshes = 0;
  globalThis.fetch = Object.assign(
    async () => {
      refreshes++;
      return Response.json({ accessToken: "synthetic-unused-access", expiresIn: 51 });
    },
    { preconnect: realFetch.preconnect },
  );
  await expect(f.refresher.forceRefresh(f.account, AbortSignal.abort())).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(refreshes).toBe(0);
});

test("Messages falls over to an eligible peer after rejecting a refresh-only update of denied access", async () => {
  const f = fixture();
  const peer = f.database.insertAccount({
    ...f.account,
    id: "synthetic-peer",
    email: "peer@example.invalid",
    accessToken: "synthetic-peer-access",
    refreshToken: "synthetic-peer-refresh",
    usedCount: 100,
    expiresAt: now + 3_600_000,
  });
  let rejectedDispatches = 0;
  let peerDispatches = 0;
  let refreshes = 0;
  globalThis.fetch = Object.assign(
    async () => {
      refreshes++;
      throw new Error("No network is needed for the synthetic eligible peer");
    },
    { preconnect: realFetch.preconnect },
  );
  const app = createApp(
    ConfigSchema.parse({
      api_keys: ["synthetic-local-key"],
      protocol_projection_mode: "safe",
      dynamic_model_catalog: false,
      account_maintenance_enabled: false,
      rate_limit_max_retries: 0,
      rate_limit_retry_delay_ms: 1,
    }),
    {
      accountManager: f.manager,
      tokenRefresher: f.refresher,
      makeClient: (auth) => ({
        async send() {
          if (auth.access === f.account.accessToken) {
            rejectedDispatches++;
            f.rotateRefreshOnly();
            throw Object.assign(new Error("Synthetic rejected credentials"), {
              $metadata: { httpStatusCode: 401 },
            });
          }
          expect(auth.access === peer.accessToken).toBe(true);
          peerDispatches++;
          return makeSdkResponse([{ assistantResponseEvent: { content: "SYNTHETIC_PEER_OK" } }]);
        },
      }),
    },
  );
  const response = await app(
    new Request("http://synthetic.invalid/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer synthetic-local-key", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-5-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Synthetic" }],
      }),
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("SYNTHETIC_PEER_OK");
  expect(rejectedDispatches).toBe(1);
  expect(peerDispatches).toBe(1);
  expect(refreshes).toBe(0);
});
