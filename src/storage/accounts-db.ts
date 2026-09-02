import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { auditLog } from "../core/audit-log.js";
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

interface UserVersionRow {
	user_version: number;
}

interface SessionAffinityRow {
	key_hash: string;
	account_id: string;
	conversation_id: string;
	created_at: number;
	last_seen: number;
	expires_at: number;
}

interface OutputLineageRow {
	key_hash: string;
	account_id: string;
	conversation_id: string;
	created_at: number;
	last_seen: number;
	expires_at: number;
}

interface CountRow {
	count: number;
}

interface KeyIdRow {
	key_id: string;
}

export interface ReasoningReplayRecord {
	readonly tokenHash: string;
	readonly chatLookupHash: string | null;
	readonly fingerprintHash: string;
	readonly tenantId: string;
	readonly accountId: string;
	readonly conversationId: string;
	readonly model: string;
	readonly keyId: string;
	readonly nonce: Uint8Array;
	readonly ciphertext: Uint8Array;
	readonly authTag: Uint8Array;
	readonly createdAt: number;
	readonly lastSeen: number;
	readonly expiresAt: number;
}

interface ReasoningReplayRow {
	token_hash: string;
	chat_lookup_hash: string | null;
	fingerprint_hash: string;
	tenant_id: string;
	account_id: string;
	conversation_id: string;
	model: string;
	key_id: string;
	nonce: Uint8Array;
	ciphertext: Uint8Array;
	auth_tag: Uint8Array;
	created_at: number;
	last_seen: number;
	expires_at: number;
}

export interface SessionAffinityBinding {
	readonly keyHash: string;
	readonly accountId: string;
	readonly conversationId: string;
	readonly createdAt: number;
	readonly lastSeen: number;
	readonly expiresAt: number;
}

function rowToSessionAffinity(row: SessionAffinityRow): SessionAffinityBinding {
	return {
		keyHash: row.key_hash,
		accountId: row.account_id,
		conversationId: row.conversation_id,
		createdAt: row.created_at,
		lastSeen: row.last_seen,
		expiresAt: row.expires_at,
	};
}

function rowToOutputLineage(row: OutputLineageRow): SessionAffinityBinding {
	return {
		keyHash: row.key_hash,
		accountId: row.account_id,
		conversationId: row.conversation_id,
		createdAt: row.created_at,
		lastSeen: row.last_seen,
		expiresAt: row.expires_at,
	};
}

function rowToReasoningReplay(row: ReasoningReplayRow): ReasoningReplayRecord {
	return {
		tokenHash: row.token_hash,
		chatLookupHash: row.chat_lookup_hash,
		fingerprintHash: row.fingerprint_hash,
		tenantId: row.tenant_id,
		accountId: row.account_id,
		conversationId: row.conversation_id,
		model: row.model,
		keyId: row.key_id,
		nonce: row.nonce,
		ciphertext: row.ciphertext,
		authTag: row.auth_tag,
		createdAt: row.created_at,
		lastSeen: row.last_seen,
		expiresAt: row.expires_at,
	};
}

function defaultDatabasePath(): string {
	const configRoot =
		process.platform === "win32"
			? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
			: (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
	return join(configRoot, "kiro-provider", "accounts.db");
}

export const ACCOUNTS_DB_PATH = defaultDatabasePath();

function hasColumn(db: Database, table: string, column: string): boolean {
	return db
		.query<TableColumnRow, []>(`PRAGMA table_info(${table})`)
		.all()
		.some(({ name }) => name === column);
}

type Migration = (db: Database) => void;

/**
 * Ordered, idempotent schema migrations. `PRAGMA user_version` records how many
 * have been applied. Databases created before versioning report 0 and are
 * brought forward by the same steps: every step uses IF NOT EXISTS or a column
 * probe, so re-applying it to an already-shaped legacy schema is a no-op, after
 * which the version is stamped. Append new steps; never reorder or edit old ones.
 */
const MIGRATIONS: readonly Migration[] = [
	// v1: accounts with generation-based CAS, plus removal tombstones.
	(db) => {
		db.run(`
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
		db.run(`
      CREATE TABLE IF NOT EXISTS removed_accounts (
        id TEXT PRIMARY KEY,
        removed_at INTEGER NOT NULL,
        last_generation INTEGER NOT NULL
      )
    `);
	},
	// v2: generation column for databases created before CAS updates existed.
	(db) => {
		if (!hasColumn(db, "accounts", "generation")) {
			db.run(
				"ALTER TABLE accounts ADD COLUMN generation INTEGER NOT NULL DEFAULT 1",
			);
		}
	},
	// v3: tenant-isolated session affinity.
	(db) => {
		db.run(`
      CREATE TABLE IF NOT EXISTS session_affinity (
        key_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
		db.run(`
      CREATE INDEX IF NOT EXISTS session_affinity_expires_at_idx
      ON session_affinity (expires_at)
    `);
		db.run(`
      CREATE INDEX IF NOT EXISTS session_affinity_last_seen_idx
      ON session_affinity (last_seen)
    `);
	},
	// v4: output lineage for implicit conversation continuation.
	(db) => {
		db.run(`
      CREATE TABLE IF NOT EXISTS output_lineage (
        key_hash TEXT NOT NULL,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (key_hash, account_id, conversation_id)
      )
    `);
		db.run(`
      CREATE INDEX IF NOT EXISTS output_lineage_lookup_idx
      ON output_lineage (key_hash, expires_at)
    `);
		db.run(`
      CREATE INDEX IF NOT EXISTS output_lineage_lru_idx
      ON output_lineage (last_seen, key_hash)
    `);
	},
	// v5: encrypted reasoning replay records.
	(db) => {
		db.run(`
      CREATE TABLE IF NOT EXISTS reasoning_replay (
        token_hash TEXT PRIMARY KEY,
        chat_lookup_hash TEXT,
        fingerprint_hash TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        model TEXT NOT NULL,
        key_id TEXT NOT NULL,
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
		db.run(`
      CREATE INDEX IF NOT EXISTS reasoning_replay_lookup_idx
      ON reasoning_replay (tenant_id, model, chat_lookup_hash, expires_at)
    `);
		db.run(`
      CREATE INDEX IF NOT EXISTS reasoning_replay_lru_idx
      ON reasoning_replay (last_seen, token_hash)
    `);
		db.run(`
      CREATE INDEX IF NOT EXISTS reasoning_replay_key_id_idx
      ON reasoning_replay (key_id, expires_at)
    `);
	},
];

export const ACCOUNTS_DB_SCHEMA_VERSION = MIGRATIONS.length;

function errnoCode(error: unknown): string | undefined {
	return typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
		? error.code
		: undefined;
}

export class AccountsDatabase {
	private readonly db: Database;
	private readonly path: string;

	constructor(path: string = ACCOUNTS_DB_PATH) {
		this.path = path;
		if (path !== ":memory:") {
			mkdirSync(dirname(path), { recursive: true });
			// Create the file 0600 before SQLite opens it: SQLite derives the mode of
			// the -wal and -shm sidecars from the main database file.
			closeSync(openSync(path, "a", 0o600));
		}
		this.db = new Database(path, { create: true, strict: true });
		this.tightenPermissions();
		this.db.run("PRAGMA busy_timeout = 5000");
		this.db.run("PRAGMA journal_mode = WAL");
		this.withImmediateTransaction(() => this.migrate());
		// Sidecars created by the first write above inherit the main file's mode; this
		// second pass only matters for pre-existing sidecars left by older versions.
		this.tightenPermissions();
	}

	schemaVersion(): number {
		return (
			this.db.query<UserVersionRow, []>("PRAGMA user_version").get()
				?.user_version ?? 0
		);
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
			.flatMap((row) => {
				const account = rowToAccount(row);
				return account === undefined ? [] : [account];
			});
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
			const stored = rowToAccount(row);
			if (stored === undefined) {
				throw new TypeError(`Account ${account.id} has an invalid region and was not stored`);
			}
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
			return stored;
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
					.query("DELETE FROM session_affinity WHERE account_id = ?")
					.run(id);
				this.db
					.query("DELETE FROM output_lineage WHERE account_id = ?")
					.run(id);
				this.db
				.query("DELETE FROM reasoning_replay WHERE account_id = ?")
				.run(id);
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

	getSessionAffinity(
		keyHash: string,
		now: number = Date.now(),
	): SessionAffinityBinding | undefined {
		const row = this.db
			.query<SessionAffinityRow, [string, number]>(`
	      SELECT * FROM session_affinity
	      WHERE key_hash = ? AND expires_at > ?
	    `)
			.get(keyHash, now);
		return row === null ? undefined : rowToSessionAffinity(row);
	}

	claimSessionAffinity(
		keyHash: string,
		accountId: string,
		conversationId: string,
		now: number,
		ttlMs: number,
		maxEntries: number,
	): SessionAffinityBinding {
		return this.withImmediateTransaction(() => {
			this.db
				.query("DELETE FROM session_affinity WHERE key_hash = ? AND expires_at <= ?")
				.run(keyHash, now);
			this.db
				.query(`
	        INSERT OR IGNORE INTO session_affinity (
	          key_hash, account_id, conversation_id, created_at, last_seen, expires_at
	        ) VALUES (?, ?, ?, ?, ?, ?)
	      `)
				.run(keyHash, accountId, conversationId, now, now, now + ttlMs);
			this.db
				.query(`
	        UPDATE session_affinity
	        SET last_seen = ?, expires_at = ?
	        WHERE key_hash = ?
	      `)
				.run(now, now + ttlMs, keyHash);
			this.pruneSessionAffinitiesInternal(now, maxEntries, keyHash);
			const row = this.selectSessionAffinity(keyHash);
			if (row === undefined) {
				throw new TypeError("Session affinity claim did not persist");
			}
			return rowToSessionAffinity(row);
		});
	}

	rebindSessionAffinity(
		keyHash: string,
		accountId: string,
		conversationId: string,
		now: number,
		ttlMs: number,
		maxEntries: number,
	): SessionAffinityBinding {
		return this.withImmediateTransaction(() => {
			this.db
				.query(`
	        INSERT INTO session_affinity (
	          key_hash, account_id, conversation_id, created_at, last_seen, expires_at
	        ) VALUES (?, ?, ?, ?, ?, ?)
	        ON CONFLICT(key_hash) DO UPDATE SET
	          account_id = excluded.account_id,
	          conversation_id = excluded.conversation_id,
	          created_at = excluded.created_at,
	          last_seen = excluded.last_seen,
	          expires_at = excluded.expires_at
	      `)
				.run(keyHash, accountId, conversationId, now, now, now + ttlMs);
			this.pruneSessionAffinitiesInternal(now, maxEntries, keyHash);
			const row = this.selectSessionAffinity(keyHash);
			if (row === undefined) {
				throw new TypeError("Session affinity rebind did not persist");
			}
			return rowToSessionAffinity(row);
		});
	}

	pruneSessionAffinities(
		now: number = Date.now(),
		maxEntries = 10_000,
	): number {
		return this.withImmediateTransaction(() =>
			this.pruneSessionAffinitiesInternal(now, maxEntries),
		);
	}

	resolveOutputLineage(
		keyHash: string,
		now: number = Date.now(),
	): SessionAffinityBinding | undefined {
		const rows = this.db
			.query<OutputLineageRow, [string, number]>(`
	      SELECT * FROM output_lineage
	      WHERE key_hash = ? AND expires_at > ?
	      ORDER BY last_seen DESC, account_id ASC, conversation_id ASC
	      LIMIT 2
	    `)
			.all(keyHash, now);
		return rows.length === 1 ? rowToOutputLineage(rows[0] as OutputLineageRow) : undefined;
	}

	recordOutputLineage(
		keyHash: string,
		accountId: string,
		conversationId: string,
		now: number,
		ttlMs: number,
		maxEntries: number,
	): void {
		this.withImmediateTransaction(() => {
			this.db.query("DELETE FROM output_lineage WHERE expires_at <= ?").run(now);
			this.db
				.query(`
	        INSERT INTO output_lineage (
	          key_hash, account_id, conversation_id, created_at, last_seen, expires_at
	        ) VALUES (?, ?, ?, ?, ?, ?)
	        ON CONFLICT(key_hash, account_id, conversation_id) DO UPDATE SET
	          last_seen = excluded.last_seen,
	          expires_at = excluded.expires_at
	      `)
				.run(keyHash, accountId, conversationId, now, now, now + ttlMs);
			this.pruneOutputLineageInternal(
				now,
				maxEntries,
				keyHash,
				accountId,
				conversationId,
			);
		});
	}

	pruneOutputLineage(
		now: number = Date.now(),
		maxEntries = 10_000,
	): number {
		return this.withImmediateTransaction(() =>
			this.pruneOutputLineageInternal(now, maxEntries),
		);
	}

	insertReasoningReplay(
		record: ReasoningReplayRecord,
		maxEntries: number,
		now: number = Date.now(),
	): void {
		this.withImmediateTransaction(() => {
			this.db.query("DELETE FROM reasoning_replay WHERE expires_at <= ?").run(now);
			this.db
				.query(`
	        INSERT INTO reasoning_replay (
	          token_hash, chat_lookup_hash, fingerprint_hash, tenant_id, account_id,
	          conversation_id, model, key_id, nonce, ciphertext, auth_tag,
	          created_at, last_seen, expires_at
	        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	      `)
				.run(
					record.tokenHash,
					record.chatLookupHash,
					record.fingerprintHash,
					record.tenantId,
					record.accountId,
					record.conversationId,
					record.model,
					record.keyId,
					record.nonce,
					record.ciphertext,
					record.authTag,
					record.createdAt,
					record.lastSeen,
					record.expiresAt,
				);
			this.pruneReasoningReplayInternal(now, maxEntries, record.tokenHash);
		});
	}

	getReasoningReplayRecord(tokenHash: string): ReasoningReplayRecord | undefined {
		const row = this.db
			.query<ReasoningReplayRow, [string]>(
				"SELECT * FROM reasoning_replay WHERE token_hash = ?",
			)
			.get(tokenHash);
		return row === null ? undefined : rowToReasoningReplay(row);
	}

	findReasoningReplayByChatHash(
		tenantId: string,
		model: string,
		chatLookupHash: string,
		now: number = Date.now(),
	): ReasoningReplayRecord[] {
		return this.db
			.query<ReasoningReplayRow, [string, string, string, number]>(`
	      SELECT * FROM reasoning_replay
	      WHERE tenant_id = ? AND model = ? AND chat_lookup_hash = ? AND expires_at > ?
	      ORDER BY last_seen DESC, token_hash ASC
	    `)
			.all(tenantId, model, chatLookupHash, now)
			.map(rowToReasoningReplay);
	}

	touchReasoningReplay(tokenHash: string, now: number = Date.now()): void {
		this.db
			.query("UPDATE reasoning_replay SET last_seen = ? WHERE token_hash = ?")
			.run(now, tokenHash);
	}

	activeReasoningReplayKeyIds(now: number = Date.now()): string[] {
		return this.db
			.query<KeyIdRow, [number]>(`
	      SELECT DISTINCT key_id FROM reasoning_replay
	      WHERE expires_at > ? ORDER BY key_id ASC
	    `)
			.all(now)
			.map((row) => row.key_id);
	}

	pruneReasoningReplay(now: number = Date.now(), maxEntries = 10_000): number {
		return this.withImmediateTransaction(() =>
			this.pruneReasoningReplayInternal(now, maxEntries),
		);
	}

	checkWritable(): boolean {
		try {
			this.withImmediateTransaction(() => {
				this.db.run("UPDATE reasoning_replay SET last_seen = last_seen WHERE 0");
			});
			return true;
		} catch {
			return false;
		}
	}

	close(): void {
		this.db.close();
	}

	private clearRemovedAccountInternal(id: string): void {
		this.db.query("DELETE FROM removed_accounts WHERE id = ?").run(id);
	}

	private selectSessionAffinity(keyHash: string): SessionAffinityRow | undefined {
		const row = this.db
			.query<SessionAffinityRow, [string]>(
				"SELECT * FROM session_affinity WHERE key_hash = ?",
			)
			.get(keyHash);
		return row === null ? undefined : row;
	}

	private pruneSessionAffinitiesInternal(
		now: number,
		maxEntries: number,
		preserveKey?: string,
	): number {
		let changes = this.db
			.query("DELETE FROM session_affinity WHERE expires_at <= ?")
			.run(now).changes;
		const row = this.db
			.query<CountRow, []>("SELECT COUNT(*) AS count FROM session_affinity")
			.get();
		const overflow = Math.max(0, (row?.count ?? 0) - maxEntries);
		if (overflow > 0) {
			const prune = preserveKey
				? this.db.query(`
	        DELETE FROM session_affinity
	        WHERE key_hash IN (
	          SELECT key_hash FROM session_affinity
	          WHERE key_hash != ?
	          ORDER BY last_seen ASC, key_hash ASC
	          LIMIT ?
	        )
	      `)
				: this.db.query(`
	        DELETE FROM session_affinity
	        WHERE key_hash IN (
	          SELECT key_hash FROM session_affinity
	          ORDER BY last_seen ASC, key_hash ASC
	          LIMIT ?
	        )
	      `);
			changes += (
				preserveKey ? prune.run(preserveKey, overflow) : prune.run(overflow)
			).changes;
		}
		return changes;
	}

	private pruneReasoningReplayInternal(
		now: number,
		maxEntries: number,
		preserveTokenHash?: string,
	): number {
		let changes = this.db
			.query("DELETE FROM reasoning_replay WHERE expires_at <= ?")
			.run(now).changes;
		const row = this.db
			.query<CountRow, []>("SELECT COUNT(*) AS count FROM reasoning_replay")
			.get();
		const overflow = Math.max(0, (row?.count ?? 0) - maxEntries);
		if (overflow <= 0) return changes;
		const prune = preserveTokenHash
			? this.db.query(`
	      DELETE FROM reasoning_replay
	      WHERE token_hash IN (
	        SELECT token_hash FROM reasoning_replay
	        WHERE token_hash != ?
	        ORDER BY last_seen ASC, token_hash ASC
	        LIMIT ?
	      )
	    `)
			: this.db.query(`
	      DELETE FROM reasoning_replay
	      WHERE token_hash IN (
	        SELECT token_hash FROM reasoning_replay
	        ORDER BY last_seen ASC, token_hash ASC
	        LIMIT ?
	      )
	    `);
		changes += (
			preserveTokenHash
				? prune.run(preserveTokenHash, overflow)
				: prune.run(overflow)
		).changes;
		return changes;
	}

	private pruneOutputLineageInternal(
		now: number,
		maxEntries: number,
		preserveKey?: string,
		preserveAccountId?: string,
		preserveConversationId?: string,
	): number {
		let changes = this.db
			.query("DELETE FROM output_lineage WHERE expires_at <= ?")
			.run(now).changes;
		const row = this.db
			.query<CountRow, []>("SELECT COUNT(*) AS count FROM output_lineage")
			.get();
		const overflow = Math.max(0, (row?.count ?? 0) - maxEntries);
		if (overflow <= 0) return changes;
		const preserve =
			preserveKey !== undefined &&
			preserveAccountId !== undefined &&
			preserveConversationId !== undefined;
		const prune = preserve
			? this.db.query(`
	      DELETE FROM output_lineage
	      WHERE rowid IN (
	        SELECT rowid FROM output_lineage
	        WHERE NOT (
	          key_hash = ? AND account_id = ? AND conversation_id = ?
	        )
	        ORDER BY last_seen ASC, key_hash ASC, account_id ASC, conversation_id ASC
	        LIMIT ?
	      )
	    `)
			: this.db.query(`
	      DELETE FROM output_lineage
	      WHERE rowid IN (
	        SELECT rowid FROM output_lineage
	        ORDER BY last_seen ASC, key_hash ASC, account_id ASC, conversation_id ASC
	        LIMIT ?
	      )
	    `);
		changes += (
			preserve
				? prune.run(
						preserveKey,
						preserveAccountId,
						preserveConversationId,
						overflow,
					)
				: prune.run(overflow)
		).changes;
		return changes;
	}

	private migrate(): void {
		const current = this.schemaVersion();
		if (current >= ACCOUNTS_DB_SCHEMA_VERSION) return;
		for (const migration of MIGRATIONS.slice(current)) migration(this.db);
		this.db.run(`PRAGMA user_version = ${ACCOUNTS_DB_SCHEMA_VERSION}`);
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
		}
	}

	/**
	 * Runs once at open. A chmod failure (foreign ownership, read-only mount,
	 * non-POSIX filesystem) is reported rather than thrown: the database is
	 * already usable and the mode is best effort at this point.
	 */
	private tightenPermissions(): void {
		if (this.path === ":memory:") return;
		for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
			if (!existsSync(path)) continue;
			try {
				chmodSync(path, 0o600);
			} catch (error) {
				auditLog("warn", "accounts_db_chmod_failed", {
					path,
					code: errnoCode(error),
				});
			}
		}
	}
}

export function createAccountsDatabase(path?: string): AccountsDatabase {
	return path === undefined
		? new AccountsDatabase()
		: new AccountsDatabase(path);
}
