import { afterEach, describe, expect, test } from "bun:test";
import type { KiroAuthDetails } from "../src/kiro/types.js";
import {
  fetchUsageLimits,
  isKiroUsageAuthenticationError,
  KiroUsageError,
} from "../src/kiro/usage-client.js";

const originalFetch = globalThis.fetch;
type FetchHandler = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

const auth: KiroAuthDetails = {
  access: "access-token",
  refresh: "refresh-token",
  expires: Date.now() + 60_000,
  authMethod: "desktop",
  region: "us-east-1",
  email: "test@example.com",
  profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/test",
};

function useFetch(handler: FetchHandler): void {
  globalThis.fetch = Object.assign(handler, {
    preconnect: originalFetch.preconnect,
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Kiro usage client", () => {
  test("sends the Kiro usage request through the configured proxy and sums all segments", async () => {
    const calls: URL[] = [];
    useFetch(async (input, init) => {
      const url = new URL(String(input));
      calls.push(url);
      const headers = new Headers(init?.headers);
      expect(init?.method).toBe("GET");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(headers.get("authorization")).toBe("Bearer access-token");
      expect(headers.get("x-amzn-kiro-agent-mode")).toBe("vibe");
      expect((init as RequestInit & { proxy?: string }).proxy).toBe("http://127.0.0.1:3128");
      return Response.json({
        usageBreakdownList: [
          { currentUsage: 100, usageLimit: 1_000 },
          {
            currentUsage: 29,
            usageLimit: 0,
            currentOverages: 3,
            freeTrialInfo: { currentUsage: 800, usageLimit: 9_000 },
          },
        ],
        userInfo: { email: "usage@example.com" },
      });
    });

    const result = await fetchUsageLimits(auth, {
      proxyUrl: "http://127.0.0.1:3128",
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      usedCount: 929,
      limitCount: 10_000,
      overageCount: 3,
      email: "usage@example.com",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.origin).toBe("https://q.us-east-1.amazonaws.com");
    expect(calls[0]?.searchParams.get("resourceType")).toBe("AGENTIC_REQUEST");
    expect(calls[0]?.searchParams.get("origin")).toBe("AI_EDITOR");
    expect(calls[0]?.searchParams.get("profileArn")).toBe(auth.profileArn);
  });

  test("falls back only when the requested usage projection is unsupported", async () => {
    let calls = 0;
    useFetch(async (input) => {
      calls += 1;
      const url = new URL(String(input));
      if (calls === 1) {
        expect(url.searchParams.get("resourceType")).toBe("AGENTIC_REQUEST");
        return Response.json({ __type: "FEATURE_NOT_SUPPORTED" }, { status: 400 });
      }
      expect(url.searchParams.has("resourceType")).toBe(false);
      return Response.json({
        usageBreakdownList: [{ currentUsage: 1, usageLimit: 100 }],
      });
    });

    expect(await fetchUsageLimits(auth)).toMatchObject({
      usedCount: 1,
      limitCount: 100,
    });
    expect(calls).toBe(2);
  });

  test("classifies an invalid bearer response without retrying parameter variants", async () => {
    let calls = 0;
    useFetch(async () => {
      calls += 1;
      return new Response("The bearer token included in the request is invalid", {
        status: 403,
        headers: { "x-amzn-errortype": "AccessDeniedException" },
      });
    });

    const error = await fetchUsageLimits(auth).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(KiroUsageError);
    expect(error).toMatchObject({
      status: 403,
      upstreamCode: "AccessDeniedException",
    });
    expect(isKiroUsageAuthenticationError(error)).toBe(true);
    expect(calls).toBe(1);
  });

  test("rejects malformed successful responses", async () => {
    useFetch(async () => Response.json({ usageBreakdownList: "invalid" }));

    await expect(fetchUsageLimits(auth)).rejects.toMatchObject({
      name: "KiroUsageError",
      message: "Kiro usage service returned an invalid response shape",
    });
  });
});
