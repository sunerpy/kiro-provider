// Failure and quota classification for Kiro accounts.
//
// Two orthogonal failure classes drive the refresh / selection logic:
//
//   isAccessTokenError  — the ACCESS token is stale/invalid but the REFRESH
//                         token is (probably) still good. REFRESHABLE: force a
//                         refresh and retry; never mark the account dead just
//                         for this. "The bearer token included in the request
//                         is invalid" is the canonical signal.
//
//   isRefreshTokenDead  — the REFRESH token itself is dead, the OIDC client
//                         registration expired, or the stored credentials are
//                         unusable (missing IdC client secret, a refresh
//                         response without a token). PERMANENT: the account
//                         needs a re-login.
//
// isPermanentError is an alias of isRefreshTokenDead. Callers in this repo:
// TokenRefresher, QuotaRechecker and AccountMaintenanceService persist the
// dead reason through AccountManager.markUnhealthy; account-selection.ts and
// AccountManager exclude permanent accounts from selection; the CLI account
// listing renders them as "needs-relogin". invalid-bearer is deliberately NOT
// permanent.
//
// isQuotaExhausted is the selection gate for spent quota. Included quota
// (usedCount >= limitCount) always blocks; paid overage blocks only under the
// configured OveragePolicy (stop_on_overage / overage_threshold).

/**
 * Structured signals that the REFRESH token (or the OIDC client registration)
 * is permanently dead. Only service-issued codes and their canonical messages
 * qualify. token.ts emits a bare `HTTP_<status>` code whenever the response
 * body carried no service error code (HTML from a proxy / WAF, an empty body,
 * or JSON without `error` / `__type`); such reasons are transient and must never
 * park an account permanently, even for 401 / 403.
 */
const REFRESH_TOKEN_DEAD_MARKERS: readonly string[] = [
  // OAuth2 / AWS SSO OIDC `error` codes
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  // AWS JSON protocol `__type` exception names
  "InvalidGrantException",
  "InvalidClientException",
  "UnauthorizedClientException",
  "ExpiredTokenException",
  "InvalidTokenException",
  "ExpiredClientException",
  // Kiro desktop auth service messages
  "Invalid refresh token",
  "Invalid grant provided",
  "Client is expired",
];

/**
 * KiroTokenRefreshError codes emitted by token.ts / auth.ts for credentials
 * that can never refresh successfully: an IdC row without its client id or
 * secret, or a refresh response that carried no access token. Matched on the
 * structured `<code>: <message>` prefix built by errorReason, never on prose.
 */
const REFRESH_TOKEN_DEAD_CODES: readonly string[] = ["MISSING_CREDENTIALS", "INVALID_RESPONSE"];

function hasDeadCode(reason: string): boolean {
  return REFRESH_TOKEN_DEAD_CODES.some(
    (code) => reason === code || reason.startsWith(`${code}:`) || reason.includes(` ${code}:`),
  );
}

/** REFRESH-token-dead signals (needs re-login). */
export function isRefreshTokenDead(reason?: string): boolean {
  if (!reason) return false;
  if (hasDeadCode(reason)) return true;
  return REFRESH_TOKEN_DEAD_MARKERS.some((marker) => reason.includes(marker));
}

/**
 * ACCESS-token-error signals (refreshable, transient). The canonical case is
 * the CodeWhisperer invalid-bearer 403 whose message is "The bearer token
 * included in the request is invalid". Matched case-insensitively so a
 * capitalization drift on the wire does not misclassify it as dead.
 */
export function isAccessTokenError(reason?: string): boolean {
  if (!reason) return false;
  const lower = reason.toLowerCase();
  return (
    lower.includes("bearer token included in the request is invalid") ||
    lower.includes("access token has expired") ||
    lower.includes("access_token expired") ||
    lower.includes("the access token expired")
  );
}

/**
 * How paid overage gates account selection. Mirrors the `stop_on_overage` and
 * `overage_threshold` config knobs: when `stopOnOverage` is true an account
 * whose observed overage count exceeds `overageThreshold` is treated as
 * exhausted until the next authoritative usage sync brings it back within the
 * threshold. Overage never marks an account unhealthy.
 */
export interface OveragePolicy {
  readonly stopOnOverage: boolean;
  readonly overageThreshold: number;
}

export const DEFAULT_OVERAGE_POLICY: OveragePolicy = {
  stopOnOverage: true,
  overageThreshold: 0,
};

/** Builds the policy from the snake_case config fields. */
export function toOveragePolicy(config: {
  readonly stop_on_overage: boolean;
  readonly overage_threshold: number;
}): OveragePolicy {
  return {
    stopOnOverage: config.stop_on_overage,
    overageThreshold: config.overage_threshold,
  };
}

export interface QuotaCounts {
  readonly usedCount?: number;
  readonly limitCount?: number;
  readonly overageCount?: number;
}

/** Included quota spent: a known positive limit and used credits at or above it. */
export function isIncludedQuotaExhausted(account: QuotaCounts): boolean {
  const usedCount = account.usedCount ?? 0;
  const limitCount = account.limitCount ?? 0;
  return (
    Number.isFinite(usedCount) &&
    Number.isFinite(limitCount) &&
    limitCount > 0 &&
    usedCount >= limitCount
  );
}

/**
 * The policy argument, or the default when the caller passed none. Callers may
 * hand these predicates point-free to Array.prototype.filter, which supplies
 * the element index as the second argument; anything that is not a policy
 * object therefore falls back to the default instead of disabling the gate.
 */
function resolvePolicy(policy: unknown): OveragePolicy {
  return typeof policy === "object" &&
    policy !== null &&
    typeof (policy as OveragePolicy).stopOnOverage === "boolean" &&
    typeof (policy as OveragePolicy).overageThreshold === "number"
    ? (policy as OveragePolicy)
    : DEFAULT_OVERAGE_POLICY;
}

/**
 * Paid overage above the policy threshold while the gate is on. Equal to the
 * threshold is allowed; strictly greater blocks.
 */
export function isOverageBlocked(account: QuotaCounts, policy?: OveragePolicy): boolean {
  const effective = resolvePolicy(policy);
  if (!effective.stopOnOverage) return false;
  const overageCount = account.overageCount ?? 0;
  return Number.isFinite(overageCount) && overageCount > effective.overageThreshold;
}

/**
 * Selection gate for spent quota: included quota exhausted, or paid overage
 * blocked by the policy (DEFAULT_OVERAGE_POLICY when omitted). The
 * `usedCount >= limitCount` rule does not depend on the policy.
 */
export function isQuotaExhausted(account: QuotaCounts): boolean;
export function isQuotaExhausted(account: QuotaCounts, policy: OveragePolicy): boolean;
export function isQuotaExhausted(account: QuotaCounts, policy?: OveragePolicy): boolean {
  return isOverageBlocked(account, policy) || isIncludedQuotaExhausted(account);
}

/**
 * Back-compat alias. Semantics == refresh-token-dead == permanent (needs
 * re-auth). Preserved so callers that gate exclude/auto-heal/needs-reauth on
 * "permanent" keep working unchanged.
 */
export function isPermanentError(reason?: string): boolean {
  return isRefreshTokenDead(reason);
}

/**
 * Ensure a reason string classifies as refresh-token-dead when persisted via
 * markUnhealthy (which decides permanence from the reason string). If the raw
 * message already matches a dead keyword it is returned unchanged; otherwise a
 * dead marker is prepended so the stored reason is recognized as permanent by
 * isRefreshTokenDead / isPermanentError.
 */
export function toDeadReason(reason?: string): string {
  const base = reason && reason.length > 0 ? reason : "Account needs re-authentication";
  return isRefreshTokenDead(base) ? base : `InvalidTokenException: ${base}`;
}
