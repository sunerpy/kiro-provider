import { expect, test } from "bun:test";
import { ConfigSchema } from "../src/config/schema.js";
import { runChatCompletion } from "../src/core/pipeline.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import { canonicalRequest, message } from "./canonical-test-helpers.js";

test("a request deadline retains the preceding SDK 503 and both request identities", async () => {
  const account: ManagedAccount = {
    id: "causality-account",
    email: "causality@example.invalid",
    authMethod: "desktop",
    region: "us-east-1",
    accessToken: "fixture-access-secret",
    refreshToken: "fixture-refresh-secret",
    expiresAt: Date.now() + 60_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
  };
  let sends = 0;
  const response = await runChatCompletion({
    requestId: "req_causality-fixture",
    model: "gpt-5.6-sol",
    stream: true,
    body: canonicalRequest([message("user", "Synthetic request")], { model: "gpt-5.6-sol" }),
    config: ConfigSchema.parse({
      api_keys: ["fixture-client-secret"],
      request_timeout_ms: 60,
      rate_limit_max_retries: 3,
    }),
    accountManager: {
      reconcileFromDb: () => [account],
      selectHealthyAccount: () => account,
      getAccountCount: () => 1,
      toAuthDetails: () => ({
        refresh: account.refreshToken,
        access: account.accessToken,
        expires: account.expiresAt,
        authMethod: account.authMethod,
        region: account.region,
      }),
      markRateLimited() {},
      markUnhealthy() {},
    },
    tokenRefresher: {
      refreshIfNeeded: async () => account,
      forceRefresh: async () => account,
    },
    makeClient: () => ({
      async send() {
        sends += 1;
        throw Object.assign(new Error("Upstream unavailable; token=fixture-access-secret"), {
          name: "ServiceUnavailableException",
          $metadata: { httpStatusCode: 503, requestId: "upstream-causality-fixture" },
        });
      },
    }),
  });
  expect(response.status).toBe(504);
  const text = await response.text();
  const body = JSON.parse(text);
  expect(body.error.request_id).toBe("req_causality-fixture");
  expect(body.error.details.first_failure).toMatchObject({
    upstream_status: 503,
    upstream_code: "ServiceUnavailableException",
    upstream_request_id: "upstream-causality-fixture",
  });
  expect(body.error.details.last_failure).toMatchObject({
    upstream_status: 503,
    upstream_request_id: "upstream-causality-fixture",
  });
  expect(body.error.details.cancel_source).toBe("request_deadline");
  expect(body.error.message).toContain("earlier upstream failure HTTP 503");
  expect(body.error.message).toContain("upstream-causality-fixture");
  expect(text).not.toContain("fixture-access-secret");
  expect(text).not.toContain("fixture-client-secret");
  expect(sends).toBe(1);
});

test("an SDK failure cannot trigger a second inference after the upstream dispatch budget is spent", async () => {
  const account: ManagedAccount = {
    id: "single-dispatch-account",
    email: "single-dispatch@example.invalid",
    authMethod: "desktop",
    region: "us-east-1",
    accessToken: "fixture-access-secret",
    refreshToken: "fixture-refresh-secret",
    expiresAt: Date.now() + 60_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
  };
  let sends = 0;
  const response = await runChatCompletion({
    model: "auto",
    stream: false,
    body: canonicalRequest([message("user", "Synthetic request")], { model: "auto" }),
    config: ConfigSchema.parse({
      api_keys: ["fixture-client-secret"],
      request_timeout_ms: 5_000,
      rate_limit_retry_delay_ms: 1,
      rate_limit_max_retries: 3,
    }),
    accountManager: {
      reconcileFromDb: () => [account],
      selectHealthyAccount: () => account,
      getAccountCount: () => 1,
      toAuthDetails: () => ({
        refresh: account.refreshToken,
        access: account.accessToken,
        expires: account.expiresAt,
        authMethod: account.authMethod,
        region: account.region,
      }),
      markRateLimited() {},
      markUnhealthy() {},
    },
    tokenRefresher: {
      refreshIfNeeded: async () => account,
      forceRefresh: async () => account,
    },
    makeClient: () => ({
      async send() {
        sends += 1;
        throw Object.assign(new Error("upstream unavailable"), {
          name: "ServiceUnavailableException",
          $metadata: { httpStatusCode: 503 },
        });
      },
    }),
    maxUpstreamDispatches: 1,
  });

  expect(response.status).toBe(503);
  expect(sends).toBe(1);
});

test("credential rejection cannot force-refresh and redispatch after the upstream budget is spent", async () => {
  const account: ManagedAccount = {
    id: "single-dispatch-auth-account",
    email: "single-dispatch-auth@example.invalid",
    authMethod: "desktop",
    region: "us-east-1",
    accessToken: "fixture-access-secret",
    refreshToken: "fixture-refresh-secret",
    expiresAt: Date.now() + 60_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
  };
  let sends = 0;
  let forcedRefreshes = 0;
  const response = await runChatCompletion({
    model: "auto",
    stream: false,
    body: canonicalRequest([message("user", "Synthetic request")], { model: "auto" }),
    config: ConfigSchema.parse({
      api_keys: ["fixture-client-secret"],
      request_timeout_ms: 5_000,
      rate_limit_retry_delay_ms: 1,
      rate_limit_max_retries: 3,
    }),
    accountManager: {
      reconcileFromDb: () => [account],
      selectHealthyAccount: () => account,
      getAccountCount: () => 1,
      toAuthDetails: () => ({
        refresh: account.refreshToken,
        access: account.accessToken,
        expires: account.expiresAt,
        authMethod: account.authMethod,
        region: account.region,
      }),
      markRateLimited() {},
      markUnhealthy() {},
    },
    tokenRefresher: {
      refreshIfNeeded: async () => account,
      forceRefresh: async () => {
        forcedRefreshes += 1;
        return account;
      },
    },
    makeClient: () => ({
      async send() {
        sends += 1;
        throw Object.assign(new Error("access token rejected"), {
          name: "UnauthorizedException",
          $metadata: { httpStatusCode: 401 },
        });
      },
    }),
    maxUpstreamDispatches: 1,
  });

  expect(response.status).toBe(401);
  expect(sends).toBe(1);
  expect(forcedRefreshes).toBe(0);
});

test("rate limiting cannot switch accounts and redispatch after the upstream budget is spent", async () => {
  const accounts: ManagedAccount[] = ["a", "b"].map((suffix) => ({
    id: `single-dispatch-${suffix}`,
    email: `single-dispatch-${suffix}@example.invalid`,
    authMethod: "desktop",
    region: "us-east-1",
    accessToken: `fixture-access-${suffix}`,
    refreshToken: `fixture-refresh-${suffix}`,
    expiresAt: Date.now() + 60_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
  }));
  let sends = 0;
  const rateLimited: string[] = [];
  const response = await runChatCompletion({
    model: "auto",
    stream: false,
    body: canonicalRequest([message("user", "Synthetic request")], { model: "auto" }),
    config: ConfigSchema.parse({
      api_keys: ["fixture-client-secret"],
      request_timeout_ms: 5_000,
      rate_limit_retry_delay_ms: 1,
      rate_limit_max_retries: 3,
    }),
    accountManager: {
      reconcileFromDb: () => accounts,
      selectHealthyAccount: (_preferred, eligible) =>
        accounts.find((candidate) => eligible?.has(candidate.id) ?? true) ?? null,
      getAccountCount: () => accounts.length,
      toAuthDetails: (account) => ({
        refresh: account.refreshToken,
        access: account.accessToken,
        expires: account.expiresAt,
        authMethod: account.authMethod,
        region: account.region,
      }),
      markRateLimited(account) {
        rateLimited.push(account.id);
      },
      markUnhealthy() {},
    },
    tokenRefresher: {
      refreshIfNeeded: async (account) => account,
      forceRefresh: async (account) => account,
    },
    makeClient: () => ({
      async send() {
        sends += 1;
        throw Object.assign(new Error("rate limited"), {
          name: "ThrottlingException",
          $metadata: { httpStatusCode: 429 },
        });
      },
    }),
    maxUpstreamDispatches: 1,
  });

  expect(response.status).toBe(429);
  expect(sends).toBe(1);
  expect(rateLimited).toEqual(["single-dispatch-a"]);
});
