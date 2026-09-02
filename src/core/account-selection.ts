import {
	isAccessTokenError,
	isPermanentError,
	isQuotaExhausted,
} from "../kiro/health.js";
import type { AccountSelectionStrategy, ManagedAccount } from "../kiro/types.js";

function assertNever(value: never): never {
	throw new TypeError(`Unsupported account selection strategy: ${String(value)}`);
}

/**
 * Whether selectHealthyAccount may hand out this account right now: not
 * permanently dead, not quota-exhausted, not inside a rate-limit cooldown, and
 * either healthy, only suffering a refreshable access-token error, or past its
 * transient recovery time. Shared by the local and OpenCode account managers so
 * both apply the same health semantics.
 */
export function isSelectableAccount(account: ManagedAccount, now: number): boolean {
	if (isPermanentError(account.unhealthyReason)) return false;
	if (isQuotaExhausted(account)) return false;
	if (account.rateLimitResetTime > now) return false;
	if (account.isHealthy || isAccessTokenError(account.unhealthyReason)) return true;
	return account.recoveryTime !== undefined && account.recoveryTime <= now;
}

/** Selectable accounts restricted to the eligible ids, in stable id order. */
export function selectableCandidates<T extends ManagedAccount>(
	accounts: readonly T[],
	now: number,
	eligibleAccountIds?: ReadonlySet<string>,
): T[] {
	return accounts
		.filter((account) => isSelectableAccount(account, now))
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
): number {
	return accounts.filter(
		(account) =>
			isSelectableAccount(account, now) && (eligibleAccountIds?.has(account.id) ?? true),
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
			candidates.find(({ id }) => id === preferredAccountId) ??
			this.pickByStrategy(candidates)
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
