import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import {
  loadReasoningReplayKeyring,
  type ReasoningReplayKeyring,
} from "../src/reasoning/keyring.js";
import {
  ReasoningReplayError,
  ReasoningReplayStore,
} from "../src/reasoning/replay-store.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

const directories = new Set<string>();
const databases = new Set<AccountsDatabase>();

afterEach(() => {
  for (const database of databases) {
    try {
      database.close();
    } catch {
      // A test may close a database before reopening it to prove restart behavior.
    }
  }
  databases.clear();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

function key(byte: number): string {
  return Buffer.alloc(32, byte).toString("base64url");
}

function config(
  keyEntries: readonly string[] = [`key-one:${key(1)}`],
  overrides: Partial<Config> = {},
): Config {
  return ConfigSchema.parse({
    api_keys: ["test-key"],
    reasoning_replay_keys: keyEntries,
    reasoning_replay_ttl_ms: 60_000,
    reasoning_replay_max_entries: 100,
    ...overrides,
  });
}

function fixture(inputConfig: Config = config()): {
  readonly directory: string;
  readonly path: string;
  readonly database: AccountsDatabase;
  readonly store: ReasoningReplayStore;
  readonly config: Config;
} {
  const directory = mkdtempSync(join(tmpdir(), "kiro-provider-reasoning-"));
  directories.add(directory);
  const path = join(directory, "accounts.db");
  const database = new AccountsDatabase(path);
  databases.add(database);
  return {
    directory,
    path,
    database,
    store: new ReasoningReplayStore(database, inputConfig),
    config: inputConfig,
  };
}

const baseContext = {
  tenantId: "tenant-a",
  model: "gpt-5.6-sol",
  accountId: "account-a",
  conversationId: "conversation-a",
  outputFingerprint: "output-fingerprint-a",
} as const;

function requireToken(value: string | undefined): string {
  expect(value).toBeString();
  if (value === undefined) throw new TypeError("Expected a reasoning replay token");
  return value;
}

function expectReplayError(operation: () => unknown, code: string): ReasoningReplayError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ReasoningReplayError);
    const replayError = error as ReasoningReplayError;
    expect(replayError.code).toBe(code);
    return replayError;
  }
  throw new TypeError(`Expected ReasoningReplayError ${code}`);
}

function openRaw(path: string): Database {
  return new Database(path, { strict: true });
}

describe("ReasoningReplayStore", () => {
  test("stores only token/fingerprint hashes and decrypts an exact signed replay", () => {
    const { path, store } = fixture();
    const reasoning = "private-reasoning-4b2f7156-d62d-4ad7-a09e-47e8f94c5853";
    const signature = "private-signature-78db887a-72b4-45a4-8df7-914312cb9ad2";

    const token = requireToken(store.store({ text: reasoning, signature }, baseContext));
    expect(token).toStartWith("kr1_");

    const raw = openRaw(path);
    const row = raw
      .query<
        {
          token_hash: string;
          fingerprint_hash: string;
          nonce: Uint8Array;
          ciphertext: Uint8Array;
          auth_tag: Uint8Array;
        },
        []
      >(
        "SELECT token_hash, fingerprint_hash, nonce, ciphertext, auth_tag FROM reasoning_replay",
      )
      .get();
    raw.close();
    expect(row).not.toBeNull();
    if (!row) throw new TypeError("Expected one encrypted replay row");
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.fingerprint_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toContain(token);
    const encryptedMaterial = Buffer.concat([
      Buffer.from(row.nonce),
      Buffer.from(row.ciphertext),
      Buffer.from(row.auth_tag),
    ]).toString("utf8");
    expect(encryptedMaterial).not.toContain(token);
    expect(encryptedMaterial).not.toContain(reasoning);
    expect(encryptedMaterial).not.toContain(signature);

    const resolved = store.resolveResponses(token, baseContext, 3);
    expect(resolved).toEqual({
      accountId: baseContext.accountId,
      conversationId: baseContext.conversationId,
      replay: {
        insertBeforeMessage: 3,
        content: { kind: "reasoning_text", text: reasoning, signature },
      },
    });
  });

  test("survives a database restart with the same keyring", () => {
    const first = fixture();
    const token = requireToken(
      first.store.store(
        { text: "restart reasoning", signature: "restart signature" },
        baseContext,
      ),
    );
    first.database.close();
    databases.delete(first.database);

    const reopened = new AccountsDatabase(first.path);
    databases.add(reopened);
    const restartedStore = new ReasoningReplayStore(reopened, first.config);
    expect(restartedStore.resolveResponses(token, baseContext, 1)).toMatchObject({
      accountId: baseContext.accountId,
      conversationId: baseContext.conversationId,
      replay: {
        insertBeforeMessage: 1,
        content: { kind: "reasoning_text", text: "restart reasoning" },
      },
    });
  });

  test("decrypts old records after key rotation and fails startup when an active key disappears", () => {
    const firstConfig = config([`old:${key(1)}`]);
    const first = fixture(firstConfig);
    const now = Date.now();
    const oldToken = requireToken(
      first.store.store(
        { text: "old reasoning", signature: "old signature" },
        baseContext,
        now,
      ),
    );
    first.database.close();
    databases.delete(first.database);

    const rotatedDatabase = new AccountsDatabase(first.path);
    databases.add(rotatedDatabase);
    const rotatedConfig = config([`new:${key(2)}`, `old:${key(1)}`]);
    const rotatedStore = new ReasoningReplayStore(rotatedDatabase, rotatedConfig);
    expect(rotatedStore.resolveResponses(oldToken, { ...baseContext, now: now + 1 }, 0)).toMatchObject({
      replay: { content: { text: "old reasoning", signature: "old signature" } },
    });
    requireToken(
      rotatedStore.store(
        { text: "new reasoning", signature: "new signature" },
        { ...baseContext, outputFingerprint: "output-fingerprint-new" },
        now + 2,
      ),
    );
    expect(rotatedDatabase.activeReasoningReplayKeyIds(now + 3)).toEqual(["new", "old"]);

    const missingKeyDatabase = new AccountsDatabase(first.path);
    databases.add(missingKeyDatabase);
    expect(() => new ReasoningReplayStore(missingKeyDatabase, config([`new:${key(2)}`]))).toThrow(
      /missing active key ids: old/,
    );
  });

  test("binds replay to tenant, model, account, conversation, output fingerprint, and TTL", () => {
    const replayConfig = config(undefined, { reasoning_replay_ttl_ms: 25 });
    const { store } = fixture(replayConfig);
    const now = Date.now();
    const token = requireToken(
      store.store({ text: "bound reasoning", signature: "bound signature" }, baseContext, now),
    );

    for (const mismatch of [
      { ...baseContext, tenantId: "tenant-b", now: now + 1 },
      { ...baseContext, model: "claude-sonnet-5", now: now + 1 },
      { ...baseContext, accountId: "account-b", now: now + 1 },
      { ...baseContext, conversationId: "conversation-b", now: now + 1 },
      { ...baseContext, outputFingerprint: "different-output", now: now + 1 },
    ]) {
      expectReplayError(
        () => store.resolveResponses(token, mismatch, 0),
        "reasoning_replay_context_mismatch",
      );
    }
    expectReplayError(
      () => store.resolveResponses(token, { ...baseContext, now: now + 25 }, 0),
      "reasoning_replay_expired",
    );
  });

  test("detects ciphertext tampering instead of degrading to plaintext", () => {
    const { path, store } = fixture();
    const token = requireToken(
      store.store({ text: "tamper reasoning", signature: "tamper signature" }, baseContext),
    );
    const raw = openRaw(path);
    const row = raw
      .query<{ token_hash: string; ciphertext: Uint8Array }, []>(
        "SELECT token_hash, ciphertext FROM reasoning_replay",
      )
      .get();
    if (!row) throw new TypeError("Expected an encrypted replay row");
    const tampered = Uint8Array.from(row.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    raw.query("UPDATE reasoning_replay SET ciphertext = ? WHERE token_hash = ?").run(
      tampered,
      row.token_hash,
    );
    raw.close();

    expectReplayError(
      () => store.resolveResponses(token, baseContext, 0),
      "reasoning_replay_decryption_failed",
    );
  });

  test("uses an exact Chat reasoning plus assistant-output hash and rejects ambiguity", () => {
    const { store } = fixture();
    const reasoningText = "chat signed reasoning";
    const signature = "chat signature";
    requireToken(store.store({ text: reasoningText, signature }, baseContext));
    requireToken(
      store.store(
        { text: reasoningText, signature: "other account signature" },
        {
          ...baseContext,
          accountId: "account-b",
          conversationId: "conversation-b",
        },
      ),
    );

    expectReplayError(
      () =>
        store.resolveChat(
          reasoningText,
          {
            tenantId: baseContext.tenantId,
            model: baseContext.model,
            outputFingerprint: baseContext.outputFingerprint,
          },
          0,
        ),
      "reasoning_replay_ambiguous",
    );
    expect(store.resolveChat(reasoningText, { ...baseContext, accountId: "account-a" }, 2)).toEqual({
      accountId: "account-a",
      conversationId: "conversation-a",
      replay: {
        insertBeforeMessage: 2,
        content: { kind: "reasoning_text", text: reasoningText, signature },
      },
    });
    expectReplayError(
      () =>
        store.resolveChat(
          reasoningText,
          { ...baseContext, outputFingerprint: "different-output" },
          0,
        ),
      "reasoning_replay_not_found",
    );
  });

  test("round-trips redacted bytes and rejects incomplete or ambiguous captures", () => {
    const { path, store } = fixture();
    const bytes = Uint8Array.from([0, 1, 2, 3, 127, 128, 254, 255]);
    const token = requireToken(
      store.store({ text: "", redactedContent: bytes }, baseContext),
    );
    expect(store.resolveResponses(token, baseContext, 4)).toEqual({
      accountId: baseContext.accountId,
      conversationId: baseContext.conversationId,
      replay: {
        insertBeforeMessage: 4,
        content: { kind: "redacted_content", bytes },
      },
    });
    expect(store.store({ text: "unsigned" }, baseContext)).toBeUndefined();
    expectReplayError(
      () =>
        store.store(
          { text: "ambiguous", signature: "signature", redactedContent: bytes },
          baseContext,
        ),
      "reasoning_replay_ambiguous",
    );

    const raw = openRaw(path);
    const count = raw.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM reasoning_replay").get();
    raw.close();
    expect(count?.count).toBe(1);
  });

  test("prunes expired and least-recently-used records transactionally", () => {
    const replayConfig = config(undefined, {
      reasoning_replay_ttl_ms: 10,
      reasoning_replay_max_entries: 2,
    });
    const { database, store } = fixture(replayConfig);
    const now = Date.now();
    const token1 = requireToken(
      store.store(
        { text: "reasoning one", signature: "signature one" },
        { ...baseContext, outputFingerprint: "output-one" },
        now,
      ),
    );
    const token2 = requireToken(
      store.store(
        { text: "reasoning two", signature: "signature two" },
        { ...baseContext, outputFingerprint: "output-two" },
        now + 1,
      ),
    );
    store.resolveResponses(
      token1,
      { ...baseContext, outputFingerprint: "output-one", now: now + 2 },
      0,
    );
    const token3 = requireToken(
      store.store(
        { text: "reasoning three", signature: "signature three" },
        { ...baseContext, outputFingerprint: "output-three" },
        now + 3,
      ),
    );

    expectReplayError(
      () =>
        store.resolveResponses(
          token2,
          { ...baseContext, outputFingerprint: "output-two", now: now + 4 },
          0,
        ),
      "reasoning_replay_not_found",
    );
    expect(store.resolveResponses(
      token1,
      { ...baseContext, outputFingerprint: "output-one", now: now + 4 },
      0,
    )).toMatchObject({ accountId: baseContext.accountId });
    expect(store.resolveResponses(
      token3,
      { ...baseContext, outputFingerprint: "output-three", now: now + 4 },
      0,
    )).toMatchObject({ accountId: baseContext.accountId });

    expect(database.pruneReasoningReplay(now + 13, 2)).toBe(2);
    expect(database.activeReasoningReplayKeyIds(now + 13)).toEqual([]);
  });
});

describe("reasoning replay keyring", () => {
  test("atomically generates and reuses a 0600 key file when no environment keyring is configured", () => {
    const directory = mkdtempSync(join(tmpdir(), "kiro-provider-reasoning-key-"));
    directories.add(directory);
    const path = join(directory, "nested", "reasoning-replay-keys.json");
    const fileConfig = config([], { reasoning_replay_key_path: path });

    const first = loadReasoningReplayKeyring(fileConfig);
    const second = loadReasoningReplayKeyring(fileConfig);

    expect(existsSync(path)).toBe(true);
    expect(first.source).toBe("file");
    expect(first.path).toBe(path);
    expect(second.active.id).toBe(first.active.id);
    expect(Buffer.from(second.active.key)).toEqual(Buffer.from(first.active.key));
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed).toMatchObject({ version: 1, keys: [{ id: first.active.id }] });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("uses the first configured key for encryption and keeps later keys for decryption", () => {
    const ring: ReasoningReplayKeyring = loadReasoningReplayKeyring(
      config([`active:${key(9)}`, `old:${key(8)}`]),
    );
    expect(ring.source).toBe("environment");
    expect(ring.active.id).toBe("active");
    expect([...ring.byId.keys()]).toEqual(["active", "old"]);
  });
});
