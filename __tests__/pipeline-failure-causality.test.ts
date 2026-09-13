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
