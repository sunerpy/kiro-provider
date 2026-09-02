/**
 * Error-to-reason helpers shared by the refresh, maintenance, and quota-probe
 * paths. The reason string feeds isRefreshTokenDead / toDeadReason and is what
 * gets persisted as an account's unhealthy_reason, so every caller must derive
 * it identically: `<code>: <message>` when the error carries a string code
 * (KiroTokenRefreshError, Node system errors), otherwise the bare message.
 * Non-string codes (DOMException.code is a number) are ignored.
 */
export function errorCode(error: unknown): string | undefined {
	return typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
		? error.code
		: undefined;
}

export function errorReason(error: unknown): string {
	const code = errorCode(error);
	const message = error instanceof Error ? error.message : String(error);
	return code ? `${code}: ${message}` : message;
}

export type ErrorAuditFields = Readonly<
	Record<string, string | number | boolean | null | undefined>
>;

/** Audit-log fields for a failure: the error class name and its string code. */
export function errorFields(error: unknown): ErrorAuditFields {
	return {
		error_name: error instanceof Error ? error.name : "UnknownError",
		error_code: errorCode(error),
	};
}
