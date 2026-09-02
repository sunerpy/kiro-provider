import { describe, expect, test } from "bun:test";
import {
	classifyError,
	type ErrorClassificationContext,
	type NormalizedSdkError,
} from "../src/core/error-classifier.js";

/**
 * C6: classifyError must not mutate its context. The forced-refresh
 * bookkeeping belongs to the pipeline, which records the account id returned
 * on a `refresh-then-retry` decision.
 */

function context(
	overrides: Partial<ErrorClassificationContext> = {},
): ErrorClassificationContext {
	return {
		accountId: "account-a",
		accountCount: 2,
		retryCount: 0,
		maxRetries: 3,
		serverErrorCount: 0,
		retryDelayMs: 500,
		forcedRefreshAccountIds: new Set<string>(),
		...overrides,
	};
}

const UNAUTHORIZED: NormalizedSdkError = { status: 401, message: "unauthorized" };
const INVALID_BEARER: NormalizedSdkError = {
	status: 403,
	message: "The bearer token included in the request is invalid",
};

/** A set that fails loudly if the classifier tries to write to it. */
function sealedSet(ids: readonly string[] = []): ReadonlySet<string> {
	const inner = new Set(ids);
	return new Proxy(inner, {
		get(target, key, receiver) {
			if (key === "add" || key === "delete" || key === "clear") {
				return () => {
					throw new Error(`classifier must not call Set.${String(key)}`);
				};
			}
			const value = Reflect.get(target, key, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

describe("classifyError is pure", () => {
	test.each([
		["401", UNAUTHORIZED, 401],
		["invalid-bearer 403", INVALID_BEARER, 403],
	])("returns the account to record for a %s without touching the set", (_label, error, status) => {
		// Given
		const forcedRefreshAccountIds = new Set<string>();

		// When
		const classification = classifyError(error, context({ forcedRefreshAccountIds }));

		// Then
		expect(classification).toEqual({
			action: "refresh-then-retry",
			status,
			forcedRefreshAccountId: "account-a",
		});
		expect(forcedRefreshAccountIds.size).toBe(0);
	});

	test("never writes to the forced-refresh set on any credential path", () => {
		expect(() =>
			classifyError(UNAUTHORIZED, context({ forcedRefreshAccountIds: sealedSet() })),
		).not.toThrow();
		expect(() =>
			classifyError(
				INVALID_BEARER,
				context({ forcedRefreshAccountIds: sealedSet(["account-a"]) }),
			),
		).not.toThrow();
	});

	test("is idempotent until the caller records the decision", () => {
		// Given
		const forcedRefreshAccountIds = new Set<string>();
		const classificationContext = context({ forcedRefreshAccountIds });

		// When
		const first = classifyError(UNAUTHORIZED, classificationContext);
		const repeated = classifyError(UNAUTHORIZED, classificationContext);

		// Then: no hidden state changed between the two identical calls.
		expect(repeated).toEqual(first);
		expect(first.action).toBe("refresh-then-retry");
	});

	test("switches or fails once the caller has recorded the forced refresh", () => {
		// Given
		const first = classifyError(UNAUTHORIZED, context());
		if (first.action !== "refresh-then-retry") {
			throw new Error(`expected refresh-then-retry, got ${first.action}`);
		}
		const recorded = new Set([first.forcedRefreshAccountId]);

		// When
		const withAlternative = classifyError(
			UNAUTHORIZED,
			context({ accountCount: 2, forcedRefreshAccountIds: recorded }),
		);
		const lastAccount = classifyError(
			INVALID_BEARER,
			context({ accountCount: 1, forcedRefreshAccountIds: recorded }),
		);

		// Then
		expect(withAlternative).toEqual({ action: "switch", status: 401 });
		expect(lastAccount).toEqual({ action: "fail", status: 403, terminalStatus: 403 });
	});

	test("scopes the forced refresh to the failing account", () => {
		// Given: account-b was refreshed earlier in the request, account-a was not.
		const recorded = new Set(["account-b"]);

		// When
		const classification = classifyError(
			UNAUTHORIZED,
			context({ accountId: "account-a", forcedRefreshAccountIds: recorded }),
		);

		// Then
		expect(classification).toEqual({
			action: "refresh-then-retry",
			status: 401,
			forcedRefreshAccountId: "account-a",
		});
		expect(recorded).toEqual(new Set(["account-b"]));
	});
});
