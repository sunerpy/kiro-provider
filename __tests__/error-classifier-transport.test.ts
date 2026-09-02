import { describe, expect, test } from "bun:test";
import {
  classifyError,
  type ErrorClassificationContext,
  isNetworkError,
  isRetryableServerStatus,
  type NormalizedSdkError,
  normalizeSdkError,
} from "../src/core/error-classifier.js";

function context(overrides: Partial<ErrorClassificationContext> = {}): ErrorClassificationContext {
  return {
    accountId: "account-a",
    accountCount: 1,
    retryCount: 0,
    maxRetries: 3,
    serverErrorCount: 0,
    retryDelayMs: 500,
    forcedRefreshAccountIds: new Set<string>(),
    ...overrides,
  };
}

function error(overrides: Partial<NormalizedSdkError> = {}): NormalizedSdkError {
  return { message: "upstream failed", ...overrides };
}

describe("classifyError gateway statuses", () => {
  test.each([502, 503, 504])(
    "treats %i like 500: bounded same-account retry, then switch",
    (status) => {
      expect(classifyError(error({ status }), context({ serverErrorCount: 1 }))).toEqual({
        action: "retry",
        status,
        retryAfterMs: 1_000,
      });
      expect(classifyError(error({ status }), context({ serverErrorCount: 4 }))).toEqual({
        action: "retry",
        status,
        retryAfterMs: 8_000,
      });
      expect(classifyError(error({ status }), context({ serverErrorCount: 5 }))).toEqual({
        action: "switch",
        status,
      });
    },
  );

  test("exposes the retryable server status set for pipeline bookkeeping", () => {
    expect([500, 502, 503, 504].every(isRetryableServerStatus)).toBe(true);
    expect(isRetryableServerStatus(501)).toBe(false);
    expect(isRetryableServerStatus(429)).toBe(false);
    expect(isRetryableServerStatus(undefined)).toBe(false);
  });

  test("still fails statuses outside the retryable set without remapping", () => {
    expect(classifyError(error({ status: 501 }), context())).toEqual({
      action: "fail",
      status: 501,
      terminalStatus: 501,
    });
  });
});

describe("classifyError transport codes", () => {
  test.each([
    "ECONNREFUSED",
    "EAI_AGAIN",
    "EPIPE",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EHOSTUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
  ])("retries %s by code even when the message is opaque", (code) => {
    expect(
      classifyError(error({ code, message: "request failed" }), context({ retryCount: 1 })),
    ).toEqual({ action: "retry", retryAfterMs: 1_000 });
  });

  test("retries a Smithy TimeoutError and a non-caller AbortError", () => {
    expect(
      classifyError(error({ code: "TimeoutError", message: "Request timed out" }), context()),
    ).toEqual({ action: "retry", retryAfterMs: 500 });
    expect(
      classifyError(error({ code: "AbortError", message: "Request aborted" }), context()),
    ).toEqual({ action: "retry", retryAfterMs: 500 });
  });

  test("recognizes 'timed out' and other socket messages when no code exists", () => {
    expect(
      classifyError(error({ message: "Connection timed out after 30000ms" }), context()),
    ).toEqual({ action: "retry", retryAfterMs: 500 });
    expect(
      isNetworkError(error({ message: "getaddrinfo EAI_AGAIN q.us-east-1.amazonaws.com" })),
    ).toBe(true);
    expect(isNetworkError(error({ message: "unexpected parser failure" }))).toBe(false);
  });

  test("fails a transport error once the retry cap is reached", () => {
    expect(classifyError(error({ code: "ECONNREFUSED" }), context({ retryCount: 3 }))).toEqual({
      action: "fail",
      terminalStatus: 500,
    });
  });

  test("does not misread a generic constructor name as a transport code", () => {
    expect(
      classifyError(error({ code: "Error", message: "unexpected parser failure" }), context()),
    ).toEqual({ action: "fail", terminalStatus: 500 });
  });
});

describe("normalizeSdkError cause codes", () => {
  test("lifts the socket code from the cause of a generic fetch failure", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
      code: "ECONNREFUSED",
    });
    const failure = new TypeError("fetch failed", { cause });

    const normalized = normalizeSdkError(failure);

    expect(normalized).toEqual({ message: "fetch failed", code: "ECONNREFUSED" });
    expect(classifyError(normalized, context())).toEqual({
      action: "retry",
      retryAfterMs: 500,
    });
  });

  test("keeps a specific top-level code over the cause", () => {
    const failure = Object.assign(new Error("boom"), {
      name: "ThrottlingException",
      cause: { code: "ECONNRESET" },
    });

    expect(normalizeSdkError(failure).code).toBe("ThrottlingException");
  });

  test("preserves the generic name when no cause code exists", () => {
    expect(normalizeSdkError(new Error("socket closed"))).toEqual({
      message: "socket closed",
      code: "Error",
    });
  });
});
