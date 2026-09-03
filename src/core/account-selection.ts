import {
  DEFAULT_OVERAGE_POLICY,
  isAccessTokenError,
  isIncludedQuotaExhausted,
  isOverageBlocked,
  isPermanentError,
  isQuotaExhausted,
  type OveragePolicy,
} from "../kiro/health.js";
import type { AccountSelectionStrategy, ManagedAccount } from "../kiro/types.js";

function assertNever(value: never): never {
  throw new TypeError(`Unsupported account selection strategy: ${String(value)}`);
}

/**
 * Whether selectHealthyAccount may hand out this account right now: not
 * permanently dead, not quota-exhausted under the overage policy, not inside a
 * rate-limit cooldown, and either healthy, only suffering a refreshable
 * access-token error, or past its transient recovery time. Shared by
 * AccountManager, the pipeline and the maintenance paths so all apply the same
 * health semantics.
 */
export function isSelectableAccount(
  account: ManagedAccount,
  now: number,
  policy: OveragePolicy = DEFAULT_OVERAGE_POLICY,
): boolean {
  if (isPermanentError(account.unhealthyReason)) return false;
  if (isQuotaExhausted(account, policy)) return false;
  if (account.rateLimitResetTime > now) return false;
  return hasUsableHealth(account, now);
}

function hasUsableHealth(account: ManagedAccount, now: number): boolean {
  if (account.isHealthy || isAccessTokenError(account.unhealthyReason)) return true;
  return account.recoveryTime !== undefined && account.recoveryTime <= now;
}

/**
 * Whether the overage gate is the only thing keeping this account out of
 * selection: overage above the threshold, but not dead, not exhausted on its
 * included quota, and with usable health. The rate-limit cooldown is ignored
 * on purpose: an exhausted account stores its next quota recheck time there,
 * so honoring it would hide the very accounts the gate parked.
 */
export function isBlockedOnlyByOverage(
  account: ManagedAccount,
  now: number,
  policy: OveragePolicy = DEFAULT_OVERAGE_POLICY,
): boolean {
  if (!isOverageBlocked(account, policy)) return false;
  if (isPermanentError(account.unhealthyReason)) return false;
  if (isIncludedQuotaExhausted(account)) return false;
  return hasUsableHealth(account, now);
}

/** Selectable accounts restricted to the eligible ids, in stable id order. */
export function selectableCandidates<T extends ManagedAccount>(
  accounts: readonly T[],
  now: number,
  eligibleAccountIds?: ReadonlySet<string>,
  policy: OveragePolicy = DEFAULT_OVERAGE_POLICY,
): T[] {
  return accounts
    .filter((account) => isSelectableAccount(account, now, policy))
    .filter((account) => eligibleAccountIds?.has(account.id) ?? true)
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Number of accounts selectHealthyAccount could return right now, optionally
 * restricted to the eligible ids. The pipeline uses it as the failover
 * alternative count.
 */
export function countSelectable(
  accounts: readonly ManagedAccount[],
  now: number,
  eligibleAccountIds?: ReadonlySet<string>,
  policy: OveragePolicy = DEFAULT_OVERAGE_POLICY,
): number {
  return accounts.filter(
    (account) =>
      isSelectableAccount(account, now, policy) && (eligibleAccountIds?.has(account.id) ?? true),
  ).length;
}

/**
 * Strategy state (sticky pointer, round-robin cursor) shared by the local and
 * OpenCode account managers so both pick the same account for the same input.
 */
export class AccountSelector {
  private stickyId: string | undefined;
  private roundRobinCursor = 0;

  constructor(private readonly strategy: AccountSelectionStrategy) {}

  /**
   * The preferred account when it is a candidate, otherwise the strategy's
   * pick. A preferred hit neither advances the round-robin cursor nor moves
   * the sticky pointer. Throws RangeError for an empty candidate list.
   */
  pick<T extends ManagedAccount>(candidates: readonly T[], preferredAccountId?: string): T {
    return (
      candidates.find(({ id }) => id === preferredAccountId) ?? this.pickByStrategy(candidates)
    );
  }

  /** Forgets the sticky pointer when its account is no longer present. */
  retainSticky(accounts: readonly ManagedAccount[]): void {
    if (this.stickyId && !accounts.some(({ id }) => id === this.stickyId)) {
      this.stickyId = undefined;
    }
  }

  /** Forgets the sticky pointer when it names the given account. */
  forget(accountId: string): void {
    if (this.stickyId === accountId) this.stickyId = undefined;
  }

  private pickByStrategy<T extends ManagedAccount>(candidates: readonly T[]): T {
    switch (this.strategy) {
      case "sticky": {
        const sticky = candidates.find(({ id }) => id === this.stickyId);
        const selected = sticky ?? candidates[0];
        if (!selected) throw new RangeError("Candidate list cannot be empty");
        this.stickyId = selected.id;
        return selected;
      }
      case "round-robin": {
        const selected = candidates[this.roundRobinCursor % candidates.length];
        if (!selected) throw new RangeError("Candidate list cannot be empty");
        this.roundRobinCursor += 1;
        return selected;
      }
      case "lowest-usage": {
        const selected = [...candidates].sort(
          (left, right) =>
            (left.usedCount ?? 0) - (right.usedCount ?? 0) ||
            (left.lastUsed ?? 0) - (right.lastUsed ?? 0) ||
            left.id.localeCompare(right.id),
        )[0];
        if (!selected) throw new RangeError("Candidate list cannot be empty");
        return selected;
      }
      default:
        return assertNever(this.strategy);
    }
  }
}
