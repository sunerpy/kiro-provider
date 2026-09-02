import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  authorizeKiroIDC,
  IDC_REQUEST_TIMEOUT_MS,
  pollKiroIDCToken,
} from "../src/kiro/oauth-idc.js";

type CapturedRequest = {
  readonly url: string;
  readonly init?: RequestInit;
};

const realFetch = globalThis.fetch;
const immediateSleep = async (): Promise<void> => undefined;

function installFetch(
  responder: (request: CapturedRequest, index: number) => Response | Promise<Response>,
): CapturedRequest[] {
  const calls: CapturedRequest[] = [];
  const requestMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const request: CapturedRequest = {
      url: typeof input === "string" ? input : String(input),
      ...(init ? { init } : {}),
    };
    const index = calls.length;
    calls.push(request);
    return responder(request, index);
  });
  globalThis.fetch = Object.assign(requestMock, { preconnect: realFetch.preconnect });
  return calls;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("per-request timeouts", () => {
  test("uses a 30 second per-request deadline", () => {
    expect(IDC_REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  test("attaches an AbortSignal to client registration and device authorization", async () => {
    const calls = installFetch((_request, index) =>
      index === 0
        ? json({ clientId: "c", clientSecret: "s" })
        : json({
            verificationUri: "u",
            verificationUriComplete: "uc",
            userCode: "code",
            deviceCode: "dc",
          }),
    );

    await authorizeKiroIDC("us-east-1");

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
      expect(call.init?.signal?.aborted).toBe(false);
    }
  });

  test("attaches a fresh AbortSignal to every token poll", async () => {
    const calls = installFetch((_request, index) =>
      index === 0
        ? json({ error: "authorization_pending" })
        : json({ access_token: "a", refresh_token: "r" }),
    );

    await pollKiroIDCToken("client", "secret", "device", 5, 600, "us-east-1", immediateSleep);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[1]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.init?.signal).not.toBe(calls[1]?.init?.signal);
  });
});

describe("token polling transient failures", () => {
  test("keeps polling after a network error and returns the issued tokens", async () => {
    const calls = installFetch((_request, index) => {
      if (index === 0) throw new TypeError("fetch failed: ECONNRESET");
      if (index === 1) {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }
      if (index === 2) return json({ error: "authorization_pending" });
      return json({ access_token: "idc-access", refresh_token: "idc-refresh" });
    });

    const result = await pollKiroIDCToken(
      "client",
      "secret",
      "device",
      5,
      600,
      "us-east-1",
      immediateSleep,
    );

    expect(calls).toHaveLength(4);
    expect(result).toMatchObject({ accessToken: "idc-access", refreshToken: "idc-refresh" });
  });

  test("gives up after the device-code budget when every poll fails on the network", async () => {
    const calls = installFetch(() => {
      throw new TypeError("fetch failed: ENOTFOUND");
    });

    await expect(
      pollKiroIDCToken("client", "secret", "device", 5, 20, "us-east-1", immediateSleep),
    ).rejects.toThrow(/timed out after repeated network failures.*ENOTFOUND/);
    expect(calls).toHaveLength(4);
  });

  test("waits between polls after a network error", async () => {
    const sleeps: number[] = [];
    installFetch((_request, index) => {
      if (index === 0) throw new TypeError("fetch failed");
      return json({ access_token: "a", refresh_token: "r" });
    });

    await pollKiroIDCToken("client", "secret", "device", 5, 600, "us-east-1", async (ms) => {
      sleeps.push(ms);
    });

    expect(sleeps).toEqual([5_000, 5_000]);
  });

  test("still honors slow_down and terminal OAuth errors after a network error", async () => {
    const sleeps: number[] = [];
    installFetch((_request, index) => {
      if (index === 0) throw new TypeError("fetch failed");
      if (index === 1) return json({ error: "slow_down" });
      return json({ accessToken: "a", refreshToken: "r" });
    });

    await expect(
      pollKiroIDCToken("client", "secret", "device", 5, 600, "us-east-1", async (ms) => {
        sleeps.push(ms);
      }),
    ).resolves.toMatchObject({ accessToken: "a" });
    expect(sleeps).toEqual([5_000, 5_000, 10_000]);

    installFetch((_request, index) =>
      index === 0
        ? Promise.reject(new TypeError("fetch failed"))
        : json({ error: "access_denied" }),
    );
    await expect(
      pollKiroIDCToken("client", "secret", "device", 5, 600, "us-east-1", immediateSleep),
    ).rejects.toThrow("Authorization was denied");
  });

  test("does not swallow malformed responses as transient failures", async () => {
    installFetch(() => new Response("<html>", { status: 502 }));

    await expect(
      pollKiroIDCToken("client", "secret", "device", 5, 600, "us-east-1", immediateSleep),
    ).rejects.toThrow("invalid JSON response (HTTP 502)");
  });
});
