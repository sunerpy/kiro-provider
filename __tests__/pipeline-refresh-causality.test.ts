import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import { AccountManager } from "../src/core/account-manager.js";
import { runChatCompletion } from "../src/core/pipeline.js";
import { TokenRefresher } from "../src/core/token-refresher.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import { type AppDependencies, createApp } from "../src/server/app.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";
import { canonicalRequest, message } from "./canonical-test-helpers.js";

const FIXTURE_KEY = "sk-refresh-causality-fixture";
const realFetch = globalThis.fetch;
const fixtures: Array<{ directory: string; database: AccountsDatabase }> = [];
type Protocol = "messages" | "responses";
type ErrorBody = { error: { type: string; message: string; code?: string } };

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const { directory, database } of fixtures.splice(0)) {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function account(id: string, overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id,
    email: `${id}@example.invalid`,
    authMethod: "idc",
    region: "us-east-1",
    oidcRegion: "us-east-1",
    clientId: "synthetic-client",
    clientSecret: "synthetic-client-secret",
    refreshToken: "synthetic-refresh",
    accessToken: "synthetic-access",
    expiresAt: Date.now() - 1,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 10,
    limitCount: 100,
    overageCount: 0,
    lastSync: Date.now(),
    ...overrides,
  };
}

function fixture(
  accounts: readonly ManagedAccount[],
  options: {
    config?: Partial<Config>;
    dependencies?: Partial<AppDependencies>;
    refresh?: (database: AccountsDatabase, init?: RequestInit) => Response | Promise<Response>;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "kiro-refresh-causality-"));
  const database = new AccountsDatabase(join(directory, "accounts.db"));
  fixtures.push({ directory, database });
  const stored = accounts.map((candidate) => database.insertAccount(candidate));
  const manager = new AccountManager(stored, "lowest-usage", database);
  const refresher = new TokenRefresher(manager, 300_000);
  const config = ConfigSchema.parse({
    api_keys: [FIXTURE_KEY],
    protocol_projection_mode: "safe",
    dynamic_model_catalog: false,
    account_maintenance_enabled: false,
    request_timeout_ms: 1_000,
    rate_limit_retry_delay_ms: 1,
    rate_limit_max_retries: 0,
    ...options.config,
  });
  const counts = { refreshes: 0, sends: 0, unexpectedNetwork: 0 };
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input) !== "https://oidc.us-east-1.amazonaws.com/token") {
        counts.unexpectedNetwork++;
        throw new Error("Unexpected network blocked by synthetic fixture");
      }
      counts.refreshes++;
      expect(JSON.parse(String(init?.body))).toMatchObject({ grantType: "refresh_token" });
      return (
        options.refresh?.(database, init) ??
        Response.json(
          { error: "invalid_request", error_description: "synthetic refresh rejection" },
          { status: 400 },
        )
      );
    },
    { preconnect: realFetch.preconnect },
  ) as typeof fetch;
  const app = createApp(config, {
    accountManager: manager,
    tokenRefresher: refresher,
    makeClient: () => ({
      async send() {
        counts.sends++;
        return {
          generateAssistantResponseResponse: (async function* () {
            yield { assistantResponseEvent: { content: "FRESH_LOGIN_OK" } };
            yield {
              metadataEvent: { tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
            };
          })(),
        };
      },
    }),
    ...options.dependencies,
  });
  const request = (
    protocol: Protocol,
    stream: boolean,
    init: { authenticated?: boolean; signal?: AbortSignal } = {},
  ) =>
    app(
      new Request(`http://fixture/v1/${protocol}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(init.authenticated === false ? {} : { "x-api-key": FIXTURE_KEY }),
        },
        body: JSON.stringify(
          protocol === "messages"
            ? {
                model: "claude-sonnet-5",
                max_tokens: 1024,
                stream,
                messages: [{ role: "user", content: "synthetic" }],
              }
            : { model: "claude-sonnet-5", store: false, stream, input: "synthetic" },
        ),
        ...(init.signal ? { signal: init.signal } : {}),
      }),
    );
  return { request, counts, database, manager, refresher, config };
}

async function expectRefreshFailure(response: Response, protocol: Protocol): Promise<void> {
  expect(response.status).toBe(503);
  const body = (await response.json()) as ErrorBody;
  expect(body.error).toMatchObject({
    type: protocol === "messages" ? "overloaded_error" : "service_unavailable",
    message: expect.stringContaining("Token refresh failed for every usable Kiro account"),
  });
  if (protocol === "responses") expect(body.error.code).toBe("upstream_token_refresh_failed");
}

describe("refresh failure causality at authenticated protocol ingress", () => {
  for (const protocol of ["messages", "responses"] as const) {
    for (const stream of [false, true]) {
      for (const spent of [false, true]) {
        test(`${protocol} preserves refresh failure with unrelated exhausted rows (stream=${stream}, spent=${spent})`, async () => {
          const accounts = [account("usable")];
          if (spent) accounts.push(account("spent", { usedCount: 100 }));
          const { request, counts, database } = fixture(accounts);
          const response = await request(protocol, stream);
          await expectRefreshFailure(response, protocol);
          expect(counts).toEqual({ refreshes: 1, sends: 0, unexpectedNetwork: 0 });
          const failed = database.getById("usable");
          expect(failed?.rateLimitResetTime).toBe(0);
          expect(failed?.refreshFailureCode).toBe("invalid_request");
          expect(failed?.refreshFailureCount).toBe(1);
          expect(failed?.refreshRetryAt).toBeGreaterThan(Date.now());
          const retry = await request(protocol, stream);
          expect(Number(retry.headers.get("Retry-After"))).toBeGreaterThan(0);
          await expectRefreshFailure(retry, protocol);
          expect(counts).toEqual({ refreshes: 1, sends: 0, unexpectedNetwork: 0 });
          expect(database.getById("usable")?.refreshFailureCount).toBe(1);
        });
      }

      test(`${protocol} reports persisted auth backoff without another refresh or rate-limit wait (stream=${stream})`, async () => {
        const retryAt = Date.now() + 60_000;
        const { request, counts } = fixture([
          account("backoff", {
            refreshFailureCode: "invalid_request",
            refreshFailureCount: 2,
            refreshFailedAt: Date.now(),
            refreshRetryAt: retryAt,
          }),
          account("spent", { usedCount: 100 }),
        ]);
        const response = await request(protocol, stream);
        expect(Number(response.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
        await expectRefreshFailure(response, protocol);
        expect(counts).toEqual({ refreshes: 0, sends: 0, unexpectedNetwork: 0 });
      });
    }

    test(`${protocol} authenticates before refreshing or sending`, async () => {
      const { request, counts } = fixture([account("usable")]);
      const response = await request(protocol, false, { authenticated: false });
      expect(response.status).toBe(401);
      expect(counts).toEqual({ refreshes: 0, sends: 0, unexpectedNetwork: 0 });
    });

    test(`${protocol} preserves the included quota gate when no usable credentials failed`, async () => {
      const { request, counts } = fixture([account("spent", { usedCount: 100 })]);
      const response = await request(protocol, false);
      expect(response.status).toBe(protocol === "messages" ? 429 : 402);
      const body = (await response.json()) as ErrorBody;
      if (protocol === "messages") {
        expect(body.error.type).toBe("rate_limit_error");
        expect(body.error.message).toContain("quota_exhausted");
      } else expect(body.error.code).toBe("quota_exhausted");
      expect(counts).toEqual({ refreshes: 0, sends: 0, unexpectedNetwork: 0 });
    });

    test(`${protocol} preserves a paid-overage-only rejection`, async () => {
      const { request, counts } = fixture([account("overage", { overageCount: 2 })]);
      const response = await request(protocol, false);
      expect(response.status).toBe(protocol === "messages" ? 429 : 402);
      const body = (await response.json()) as ErrorBody;
      if (protocol === "messages") expect(body.error.message).toContain("paid_overage_blocked");
      else expect(body.error.code).toBe("paid_overage_blocked");
      expect(counts).toEqual({ refreshes: 0, sends: 0, unexpectedNetwork: 0 });
    });

    test(`${protocol} does not replace model ineligibility with another account's auth backoff`, async () => {
      const { request, counts } = fixture(
        [account("backoff", { refreshRetryAt: Date.now() + 60_000 })],
        {
          dependencies: {
            modelCapabilities: {
              eligibleAccountIds: () => new Set(),
              isKnownModel: () => true,
              ensureAccountModel: async () => ({ supported: false, source: "static" }),
              catalog: () => [],
              readiness: () => ({
                enabled: true,
                usable: true,
                source: "static",
                freshAccounts: 0,
                staleAccounts: 0,
              }),
              refreshAccounts: async () => {},
            },
          },
        },
      );
      const response = await request(protocol, false);
      expect(response.status).toBe(503);
      const body = (await response.json()) as ErrorBody;
      expect(body.error.message).toContain("not available");
      if (protocol === "responses") expect(body.error.code).toBe("model_unavailable_for_accounts");
      expect(counts).toEqual({ refreshes: 0, sends: 0, unexpectedNetwork: 0 });
    });

    for (const stream of [false, true]) {
      test(`${protocol} adopts a verified same-owner re-login rather than poisoning fresh credentials (stream=${stream})`, async () => {
        const fresh = account("usable", {
          accessToken: "synthetic-fresh-access",
          refreshToken: "synthetic-fresh-refresh",
          clientId: "synthetic-new-client",
          clientSecret: "synthetic-new-client-secret",
          expiresAt: Date.now() + 3_600_000,
        });
        const { request, counts, database } = fixture([account("usable")], {
          refresh(database) {
            database.insertAccount(fresh);
            return Response.json({ error: "invalid_request" }, { status: 400 });
          },
        });
        const response = await request(protocol, stream);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("FRESH_LOGIN_OK");
        const current = database.getById("usable");
        expect(current).toMatchObject({
          accessToken: fresh.accessToken,
          refreshToken: fresh.refreshToken,
          clientId: fresh.clientId,
          clientSecret: fresh.clientSecret,
          isHealthy: true,
          rateLimitResetTime: 0,
        });
        expect(current?.refreshFailureCount ?? 0).toBe(0);
        expect(current?.refreshRetryAt ?? 0).toBe(0);
        expect(counts).toEqual({ refreshes: 1, sends: 1, unexpectedNetwork: 0 });
      });
    }

    test(`${protocol} detaches a cancelled request while the shared refresh finishes without false cooldown`, async () => {
      let started!: () => void;
      const refreshStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      let settle!: (response: Response) => void;
      const refreshResponse = new Promise<Response>((resolve) => {
        settle = resolve;
      });
      let refreshSignal: AbortSignal | null | undefined;
      const { request, counts, database } = fixture([account("usable")], {
        refresh(_database, init) {
          refreshSignal = init?.signal;
          started();
          return refreshResponse;
        },
        config: { max_inflight_requests: 1 },
      });
      const controller = new AbortController();
      const pending = request(protocol, false, { signal: controller.signal });
      await refreshStarted;
      controller.abort();
      const cancelled = await pending;
      expect(cancelled.status).toBe(499);
      await cancelled.text();
      expect(refreshSignal?.aborted).toBe(false);
      expect(counts.sends).toBe(0);
      settle(
        Response.json({
          accessToken: "synthetic-refreshed-access",
          refreshToken: "synthetic-refreshed-refresh",
          expiresIn: 3_600,
        }),
      );
      for (let attempt = 0; attempt < 100; attempt++) {
        if (database.getById("usable")?.accessToken === "synthetic-refreshed-access") break;
        await Bun.sleep(1);
      }
      const current = database.getById("usable");
      expect(current?.accessToken).toBe("synthetic-refreshed-access");
      expect(current?.refreshFailureCount ?? 0).toBe(0);
      expect(current?.refreshRetryAt ?? 0).toBe(0);
      expect(current?.rateLimitResetTime).toBe(0);
      // Reusing the same app also proves the cancelled admission lease was released.
      const recovered = await request(protocol, false);
      expect(recovered.status).toBe(200);
      expect(await recovered.text()).toContain("FRESH_LOGIN_OK");
      expect(counts).toEqual({ refreshes: 1, sends: 1, unexpectedNetwork: 0 });
    });
  }

  test("an owner-bound replay in auth backoff keeps its typed failure and never migrates to a healthy peer", async () => {
    const { manager, refresher, config, counts } = fixture([
      account("owner", { refreshRetryAt: Date.now() + 60_000 }),
      account("peer", { expiresAt: Date.now() + 3_600_000 }),
    ]);
    const body = canonicalRequest(
      [message("assistant", "prior answer"), message("user", "continue")],
      {
        model: "claude-sonnet-5",
        reasoningReplays: [
          {
            lookup: { kind: "responses-token", encryptedContent: "kr1_synthetic" },
            outputFingerprint: "synthetic-fingerprint",
            insertBeforeMessage: 0,
            path: "input.0",
          },
        ],
      },
    );
    const response = await runChatCompletion({
      body,
      model: body.model,
      stream: false,
      config,
      accountManager: manager,
      tokenRefresher: refresher,
      tenantId: "synthetic-tenant",
      reasoningReplayStore: {
        readiness: () => ({ writable: true, keyringAvailable: true, missingKeyIds: [] }),
        store: () => undefined,
        resolveResponses: (_token, _context, insertBeforeMessage) => ({
          accountId: "owner",
          conversationId: "synthetic-owner-conversation",
          replay: {
            insertBeforeMessage,
            content: {
              kind: "reasoning_text",
              text: "synthetic",
              signature: "synthetic-signature",
            },
          },
        }),
        resolveChat() {
          throw new Error("Chat replay is not used by this fixture");
        },
      },
      makeClient: () => ({
        async send() {
          counts.sends++;
          throw new Error("Owner must not migrate");
        },
      }),
    });
    expect(response.status).toBe(503);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await response.json()).toMatchObject({
      error: { code: "reasoning_replay_account_refresh_failed" },
    });
    expect(counts).toEqual({ refreshes: 0, sends: 0, unexpectedNetwork: 0 });
  });
});
