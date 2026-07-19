import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { RegionSchema } from "../kiro/regions.js";
import type { ManagedAccount } from "../kiro/types.js";
import type { AccountsDatabase } from "../storage/accounts-db.js";

const SourceAccountSchema = z.object({
	id: z.string().min(1),
	email: z.string().min(1),
	auth_method: z.string(),
	region: z.string(),
	oidc_region: z.string().nullable(),
	client_id: z.string().nullable(),
	client_secret: z.string().nullable(),
	profile_arn: z.string().nullable(),
	start_url: z.string().nullable(),
	refresh_token: z.string(),
	access_token: z.string(),
	expires_at: z.number(),
	rate_limit_reset: z.number().nullable(),
	is_healthy: z.number().nullable(),
	unhealthy_reason: z.string().nullable(),
	recovery_time: z.number().nullable(),
	fail_count: z.number().nullable(),
	last_used: z.number().nullable(),
	used_count: z.number().nullable(),
	limit_count: z.number().nullable(),
	last_sync: z.number().nullable(),
	overage_count: z.number().nullable(),
});

type SourceAccount = z.infer<typeof SourceAccountSchema>;

export type ImportAccountsOptions = {
	readonly from?: string;
};

export type ImportAccountsDependencies = {
	readonly database: Pick<AccountsDatabase, "insertAccount" | "getAccounts">;
	readonly stdout: (message: string) => void;
};

export type ImportAccountsResult = {
	readonly imported: number;
	readonly skipped: number;
	readonly total: number;
};

type AccountCandidate =
	| { readonly kind: "usable"; readonly account: ManagedAccount }
	| { readonly kind: "skipped"; readonly reason: string };

export function defaultOpenCodeDatabasePath(
	env: Readonly<Record<string, string | undefined>> = process.env,
): string {
	const configHome = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
	return join(configHome, "opencode", "kiro.db");
}

function optionalText(value: string | null): string | undefined {
	return value === null || value === "" ? undefined : value;
}

function toCandidate(row: SourceAccount): AccountCandidate {
	if (!row.refresh_token) return { kind: "skipped", reason: "missing refresh token" };
	if (!row.access_token) return { kind: "skipped", reason: "missing access token" };
	const region = RegionSchema.safeParse(row.region);
	if (!region.success) return { kind: "skipped", reason: "missing or unsupported region" };
	if (row.auth_method !== "idc" && row.auth_method !== "desktop") {
		return { kind: "skipped", reason: "unsupported auth method" };
	}
	if (row.auth_method === "idc" && (!row.client_id || !row.client_secret)) {
		return { kind: "skipped", reason: "IDC client credentials missing" };
	}
	const oidcRegion = optionalText(row.oidc_region);
	const parsedOidcRegion = oidcRegion === undefined ? undefined : RegionSchema.safeParse(oidcRegion);
	if (parsedOidcRegion !== undefined && !parsedOidcRegion.success) {
		return { kind: "skipped", reason: "unsupported OIDC region" };
	}

	return {
		kind: "usable",
		account: {
			id: row.id,
			email: row.email,
			authMethod: row.auth_method,
			region: region.data,
			...(parsedOidcRegion?.success ? { oidcRegion: parsedOidcRegion.data } : {}),
			...(optionalText(row.client_id) ? { clientId: optionalText(row.client_id) } : {}),
			...(optionalText(row.client_secret)
				? { clientSecret: optionalText(row.client_secret) }
				: {}),
			...(optionalText(row.profile_arn) ? { profileArn: optionalText(row.profile_arn) } : {}),
			...(optionalText(row.start_url) ? { startUrl: optionalText(row.start_url) } : {}),
			refreshToken: row.refresh_token,
			accessToken: row.access_token,
			expiresAt: row.expires_at,
			rateLimitResetTime: row.rate_limit_reset ?? 0,
			isHealthy: row.is_healthy !== 0,
			...(optionalText(row.unhealthy_reason)
				? { unhealthyReason: optionalText(row.unhealthy_reason) }
				: {}),
			...(row.recovery_time === null ? {} : { recoveryTime: row.recovery_time }),
			failCount: row.fail_count ?? 0,
			lastUsed: row.last_used ?? 0,
			usedCount: row.used_count ?? 0,
			limitCount: row.limit_count ?? 0,
			lastSync: row.last_sync ?? 0,
			overageCount: row.overage_count ?? 0,
		},
	};
}

export function runImportAccounts(
	options: ImportAccountsOptions,
	dependencies: ImportAccountsDependencies,
): ImportAccountsResult {
	const sourcePath = options.from ?? defaultOpenCodeDatabasePath();
	const source = new Database(sourcePath, { readonly: true, strict: true });
	let imported = 0;
	let skipped = 0;
	try {
		const rows = source
			.query<Record<string, unknown>, []>(`SELECT
          id, email, auth_method, region, oidc_region, client_id, client_secret,
          profile_arn, start_url, refresh_token, access_token, expires_at,
          rate_limit_reset, is_healthy, unhealthy_reason, recovery_time, fail_count,
          last_used, used_count, limit_count, last_sync, overage_count
        FROM accounts`)
			.all();
		for (const rawRow of rows) {
			const parsed = SourceAccountSchema.safeParse(rawRow);
			if (!parsed.success) {
				skipped += 1;
				dependencies.stdout("Skipped malformed source account row");
				continue;
			}
			const candidate = toCandidate(parsed.data);
			if (candidate.kind === "skipped") {
				skipped += 1;
				dependencies.stdout(`Skipped ${parsed.data.email}: ${candidate.reason}`);
				continue;
			}
			dependencies.database.insertAccount(candidate.account);
			imported += 1;
			dependencies.stdout(
				`Imported ${candidate.account.email}\t${candidate.account.authMethod}\t${candidate.account.region}`,
			);
		}
	} finally {
		source.close();
	}
	const total = dependencies.database.getAccounts().length;
	dependencies.stdout(`Imported ${imported}, skipped ${skipped}, total in DB now ${total}`);
	return { imported, skipped, total };
}
