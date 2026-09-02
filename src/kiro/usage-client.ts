import { z } from "zod";
import { fetchProxyOption } from "../core/proxy.js";
import { buildUrl, KIRO_CONSTANTS } from "./constants.js";
import { isAccessTokenError } from "./health.js";
import type { KiroAuthDetails, KiroUsageSnapshot } from "./types.js";

const UsageLimitsResponseSchema = z
	.object({
		usageBreakdownList: z
			.array(
				z
					.object({
						currentUsage: z.number().optional(),
						usageLimit: z.number().optional(),
						currentOverages: z.number().optional(),
						freeTrialInfo: z
							.object({
								currentUsage: z.number().optional(),
								usageLimit: z.number().optional(),
							})
							.passthrough()
							.nullable()
							.optional(),
					})
					.passthrough(),
			)
			.optional(),
		userInfo: z
			.object({ email: z.string().optional() })
			.passthrough()
			.optional(),
	})
	.passthrough();

interface UsageAttempt {
	readonly resourceType?: string;
	readonly origin?: string;
}

const USAGE_ATTEMPTS: readonly UsageAttempt[] = [
	{ resourceType: "AGENTIC_REQUEST", origin: "AI_EDITOR" },
	{ origin: "AI_EDITOR" },
	{ resourceType: "CONVERSATION", origin: "AI_EDITOR" },
	{},
];

export class KiroUsageError extends Error {
	readonly name = "KiroUsageError";

	constructor(
		message: string,
		readonly status?: number,
		readonly upstreamCode?: string,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("Kiro usage request was aborted", "AbortError");
}

function responseRequestId(response: Response): string | undefined {
	return (
		response.headers.get("x-amzn-requestid") ??
		response.headers.get("x-amzn-request-id") ??
		response.headers.get("x-amz-request-id") ??
		undefined
	);
}

function responseErrorType(response: Response): string | undefined {
	return (
		response.headers.get("x-amzn-errortype") ??
		response.headers.get("x-amzn-error-type") ??
		undefined
	);
}

function parseUsagePayload(value: unknown): KiroUsageSnapshot {
	const parsed = UsageLimitsResponseSchema.safeParse(value);
	if (!parsed.success) {
		throw new KiroUsageError("Kiro usage service returned an invalid response shape");
	}

	let usedCount = 0;
	let limitCount = 0;
	let overageCount = 0;
	for (const segment of parsed.data.usageBreakdownList ?? []) {
		if (segment.freeTrialInfo) {
			usedCount += segment.freeTrialInfo.currentUsage ?? 0;
			limitCount += segment.freeTrialInfo.usageLimit ?? 0;
		}
		usedCount += segment.currentUsage ?? 0;
		limitCount += segment.usageLimit ?? 0;
		overageCount += segment.currentOverages ?? 0;
	}

	return {
		usedCount,
		limitCount,
		overageCount,
		...(parsed.data.userInfo?.email
			? { email: parsed.data.userInfo.email }
			: {}),
	};
}

export function isKiroUsageAuthenticationError(error: unknown): boolean {
	return (
		error instanceof KiroUsageError &&
		(error.status === 401 ||
			(error.status === 403 && isAccessTokenError(error.message)))
	);
}

export async function fetchUsageLimits(
	auth: KiroAuthDetails,
	options: {
		readonly proxyUrl?: string;
		readonly signal?: AbortSignal;
		readonly timeoutMs?: number;
	} = {},
): Promise<KiroUsageSnapshot> {
	const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 10_000);
	const signal =
		options.signal === undefined
			? timeoutSignal
			: AbortSignal.any([options.signal, timeoutSignal]);
	let lastError: Error | undefined;

	for (const [index, params] of USAGE_ATTEMPTS.entries()) {
		if (signal.aborted) throw abortReason(signal);
		const endpoint = new URL(
			buildUrl(KIRO_CONSTANTS.USAGE_LIMITS_URL, auth.region),
		);
		endpoint.searchParams.set("isEmailRequired", "true");
		if (params.origin) endpoint.searchParams.set("origin", params.origin);
		if (params.resourceType) {
			endpoint.searchParams.set("resourceType", params.resourceType);
		}
		if (auth.profileArn) {
			endpoint.searchParams.set("profileArn", auth.profileArn);
		}

		let response: Response;
		try {
			response = await fetch(endpoint, {
				method: "GET",
				signal,
				headers: {
					Authorization: `Bearer ${auth.access}`,
					"Content-Type": "application/json",
					"x-amzn-kiro-agent-mode": "vibe",
					"amz-sdk-request": "attempt=1; max=1",
				},
				...fetchProxyOption(options.proxyUrl),
			});
		} catch (error) {
			if (signal.aborted) throw abortReason(signal);
			lastError =
				error instanceof Error
					? error
					: new KiroUsageError(String(error));
			continue;
		}

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			const requestId = responseRequestId(response);
			const upstreamCode = responseErrorType(response);
			const detail =
				body.length > 0
					? `${body.slice(0, 2_000)}${body.length > 2_000 ? "…" : ""}`
					: `HTTP ${response.status}`;
			const error = new KiroUsageError(
				`Kiro usage service returned HTTP ${response.status}${
					upstreamCode ? ` (${upstreamCode})` : ""
				}${requestId ? ` [${requestId}]` : ""}: ${detail}`,
				response.status,
				upstreamCode,
			);
			if (
				body.includes("FEATURE_NOT_SUPPORTED") &&
				index < USAGE_ATTEMPTS.length - 1
			) {
				lastError = error;
				continue;
			}
			// Credential failures and throttling apply to every parameter variant;
			// cycling through the remaining ones would only hammer the endpoint.
			if (
				response.status === 401 ||
				response.status === 403 ||
				response.status === 429
			) {
				throw error;
			}
			lastError = error;
			continue;
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			throw new KiroUsageError(
				"Kiro usage service returned invalid JSON",
				response.status,
				undefined,
				{ cause: error },
			);
		}
		return parseUsagePayload(payload);
	}

	throw (
		lastError ??
		new KiroUsageError("All Kiro usage service request variants failed")
	);
}
