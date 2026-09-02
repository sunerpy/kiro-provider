import { afterEach, describe, expect, test } from "bun:test";
import type { KiroAuthDetails } from "../src/kiro/types.js";
import { fetchUsageLimits } from "../src/kiro/usage-client.js";

const originalFetch = globalThis.fetch;
type FetchHandler = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

const auth: KiroAuthDetails = {
  access: "access-token",
  refresh: "refresh-token",
  expires: Date.now() + 60_000,
  authMethod: "desktop",
  region: "us-east-1",
  email: "test@example.com",
};

// Observed upstream value: 2026-10-01T00:00:00Z expressed in epoch seconds.
const OBSERVED_RESET_SECONDS = 1_790_812_800;
const DAY_SECONDS = 24 * 60 * 60;

function useFetch(handler: FetchHandler): void {
  globalThis.fetch = Object.assign(handler, {
    preconnect: originalFetch.preconnect,
  });
}

function respondWith(body: Record<string, unknown>): void {
  useFetch(async () => Response.json(body));
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Kiro usage client reset time", () => {
  test("parses the top-level nextDateReset from epoch seconds into resetAt milliseconds", async () => {
    respondWith({
      daysUntilReset: 0,
      nextDateReset: OBSERVED_RESET_SECONDS,
      usageBreakdownList: [
        {
          currentUsage: 25,
          usageLimit: 100,
          nextDateReset: OBSERVED_RESET_SECONDS,
        },
      ],
      userInfo: { email: "usage@example.com" },
    });

    const result = await fetchUsageLimits(auth, { timeoutMs: 1_000 });

    expect(result).toEqual({
      usedCount: 25,
      limitCount: 100,
      overageCount: 0,
      email: "usage@example.com",
      resetAt: OBSERVED_RESET_SECONDS * 1000,
    });
    expect(new Date(result.resetAt ?? 0).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  test("falls back to the earliest usageBreakdownList reset when the top-level field is missing", async () => {
    respondWith({
      usageBreakdownList: [
        { currentUsage: 1, usageLimit: 10, nextDateReset: OBSERVED_RESET_SECONDS },
        { currentUsage: 2, usageLimit: 10, nextDateReset: OBSERVED_RESET_SECONDS - DAY_SECONDS },
        { currentUsage: 3, usageLimit: 10 },
      ],
    });

    const result = await fetchUsageLimits(auth, { timeoutMs: 1_000 });

    expect(result.resetAt).toBe((OBSERVED_RESET_SECONDS - DAY_SECONDS) * 1000);
    expect(result).toMatchObject({ usedCount: 6, limitCount: 30 });
  });

  test("falls back to the breakdown when the top-level value is unusable", async () => {
    respondWith({
      nextDateReset: 0,
      usageBreakdownList: [
        { currentUsage: 1, usageLimit: 10, nextDateReset: OBSERVED_RESET_SECONDS },
      ],
    });

    const result = await fetchUsageLimits(auth, { timeoutMs: 1_000 });

    expect(result.resetAt).toBe(OBSERVED_RESET_SECONDS * 1000);
  });

  test("ignores daysUntilReset and omits resetAt when no usable reset is reported", async () => {
    respondWith({
      daysUntilReset: 3,
      usageBreakdownList: [{ currentUsage: 1, usageLimit: 10 }],
    });

    const result = await fetchUsageLimits(auth, { timeoutMs: 1_000 });

    expect(result).toEqual({ usedCount: 1, limitCount: 10, overageCount: 0 });
    expect(result).not.toHaveProperty("resetAt");
  });

  test("treats non-numeric, non-positive, and non-finite reset values as absent without failing the parse", async () => {
    for (const bad of [null, "1790812800", -1, 0, true, {}, []]) {
      respondWith({
        nextDateReset: bad,
        usageBreakdownList: [{ currentUsage: 1, usageLimit: 10, nextDateReset: bad }],
      });

      const result = await fetchUsageLimits(auth, { timeoutMs: 1_000 });

      expect(result).toEqual({ usedCount: 1, limitCount: 10, overageCount: 0 });
    }
  });

  test("treats a reset more than 400 days ahead as absent", async () => {
    respondWith({
      nextDateReset: nowSeconds() + 401 * DAY_SECONDS,
      usageBreakdownList: [{ currentUsage: 1, usageLimit: 10 }],
    });

    const result = await fetchUsageLimits(auth, { timeoutMs: 1_000 });

    expect(result).not.toHaveProperty("resetAt");
  });

  test("rejects a millisecond-valued reset as a unit mismatch", async () => {
    respondWith({
      nextDateReset: OBSERVED_RESET_SECONDS * 1000,
      usageBreakdownList: [{ currentUsage: 1, usageLimit: 10 }],
    });

    const result = await fetchUsageLimits(auth, { timeoutMs: 1_000 });

    expect(result).not.toHaveProperty("resetAt");
  });

  test("accepts a reset within the 400-day horizon", async () => {
    const resetSeconds = nowSeconds() + 30 * DAY_SECONDS;
    respondWith({
      nextDateReset: resetSeconds,
      usageBreakdownList: [{ currentUsage: 1, usageLimit: 10 }],
    });

    const result = await fetchUsageLimits(auth, { timeoutMs: 1_000 });

    expect(result.resetAt).toBe(resetSeconds * 1000);
  });
});
