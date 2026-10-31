import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogin } from "../src/cli/login.js";
import { ConfigSchema } from "../src/config/schema.js";
import { KIRO_AUTH_SERVICE } from "../src/kiro/constants.js";
import { pollKiroIDCToken } from "../src/kiro/oauth-idc.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

const realFetch = globalThis.fetch;
let root: string | undefined;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

test("a complete Builder ID device login uses the CLI service profile and never calls the denied profile catalog", async () => {
  root = mkdtempSync(join(tmpdir(), "kiro-builder-login-"));
  const path = join(root, "accounts.db");
  const calls: URL[] = [];
  const responder = async (input: string | Request | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname === "/client/register") {
      return Response.json({ clientId: "builder-client", clientSecret: "builder-secret" });
    }
    if (url.pathname === "/device_authorization") {
      return Response.json({
        verificationUri: "https://synthetic.test/verify",
        verificationUriComplete: "https://synthetic.test/verify?code=builder",
        userCode: "builder",
        deviceCode: "builder-device",
        interval: 1,
        expiresIn: 10,
      });
    }
    if (url.pathname === "/token") {
      return Response.json({
        access_token: "builder-access",
        refresh_token: "builder-refresh",
        expires_in: 3600,
      });
    }
    if (url.pathname === "/List-Available-Profiles") {
      return new Response("AWS Builder ID is not supported for this operation", { status: 403 });
    }
    if (url.pathname === "/getUsageLimits") {
      expect(url.searchParams.get("profileArn")).toBe(KIRO_AUTH_SERVICE.BUILDER_ID_PROFILE_ARN);
      return Response.json({
        userInfo: { email: "builder@example.test" },
        usageBreakdownList: [{ currentUsage: 2, usageLimit: 50 }],
      });
    }
    throw new Error(`unexpected fixture endpoint ${url.pathname}`);
  };
  globalThis.fetch = Object.assign(responder, { preconnect: realFetch.preconnect });

  const result = await runLogin(
    ConfigSchema.parse({
      api_keys: ["synthetic-key"],
      proxy_url: "",
      default_region: "eu-central-1",
    }),
    {},
    {
      poll: (client, secret, device, interval, expires, region, _sleep, proxy) =>
        pollKiroIDCToken(
          client,
          secret,
          device,
          interval,
          expires,
          region,
          async () => undefined,
          proxy,
        ),
      openDb: () => new AccountsDatabase(path),
      stdout: () => undefined,
      stderr: () => undefined,
    },
  );

  expect(calls.filter(({ pathname }) => pathname === "/List-Available-Profiles")).toEqual([]);
  expect(result.account).toMatchObject({
    email: "builder@example.test",
    profileArn: KIRO_AUTH_SERVICE.BUILDER_ID_PROFILE_ARN,
    region: "us-east-1",
    oidcRegion: "eu-central-1",
  });
  expect(calls.find(({ pathname }) => pathname === "/client/register")?.hostname).toBe(
    "oidc.eu-central-1.amazonaws.com",
  );
  const db = new AccountsDatabase(path);
  try {
    expect(db.getAccounts()).toEqual([result.account]);
  } finally {
    db.close();
  }
});

test("RegisterClient seconds survive real authorization, polling, relogin and SQLite reopen without reviving old auth state", async () => {
  root = mkdtempSync(join(tmpdir(), "kiro-login-metadata-"));
  const path = join(root, "accounts.db");
  const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/synthetic";
  let db = new AccountsDatabase(path);
  let previous = db.insertAccount({
    id: "synthetic-existing-owner",
    email: "synthetic@example.test",
    authMethod: "idc",
    region: "us-east-1",
    oidcRegion: "eu-central-1",
    profileArn,
    clientId: "old-client",
    clientSecret: "old-secret",
    clientIdIssuedAt: 10,
    clientSecretExpiresAt: 20,
    refreshToken: "old-refresh",
    accessToken: "old-access",
    expiresAt: 30,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    refreshFailureCount: 4,
    refreshFailureCode: "invalid_request",
    refreshFailedAt: 40,
    refreshRetryAt: 50,
    lastRefreshAt: 5,
  });
  db.claimSessionAffinity(
    "synthetic-affinity",
    previous.id,
    "synthetic-conversation",
    10,
    10000,
    10,
  );
  db.recordOutputLineage("synthetic-lineage", previous.id, "synthetic-conversation", 10, 10000, 10);
  db.close();
  for (const includeMetadata of [true, false]) {
    const calls: string[] = [];
    const responder = async (input: string | Request | URL) => {
      const url = String(input);
      calls.push(new URL(url).pathname);
      const value = url.endsWith("/client/register")
        ? {
            clientId: "new-client",
            clientSecret: "new-secret",
            ...(includeMetadata
              ? { clientIdIssuedAt: 1_700_000_000, clientSecretExpiresAt: 1_800_000_000 }
              : {}),
          }
        : url.endsWith("/device_authorization")
          ? {
              verificationUri: "https://synthetic.test/verify",
              verificationUriComplete: "https://synthetic.test/verify",
              userCode: "synthetic",
              deviceCode: "synthetic",
              interval: 1,
              expiresIn: 10,
            }
          : { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 };
      return Response.json(value);
    };
    globalThis.fetch = Object.assign(responder, { preconnect: realFetch.preconnect });
    await runLogin(
      ConfigSchema.parse({ api_keys: ["synthetic-key"] }),
      { replaceAccount: previous },
      {
        poll: (client, secret, device, interval, expires, region, _sleep, proxy) =>
          pollKiroIDCToken(
            client,
            secret,
            device,
            interval,
            expires,
            region,
            async () => undefined,
            proxy,
          ),
        fetchUsage: async () => ({
          email: previous.email,
          usedCount: 1,
          limitCount: 100,
          overageCount: 0,
        }),
        openDb: () => new AccountsDatabase(path),
        stdout: () => undefined,
        stderr: () => undefined,
      },
    );
    db = new AccountsDatabase(path);
    try {
      const next = db.getById(previous.id);
      if (next === undefined) throw new Error("re-login did not persist the fixture account");
      expect(calls).toEqual(["/client/register", "/device_authorization", "/token"]);
      expect(next).toMatchObject({
        id: previous.id,
        profileArn,
        oidcRegion: "eu-central-1",
        clientId: "new-client",
        clientSecret: "new-secret",
        accessToken: "new-access",
        refreshToken: "new-refresh",
      });
      if (includeMetadata)
        expect(next).toMatchObject({
          clientIdIssuedAt: 1_700_000_000_000,
          clientSecretExpiresAt: 1_800_000_000_000,
        });
      else {
        expect(next).not.toHaveProperty("clientIdIssuedAt");
        expect(next).not.toHaveProperty("clientSecretExpiresAt");
      }
      for (const field of [
        "refreshFailureCount",
        "refreshFailureCode",
        "refreshFailedAt",
        "refreshRetryAt",
        "lastRefreshAt",
      ])
        expect(next).not.toHaveProperty(field);
      expect(db.getSessionAffinity("synthetic-affinity", 20)?.accountId).toBe(previous.id);
      expect(db.resolveOutputLineage("synthetic-lineage", 20)?.accountId).toBe(previous.id);
      previous = next;
    } finally {
      db.close();
    }
  }
});
