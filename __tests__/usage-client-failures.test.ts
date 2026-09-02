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
};

function useFetch(handler: FetchHandler): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = Object.assign(
    ((...args: Parameters<typeof fetch>) => {
      calls += 1;
      return handler(...args);
    }) as FetchHandler,
    { preconnect: originalFetch.preconnect },
  );
  return { calls: () => calls };
}

function variantOf(input: Parameters<typeof fetch>[0]): string {
  const url = new URL(String(input));
  return `${url.searchParams.get("resourceType") ?? "-"}/${url.searchParams.get("origin") ?? "-"}`;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Kiro usage client failure handling", () => {
  test("a 429 stops the variant cycle immediately and is not an authentication error", async () => {
    const { calls } = useFetch(
      async () =>
        new Response(JSON.stringify({ message: "Too many requests" }), {
          status: 429,
          headers: {
            "x-amzn-errortype": "ThrottlingException",
            "x-amzn-requestid": "req-429",
          },
        }),
    );

    const error = await fetchUsageLimits(auth).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(KiroUsageError);
    expect(error).toMatchObject({ status: 429, upstreamCode: "ThrottlingException" });
    expect((error as KiroUsageError).message).toContain("HTTP 429");
    expect((error as KiroUsageError).message).toContain("[req-429]");
    expect(isKiroUsageAuthenticationError(error)).toBe(false);
    expect(calls()).toBe(1);
  });

  test("a 5xx on every variant surfaces the last 5xx after trying each variant once", async () => {
    const variants: string[] = [];
    const { calls } = useFetch(async (input) => {
      variants.push(variantOf(input));
      return new Response("upstream unavailable", { status: 503 });
    });

    const error = await fetchUsageLimits(auth).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(KiroUsageError);
    expect(error).toMatchObject({ status: 503 });
    expect((error as KiroUsageError).message).toContain("upstream unavailable");
    expect(isKiroUsageAuthenticationError(error)).toBe(false);
    expect(calls()).toBe(4);
    expect(variants).toEqual([
      "AGENTIC_REQUEST/AI_EDITOR",
      "-/AI_EDITOR",
      "CONVERSATION/AI_EDITOR",
      "-/-",
    ]);
  });

  test("a 5xx on one variant falls through to a later variant that succeeds", async () => {
    const { calls } = useFetch(async () =>
      calls() === 1
        ? new Response("", { status: 500 })
        : Response.json({ usageBreakdownList: [{ currentUsage: 5, usageLimit: 50 }] }),
    );

    expect(await fetchUsageLimits(auth)).toMatchObject({ usedCount: 5, limitCount: 50 });
    expect(calls()).toBe(2);
  });

  test("an empty 5xx body is reported as the bare HTTP status", async () => {
    useFetch(async () => new Response("", { status: 502 }));

    const error = await fetchUsageLimits(auth).catch((caught: unknown) => caught);

    expect((error as KiroUsageError).message).toContain("HTTP 502: HTTP 502");
  });

  test("the request timeout aborts the in-flight variant and rejects with TimeoutError", async () => {
    const { calls } = useFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );

    const started = Date.now();
    const error = await fetchUsageLimits(auth, { timeoutMs: 25 }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("TimeoutError");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(calls()).toBe(1);
  });

  test("a caller abort surfaces the caller's reason instead of cycling variants", async () => {
    const controller = new AbortController();
    const reason = new Error("client went away");
    const { calls } = useFetch(async (_input, init) => {
      controller.abort(reason);
      throw init?.signal?.reason;
    });

    await expect(
      fetchUsageLimits(auth, { signal: controller.signal, timeoutMs: 1_000 }),
    ).rejects.toBe(reason);
    expect(calls()).toBe(1);
  });

  test("a socket failure on every variant rethrows the last transport error", async () => {
    const { calls } = useFetch(async () => {
      throw Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" });
    });

    const error = await fetchUsageLimits(auth).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ code: "ECONNREFUSED" });
    expect(calls()).toBe(4);
  });
});
