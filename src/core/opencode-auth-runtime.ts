import type { OpenCodeAuthStore } from "../auth/opencode-auth-store.js";
import {
	openCodePluginDirForDatabase,
	sameTokenSnapshot,
} from "../auth/opencode-auth-store.js";
import { withOpenCodeRefreshLock } from "../auth/opencode-refresh-lock.js";
import { accessTokenExpired, decodeRefreshToken } from "../kiro/auth.js";
import {
	isPermanentError,
	isRefreshTokenDead,
	toDeadReason,
} from "../kiro/health.js";
import { refreshAccessToken } from "../kiro/token.js";
import type {
	AccountSelectionStrategy,
	KiroAuthDetails,
	KiroUsageSnapshot,
	ManagedAccount,
} from "../kiro/types.js";
import { errorReason } from "./account-errors.js";
import { toAuthDetails } from "./account-manager.js";
import {
	AccountSelector,
	countSelectable,
	selectableCandidates,
} from "./account-selection.js";
import { evictSdkClientsForAccount } from "./sdk-client.js";
import { AccountUnavailableError } from "./token-refresher.js";

function cloneAccount(account: ManagedAccount): ManagedAccount {
	return { ...account };
}

export class OpenCodeAccountManager {
	private accounts: ManagedAccount[] = [];
	private readonly selector: AccountSelector;

	constructor(
		private readonly store: OpenCodeAuthStore,
		strategy: AccountSelectionStrategy,
	) {
		this.selector = new AccountSelector(strategy);
		this.reconcileFromDb();
	}

	/**
	 * Re-reads every live row. Accounts that vanished (removed or tombstoned by
	 * another OpenCode writer) lose their cached SDK transports, mirroring
	 * AccountManager.reconcileFromDb.
	 */
	reconcileFromDb(): readonly ManagedAccount[] {
		const previousIds = this.accounts.map(({ id }) => id);
		this.accounts = this.store.getAccounts();
		const survivingIds = new Set(this.accounts.map(({ id }) => id));
		for (const id of previousIds) {
			if (!survivingIds.has(id)) evictSdkClientsForAccount(id);
		}
		this.selector.retainSticky(this.accounts);
		return this.accounts.map(cloneAccount);
	}

	selectHealthyAccount(
		preferredAccountId?: string,
		eligibleAccountIds?: ReadonlySet<string>,
	): ManagedAccount | null {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const now = Date.now();
			const candidates = selectableCandidates(
				this.accounts,
				now,
				eligibleAccountIds,
			);
			if (candidates.length === 0) return null;

			const selected = this.selector.pick(candidates, preferredAccountId);
			const persisted = this.store.recordSelection(selected.id, now);
			if (persisted) {
				this.publishLatest(persisted);
				return cloneAccount(persisted);
			}
			this.reconcileFromDb();
		}
		return null;
	}

	getAccountCount(): number {
		return this.accounts.length;
	}

	/**
	 * Number of accounts selectHealthyAccount could return right now among the
	 * eligible ids; same semantics as AccountManager.countSelectableAccounts, so
	 * the pipeline's failover classifier sees the same alternative count in
	 * both auth modes instead of a row-based approximation.
	 */
	countSelectableAccounts(
		eligibleAccountIds?: ReadonlySet<string>,
		now = Date.now(),
	): number {
		return countSelectable(this.accounts, now, eligibleAccountIds);
	}

	toAuthDetails(account: ManagedAccount): KiroAuthDetails {
		return toAuthDetails(account);
	}

	markRateLimited(
		account: ManagedAccount,
		resetTime: number,
	): ManagedAccount | undefined {
		const updated = this.store.markRateLimited(account.id, resetTime);
		if (updated) this.publishLatest(updated);
		else this.reconcileFromDb();
		return updated === undefined ? undefined : cloneAccount(updated);
	}

	markQuotaExhausted(
		account: ManagedAccount,
		recheckAfter: number,
	): ManagedAccount | undefined {
		const updated = this.store.markQuotaExhausted(account.id, recheckAfter);
		if (updated) this.publishLatest(updated);
		else this.reconcileFromDb();
		return updated === undefined ? undefined : cloneAccount(updated);
	}

	scheduleQuotaRecheck(
		account: ManagedAccount,
		recheckAfter: number,
	): ManagedAccount | undefined {
		const updated = this.store.scheduleQuotaRecheck(
			account.id,
			recheckAfter,
		);
		if (updated) this.publishLatest(updated);
		else this.reconcileFromDb();
		return updated === undefined ? undefined : cloneAccount(updated);
	}

	updateQuotaUsage(
		account: ManagedAccount,
		usage: KiroUsageSnapshot & { readonly lastSync: number },
		nextRecheckAt: number,
	): ManagedAccount | undefined {
		const updated = this.store.updateQuotaUsage(
			account.id,
			usage,
			nextRecheckAt,
		);
		if (updated) this.publishLatest(updated);
		else this.reconcileFromDb();
		return updated === undefined ? undefined : cloneAccount(updated);
	}

	/**
	 * Mirrors AccountManager.markUnhealthy for refresh-token-dead reasons, the
	 * only kind production callers pass: a binary permanent marker (fail_count
	 * 10, unhealthy, no recovery time). Any other reason falls through to the
	 * shared store's fail_count ladder, documented on
	 * OpenCodeAuthStore.markUnhealthy.
	 */
	markUnhealthy(
		account: ManagedAccount,
		reason: string,
		recoveryTime?: number,
	): ManagedAccount | undefined {
		const updated = this.store.markUnhealthy(
			account.id,
			reason,
			isPermanentError(reason),
			recoveryTime,
			Date.now(),
		);
		if (updated) this.publishLatest(updated);
		else this.reconcileFromDb();
		return updated === undefined ? undefined : cloneAccount(updated);
	}

	publishLatest(account: ManagedAccount): void {
		const index = this.accounts.findIndex(({ id }) => id === account.id);
		if (index === -1) this.accounts.push(cloneAccount(account));
		else this.accounts[index] = cloneAccount(account);
	}
}

export class OpenCodeTokenRefresher {
	private readonly inFlight = new Map<string, Promise<ManagedAccount>>();
	private readonly lockDirectory: string;

	constructor(
		private readonly accountManager: OpenCodeAccountManager,
		private readonly store: OpenCodeAuthStore,
		private readonly tokenExpiryBufferMs: number,
		private readonly proxyUrl?: string,
		lockDirectory: string = openCodePluginDirForDatabase(store.path),
	) {
		this.lockDirectory = lockDirectory;
	}

	async refreshIfNeeded(
		account: ManagedAccount,
		_auth: KiroAuthDetails,
		signal?: AbortSignal,
	): Promise<ManagedAccount> {
		const latest = this.store.getById(account.id);
		if (!latest) throw new AccountUnavailableError(account.id);
		this.accountManager.publishLatest(latest);
		if (
			!accessTokenExpired(
				this.accountManager.toAuthDetails(latest),
				this.tokenExpiryBufferMs,
			)
		) {
			return latest;
		}
		return this.startOrJoinRefresh(account, false, signal);
	}

	async forceRefresh(
		account: ManagedAccount,
		signal?: AbortSignal,
	): Promise<ManagedAccount> {
		return this.startOrJoinRefresh(account, true, signal);
	}

	private startOrJoinRefresh(
		account: ManagedAccount,
		force: boolean,
		signal?: AbortSignal,
	): Promise<ManagedAccount> {
		const existing = this.inFlight.get(account.id);
		if (existing) return existing;

		const refresh = this.runLockedRefresh(account, force, signal).finally(() => {
			if (this.inFlight.get(account.id) === refresh) {
				this.inFlight.delete(account.id);
			}
		});
		this.inFlight.set(account.id, refresh);
		return refresh;
	}

	private async runLockedRefresh(
		startedAccount: ManagedAccount,
		force: boolean,
		signal?: AbortSignal,
	): Promise<ManagedAccount> {
		return withOpenCodeRefreshLock(
			this.lockDirectory,
			startedAccount.id,
			async () => {
				const latest = this.store.getById(startedAccount.id);
				if (!latest) throw new AccountUnavailableError(startedAccount.id);
				const latestAuth = this.accountManager.toAuthDetails(latest);

				if (
					(force && !sameTokenSnapshot(startedAccount, latest)) ||
					(!force &&
						!accessTokenExpired(latestAuth, this.tokenExpiryBufferMs))
				) {
					this.accountManager.publishLatest(latest);
					return latest;
				}

				try {
					const refreshedAuth = await refreshAccessToken(
						latestAuth,
						signal,
						this.proxyUrl,
					);
					const refresh = decodeRefreshToken(refreshedAuth.refresh);
					const candidate: ManagedAccount = {
						...latest,
						refreshToken: refresh.refreshToken,
						accessToken: refreshedAuth.access,
						expiresAt: refreshedAuth.expires,
						lastUsed: Date.now(),
						isHealthy: true,
						failCount: 0,
						unhealthyReason: undefined,
						recoveryTime: undefined,
						...(refreshedAuth.email
							? { email: refreshedAuth.email }
							: {}),
						...(refresh.clientId
							? { clientId: refresh.clientId }
							: {}),
						...(refresh.clientSecret
							? { clientSecret: refresh.clientSecret }
							: {}),
					};
					const persisted = this.store.persistRefreshedAccount(
						latest,
						candidate,
					);
					if (!persisted) {
						throw new AccountUnavailableError(startedAccount.id);
					}
					this.accountManager.publishLatest(persisted);
					return persisted;
				} catch (error) {
					const reason = errorReason(error);
					if (isRefreshTokenDead(reason)) {
						this.accountManager.markUnhealthy(
							latest,
							toDeadReason(reason),
						);
					}
					throw error;
				}
			},
			signal,
		);
	}
}
