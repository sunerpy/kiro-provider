import { decodeRefreshToken, encodeRefreshToken } from "../kiro/auth.js";
import { KiroTokenRefreshError } from "../kiro/errors.js";
import {
  DEFAULT_OVERAGE_POLICY,
  isPermanentError,
  isQuotaExhausted,
  isRefreshTokenDead,
  type OveragePolicy,
  toDeadReason,
} from "../kiro/health.js";
import type {
  AccountSelectionStrategy,
  KiroAuthDetails,
  KiroUsageSnapshot,
  ManagedAccount,
} from "../kiro/types.js";
import type { AccountsDatabase, StoredAccount } from "../storage/accounts-db.js";
import { errorReason } from "./account-errors.js";
import {
  AccountSelector,
  countSelectable,
  isBlockedOnlyByOverage,
  isSelectableAccount,
  selectableCandidates,
} from "./account-selection.js";
import {
  canAdoptRefreshedAccount,
  refreshFailureCode,
  refreshFailureDelayMs,
  sameCredentialTuple,
} from "./credential-state.js";
import { evictSdkClientsForAccount } from "./sdk-client.js";

const MAX_CAS_ATTEMPTS = 4;

type AccountPatch = (account: StoredAccount) => StoredAccount;

export interface AccountManagerOptions {
  /** Overage selection gate; defaults to stop_on_overage=true, overage_threshold=0. */
  readonly overagePolicy?: OveragePolicy;
}

export class AccountConcurrentUpdateError extends Error {
  constructor(readonly accountId: string) {
    super(`Account ${accountId} changed too frequently to update`);
    this.name = "AccountConcurrentUpdateError";
  }
}

function cloneAccount(account: StoredAccount): StoredAccount {
  return { ...account };
}

export function toAuthDetails(account: ManagedAccount): KiroAuthDetails {
  return {
    refresh: encodeRefreshToken({
      refreshToken: account.refreshToken,
      authMethod: account.authMethod,
      ...(account.clientId ? { clientId: account.clientId } : {}),
      ...(account.clientSecret ? { clientSecret: account.clientSecret } : {}),
      ...(account.profileArn ? { profileArn: account.profileArn } : {}),
    }),
    access: account.accessToken,
    expires: account.expiresAt,
    authMethod: account.authMethod,
    region: account.region,
    ...(account.oidcRegion ? { oidcRegion: account.oidcRegion } : {}),
    ...(account.clientId ? { clientId: account.clientId } : {}),
    ...(account.clientSecret ? { clientSecret: account.clientSecret } : {}),
    ...(account.clientIdIssuedAt !== undefined
      ? { clientIdIssuedAt: account.clientIdIssuedAt }
      : {}),
    ...(account.clientSecretExpiresAt !== undefined
      ? { clientSecretExpiresAt: account.clientSecretExpiresAt }
      : {}),
    ...(account.email ? { email: account.email } : {}),
    ...(account.profileArn ? { profileArn: account.profileArn } : {}),
  };
}

export class AccountManager {
  private accounts: StoredAccount[];
  private readonly selector: AccountSelector;
  private readonly overagePolicy: OveragePolicy;

  constructor(
    accounts: readonly StoredAccount[],
    strategy: AccountSelectionStrategy,
    private readonly database: AccountsDatabase,
    options: AccountManagerOptions = {},
  ) {
    this.accounts = accounts.map(cloneAccount);
    this.selector = new AccountSelector(strategy);
    this.overagePolicy = options.overagePolicy ?? DEFAULT_OVERAGE_POLICY;
  }

  /** The overage gate every selection and exhaustion decision of this manager applies. */
  getOveragePolicy(): OveragePolicy {
    return this.overagePolicy;
  }

  getAccountCount(): number {
    return this.accounts.length;
  }

  getAccounts(): StoredAccount[] {
    return this.accounts.map(cloneAccount);
  }

  /**
   * Re-reads one account row from the database and publishes it to the
   * in-memory snapshot. Returns undefined when the account no longer exists.
   */
  getLatestAccount(id: string): StoredAccount | undefined {
    const latest = this.database.getById(id);
    if (!latest) {
      this.dropAccount(id);
      return undefined;
    }
    const current = this.accounts.find((account) => account.id === id);
    if (current?.generation !== latest.generation) this.replaceAccount(cloneAccount(latest));
    return cloneAccount(latest);
  }

  getMinWaitTime(): number {
    const now = Date.now();
    const waits = this.accounts
      .map((account) => Math.max(account.rateLimitResetTime, account.refreshRetryAt ?? 0) - now)
      .filter((wait) => wait > 0);
    return waits.length === 0 ? 0 : Math.min(...waits);
  }

  reconcileFromDb(database: AccountsDatabase = this.database): StoredAccount[] {
    const currentById = new Map(this.accounts.map((account) => [account.id, account]));
    this.accounts = database.getAccounts().map((row) => {
      const current = currentById.get(row.id);
      return current?.generation === row.generation ? current : cloneAccount(row);
    });
    const survivingIds = new Set(this.accounts.map(({ id }) => id));
    for (const id of currentById.keys()) {
      if (!survivingIds.has(id)) evictSdkClientsForAccount(id);
    }
    this.selector.retainSticky(this.accounts);
    return this.getAccounts();
  }

  selectHealthyAccount(
    preferredAccountId?: string,
    eligibleAccountIds?: ReadonlySet<string>,
  ): StoredAccount | null {
    const now = Date.now();
    const candidates = selectableCandidates(
      this.accounts,
      now,
      eligibleAccountIds,
      this.overagePolicy,
    );
    if (candidates.length === 0) return null;

    const selected = this.selector.pick(candidates, preferredAccountId);
    return (
      this.patchAccount(selected.id, (latest) => ({
        ...latest,
        isHealthy: true,
        unhealthyReason: undefined,
        recoveryTime: undefined,
        lastUsed: now,
        usedCount: (latest.usedCount ?? 0) + 1,
      })) ?? null
    );
  }

  getCurrentOrNext(): StoredAccount | null {
    return this.selectHealthyAccount();
  }

  /**
   * Number of accounts selectHealthyAccount could return right now (healthy,
   * not rate-limited, not quota-exhausted), optionally restricted to the
   * given eligible ids. Used as the failover alternative count.
   */
  countSelectableAccounts(eligibleAccountIds?: ReadonlySet<string>, now = Date.now()): number {
    return countSelectable(this.accounts, now, eligibleAccountIds, this.overagePolicy);
  }

  /**
   * Whether the overage gate alone is what leaves nothing to select among the
   * given account ids (all accounts when omitted). True only when none of them
   * is selectable, at least one remains after ignoring permanently dead rows,
   * and every remaining one is blocked solely by overage above the threshold:
   * not exhausted on its included quota, not unhealthy. A genuinely rate-limited
   * or included-quota-exhausted account therefore yields false, so the caller
   * keeps its wait / quota_exhausted handling for those. Lets the pipeline
   * answer 402 `paid_overage_blocked` with a `stop_on_overage` hint instead of
   * a generic quota failure.
   */
  blockedByOverageOnly(accountIds?: ReadonlySet<string>, now = Date.now()): boolean {
    const candidates = this.accounts.filter(
      (account) =>
        (accountIds?.has(account.id) ?? true) && !isPermanentError(account.unhealthyReason),
    );
    if (candidates.length === 0) return false;
    if (candidates.some((account) => isSelectableAccount(account, now, this.overagePolicy))) {
      return false;
    }
    return candidates.every((account) => isBlockedOnlyByOverage(account, now, this.overagePolicy));
  }

  markRateLimited(account: ManagedAccount, resetTime: number): StoredAccount | undefined {
    return this.patchAccount(account.id, (latest) => ({
      ...latest,
      rateLimitResetTime: resetTime,
    }));
  }

  markQuotaExhausted(account: ManagedAccount, recheckAfter: number): StoredAccount | undefined {
    return this.patchAccount(account.id, (latest) => ({
      ...latest,
      usedCount:
        (latest.limitCount ?? 0) > 0
          ? Math.max(latest.usedCount ?? 0, latest.limitCount ?? 0)
          : latest.usedCount,
      rateLimitResetTime: Math.max(latest.rateLimitResetTime, recheckAfter),
    }));
  }

  scheduleQuotaRecheck(account: ManagedAccount, recheckAfter: number): StoredAccount | undefined {
    return this.patchAccount(account.id, (latest) =>
      isQuotaExhausted(latest, this.overagePolicy)
        ? {
            ...latest,
            rateLimitResetTime: Math.max(latest.rateLimitResetTime, recheckAfter),
          }
        : latest,
    );
  }

  updateQuotaUsage(
    account: ManagedAccount,
    usage: KiroUsageSnapshot & { readonly lastSync: number },
    nextRecheckAt: number,
  ): StoredAccount | undefined {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = this.database.getById(account.id);
      if (!current) {
        this.dropAccount(account.id);
        return undefined;
      }
      if ((current.lastSync ?? 0) > usage.lastSync) {
        this.replaceAccount(current);
        return cloneAccount(current);
      }
      const wasExhausted = isQuotaExhausted(current, this.overagePolicy);
      const snapshotExhausted = isQuotaExhausted(usage, this.overagePolicy);
      const updated: StoredAccount = {
        ...current,
        email: usage.email ?? current.email,
        usedCount: usage.usedCount,
        limitCount: usage.limitCount,
        overageCount: usage.overageCount,
        lastSync: usage.lastSync,
        rateLimitResetTime: snapshotExhausted
          ? Math.max(current.rateLimitResetTime, nextRecheckAt)
          : wasExhausted
            ? 0
            : current.rateLimitResetTime,
      };
      if (this.database.updateExistingAccounts([updated]) === 1) {
        const persisted = { ...updated, generation: current.generation + 1 };
        this.replaceAccount(persisted);
        return cloneAccount(persisted);
      }
    }
    this.reconcileFromDb();
    throw new AccountConcurrentUpdateError(account.id);
  }

  /**
   * Marks an account unhealthy until a later successful refresh heals it
   * (updateFromAuth resets isHealthy/failCount). Every production caller
   * passes a refresh-token-dead reason, so the former transient fail-count
   * ladder (unreachable, and never reset) is gone: failCount is a binary
   * marker, 10 when marked and 0 when healed.
   */
  markUnhealthy(account: ManagedAccount, reason: string): StoredAccount | undefined {
    const now = Date.now();
    return this.patchAccount(account.id, (latest) => ({
      ...latest,
      failCount: 10,
      isHealthy: false,
      unhealthyReason: reason,
      recoveryTime: undefined,
      lastUsed: now,
    }));
  }

  /** Persist refresh failure only for the credential epoch that actually failed. */
  recordRefreshFailure(account: ManagedAccount, error: unknown): StoredAccount | undefined {
    if (error instanceof KiroTokenRefreshError && error.code === "REFRESH_BACKOFF") {
      return this.getLatestAccount(account.id);
    }
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = this.database.getById(account.id);
      if (!current) return undefined;
      if (!sameCredentialTuple(account, current)) {
        this.replaceAccount(cloneAccount(current));
        return cloneAccount(current);
      }
      const now = Date.now();
      const previousCount = current.refreshFailureCount ?? 0;
      const count = Math.min(Number.MAX_SAFE_INTEGER, previousCount + 1);
      const reason = errorReason(error);
      const permanent = isRefreshTokenDead(reason);
      const updated: StoredAccount = {
        ...current,
        refreshFailureCount: count,
        refreshFailureCode: refreshFailureCode(error),
        refreshFailedAt: now,
        ...(permanent
          ? {
              isHealthy: false,
              failCount: 10,
              unhealthyReason: toDeadReason(reason),
              recoveryTime: undefined,
            }
          : { refreshRetryAt: now + refreshFailureDelayMs(count) }),
      };
      if (this.database.updateExistingAccounts([updated]) === 1) {
        const persisted = { ...updated, generation: current.generation + 1 };
        this.replaceAccount(persisted);
        return cloneAccount(persisted);
      }
    }
    this.reconcileFromDb();
    throw new AccountConcurrentUpdateError(account.id);
  }

  updateFromAuth(account: StoredAccount, auth: KiroAuthDetails): StoredAccount | undefined {
    const refresh = decodeRefreshToken(auth.refresh);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = attempt === 0 ? account : this.database.getById(account.id);
      if (!current) {
        this.reconcileFromDb();
        return undefined;
      }
      if (attempt > 0 && !sameCredentialTuple(account, current)) {
        // Another writer already rotated this login's credentials; adopt the
        // newer row instead of overwriting it with this refresh result.
        if (canAdoptRefreshedAccount(account, current, 0)) {
          this.replaceAccount(cloneAccount(current));
          return cloneAccount(current);
        }
        this.reconcileFromDb();
        return undefined;
      }
      const updated: StoredAccount = {
        ...current,
        refreshToken: refresh.refreshToken,
        accessToken: auth.access,
        expiresAt: auth.expires,
        lastRefreshAt: Date.now(),
        refreshFailureCount: undefined,
        refreshFailureCode: undefined,
        refreshFailedAt: undefined,
        refreshRetryAt: undefined,
        ...(auth.email
          ? { email: current.email !== account.email ? current.email : auth.email }
          : {}),
        isHealthy: true,
        failCount: 0,
        unhealthyReason: undefined,
        recoveryTime: undefined,
      };
      if (this.database.updateExistingAccounts([updated]) === 1) {
        const persisted = { ...updated, generation: current.generation + 1 };
        this.replaceAccount(persisted);
        return cloneAccount(persisted);
      }
    }
    this.reconcileFromDb();
    return undefined;
  }

  toAuthDetails(account: ManagedAccount): KiroAuthDetails {
    return toAuthDetails(account);
  }

  private patchAccount(id: string, patch: AccountPatch): StoredAccount | undefined {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const latest = this.database.getById(id);
      if (!latest) {
        this.dropAccount(id);
        return undefined;
      }
      const updated = patch(latest);
      if (this.database.updateExistingAccounts([updated]) === 1) {
        const persisted = { ...updated, generation: latest.generation + 1 };
        this.replaceAccount(persisted);
        return cloneAccount(persisted);
      }
    }
    this.reconcileFromDb();
    throw new AccountConcurrentUpdateError(id);
  }

  /** Forgets an account that vanished from the database and releases its SDK transports. */
  private dropAccount(id: string): void {
    this.accounts = this.accounts.filter((account) => account.id !== id);
    this.selector.forget(id);
    evictSdkClientsForAccount(id);
  }

  private replaceAccount(account: StoredAccount): void {
    const index = this.accounts.findIndex(({ id }) => id === account.id);
    if (index === -1) this.accounts.push(account);
    else this.accounts[index] = account;
  }
}
