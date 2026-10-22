import { KiroTokenRefreshError } from "../kiro/errors.js";
import {
  isClientRegistrationExpired,
  isPermanentError,
  isRefreshTokenDead,
  toDeadReason,
} from "../kiro/health.js";
import type { ManagedAccount } from "../kiro/types.js";
import { errorCode, errorReason } from "./account-errors.js";

export const REFRESH_BACKOFF_BASE_MS = 30_000;
export const REFRESH_BACKOFF_MAX_MS = 900_000;

/** Credential epoch only: quota, health, usage and row generations are not credentials. */
export function sameCredentialTuple(left: ManagedAccount, right: ManagedAccount): boolean {
  return (
    left.id === right.id &&
    left.authMethod === right.authMethod &&
    left.email.trim().toLowerCase() === right.email.trim().toLowerCase() &&
    left.startUrl === right.startUrl &&
    left.region === right.region &&
    left.oidcRegion === right.oidcRegion &&
    left.profileArn === right.profileArn &&
    left.clientId === right.clientId &&
    left.clientSecret === right.clientSecret &&
    left.clientIdIssuedAt === right.clientIdIssuedAt &&
    left.clientSecretExpiresAt === right.clientSecretExpiresAt &&
    left.refreshToken === right.refreshToken &&
    left.accessToken === right.accessToken &&
    left.expiresAt === right.expiresAt
  );
}

/** A re-login may replace its client registration, never its replay owner or issuer. */
export function canAdoptRefreshedAccount(
  attempted: ManagedAccount,
  current: ManagedAccount,
  bufferMs: number,
  now = Date.now(),
): boolean {
  return (
    !sameCredentialTuple(attempted, current) &&
    attempted.id === current.id &&
    attempted.authMethod === current.authMethod &&
    attempted.email.trim().toLowerCase() === current.email.trim().toLowerCase() &&
    attempted.startUrl === current.startUrl &&
    attempted.profileArn === current.profileArn &&
    attempted.region === current.region &&
    (attempted.oidcRegion ?? attempted.region) === (current.oidcRegion ?? current.region) &&
    current.isHealthy &&
    !isPermanentError(current.unhealthyReason) &&
    !isClientRegistrationExpired(current, now) &&
    (current.refreshRetryAt ?? 0) <= now &&
    Boolean(current.refreshToken && current.accessToken) &&
    (current.authMethod !== "idc" || Boolean(current.clientId && current.clientSecret)) &&
    Number.isFinite(current.expiresAt) &&
    current.expiresAt > now + bufferMs
  );
}

export function refreshFailureCode(
  error: unknown,
): NonNullable<ManagedAccount["refreshFailureCode"]> {
  const code = errorCode(error);
  if (code === "invalid_request") return "invalid_request";
  if (code === "NETWORK_ERROR") return "network_error";
  if (
    code === "HTTP_429" ||
    code === "ThrottlingException" ||
    code === "TooManyRequestsException" ||
    code === "SlowDownException" ||
    (error instanceof KiroTokenRefreshError && error.status === 429)
  )
    return "throttled";
  return "upstream_error";
}

export function refreshFailureDelayMs(count: number): number {
  return Math.min(
    REFRESH_BACKOFF_MAX_MS,
    REFRESH_BACKOFF_BASE_MS * 2 ** Math.min(5, Math.max(0, count - 1)),
  );
}

export interface RefreshFailureRecorder {
  recordRefreshFailure?(account: ManagedAccount, error: unknown): ManagedAccount | undefined;
  /** Compatibility for dependency-injected managers without durable refresh state. */
  markUnhealthy?(account: ManagedAccount, reason: string): unknown;
}

const recorded = new WeakMap<object, WeakMap<object, Map<string, ManagedAccount | undefined>>>();

/** One error may cross refresher, pipeline and maintenance boundaries; charge it once. */
export function recordRefreshFailure(
  manager: RefreshFailureRecorder,
  attempted: ManagedAccount,
  error: unknown,
): ManagedAccount | undefined {
  if (error instanceof KiroTokenRefreshError && error.code === "REFRESH_BACKOFF") return undefined;
  if (!(error instanceof KiroTokenRefreshError) && !isRefreshTokenDead(errorReason(error)))
    return undefined;
  const object = typeof error === "object" && error !== null ? error : undefined;
  let accounts: Map<string, ManagedAccount | undefined> | undefined;
  if (object) {
    let managers = recorded.get(object);
    if (!managers) {
      managers = new WeakMap();
      recorded.set(object, managers);
    }
    accounts = managers.get(manager);
    if (!accounts) {
      accounts = new Map();
      managers.set(manager, accounts);
    }
    if (accounts.has(attempted.id)) return accounts.get(attempted.id);
  }
  let result: ManagedAccount | undefined;
  if (manager.recordRefreshFailure) {
    result = manager.recordRefreshFailure(attempted, error);
  } else if (isRefreshTokenDead(errorReason(error))) {
    manager.markUnhealthy?.(attempted, toDeadReason(errorReason(error)));
  }
  accounts?.set(attempted.id, result);
  return result;
}
