import { describe, expect, test } from "bun:test";
import { accountAvailability, formatAccountList, sortAccounts } from "../src/cli/account-output.js";
import { isSelectableAccount } from "../src/core/account-selection.js";
import type { StoredAccount } from "../src/storage/accounts-db.js";

const NOW = 1_800_000_000_000;

function account(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id: "auth-availability-fixture",
    email: "fixture@example.invalid",
    authMethod: "idc",
    region: "us-east-1",
    clientId: "synthetic-client-id",
    clientSecret: "synthetic-client-secret",
    refreshToken: "synthetic-refresh-token",
    accessToken: "synthetic-access-token",
    expiresAt: NOW + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 10,
    limitCount: 100,
    generation: 1,
    ...overrides,
  };
}

describe("credential refresh availability projections", () => {
  test("an elapsed auth backoff is probeable but never falsely reported as recovered", () => {
    const failed = account({
      expiresAt: NOW - 1,
      refreshFailureCount: 2,
      refreshFailureCode: "invalid_request",
      refreshFailedAt: NOW - 1_000,
      refreshRetryAt: NOW + 30_000,
    });
    expect(accountAvailability(failed, undefined, NOW)).toBe("refresh-failed");
    expect(isSelectableAccount(failed, NOW)).toBe(false);
    expect(isSelectableAccount(failed, NOW + 30_000)).toBe(true);
    expect(accountAvailability(failed, undefined, NOW + 30_000)).toBe("refresh-failed");
    for (const mode of ["table", "details", "json"] as const) {
      expect(formatAccountList([failed], mode, undefined, undefined, NOW).join("\n")).toContain(
        "refresh-failed",
      );
    }
  });

  test("known registration expiry requires login while unknown legacy metadata remains usable", () => {
    const expired = account({ clientSecretExpiresAt: NOW });
    expect(accountAvailability(expired, undefined, NOW)).toBe("needs-relogin");
    expect(isSelectableAccount(expired, NOW)).toBe(false);
    expect(accountAvailability(account(), undefined, NOW)).toBe("available");
    expect(isSelectableAccount(account(), NOW)).toBe(true);
    const desktop = account({ authMethod: "desktop", clientSecretExpiresAt: NOW - 1 });
    expect(accountAvailability(desktop, undefined, NOW)).toBe("available");
  });

  test("JSON exposes only bounded diagnostic state and lifecycle times, never credentials", () => {
    const failed = account({
      clientIdIssuedAt: NOW - 60_000,
      clientSecretExpiresAt: NOW + 3_600_000,
      refreshFailureCount: 1,
      refreshFailureCode: "invalid_request",
      refreshFailedAt: NOW - 1_000,
      refreshRetryAt: NOW + 30_000,
      lastRefreshAt: NOW - 3_600_000,
    });
    const text = formatAccountList([failed], "json", undefined, undefined, NOW).join("\n");
    expect(JSON.parse(text)[0]).toMatchObject({
      availability: "refresh-failed",
      refresh_failure_count: 1,
      refresh_failure_code: "invalid_request",
      refresh_failed_at: new Date(NOW - 1_000).toISOString(),
      refresh_retry_at: new Date(NOW + 30_000).toISOString(),
      last_refresh_at: new Date(NOW - 3_600_000).toISOString(),
      client_id_issued_at: new Date(NOW - 60_000).toISOString(),
      client_secret_expires_at: new Date(NOW + 3_600_000).toISOString(),
    });
    for (const secret of [
      failed.clientId,
      failed.clientSecret,
      failed.refreshToken,
      failed.accessToken,
    ]) {
      expect(text).not.toContain(secret as string);
    }
  });

  test("preserves quota and permanent failure semantics and ranks unverified authentication", () => {
    const failure = { refreshFailureCount: 1, refreshFailureCode: "invalid_request" as const };
    expect(accountAvailability(account({ ...failure, usedCount: 100 }), undefined, NOW)).toBe(
      "quota-exhausted",
    );
    expect(
      accountAvailability(
        account({ ...failure, unhealthyReason: "invalid_grant" }),
        undefined,
        NOW,
      ),
    ).toBe("needs-relogin");
    const rows = [
      account({ id: "auth", ...failure }),
      account({ id: "sick", isHealthy: false }),
      account({ id: "ok" }),
      account({ id: "limited", rateLimitResetTime: NOW + 1 }),
    ];
    expect(
      sortAccounts(rows, { field: "availability", order: "asc" }, undefined, NOW).map(
        (row) => row.id,
      ),
    ).toEqual(["ok", "limited", "auth", "sick"]);
  });
});
