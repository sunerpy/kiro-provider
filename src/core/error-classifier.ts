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
	readonly forcedRefreshAccountIds: Set<string>;
}

export type ErrorClassification = {
	readonly action: "retry" | "switch" | "refresh-then-retry" | "fail";
	readonly status?: number;
	readonly retryAfterMs?: number;
	readonly terminalStatus?: number;
};

const KIRO_CONTEXT_OVERFLOW_PATTERNS = [
	/input is too long/i,
	/CONTENT_LENGTH_EXCEEDS_THRESHOLD/i,
] as const;
const NETWORK_ERROR_PATTERN =
	/econnreset|etimedout|enotfound|network|fetch failed|socket/i;

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

export function normalizeSdkError(error: unknown): NormalizedSdkError {
	if (!isRecord(error)) {
		return { message: error instanceof Error ? error.message : String(error) };
	}

	const status = readStatus(error);
	const message = readString(error, "message") ?? String(error);
	const code = readString(error, "name");
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
			return context.retryCount < context.maxRetries
				? { action: "retry", status: 401 }
				: { action: "fail", status: 401, terminalStatus: 401 };
		case 402:
			return { action: "fail", status: 402, terminalStatus: 402 };
		case 403:
			if (isAccessTokenError(error.message)) {
				if (!context.forcedRefreshAccountIds.has(context.accountId)) {
					context.forcedRefreshAccountIds.add(context.accountId);
					return { action: "refresh-then-retry", status: 403 };
				}
				return context.accountCount > 1
					? { action: "switch", status: 403 }
					: { action: "fail", status: 403, terminalStatus: 403 };
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
			return context.accountCount > 1
				? { action: "switch", status: 429, retryAfterMs: waitMs }
				: { action: "retry", status: 429, retryAfterMs: waitMs };
		}
		case 500:
			return context.serverErrorCount < 5
				? {
						action: "retry",
						status: 500,
						retryAfterMs:
							1_000 * 2 ** Math.max(0, context.serverErrorCount - 1),
					}
				: { action: "switch", status: 500 };
		case undefined:
			if (NETWORK_ERROR_PATTERN.test(error.message)) {
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
