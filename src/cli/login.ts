import { createHash } from "node:crypto";
import type { Config } from "../config/schema.js";
import { resolveProxyUrl } from "../core/proxy.js";
import {
	authorizeKiroIDC,
	pollKiroIDCToken,
} from "../kiro/oauth-idc.js";
import { RegionSchema } from "../kiro/regions.js";
import type { ManagedAccount } from "../kiro/types.js";
import {
	ACCOUNTS_DB_PATH,
	AccountsDatabase,
} from "../storage/accounts-db.js";

export type LoginOptions = {
	readonly startUrl?: string;
	readonly region?: string;
};

export type LoginDependencies = {
	readonly authorize?: typeof authorizeKiroIDC;
	readonly poll?: typeof pollKiroIDCToken;
	readonly openDb?: (
		path: string,
	) => Pick<AccountsDatabase, "insertAccount" | "close">;
	readonly stdout?: (message: string) => void;
};

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

export async function runLogin(
	config: Config,
	options: LoginOptions = {},
	dependencies: LoginDependencies = {},
): Promise<void> {
	const authorize = dependencies.authorize ?? authorizeKiroIDC;
	const poll = dependencies.poll ?? pollKiroIDCToken;
	const stdout = dependencies.stdout ?? console.log;
	const startUrl = normalizeStartUrl(options.startUrl);
	const region = RegionSchema.parse(options.region ?? config.default_region);
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
	const account: ManagedAccount = {
		id: accountId(token.email, token.clientId),
		email: token.email,
		authMethod: "idc",
		region,
		oidcRegion: region,
		clientId: token.clientId,
		clientSecret: token.clientSecret,
		...(startUrl ? { startUrl } : {}),
		refreshToken: token.refreshToken,
		accessToken: token.accessToken,
		expiresAt: token.expiresAt,
		rateLimitResetTime: 0,
		isHealthy: true,
		failCount: 0,
		usedCount: 0,
		limitCount: 0,
	};

	const database =
		dependencies.openDb?.(ACCOUNTS_DB_PATH) ??
		new AccountsDatabase(ACCOUNTS_DB_PATH);
	try {
		database.insertAccount(account);
	} finally {
		database.close();
	}
	stdout(`Login successful: ${account.email}`);
}
