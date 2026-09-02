import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const artifactPath = join(repoRoot, "dist", "cli.js");
const SHEBANG = "#!/usr/bin/env bun";

async function run(command: readonly string[]): Promise<{ exitCode: number; stderr: string }> {
  const child = Bun.spawn([...command], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr };
}

// `bun build` preserves the entry point's own hashbang, so build:npm must not add
// a `--banner` shebang: Bun 1.3.14 would then emit two shebang lines and the
// artifact would fail to execute. This guards the published npm bin.
describe("build:npm artifact", () => {
  test("dist/cli.js starts with exactly one bun shebang and runs --help", async () => {
    const build = await run(["bun", "run", "build:npm"]);
    expect(build.stderr.includes("error")).toBe(false);
    expect(build.exitCode).toBe(0);

    const lines = readFileSync(artifactPath, "utf8").split("\n");
    expect(lines[0]).toBe(SHEBANG);
    expect(lines.filter((line) => line.startsWith("#!"))).toEqual([SHEBANG]);
    if (process.platform !== "win32") {
      expect(statSync(artifactPath).mode & 0o111).not.toBe(0);
    }

    const help = await run(["bun", artifactPath, "--help"]);
    expect(help.exitCode).toBe(0);
  }, 30_000);
});
