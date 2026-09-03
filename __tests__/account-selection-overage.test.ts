import { describe, expect, test } from "bun:test";
import {
  countSelectable,
  isBlockedOnlyByOverage,
  isSelectableAccount,
  selectableCandidates,
} from "../src/core/account-selection.js";
import type { OveragePolicy } from "../src/kiro/health.js";
import type { ManagedAccount } from "../src/kiro/types.js";

const NOW = 1_700_000_000_000;
const OFF: OveragePolicy = { stopOnOverage: false, overageThreshold: 0 };
const THRESHOLD_TWO: OveragePolicy = { stopOnOverage: true, overageThreshold: 2 };

function account(id: string, overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id,
    email: `${id.toLowerCase()}@example.invalid`,
    authMethod: "desktop",
    region: "us-east-1",
    refreshToken: `refresh-${id}`,
    accessToken: `access-${id}`,
    expiresAt: NOW + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 0,
    limitCount: 100,
    overageCount: 0,
    lastUsed: 0,
    ...overrides,
  };
}

describe("isSelectableAccount with an overage policy", () => {
  test("defaults to the built-in gate and honors the knob and threshold", () => {
    const overage = account("A", { overageCount: 1 });

    expect(isSelectableAccount(overage, NOW)).toBe(false);
    expect(isSelectableAccount(overage, NOW, OFF)).toBe(true);
    expect(isSelectableAccount(account("A", { overageCount: 2 }), NOW, THRESHOLD_TWO)).toBe(true);
    expect(isSelectableAccount(account("A", { overageCount: 3 }), NOW, THRESHOLD_TWO)).toBe(false);
  });

  test("the knob never admits an account exhausted on its included quota", () => {
    expect(isSelectableAccount(account("A", { usedCount: 100, limitCount: 100 }), NOW, OFF)).toBe(
      false,
    );
  });
});

describe("selectableCandidates and countSelectable with an overage policy", () => {
  const accounts = [
    account("C", { overageCount: 1 }),
    account("A"),
    account("B", { overageCount: 3 }),
    account("D", { usedCount: 100, limitCount: 100, overageCount: 9 }),
  ];

  test("agree with each other under every policy", () => {
    for (const policy of [undefined, OFF, THRESHOLD_TWO]) {
      expect(countSelectable(accounts, NOW, undefined, policy)).toBe(
        selectableCandidates(accounts, NOW, undefined, policy).length,
      );
    }
  });

  test("the policy decides which overage accounts are candidates", () => {
    expect(selectableCandidates(accounts, NOW).map(({ id }) => id)).toEqual(["A"]);
    expect(
      selectableCandidates(accounts, NOW, undefined, THRESHOLD_TWO).map(({ id }) => id),
    ).toEqual(["A", "C"]);
    expect(selectableCandidates(accounts, NOW, undefined, OFF).map(({ id }) => id)).toEqual([
      "A",
      "B",
      "C",
    ]);
    expect(countSelectable(accounts, NOW, new Set(["B", "C"]), OFF)).toBe(2);
    expect(countSelectable(accounts, NOW, new Set(["B", "C"]))).toBe(0);
  });
});

describe("isBlockedOnlyByOverage", () => {
  test("is true for a healthy account kept out solely by the overage gate", () => {
    expect(isBlockedOnlyByOverage(account("A", { overageCount: 1 }), NOW)).toBe(true);
    expect(isBlockedOnlyByOverage(account("A", { overageCount: 1 }), NOW, OFF)).toBe(false);
    expect(isBlockedOnlyByOverage(account("A", { overageCount: 2 }), NOW, THRESHOLD_TWO)).toBe(
      false,
    );
    expect(isBlockedOnlyByOverage(account("A", { overageCount: 3 }), NOW, THRESHOLD_TWO)).toBe(
      true,
    );
    expect(isBlockedOnlyByOverage(account("A"), NOW)).toBe(false);
  });

  test("ignores the cooldown because exhaustion stores its recheck time there", () => {
    expect(
      isBlockedOnlyByOverage(
        account("A", { overageCount: 1, rateLimitResetTime: NOW + 60_000 }),
        NOW,
      ),
    ).toBe(true);
  });

  test("is false when something other than overage also blocks the account", () => {
    expect(
      isBlockedOnlyByOverage(
        account("A", { overageCount: 1, usedCount: 100, limitCount: 100 }),
        NOW,
      ),
    ).toBe(false);
    expect(
      isBlockedOnlyByOverage(
        account("A", { overageCount: 1, unhealthyReason: "InvalidGrantException: dead" }),
        NOW,
      ),
    ).toBe(false);
    expect(
      isBlockedOnlyByOverage(
        account("A", { overageCount: 1, isHealthy: false, unhealthyReason: "temporary" }),
        NOW,
      ),
    ).toBe(false);
    expect(
      isBlockedOnlyByOverage(
        account("A", {
          overageCount: 1,
          isHealthy: false,
          unhealthyReason: "temporary",
          recoveryTime: NOW + 1,
        }),
        NOW,
      ),
    ).toBe(false);
  });

  test("keeps refreshable or recovered unhealthy accounts in the overage-only set", () => {
    expect(
      isBlockedOnlyByOverage(
        account("A", {
          overageCount: 1,
          isHealthy: false,
          unhealthyReason: "The bearer token included in the request is invalid",
        }),
        NOW,
      ),
    ).toBe(true);
    expect(
      isBlockedOnlyByOverage(
        account("A", {
          overageCount: 1,
          isHealthy: false,
          unhealthyReason: "temporary",
          recoveryTime: NOW,
        }),
        NOW,
      ),
    ).toBe(true);
  });
});
