import { describe, expect, test } from "bun:test";
import {
	classifyError,
	type ErrorClassificationContext,
	type NormalizedSdkError,
	normalizeSdkError,
} from "../src/core/error-classifier.js";

function context(
	overrides: Partial<ErrorClassificationContext> = {},
): ErrorClassificationContext {
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

function error(
	overrides: Partial<NormalizedSdkError> = {},
): NormalizedSdkError {
	return { message: "upstream failed", ...overrides };
}

describe("normalizeSdkError", () => {
	test("extracts the SDK status, message, code, reason, and response headers", () => {
		// Given
		const sdkError = {
			name: "ThrottlingException",
			message: "slow down",
			reason: "RATE_LIMITED",
			$metadata: { httpStatusCode: 429 },
			$response: {
				headers: { "retry-after": "7", "x-request-id": "request-1" },
			},
		};

		// When
		const normalized = normalizeSdkError(sdkError);

		// Then
		expect(normalized).toEqual({
			status: 429,
			message: "slow down",
			code: "ThrottlingException",
			reason: "RATE_LIMITED",
			headers: { "retry-after": "7", "x-request-id": "request-1" },
		});
	});

	test("provides an Error message without inventing optional SDK fields", () => {
		// Given
		const sdkError = new Error("socket closed");

		// When
		const normalized = normalizeSdkError(sdkError);

		// Then
		expect(normalized).toEqual({ message: "socket closed", code: "Error" });
	});

	test("normalizes primitive failures without inventing SDK metadata", () => {
		// Given
		const thrownReason = "connection closed";

		// When
		const normalized = normalizeSdkError(thrownReason);

		// Then
		expect(normalized).toEqual({ message: "connection closed" });
	});

	test("stringifies numeric headers and ignores unsupported header values", () => {
		// Given
		const sdkError = {
			message: "slow down",
			$response: {
				headers: {
					"retry-after": 9,
					ignored: true,
				},
			},
		};

		// When
		const normalized = normalizeSdkError(sdkError);

		// Then
		expect(normalized).toEqual({
			message: "slow down",
			headers: { "retry-after": "9" },
		});
	});

	test("falls back to object stringification when SDK fields are absent", () => {
		// Given
		const sdkError = { $metadata: null, $response: { headers: {} } };

		// When
		const normalized = normalizeSdkError(sdkError);

		// Then
		expect(normalized).toEqual({ message: "[object Object]" });
	});
});

describe("classifyError HTTP decisions", () => {
	test("retries 401 responses until the retry cap", () => {
		expect(
			classifyError(error({ status: 401 }), context({ retryCount: 2 })),
		).toEqual({
			action: "retry",
			status: 401,
		});
		expect(
			classifyError(error({ status: 401 }), context({ retryCount: 3 })),
		).toEqual({
			action: "fail",
			status: 401,
			terminalStatus: 401,
		});
	});

	test("force-refreshes an invalid bearer only once per account", () => {
		// Given
		const forcedRefreshAccountIds = new Set<string>();
		const invalidBearer = error({
			status: 403,
			message: "The bearer token included in the request is invalid",
		});
		const classificationContext = context({
			accountCount: 2,
			forcedRefreshAccountIds,
		});

		// When
		const first = classifyError(invalidBearer, classificationContext);
		const second = classifyError(invalidBearer, classificationContext);

		// Then
		expect(first).toEqual({ action: "refresh-then-retry", status: 403 });
		expect(second).toEqual({ action: "switch", status: 403 });
		expect(forcedRefreshAccountIds).toEqual(new Set(["account-a"]));
	});

	test("fails quota responses without retrying", () => {
		expect(classifyError(error({ status: 402 }), context())).toEqual({
			action: "fail",
			status: 402,
			terminalStatus: 402,
		});
	});

	test("parses retry-after seconds and switches when another account exists", () => {
		expect(
			classifyError(
				error({ status: 429, headers: { "Retry-After": "7" } }),
				context({ accountCount: 2 }),
			),
		).toEqual({ action: "switch", status: 429, retryAfterMs: 7_000 });
	});

	test("waits and retries a rate limit when only one account exists", () => {
		expect(classifyError(error({ status: 429 }), context())).toEqual({
			action: "retry",
			status: 429,
			retryAfterMs: 60_000,
		});
	});

	test("backs off 500 responses four times then switches on the fifth", () => {
		expect(
			classifyError(error({ status: 500 }), context({ serverErrorCount: 1 })),
		).toEqual({
			action: "retry",
			status: 500,
			retryAfterMs: 1_000,
		});
		expect(
			classifyError(error({ status: 500 }), context({ serverErrorCount: 4 })),
		).toEqual({
			action: "retry",
			status: 500,
			retryAfterMs: 8_000,
		});
		expect(
			classifyError(error({ status: 500 }), context({ serverErrorCount: 5 })),
		).toEqual({
			action: "switch",
			status: 500,
		});
	});

	test("remaps only the two explicit context overflow messages from 400 to 413", () => {
		const first = classifyError(
			error({ status: 400, message: "input is too long" }),
			context(),
		);
		const second = classifyError(
			error({ status: 400, message: "CONTENT_LENGTH_EXCEEDS_THRESHOLD" }),
			context(),
		);
		const unrelated = classifyError(
			error({ status: 400, message: "Improperly formed request." }),
			context(),
		);

		expect(first).toEqual({ action: "fail", status: 400, terminalStatus: 413 });
		expect(second).toEqual({
			action: "fail",
			status: 400,
			terminalStatus: 413,
		});
		expect(unrelated).toEqual({
			action: "fail",
			status: 400,
			terminalStatus: 400,
		});
	});

	test("fails an invalid model with its upstream status", () => {
		expect(
			classifyError(
				error({ status: 403, reason: "INVALID_MODEL_ID" }),
				context(),
			),
		).toEqual({ action: "fail", status: 403, terminalStatus: 403 });
	});

	test("switches permanently suspended accounts when an alternative exists", () => {
		expect(
			classifyError(
				error({ status: 403, reason: "TEMPORARILY_SUSPENDED" }),
				context({ accountCount: 2 }),
			),
			).toEqual({ action: "switch", status: 403 });
	});

	test("fails an invalid model without a status as a bad request", () => {
		expect(
			classifyError(error({ reason: "INVALID_MODEL_ID" }), context()),
		).toEqual({ action: "fail", status: 400, terminalStatus: 400 });
	});

	test("fails a suspended account when no alternative exists", () => {
		expect(
			classifyError(
				error({ reason: "TEMPORARILY_SUSPENDED" }),
				context({ accountCount: 1 }),
			),
		).toEqual({ action: "fail", terminalStatus: 403 });
	});

	test("fails an invalid bearer after its one forced refresh on a single account", () => {
		// Given
		const invalidBearer = error({
			status: 403,
			message: "The bearer token included in the request is invalid",
		});
		const classificationContext = context({
			forcedRefreshAccountIds: new Set(["account-a"]),
		});

		// When
		const classification = classifyError(
			invalidBearer,
			classificationContext,
		);

		// Then
		expect(classification).toEqual({
			action: "fail",
			status: 403,
			terminalStatus: 403,
		});
	});

	test("switches a non-bearer 403 when another account exists", () => {
		expect(
			classifyError(
				error({ status: 403, message: "access denied" }),
				context({ accountCount: 2 }),
			),
		).toEqual({ action: "switch", status: 403 });
	});

	test("backs off a non-bearer 403 until the retry cap", () => {
		expect(
			classifyError(
				error({ status: 403, message: "access denied" }),
				context({ retryCount: 2, retryDelayMs: 250 }),
			),
		).toEqual({ action: "retry", status: 403, retryAfterMs: 1_000 });
		expect(
			classifyError(
				error({ status: 403, message: "access denied" }),
				context({ retryCount: 3 }),
			),
		).toEqual({ action: "fail", status: 403, terminalStatus: 403 });
	});

	test("fails unrecognized HTTP statuses without remapping them", () => {
		expect(classifyError(error({ status: 418 }), context())).toEqual({
			action: "fail",
			status: 418,
			terminalStatus: 418,
		});
	});
});

describe("classifyError network decisions", () => {
	test("retries network failures with exponential backoff", () => {
		expect(
			classifyError(
				error({ message: "fetch failed: ECONNRESET" }),
				context({ retryCount: 2 }),
			),
		).toEqual({ action: "retry", retryAfterMs: 2_000 });
	});

	test("fails non-network errors without an HTTP status", () => {
		expect(
			classifyError(error({ message: "unexpected parser failure" }), context()),
		).toEqual({
			action: "fail",
			terminalStatus: 500,
		});
	});

	test("fails a network error after the retry cap", () => {
		expect(
			classifyError(
				error({ message: "socket disconnected" }),
				context({ retryCount: 3 }),
			),
		).toEqual({ action: "fail", terminalStatus: 500 });
	});
});
