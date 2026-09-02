import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { platformConfigRoot } from "../config/paths.js";
import { isQuotaExhausted } from "../kiro/health.js";
import type {
	KiroUsageSnapshot,
	ManagedAccount,
} from "../kiro/types.js";
import { rowToManagedAccount } from "../storage/account-record.js";

const DATABASE_BUSY_TIMEOUT_MS = 5_000;
const WRITE_LOCK_DEADLINE_MS = 30_000;
const WRITE_LOCK_MIN_BACKOFF_MS = 25;
const WRITE_LOCK_MAX_BACKOFF_MS = 500;

const REQUIRED_ACCOUNT_COLUMNS = new Set([
	"id",
	"email",
	"auth_method",
	"region",
	"oidc_region",
	"client_id",
	"client_secret",
	"profile_arn",
	"start_url",
	"refresh_token",
	"access_token",
	"expires_at",
	"rate_limit_reset",
	"is_healthy",
	"unhealthy_reason",
	"recovery_time",
	"fail_count",
	"last_used",
	"used_count",
	"limit_count",
	"last_sync",
	"overage_count",
]);

interface TableColumnRow {
	readonly name: string;
}

interface TableRow {
	readonly name: string;
}

interface OpenCodeAccountRow {
	readonly id: string;
	readonly email: string;
	readonly auth_method: ManagedAccount["authMethod"];
	readonly region: string;
	readonly oidc_region: string | null;
	readonly client_id: string | null;
	readonly client_secret: string | null;
	readonly profile_arn: string | null;
	readonly start_url: string | null;
	readonly refresh_token: string;
	readonly access_token: string;
	readonly expires_at: number;
	readonly rate_limit_reset: number | null;
	readonly is_healthy: number | null;
	readonly unhealthy_reason: string | null;
	readonly recovery_time: number | null;
	readonly fail_count: number | null;
	readonly last_used: number | null;
	readonly used_count: number | null;
	readonly limit_count: number | null;
	readonly last_sync: number | null;
	readonly overage_count: number | null;
}

export class OpenCodeAuthStoreError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "OpenCodeAuthStoreError";
	}
}

function isSqliteBusy(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return false;
	}
	return String(error.code).toUpperCase().startsWith("SQLITE_BUSY");
}

function blockingBackoff(attempt: number, remainingMs: number): void {
	const ceiling = Math.min(
		WRITE_LOCK_MIN_BACKOFF_MS * 2 ** Math.min(attempt, 5),
		WRITE_LOCK_MAX_BACKOFF_MS,
		remainingMs,
	);
	const floor = Math.max(1, Math.floor(ceiling / 2));
	const delay = floor + Math.floor(Math.random() * (ceiling - floor + 1));
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
}

/**
 * Returns undefined (after an audit warning) when a region column is invalid.
 *
 * The OpenCode schema leaves its bookkeeping columns nullable, which the local
 * schema does not: a NULL is_healthy means healthy and every other NULL counter
 * means 0. Those defaults are applied here so the column mapping itself is
 * shared with the local store.
 */
function rowToAccount(row: OpenCodeAccountRow): ManagedAccount | undefined {
	return rowToManagedAccount({
		...row,
		rate_limit_reset: row.rate_limit_reset ?? 0,
		is_healthy: row.is_healthy ?? 1,
		fail_count: row.fail_count ?? 0,
		last_used: row.last_used ?? 0,
		used_count: row.used_count ?? 0,
		limit_count: row.limit_count ?? 0,
		last_sync: row.last_sync ?? 0,
		overage_count: row.overage_count ?? 0,
	});
}

/**
 * Compare-and-swap identity for a shared row: the credential fields another
 * OpenCode writer rotates on refresh or re-login. Used by the store before
 * persisting a refresh and by the runtime to detect a concurrent rotation.
 */
export function sameTokenSnapshot(
	expected: ManagedAccount,
	current: ManagedAccount,
): boolean {
	return (
		current.refreshToken === expected.refreshToken &&
		current.accessToken === expected.accessToken &&
		current.expiresAt === expected.expiresAt &&
		current.authMethod === expected.authMethod &&
		current.clientId === expected.clientId &&
		current.clientSecret === expected.clientSecret &&
		current.profileArn === expected.profileArn &&
		current.email === expected.email &&
		current.startUrl === expected.startUrl
	);
}

export function defaultOpenCodeAuthDbPath(
	env: Record<string, string | undefined> = process.env,
): string {
	return join(platformConfigRoot({ env }), "opencode", "kiro.db");
}

export function openCodePluginDirForDatabase(databasePath: string): string {
	return join(dirname(databasePath), "kiro-auth-plugin");
}

export class OpenCodeAuthStore {
	private readonly db: Database;

	constructor(readonly path: string = defaultOpenCodeAuthDbPath()) {
		if (!existsSync(path)) {
			throw new OpenCodeAuthStoreError(
				`OpenCode Kiro auth database not found: ${path}. Run OpenCode Kiro authentication first or set auth_source to "local".`,
			);
		}
		this.db = new Database(path, { strict: true });
		this.db.run(`PRAGMA busy_timeout = ${DATABASE_BUSY_TIMEOUT_MS}`);
		this.validateSchema();
	}

	getAccounts(): ManagedAccount[] {
		return this.db
			.query<OpenCodeAccountRow, []>(`
				SELECT accounts.*
				FROM accounts
				WHERE NOT EXISTS (
					SELECT 1 FROM removed_accounts
					WHERE removed_accounts.id = accounts.id
				)
			`)
			.all()
			.flatMap((row) => {
				const account = rowToAccount(row);
				return account === undefined ? [] : [account];
			});
	}

	getById(id: string): ManagedAccount | undefined {
		const row = this.selectById(id);
		return row === undefined ? undefined : rowToAccount(row);
	}

	recordSelection(id: string, now: number): ManagedAccount | undefined {
		return this.withImmediateTransaction(() => {
			const updated = this.db
				.query(`
					UPDATE accounts
					SET last_used = ?,
						used_count = COALESCE(used_count, 0) + 1
					WHERE id = ?
						AND NOT EXISTS (
							SELECT 1 FROM removed_accounts
							WHERE removed_accounts.id = accounts.id
						)
				`)
				.run(now, id);
			if (updated.changes !== 1) return undefined;
			const row = this.selectById(id);
			return row === undefined ? undefined : rowToAccount(row);
		});
	}

	markRateLimited(id: string, resetTime: number): ManagedAccount | undefined {
		return this.withImmediateTransaction(() => {
			this.db
				.query(`
					UPDATE accounts
					SET rate_limit_reset = MAX(COALESCE(rate_limit_reset, 0), ?)
					WHERE id = ?
				`)
				.run(resetTime, id);
			const row = this.selectById(id);
			return row === undefined ? undefined : rowToAccount(row);
		});
	}

	markQuotaExhausted(
		id: string,
		recheckAfter: number,
	): ManagedAccount | undefined {
		return this.withImmediateTransaction(() => {
			this.db
				.query(`
					UPDATE accounts
					SET used_count = CASE
							WHEN COALESCE(limit_count, 0) > 0
							THEN MAX(COALESCE(used_count, 0), limit_count)
							ELSE used_count
						END,
						rate_limit_reset = MAX(COALESCE(rate_limit_reset, 0), ?)
					WHERE id = ?
				`)
				.run(recheckAfter, id);
			const row = this.selectById(id);
			return row === undefined ? undefined : rowToAccount(row);
		});
	}

	scheduleQuotaRecheck(
		id: string,
		recheckAfter: number,
	): ManagedAccount | undefined {
		return this.withImmediateTransaction(() => {
			const currentRow = this.selectById(id);
			if (currentRow === undefined) return undefined;
			const current = rowToAccount(currentRow);
			if (current === undefined) return undefined;
			if (!isQuotaExhausted(current)) return current;
			this.db
				.query(`
					UPDATE accounts
					SET rate_limit_reset = MAX(COALESCE(rate_limit_reset, 0), ?)
					WHERE id = ?
				`)
				.run(recheckAfter, id);
			const persisted = this.selectById(id);
			return persisted === undefined ? undefined : rowToAccount(persisted);
		});
	}

	updateQuotaUsage(
		id: string,
		usage: KiroUsageSnapshot & { readonly lastSync: number },
		nextRecheckAt: number,
	): ManagedAccount | undefined {
		return this.withImmediateTransaction(() => {
			const currentRow = this.selectById(id);
			if (currentRow === undefined) return undefined;
			const current = rowToAccount(currentRow);
			if (current === undefined) return undefined;
			if ((current.lastSync ?? 0) > usage.lastSync) return current;
			const wasExhausted = isQuotaExhausted(current);
			const snapshotExhausted = isQuotaExhausted(usage);
			const rateLimitResetTime = snapshotExhausted
				? Math.max(current.rateLimitResetTime, nextRecheckAt)
				: wasExhausted
					? 0
					: current.rateLimitResetTime;
			this.db
				.query(`
					UPDATE accounts
					SET email = COALESCE(?, email),
						used_count = ?,
						limit_count = ?,
						overage_count = ?,
						last_sync = ?,
						rate_limit_reset = ?
					WHERE id = ?
				`)
				.run(
					usage.email ?? null,
					usage.usedCount,
					usage.limitCount,
					usage.overageCount,
					usage.lastSync,
					rateLimitResetTime,
					id,
				);
			const persisted = this.selectById(id);
			return persisted === undefined ? undefined : rowToAccount(persisted);
		});
	}

	markUnhealthy(
		id: string,
		reason: string,
		permanent: boolean,
		recoveryTime: number | undefined,
		now: number,
	): ManagedAccount | undefined {
		return this.withImmediateTransaction(() => {
			if (permanent) {
				this.db
					.query(`
						UPDATE accounts
						SET fail_count = 10,
							is_healthy = 0,
							unhealthy_reason = ?,
							recovery_time = NULL,
							last_used = ?
						WHERE id = ?
					`)
					.run(reason, now, id);
			} else {
				this.db
					.query(`
						UPDATE accounts
						SET fail_count = COALESCE(fail_count, 0) + 1,
							is_healthy =
								CASE WHEN COALESCE(fail_count, 0) + 1 >= 10 THEN 0 ELSE 1 END,
							unhealthy_reason = ?,
							recovery_time =
								CASE
									WHEN COALESCE(fail_count, 0) + 1 >= 10 THEN ?
									ELSE NULL
								END,
							last_used = ?
						WHERE id = ?
					`)
					.run(reason, recoveryTime ?? now + 3_600_000, now, id);
			}
			const row = this.selectById(id);
			return row === undefined ? undefined : rowToAccount(row);
		});
	}

	persistRefreshedAccount(
		expected: ManagedAccount,
		candidate: ManagedAccount,
	): ManagedAccount | undefined {
		return this.withImmediateTransaction(() => {
			const currentRow = this.selectById(expected.id);
			if (currentRow === undefined) return undefined;
			const current = rowToAccount(currentRow);
			if (current === undefined) return undefined;
			if (!sameTokenSnapshot(expected, current)) return current;

			this.db
				.query(`
					UPDATE accounts
					SET email = ?,
						oidc_region = ?,
						client_id = ?,
						client_secret = ?,
						profile_arn = ?,
						start_url = ?,
						refresh_token = ?,
						access_token = ?,
						expires_at = ?,
						is_healthy = 1,
						unhealthy_reason = NULL,
						recovery_time = NULL,
						fail_count = 0,
						last_used = ?
					WHERE id = ?
				`)
				.run(
					candidate.email,
					candidate.oidcRegion ?? null,
					candidate.clientId ?? null,
					candidate.clientSecret ?? null,
					candidate.profileArn ?? null,
					candidate.startUrl ?? null,
					candidate.refreshToken,
					candidate.accessToken,
					candidate.expiresAt,
					candidate.lastUsed ?? Date.now(),
					candidate.id,
				);
			const persisted = this.selectById(candidate.id);
			return persisted === undefined ? undefined : rowToAccount(persisted);
		});
	}

	close(): void {
		this.db.close();
	}

	private selectById(id: string): OpenCodeAccountRow | undefined {
		const row = this.db
			.query<OpenCodeAccountRow, [string]>(`
				SELECT accounts.*
				FROM accounts
				WHERE accounts.id = ?
					AND NOT EXISTS (
						SELECT 1 FROM removed_accounts
						WHERE removed_accounts.id = accounts.id
					)
			`)
			.get(id);
		return row === null ? undefined : row;
	}

	private validateSchema(): void {
		const tables = new Set(
			this.db
				.query<TableRow, []>(
					"SELECT name FROM sqlite_master WHERE type = 'table'",
				)
				.all()
				.map(({ name }) => name),
		);
		for (const table of ["accounts", "removed_accounts"]) {
			if (!tables.has(table)) {
				throw new OpenCodeAuthStoreError(
					`OpenCode Kiro auth database ${this.path} is missing table ${table}; update opencode-kiro-auth and authenticate again.`,
				);
			}
		}

		const columns = new Set(
			this.db
				.query<TableColumnRow, []>("PRAGMA table_info(accounts)")
				.all()
				.map(({ name }) => name),
		);
		const missing = [...REQUIRED_ACCOUNT_COLUMNS].filter(
			(column) => !columns.has(column),
		);
		if (missing.length > 0) {
			throw new OpenCodeAuthStoreError(
				`OpenCode Kiro auth database ${this.path} is missing required account columns: ${missing.join(", ")}`,
			);
		}
	}

	private withImmediateTransaction<T>(operation: () => T): T {
		const deadline = Date.now() + WRITE_LOCK_DEADLINE_MS;
		let attempt = 0;

		for (;;) {
			let began = false;
			let beginError: unknown;
			try {
				this.db.run("PRAGMA busy_timeout = 0");
				this.db.exec("BEGIN IMMEDIATE");
				began = true;
			} catch (error) {
				beginError = error;
			} finally {
				this.db.run(`PRAGMA busy_timeout = ${DATABASE_BUSY_TIMEOUT_MS}`);
			}

			if (!began) {
				if (!isSqliteBusy(beginError)) throw beginError;
				const remainingMs = deadline - Date.now();
				if (remainingMs <= 0) {
					throw new OpenCodeAuthStoreError(
						`Timed out waiting for the OpenCode Kiro auth database write lock: ${this.path}`,
						{ cause: beginError },
					);
				}
				blockingBackoff(attempt, remainingMs);
				attempt += 1;
				continue;
			}

			try {
				const result = operation();
				this.db.exec("COMMIT");
				return result;
			} catch (error) {
				this.db.exec("ROLLBACK");
				throw error;
			}
		}
	}
}
