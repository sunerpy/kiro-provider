import { describe, expect, test } from "bun:test";
import { errorCode, errorFields, errorReason } from "../src/core/account-errors.js";
import { KiroTokenRefreshError } from "../src/kiro/errors.js";

describe("account error reasons", () => {
  test("prefix the message with a string code and ignore every other code shape", () => {
    expect(errorReason(new KiroTokenRefreshError("Refresh failed: nope", "invalid_grant"))).toBe(
      "invalid_grant: Refresh failed: nope",
    );
    expect(errorReason(new KiroTokenRefreshError("Refresh failed: nope"))).toBe(
      "Refresh failed: nope",
    );
    expect(errorReason(Object.assign(new Error("system"), { code: "ECONNRESET" }))).toBe(
      "ECONNRESET: system",
    );
    expect(errorReason(new DOMException("The operation was aborted", "AbortError"))).toBe(
      "The operation was aborted",
    );
    expect(errorReason(Object.assign(new Error("numeric"), { code: 429 }))).toBe("numeric");
    expect(errorReason(Object.assign(new Error("empty"), { code: "" }))).toBe("empty");
    expect(errorReason("plain string")).toBe("plain string");
    expect(errorReason(undefined)).toBe("undefined");
  });

  test("expose the string code and audit fields", () => {
    expect(errorCode(new KiroTokenRefreshError("x", "HTTP_502"))).toBe("HTTP_502");
    expect(errorCode(new Error("x"))).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
    expect(errorFields(new KiroTokenRefreshError("x", "HTTP_502"))).toEqual({
      error_name: "KiroTokenRefreshError",
      error_code: "HTTP_502",
    });
    expect(errorFields(new RangeError("x"))).toEqual({
      error_name: "RangeError",
      error_code: undefined,
    });
    expect(errorFields({ code: "PLAIN_OBJECT_CODE" })).toEqual({
      error_name: "UnknownError",
      error_code: "PLAIN_OBJECT_CODE",
    });
  });
});
