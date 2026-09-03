import {
  ServiceQuotaExceededExceptionReason,
  ValidationExceptionReason,
} from "@aws/codewhisperer-streaming-client";
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
      /**
       * Stable client-facing error code derived from the structured SDK
       * `reason` (or, for a few legacy bodies, the message). Absent when the
       * upstream failure carried no classifiable reason; the caller then falls
       * back to the upstream exception name.
       */
      readonly code?: string;
    }
  | {
      /** Force one token refresh for the account, then retry on it. */
      readonly action: "refresh-then-retry";
      readonly status: number;
      /** Account the caller must add to `forcedRefreshAccountIds`. */
      readonly forcedRefreshAccountId: string;
    };

/** Client code for a request that exceeds the model's context window (HTTP 413). */
export const CONTEXT_LENGTH_EXCEEDED_CODE = "context_length_exceeded";
/** Client code for a tampered or foreign thinking signature (HTTP 400). */
export const INVALID_REASONING_SIGNATURE_CODE = "invalid_reasoning_signature";
/** Client code for a conversation that hit Kiro's per-conversation limit (HTTP 400). */
export const CONVERSATION_LIMIT_EXCEEDED_CODE = "conversation_limit_exceeded";
/** Client code for an account whose included monthly request quota is used up (HTTP 402). */
export const MONTHLY_REQUEST_LIMIT_CODE = "monthly_request_limit";
/** Client code for an account whose paid overage allowance is used up (HTTP 402). */
export const OVERAGE_REQUEST_LIMIT_CODE = "overage_request_limit";

/**
 * Classification codes that mean "this account has no quota left". They carry
 * the same switch/fail semantics as a bare upstream 402 and the caller persists
 * the exhaustion for the account exactly as it does for a 402.
 */
export const QUOTA_EXHAUSTION_CODES: ReadonlySet<string> = new Set([
  MONTHLY_REQUEST_LIMIT_CODE,
  OVERAGE_REQUEST_LIMIT_CODE,
]);

const SERVICE_QUOTA_EXCEEDED_EXCEPTION = "ServiceQuotaExceededException";

const KIRO_CONTEXT_OVERFLOW_PATTERNS = [
  /input is too long/i,
  /CONTENT_LENGTH_EXCEEDS_THRESHOLD/i,
] as const;
/** Legacy message form of `THINKING_SIGNATURE_INVALID` for bodies without a reason. */
const INVALID_REASONING_SIGNATURE_PATTERN = /invalid\s+`?signature`?\s+in\s+`?thinking`?\s+block/i;
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
const RETRYABLE_SERVER_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);
/** Bound on `cause` traversal so a cyclic chain cannot hang normalization. */
const MAX_CAUSE_DEPTH = 8;

/**
 * `ValidationException` reasons and their client codes. Two reasons describe a
 * request that does not fit the context window and keep the historical 413;
 * everything else is a plain client input error. Reasons absent from this map
 * (REQUEST_BODY_INVALID, TOOL_CONFIG_MISSING, ...) fall back to their
 * lower-cased enum value.
 */
const VALIDATION_REASON_CODES: ReadonlyMap<string, string> = new Map([
  [ValidationExceptionReason.CONTENT_LENGTH_EXCEEDS_THRESHOLD, CONTEXT_LENGTH_EXCEEDED_CODE],
  [ValidationExceptionReason.PROMPT_TOO_LONG, CONTEXT_LENGTH_EXCEEDED_CODE],
  [ValidationExceptionReason.THINKING_SIGNATURE_INVALID, INVALID_REASONING_SIGNATURE_CODE],
  [ValidationExceptionReason.TOOL_SCHEMA_INVALID, "invalid_tool_schema"],
  [ValidationExceptionReason.TOOL_DUPLICATE, "duplicate_tool"],
  [ValidationExceptionReason.TOOL_USE_RESULT_MISMATCH, "tool_result_mismatch"],
  [ValidationExceptionReason.INVALID_CONVERSATION_ID, "invalid_conversation_id"],
]);
const CONTEXT_OVERFLOW_REASONS: ReadonlySet<string> = new Set([
  ValidationExceptionReason.CONTENT_LENGTH_EXCEEDS_THRESHOLD,
  ValidationExceptionReason.PROMPT_TOO_LONG,
]);
/** Every `ValidationException` reason the SDK declares, for the lower-cased fallback. */
const VALIDATION_REASONS: ReadonlySet<string> = new Set(Object.values(ValidationExceptionReason));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** The error followed by its `cause` chain, outermost first, bounded and cycle-safe. */
function causeChain(record: Record<string, unknown>): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  const seen = new Set<Record<string, unknown>>();
  let current: unknown = record;
  while (isRecord(current) && !seen.has(current) && chain.length < MAX_CAUSE_DEPTH) {
    seen.add(current);
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function readStatus(chain: readonly Record<string, unknown>[]): number | undefined {
  for (const record of chain) {
    const metadata = record.$metadata;
    if (!isRecord(metadata)) continue;
    const status = metadata.httpStatusCode;
    if (typeof status === "number") return status;
  }
  return undefined;
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
 * first specific code along the `cause` chain so ECONNREFUSED and friends, or
 * a wrapped `ServiceQuotaExceededException`, stay classifiable.
 */
function readCode(chain: readonly Record<string, unknown>[]): string | undefined {
  const [own] = chain;
  const ownCode = own ? (readString(own, "code") ?? readString(own, "name")) : undefined;
  if (ownCode !== undefined && !GENERIC_ERROR_NAMES.has(ownCode)) return ownCode;
  for (const record of chain.slice(1)) {
    const causeCode = readString(record, "code") ?? readString(record, "name");
    if (causeCode !== undefined && !GENERIC_ERROR_NAMES.has(causeCode)) return causeCode;
  }
  return ownCode;
}

/** The structured SDK `reason`, from the error itself or the first cause that carries one. */
function readReason(chain: readonly Record<string, unknown>[]): string | undefined {
  for (const record of chain) {
    const reason = readString(record, "reason");
    if (reason !== undefined) return reason;
  }
  return undefined;
}

export function normalizeSdkError(error: unknown): NormalizedSdkError {
  if (!isRecord(error)) {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  const chain = causeChain(error);
  const status = readStatus(chain);
  const message = readString(error, "message") ?? String(error);
  const code = readCode(chain);
  const reason = readReason(chain);
  const headers = readHeaders(error);
  return {
    message,
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(headers !== undefined ? { headers } : {}),
  };
}

function retryAfterMs(headers: Readonly<Record<string, string>> | undefined): number {
  const entry = Object.entries(headers ?? {}).find(
    ([name]) => name.toLowerCase() === "retry-after",
  );
  const seconds = Number.parseInt(entry?.[1] ?? "60", 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : 60_000;
}

export function isKiroContextOverflowBody(message: string): boolean {
  return KIRO_CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
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
 * Whether a classification means the account's quota is spent: either a bare
 * upstream 402 or a structured quota reason. Callers persist the exhaustion
 * and remember the failure for the terminal 402 exactly as for a 402 status.
 */
export function isQuotaExhaustionClassification(classification: ErrorClassification): boolean {
  if (classification.action === "refresh-then-retry") return false;
  if (classification.code !== undefined) return QUOTA_EXHAUSTION_CODES.has(classification.code);
  return classification.status === 402;
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

/** Quota-exhausted semantics: switch when an alternative exists, otherwise terminal 402. */
function classifyQuotaExhausted(
  status: number,
  context: ErrorClassificationContext,
  code?: string,
): ErrorClassification {
  const codeField = code !== undefined ? { code } : {};
  return context.accountCount > 1
    ? { action: "switch", status, ...codeField }
    : { action: "fail", status, terminalStatus: 402, ...codeField };
}

/** Terminal client input error carrying a stable code. */
function failClientError(
  error: NormalizedSdkError,
  terminalStatus: number,
  code: string,
): ErrorClassification {
  return { action: "fail", status: error.status ?? 400, terminalStatus, code };
}

/**
 * `ValidationException` reasons are client input errors, never account or
 * transient faults. Applied regardless of status so a validation failure
 * delivered inside an already-open event stream (no HTTP status) still maps.
 */
function classifyValidationReason(
  error: NormalizedSdkError,
  reason: string,
): ErrorClassification | undefined {
  const mapped = VALIDATION_REASON_CODES.get(reason);
  if (mapped !== undefined) {
    return failClientError(error, CONTEXT_OVERFLOW_REASONS.has(reason) ? 413 : 400, mapped);
  }
  if (reason.startsWith("IMAGE_")) return failClientError(error, 400, "invalid_image");
  if (reason.startsWith("DOCUMENT_")) return failClientError(error, 400, "invalid_document");
  if (VALIDATION_REASONS.has(reason) || error.status === 400) {
    return failClientError(error, 400, reason.toLowerCase());
  }
  return undefined;
}

/**
 * `ServiceQuotaExceededException` is recognised by exception name (walked
 * through `cause` during normalization) so it classifies even when the SDK
 * delivered it inside the event stream without `$metadata.httpStatusCode`.
 * `MONTHLY_REQUEST_COUNT` is shared with `ThrottlingException`, where it keeps
 * the 429 semantics, so it only counts as quota exhaustion here when the name
 * or a 402 status says so.
 */
function classifyServiceQuotaReason(
  error: NormalizedSdkError,
  reason: string,
  context: ErrorClassificationContext,
): ErrorClassification | undefined {
  const quotaException = error.code === SERVICE_QUOTA_EXCEEDED_EXCEPTION || error.status === 402;
  switch (reason) {
    case ServiceQuotaExceededExceptionReason.MONTHLY_REQUEST_COUNT:
      return quotaException
        ? classifyQuotaExhausted(error.status ?? 402, context, MONTHLY_REQUEST_LIMIT_CODE)
        : undefined;
    case ServiceQuotaExceededExceptionReason.OVERAGE_REQUEST_LIMIT_EXCEEDED:
      return classifyQuotaExhausted(error.status ?? 402, context, OVERAGE_REQUEST_LIMIT_CODE);
    case ServiceQuotaExceededExceptionReason.CONVERSATION_LIMIT_EXCEEDED:
      return failClientError(error, 400, CONVERSATION_LIMIT_EXCEEDED_CODE);
    default:
      return undefined;
  }
}

/**
 * Structured `reason` classification. Returns undefined when the reason is
 * unknown so the status-based rules (and their message regex fallbacks) apply.
 */
function classifyByReason(
  error: NormalizedSdkError,
  context: ErrorClassificationContext,
): ErrorClassification | undefined {
  const reason = error.reason;
  if (reason === undefined) return undefined;

  if (reason === ValidationExceptionReason.INVALID_MODEL_ID) {
    const status = error.status ?? 400;
    return { action: "fail", status, terminalStatus: status };
  }

  if (reason === "TEMPORARILY_SUSPENDED") {
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

  return (
    classifyServiceQuotaReason(error, reason, context) ?? classifyValidationReason(error, reason)
  );
}

/** Reason-less 400: legacy message patterns decide the code, if any. */
function classifyBadRequestBody(error: NormalizedSdkError): ErrorClassification {
  if (isKiroContextOverflowBody(error.message)) {
    return { action: "fail", status: 400, terminalStatus: 413, code: CONTEXT_LENGTH_EXCEEDED_CODE };
  }
  if (INVALID_REASONING_SIGNATURE_PATTERN.test(error.message)) {
    return {
      action: "fail",
      status: 400,
      terminalStatus: 400,
      code: INVALID_REASONING_SIGNATURE_CODE,
    };
  }
  return { action: "fail", status: 400, terminalStatus: 400 };
}

export function classifyError(
  error: NormalizedSdkError,
  context: ErrorClassificationContext,
): ErrorClassification {
  const byReason = classifyByReason(error, context);
  if (byReason !== undefined) return byReason;

  switch (error.status) {
    case 400:
      return classifyBadRequestBody(error);
    case 401:
      return classifyRejectedCredentials(401, context);
    case 402:
      return classifyQuotaExhausted(402, context);
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
            retryAfterMs: 1_000 * 2 ** Math.max(0, context.serverErrorCount - 1),
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
