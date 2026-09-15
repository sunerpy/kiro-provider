import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverReasoningReplay } from "../scripts/recover-reasoning-replay.js";
import { ConfigSchema } from "../src/config/schema.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const replayContext = {
  tenantId: "tenant-a",
  model: "gpt-5.6-sol",
  accountId: "account-a",
  conversationId: "conversation-a",
  outputFingerprint: "output-a",
} as const;

function account(): ManagedAccount {
  return {
    id: replayContext.accountId,
    email: "account@example.com",
    authMethod: "desktop",
    region: "us-east-1",
    refreshToken: "refresh",
    accessToken: "access",
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
  };
}

describe("legacy reasoning replay recovery utility", () => {
  test("dry-runs read-only then restores exactly one authenticated row", () => {
    const root = mkdtempSync(join(tmpdir(), "kiro-replay-recover-"));
    roots.push(root);
    const sourcePath = join(root, "source.db");
    const targetPath = join(root, "target.db");
    const configPath = join(root, "config.json");
    const key = Buffer.alloc(32, 7).toString("base64url");
    writeFileSync(
      configPath,
      JSON.stringify({
        api_keys: ["sk-test"],
        reasoning_replay_keys: [`active:${key}`],
        reasoning_replay_token_format: "database-v1",
        reasoning_replay_ttl_ms: 60_000,
        instance_lock_path: join(root, "service.instance"),
      }),
      { mode: 0o600 },
    );
    const config = ConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
    const source = new AccountsDatabase(sourcePath);
    source.insertAccount(account());
    const token = new ReasoningReplayStore(source, config).store(
      { text: "private", signature: "signature" },
      replayContext,
    );
    expect(token).toStartWith("kr1_");
    source.close();
    const raw = new Database(sourcePath, { readonly: true, strict: true });
    const tokenHash = raw
      .query<{ token_hash: string }, []>("SELECT token_hash FROM reasoning_replay")
      .get()?.token_hash;
    raw.close(false);
    if (!tokenHash || !token) throw new TypeError("missing source token");
    const target = new AccountsDatabase(targetPath);
    target.insertAccount(account());
    target.close();

    const base = {
      sourceDb: sourcePath,
      targetDb: targetPath,
      configPath,
      tokenHashPrefix: tokenHash.slice(0, 16),
      ttlMs: 120_000,
    } as const;
    expect(recoverReasoningReplay({ ...base, apply: false })).toMatchObject({
      mode: "dry-run",
      sourceRecordAuthenticated: true,
      targetAlreadyPresent: false,
      targetAccountPresent: true,
      targetQuickCheck: "not-run",
    });
    const dryTarget = new Database(targetPath, { readonly: true });
    expect(
      dryTarget.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM reasoning_replay").get()
        ?.count,
    ).toBe(0);
    dryTarget.close(false);

    expect(
      recoverReasoningReplay({
        ...base,
        apply: true,
        confirmation: tokenHash.slice(0, 16),
      }),
    ).toMatchObject({ mode: "applied", targetQuickCheck: "ok" });
    const reopened = new AccountsDatabase(targetPath);
    expect(
      new ReasoningReplayStore(reopened, config).resolveResponses(token, replayContext, 0),
    ).toMatchObject({ replay: { content: { text: "private", signature: "signature" } } });
    reopened.close();
  });
});
