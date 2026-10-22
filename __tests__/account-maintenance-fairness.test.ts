import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountMaintenanceService } from "../src/core/account-maintenance.js";
import { AccountManager } from "../src/core/account-manager.js";
import { TokenRefresher } from "../src/core/token-refresher.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";
import { captureAuditEvents } from "./audit-test-helpers.js";

const originalFetch = globalThis.fetch;
const databases: AccountsDatabase[] = [];
const directories: string[] = [];
const restoreClocks: Array<() => void> = [];
let audit: ReturnType<typeof captureAuditEvents>;
beforeEach(() => {
  audit = captureAuditEvents();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const restore of restoreClocks.splice(0)) restore();
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  audit.restore();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fixture() {
  // Exercise deadline transitions explicitly: hosted Windows runners may stall
  // longer than a tiny wall-clock budget even when the implementation is right.
  const clock = spyOn(Date, "now").mockReturnValue(Date.now());
  const tokenPhases: AbortController[] = [];
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController();
    if (milliseconds === 40) tokenPhases.push(controller);
    return controller.signal;
  });
  restoreClocks.push(
    () => clock.mockRestore(),
    () => timeout.mockRestore(),
  );
  const directory = mkdtempSync(join(tmpdir(), "kiro-maintenance-fair-"));
  directories.push(directory);
  const db = new AccountsDatabase(join(directory, "accounts.db"));
  databases.push(db);
  const stored = ["a", "b", "c"].map((id) =>
    db.insertAccount({
      id,
      email: `${id}@example.invalid`,
      authMethod: "desktop",
      region: "us-east-1",
      refreshToken: `synthetic-${id}-refresh`,
      accessToken: `synthetic-${id}-access`,
      expiresAt: Date.now() - 60_000,
      rateLimitResetTime: 0,
      isHealthy: true,
      failCount: 0,
      usedCount: 1,
      limitCount: 100,
    } satisfies ManagedAccount),
  );
  const manager = new AccountManager(stored, "sticky", db);
  const refresher = new TokenRefresher(manager, 300_000);
  const started = deferred();
  const release = deferred();
  const tailsStarted = deferred();
  let tailRefreshes = 0;
  let headRefreshes = 0;
  let usageCalls = 0;
  const usageSignals: boolean[] = [];
  globalThis.fetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (body.refreshToken === "synthetic-a-refresh") {
        headRefreshes++;
        started.resolve();
        await release.promise;
      } else {
        tailRefreshes++;
        if (tailRefreshes === 2) tailsStarted.resolve();
      }
      return Response.json({
        accessToken: "synthetic-rotated-access",
        refreshToken: "synthetic-rotated-refresh",
        expiresIn: 3600,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  const service = new AccountMaintenanceService({
    enabled: true,
    intervalMs: 60_000,
    timeoutMs: 80,
    concurrency: 1,
    tokenExpiryBufferMs: 300_000,
    accountManager: manager,
    tokenRefresher: refresher,
    usageRefresher: {
      async recheckDueAccounts(_accounts, signal) {
        usageCalls++;
        usageSignals.push(signal.aborted);
      },
      async syncDueAccounts(_accounts, signal) {
        usageCalls++;
        usageSignals.push(signal.aborted);
      },
    },
  });
  return {
    db,
    manager,
    refresher,
    stored,
    service,
    started,
    release,
    tailsStarted,
    expireTokenPhase: () => {
      const phase = tokenPhases.at(-1);
      if (!phase) throw new Error("Missing bounded token-phase deadline");
      phase.abort(new DOMException("Synthetic token-phase deadline", "TimeoutError"));
    },
    tailRefreshes: () => tailRefreshes,
    headRefreshes: () => headRefreshes,
    usageCalls: () => usageCalls,
    usageSignals,
  };
}

test("token phase deadline leaves time for quota and usage while the shared refresh can finish later", async () => {
  const f = fixture();
  const first = f.service.runOnce().catch(() => undefined);
  await f.started.promise;
  const head = f.stored[0];
  if (!head) throw new Error("Missing synthetic head");
  const joined = f.refresher.refreshIfNeeded(head, f.manager.toAuthDetails(head));
  try {
    f.expireTokenPhase();
    await first;
    expect(f.usageCalls()).toBe(2);
    expect(f.usageSignals).toEqual([false, false]);
    expect(f.db.getById(head.id)?.refreshFailureCount).toBeUndefined();
    expect(f.db.getById(head.id)?.refreshRetryAt).toBeUndefined();
  } finally {
    f.release.resolve();
    await joined;
  }
  expect(f.db.getById(head.id)?.lastRefreshAt).toBeGreaterThan(0);
  expect(f.headRefreshes()).toBe(1);
});

test("a timed-out slow head cannot starve later accounts on the next maintenance round", async () => {
  const f = fixture();
  const first = f.service.runOnce().catch(() => undefined);
  await f.started.promise;
  const head = f.stored[0];
  if (!head) throw new Error("Missing synthetic head");
  const joined = f.refresher.refreshIfNeeded(head, f.manager.toAuthDetails(head));
  try {
    f.expireTokenPhase();
    await first;
    const second = f.service.runOnce().catch(() => undefined);
    await f.tailsStarted.promise;
    f.expireTokenPhase();
    await second;
    expect(f.tailRefreshes()).toBe(2);
    expect(f.headRefreshes()).toBe(1);
    expect(f.usageCalls()).toBe(4);
    for (const account of f.stored) {
      expect(f.db.getById(account.id)?.refreshFailureCount).toBeUndefined();
      expect(f.db.getById(account.id)?.rateLimitResetTime).toBe(0);
    }
  } finally {
    f.release.resolve();
    await joined;
  }
});
