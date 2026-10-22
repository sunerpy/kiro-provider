import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogin } from "../src/cli/login.js";
import { ConfigSchema } from "../src/config/schema.js";
import { pollKiroIDCToken } from "../src/kiro/oauth-idc.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

const realFetch = globalThis.fetch;
let root: string | undefined;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
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
      const next = db.getById(previous.id)!;
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
