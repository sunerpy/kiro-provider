import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ManagedAccount } from "../kiro/types.js";
import {
	type AccountRow,
	accountToRow,
	rowBindings,
	rowToAccount,
	type StoredAccount,
} from "./account-record.js";

export type { StoredAccount } from "./account-record.js";

interface GenerationRow {
	generation: number;
}

interface TombstoneRow {
	last_generation: number;
}

interface TableColumnRow {
	name: string;
}

function defaultDatabasePath(): string {
	const configRoot =
		process.platform === "win32"
			? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
			: (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
	return join(configRoot, "kiro-provider", "accounts.db");
}

export const ACCOUNTS_DB_PATH = defaultDatabasePath();

export class AccountsDatabase {
	private readonly db: Database;
	private readonly path: string;

	constructor(path: string = ACCOUNTS_DB_PATH) {
		this.path = path;
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.db = new Database(path, { create: true, strict: true });
		this.tightenPermissions();
		this.db.run("PRAGMA busy_timeout = 5000");
		this.db.run("PRAGMA journal_mode = WAL");
		this.withImmediateTransaction(() => {
			this.db.run(`
        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY, email TEXT NOT NULL, auth_method TEXT NOT NULL,
          region TEXT NOT NULL, oidc_region TEXT, client_id TEXT, client_secret TEXT,
          profile_arn TEXT, start_url TEXT, refresh_token TEXT NOT NULL,
          access_token TEXT NOT NULL, expires_at INTEGER NOT NULL,
          rate_limit_reset INTEGER DEFAULT 0, is_healthy INTEGER DEFAULT 1,
          unhealthy_reason TEXT, recovery_time INTEGER, fail_count INTEGER DEFAULT 0,
          last_used INTEGER DEFAULT 0, used_count INTEGER DEFAULT 0,
          limit_count INTEGER DEFAULT 0, last_sync INTEGER DEFAULT 0,
          overage_count INTEGER DEFAULT 0, generation INTEGER NOT NULL DEFAULT 1
        )
      `);
			const hasGeneration = this.db
				.query<TableColumnRow, []>("PRAGMA table_info(accounts)")
				.all()
				.some(({ name }) => name === "generation");
			if (!hasGeneration) {
				this.db.run(
					"ALTER TABLE accounts ADD COLUMN generation INTEGER NOT NULL DEFAULT 1",
				);
			}
			this.db.run(`
        CREATE TABLE IF NOT EXISTS removed_accounts (
          id TEXT PRIMARY KEY,
          removed_at INTEGER NOT NULL,
          last_generation INTEGER NOT NULL
        )
      `);
		});
	}

	getAccounts(): StoredAccount[] {
		return this.db
			.query<AccountRow, []>(`
        SELECT accounts.* FROM accounts
        WHERE NOT EXISTS (
          SELECT 1 FROM removed_accounts WHERE removed_accounts.id = accounts.id
        )
      `)
			.all()
			.map(rowToAccount);
	}

	getById(id: string): StoredAccount | undefined {
		const row = this.db
			.query<AccountRow, [string]>(`
        SELECT accounts.* FROM accounts
        WHERE accounts.id = ? AND NOT EXISTS (
          SELECT 1 FROM removed_accounts WHERE removed_accounts.id = accounts.id
        )
      `)
			.get(id);
		return row === null ? undefined : rowToAccount(row);
	}

	insertAccount(account: ManagedAccount): StoredAccount {
		return this.withImmediateTransaction(() => {
			const existing = this.db
				.query<GenerationRow, [string]>(
					"SELECT generation FROM accounts WHERE id = ?",
				)
				.get(account.id);
			const tombstone = this.db
				.query<TombstoneRow, [string]>(
					"SELECT last_generation FROM removed_accounts WHERE id = ?",
				)
				.get(account.id);
			const generation =
				Math.max(existing?.generation ?? 0, tombstone?.last_generation ?? 0) +
				1;
			const row = accountToRow(account, generation);
			this.db
				.query(`
          INSERT OR REPLACE INTO accounts (
            id, email, auth_method, region, oidc_region, client_id, client_secret,
            profile_arn, start_url, refresh_token, access_token, expires_at,
            rate_limit_reset, is_healthy, unhealthy_reason, recovery_time, fail_count,
            last_used, used_count, limit_count, last_sync, overage_count, generation
          ) VALUES (${Array.from({ length: 23 }, () => "?").join(", ")})
        `)
				.run(...rowBindings(row));
			this.clearRemovedAccountInternal(account.id);
			return rowToAccount(row);
		});
	}

	updateExistingAccounts(accounts: readonly StoredAccount[]): number {
		return this.withImmediateTransaction(() => {
			let changes = 0;
			const update = this.db.query(`
        UPDATE accounts SET
          email = ?, auth_method = ?, region = ?, oidc_region = ?, client_id = ?,
          client_secret = ?, profile_arn = ?, start_url = ?, refresh_token = ?,
          access_token = ?, expires_at = ?, rate_limit_reset = ?, is_healthy = ?,
          unhealthy_reason = ?, recovery_time = ?, fail_count = ?, last_used = ?,
          used_count = ?, limit_count = ?, last_sync = ?, overage_count = ?,
          generation = generation + 1
        WHERE id = ? AND generation = ? AND NOT EXISTS (
          SELECT 1 FROM removed_accounts WHERE removed_accounts.id = accounts.id
        )
      `);
			for (const account of accounts) {
				const bindings = rowBindings(accountToRow(account, account.generation));
				const id = bindings.shift();
				bindings.pop();
				changes += update.run(
					...bindings,
					id ?? account.id,
					account.generation,
				).changes;
			}
			return changes;
		});
	}

	removeAccount(id: string): void {
		this.withImmediateTransaction(() => {
			const existing = this.db
				.query<GenerationRow, [string]>(
					"SELECT generation FROM accounts WHERE id = ?",
				)
				.get(id);
			const tombstone = this.db
				.query<TombstoneRow, [string]>(
					"SELECT last_generation FROM removed_accounts WHERE id = ?",
				)
				.get(id);
			const lastGeneration =
				existing?.generation ?? tombstone?.last_generation ?? 0;
			this.db.query("DELETE FROM accounts WHERE id = ?").run(id);
			this.db
				.query(`
          INSERT OR REPLACE INTO removed_accounts (id, removed_at, last_generation)
          VALUES (?, ?, ?)
        `)
				.run(id, Date.now(), lastGeneration);
		});
	}

	clearRemovedAccount(id: string): void {
		this.withImmediateTransaction(() => this.clearRemovedAccountInternal(id));
	}

	close(): void {
		this.db.close();
	}

	private clearRemovedAccountInternal(id: string): void {
		this.db.query("DELETE FROM removed_accounts WHERE id = ?").run(id);
	}

	private withImmediateTransaction<T>(operation: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		} finally {
			this.tightenPermissions();
		}
	}

	private tightenPermissions(): void {
		if (this.path === ":memory:") return;
		for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
			if (existsSync(path)) chmodSync(path, 0o600);
		}
	}
}

export function createAccountsDatabase(path?: string): AccountsDatabase {
	return path === undefined
		? new AccountsDatabase()
		: new AccountsDatabase(path);
}
