import { describe, expect, test } from "bun:test";
import { buildUrl, KIRO_CONSTANTS, normalizeRegion } from "../src/kiro/constants.js";

describe("normalizeRegion", () => {
  test("accepts configured AWS regions with the installed Zod enum shape", () => {
    expect(normalizeRegion("us-west-2")).toBe("us-west-2");
  });

  test("falls back to us-east-1 for unknown or missing regions", () => {
    expect(normalizeRegion(undefined)).toBe("us-east-1");
    expect(normalizeRegion("evil.example/")).toBe("us-east-1");
  });
});

describe("buildUrl", () => {
  test("interpolates the region into every retained endpoint template", () => {
    expect(buildUrl(KIRO_CONSTANTS.USAGE_LIMITS_URL, "eu-west-1")).toBe(
      "https://q.eu-west-1.amazonaws.com/getUsageLimits",
    );
    expect(buildUrl(KIRO_CONSTANTS.REFRESH_IDC_URL, "ap-southeast-1")).toBe(
      "https://oidc.ap-southeast-1.amazonaws.com/token",
    );
    expect(buildUrl(KIRO_CONSTANTS.REFRESH_URL, "us-east-1")).toBe(
      "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken",
    );
  });
});
