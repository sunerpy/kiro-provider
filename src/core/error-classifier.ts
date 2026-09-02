import { isAccessTokenError } from "../kiro/health.js";

export interface NormalizedSdkError {
	readonly status?: number;
	readonly message: string;
	readonly code?: string;
	readonly reason?: string;
	readonly headers?: Readonly<Record<string, string>>;
}

export interface ErrorClassificationContext {
	readonly accountId: string;
	readonly accountCount: number;
	readonly retryCount: number;
	readonly maxRetries: number;
	readonly serverErrorCount: number;
	readonly retryDelayMs: number;
	/**
	 * Accounts already force-refreshed during this request. The classifier only
	 * reads this set; the caller records `forcedRefreshAccountId` from a
	 * `refresh-then-retry` decision before acting on it.
	 */
	readonly forcedRefreshAccountIds: ReadonlySet<string>;
}

export type ErrorClassification =
	| {
			readonly action: "retry" | "switch" | "fail";
			readonly status?: number;
			readonly retryAfterMs?: number;
			readonly terminalStatus?: number;
	  }
	| {
			/** Force one token refresh for the account, then retry on it. */
			readonly action: "refresh-then-retry";
			readonly status: number;
			/** Account the caller must add to `forcedRefreshAccountIds`. */
			readonly forcedRefreshAccountId: string;
	  };

const KIRO_CONTEXT_OVERFLOW_PATTERNS = [
	/input is too long/i,
	/CONTENT_LENGTH_EXCEEDS_THRESHOLD/i,
] as const;
/**
 * Transport-level failure codes. Node/Bun socket errors expose `code`; Smithy's
 * NodeHttpHandler reports its request/connection timeout as `name: "TimeoutError"`
 * and an aborted socket as `name: "AbortError"`. The pipeline checks its own
 * deadline and cancellation signals before classifying, so an AbortError that
 * reaches this classifier did not originate from the caller.
 */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ECONNABORTED",
	"ETIMEDOUT",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EPIPE",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ENETDOWN",
	"UND_ERR_SOCKET",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"TimeoutError",
	"AbortError",
]);
/** Message fallback for transports that only expose free text. */
const NETWORK_ERROR_PATTERN =
	/econnreset|econnrefused|etimedout|enotfound|eai_again|epipe|ehostunreach|enetunreach|timed out|network|fetch failed|socket/i;
/** Constructor names that carry no classification signal on their own. */
const GENERIC_ERROR_NAMES: ReadonlySet<string> = new Set(["Error", "TypeError"]);
/** Upstream statuses that are retried on the same account before switching. */
const RETRYABLE_SERVER_STATUSES: ReadonlySet<number> = new Set([
	500, 502, 503, 504,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function readStatus(record: Record<string, unknown>): number | undefined {
	const metadata = record.$metadata;
	if (!isRecord(metadata)) return undefined;
	const status = metadata.httpStatusCode;
	return typeof status === "number" ? status : undefined;
}

function readHeaders(
	record: Record<string, unknown>,
): Readonly<Record<string, string>> | undefined {
	const response = record.$response;
	if (!isRecord(response)) return undefined;
	const candidate = response.headers;
	if (!isRecord(candidate)) return undefined;

	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(candidate)) {
		if (typeof value === "string") headers[key] = value;
		else if (typeof value === "number") headers[key] = String(value);
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * Prefer the error's own `code`/`name`; when that is only a generic constructor
 * name (Bun's `TypeError: fetch failed`, Smithy wrappers), fall back to the
 * socket-level `cause` so ECONNREFUSED and friends stay classifiable.
 */
function readCode(record: Record<string, unknown>): string | undefined {
	const own = readString(record, "code") ?? readString(record, "name");
	if (own !== undefined && !GENERIC_ERROR_NAMES.has(own)) return own;
	const cause = record.cause;
	if (isRecord(cause)) {
		const causeCode = readString(cause, "code") ?? readString(cause, "name");
		if (causeCode !== undefined && !GENERIC_ERROR_NAMES.has(causeCode)) {
			return causeCode;
		}
	}
	return own;
}

export function normalizeSdkError(error: unknown): NormalizedSdkError {
	if (!isRecord(error)) {
		return { message: error instanceof Error ? error.message : String(error) };
	}

	const status = readStatus(error);
	const message = readString(error, "message") ?? String(error);
	const code = readCode(error);
	const reason = readString(error, "reason");
	const headers = readHeaders(error);
	return {
		message,
		...(status !== undefined ? { status } : {}),
		...(code !== undefined ? { code } : {}),
		...(reason !== undefined ? { reason } : {}),
		...(headers !== undefined ? { headers } : {}),
	};
}

function retryAfterMs(
	headers: Readonly<Record<string, string>> | undefined,
): number {
	const entry = Object.entries(headers ?? {}).find(
		([name]) => name.toLowerCase() === "retry-after",
	);
	const seconds = Number.parseInt(entry?.[1] ?? "60", 10);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : 60_000;
}

export function isKiroContextOverflowBody(message: string): boolean {
	return KIRO_CONTEXT_OVERFLOW_PATTERNS.some((pattern) =>
		pattern.test(message),
	);
}

/** 500/502/503/504: bounded same-account retry, then switch accounts. */
export function isRetryableServerStatus(status: number | undefined): boolean {
	return status !== undefined && RETRYABLE_SERVER_STATUSES.has(status);
}

/** Transport failure without an upstream HTTP status. */
export function isNetworkError(error: NormalizedSdkError): boolean {
	if (error.code !== undefined && NETWORK_ERROR_CODES.has(error.code)) return true;
	return NETWORK_ERROR_PATTERN.test(error.message);
}

/**
 * 401 or invalid-bearer 403: one forced token refresh per account per request,
 * then switch accounts or fail. Pure: classifying the same rejection twice
 * without the caller recording the first decision yields the same decision.
 */
function classifyRejectedCredentials(
	status: 401 | 403,
	context: ErrorClassificationContext,
): ErrorClassification {
	if (!context.forcedRefreshAccountIds.has(context.accountId)) {
		return {
			action: "refresh-then-retry",
			status,
			forcedRefreshAccountId: context.accountId,
		};
	}
	return context.accountCount > 1
		? { action: "switch", status }
		: { action: "fail", status, terminalStatus: status };
}

export function classifyError(
	error: NormalizedSdkError,
	context: ErrorClassificationContext,
): ErrorClassification {
	if (error.reason === "INVALID_MODEL_ID") {
		const status = error.status ?? 400;
		return { action: "fail", status, terminalStatus: status };
	}

	if (error.reason === "TEMPORARILY_SUSPENDED") {
		return context.accountCount > 1
			? {
					action: "switch",
					...(error.status !== undefined ? { status: error.status } : {}),
				}
			: {
					action: "fail",
					...(error.status !== undefined ? { status: error.status } : {}),
					terminalStatus: error.status ?? 403,
				};
	}

	switch (error.status) {
			case 400:
				return {
					action: "fail",
					status: 400,
					terminalStatus: isKiroContextOverflowBody(error.message) ? 413 : 400,
				};
			case 401:
				return classifyRejectedCredentials(401, context);
			case 402:
				return context.accountCount > 1
					? { action: "switch", status: 402 }
					: { action: "fail", status: 402, terminalStatus: 402 };
		case 403:
			if (isAccessTokenError(error.message)) {
				return classifyRejectedCredentials(403, context);
			}
			if (context.accountCount > 1) return { action: "switch", status: 403 };
			return context.retryCount < context.maxRetries
				? {
						action: "retry",
						status: 403,
						retryAfterMs: context.retryDelayMs * 2 ** context.retryCount,
					}
				: { action: "fail", status: 403, terminalStatus: 403 };
		case 429: {
			const waitMs = retryAfterMs(error.headers);
			if (context.accountCount > 1) {
				return { action: "switch", status: 429, retryAfterMs: waitMs };
			}
			// Bounded by rate_limit_max_retries so the client sees the upstream 429
			// instead of a deadline-induced 504 after repeated 60 s waits.
			return context.retryCount < context.maxRetries
				? { action: "retry", status: 429, retryAfterMs: waitMs }
				: { action: "fail", status: 429, terminalStatus: 429 };
		}
		case 500:
		case 502:
		case 503:
		case 504:
			return context.serverErrorCount < 5
				? {
						action: "retry",
						status: error.status,
						retryAfterMs:
							1_000 * 2 ** Math.max(0, context.serverErrorCount - 1),
					}
				: { action: "switch", status: error.status };
		case undefined:
			if (isNetworkError(error)) {
				return context.retryCount < context.maxRetries
					? {
							action: "retry",
							retryAfterMs: context.retryDelayMs * 2 ** context.retryCount,
						}
					: { action: "fail", terminalStatus: 500 };
			}
			return { action: "fail", terminalStatus: 500 };
		default:
			return {
				action: "fail",
				status: error.status,
				terminalStatus: error.status,
			};
	}
}
