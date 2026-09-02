import { afterEach, describe, expect, test } from "bun:test";
import { encodeRefreshToken } from "../src/kiro/auth.js";
import { refreshAccessToken } from "../src/kiro/token.js";
import type { KiroAuthDetails } from "../src/kiro/types.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function desktopAuth(): KiroAuthDetails {
  return {
    refresh: encodeRefreshToken({ refreshToken: "desktop-refresh-token", authMethod: "desktop" }),
    access: "old-access",
    expires: 0,
    authMethod: "desktop",
    region: "us-west-2",
  };
}

function respondJson(body: Record<string, unknown>): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

async function expiresAfterSeconds(body: Record<string, unknown>): Promise<{
  readonly before: number;
  readonly after: number;
  readonly expires: number;
}> {
  respondJson(body);
  const before = Date.now();
  const result = await refreshAccessToken(desktopAuth());
  const after = Date.now();
  return { before, after, expires: result.expires };
}

function expectWithinSeconds(
  sample: { readonly before: number; readonly after: number; readonly expires: number },
  seconds: number,
): void {
  expect(sample.expires).toBeGreaterThanOrEqual(sample.before + seconds * 1_000);
  expect(sample.expires).toBeLessThanOrEqual(sample.after + seconds * 1_000);
}

describe("refreshAccessToken expiry conversion", () => {
  test("converts expires_in seconds to an absolute millisecond timestamp", async () => {
    expectWithinSeconds(
      await expiresAfterSeconds({ access_token: "access", expires_in: 1_800 }),
      1_800,
    );
  });

  test("accepts the camelCase expiresIn variant", async () => {
    expectWithinSeconds(await expiresAfterSeconds({ accessToken: "access", expiresIn: 900 }), 900);
  });

  test("prefers expires_in when both spellings are present", async () => {
    expectWithinSeconds(
      await expiresAfterSeconds({ access_token: "access", expires_in: 600, expiresIn: 7_200 }),
      600,
    );
  });

  test("defaults to 3600 seconds when no expiry is returned", async () => {
    expectWithinSeconds(await expiresAfterSeconds({ access_token: "access" }), 3_600);
  });

  test("ignores a non-numeric expiry and falls back to the 3600 second default", async () => {
    expectWithinSeconds(
      await expiresAfterSeconds({ access_token: "access", expires_in: "1800" }),
      3_600,
    );
  });
});
