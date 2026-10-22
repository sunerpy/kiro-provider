import { afterEach, describe, expect, test } from "bun:test";
import { ConfigSchema } from "../src/config/schema.js";
import { AccountManager } from "../src/core/account-manager.js";
import { TokenRefresher } from "../src/core/token-refresher.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import { createApp } from "../src/server/app.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

const realFetch = globalThis.fetch;
const databases: AccountsDatabase[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const database of databases.splice(0)) database.close();
});

function fixture(backoff = false) {
  const database = new AccountsDatabase(":memory:");
  databases.push(database);
  const input: ManagedAccount = {
    id: "synthetic-native-refresh",
    email: "fixture@example.invalid",
    authMethod: "idc",
    region: "us-east-1",
    oidcRegion: "us-east-1",
    clientId: "synthetic-client",
    clientSecret: "synthetic-client-secret",
    profileArn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/synthetic",
    refreshToken: "synthetic-refresh",
    accessToken: "synthetic-access",
    expiresAt: Date.now() - 1,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 1,
    limitCount: 100,
    ...(backoff
      ? {
          refreshFailureCount: 1,
          refreshFailureCode: "invalid_request" as const,
          refreshFailedAt: Date.now(),
          refreshRetryAt: Date.now() + 60_000,
        }
      : {}),
  };
  const stored = database.insertAccount(input);
  const accountManager = new AccountManager([stored], "sticky", database);
  const tokenRefresher = new TokenRefresher(accountManager, 300_000);
  let refreshCalls = 0;
  let inferenceCalls = 0;
  globalThis.fetch = Object.assign(
    async (url: Parameters<typeof fetch>[0]) => {
      expect(String(url)).toBe("https://oidc.us-east-1.amazonaws.com/token");
      refreshCalls++;
      return Response.json(
        { error: "invalid_request", error_description: "synthetic rejected credentials" },
        { status: 400 },
      );
    },
    { preconnect: realFetch.preconnect },
  );
  const config = ConfigSchema.parse({
    api_keys: ["synthetic-native-key"],
    responses_native_tool_bridge: "off",
    protocol_projection_mode: "v3-auto",
    dynamic_model_catalog: false,
    account_maintenance_enabled: false,
    rate_limit_max_retries: 0,
    request_timeout_ms: 1_000,
    test_upstream_endpoint: "https://synthetic-runtime.example.invalid",
  });
  const app = createApp(config, {
    accountManager,
    tokenRefresher,
    nativeResponsesFetch: async () => {
      inferenceCalls++;
      throw new Error("Inference must not run after failed authentication");
    },
  });
  return {
    calls: () => ({ refreshCalls, inferenceCalls }),
    request: (stream: boolean, authenticated = true) =>
      app(
        new Request("http://gateway/v1/responses", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authenticated ? { Authorization: "Bearer synthetic-native-key" } : {}),
          },
          body: JSON.stringify({ model: "gpt-5.6-sol", input: "synthetic", stream }),
        }),
      ),
  };
}

describe("native Responses authentication refresh state", () => {
  for (const stream of [false, true]) {
    test(`reports refresh failure as 503 without dispatch or secret disclosure (stream=${stream})`, async () => {
      const run = fixture();
      const response = await run.request(stream);
      const text = await response.text();
      expect(response.status).toBe(503);
      expect(JSON.parse(text).error.code).toBe("upstream_token_refresh_failed");
      expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
      expect(run.calls()).toEqual({ refreshCalls: 1, inferenceCalls: 0 });
      expect(text).not.toContain("synthetic rejected credentials");
      expect(text).not.toContain("synthetic-client-secret");
    });

    test(`persisted auth backoff does not masquerade as a rate limit (stream=${stream})`, async () => {
      const run = fixture(true);
      const response = await run.request(stream);
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("upstream_token_refresh_failed");
      expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
      expect(run.calls()).toEqual({ refreshCalls: 0, inferenceCalls: 0 });
    });
  }

  test("authentication still rejects before refresh and native dispatch", async () => {
    const run = fixture();
    const response = await run.request(false, false);
    expect(response.status).toBe(401);
    expect(run.calls()).toEqual({ refreshCalls: 0, inferenceCalls: 0 });
  });
});
