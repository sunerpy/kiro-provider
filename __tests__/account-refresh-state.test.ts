import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config/schema.ts";
import { AccountMaintenanceService } from "../src/core/account-maintenance.ts";
import { AccountManager } from "../src/core/account-manager.ts";
import { recordRefreshFailure } from "../src/core/credential-state.ts";
import { QuotaRechecker } from "../src/core/quota-rechecker.ts";
import { TokenRefresher } from "../src/core/token-refresher.ts";
import { KiroTokenRefreshError } from "../src/kiro/errors.ts";
import { isClientRegistrationExpired, isRefreshTokenDead } from "../src/kiro/health.ts";
import { refreshAccessToken } from "../src/kiro/token.ts";
import type { ManagedAccount } from "../src/kiro/types.ts";
import { KiroUsageError } from "../src/kiro/usage-client.ts";
import { createApp } from "../src/server/app.ts";
import { AccountsDatabase } from "../src/storage/accounts-db.ts";
import { captureAuditEvents } from "./audit-test-helpers.ts";
import { makeSdkResponse } from "./sdk-stream-test-helpers.ts";

// Every credential/identity in this harness is a synthetic fixture. Never print
// complete rows, request bodies, opaque values, or original Error messages.
const originalFetch = globalThis.fetch;
const databases: AccountsDatabase[] = [];
const directories: string[] = [];
let audit: ReturnType<typeof captureAuditEvents>;
beforeEach(() => {
  audit = captureAuditEvents();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
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

function fixture(overrides: Partial<ManagedAccount> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "kiro-refresh-state-"));
  directories.push(directory);
  const path = join(directory, "accounts.db");
  const database = new AccountsDatabase(path);
  const external = new AccountsDatabase(path);
  databases.push(database, external);
  const input: ManagedAccount = {
    id: "synthetic-account",
    email: "fixture@example.invalid",
    authMethod: "idc",
    region: "us-east-1",
    oidcRegion: "us-east-1",
    clientId: "synthetic-old-client",
    clientSecret: "synthetic-old-client-secret",
    profileArn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/synthetic",
    startUrl: "https://synthetic.awsapps.com/start",
    refreshToken: "synthetic-old-refresh",
    accessToken: "synthetic-old-access",
    expiresAt: Date.now() - 60_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 1,
    limitCount: 100,
    lastSync: Date.now(),
    ...overrides,
  };
  const account = database.insertAccount(input);
  const manager = new AccountManager([account], "sticky", database);
  const refresher = new TokenRefresher(manager, 300_000);
  const replace = () =>
    external.insertAccount({
      ...input,
      clientId: "synthetic-new-client",
      clientSecret: "synthetic-new-client-secret",
      refreshToken: "synthetic-new-refresh",
      accessToken: "synthetic-new-access",
      expiresAt: Date.now() + 3_600_000,
    });
  return { database, external, account, manager, refresher, replace };
}

function fakeRefresh(code: "invalid_grant" | "invalid_request" | "success") {
  const started = deferred();
  const release = deferred();
  let calls = 0;
  globalThis.fetch = Object.assign(
    async () => {
      calls++;
      started.resolve();
      await release.promise;
      return code === "success"
        ? Response.json({
            accessToken: "synthetic-stale-access",
            refreshToken: "synthetic-stale-refresh",
            expiresIn: 3600,
          })
        : Response.json({ error: code, error_description: "synthetic rejection" }, { status: 400 });
    },
    { preconnect: originalFetch.preconnect },
  );
  return { started, release, calls: () => calls };
}

function persisted(f: ReturnType<typeof fixture>) {
  const row = f.database.getById(f.account.id);
  if (!row) throw new Error("Synthetic account unexpectedly disappeared");
  return row;
}

test("late permanent refresh rejection must not mark a replacement login dead", async () => {
  const f = fixture();
  const mock = fakeRefresh("invalid_grant");
  const pending = f.refresher.refreshIfNeeded(f.account, f.manager.toAuthDetails(f.account)).then(
    () => "fulfilled",
    () => "rejected",
  );
  await mock.started.promise;
  const fresh = f.replace();
  mock.release.resolve();
  const outcome = await pending;
  const row = persisted(f);
  expect(row.accessToken === fresh.accessToken).toBe(true);
  expect(mock.calls()).toBe(1);
  expect(row.isHealthy).toBe(true);
  expect(row.failCount).toBe(0);
  expect(outcome).toBe("fulfilled");
});

for (const code of ["invalid_grant", "invalid_request"] as const) {
  test(`authenticated Messages pipeline must adopt replacement login after late ${code}`, async () => {
    const f = fixture();
    const mock = fakeRefresh(code);
    let sdkCalls = 0;
    let sdkUsedNewCredential = false;
    const config = ConfigSchema.parse({
      api_keys: ["synthetic-local-key"],
      protocol_projection_mode: "safe",
      dynamic_model_catalog: false,
      account_maintenance_enabled: false,
      rate_limit_retry_delay_ms: 5000,
      request_timeout_ms: 1000,
      stream_idle_timeout_ms: 500,
    });
    const app = createApp(config, {
      accountManager: f.manager,
      tokenRefresher: f.refresher,
      makeClient: (auth) => ({
        async send() {
          sdkCalls++;
          sdkUsedNewCredential = auth.access === "synthetic-new-access";
          return makeSdkResponse([{ assistantResponseEvent: { content: "SYNTHETIC_OK" } }]);
        },
      }),
    });
    const pending = app(
      new Request("http://synthetic.invalid/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer synthetic-local-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-opus-5-5",
          max_tokens: 1024,
          stream: false,
          messages: [{ role: "user", content: "Synthetic audit only" }],
        }),
      }),
    );
    await mock.started.promise;
    const fresh = f.replace();
    mock.release.resolve();
    const response = await pending;
    await response.arrayBuffer();
    const row = persisted(f);
    expect(row.accessToken === fresh.accessToken).toBe(true);
    expect(mock.calls()).toBe(1);
    expect(row.isHealthy).toBe(true);
    expect(row.rateLimitResetTime > Date.now()).toBe(false);
    expect(response.status).toBe(200);
    expect(sdkCalls).toBe(1);
    expect(sdkUsedNewCredential).toBe(true);
  });
}

test("control: current credential permanent rejection still marks the current account dead", async () => {
  const f = fixture();
  const mock = fakeRefresh("invalid_grant");
  const pending = f.refresher.refreshIfNeeded(f.account, f.manager.toAuthDetails(f.account)).then(
    () => false,
    () => true,
  );
  await mock.started.promise;
  mock.release.resolve();
  expect(await pending).toBe(true);
  const row = persisted(f);
  expect(row.isHealthy).toBe(false);
  expect(row.failCount).toBe(10);
});

test("control: late successful refresh cannot overwrite the replacement login", async () => {
  const f = fixture();
  const mock = fakeRefresh("success");
  const pending = f.refresher.refreshIfNeeded(f.account, f.manager.toAuthDetails(f.account));
  await mock.started.promise;
  const fresh = f.replace();
  mock.release.resolve();
  let fulfilled = false;
  let adopted = false;
  try {
    const result = await pending;
    fulfilled = true;
    adopted = result.accessToken === fresh.accessToken;
  } catch {}
  const row = persisted(f);
  expect(fulfilled).toBe(true);
  expect(adopted).toBe(true);
  expect(row.isHealthy).toBe(true);
  expect(row.accessToken === fresh.accessToken).toBe(true);
  expect(mock.calls()).toBe(1);
});

test("invalid_request persists independent auth backoff and prevents repeated network refresh", async () => {
  const f = fixture();
  const mock = fakeRefresh("invalid_request");
  const pending = f.refresher
    .refreshIfNeeded(f.account, f.manager.toAuthDetails(f.account))
    .catch((error: unknown) => error);
  await mock.started.promise;
  mock.release.resolve();
  const error = await pending;
  expect(error instanceof KiroTokenRefreshError).toBe(true);
  const failed = persisted(f);
  expect(failed.refreshFailureCount).toBe(1);
  expect(failed.refreshFailureCode).toBe("invalid_request");
  expect((failed.refreshRetryAt ?? 0) - (failed.refreshFailedAt ?? 0)).toBe(30_000);
  expect(failed.rateLimitResetTime).toBe(0);
  expect(failed.isHealthy).toBe(true);
  recordRefreshFailure(f.manager, f.account, error);
  recordRefreshFailure(f.manager, f.account, error);
  expect(persisted(f).generation).toBe(failed.generation);
  let secondCode: string | undefined;
  try {
    await f.refresher.refreshIfNeeded(f.account, f.manager.toAuthDetails(f.account));
  } catch (caught) {
    if (caught instanceof KiroTokenRefreshError) {
      secondCode = caught.code;
      expect(caught.retryAt).toBe(failed.refreshRetryAt);
    }
  }
  expect(secondCode).toBe("REFRESH_BACKOFF");
  expect(mock.calls()).toBe(1);
  expect(persisted(f).refreshFailureCount).toBe(1);
});

test("auth backoff survives reopening and doubles from 30 seconds up to 15 minutes", () => {
  const f = fixture();
  const delays = [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000];
  for (const [index, delay] of delays.entries()) {
    recordRefreshFailure(
      f.manager,
      f.account,
      new KiroTokenRefreshError("Synthetic refresh failure", "invalid_request"),
    );
    const row = f.external.getById(f.account.id);
    expect(row?.refreshFailureCount).toBe(index + 1);
    expect((row?.refreshRetryAt ?? 0) - (row?.refreshFailedAt ?? 0)).toBe(delay);
    expect(row?.rateLimitResetTime).toBe(0);
  }
});

test("successful refresh clears auth failure state, records success and preserves a real upstream cooldown", async () => {
  const cooldown = Date.now() + 60_000;
  const f = fixture({
    refreshFailureCount: 3,
    refreshFailureCode: "network_error",
    refreshFailedAt: Date.now() - 100_000,
    refreshRetryAt: Date.now() - 1,
    rateLimitResetTime: cooldown,
  });
  const mock = fakeRefresh("success");
  const pending = f.refresher.refreshIfNeeded(f.account, f.manager.toAuthDetails(f.account));
  await mock.started.promise;
  mock.release.resolve();
  await pending;
  const row = persisted(f);
  expect(row.refreshFailureCount).toBeUndefined();
  expect(row.refreshFailureCode).toBeUndefined();
  expect(row.refreshFailedAt).toBeUndefined();
  expect(row.refreshRetryAt).toBeUndefined();
  expect(row.lastRefreshAt).toBeGreaterThan(0);
  expect(row.rateLimitResetTime).toBe(cooldown);
});

test("a benign usage generation bump does not hide a current-credential refresh failure", async () => {
  const f = fixture();
  const mock = fakeRefresh("invalid_request");
  const pending = f.refresher
    .refreshIfNeeded(f.account, f.manager.toAuthDetails(f.account))
    .catch(() => undefined);
  await mock.started.promise;
  f.external.updateExistingAccounts([{ ...f.account, usedCount: 42, lastUsed: 99 }]);
  mock.release.resolve();
  await pending;
  expect(persisted(f)).toMatchObject({
    usedCount: 42,
    lastUsed: 99,
    refreshFailureCount: 1,
    refreshFailureCode: "invalid_request",
    isHealthy: true,
  });
});

test("a case-only authoritative usage email update cannot discard a successful token rotation", async () => {
  const f = fixture();
  const mock = fakeRefresh("success");
  const pending = f.refresher.refreshIfNeeded(f.account, f.manager.toAuthDetails(f.account)).then(
    () => true,
    () => false,
  );
  await mock.started.promise;
  f.manager.updateQuotaUsage(
    f.account,
    {
      email: "Fixture@Example.Invalid",
      usedCount: 42,
      limitCount: 100,
      overageCount: 0,
      lastSync: Date.now() + 1,
    },
    0,
  );
  mock.release.resolve();
  expect(await pending).toBe(true);
  const row = persisted(f);
  expect(row.refreshToken === "synthetic-stale-refresh").toBe(true);
  expect(row.usedCount).toBe(42);
  expect(row.email).toBe("Fixture@Example.Invalid");
  expect(row.lastRefreshAt).toBeGreaterThan(0);
});

test.each([
  { label: "client_secret", change: { clientSecret: "synthetic-replacement-secret" } },
  { label: "issuer_region", change: { oidcRegion: "eu-west-1" as const } },
  { label: "runtime_region", change: { region: "eu-west-1" as const } },
  {
    label: "profile",
    change: { profileArn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/different" },
  },
  { label: "client_issued_at", change: { clientIdIssuedAt: 1000 } },
  { label: "client_expires_at", change: { clientSecretExpiresAt: Date.now() + 3_600_000 } },
])(
  "the full attempted tuple guards late failure writes after $label changes",
  async ({ change }) => {
    const f = fixture();
    const mock = fakeRefresh("invalid_grant");
    const pending = f.refresher
      .refreshIfNeeded(f.account, f.manager.toAuthDetails(f.account))
      .catch(() => undefined);
    await mock.started.promise;
    const replacement = f.external.insertAccount({ ...f.account, ...change });
    mock.release.resolve();
    await pending;
    const row = persisted(f);
    expect(row.generation).toBe(replacement.generation);
    expect(row.isHealthy).toBe(true);
    expect(row.refreshFailureCount).toBeUndefined();
    expect(row.refreshRetryAt).toBeUndefined();
  },
);

test("registration metadata is forwarded from the stored tuple to the refresh auth", () => {
  const f = fixture({ clientIdIssuedAt: 1000, clientSecretExpiresAt: Date.now() + 3_600_000 });
  const auth = f.manager.toAuthDetails(f.account);
  expect(auth.clientIdIssuedAt).toBe(f.account.clientIdIssuedAt);
  expect(auth.clientSecretExpiresAt).toBe(f.account.clientSecretExpiresAt);
});

test("direct token refresh rejects a known expired client before any transport call", async () => {
  const f = fixture();
  let calls = 0;
  globalThis.fetch = Object.assign(
    async () => {
      calls++;
      return Response.json({ accessToken: "synthetic-new", expiresIn: 3600 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const result = await refreshAccessToken({
    ...f.manager.toAuthDetails(f.account),
    clientSecretExpiresAt: Date.now() - 1,
  }).then(
    () => undefined,
    (error: unknown) => (error instanceof KiroTokenRefreshError ? error.code : "other"),
  );
  expect(result).toBe("CLIENT_REGISTRATION_EXPIRED");
  expect(calls).toBe(0);
});

test("known client expiry is persisted as needs-relogin without guessing legacy metadata", async () => {
  const f = fixture({ clientSecretExpiresAt: Date.now() - 1 });
  let calls = 0;
  globalThis.fetch = Object.assign(
    async () => {
      calls++;
      throw new Error("Unexpected transport");
    },
    { preconnect: originalFetch.preconnect },
  );
  await expect(
    f.refresher.refreshIfNeeded(f.account, f.manager.toAuthDetails(f.account)),
  ).rejects.toMatchObject({ code: "CLIENT_REGISTRATION_EXPIRED" });
  expect(calls).toBe(0);
  expect(persisted(f).isHealthy).toBe(false);
  expect(isClientRegistrationExpired({ authMethod: "idc" })).toBe(false);
  expect(isClientRegistrationExpired({ authMethod: "idc", clientSecretExpiresAt: 0 })).toBe(false);
  expect(
    isClientRegistrationExpired({ authMethod: "idc", clientSecretExpiresAt: Number.NaN }),
  ).toBe(false);
  expect(isClientRegistrationExpired({ authMethod: "desktop", clientSecretExpiresAt: 1 })).toBe(
    false,
  );
  expect(isRefreshTokenDead("expired_token: Synthetic OAuth rejection")).toBe(true);
  expect(isRefreshTokenDead("invalid_request: Synthetic OAuth rejection")).toBe(false);
});

test.each(["invalid_request", "HTTP_403", "NETWORK_ERROR"])(
  "a structured transient %s cannot become permanent from incidental error prose",
  (code) => {
    const f = fixture();
    recordRefreshFailure(
      f.manager,
      f.account,
      new KiroTokenRefreshError(
        "Synthetic diagnostic mentions invalid_grant but is not that service code",
        code,
      ),
    );
    const row = persisted(f);
    expect(row.isHealthy).toBe(true);
    expect(row.unhealthyReason).toBeUndefined();
    expect(row.refreshRetryAt).toBeGreaterThan(Date.now());
    expect(row.refreshFailureCount).toBe(1);
  },
);

for (const kind of ["http_500", "network"] as const) {
  test(`usage ${kind} does not become auth failure or prevent real Messages dispatch`, async () => {
    const f = fixture({ expiresAt: Date.now() + 3_600_000 });
    let refreshCalls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        refreshCalls++;
        throw new Error("Unexpected OAuth transport");
      },
      { preconnect: originalFetch.preconnect },
    );
    const rechecker = new QuotaRechecker({
      accountManager: f.manager,
      tokenRefresher: f.refresher,
      intervalMs: 60_000,
      usageRefreshIntervalMs: 60_000,
      timeoutMs: 500,
      concurrency: 1,
      fetchUsage: async () => {
        if (kind === "http_500") throw new KiroUsageError("Synthetic usage error", 500);
        throw new TypeError("Synthetic usage transport failure");
      },
    });
    const result = await rechecker.refreshAccounts([f.account], new AbortController().signal);
    expect(result.failed).toBe(1);
    expect(persisted(f).refreshFailureCount).toBeUndefined();
    expect(persisted(f).refreshRetryAt).toBeUndefined();
    expect(persisted(f).rateLimitResetTime).toBe(0);
    expect(persisted(f).isHealthy).toBe(true);
    let sdkCalls = 0;
    const app = createApp(
      ConfigSchema.parse({ api_keys: ["synthetic-local-key"], protocol_projection_mode: "safe" }),
      {
        accountManager: f.manager,
        tokenRefresher: f.refresher,
        makeClient: () => ({
          async send() {
            sdkCalls++;
            return makeSdkResponse([{ assistantResponseEvent: { content: "SYNTHETIC_OK" } }]);
          },
        }),
      },
    );
    const response = await app(
      new Request("http://synthetic.invalid/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer synthetic-local-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-opus-5-5",
          max_tokens: 1024,
          stream: false,
          messages: [{ role: "user", content: "Synthetic audit only" }],
        }),
      }),
    );
    await response.arrayBuffer();
    expect(response.status).toBe(200);
    expect(sdkCalls).toBe(1);
    expect(refreshCalls).toBe(0);
  });
}

test("maintenance cancellation only detaches its caller; shared OAuth result still persists", async () => {
  const f = fixture();
  const mock = fakeRefresh("success");
  const controller = new AbortController();
  let usageCalls = 0;
  const service = new AccountMaintenanceService({
    enabled: true,
    intervalMs: 60_000,
    timeoutMs: 1000,
    concurrency: 1,
    tokenExpiryBufferMs: 300_000,
    accountManager: f.manager,
    tokenRefresher: f.refresher,
    usageRefresher: {
      async recheckDueAccounts() {
        usageCalls++;
      },
      async syncDueAccounts() {
        usageCalls++;
      },
    },
  });
  const running = service.runOnce(controller.signal).catch(() => undefined);
  await mock.started.promise;
  const joined = f.refresher.refreshIfNeeded(f.account, f.manager.toAuthDetails(f.account));
  controller.abort();
  await running;
  expect(persisted(f).refreshFailureCount).toBeUndefined();
  expect(persisted(f).refreshRetryAt).toBeUndefined();
  expect(persisted(f).rateLimitResetTime).toBe(0);
  expect(persisted(f).isHealthy).toBe(true);
  mock.release.resolve();
  await joined;
  expect(persisted(f).lastRefreshAt).toBeGreaterThan(0);
  expect(persisted(f).refreshFailureCount).toBeUndefined();
  expect(mock.calls()).toBe(1);
  expect(usageCalls).toBe(0);
});

for (const boundary of ["maintenance", "quota"] as const) {
  test(`${boundary} charges the same real refresh failure once`, async () => {
    const f = fixture();
    const mock = fakeRefresh("invalid_request");
    const usage = {
      async recheckDueAccounts() {},
      async syncDueAccounts() {},
    };
    const operation =
      boundary === "maintenance"
        ? new AccountMaintenanceService({
            enabled: true,
            intervalMs: 60_000,
            timeoutMs: 1000,
            concurrency: 1,
            tokenExpiryBufferMs: 300_000,
            accountManager: f.manager,
            tokenRefresher: f.refresher,
            usageRefresher: usage,
          }).runOnce()
        : new QuotaRechecker({
            accountManager: f.manager,
            tokenRefresher: f.refresher,
            intervalMs: 60_000,
            usageRefreshIntervalMs: 60_000,
            timeoutMs: 500,
            concurrency: 1,
            fetchUsage: async () => {
              throw new Error("Usage must not start after auth failure");
            },
          }).refreshAccounts([f.account], new AbortController().signal);
    await mock.started.promise;
    mock.release.resolve();
    await operation;
    const row = persisted(f);
    expect(row.refreshFailureCount).toBe(1);
    expect(row.refreshFailureCode).toBe("invalid_request");
    expect((row.refreshRetryAt ?? 0) - (row.refreshFailedAt ?? 0)).toBe(30_000);
    expect(row.rateLimitResetTime).toBe(0);
    expect(mock.calls()).toBe(1);
  });
}
