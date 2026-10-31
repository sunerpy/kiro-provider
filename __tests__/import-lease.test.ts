import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireImportLease,
  IMPORT_LOCK_STALE_MS,
  IMPORT_LOCK_UPDATE_MS,
  type ImportLease,
} from "../src/cli/import-lease.js";

const roots: string[] = [];
const leases: ImportLease[] = [];

afterEach(async () => {
  for (const lease of leases.splice(0)) await lease.release();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function target() {
  const root = mkdtempSync(join(tmpdir(), "kiro-import-lease-test-"));
  roots.push(root);
  return { root, path: join(root, "accounts.db.import") };
}

describe("credential import process lease", () => {
  test("uses a 30 second stale window, private files and a non-waiting exclusive lease", async () => {
    expect(IMPORT_LOCK_STALE_MS).toBe(30_000);
    expect(IMPORT_LOCK_UPDATE_MS).toBe(5_000);
    const { path } = target();
    const lease = await acquireImportLease({ path });
    leases.push(lease);
    lease.assertHeld();
    await expect(acquireImportLease({ path })).rejects.toThrow("import_in_progress");
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(`${path}.lock`).mode & 0o777).toBe(0o700);
    }
    await lease.release();
    expect(existsSync(`${path}.lock`)).toBe(false);
    const next = await acquireImportLease({ path });
    leases.push(next);
  });

  test("recovers a stale crashed holder and renews a live holder while work continues", async () => {
    const { path } = target();
    mkdirSync(`${path}.lock`, { mode: 0o700 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, old, old);
    const lease = await acquireImportLease({ path, staleMs: 2_000, updateMs: 1_000 });
    leases.push(lease);
    const initial = statSync(`${path}.lock`).mtimeMs;
    await Bun.sleep(1_200);
    expect(statSync(`${path}.lock`).mtimeMs).toBeGreaterThan(initial);
    lease.assertHeld();
    await expect(acquireImportLease({ path, staleMs: 2_000, updateMs: 1_000 })).rejects.toThrow(
      "import_in_progress",
    );
  });

  test("aborts on heartbeat compromise and leaves a replacement owner intact during release", async () => {
    const { path } = target();
    const lease = await acquireImportLease({ path, staleMs: 2_000, updateMs: 1_000 });
    leases.push(lease);
    const compromised = new Promise<void>((resolve) =>
      lease.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    rmSync(`${path}.lock`, { recursive: true });
    await Promise.race([
      compromised,
      Bun.sleep(3_000).then(() => {
        throw new Error("import heartbeat did not detect ownership loss");
      }),
    ]);
    expect(lease.signal.aborted).toBe(true);
    expect(() => lease.assertHeld()).toThrow("import_lock_compromised");
    mkdirSync(`${path}.lock`, { mode: 0o700 });
    await lease.release();
    expect(existsSync(`${path}.lock`)).toBe(true);
  });

  test("detects directory replacement synchronously before the next heartbeat and never removes the replacement", async () => {
    const { path, root } = target();
    const lease = await acquireImportLease({ path });
    leases.push(lease);
    const replacement = join(root, "replacement");
    mkdirSync(replacement, { mode: 0o700 });
    rmSync(`${path}.lock`, { recursive: true });
    renameSync(replacement, `${path}.lock`);
    expect(() => lease.assertHeld()).toThrow("import_lock_compromised");
    await lease.release();
    expect(existsSync(`${path}.lock`)).toBe(true);
  });

  test("rejects unsafe parents, symlink targets and hard-linked targets with sanitized errors", async () => {
    const { root, path } = target();
    if (process.platform !== "win32") {
      chmodSync(root, 0o777);
      await expect(acquireImportLease({ path })).rejects.toThrow("unsafe_import_lock_path");
      chmodSync(root, 0o700);
    }
    const other = join(root, "fixture-original");
    writeFileSync(other, "fixture", { mode: 0o600 });
    linkSync(other, path);
    await expect(acquireImportLease({ path })).rejects.toThrow("unsafe_import_lock_path");
    rmSync(path);
    try {
      symlinkSync(other, path);
    } catch {
      return;
    }
    await expect(acquireImportLease({ path })).rejects.toThrow("unsafe_import_lock_path");
    expect(statSync(other).size).toBe(7);
  });

  test("normal process exit removes its own lock without waiting for heartbeat", async () => {
    const { path } = target();
    const moduleUrl = new URL("../src/cli/import-lease.ts", import.meta.url).href;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { acquireImportLease } from ${JSON.stringify(moduleUrl)}; await acquireImportLease({path:${JSON.stringify(path)}});`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
});
