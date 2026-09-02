import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountManager } from "../src/core/account-manager.js";
import { TokenRefresher } from "../src/core/token-refresher.js";
import { KiroTokenRefreshError } from "../src/kiro/errors.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

const realFetch = globalThis.fetch;
const databases: AccountsDatabase[] = [];
const temporaryDirectories: string[] = [];

function installFetch(
  handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): void {
  globalThis.fetch = Object.assign(handler, { preconnect: realFetch.preconnect });
}

function createFixture(overrides: Partial<ManagedAccount> = {}): {
  readonly database: AccountsDatabase;
  readonly databasePath: string;
  readonly manager: AccountManager;
  readonly account: ReturnType<AccountsDatabase["insertAccount"]>;
  readonly auth: KiroAuthDetails;
} {
  const directory = mkdtempSync(join(tmpdir(), "kiro-provider-refresher-"));
  const databasePath = join(directory, "accounts.db");
  const database = new AccountsDatabase(databasePath);
  const account = database.insertAccount(managedAccount(overrides));
  const manager = new AccountManager([account], "sticky", database);
  databases.push(database);
  temporaryDirectories.push(directory);
  return { database, databasePath, manager, account, auth: manager.toAuthDetails(account) };
}

function managedAccount(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: "account-A",
    email: "account-a@example.com",
    authMethod: "desktop",
    region: "us-east-1",
    refreshToken: "old-refresh",
    accessToken: "old-access",
    expiresAt: Date.now() - 1,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    ...overrides,
  };
}

function refreshResponse(): Response {
  return new Response(
    JSON.stringify({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresIn: 3600,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function refreshResponseWith(accessToken: string, refreshToken: string): Response {
  return new Response(JSON.stringify({ accessToken, refreshToken, expiresIn: 3600 }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  if (!resolvePromise) throw new Error("Deferred resolver was not initialized");
  return { promise, resolve: resolvePromise };
}

async function waitFor(
  condition: () => boolean,
  message: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(1);
  }
}

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const database of databases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("TokenRefresher", () => {
  test("returns an unexpired account without a network refresh", async () => {
    // Given
    const fixture = createFixture({ expiresAt: Date.now() + 600_000 });
    const refresher = new TokenRefresher(fixture.manager, 300_000);
    let fetchCalls = 0;
    installFetch(async () => {
      fetchCalls += 1;
      return refreshResponse();
    });

    // When
    const result = await refresher.refreshIfNeeded(fixture.account, fixture.auth);

    // Then
    expect(result.accessToken).toBe("old-access");
    expect(fetchCalls).toBe(0);
  });

  test("re-reads the latest row instead of trusting a stale caller snapshot", async () => {
    // Given
    const fixture = createFixture();
    const externalDatabase = new AccountsDatabase(fixture.databasePath);
    databases.push(externalDatabase);
    const refresher = new TokenRefresher(fixture.manager, 300_000);
    let fetchCalls = 0;
    installFetch(async () => {
      fetchCalls += 1;
      return refreshResponse();
    });
    externalDatabase.updateExistingAccounts([
      { ...fixture.account, accessToken: "externally-refreshed", expiresAt: Date.now() + 600_000 },
    ]);

    // When: the caller still holds the expired snapshot
    const result = await refresher.refreshIfNeeded(fixture.account, fixture.auth);

    // Then
    expect(result.accessToken).toBe("externally-refreshed");
    expect(fetchCalls).toBe(0);
  });

  test("refreshes an expired token and persists it through CAS", async () => {
    // Given
    const fixture = createFixture();
    const refresher = new TokenRefresher(fixture.manager, 300_000);
    installFetch(async () => refreshResponse());

    // When
    const result = await refresher.refreshIfNeeded(fixture.account, fixture.auth);

    // Then
    expect(result.accessToken).toBe("new-access");
    expect(result.refreshToken).toBe("new-refresh");
    expect(fixture.database.getById(fixture.account.id)?.accessToken).toBe("new-access");
    expect(fixture.database.getById(fixture.account.id)?.generation).toBe(
      fixture.account.generation + 1,
    );
  });

  test.each([
    { label: "configured", proxyUrl: "http://p:1080", expectedProxyUrl: "http://p:1080" },
    { label: "disabled", proxyUrl: undefined, expectedProxyUrl: undefined },
  ])("passes the $label proxy URL to token refresh", async ({ proxyUrl, expectedProxyUrl }) => {
    // Given
    const fixture = createFixture();
    const refresher = new TokenRefresher(fixture.manager, 300_000, proxyUrl);
    let capturedProxyUrl: string | undefined;
    installFetch(async (_input, init) => {
      capturedProxyUrl =
        init !== undefined && "proxy" in init && typeof init.proxy === "string"
          ? init.proxy
          : undefined;
      return refreshResponse();
    });

    // When
    await refresher.refreshIfNeeded(fixture.account, fixture.auth);

    // Then
    expect(capturedProxyUrl).toBe(expectedProxyUrl);
  });

  test("deduplicates two concurrent refreshIfNeeded calls for the same account", async () => {
    // Given
    const fixture = createFixture();
    const refresher = new TokenRefresher(fixture.manager, 300_000);
    const started = deferred();
    const release = deferred();
    let fetchCalls = 0;
    installFetch(async () => {
      fetchCalls += 1;
      started.resolve();
      await release.promise;
      return refreshResponse();
    });

    // When
    const first = refresher.refreshIfNeeded(fixture.account, fixture.auth);
    await started.promise;
    const second = refresher.refreshIfNeeded(fixture.account, fixture.auth);
    expect(fetchCalls).toBe(1);
    release.resolve();
    const results = await Promise.all([first, second]);

    // Then
    expect(fetchCalls).toBe(1);
    expect(results.map(({ accessToken }) => accessToken)).toEqual(["new-access", "new-access"]);
    expect(fixture.database.getById(fixture.account.id)?.generation).toBe(
      fixture.account.generation + 1,
    );
  });

  test("persists a refresh after a benign same-login generation bump", async () => {
    // Given
    const fixture = createFixture();
    const concurrentDatabase = new AccountsDatabase(fixture.databasePath);
    databases.push(concurrentDatabase);
    const refresher = new TokenRefresher(fixture.manager, 300_000);
    const started = deferred();
    const release = deferred();
    installFetch(async () => {
      started.resolve();
      await release.promise;
      return refreshResponseWith("refreshed-access", "rotated-refresh");
    });
    const refresh = refresher.refreshIfNeeded(fixture.account, fixture.auth);
    await started.promise;
    const current = concurrentDatabase.getById(fixture.account.id);
    expect(current).toBeDefined();
    if (!current) return;
    expect(
      concurrentDatabase.updateExistingAccounts([
        { ...current, usedCount: (current.usedCount ?? 0) + 1, lastUsed: 42 },
      ]),
    ).toBe(1);

    // When
    release.resolve();
    const refreshed = await refresh;

    // Then
    expect(refreshed.accessToken).toBe("refreshed-access");
    expect(refreshed.refreshToken).toBe("rotated-refresh");
    expect(refreshed.usedCount).toBe(1);
    expect(refreshed.lastUsed).toBe(42);
    expect(concurrentDatabase.getById(fixture.account.id)).toMatchObject({
      accessToken: "refreshed-access",
      refreshToken: "rotated-refresh",
      usedCount: 1,
      lastUsed: 42,
    });
  });

  test("adopts the relogged row instead of persisting a stale refresh after same-id relogin", async () => {
    // Given
    const fixture = createFixture();
    const externalDatabase = new AccountsDatabase(fixture.databasePath);
    databases.push(externalDatabase);
    const refresher = new TokenRefresher(fixture.manager, 300_000);
    const started = deferred();
    const release = deferred();
    installFetch(async () => {
      started.resolve();
      await release.promise;
      return refreshResponseWith("stale-rotated-access", "stale-rotated-refresh");
    });
    const staleRefresh = refresher.refreshIfNeeded(fixture.account, fixture.auth);
    await started.promise;
    externalDatabase.removeAccount(fixture.account.id);
    const relogged = externalDatabase.insertAccount(
      managedAccount({
        refreshToken: "fresh-login-refresh",
        accessToken: "fresh-login-access",
        expiresAt: Date.now() + 3_600_000,
      }),
    );

    // When
    release.resolve();
    const adopted = await staleRefresh;

    // Then: the stale rotation is never persisted over the fresh login
    expect(adopted).toEqual(relogged);
    expect(fixture.database.getById(fixture.account.id)).toEqual(relogged);
  });

  test("deduplicates concurrent refreshes across different generations of the same account", async () => {
    // Given
    const fixture = createFixture();
    const refresher = new TokenRefresher(fixture.manager, 300_000);
    const firstStarted = deferred();
    const releaseFirst = deferred();
    let fetchCalls = 0;
    installFetch(async () => {
      fetchCalls += 1;
      firstStarted.resolve();
      await releaseFirst.promise;
      return refreshResponseWith("shared-access", "shared-refresh");
    });
    const first = refresher.forceRefresh(fixture.account);
    await firstStarted.promise;
    const generationTwo = { ...fixture.account, generation: fixture.account.generation + 1 };

    // When
    const second = refresher.forceRefresh(generationTwo);
    releaseFirst.resolve();
    const results = await Promise.all([first, second]);

    // Then
    expect(fetchCalls).toBe(1);
    expect(results.map(({ accessToken }) => accessToken)).toEqual([
      "shared-access",
      "shared-access",
    ]);
    expect(fixture.database.getById(fixture.account.id)?.refreshToken).toBe("shared-refresh");
  });

  test("skips the network when a stale snapshot is force-refreshed after another writer rotated", async () => {
    // Given
    const fixture = createFixture();
    const externalDatabase = new AccountsDatabase(fixture.databasePath);
    databases.push(externalDatabase);
    const refresher = new TokenRefresher(fixture.manager, 300_000);
    let fetchCalls = 0;
    installFetch(async () => {
      fetchCalls += 1;
      return refreshResponse();
    });
    externalDatabase.updateExistingAccounts([
      {
        ...fixture.account,
        refreshToken: "rotated-refresh",
        accessToken: "rotated-access",
        expiresAt: Date.now() + 600_000,
      },
    ]);

    // When
    const result = await refresher.forceRefresh(fixture.account);

    // Then
    expect(fetchCalls).toBe(0);
    expect(result).toMatchObject({
      refreshToken: "rotated-refresh",
      accessToken: "rotated-access",
    });
  });

  test("adopts a concurrent rotation instead of throwing when the refresh token changed mid-flight", async () => {
    // Given
    const fixture = createFixture();
    const externalDatabase = new AccountsDatabase(fixture.databasePath);
    databases.push(externalDatabase);
    const refresher = new TokenRefresher(fixture.manager, 300_000);
    const started = deferred();
    const release = deferred();
    installFetch(async () => {
      started.resolve();
      await release.promise;
      return refreshResponseWith("late-access", "late-refresh");
    });
    const refresh = refresher.refreshIfNeeded(fixture.account, fixture.auth);
    await started.promise;
    externalDatabase.updateExistingAccounts([
      {
        ...fixture.account,
        refreshToken: "winner-refresh",
        accessToken: "winner-access",
        expiresAt: Date.now() + 600_000,
      },
    ]);

    // When
    release.resolve();
    const result = await refresh;

    // Then: no AccountUnavailableError, and the later rotation wins
    expect(result).toMatchObject({ refreshToken: "winner-refresh", accessToken: "winner-access" });
    expect(fixture.database.getById(fixture.account.id)).toMatchObject({
      refreshToken: "winner-refresh",
      accessToken: "winner-access",
    });
  });

  test("does not thread the caller AbortSignal into the shared refresh; abort only detaches the caller", async () => {
    // Given
    const fixture = createFixture();
    const refresher = new TokenRefresher(fixture.manager, 300_000);
    const controller = new AbortController();
    let capturedSignal: AbortSignal | null | undefined;
    installFetch(async (_input, init) => {
      capturedSignal = init?.signal;
      controller.abort();
      await Bun.sleep(1);
      return refreshResponse();
    });

    // When / Then
    await expect(refresher.forceRefresh(fixture.account, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal).not.toBe(controller.signal);
    await waitFor(
      () => fixture.database.getById(fixture.account.id)?.accessToken === "new-access",
      "shared refresh should still persist after the caller detached",
    );
  });

  test("a joiner still receives the refreshed account after the first caller aborts", async () => {
    // Given
    const fixture = createFixture();
    const refresher = new TokenRefresher(fixture.manager, 300_000);
    const firstController = new AbortController();
    const started = deferred();
    const release = deferred();
    let fetchCalls = 0;
    installFetch(async () => {
      fetchCalls += 1;
      started.resolve();
      await release.promise;
      return refreshResponse();
    });
    const first = refresher.refreshIfNeeded(fixture.account, fixture.auth, firstController.signal);
    await started.promise;
    const joiner = refresher.refreshIfNeeded(
      fixture.account,
      fixture.auth,
      new AbortController().signal,
    );

    // When
    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    release.resolve();
    const joined = await joiner;

    // Then
    expect(fetchCalls).toBe(1);
    expect(joined.accessToken).toBe("new-access");
  });

  test("marks the account unhealthy and rethrows when the refresh token is dead", async () => {
    // Given
    const fixture = createFixture();
    const refresher = new TokenRefresher(fixture.manager, 300_000);
    installFetch(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant", error_description: "revoked" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    );

    // When / Then
    await expect(refresher.refreshIfNeeded(fixture.account, fixture.auth)).rejects.toBeInstanceOf(
      KiroTokenRefreshError,
    );
    expect(fixture.database.getById(fixture.account.id)).toMatchObject({
      isHealthy: false,
      failCount: 10,
      unhealthyReason: expect.stringContaining("invalid_grant"),
    });
  });

  test("leaves health untouched and rethrows on a transient refresh failure", async () => {
    // Given
    const fixture = createFixture();
    const refresher = new TokenRefresher(fixture.manager, 300_000);
    installFetch(async () => {
      throw new TypeError("fetch failed");
    });

    // When / Then
    await expect(refresher.refreshIfNeeded(fixture.account, fixture.auth)).rejects.toMatchObject({
      name: "KiroTokenRefreshError",
      code: "NETWORK_ERROR",
    });
    expect(fixture.database.getById(fixture.account.id)).toMatchObject({
      isHealthy: true,
      failCount: 0,
    });
  });

  test("a successful refresh heals health and persists the discovered email", async () => {
    // Given
    const fixture = createFixture({
      email: "",
      isHealthy: false,
      failCount: 10,
      unhealthyReason: "InvalidTokenException: stale marker",
      recoveryTime: Date.now() + 60_000,
    });
    const refresher = new TokenRefresher(fixture.manager, 300_000);
    installFetch(
      async () =>
        new Response(
          JSON.stringify({
            accessToken: "healed-access",
            refreshToken: "healed-refresh",
            expiresIn: 3600,
            userInfo: { email: "discovered@example.com" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    // When
    const result = await refresher.refreshIfNeeded(
      fixture.account,
      fixture.manager.toAuthDetails(fixture.account),
    );

    // Then
    expect(result).toMatchObject({
      accessToken: "healed-access",
      email: "discovered@example.com",
      isHealthy: true,
      failCount: 0,
      unhealthyReason: undefined,
      recoveryTime: undefined,
    });
    expect(fixture.database.getById(fixture.account.id)).toMatchObject({
      isHealthy: true,
      failCount: 0,
      email: "discovered@example.com",
    });
  });
});
