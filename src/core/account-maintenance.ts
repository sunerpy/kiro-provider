import { accessTokenExpired } from "../kiro/auth.js";
import {
	isPermanentError,
	isQuotaExhausted,
	isRefreshTokenDead,
	toDeadReason,
} from "../kiro/health.js";
import type { KiroAuthDetails, ManagedAccount } from "../kiro/types.js";
import { auditHash, auditLog } from "./audit-log.js";
import type { PipelineQuotaRechecker } from "./quota-rechecker.js";

interface MaintenanceAccountManager {
	reconcileFromDb(): readonly ManagedAccount[];
	toAuthDetails(account: ManagedAccount): KiroAuthDetails;
	markUnhealthy(
		account: ManagedAccount,
		reason: string,
		recoveryTime?: number,
	): unknown;
}

interface MaintenanceTokenRefresher {
	refreshIfNeeded(
		account: ManagedAccount,
		auth: KiroAuthDetails,
		signal?: AbortSignal,
	): Promise<ManagedAccount>;
}

export interface PipelineAccountMaintenance {
	start(): void;
	stop(): void;
	runOnce(signal?: AbortSignal): Promise<void>;
}

export interface AccountMaintenanceOptions {
	readonly enabled: boolean;
	readonly intervalMs: number;
	readonly timeoutMs: number;
	readonly concurrency: number;
	readonly tokenExpiryBufferMs: number;
	readonly accountManager: MaintenanceAccountManager;
	readonly tokenRefresher: MaintenanceTokenRefresher;
	readonly usageRefresher: PipelineQuotaRechecker;
	readonly initialDelayMs?: number;
}

type TimerHandle = ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;

function unrefTimer(timer: TimerHandle): void {
	if (
		typeof timer === "object" &&
		timer !== null &&
		"unref" in timer &&
		typeof timer.unref === "function"
	) {
		timer.unref();
	}
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

export class AccountMaintenanceService implements PipelineAccountMaintenance {
	private initialTimer: ReturnType<typeof setTimeout> | undefined;
	private intervalTimer: ReturnType<typeof setInterval> | undefined;
	private lifecycleController = new AbortController();
	private inFlight: Promise<void> | undefined;

	constructor(private readonly options: AccountMaintenanceOptions) {}

	start(): void {
		if (
			!this.options.enabled ||
			this.initialTimer !== undefined ||
			this.intervalTimer !== undefined
		) {
			return;
		}
		this.lifecycleController = new AbortController();
		const trigger = (): void => {
			void this.runOnce(this.lifecycleController.signal).catch((error) => {
				if (this.lifecycleController.signal.aborted) return;
				auditLog("warn", "account_maintenance_pass_failed", {
					...errorFields(error),
				});
			});
		};
		this.initialTimer = setTimeout(() => {
			this.initialTimer = undefined;
			trigger();
		}, this.options.initialDelayMs ?? 5_000);
		this.intervalTimer = setInterval(trigger, this.options.intervalMs);
		unrefTimer(this.initialTimer);
		unrefTimer(this.intervalTimer);
		auditLog("info", "account_maintenance_started", {
			interval_ms: this.options.intervalMs,
			timeout_ms: this.options.timeoutMs,
			concurrency: this.options.concurrency,
		});
	}

	stop(): void {
		if (this.initialTimer !== undefined) {
			clearTimeout(this.initialTimer);
			this.initialTimer = undefined;
		}
		if (this.intervalTimer !== undefined) {
			clearInterval(this.intervalTimer);
			this.intervalTimer = undefined;
		}
		if (!this.lifecycleController.signal.aborted) {
			this.lifecycleController.abort(
				new DOMException("Account maintenance stopped", "AbortError"),
			);
		}
		auditLog("info", "account_maintenance_stopped", {});
	}

	runOnce(signal?: AbortSignal): Promise<void> {
		if (!this.options.enabled) return Promise.resolve();
		if (this.inFlight) return this.inFlight;
		const operation = this.runPass(signal).finally(() => {
			if (this.inFlight === operation) this.inFlight = undefined;
		});
		this.inFlight = operation;
		return operation;
	}

	private async runPass(parentSignal?: AbortSignal): Promise<void> {
		const startedAt = Date.now();
		const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs);
		const signal = parentSignal
			? AbortSignal.any([parentSignal, timeoutSignal])
			: timeoutSignal;
		const accounts = this.options.accountManager.reconcileFromDb();
		const tokenCandidates = accounts.filter(
			(account) =>
				!isPermanentError(account.unhealthyReason) &&
				!isQuotaExhausted(account) &&
				accessTokenExpired(
					this.options.accountManager.toAuthDetails(account),
					this.options.tokenExpiryBufferMs,
				),
		);
		let tokenRefreshed = 0;
		let tokenFailed = 0;
		let cursor = 0;
		const worker = async (): Promise<void> => {
			for (;;) {
				if (signal.aborted) throw signal.reason;
				const account = tokenCandidates[cursor];
				cursor += 1;
				if (!account) return;
				try {
					await this.options.tokenRefresher.refreshIfNeeded(
						account,
						this.options.accountManager.toAuthDetails(account),
						signal,
					);
					tokenRefreshed += 1;
				} catch (error) {
					tokenFailed += 1;
					const reason = errorReason(error);
					if (isRefreshTokenDead(reason)) {
						try {
							this.options.accountManager.markUnhealthy(
								account,
								toDeadReason(reason),
							);
						} catch {
							// The account may have been removed while maintenance ran.
						}
					}
					auditLog("warn", "account_maintenance_token_refresh_failed", {
						account_hash: auditHash(account.id),
						...errorFields(error),
					});
				}
			}
		};
		await Promise.all(
			Array.from(
				{
					length: Math.min(
						this.options.concurrency,
						tokenCandidates.length,
					),
				},
				worker,
			),
		);
		const refreshedAccounts = this.options.accountManager.reconcileFromDb();
		await this.options.usageRefresher.recheckDueAccounts(
			refreshedAccounts,
			signal,
		);
		const usageAccounts = this.options.accountManager.reconcileFromDb();
		await this.options.usageRefresher.syncDueAccounts(usageAccounts, signal);
		auditLog("info", "account_maintenance_pass_completed", {
			account_count: usageAccounts.length,
			token_due_count: tokenCandidates.length,
			token_refreshed_count: tokenRefreshed,
			token_failed_count: tokenFailed,
			duration_ms: Date.now() - startedAt,
		});
	}
}

type StoppableServer = {
	stop(closeActiveConnections?: boolean): void;
};

export function bindAccountMaintenanceLifecycle<T extends StoppableServer>(
	server: T,
	maintenance: PipelineAccountMaintenance | undefined,
): T {
	if (!maintenance) return server;
	maintenance.start();
	const originalStop = server.stop.bind(server);
	const stop = (closeActiveConnections?: boolean): void => {
		try {
			maintenance.stop();
		} finally {
			originalStop(closeActiveConnections);
		}
	};
	try {
		Object.defineProperty(server, "stop", {
			configurable: true,
			value: stop,
		});
	} catch (error) {
		try {
			maintenance.stop();
		} finally {
			originalStop(true);
		}
		throw error;
	}
	return server;
}
