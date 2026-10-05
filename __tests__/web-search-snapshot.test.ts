import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config/schema.js";
import { loadReasoningReplayKeyring } from "../src/reasoning/keyring.js";
import { ACCOUNTS_DB_SCHEMA_VERSION, AccountsDatabase } from "../src/storage/accounts-db.js";
import {
  openReference,
  sealReference,
  snapshotLookupHash,
  WEB_SEARCH_ENVELOPE_PREFIX,
} from "../src/web-search/crypto.js";
import {
  WEB_SEARCH_TOMBSTONE_GRACE_MS,
  type WebSearchSnapshotBinding,
  WebSearchSnapshotStore,
} from "../src/web-search/snapshot-store.js";

const KEY_A = `a:${Buffer.alloc(32, 1).toString("base64url")}`;
const KEY_B = `b:${Buffer.alloc(32, 2).toString("base64url")}`;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function keyring(...keys: string[]) {
  return loadReasoningReplayKeyring(
    ConfigSchema.parse({ api_keys: ["sk-test"], reasoning_replay_keys: keys }),
  );
}

const binding: WebSearchSnapshotBinding = {
  protocol: "anthropic-messages",
  wireModel: "claude-opus-5.5",
  owner: {
    accountId: "account-1",
    region: "us-east-1",
    profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/fixture",
    conversationId: "conversation-1",
  },
  wire: {
    toolUseId: "toolu_wire_1",
    toolName: "web_search",
    group: ["toolu_wire_1", "toolu_client"],
  },
  declarationFingerprint: "d".repeat(64),
  toolDefinitionFingerprint: "t".repeat(64),
  queryFingerprint: "q".repeat(64),
};

const result = {
  modelText: '{"results":[]}',
  sources: [
    {
      ordinal: 0,
      title: "T",
      url: "https://example.com/a",
      snippet: "S",
      backendId: "0",
      domain: "example.com",
      maxVerbatimWordLimit: 30,
      publicDomain: true,
    },
  ],
  retrievedCount: 1,
  filteredCount: 0,
  budgetDroppedCount: 0,
};

function store(
  database = new AccountsDatabase(":memory:"),
  options: { capacityBytes?: number; now?: () => number; keys?: string[] } = {},
) {
  return {
    database,
    store: new WebSearchSnapshotStore(database, () => keyring(...(options.keys ?? [KEY_A])), {
      capacityBytes: options.capacityBytes ?? 1_048_576,
      reservationBytes: 4_096,
      ...(options.now ? { now: options.now } : {}),
    }),
  };
}

const expiresAt = () => Date.now() + 60_000;

describe("web search snapshot store", () => {
  test("migrates additively to the web_search_replay table and keeps the file private", () => {
    const directory = mkdtempSync(join(tmpdir(), "kiro-web-search-db-"));
    directories.push(directory);
    const path = join(directory, "accounts.db");
    new AccountsDatabase(path).close();
    const raw = new Database(path);
    raw.run("DROP TABLE web_search_replay");
    raw.run("PRAGMA user_version = 7");
    raw.close();
    const reopened = new AccountsDatabase(path);
    expect(reopened.schemaVersion()).toBe(ACCOUNTS_DB_SCHEMA_VERSION);
    expect(ACCOUNTS_DB_SCHEMA_VERSION).toBe(8);
    const { store: snapshots } = store(reopened);
    snapshots.prepare({
      tenantId: "tenant",
      callId: "srvtoolu_1",
      status: "deferred",
      binding,
      expiresAt: expiresAt(),
    });
    expect(snapshots.read("tenant", "srvtoolu_1").status).toBe("deferred");
    reopened.close();
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    // A v7 reader opening this file runs no migration: the table is purely additive.
    const legacyReader = new Database(path, { readonly: true });
    expect(
      legacyReader.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM accounts").get()
        ?.count,
    ).toBe(0);
    legacyReader.close();
  });

  test("records plaintext only for lookup, state, lifetime and AEAD framing", () => {
    const { store: snapshots, database } = store();
    snapshots.prepare({
      tenantId: "tenant-secret",
      callId: "ws_secret",
      status: "prepared",
      binding,
      expiresAt: expiresAt(),
    });
    const row = database.getWebSearchSnapshot(snapshotLookupHash("tenant-secret", "ws_secret"));
    expect(row?.status).toBe("prepared");
    const plaintext = Buffer.from(row?.ciphertext ?? []).toString("latin1");
    for (const secret of [
      "tenant-secret",
      "ws_secret",
      "account-1",
      "conversation-1",
      "toolu_wire_1",
    ]) {
      expect(plaintext).not.toContain(secret);
      expect(JSON.stringify({ ...row, ciphertext: undefined })).not.toContain(secret);
    }
  });

  test("moves a pending call through exactly one claim to completion", () => {
    const { store: snapshots } = store();
    snapshots.prepare({
      tenantId: "tenant",
      callId: "srvtoolu_1",
      status: "deferred",
      binding,
      pendingReason: "mixed_tool_group",
      expiresAt: expiresAt(),
    });
    const claimed = snapshots.claim("tenant", "srvtoolu_1", ["deferred"]);
    expect(claimed.status).toBe("executing");
    expect(() => snapshots.claim("tenant", "srvtoolu_1", ["deferred"])).toThrow(
      expect.objectContaining({ code: "web_search_replay_pending" }),
    );
    const completed = snapshots.complete("tenant", claimed, result);
    expect(completed.status).toBe("completed");
    const read = snapshots.read("tenant", "srvtoolu_1");
    expect(read).toMatchObject({
      status: "completed",
      owner: binding.owner,
      wire: binding.wire,
      result,
    });
    expect(() => snapshots.claim("tenant", "srvtoolu_1", ["deferred", "paused"])).toThrow(
      expect.objectContaining({ code: "web_search_replay_pending" }),
    );
  });

  test("a stale claim cannot overwrite a newer state", () => {
    const { store: snapshots } = store();
    snapshots.prepare({
      tenantId: "tenant",
      callId: "ws_1",
      status: "prepared",
      binding,
      expiresAt: expiresAt(),
    });
    const claimed = snapshots.claim("tenant", "ws_1", ["prepared"]);
    snapshots.fail("tenant", claimed, {
      code: "unavailable",
      failure: "http_server_error",
      modelText: '{"error":"unavailable"}',
    });
    expect(() => snapshots.complete("tenant", claimed, result)).toThrow(
      expect.objectContaining({ code: "web_search_store_unavailable" }),
    );
    expect(snapshots.read("tenant", "ws_1")).toMatchObject({
      status: "failed",
      error: { code: "unavailable" },
    });
  });

  test("discards only an unpublished call still in its recorded state", () => {
    const { store: snapshots, database } = store();
    const row = (callId: string) =>
      database.getWebSearchSnapshot(snapshotLookupHash("tenant", callId));
    snapshots.prepare({
      tenantId: "tenant",
      callId: "ws_prepared",
      status: "prepared",
      binding,
      expiresAt: expiresAt(),
    });
    expect(
      snapshots.discard("tenant", "ws_prepared", { generation: 1, statuses: ["deferred"] }),
    ).toBe(false);
    expect(
      snapshots.discard("tenant", "ws_prepared", { generation: 1, statuses: ["prepared"] }),
    ).toBe(true);
    expect(row("ws_prepared")).toBeUndefined();

    snapshots.prepare({
      tenantId: "tenant",
      callId: "ws_claimed",
      status: "prepared",
      binding,
      expiresAt: expiresAt(),
    });
    const claimed = snapshots.claim("tenant", "ws_claimed", ["prepared"]);
    // The row moved on: its recorded generation no longer matches.
    expect(
      snapshots.discard("tenant", "ws_claimed", { generation: 1, statuses: ["prepared"] }),
    ).toBe(false);
    snapshots.complete("tenant", claimed, result);
    expect(
      snapshots.discard("tenant", "ws_claimed", {
        generation: claimed.generation,
        statuses: ["executing"],
      }),
    ).toBe(false);
    expect(row("ws_claimed")?.status).toBe("completed");
    expect(snapshots.discard("tenant", "ws_claimed", { generation: 3, statuses: [] })).toBe(false);
  });

  test("claims a group all or none", () => {
    const { store: snapshots, database } = store();
    for (const callId of ["srvtoolu_a", "srvtoolu_b", "srvtoolu_c", "srvtoolu_d"]) {
      snapshots.prepare({
        tenantId: "tenant",
        callId,
        status: "deferred",
        binding,
        expiresAt: expiresAt(),
      });
    }
    snapshots.claim("tenant", "srvtoolu_b", ["deferred"]);
    expect(() =>
      snapshots.claimGroup("tenant", ["srvtoolu_a", "srvtoolu_b"], ["deferred"]),
    ).toThrow(expect.objectContaining({ code: "web_search_replay_pending" }));
    // The refused group moved nothing, not even its first call.
    expect(database.getWebSearchSnapshot(snapshotLookupHash("tenant", "srvtoolu_a"))).toMatchObject(
      {
        status: "deferred",
        generation: 1,
      },
    );
    const claimed = snapshots.claimGroup("tenant", ["srvtoolu_c", "srvtoolu_d"], ["deferred"]);
    expect(claimed.map((snapshot) => [snapshot.status, snapshot.generation])).toEqual([
      ["executing", 2],
      ["executing", 2],
    ]);
    expect(
      snapshots.retireUnpublished("tenant", "srvtoolu_a", {
        generation: 1,
        statuses: ["deferred"],
      }),
    ).toBe(true);
    expect(snapshots.read("tenant", "srvtoolu_a").status).toBe("uncertain");
    expect(snapshots.claimGroup("tenant", [], ["deferred"])).toEqual([]);
  });

  test.each([
    ["one call at a time", 1],
    ["groups of two", 2],
  ])(
    "two writer processes on one database claim pending calls %s exactly once",
    async (_name, size) => {
      const directory = mkdtempSync(join(tmpdir(), "kiro-web-search-race-"));
      directories.push(directory);
      const path = join(directory, "accounts.db");
      const database = new AccountsDatabase(path);
      const { store: snapshots } = store(database);
      const ids = Array.from({ length: 40 }, (_, index) => `srvtoolu_race_${index}`);
      for (const callId of ids) {
        snapshots.prepare({
          tenantId: "tenant",
          callId,
          status: "deferred",
          binding,
          expiresAt: expiresAt(),
        });
      }
      const writer = () =>
        Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, "fixtures/web-search-claim-race.ts"),
            path,
            KEY_A,
            "tenant",
            JSON.stringify(ids),
            String(size),
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
      const writers = [writer(), writer()];
      const outputs = await Promise.all(
        writers.map(async (child) => {
          const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
          return JSON.parse(stdout) as string[];
        }),
      );
      const [first = [], second = []] = outputs;
      expect([...first, ...second].sort()).toEqual([...ids].sort());
      expect(first.filter((id) => second.includes(id))).toEqual([]);
      // A group always goes to one writer as a whole.
      for (let index = 0; index < ids.length; index += size) {
        const group = ids.slice(index, index + size);
        expect(
          group.every((id) => first.includes(id)) || group.every((id) => second.includes(id)),
        ).toBe(true);
      }
      for (const callId of ids) {
        expect(snapshots.read("tenant", callId)).toMatchObject({
          status: "completed",
          generation: 3,
        });
      }
      database.close();
    },
  );

  test("a restart turns executing calls into uncertain ones that never resume", () => {
    const database = new AccountsDatabase(":memory:");
    const first = store(database).store;
    first.prepare({
      tenantId: "tenant",
      callId: "srvtoolu_2",
      status: "paused",
      binding,
      expiresAt: expiresAt(),
    });
    first.claim("tenant", "srvtoolu_2", ["paused"]);
    const restarted = store(database).store;
    expect(restarted.recoverInterruptedExecutions()).toBe(1);
    expect(restarted.read("tenant", "srvtoolu_2").status).toBe("uncertain");
    expect(() => restarted.claim("tenant", "srvtoolu_2", ["paused"])).toThrow(
      expect.objectContaining({ code: "web_search_replay_uncertain", status: 409 }),
    );
    // Pending calls survive the restart unchanged.
    restarted.prepare({
      tenantId: "tenant",
      callId: "srvtoolu_3",
      status: "deferred",
      binding,
      expiresAt: expiresAt(),
    });
    expect(store(database).store.read("tenant", "srvtoolu_3").status).toBe("deferred");
  });

  test("cancellation after dispatch records an uncertain outcome", () => {
    const { store: snapshots } = store();
    snapshots.prepare({
      tenantId: "tenant",
      callId: "ws_cancel",
      status: "prepared",
      binding,
      expiresAt: expiresAt(),
    });
    const claimed = snapshots.claim("tenant", "ws_cancel", ["prepared"]);
    expect(snapshots.markUncertain("tenant", claimed)).toBe(true);
    expect(snapshots.read("tenant", "ws_cancel").status).toBe("uncertain");
  });

  test("isolates tenants and authenticates every snapshot", () => {
    const { store: snapshots, database } = store();
    snapshots.prepare({
      tenantId: "tenant-a",
      callId: "ws_1",
      status: "prepared",
      binding,
      expiresAt: expiresAt(),
    });
    expect(() => snapshots.read("tenant-b", "ws_1")).toThrow(
      expect.objectContaining({ code: "web_search_replay_not_found" }),
    );
    const row = database.getWebSearchSnapshot(snapshotLookupHash("tenant-a", "ws_1"));
    if (!row) throw new Error("missing row");
    const tampered = Uint8Array.from(row.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(
      database.transitionWebSearchSnapshot(
        row.lookupHash,
        { generation: row.generation, statuses: ["prepared"] },
        {
          status: "prepared",
          sealed: {
            keyId: row.keyId,
            nonce: row.nonce,
            authTag: row.authTag,
            ciphertext: tampered,
          },
        },
      ),
    ).toBe(true);
    expect(() => snapshots.read("tenant-a", "ws_1")).toThrow(
      expect.objectContaining({ code: "web_search_replay_invalid" }),
    );
  });

  test("reads across key rotation and reports a missing key", () => {
    const database = new AccountsDatabase(":memory:");
    store(database, { keys: [KEY_A] }).store.prepare({
      tenantId: "tenant",
      callId: "ws_rotate",
      status: "prepared",
      binding,
      expiresAt: expiresAt(),
    });
    expect(store(database, { keys: [KEY_B, KEY_A] }).store.read("tenant", "ws_rotate").status).toBe(
      "prepared",
    );
    expect(() => store(database, { keys: [KEY_B] }).store.read("tenant", "ws_rotate")).toThrow(
      expect.objectContaining({ code: "web_search_replay_key_unavailable", status: 503 }),
    );
  });

  test("refuses new commitments when the cache is full and frees only expired entries", () => {
    let now = 1_000_000;
    const { store: snapshots } = store(new AccountsDatabase(":memory:"), {
      capacityBytes: 8_192,
      now: () => now,
    });
    snapshots.prepare({
      tenantId: "t",
      callId: "ws_1",
      status: "prepared",
      binding,
      expiresAt: now + 1_000,
    });
    snapshots.prepare({
      tenantId: "t",
      callId: "ws_2",
      status: "prepared",
      binding,
      expiresAt: now + 5_000,
    });
    expect(() =>
      snapshots.prepare({
        tenantId: "t",
        callId: "ws_3",
        status: "prepared",
        binding,
        expiresAt: now + 5_000,
      }),
    ).toThrow(expect.objectContaining({ code: "web_search_cache_full", status: 503 }));
    expect(snapshots.read("t", "ws_1").status).toBe("prepared");
    now += 1_001;
    snapshots.prepare({
      tenantId: "t",
      callId: "ws_3",
      status: "prepared",
      binding,
      expiresAt: now + 5_000,
    });
    expect(snapshots.read("t", "ws_2").status).toBe("prepared");
  });

  test("keeps expired snapshots as tombstones so expiry stays distinguishable", () => {
    let now = 1_000_000;
    const { store: snapshots } = store(new AccountsDatabase(":memory:"), { now: () => now });
    snapshots.prepare({
      tenantId: "t",
      callId: "ws_old",
      status: "prepared",
      binding,
      expiresAt: now + 10,
    });
    now += 11;
    expect(() => snapshots.read("t", "ws_old")).toThrow(
      expect.objectContaining({ code: "web_search_replay_expired" }),
    );
    snapshots.prune();
    expect(() => snapshots.read("t", "ws_old")).toThrow(
      expect.objectContaining({ code: "web_search_replay_expired" }),
    );
    now += WEB_SEARCH_TOMBSTONE_GRACE_MS;
    snapshots.prune();
    expect(() => snapshots.read("t", "ws_old")).toThrow(
      expect.objectContaining({ code: "web_search_replay_not_found" }),
    );
  });

  test("extends a snapshot for a longer-lived stored response, never shortening it", () => {
    let now = 1_000_000;
    const { store: snapshots } = store(new AccountsDatabase(":memory:"), { now: () => now });
    snapshots.prepare({
      tenantId: "t",
      callId: "ws_keep",
      status: "prepared",
      binding,
      expiresAt: now + 10,
    });
    expect(snapshots.extend("t", "ws_keep", now + 100_000)).toBe(true);
    expect(snapshots.extend("t", "ws_keep", now + 5)).toBe(true);
    now += 50_000;
    expect(snapshots.read("t", "ws_keep").expiresAt).toBe(1_100_000);
  });
});

describe("Messages search references", () => {
  const reference = {
    purpose: "result" as const,
    callId: "srvtoolu_1",
    ordinal: 2,
    sourceIdentity: "s".repeat(64),
    visibleFingerprint: "v".repeat(64),
  };

  test("round-trips only for the same tenant, call and purpose", () => {
    const ring = keyring(KEY_A);
    const token = sealReference(ring, "tenant", reference);
    expect(token.startsWith(WEB_SEARCH_ENVELOPE_PREFIX)).toBe(true);
    expect(openReference(ring, "tenant", "srvtoolu_1", "result", token)).toEqual({
      ok: true,
      reference,
    });
    for (const [tenant, call, purpose] of [
      ["other", "srvtoolu_1", "result"],
      ["tenant", "srvtoolu_2", "result"],
      ["tenant", "srvtoolu_1", "citation"],
    ] as const) {
      expect(openReference(ring, tenant, call, purpose, token)).toEqual({
        ok: false,
        code: "web_search_replay_invalid",
      });
    }
  });

  test("rejects tampering and reports an unavailable key", () => {
    const token = sealReference(keyring(KEY_A), "tenant", reference);
    const flipped = `${token.slice(0, -2)}${token.endsWith("AA") ? "AB" : "AA"}`;
    expect(openReference(keyring(KEY_A), "tenant", "srvtoolu_1", "result", flipped).ok).toBe(false);
    expect(openReference(keyring(KEY_A), "tenant", "srvtoolu_1", "result", "kws1_###").ok).toBe(
      false,
    );
    expect(openReference(keyring(KEY_A), "tenant", "srvtoolu_1", "result", 42).ok).toBe(false);
    expect(openReference(keyring(KEY_B), "tenant", "srvtoolu_1", "result", token)).toEqual({
      ok: false,
      code: "web_search_replay_key_unavailable",
    });
    expect(openReference(keyring(KEY_B, KEY_A), "tenant", "srvtoolu_1", "result", token).ok).toBe(
      true,
    );
  });
});
