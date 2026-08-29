import type { OpenCodeAuthStore } from "../auth/opencode-auth-store.js";
import { openCodePluginDirForDatabase } from "../auth/opencode-auth-store.js";
import { withOpenCodeRefreshLock } from "../auth/opencode-refresh-lock.js";
import { accessTokenExpired, decodeRefreshToken } from "../kiro/auth.js";
import {
	isAccessTokenError,
	isPermanentError,
	isQuotaExhausted,
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
import { toAuthDetails } from "./account-manager.js";
import { AccountUnavailableError } from "./token-refresher.js";

function cloneAccount(account: ManagedAccount): ManagedAccount {
	return { ...account };
}

function assertNever(value: never): never {
	throw new TypeError(`Unsupported account selection strategy: ${String(value)}`);
}

function sameTokenSnapshot(
	left: ManagedAccount,
	right: ManagedAccount,
): boolean {
	return (
		left.refreshToken === right.refreshToken &&
		left.accessToken === right.accessToken &&
		left.expiresAt === right.expiresAt &&
		left.authMethod === right.authMethod &&
		left.clientId === right.clientId &&
		left.clientSecret === right.clientSecret &&
		left.profileArn === right.profileArn &&
		left.email === right.email &&
		left.startUrl === right.startUrl
	);
}

export class OpenCodeAccountManager {
	private accounts: ManagedAccount[] = [];
	private stickyId: string | undefined;
	private roundRobinCursor = 0;

	constructor(
		private readonly store: OpenCodeAuthStore,
		private readonly strategy: AccountSelectionStrategy,
	) {
		this.reconcileFromDb();
	}

	reconcileFromDb(): readonly ManagedAccount[] {
		this.accounts = this.store.getAccounts();
		if (
			this.stickyId &&
			!this.accounts.some(({ id }) => id === this.stickyId)
		) {
			this.stickyId = undefined;
		}
		return this.accounts.map(cloneAccount);
	}

	selectHealthyAccount(
		preferredAccountId?: string,
		eligibleAccountIds?: ReadonlySet<string>,
	): ManagedAccount | null {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const now = Date.now();
			const candidates = this.accounts
				.filter((account) => this.isSelectable(account, now))
				.filter((account) => eligibleAccountIds?.has(account.id) ?? true)
				.sort((left, right) => left.id.localeCompare(right.id));
			if (candidates.length === 0) return null;

			const selected =
				candidates.find(({ id }) => id === preferredAccountId) ??
				this.selectCandidate(candidates);
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

	private isSelectable(account: ManagedAccount, now: number): boolean {
		if (isPermanentError(account.unhealthyReason)) return false;
		if (isQuotaExhausted(account)) return false;
		if (account.rateLimitResetTime > now) return false;
		if (account.isHealthy || isAccessTokenError(account.unhealthyReason)) {
			return true;
		}
		return account.recoveryTime !== undefined && account.recoveryTime <= now;
	}

	private selectCandidate(
		candidates: readonly ManagedAccount[],
	): ManagedAccount {
		switch (this.strategy) {
			case "sticky": {
				const sticky = candidates.find(({ id }) => id === this.stickyId);
				const selected = sticky ?? candidates[0];
				if (!selected) throw new RangeError("Candidate list cannot be empty");
				this.stickyId = selected.id;
				return selected;
			}
			case "round-robin": {
				const selected =
					candidates[this.roundRobinCursor % candidates.length];
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
					const code =
						typeof error === "object" &&
						error !== null &&
						"code" in error
							? String(error.code)
							: "";
					const message =
						error instanceof Error ? error.message : String(error);
					const reason = code ? `${code}: ${message}` : message;
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
