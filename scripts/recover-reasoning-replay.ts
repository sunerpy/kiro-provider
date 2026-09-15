/**
 * Recover one legacy kr1_ replay row from a quiescent database backup.
 *
 * Dry-run is the default and never opens the target database for writing.
 * Apply requires both --apply and --confirm <same-token-hash-prefix>; the
 * provider service must be stopped so this process can acquire its instance lock.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../src/config/loader.js";
import { loadReasoningReplayKeyring } from "../src/reasoning/keyring.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import { acquireServiceInstanceLock } from "../src/server/single-instance.js";
import {
  ACCOUNTS_DB_PATH,
  AccountsDatabase,
  type ReasoningReplayRecord,
} from "../src/storage/accounts-db.js";

type RawReplayRow = {
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
};

export interface RecoveryOptions {
  readonly sourceDb: string;
  readonly targetDb: string;
  readonly configPath?: string;
  readonly tokenHashPrefix: string;
  readonly ttlMs?: number;
  readonly apply: boolean;
  readonly confirmation?: string;
}

export interface RecoveryReport {
  readonly mode: "dry-run" | "applied";
  readonly tokenHashPrefix: string;
  readonly sourceRecordAuthenticated: true;
  readonly targetAlreadyPresent: boolean;
  readonly targetAccountPresent: boolean;
  readonly targetReplayCount: number;
  readonly targetQuickCheck: "ok" | "not-run";
  readonly renewedUntil: number;
  readonly model: string;
  readonly fingerprintHash: string;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function requiredArgument(name: string): string {
  const value = argument(name);
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

function parseOptions(): RecoveryOptions {
  const ttl = argument("--ttl-ms");
  const ttlMs = ttl === undefined ? undefined : Number(ttl);
  if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 2_147_483_647)) {
    throw new TypeError("--ttl-ms must be an integer between 1 and 2147483647");
  }
  return {
    sourceDb: resolve(requiredArgument("--source-db")),
    targetDb: resolve(argument("--target-db") ?? ACCOUNTS_DB_PATH),
    tokenHashPrefix: requiredArgument("--token-hash-prefix").toLowerCase(),
    ...(argument("--config") ? { configPath: resolve(argument("--config") as string) } : {}),
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    apply: process.argv.includes("--apply"),
    ...(argument("--confirm") ? { confirmation: argument("--confirm") } : {}),
  };
}

function recordFromRow(row: RawReplayRow): ReasoningReplayRecord {
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

function readUniqueSourceRecord(path: string, prefix: string): ReasoningReplayRecord {
  if (!/^[0-9a-f]{16,64}$/u.test(prefix)) {
    throw new TypeError("--token-hash-prefix must contain 16 to 64 lowercase hexadecimal digits");
  }
  if (!existsSync(path)) throw new TypeError("source database does not exist");
  const source = new Database(path, { readonly: true, strict: true });
  try {
    const rows = source
      .query<RawReplayRow, [string]>(
        "SELECT * FROM reasoning_replay WHERE token_hash LIKE ? ORDER BY token_hash LIMIT 2",
      )
      .all(`${prefix}%`);
    if (rows.length !== 1 || !rows[0]) {
      throw new TypeError(`source prefix matched ${rows.length} records; exactly one is required`);
    }
    return recordFromRow(rows[0]);
  } finally {
    source.close(false);
  }
}

function readonlyTargetState(
  path: string,
  record: ReasoningReplayRecord,
): { readonly present: boolean; readonly accountPresent: boolean; readonly replayCount: number } {
  if (!existsSync(path)) return { present: false, accountPresent: false, replayCount: 0 };
  const target = new Database(path, { readonly: true, strict: true });
  try {
    const present =
      target
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM reasoning_replay WHERE token_hash = ?",
        )
        .get(record.tokenHash)?.count === 1;
    const accountPresent =
      target
        .query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM accounts WHERE id = ?")
        .get(record.accountId)?.count === 1;
    const replayCount =
      target.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM reasoning_replay").get()
        ?.count ?? 0;
    return { present, accountPresent, replayCount };
  } finally {
    target.close(false);
  }
}

function fingerprintEvidence(value: string): string {
  return createHash("sha256")
    .update("kiro-provider-recovery-evidence\0")
    .update(value)
    .digest("hex");
}

export function recoverReasoningReplay(options: RecoveryOptions): RecoveryReport {
  if (options.apply && options.confirmation !== options.tokenHashPrefix) {
    throw new TypeError("--apply requires --confirm with the exact token hash prefix");
  }
  const loaded = loadConfig(options.configPath ? { configPath: options.configPath } : {});
  const config = {
    ...loaded,
    ...(options.ttlMs !== undefined ? { reasoning_replay_ttl_ms: options.ttlMs } : {}),
  };
  const sourceRecord = readUniqueSourceRecord(options.sourceDb, options.tokenHashPrefix);
  const keyring = loadReasoningReplayKeyring(config);
  const scratch = new AccountsDatabase(":memory:");
  let recovered: ReturnType<ReasoningReplayStore["recoverLegacyRecord"]>;
  try {
    recovered = new ReasoningReplayStore(scratch, config, keyring).recoverLegacyRecord(
      sourceRecord,
    );
  } finally {
    scratch.close();
  }
  const targetState = readonlyTargetState(options.targetDb, sourceRecord);
  const base = {
    tokenHashPrefix: sourceRecord.tokenHash.slice(0, 16),
    sourceRecordAuthenticated: true as const,
    targetAlreadyPresent: targetState.present,
    targetAccountPresent: targetState.accountPresent,
    targetReplayCount: targetState.replayCount,
    renewedUntil: recovered.record.expiresAt,
    model: sourceRecord.model,
    fingerprintHash: fingerprintEvidence(recovered.outputFingerprint),
  };
  if (!options.apply) {
    return { mode: "dry-run", targetQuickCheck: "not-run", ...base };
  }
  if (targetState.present) throw new TypeError("target database already contains this replay row");
  if (!targetState.accountPresent)
    throw new TypeError("target database does not contain the owner account");
  if (targetState.replayCount >= config.reasoning_replay_max_entries) {
    throw new TypeError(
      "target reasoning replay table is at its configured limit; raise reasoning_replay_max_entries before recovery",
    );
  }
  const lease = acquireServiceInstanceLock(config, { retryAttempts: 0 });
  const target = new AccountsDatabase(options.targetDb);
  try {
    target.insertReasoningReplay(
      recovered.record,
      Math.max(config.reasoning_replay_max_entries, 1),
      Date.now(),
    );
  } finally {
    target.close();
    lease?.release();
  }
  const verify = new Database(options.targetDb, { readonly: true, strict: true });
  let quickCheck = "";
  try {
    quickCheck = String(
      verify.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check,
    );
  } finally {
    verify.close(false);
  }
  if (quickCheck !== "ok") throw new TypeError("target database quick_check failed after recovery");
  return { mode: "applied", targetQuickCheck: "ok", ...base };
}

if (import.meta.main) {
  const report = recoverReasoningReplay(parseOptions());
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
