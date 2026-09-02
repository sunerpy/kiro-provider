import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultOpenCodeAuthDbPath } from "../src/auth/opencode-auth-store.js";
import { platformConfigRoot } from "../src/config/paths.js";
import { defaultInstanceLockPath } from "../src/server/single-instance.js";

const ACCOUNTS_DB_MODULE = resolve(import.meta.dir, "../src/storage/accounts-db.ts");
const KEYRING_MODULE = resolve(import.meta.dir, "../src/reasoning/keyring.ts");

interface ModuleDefaults {
  readonly accountsDbPath: string;
  readonly keyringPath: string;
}

/**
 * ACCOUNTS_DB_PATH and REASONING_REPLAY_KEY_PATH are computed once at module
 * load from process.env, so their resolution is observed in a child process
 * whose HOME and XDG_CONFIG_HOME point at throwaway directories. Nothing is
 * created: only the path strings are printed.
 */
async function moduleDefaults(env: Record<string, string>): Promise<ModuleDefaults> {
  const script = `
    const { ACCOUNTS_DB_PATH } = await import(${JSON.stringify(ACCOUNTS_DB_MODULE)});
    const { REASONING_REPLAY_KEY_PATH } = await import(${JSON.stringify(KEYRING_MODULE)});
    console.log(JSON.stringify({ accountsDbPath: ACCOUNTS_DB_PATH, keyringPath: REASONING_REPLAY_KEY_PATH }));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`probe exited ${exitCode}: ${stderr}`);
  return JSON.parse(stdout.trim()) as ModuleDefaults;
}

describe("default store paths resolve through platformConfigRoot", () => {
  test("the OpenCode database default honors an explicit root and ignores an empty one", () => {
    expect(
      defaultOpenCodeAuthDbPath({
        XDG_CONFIG_HOME: "/tmp/opencode-config",
        APPDATA: "/tmp/opencode-config",
      }),
    ).toBe(join("/tmp/opencode-config", "opencode", "kiro.db"));
    // An empty variable used to be honored verbatim (yielding a relative path).
    expect(defaultOpenCodeAuthDbPath({ XDG_CONFIG_HOME: "", APPDATA: "" })).toBe(
      join(platformConfigRoot({ env: {} }), "opencode", "kiro.db"),
    );
  });

  test("the instance lock default treats an empty environment root as unset", () => {
    expect(
      defaultInstanceLockPath({
        env: { XDG_CONFIG_HOME: "" },
        platform: "linux",
        homeDirectory: "/home/test",
      }),
    ).toBe(join("/home/test", ".config", "kiro-provider", "service.instance"));
    expect(
      defaultInstanceLockPath({
        env: { APPDATA: "   " },
        platform: "win32",
        homeDirectory: "C:\\Users\\test",
      }),
    ).toBe(join("C:\\Users\\test", "AppData", "Roaming", "kiro-provider", "service.instance"));
  });

  test.skipIf(process.platform === "win32")(
    "the accounts database and keyring defaults follow XDG_CONFIG_HOME and fall back to HOME when it is empty",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "kiro-provider-home-"));
      const configHome = mkdtempSync(join(tmpdir(), "kiro-provider-xdg-"));
      try {
        const explicit = await moduleDefaults({ HOME: home, XDG_CONFIG_HOME: configHome });
        expect(explicit).toEqual({
          accountsDbPath: join(configHome, "kiro-provider", "accounts.db"),
          keyringPath: join(configHome, "kiro-provider", "reasoning-replay-keys.json"),
        });

        const fallback = await moduleDefaults({ HOME: home, XDG_CONFIG_HOME: "" });
        expect(fallback).toEqual({
          accountsDbPath: join(home, ".config", "kiro-provider", "accounts.db"),
          keyringPath: join(home, ".config", "kiro-provider", "reasoning-replay-keys.json"),
        });
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(configHome, { recursive: true, force: true });
      }
    },
  );
});
