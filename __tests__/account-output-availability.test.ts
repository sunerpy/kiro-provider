import { describe, expect, test } from "bun:test";
import { accountAvailability, formatAccountList } from "../src/cli/account-output.js";
import type { OveragePolicy } from "../src/kiro/health.js";
import type { StoredAccount } from "../src/storage/accounts-db.js";

const NOW = 1_700_000_000_000;
const OFF: OveragePolicy = { stopOnOverage: false, overageThreshold: 0 };
const THRESHOLD_TWO: OveragePolicy = { stopOnOverage: true, overageThreshold: 2 };

function stored(id: string, overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id,
    email: `${id}@example.com`,
    authMethod: "idc",
    region: "us-east-1",
    refreshToken: `${id}-refresh`,
    accessToken: `${id}-access`,
    expiresAt: NOW + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 10,
    limitCount: 100,
    overageCount: 0,
    generation: 1,
    ...overrides,
  };
}

function availabilityFromJson(lines: string[]): string[] {
  const parsed = JSON.parse(lines.join("\n")) as Array<{ availability: string }>;
  return parsed.map(({ availability }) => availability);
}

describe("accountAvailability", () => {
  test("distinguishes overage-blocked from included quota exhaustion", () => {
    expect(accountAvailability(stored("a", { overageCount: 1 }), undefined, NOW)).toBe(
      "overage-blocked",
    );
    expect(accountAvailability(stored("a", { usedCount: 100 }), undefined, NOW)).toBe(
      "quota-exhausted",
    );
    expect(
      accountAvailability(stored("a", { usedCount: 100, overageCount: 4 }), undefined, NOW),
    ).toBe("quota-exhausted");
    expect(accountAvailability(stored("a"), undefined, NOW)).toBe("available");
  });

  test("honors the knob and the threshold", () => {
    expect(accountAvailability(stored("a", { overageCount: 9 }), OFF, NOW)).toBe("available");
    expect(accountAvailability(stored("a", { overageCount: 2 }), THRESHOLD_TWO, NOW)).toBe(
      "available",
    );
    expect(accountAvailability(stored("a", { overageCount: 3 }), THRESHOLD_TWO, NOW)).toBe(
      "overage-blocked",
    );
    expect(accountAvailability(stored("a", { usedCount: 100 }), OFF, NOW)).toBe("quota-exhausted");
  });

  test("overage outranks a cooldown and health, but needs-relogin outranks everything", () => {
    expect(
      accountAvailability(
        stored("a", { overageCount: 1, rateLimitResetTime: NOW + 1, isHealthy: false }),
        undefined,
        NOW,
      ),
    ).toBe("overage-blocked");
    expect(
      accountAvailability(
        stored("a", {
          overageCount: 1,
          isHealthy: false,
          unhealthyReason: "MISSING_CREDENTIALS: Missing credentials",
        }),
        undefined,
        NOW,
      ),
    ).toBe("needs-relogin");
  });
});

describe("formatAccountList", () => {
  test("shows needs-relogin for an IdC row whose stored credentials are corrupted", () => {
    const corrupted = stored("idc", {
      clientId: "client-id",
      isHealthy: false,
      failCount: 10,
      unhealthyReason: "MISSING_CREDENTIALS: Missing credentials",
    });

    const table = formatAccountList([corrupted], "table");
    const details = formatAccountList([corrupted], "details");

    expect(table[2]).toContain("needs-relogin");
    expect(details[2]).toContain("needs-relogin");
    expect(availabilityFromJson(formatAccountList([corrupted], "json"))).toEqual(["needs-relogin"]);
  });

  test("renders the overage label under the default gate and available with the knob off", () => {
    const accounts = [stored("a", { overageCount: 1 }), stored("b", { usedCount: 100 })];

    expect(availabilityFromJson(formatAccountList(accounts, "json"))).toEqual([
      "overage-blocked",
      "quota-exhausted",
    ]);
    expect(availabilityFromJson(formatAccountList(accounts, "json", OFF))).toEqual([
      "available",
      "quota-exhausted",
    ]);
    expect(formatAccountList(accounts, "table")[2]).toContain("overage-blocked");
    expect(formatAccountList(accounts, "table", OFF)[2]).toContain("available");
  });
});
