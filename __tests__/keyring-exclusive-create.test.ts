import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConfigSchema } from "../src/config/schema.js";
import { loadReasoningReplayKeyring } from "../src/reasoning/keyring.js";

const directories = new Set<string>();

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

function keyPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "kiro-provider-keyring-race-"));
  directories.add(directory);
  return join(directory, "nested", "reasoning-replay-keys.json");
}

const KEYRING_MODULE = resolve(import.meta.dir, "../src/reasoning/keyring.ts");
const CONFIG_MODULE = resolve(import.meta.dir, "../src/config/schema.ts");

/**
 * Each writer busy-waits until a shared start instant so every process reaches
 * loadReasoningReplayKeyring within the same few milliseconds; the file does not
 * exist yet when they all check for it.
 */
function concurrentWriter(path: string, startAt: number): Promise<string> {
  const script = `
    const { loadReasoningReplayKeyring } = await import(${JSON.stringify(KEYRING_MODULE)});
    const { ConfigSchema } = await import(${JSON.stringify(CONFIG_MODULE)});
    const config = ConfigSchema.parse({
      api_keys: ["test-key"],
      reasoning_replay_key_path: ${JSON.stringify(path)},
    });
    while (Date.now() < ${startAt}) {}
    const ring = loadReasoningReplayKeyring(config);
    console.log(ring.active.id);
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).then(([stdout, stderr, exitCode]) => {
    if (exitCode !== 0) throw new Error(`writer exited ${exitCode}: ${stderr}`);
    return stdout.trim();
  });
}

describe("reasoning replay keyring exclusive creation", () => {
  test("concurrent first-start writers converge on one key file and one active key", async () => {
    const path = keyPath();
    const writers = 4;
    const startAt = Date.now() + 1_500;

    const ids = await Promise.all(
      Array.from({ length: writers }, () => concurrentWriter(path, startAt)),
    );

    const [agreedId] = ids;
    expect(agreedId).toBeDefined();
    if (agreedId === undefined) return;
    expect(new Set(ids).size).toBe(1);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      readonly keys: readonly { readonly id: string }[];
    };
    expect(parsed.keys.map((entry) => entry.id)).toEqual([agreedId]);
    // A later loader adopts the same persisted key.
    const reloaded = loadReasoningReplayKeyring(
      ConfigSchema.parse({ api_keys: ["test-key"], reasoning_replay_key_path: path }),
    );
    expect(reloaded.active.id).toBe(agreedId);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  }, 20_000);

  test("leaves no temporary files behind after generating a key", () => {
    const path = keyPath();
    const config = ConfigSchema.parse({
      api_keys: ["test-key"],
      reasoning_replay_key_path: path,
    });

    const ring = loadReasoningReplayKeyring(config);

    expect(ring.source).toBe("file");
    expect(existsSync(path)).toBe(true);
    const siblings = readdirSync(join(path, ".."));
    expect(siblings).toEqual(["reasoning-replay-keys.json"]);
  });
});
