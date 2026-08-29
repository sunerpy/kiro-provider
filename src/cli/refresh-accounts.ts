import type { Config } from "../config/schema.js";
import { AccountManager } from "../core/account-manager.js";
import { resolveProxyUrl } from "../core/proxy.js";
import {
	type AccountRefreshSummary,
	QuotaRechecker,
	type QuotaRecheckerOptions,
} from "../core/quota-rechecker.js";
import { TokenRefresher } from "../core/token-refresher.js";
import {
	ACCOUNTS_DB_PATH,
	AccountsDatabase,
} from "../storage/accounts-db.js";
import { resolveAccount } from "./account-output.js";

export type RefreshAccountsOptions = {
	readonly identifier?: string;
	readonly signal?: AbortSignal;
};

export type RefreshAccountsDependencies = {
	readonly openDb?: (path: string) => AccountsDatabase;
	readonly fetchUsage?: QuotaRecheckerOptions["fetchUsage"];
	readonly now?: () => number;
};

export async function runAccountRefresh(
	config: Config,
	options: RefreshAccountsOptions = {},
	dependencies: RefreshAccountsDependencies = {},
): Promise<AccountRefreshSummary> {
	const database =
		dependencies.openDb?.(ACCOUNTS_DB_PATH) ??
		new AccountsDatabase(ACCOUNTS_DB_PATH);
	try {
		const accountManager = new AccountManager(
			database.getAccounts(),
			config.account_selection_strategy,
			database,
		);
		const tokenRefresher = new TokenRefresher(
			accountManager,
			config.token_expiry_buffer_ms,
			resolveProxyUrl(config),
		);
		const quotaRechecker = new QuotaRechecker({
			accountManager,
			tokenRefresher,
			intervalMs: config.quota_recheck_interval_ms,
			usageRefreshIntervalMs: config.usage_refresh_interval_ms,
			timeoutMs: config.quota_recheck_timeout_ms,
			concurrency: config.account_maintenance_concurrency,
			proxyUrl: resolveProxyUrl(config),
			...(dependencies.fetchUsage
				? { fetchUsage: dependencies.fetchUsage }
				: {}),
			...(dependencies.now ? { now: dependencies.now } : {}),
		});
		const available = accountManager.getAccounts();
		const accounts = options.identifier
			? [resolveAccount(available, options.identifier)]
			: available;
		const timeoutSignal = AbortSignal.timeout(
			config.account_maintenance_timeout_ms,
		);
		const signal = options.signal
			? AbortSignal.any([options.signal, timeoutSignal])
			: timeoutSignal;
		return await quotaRechecker.refreshAccounts(accounts, signal);
	} finally {
		database.close();
	}
}
