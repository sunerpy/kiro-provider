import {
	isPermanentError,
	isQuotaExhausted,
	isRefreshTokenDead,
	toDeadReason,
} from "../kiro/health.js";
import type {
	KiroAuthDetails,
	KiroUsageSnapshot,
	ManagedAccount,
} from "../kiro/types.js";
import {
	fetchUsageLimits,
	isKiroUsageAuthenticationError,
	KiroUsageError,
} from "../kiro/usage-client.js";
import { auditHash, auditLog } from "./audit-log.js";
import { abortable, abortReason } from "./pipeline-runtime.js";

interface QuotaAccountManager {
	toAuthDetails(account: ManagedAccount): KiroAuthDetails;
	markUnhealthy(
		account: ManagedAccount,
		reason: string,
		recoveryTime?: number,
	): unknown;
	scheduleQuotaRecheck(
		account: ManagedAccount,
		recheckAfter: number,
	): ManagedAccount | undefined;
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
	forceRefresh(
		account: ManagedAccount,
		signal?: AbortSignal,
	): Promise<ManagedAccount>;
}

export interface PipelineQuotaRechecker {
	recheckDueAccounts(
		accounts: readonly ManagedAccount[],
		signal: AbortSignal,
		preferredAccountId?: string,
	): Promise<void>;
	syncDueAccounts(
		accounts: readonly ManagedAccount[],
		signal: AbortSignal,
	): Promise<void>;
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

type QuotaRecheckResult =
	| "updated"
	| "recovered"
	| "exhausted"
	| "failed"
	| "skipped";
type BatchKind = "quota_recheck" | "usage_refresh";

function isQuotaRecheckDue(account: ManagedAccount, now: number): boolean {
	return (
		isQuotaExhausted(account) &&
		!isPermanentError(account.unhealthyReason) &&
		account.rateLimitResetTime <= now
	);
}

function errorReason(error: unknown): string {
	const code =
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
			? error.code
			: undefined;
	const message = error instanceof Error ? error.message : String(error);
	return code ? `${code}: ${message}` : message;
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
	const code =
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
			? error.code
			: undefined;
	return {
		error_name: error instanceof Error ? error.name : "UnknownError",
		error_code: code,
	};
}

export class QuotaRechecker implements PipelineQuotaRechecker {
	private readonly inFlight = new Map<
		string,
		Promise<QuotaRecheckResult>
	>();
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
					Number(right.id === preferredAccountId) -
						Number(left.id === preferredAccountId) ||
					left.rateLimitResetTime - right.rateLimitResetTime ||
					(left.lastSync ?? 0) - (right.lastSync ?? 0) ||
					left.id.localeCompare(right.id),
			);
		if (due.length === 0) return;

		await this.runBatch(
			due,
			signal,
			"quota_recheck",
			true,
			preferredAccountId,
		);
	}

	async syncDueAccounts(
		accounts: readonly ManagedAccount[],
		signal: AbortSignal,
	): Promise<void> {
		const startedAt = this.now();
		const due = accounts
			.filter((account) => this.isUsageRefreshDue(account, startedAt))
			.sort(
				(left, right) =>
					(left.lastSync ?? 0) - (right.lastSync ?? 0) ||
					left.id.localeCompare(right.id),
			);
		if (due.length === 0) return;
		await this.runBatch(due, signal, "usage_refresh", false);
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
				preferredAccountId !== undefined &&
				due.some(({ id }) => id === preferredAccountId),
		});

		const timeoutSignal = useBatchTimeout
			? AbortSignal.timeout(this.options.timeoutMs)
			: undefined;
		const batchSignal = timeoutSignal
			? AbortSignal.any([signal, timeoutSignal])
			: signal;
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
				const result = await abortable(
					this.startOrJoin(account),
					batchSignal,
				);
				counts[result] += 1;
			}
		};

		try {
			await Promise.all(
				Array.from(
					{ length: Math.min(this.options.concurrency, due.length) },
					worker,
				),
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
		if (
			isPermanentError(account.unhealthyReason) ||
			isQuotaExhausted(account)
		) {
			return false;
		}
		if ((this.usageRetryAfter.get(account.id) ?? 0) > now) return false;
		return (
			(account.lastSync ?? 0) + this.options.usageRefreshIntervalMs <= now
		);
	}

	private startOrJoin(account: ManagedAccount): Promise<QuotaRecheckResult> {
		const existing = this.inFlight.get(account.id);
		if (existing) return existing;

		const operation = this.runProbe(account).finally(() => {
			if (this.inFlight.get(account.id) === operation) {
				this.inFlight.delete(account.id);
			}
		});
		this.inFlight.set(account.id, operation);
		return operation;
	}

	private async runProbe(
		startedAccount: ManagedAccount,
	): Promise<QuotaRecheckResult> {
		const signal = AbortSignal.timeout(this.options.timeoutMs);
		let account = startedAccount;
		try {
			const initialAuth =
				this.options.accountManager.toAuthDetails(startedAccount);
			account = await this.options.tokenRefresher.refreshIfNeeded(
				startedAccount,
				initialAuth,
				signal,
			);
			if (
				!isQuotaRecheckDue(account, this.now()) &&
				!this.isUsageRefreshDue(account, this.now())
			) {
				return "skipped";
			}

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
				account = await this.options.tokenRefresher.forceRefresh(
					account,
					signal,
				);
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
				? lastSync + this.options.intervalMs
				: 0;
			const persisted = this.options.accountManager.updateQuotaUsage(
				account,
				{ ...usage, lastSync },
				nextRecheckAt,
			);
			if (!persisted) return "skipped";

			this.usageRetryAfter.delete(account.id);
			const persistedExhausted = isQuotaExhausted(persisted);
			if (persistedExhausted) {
				auditLog(
					"info",
					wasExhausted
						? "quota_recheck_still_exhausted"
						: "usage_refresh_detected_exhaustion",
					{
						account_hash: auditHash(account.id),
						next_recheck_at: persisted.rateLimitResetTime,
					},
				);
				return "exhausted";
			}
			if (wasExhausted) {
				auditLog("info", "quota_exhausted_account_recovered", {
					account_hash: auditHash(account.id),
				});
				return "recovered";
			}
			return "updated";
		} catch (error) {
			const nextRecheckAt = this.now() + this.options.intervalMs;
			const reason = errorReason(error);
			if (isRefreshTokenDead(reason)) {
				try {
					this.options.accountManager.markUnhealthy(
						account,
						toDeadReason(reason),
					);
				} catch {
					// The account may have been removed while its probe was in flight.
				}
				this.usageRetryAfter.delete(account.id);
			} else if (isQuotaExhausted(account)) {
				try {
					this.options.accountManager.scheduleQuotaRecheck(
						account,
						nextRecheckAt,
					);
				} catch {
					// The account may have been removed while its probe was in flight.
				}
			} else {
				this.usageRetryAfter.set(account.id, nextRecheckAt);
			}
			auditLog("warn", isQuotaExhausted(account)
				? "quota_recheck_failed"
				: "usage_refresh_failed", {
				account_hash: auditHash(startedAccount.id),
				next_recheck_at: nextRecheckAt,
				...errorFields(error),
			});
			return "failed";
		}
	}
}
