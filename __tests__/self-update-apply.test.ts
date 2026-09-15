import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FetchLike,
  runSelfUpdate,
  type SelfUpdateDependencies,
  type SelfUpdateOptions,
} from "../src/cli/self-update.js";

const LATEST_URL = "https://api.github.com/repos/sunerpy/kiro-provider/releases/latest";
const DOWNLOAD_BASE = "https://github.com/sunerpy/kiro-provider/releases/download";
const ASSET = "kiro-provider-linux-x64";
const OLD_BYTES = "old binary payload";
const NEW_BYTES = "new binary payload";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates a throwaway install directory holding a stand-in binary. */
function installRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kiro-self-update-"));
  roots.push(root);
  // Resolve now so the reported path matches what the updater resolves.
  const binary = join(realpathSync(root), "kiro-provider");
  writeFileSync(binary, OLD_BYTES, { mode: 0o755 });
  return binary;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function releaseFetch(
  options: {
    readonly tag?: string;
    readonly manifest?: string;
    readonly asset?: string;
    readonly manifestStatus?: number;
    readonly assetStatus?: number;
  } = {},
): { readonly fetch: FetchLike; readonly urls: string[] } {
  const tag = options.tag ?? "v3.4.0";
  const assetBody = options.asset ?? NEW_BYTES;
  const manifest = options.manifest ?? `${sha256(assetBody)}  ${ASSET}\n`;
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    if (url === LATEST_URL || url.endsWith(`/releases/tags/${tag}`)) {
      return new Response(JSON.stringify({ tag_name: tag }), { status: 200 });
    }
    if (url === `${DOWNLOAD_BASE}/${tag}/SHA256SUMS`) {
      return new Response(manifest, { status: options.manifestStatus ?? 200 });
    }
    if (url === `${DOWNLOAD_BASE}/${tag}/${ASSET}`) {
      return new Response(assetBody, { status: options.assetStatus ?? 200 });
    }
    return new Response("missing", { status: 404 });
  };
  return { fetch: fetchImpl, urls };
}

function update(
  binary: string,
  fetchImpl: FetchLike,
  overrides: Partial<SelfUpdateOptions> = {},
  dependencies: Partial<SelfUpdateDependencies> = {},
) {
  const options: SelfUpdateOptions = {
    currentVersion: "3.3.1",
    check: false,
    force: false,
    assumeYes: true,
    ...overrides,
  };
  return runSelfUpdate(options, {
    confirm: async () => true,
    fetch: fetchImpl,
    env: {},
    runtime: {
      entryPath: "/$bunfs/root",
      executablePath: binary,
      platform: "linux",
      arch: "x64",
    },
    ...dependencies,
  });
}

describe("runSelfUpdate", () => {
  test("replaces the binary after verifying the published digest", async () => {
    const binary = installRoot();
    const { fetch: fetchImpl, urls } = releaseFetch();
    const result = await update(binary, fetchImpl);

    expect(result.status).toBe("updated");
    expect(result).toMatchObject({
      currentVersion: "3.3.1",
      latestVersion: "3.4.0",
      executablePath: binary,
      sha256: sha256(NEW_BYTES),
    });
    expect(readFileSync(binary, "utf8")).toBe(NEW_BYTES);
    // The manifest is fetched before the asset so nothing is buffered without
    // a digest to check it against.
    expect(urls).toEqual([
      LATEST_URL,
      `${DOWNLOAD_BASE}/v3.4.0/SHA256SUMS`,
      `${DOWNLOAD_BASE}/v3.4.0/${ASSET}`,
    ]);
  });

  test("leaves no staging file behind", async () => {
    const binary = installRoot();
    await update(binary, releaseFetch().fetch);
    expect(readdirSync(join(binary, ".."))).toEqual(["kiro-provider"]);
  });

  test("preserves the existing permission bits and keeps the file executable", async () => {
    const binary = installRoot();
    chmodSync(binary, 0o700);
    await update(binary, releaseFetch().fetch);
    expect(statSync(binary).mode & 0o777).toBe(0o700);

    const readOnlyExec = installRoot();
    chmodSync(readOnlyExec, 0o644);
    await update(readOnlyExec, releaseFetch().fetch);
    expect(statSync(readOnlyExec).mode & 0o777).toBe(0o744);
  });

  test("refuses a checksum mismatch and leaves the installed binary untouched", async () => {
    const binary = installRoot();
    const { fetch: fetchImpl } = releaseFetch({ manifest: `${"0".repeat(64)}  ${ASSET}\n` });
    await expect(update(binary, fetchImpl)).rejects.toThrow(
      `Checksum mismatch for ${ASSET}: expected ${"0".repeat(64)}`,
    );
    expect(readFileSync(binary, "utf8")).toBe(OLD_BYTES);
    expect(readdirSync(join(binary, ".."))).toEqual(["kiro-provider"]);
  });

  test("refuses a manifest with no entry for this platform's asset", async () => {
    const binary = installRoot();
    const { fetch: fetchImpl, urls } = releaseFetch({
      manifest: `${sha256(NEW_BYTES)}  kiro-provider-darwin-arm64\n`,
    });
    await expect(update(binary, fetchImpl)).rejects.toThrow(`has no entry for ${ASSET}`);
    expect(readFileSync(binary, "utf8")).toBe(OLD_BYTES);
    // The asset itself is never downloaded without a digest.
    expect(urls).not.toContain(`${DOWNLOAD_BASE}/v3.4.0/${ASSET}`);
  });

  test("refuses an empty or missing asset download", async () => {
    const empty = installRoot();
    await expect(update(empty, releaseFetch({ asset: "" }).fetch)).rejects.toThrow(
      "download was empty",
    );
    expect(readFileSync(empty, "utf8")).toBe(OLD_BYTES);

    const missing = installRoot();
    await expect(update(missing, releaseFetch({ assetStatus: 404 }).fetch)).rejects.toThrow(
      "was not found (HTTP 404)",
    );
    expect(readFileSync(missing, "utf8")).toBe(OLD_BYTES);
  });

  test("reports an unavailable checksum manifest", async () => {
    const binary = installRoot();
    await expect(update(binary, releaseFetch({ manifestStatus: 404 }).fetch)).rejects.toThrow(
      "SHA256SUMS for v3.4.0 was not found (HTTP 404)",
    );
    expect(readFileSync(binary, "utf8")).toBe(OLD_BYTES);
  });

  test("stops at the version check when the release matches the running build", async () => {
    const binary = installRoot();
    const { fetch: fetchImpl, urls } = releaseFetch({ tag: "v3.3.1" });
    const result = await update(binary, fetchImpl);
    expect(result).toEqual({
      status: "up-to-date",
      currentVersion: "3.3.1",
      latestVersion: "3.3.1",
      releaseUrl: "https://github.com/sunerpy/kiro-provider/releases/tag/v3.3.1",
    });
    expect(urls).toEqual([LATEST_URL]);
    expect(readFileSync(binary, "utf8")).toBe(OLD_BYTES);
  });

  test("reinstalls the same version when forced", async () => {
    const binary = installRoot();
    const { fetch: fetchImpl } = releaseFetch({ tag: "v3.3.1" });
    const result = await update(binary, fetchImpl, { force: true });
    expect(result.status).toBe("updated");
    expect(readFileSync(binary, "utf8")).toBe(NEW_BYTES);
  });

  test("installs a pinned older release, treating the flag as an instruction", async () => {
    const binary = installRoot();
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      if (url.endsWith("/releases/tags/v3.2.0")) {
        return new Response(JSON.stringify({ tag_name: "v3.2.0" }), { status: 200 });
      }
      if (url === `${DOWNLOAD_BASE}/v3.2.0/SHA256SUMS`) {
        return new Response(`${sha256(NEW_BYTES)}  ${ASSET}\n`, { status: 200 });
      }
      if (url === `${DOWNLOAD_BASE}/v3.2.0/${ASSET}`) {
        return new Response(NEW_BYTES, { status: 200 });
      }
      return new Response("missing", { status: 404 });
    };
    const result = await update(binary, fetchImpl, { tag: "v3.2.0" });
    expect(result).toMatchObject({ status: "updated", latestVersion: "3.2.0" });
    expect(readFileSync(binary, "utf8")).toBe(NEW_BYTES);
  });

  test("--check reports the pending update without downloading anything", async () => {
    const binary = installRoot();
    const { fetch: fetchImpl, urls } = releaseFetch();
    const result = await update(binary, fetchImpl, { check: true, assumeYes: false });
    expect(result).toEqual({
      status: "available",
      currentVersion: "3.3.1",
      latestVersion: "3.4.0",
      releaseUrl: "https://github.com/sunerpy/kiro-provider/releases/tag/v3.4.0",
      asset: ASSET,
      executablePath: binary,
    });
    expect(urls).toEqual([LATEST_URL]);
    expect(readFileSync(binary, "utf8")).toBe(OLD_BYTES);
  });

  test("asks before replacing the binary and honours a refusal", async () => {
    const binary = installRoot();
    const prompts: string[] = [];
    const result = await update(
      binary,
      releaseFetch().fetch,
      { assumeYes: false },
      {
        confirm: async (message) => {
          prompts.push(message);
          return false;
        },
      },
    );
    expect(prompts).toEqual([`Update kiro-provider 3.3.1 to 3.4.0 at ${binary}?`]);
    expect(result).toEqual({
      status: "cancelled",
      currentVersion: "3.3.1",
      latestVersion: "3.4.0",
      executablePath: binary,
    });
    expect(readFileSync(binary, "utf8")).toBe(OLD_BYTES);
  });

  test("spells out a reinstall and a downgrade in the confirmation prompt", async () => {
    const reinstall = installRoot();
    const reinstallPrompts: string[] = [];
    await update(
      reinstall,
      releaseFetch({ tag: "v3.3.1" }).fetch,
      { assumeYes: false, force: true },
      {
        confirm: async (message) => {
          reinstallPrompts.push(message);
          return false;
        },
      },
    );
    expect(reinstallPrompts[0]).toContain("Reinstall kiro-provider 3.3.1");

    const downgrade = installRoot();
    const downgradePrompts: string[] = [];
    await update(
      downgrade,
      releaseFetch({ tag: "v3.2.0" }).fetch,
      { assumeYes: false, tag: "v3.2.0" },
      {
        confirm: async (message) => {
          downgradePrompts.push(message);
          return false;
        },
      },
    );
    expect(downgradePrompts[0]).toContain("with the OLDER release 3.2.0");
  });

  test("refuses an install directory it cannot write to", async () => {
    const binary = installRoot();
    const directory = join(binary, "..");
    chmodSync(directory, 0o500);
    try {
      await expect(update(binary, releaseFetch().fetch)).rejects.toThrow("No write permission");
      expect(readFileSync(binary, "utf8")).toBe(OLD_BYTES);
    } finally {
      chmodSync(directory, 0o700);
    }
  });
});
