import { describe, expect, test } from "bun:test";
import { errorReason } from "../src/core/account-errors.js";
import { encodeRefreshToken } from "../src/kiro/auth.js";
import { KiroTokenRefreshError } from "../src/kiro/errors.js";
import {
  DEFAULT_OVERAGE_POLICY,
  isIncludedQuotaExhausted,
  isOverageBlocked,
  isPermanentError,
  isQuotaExhausted,
  isRefreshTokenDead,
  type OveragePolicy,
  toDeadReason,
  toOveragePolicy,
} from "../src/kiro/health.js";

const OFF: OveragePolicy = { stopOnOverage: false, overageThreshold: 0 };
const THRESHOLD_FIVE: OveragePolicy = { stopOnOverage: true, overageThreshold: 5 };

describe("OveragePolicy gate", () => {
  test("the default gate blocks any observed overage and is what the one-argument form applies", () => {
    expect(DEFAULT_OVERAGE_POLICY).toEqual({ stopOnOverage: true, overageThreshold: 0 });
    expect(isQuotaExhausted({ usedCount: 1, limitCount: 100, overageCount: 0 })).toBe(false);
    expect(isQuotaExhausted({ usedCount: 1, limitCount: 100, overageCount: 1 })).toBe(true);
  });

  test("overage equal to the threshold is allowed, strictly greater blocks", () => {
    expect(isOverageBlocked({ overageCount: 4 }, THRESHOLD_FIVE)).toBe(false);
    expect(isOverageBlocked({ overageCount: 5 }, THRESHOLD_FIVE)).toBe(false);
    expect(isOverageBlocked({ overageCount: 6 }, THRESHOLD_FIVE)).toBe(true);
    expect(
      isQuotaExhausted({ usedCount: 10, limitCount: 100, overageCount: 5 }, THRESHOLD_FIVE),
    ).toBe(false);
    expect(
      isQuotaExhausted({ usedCount: 10, limitCount: 100, overageCount: 6 }, THRESHOLD_FIVE),
    ).toBe(true);
  });

  test("the knob off admits any overage but leaves the included quota rule untouched", () => {
    expect(isQuotaExhausted({ usedCount: 10, limitCount: 100, overageCount: 500 }, OFF)).toBe(
      false,
    );
    expect(isQuotaExhausted({ usedCount: 100, limitCount: 100, overageCount: 0 }, OFF)).toBe(true);
    expect(isQuotaExhausted({ usedCount: 100, limitCount: 100, overageCount: 7 }, OFF)).toBe(true);
    expect(isIncludedQuotaExhausted({ usedCount: 100, limitCount: 100 })).toBe(true);
    expect(isIncludedQuotaExhausted({ usedCount: 0, limitCount: 100, overageCount: 500 })).toBe(
      false,
    );
    expect(isIncludedQuotaExhausted({ usedCount: 5, limitCount: 0 })).toBe(false);
  });

  test("missing or non-finite overage never blocks", () => {
    expect(isOverageBlocked({})).toBe(false);
    expect(isOverageBlocked({ overageCount: Number.NaN })).toBe(false);
    expect(isOverageBlocked({ overageCount: Number.POSITIVE_INFINITY })).toBe(false);
  });

  test("point-free use inside Array.prototype.filter keeps the default gate", () => {
    // filter passes the element index as the second argument; it must not be
    // mistaken for a policy that disables the gate.
    const accounts = [{ overageCount: 1 }, { overageCount: 0 }, { usedCount: 5, limitCount: 5 }];

    expect(accounts.filter(isQuotaExhausted)).toEqual([
      { overageCount: 1 },
      { usedCount: 5, limitCount: 5 },
    ]);
  });

  test("toOveragePolicy maps the snake_case config knobs", () => {
    expect(toOveragePolicy({ stop_on_overage: false, overage_threshold: 3 })).toEqual({
      stopOnOverage: false,
      overageThreshold: 3,
    });
    expect(toOveragePolicy({ stop_on_overage: true, overage_threshold: 0 })).toEqual(
      DEFAULT_OVERAGE_POLICY,
    );
  });
});

describe("corrupted stored credentials are refresh-token-dead", () => {
  test("the structured MISSING_CREDENTIALS and INVALID_RESPONSE codes are permanent", () => {
    for (const reason of [
      "MISSING_CREDENTIALS: Missing credentials",
      "MISSING_CREDENTIALS: Missing creds",
      "INVALID_RESPONSE: No access token",
      "MISSING_CREDENTIALS",
    ]) {
      expect(isRefreshTokenDead(reason)).toBe(true);
      expect(isPermanentError(reason)).toBe(true);
      expect(toDeadReason(reason)).toBe(reason);
    }
  });

  test("prose that merely mentions credentials or responses stays transient", () => {
    expect(isRefreshTokenDead("Missing credentials")).toBe(false);
    expect(isRefreshTokenDead("HTTP_500: missing_credentials in response")).toBe(false);
    expect(isRefreshTokenDead("NETWORK_ERROR: Token refresh failed: invalid response")).toBe(false);
    expect(isRefreshTokenDead("HTTP_502: INVALID_RESPONSE_FROM_PROXY")).toBe(false);
  });

  test("encodeRefreshToken raises a typed error whose reason classifies as dead", () => {
    let caught: unknown;
    try {
      encodeRefreshToken({ refreshToken: "rt", clientId: "cid", authMethod: "idc" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(KiroTokenRefreshError);
    expect(caught).toMatchObject({ code: "MISSING_CREDENTIALS", message: "Missing credentials" });
    expect(errorReason(caught)).toBe("MISSING_CREDENTIALS: Missing credentials");
    expect(isRefreshTokenDead(errorReason(caught))).toBe(true);
  });
});
