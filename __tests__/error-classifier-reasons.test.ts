import { describe, expect, test } from "bun:test";
import {
  classifyError,
  type ErrorClassificationContext,
  isQuotaExhaustionClassification,
  type NormalizedSdkError,
  normalizeSdkError,
} from "../src/core/error-classifier.js";

/**
 * Structured SDK `reason` classification. Reasons come from the
 * @aws/codewhisperer-streaming-client enums; the message regexes remain only
 * as a fallback for reason-less bodies (covered in error-classifier.test.ts).
 */

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

function validation(reason: string, status: number | undefined = 400): NormalizedSdkError {
  return {
    message: "Improperly formed request.",
    code: "ValidationException",
    reason,
    ...(status !== undefined ? { status } : {}),
  };
}

function serviceQuota(reason: string, status?: number): NormalizedSdkError {
  return {
    message: "quota exceeded",
    code: "ServiceQuotaExceededException",
    reason,
    ...(status !== undefined ? { status } : {}),
  };
}

describe("ValidationException reasons", () => {
  test.each(["CONTENT_LENGTH_EXCEEDS_THRESHOLD", "PROMPT_TOO_LONG"])(
    "%s is the context overflow path: terminal 413 with context_length_exceeded",
    (reason) => {
      expect(classifyError(validation(reason), context({ accountCount: 3 }))).toEqual({
        action: "fail",
        status: 400,
        terminalStatus: 413,
        code: "context_length_exceeded",
      });
    },
  );

  test("THINKING_SIGNATURE_INVALID yields the same code as the pipeline's message special-case", () => {
    expect(
      classifyError(
        validation("THINKING_SIGNATURE_INVALID"),
        context({ accountCount: 2, forcedRefreshAccountIds: new Set(["account-a"]) }),
      ),
    ).toEqual({
      action: "fail",
      status: 400,
      terminalStatus: 400,
      code: "invalid_reasoning_signature",
    });
  });

  test.each([
    ["TOOL_SCHEMA_INVALID", "invalid_tool_schema"],
    ["TOOL_DUPLICATE", "duplicate_tool"],
    ["TOOL_USE_RESULT_MISMATCH", "tool_result_mismatch"],
    ["INVALID_CONVERSATION_ID", "invalid_conversation_id"],
    ["IMAGE_COUNT_EXCEEDED", "invalid_image"],
    ["IMAGE_DIMENSION_EXCEEDED", "invalid_image"],
    ["IMAGE_FORMAT_UNSUPPORTED", "invalid_image"],
    ["IMAGE_MIME_MISMATCH", "invalid_image"],
    ["IMAGE_SIZE_EXCEEDED", "invalid_image"],
    ["DOCUMENT_COUNT_EXCEEDED", "invalid_document"],
    ["DOCUMENT_DUPLICATE_NAME", "invalid_document"],
    ["DOCUMENT_MAXIMUM_PAGES_EXCEEDED", "invalid_document"],
    ["DOCUMENT_MODEL_NOT_SUPPORTED", "invalid_document"],
    ["DOCUMENT_PASSWORD_PROTECTED", "invalid_document"],
    ["DOCUMENT_SIZE_EXCEEDED", "invalid_document"],
    // Reasons without a dedicated code fall back to their lower-cased enum value.
    ["REQUEST_BODY_INVALID", "request_body_invalid"],
    ["REQUEST_BODY_INVALID_JSON", "request_body_invalid_json"],
    ["TOOL_CONFIG_MISSING", "tool_config_missing"],
    ["INVALID_KMS_GRANT", "invalid_kms_grant"],
  ])("%s is a terminal 400 with code %s even when alternatives exist", (reason, code) => {
    expect(classifyError(validation(reason), context({ accountCount: 4 }))).toEqual({
      action: "fail",
      status: 400,
      terminalStatus: 400,
      code,
    });
  });

  test("a reason unknown to the SDK on a 400 still lower-cases into a code", () => {
    expect(classifyError(validation("SOMETHING_NEW"), context())).toEqual({
      action: "fail",
      status: 400,
      terminalStatus: 400,
      code: "something_new",
    });
  });

  test("a known validation reason without an HTTP status still maps as a client error", () => {
    // Exceptions delivered inside an open event stream carry no $metadata status.
    expect(classifyError(validation("TOOL_SCHEMA_INVALID", undefined), context())).toEqual({
      action: "fail",
      status: 400,
      terminalStatus: 400,
      code: "invalid_tool_schema",
    });
  });

  test("an unknown reason on a non-400 status leaves the status rules in charge", () => {
    expect(
      classifyError(
        {
          status: 429,
          message: "slow down",
          code: "ThrottlingException",
          reason: "DAILY_REQUEST_COUNT",
        },
        context({ accountCount: 2 }),
      ),
    ).toEqual({ action: "switch", status: 429, retryAfterMs: 60_000 });
  });

  test("INVALID_MODEL_ID and TEMPORARILY_SUSPENDED keep their historical results", () => {
    expect(classifyError(validation("INVALID_MODEL_ID", 403), context())).toEqual({
      action: "fail",
      status: 403,
      terminalStatus: 403,
    });
    expect(
      classifyError(
        { status: 403, message: "suspended", reason: "TEMPORARILY_SUSPENDED" },
        context({ accountCount: 2 }),
      ),
    ).toEqual({ action: "switch", status: 403 });
  });
});

describe("ServiceQuotaExceededException reasons", () => {
  test("MONTHLY_REQUEST_COUNT has 402 quota semantics: switch with alternatives, else terminal", () => {
    const switched = classifyError(
      serviceQuota("MONTHLY_REQUEST_COUNT", 402),
      context({ accountCount: 2 }),
    );
    const terminal = classifyError(serviceQuota("MONTHLY_REQUEST_COUNT", 402), context());

    expect(switched).toEqual({ action: "switch", status: 402, code: "monthly_request_limit" });
    expect(terminal).toEqual({
      action: "fail",
      status: 402,
      terminalStatus: 402,
      code: "monthly_request_limit",
    });
    expect(isQuotaExhaustionClassification(switched)).toBe(true);
    expect(isQuotaExhaustionClassification(terminal)).toBe(true);
  });

  test("OVERAGE_REQUEST_LIMIT_EXCEEDED is quota exhaustion with its own code", () => {
    expect(
      classifyError(
        serviceQuota("OVERAGE_REQUEST_LIMIT_EXCEEDED", 402),
        context({ accountCount: 2 }),
      ),
    ).toEqual({ action: "switch", status: 402, code: "overage_request_limit" });
    expect(classifyError(serviceQuota("OVERAGE_REQUEST_LIMIT_EXCEEDED", 402), context())).toEqual({
      action: "fail",
      status: 402,
      terminalStatus: 402,
      code: "overage_request_limit",
    });
  });

  test("CONVERSATION_LIMIT_EXCEEDED is a client error, not an account problem", () => {
    const classification = classifyError(
      serviceQuota("CONVERSATION_LIMIT_EXCEEDED", 402),
      context({ accountCount: 3 }),
    );

    expect(classification).toEqual({
      action: "fail",
      status: 402,
      terminalStatus: 400,
      code: "conversation_limit_exceeded",
    });
    expect(isQuotaExhaustionClassification(classification)).toBe(false);
  });

  test("classifies by exception name when $metadata.httpStatusCode is missing", () => {
    expect(
      classifyError(serviceQuota("MONTHLY_REQUEST_COUNT"), context({ accountCount: 2 })),
    ).toEqual({ action: "switch", status: 402, code: "monthly_request_limit" });
    expect(classifyError(serviceQuota("OVERAGE_REQUEST_LIMIT_EXCEEDED"), context())).toEqual({
      action: "fail",
      status: 402,
      terminalStatus: 402,
      code: "overage_request_limit",
    });
    expect(classifyError(serviceQuota("CONVERSATION_LIMIT_EXCEEDED"), context())).toEqual({
      action: "fail",
      status: 400,
      terminalStatus: 400,
      code: "conversation_limit_exceeded",
    });
  });

  test("MONTHLY_REQUEST_COUNT on a ThrottlingException keeps the 429 semantics", () => {
    // The reason value is shared with ThrottlingExceptionReason.
    expect(
      classifyError(
        {
          status: 429,
          message: "slow down",
          code: "ThrottlingException",
          reason: "MONTHLY_REQUEST_COUNT",
          headers: { "retry-after": "5" },
        },
        context(),
      ),
    ).toEqual({ action: "retry", status: 429, retryAfterMs: 5_000 });
  });

  test("a bare 402 without a reason keeps its code-less classification", () => {
    const classification = classifyError({ status: 402, message: "payment required" }, context());
    expect(classification).toEqual({ action: "fail", status: 402, terminalStatus: 402 });
    expect(isQuotaExhaustionClassification(classification)).toBe(true);
  });
});

describe("normalizeSdkError cause walking", () => {
  test("finds the exception name and reason through a generic wrapper without a status", () => {
    const upstream = Object.assign(new Error("Monthly request limit reached"), {
      name: "ServiceQuotaExceededException",
      reason: "MONTHLY_REQUEST_COUNT",
    });
    const wrapped = new Error("stream failed", { cause: upstream });

    const normalized = normalizeSdkError(wrapped);

    expect(normalized).toEqual({
      message: "stream failed",
      code: "ServiceQuotaExceededException",
      reason: "MONTHLY_REQUEST_COUNT",
    });
    expect(classifyError(normalized, context({ accountCount: 2 }))).toEqual({
      action: "switch",
      status: 402,
      code: "monthly_request_limit",
    });
  });

  test("reads the status from a cause that carries $metadata", () => {
    const upstream = Object.assign(new Error("bad tool"), {
      name: "ValidationException",
      reason: "TOOL_DUPLICATE",
      $metadata: { httpStatusCode: 400 },
    });
    const normalized = normalizeSdkError(new TypeError("wrapped", { cause: upstream }));

    expect(normalized).toEqual({
      status: 400,
      message: "wrapped",
      code: "ValidationException",
      reason: "TOOL_DUPLICATE",
    });
  });

  test("survives a cyclic cause chain", () => {
    const first: Record<string, unknown> = { name: "Error", message: "first" };
    const second: Record<string, unknown> = { name: "Error", message: "second", cause: first };
    first.cause = second;

    expect(normalizeSdkError(first)).toEqual({ message: "first", code: "Error" });
  });
});

describe("reason-less message fallbacks", () => {
  test("the legacy thinking-signature message yields the same code as the structured reason", () => {
    expect(
      classifyError(
        { status: 400, message: "ValidationException: Invalid `signature` in `thinking` block" },
        context(),
      ),
    ).toEqual({
      action: "fail",
      status: 400,
      terminalStatus: 400,
      code: "invalid_reasoning_signature",
    });
  });
});
