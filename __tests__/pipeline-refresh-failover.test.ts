import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config/schema.js";
import { AccountManager } from "../src/core/account-manager.js";
import { type PipelineSdkClient, runChatCompletion } from "../src/core/pipeline.js";
import { TokenRefresher } from "../src/core/token-refresher.js";
import type {
  SdkStreamEvent,
  SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";
import { canonicalRequest, message } from "./canonical-test-helpers.js";

/**
 * End-to-end coverage for A2/A3/A4 with the REAL TokenRefresher and
 * AccountManager on a temporary SQLite database: the OIDC endpoint is mocked
 * through globalThis.fetch and the upstream SDK client is a stub.
 */

const realFetch = globalThis.fetch;
const databases: AccountsDatabase[] = [];
const directories: string[] = [];

function installFetch(
  handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): void {
  globalThis.fetch = Object.assign(handler, { preconnect: realFetch.preconnect });
}

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function account(id: string, overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    authMethod: "desktop",
    region: "us-east-1",
    refreshToken: `${id}-refresh`,
    accessToken: `${id}-access`,
    expiresAt: Date.now() - 1,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    ...overrides,
  };
}

function fixture(accounts: readonly ManagedAccount[]): {
  readonly database: AccountsDatabase;
  readonly manager: AccountManager;
  readonly refresher: TokenRefresher;
} {
  const directory = mkdtempSync(join(tmpdir(), "kiro-provider-failover-"));
  directories.push(directory);
  const database = new AccountsDatabase(join(directory, "accounts.db"));
  databases.push(database);
  const stored = accounts.map((candidate) => database.insertAccount(candidate));
  const manager = new AccountManager(stored, "sticky", database);
  return { database, manager, refresher: new TokenRefresher(manager, 300_000) };
}

function refreshTokenOf(init: RequestInit | undefined): string {
  const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  if (typeof body !== "object" || body === null || !("refreshToken" in body)) {
    throw new TypeError("refresh request must carry a refreshToken");
  }
  return String(body.refreshToken);
}

function okRefresh(accessToken: string): Response {
  return new Response(
    JSON.stringify({ accessToken, refreshToken: `${accessToken}-refresh`, expiresIn: 3600 }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function invalidGrant(): Response {
  return new Response(
    JSON.stringify({ error: "invalid_grant", error_description: "refresh token revoked" }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
}

function responseFrom(events: readonly SdkStreamEvent[]): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
        for (const event of events) yield event;
        yield {
          metadataEvent: { tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        };
      },
    },
  };
}

function config() {
  return ConfigSchema.parse({
    api_keys: ["sk-test"],
    request_timeout_ms: 5_000,
    stream_idle_timeout_ms: 1_000,
    rate_limit_retry_delay_ms: 1,
  });
}

describe("pipeline refresh failover with the real TokenRefresher", () => {
  test("account A invalid_grant + account B healthy: request succeeds and A is marked dead", async () => {
    // Given
    const { database, manager, refresher } = fixture([account("account-a"), account("account-b")]);
    const refreshed: string[] = [];
    installFetch(async (_input, init) => {
      const token = refreshTokenOf(init);
      refreshed.push(token);
      if (token === "account-a-refresh") return invalidGrant();
      return okRefresh("b-fresh");
    });
    const sentTokens: string[] = [];
    const makeClient = (auth: { access: string }): PipelineSdkClient => ({
      async send() {
        sentTokens.push(auth.access);
        return responseFrom([{ assistantResponseEvent: { content: "from B" } }]);
      },
    });

    // When
    const response = await runChatCompletion({
      body: canonicalRequest([message("user", "hello")], { model: "auto" }),
      model: "auto",
      stream: false,
      config: config(),
      accountManager: manager,
      tokenRefresher: refresher,
      makeClient,
    });

    // Then
    expect(response.status).toBe(200);
    expect(sentTokens).toEqual(["b-fresh"]);
    expect(refreshed).toEqual(["account-a-refresh", "account-b-refresh"]);
    expect(database.getById("account-a")).toMatchObject({
      isHealthy: false,
      failCount: 10,
      unhealthyReason: expect.stringContaining("invalid_grant"),
    });
    expect(database.getById("account-b")).toMatchObject({
      isHealthy: true,
      accessToken: "b-fresh",
    });
  });

  test("account A network error: request succeeds on B and A is only cooled down", async () => {
    // Given
    const { database, manager, refresher } = fixture([account("account-a"), account("account-b")]);
    installFetch(async (_input, init) => {
      if (refreshTokenOf(init) === "account-a-refresh") throw new TypeError("fetch failed");
      return okRefresh("b-fresh");
    });
    const sentTokens: string[] = [];
    const makeClient = (auth: { access: string }): PipelineSdkClient => ({
      async send() {
        sentTokens.push(auth.access);
        return responseFrom([{ assistantResponseEvent: { content: "from B" } }]);
      },
    });

    // When
    const response = await runChatCompletion({
      body: canonicalRequest([message("user", "hello")], { model: "auto" }),
      model: "auto",
      stream: false,
      config: config(),
      accountManager: manager,
      tokenRefresher: refresher,
      makeClient,
    });

    // Then
    expect(response.status).toBe(200);
    expect(sentTokens).toEqual(["b-fresh"]);
    const cooled = database.getById("account-a");
    expect(cooled).toMatchObject({ isHealthy: true, failCount: 0 });
    expect(cooled?.rateLimitResetTime ?? 0).toBeGreaterThan(0);
  });

  test("concurrent requests holding different generations share one network refresh", async () => {
    // Given
    const { manager, refresher } = fixture([account("account-a")]);
    let fetchCalls = 0;
    installFetch(async () => {
      fetchCalls += 1;
      await Bun.sleep(5);
      return okRefresh("shared");
    });
    const makeClient = (): PipelineSdkClient => ({
      async send() {
        return responseFrom([{ assistantResponseEvent: { content: "ok" } }]);
      },
    });
    const run = () =>
      runChatCompletion({
        body: canonicalRequest([message("user", "hello")], { model: "auto" }),
        model: "auto",
        stream: false,
        config: config(),
        accountManager: manager,
        tokenRefresher: refresher,
        makeClient,
      });

    // When
    const responses = await Promise.all([run(), run(), run()]);

    // Then
    expect(responses.map(({ status }) => status)).toEqual([200, 200, 200]);
    expect(fetchCalls).toBe(1);
  });
});
