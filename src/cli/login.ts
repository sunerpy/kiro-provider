import { createHash } from "node:crypto";
import type { Config } from "../config/schema.js";
import { resolveProxyUrl } from "../core/proxy.js";
import { encodeRefreshToken } from "../kiro/auth.js";
import { isQuotaExhausted } from "../kiro/health.js";
import {
	authorizeKiroIDC,
	pollKiroIDCToken,
} from "../kiro/oauth-idc.js";
import { RegionSchema } from "../kiro/regions.js";
import type {
	KiroAuthDetails,
	KiroUsageSnapshot,
	ManagedAccount,
} from "../kiro/types.js";
import { fetchUsageLimits } from "../kiro/usage-client.js";
import {
	ACCOUNTS_DB_PATH,
	AccountsDatabase,
	type StoredAccount,
} from "../storage/accounts-db.js";

export type LoginOptions = {
	readonly startUrl?: string;
	readonly region?: string;
	readonly replaceAccount?: StoredAccount;
};

export type LoginResult = {
	readonly account: StoredAccount;
	readonly removedDuplicateIds: readonly string[];
};

export type LoginDependencies = {
	readonly authorize?: typeof authorizeKiroIDC;
	readonly poll?: typeof pollKiroIDCToken;
	readonly fetchUsage?: typeof fetchUsageLimits;
	readonly openDb?: (
		path: string,
	) => Pick<
		AccountsDatabase,
		"getAccounts" | "insertAccount" | "removeAccount" | "close"
	>;
	readonly stdout?: (message: string) => void;
};

export class ReloginIdentityMismatchError extends Error {
	constructor(
		readonly expectedEmail: string,
		readonly actualEmail: string,
	) {
		super(
			`Re-login authenticated ${actualEmail}, but the selected account is ${expectedEmail}. No credentials were changed.`,
		);
		this.name = "ReloginIdentityMismatchError";
	}
}

export function normalizeStartUrl(value: string | undefined): string | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const url = new URL(value.trim());
	url.hash = "";
	url.search = "";
	url.pathname = `${url.pathname.replace(/\/start\/?$/, "").replace(/\/+$/, "")}/start`;
	return url.toString();
}

function accountId(email: string, clientId: string): string {
	return createHash("sha256")
		.update(`${email}:idc:${clientId}:`)
		.digest("hex");
}

function normalizedEmail(value: string): string {
	return value.trim().toLowerCase();
}

function normalizedIdentityStartUrl(value: string | undefined): string {
	try {
		return normalizeStartUrl(value) ?? "";
	} catch {
		return value?.trim() ?? "";
	}
}

function isSameLoginIdentity(
	account: StoredAccount,
	reference: ManagedAccount,
): boolean {
	return (
		normalizedEmail(account.email) === normalizedEmail(reference.email) &&
		account.authMethod === reference.authMethod &&
		normalizedIdentityStartUrl(account.startUrl) ===
			normalizedIdentityStartUrl(reference.startUrl) &&
		(account.profileArn ?? "") === (reference.profileArn ?? "")
	);
}

function usageAuth(
	token: Awaited<ReturnType<typeof pollKiroIDCToken>>,
	region: ManagedAccount["region"],
	profileArn: string | undefined,
): KiroAuthDetails {
	return {
		refresh: encodeRefreshToken({
			refreshToken: token.refreshToken,
			clientId: token.clientId,
			clientSecret: token.clientSecret,
			authMethod: "idc",
		}),
		access: token.accessToken,
		expires: token.expiresAt,
		authMethod: "idc",
		region,
		oidcRegion: region,
		clientId: token.clientId,
		clientSecret: token.clientSecret,
		email: token.email,
		...(profileArn ? { profileArn } : {}),
	};
}

export async function runLogin(
	config: Config,
	options: LoginOptions = {},
	dependencies: LoginDependencies = {},
): Promise<LoginResult> {
	const authorize = dependencies.authorize ?? authorizeKiroIDC;
	const poll = dependencies.poll ?? pollKiroIDCToken;
	const fetchUsage = dependencies.fetchUsage ?? fetchUsageLimits;
	const stdout = dependencies.stdout ?? console.log;
	const replaceAccount = options.replaceAccount;
	const startUrl = normalizeStartUrl(
		options.startUrl ?? replaceAccount?.startUrl,
	);
	const region = RegionSchema.parse(
		options.region ??
			replaceAccount?.oidcRegion ??
			replaceAccount?.region ??
			config.default_region,
	);
	const proxyUrl = resolveProxyUrl(config);
	const authorization = await authorize(region, startUrl, proxyUrl);
	stdout(`Open this URL to sign in:\n${authorization.verificationUriComplete}`);

	const token = await poll(
		authorization.clientId,
		authorization.clientSecret,
		authorization.deviceCode,
		authorization.interval,
		authorization.expiresIn,
		region,
		undefined,
		proxyUrl,
	);
	let usage: KiroUsageSnapshot | undefined;
	let email = token.email;
	const refreshedAt = Date.now();
	if (replaceAccount) {
		usage = await fetchUsage(
			usageAuth(token, region, replaceAccount.profileArn),
			{
				proxyUrl,
				timeoutMs: config.quota_recheck_timeout_ms,
			},
		);
		if (!usage.email) {
			throw new Error(
				"Kiro usage verification did not return an account email. No credentials were changed.",
			);
		}
		email = usage.email;
		const selectedEmail = normalizedEmail(replaceAccount.email);
		if (
			selectedEmail !== "builder-id@aws.amazon.com" &&
			selectedEmail !== normalizedEmail(email)
		) {
			throw new ReloginIdentityMismatchError(replaceAccount.email, email);
		}
	}
	const account: ManagedAccount = {
		id: replaceAccount?.id ?? accountId(email, token.clientId),
		email,
		authMethod: "idc",
		region,
		oidcRegion: region,
		clientId: token.clientId,
		clientSecret: token.clientSecret,
		...(startUrl ? { startUrl } : {}),
		...(replaceAccount?.profileArn
			? { profileArn: replaceAccount.profileArn }
			: {}),
		refreshToken: token.refreshToken,
		accessToken: token.accessToken,
		expiresAt: token.expiresAt,
		rateLimitResetTime:
			usage && isQuotaExhausted(usage)
				? refreshedAt + config.quota_recheck_interval_ms
				: 0,
		isHealthy: true,
		failCount: 0,
		lastUsed: replaceAccount?.lastUsed ?? 0,
		usedCount: usage?.usedCount ?? replaceAccount?.usedCount ?? 0,
		limitCount: usage?.limitCount ?? replaceAccount?.limitCount ?? 0,
		overageCount: usage?.overageCount ?? replaceAccount?.overageCount ?? 0,
		lastSync: usage ? refreshedAt : (replaceAccount?.lastSync ?? 0),
	};

	const database =
		dependencies.openDb?.(ACCOUNTS_DB_PATH) ??
		new AccountsDatabase(ACCOUNTS_DB_PATH);
	const removedDuplicateIds: string[] = [];
	let persisted: StoredAccount;
	try {
		const existingAccounts = database.getAccounts();
		if (
			replaceAccount &&
			!existingAccounts.some(({ id }) => id === replaceAccount.id)
		) {
			throw new Error(
				`Account ${replaceAccount.id} was removed while re-login was in progress. No credentials were changed.`,
			);
		}
		const duplicates = replaceAccount
			? existingAccounts.filter(
					(candidate) =>
						candidate.id !== replaceAccount.id &&
						isSameLoginIdentity(candidate, replaceAccount),
				)
			: [];
		persisted = database.insertAccount(account);
		for (const duplicate of duplicates) {
			database.removeAccount(duplicate.id);
			removedDuplicateIds.push(duplicate.id);
		}
	} finally {
		database.close();
	}
	if (replaceAccount) {
		stdout(`Re-login successful: ${persisted.email} [${persisted.id}]`);
		if (removedDuplicateIds.length > 0) {
			stdout(`Removed ${removedDuplicateIds.length} duplicate account record(s).`);
		}
	} else {
		stdout(`Login successful: ${persisted.email}`);
	}
	return { account: persisted, removedDuplicateIds };
}
