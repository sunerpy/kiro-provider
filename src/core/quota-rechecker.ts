import {
  isPermanentError,
  isQuotaExhausted,
  isRefreshTokenDead,
  toDeadReason,
} from "../kiro/health.js";
import type { KiroAuthDetails, KiroUsageSnapshot, ManagedAccount } from "../kiro/types.js";
import {
  fetchUsageLimits,
  isKiroUsageAuthenticationError,
  KiroUsageError,
} from "../kiro/usage-client.js";
import { errorFields as baseErrorFields, errorReason } from "./account-errors.js";
import { auditHash, auditLog } from "./audit-log.js";
import { abortable, abortReason } from "./pipeline-runtime.js";

interface QuotaAccountManager {
  toAuthDetails(account: ManagedAccount): KiroAuthDetails;
  markUnhealthy(account: ManagedAccount, reason: string, recoveryTime?: number): unknown;
  scheduleQuotaRecheck(account: ManagedAccount, recheckAfter: number): ManagedAccount | undefined;
  updateQuotaUsage(
    account: ManagedAccount,
    usage: KiroUsageSnapshot & { readonly lastSync: number },
    nextRecheckAt: number,
  ): ManagedAccount | undefined;
}

interface QuotaTokenRefresher {
  refreshIfNeeded(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    signal?: AbortSignal,
  ): Promise<ManagedAccount>;
  forceRefresh(account: ManagedAccount, signal?: AbortSignal): Promise<ManagedAccount>;
}

export interface PipelineQuotaRechecker {
  recheckDueAccounts(
    accounts: readonly ManagedAccount[],
    signal: AbortSignal,
    preferredAccountId?: string,
  ): Promise<void>;
  syncDueAccounts(accounts: readonly ManagedAccount[], signal: AbortSignal): Promise<void>;
}

export interface QuotaRecheckerOptions {
  readonly accountManager: QuotaAccountManager;
  readonly tokenRefresher: QuotaTokenRefresher;
  readonly intervalMs: number;
  readonly usageRefreshIntervalMs: number;
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly proxyUrl?: string;
  readonly now?: () => number;
  readonly fetchUsage?: (
    auth: KiroAuthDetails,
    options: {
      readonly proxyUrl?: string;
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
    },
  ) => Promise<KiroUsageSnapshot>;
}

type QuotaRecheckResult = "updated" | "recovered" | "exhausted" | "failed" | "skipped";
type BatchKind = "quota_recheck" | "usage_refresh";

export type AccountTokenRefreshStatus =
  | "renewed"
  | "not_needed"
  | "skipped_unhealthy"
  | "failed"
  | "timeout"
  | "aborted";

export type AccountUsageRefreshStatus = "updated" | "skipped" | "failed" | "timeout" | "aborted";

export interface AccountRefreshResult {
  readonly accountId: string;
  readonly email: string;
  readonly before: {
    readonly usedCount: number;
    readonly limitCount: number;
    readonly overageCount: number;
  };
  readonly after: {
    readonly usedCount: number;
    readonly limitCount: number;
    readonly overageCount: number;
  };
  readonly tokenStatus: AccountTokenRefreshStatus;
  readonly usageStatus: AccountUsageRefreshStatus;
  readonly quotaStatus: "available" | "exhausted" | "unknown";
  readonly error?: string;
}

export interface AccountRefreshSummary {
  readonly startedAt: number;
  readonly completedAt: number;
  readonly totalAccounts: number;
  readonly tokenRenewed: number;
  readonly usageUpdated: number;
  readonly failed: number;
  readonly timedOut: boolean;
  readonly accounts: readonly AccountRefreshResult[];
}

interface QuotaProbeOutcome {
  readonly result: QuotaRecheckResult;
  readonly account: AccountRefreshResult;
}

function isQuotaRecheckDue(account: ManagedAccount, now: number): boolean {
  return (
    isQuotaExhausted(account) &&
    !isPermanentError(account.unhealthyReason) &&
    account.rateLimitResetTime <= now
  );
}

/** Longest an exhausted account may go without an authoritative probe. */
const DAILY_RECHECK_MS = 24 * 60 * 60 * 1000;

/**
 * Picks when a confirmed-exhausted account is probed next. Without an upstream
 * reset time this is the fixed interval. With one, the probe waits for the
 * reset (never sooner than the interval) but is still capped to at least one
 * probe per `max(intervalMs, 24h)` so a stale or wrong reset date cannot park
 * the account indefinitely.
 */
function exhaustedRecheckAt(
  lastSync: number,
  intervalMs: number,
  resetAt: number | undefined,
): number {
  const intervalRecheckAt = lastSync + intervalMs;
  if (resetAt === undefined || !Number.isFinite(resetAt)) {
    return intervalRecheckAt;
  }
  const latestRecheckAt = lastSync + Math.max(intervalMs, DAILY_RECHECK_MS);
  return Math.min(Math.max(resetAt, intervalRecheckAt), latestRecheckAt);
}

function errorFields(
  error: unknown,
): Readonly<Record<string, string | number | boolean | null | undefined>> {
  if (error instanceof KiroUsageError) {
    return {
      error_name: error.name,
      error_status: error.status,
      error_code: error.upstreamCode,
    };
  }
  return baseErrorFields(error);
}

function usageCounts(account: ManagedAccount): {
  readonly usedCount: number;
  readonly limitCount: number;
  readonly overageCount: number;
} {
  return {
    usedCount: account.usedCount ?? 0,
    limitCount: account.limitCount ?? 0,
    overageCount: account.overageCount ?? 0,
  };
}

function quotaStatus(account: ManagedAccount): AccountRefreshResult["quotaStatus"] {
  const counts = usageCounts(account);
  if (counts.limitCount <= 0) return "unknown";
  return isQuotaExhausted(counts) ? "exhausted" : "available";
}

function abortStatus(signal: AbortSignal): "timeout" | "aborted" {
  return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
    ? "timeout"
    : "aborted";
}

export class QuotaRechecker implements PipelineQuotaRechecker {
  private readonly inFlight = new Map<string, Promise<QuotaProbeOutcome>>();
  private readonly usageRetryAfter = new Map<string, number>();
  private readonly now: () => number;
  private readonly fetchUsage: NonNullable<QuotaRecheckerOptions["fetchUsage"]>;

  constructor(private readonly options: QuotaRecheckerOptions) {
    this.now = options.now ?? Date.now;
    this.fetchUsage = options.fetchUsage ?? fetchUsageLimits;
  }

  async recheckDueAccounts(
    accounts: readonly ManagedAccount[],
    signal: AbortSignal,
    preferredAccountId?: string,
  ): Promise<void> {
    const startedAt = this.now();
    const due = accounts
      .filter((account) => isQuotaRecheckDue(account, startedAt))
      .sort(
        (left, right) =>
          Number(right.id === preferredAccountId) - Number(left.id === preferredAccountId) ||
          left.rateLimitResetTime - right.rateLimitResetTime ||
          (left.lastSync ?? 0) - (right.lastSync ?? 0) ||
          left.id.localeCompare(right.id),
      );
    if (due.length === 0) return;

    await this.runBatch(due, signal, "quota_recheck", true, preferredAccountId);
  }

  async syncDueAccounts(accounts: readonly ManagedAccount[], signal: AbortSignal): Promise<void> {
    const startedAt = this.now();
    const due = accounts
      .filter((account) => this.isUsageRefreshDue(account, startedAt))
      .sort(
        (left, right) =>
          (left.lastSync ?? 0) - (right.lastSync ?? 0) || left.id.localeCompare(right.id),
      );
    if (due.length === 0) return;
    await this.runBatch(due, signal, "usage_refresh", false);
  }

  async refreshAccounts(
    accounts: readonly ManagedAccount[],
    signal: AbortSignal,
  ): Promise<AccountRefreshSummary> {
    const startedAt = this.now();
    const ordered = [...accounts].sort(
      (left, right) => left.email.localeCompare(right.email) || left.id.localeCompare(right.id),
    );
    const results = new Map<string, AccountRefreshResult>();
    let cursor = 0;
    auditLog("info", "manual_account_refresh_started", {
      account_count: ordered.length,
      concurrency: this.options.concurrency,
    });

    const worker = async (): Promise<void> => {
      for (;;) {
        if (signal.aborted) return;
        const account = ordered[cursor];
        cursor += 1;
        if (!account) return;
        try {
          const outcome = await abortable(this.startOrJoin(account, true, signal), signal);
          results.set(account.id, outcome.account);
        } catch (error) {
          if (signal.aborted) return;
          throw error;
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.options.concurrency, ordered.length) }, worker),
    );

    if (signal.aborted) {
      const status = abortStatus(signal);
      for (const account of ordered) {
        if (!results.has(account.id)) {
          results.set(
            account.id,
            this.terminalAccountResult(
              account,
              status,
              status === "timeout" ? "Account refresh timed out." : "Account refresh was aborted.",
            ),
          );
        }
      }
    }

    const accountResults = ordered
      .map(({ id }) => results.get(id))
      .filter((result): result is AccountRefreshResult => result !== undefined);
    const summary: AccountRefreshSummary = {
      startedAt,
      completedAt: this.now(),
      totalAccounts: ordered.length,
      tokenRenewed: accountResults.filter((result) => result.tokenStatus === "renewed").length,
      usageUpdated: accountResults.filter((result) => result.usageStatus === "updated").length,
      failed: accountResults.filter((result) => result.usageStatus !== "updated").length,
      timedOut: signal.aborted && abortStatus(signal) === "timeout",
      accounts: accountResults,
    };
    auditLog("info", "manual_account_refresh_completed", {
      account_count: summary.totalAccounts,
      token_renewed_count: summary.tokenRenewed,
      usage_updated_count: summary.usageUpdated,
      failed_count: summary.failed,
      timed_out: summary.timedOut,
      duration_ms: summary.completedAt - summary.startedAt,
    });
    return summary;
  }

  private async runBatch(
    due: readonly ManagedAccount[],
    signal: AbortSignal,
    kind: BatchKind,
    useBatchTimeout: boolean,
    preferredAccountId?: string,
  ): Promise<void> {
    auditLog("info", `${kind}_batch_started`, {
      account_count: due.length,
      concurrency: this.options.concurrency,
      preferred_account_present:
        preferredAccountId !== undefined && due.some(({ id }) => id === preferredAccountId),
    });

    const timeoutSignal = useBatchTimeout ? AbortSignal.timeout(this.options.timeoutMs) : undefined;
    const batchSignal = timeoutSignal ? AbortSignal.any([signal, timeoutSignal]) : signal;
    let cursor = 0;
    const counts: Record<QuotaRecheckResult, number> = {
      updated: 0,
      recovered: 0,
      exhausted: 0,
      failed: 0,
      skipped: 0,
    };
    const worker = async (): Promise<void> => {
      for (;;) {
        if (batchSignal.aborted) throw abortReason(batchSignal);
        const account = due[cursor];
        cursor += 1;
        if (!account) return;
        const outcome = await abortable(this.startOrJoin(account, false), batchSignal);
        counts[outcome.result] += 1;
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(this.options.concurrency, due.length) }, worker),
      );
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      if (!timeoutSignal?.aborted) throw error;
      auditLog("warn", `${kind}_batch_timeout`, {
        account_count: due.length,
        started_count: Math.min(cursor, due.length),
        timeout_ms: this.options.timeoutMs,
      });
      return;
    }
    auditLog("info", `${kind}_batch_completed`, {
      account_count: due.length,
      updated_count: counts.updated,
      recovered_count: counts.recovered,
      exhausted_count: counts.exhausted,
      failed_count: counts.failed,
      skipped_count: counts.skipped,
    });
  }

  private isUsageRefreshDue(account: ManagedAccount, now: number): boolean {
    if (isPermanentError(account.unhealthyReason) || isQuotaExhausted(account)) {
      return false;
    }
    if ((this.usageRetryAfter.get(account.id) ?? 0) > now) return false;
    return (account.lastSync ?? 0) + this.options.usageRefreshIntervalMs <= now;
  }

  private startOrJoin(
    account: ManagedAccount,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<QuotaProbeOutcome> {
    const forcedKey = `${account.id}:force`;
    if (!force) {
      const forced = this.inFlight.get(forcedKey);
      if (forced) return forced;
    }
    const key = force ? forcedKey : `${account.id}:scheduled`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const operation = this.runProbe(account, force, signal).finally(() => {
      if (this.inFlight.get(key) === operation) {
        this.inFlight.delete(key);
      }
    });
    this.inFlight.set(key, operation);
    return operation;
  }

  private async runProbe(
    startedAccount: ManagedAccount,
    force: boolean,
    parentSignal?: AbortSignal,
  ): Promise<QuotaProbeOutcome> {
    const before = usageCounts(startedAccount);
    let account = startedAccount;
    let tokenStatus: AccountTokenRefreshStatus = "not_needed";
    let phase: "token" | "usage" = "token";
    if (force && isPermanentError(startedAccount.unhealthyReason)) {
      return {
        result: "failed",
        account: {
          accountId: startedAccount.id,
          email: startedAccount.email,
          before,
          after: before,
          tokenStatus: "skipped_unhealthy",
          usageStatus: "skipped",
          quotaStatus: quotaStatus(startedAccount),
          error: "Account needs re-login before its usage can be refreshed.",
        },
      };
    }

    const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs);
    const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
    try {
      const initialAuth = this.options.accountManager.toAuthDetails(startedAccount);
      const previousAccess = startedAccount.accessToken;
      const previousExpiry = startedAccount.expiresAt;
      account = await this.options.tokenRefresher.refreshIfNeeded(
        startedAccount,
        initialAuth,
        signal,
      );
      if (account.accessToken !== previousAccess || account.expiresAt !== previousExpiry) {
        tokenStatus = "renewed";
      }
      if (
        !force &&
        !isQuotaRecheckDue(account, this.now()) &&
        !this.isUsageRefreshDue(account, this.now())
      ) {
        return {
          result: "skipped",
          account: {
            accountId: account.id,
            email: account.email,
            before,
            after: usageCounts(account),
            tokenStatus,
            usageStatus: "skipped",
            quotaStatus: quotaStatus(account),
          },
        };
      }

      phase = "usage";
      const wasExhausted = isQuotaExhausted(account);
      let auth = this.options.accountManager.toAuthDetails(account);
      let usage: KiroUsageSnapshot;
      try {
        usage = await this.fetchUsage(auth, {
          proxyUrl: this.options.proxyUrl,
          signal,
          timeoutMs: this.options.timeoutMs,
        });
      } catch (error) {
        if (!isKiroUsageAuthenticationError(error)) throw error;
        account = await this.options.tokenRefresher.forceRefresh(account, signal);
        tokenStatus = "renewed";
        auth = this.options.accountManager.toAuthDetails(account);
        usage = await this.fetchUsage(auth, {
          proxyUrl: this.options.proxyUrl,
          signal,
          timeoutMs: this.options.timeoutMs,
        });
      }

      const lastSync = this.now();
      const exhausted = isQuotaExhausted(usage);
      const nextRecheckAt = exhausted
        ? exhaustedRecheckAt(lastSync, this.options.intervalMs, usage.resetAt)
        : 0;
      const persisted = this.options.accountManager.updateQuotaUsage(
        account,
        { ...usage, lastSync },
        nextRecheckAt,
      );
      if (!persisted) {
        return {
          result: "skipped",
          account: {
            accountId: account.id,
            email: account.email,
            before,
            after: usageCounts(account),
            tokenStatus,
            usageStatus: "skipped",
            quotaStatus: quotaStatus(account),
            error: "Account was removed while its usage was being refreshed.",
          },
        };
      }

      this.usageRetryAfter.delete(account.id);
      const persistedExhausted = isQuotaExhausted(persisted);
      let result: QuotaRecheckResult = "updated";
      if (persistedExhausted) {
        auditLog(
          "info",
          wasExhausted ? "quota_recheck_still_exhausted" : "usage_refresh_detected_exhaustion",
          {
            account_hash: auditHash(account.id),
            next_recheck_at: persisted.rateLimitResetTime,
            reset_at: usage.resetAt,
          },
        );
        result = "exhausted";
      } else if (wasExhausted) {
        auditLog("info", "quota_exhausted_account_recovered", {
          account_hash: auditHash(account.id),
        });
        result = "recovered";
      }
      return {
        result,
        account: {
          accountId: persisted.id,
          email: persisted.email,
          before,
          after: usageCounts(persisted),
          tokenStatus,
          usageStatus: "updated",
          quotaStatus: quotaStatus(persisted),
        },
      };
    } catch (error) {
      const nextRecheckAt = this.now() + this.options.intervalMs;
      const reason = errorReason(error);
      if (isRefreshTokenDead(reason)) {
        try {
          this.options.accountManager.markUnhealthy(account, toDeadReason(reason));
        } catch {
          // The account may have been removed while its probe was in flight.
        }
        this.usageRetryAfter.delete(account.id);
      } else if (isQuotaExhausted(account)) {
        try {
          this.options.accountManager.scheduleQuotaRecheck(account, nextRecheckAt);
        } catch {
          // The account may have been removed while its probe was in flight.
        }
      } else {
        this.usageRetryAfter.set(account.id, nextRecheckAt);
      }
      auditLog(
        "warn",
        isQuotaExhausted(account) ? "quota_recheck_failed" : "usage_refresh_failed",
        {
          account_hash: auditHash(startedAccount.id),
          next_recheck_at: nextRecheckAt,
          ...errorFields(error),
        },
      );
      const interrupted = signal.aborted ? abortStatus(signal) : undefined;
      return {
        result: "failed",
        account: {
          accountId: account.id,
          email: account.email,
          before,
          after: usageCounts(account),
          tokenStatus:
            interrupted && phase === "token"
              ? interrupted
              : phase === "token"
                ? "failed"
                : tokenStatus,
          usageStatus: interrupted ?? (phase === "token" ? "skipped" : "failed"),
          quotaStatus: quotaStatus(account),
          error: reason,
        },
      };
    }
  }

  private terminalAccountResult(
    account: ManagedAccount,
    status: "timeout" | "aborted",
    error: string,
  ): AccountRefreshResult {
    const counts = usageCounts(account);
    return {
      accountId: account.id,
      email: account.email,
      before: counts,
      after: counts,
      tokenStatus: status,
      usageStatus: status,
      quotaStatus: quotaStatus(account),
      error,
    };
  }
}
