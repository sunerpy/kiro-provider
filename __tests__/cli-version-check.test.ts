import { describe, expect, test } from "bun:test";
import { CLI_VERSION, type CliDependencies, main, parseCliArgs } from "../src/cli/main.js";
import type {
  SelfUpdateOptions,
  SelfUpdateResult,
  UpdateCheck,
  UpdateCheckOptions,
} from "../src/cli/self-update.js";

const RELEASE_URL = "https://github.com/sunerpy/kiro-provider/releases/tag/v9.9.9";

type Harness = {
  readonly deps: CliDependencies;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly checks: UpdateCheckOptions[];
  readonly updates: SelfUpdateOptions[];
  readonly loaded: number[];
};

function createHarness(
  overrides: {
    readonly check?: (options: UpdateCheckOptions) => Promise<UpdateCheck>;
    readonly update?: (options: SelfUpdateOptions) => Promise<SelfUpdateResult>;
  } = {},
): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const checks: UpdateCheckOptions[] = [];
  const updates: SelfUpdateOptions[] = [];
  const loaded: number[] = [];
  const deps: CliDependencies = {
    loadConfig: () => {
      loaded.push(1);
      throw new Error("version and self-update must not load the gateway configuration");
    },
    startServer: () => ({}),
    runLogin: async () => {
      throw new Error("runLogin must not be called by this test");
    },
    runAccountRefresh: async () => {
      throw new Error("runAccountRefresh must not be called by this test");
    },
    runImportAccounts: () => undefined,
    checkForUpdate: async (options) => {
      checks.push(options);
      if (overrides.check) return overrides.check(options);
      return {
        currentVersion: options.currentVersion,
        latestVersion: "9.9.9",
        latestTag: "v9.9.9",
        releaseUrl: RELEASE_URL,
        updateAvailable: true,
        localIsNewer: false,
      };
    },
    runSelfUpdate: async (options) => {
      updates.push(options);
      if (overrides.update) return overrides.update(options);
      return {
        status: "updated",
        currentVersion: options.currentVersion,
        latestVersion: "9.9.9",
        releaseUrl: RELEASE_URL,
        asset: "kiro-provider-linux-x64",
        executablePath: "/home/dev/.local/bin/kiro-provider",
        sha256: "d".repeat(64),
      };
    },
    openDb: () => {
      throw new Error("openDb must not be called by this test");
    },
    confirm: async () => true,
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  };
  return { deps, stdout, stderr, checks, updates, loaded };
}

describe("version flags", () => {
  test("parses --check, --json, and --proxy on both spellings", () => {
    expect(parseCliArgs(["--version", "--check"])).toEqual({
      kind: "version",
      check: true,
      json: false,
    });
    expect(parseCliArgs(["-V", "--json"])).toEqual({
      kind: "version",
      check: false,
      json: true,
    });
    expect(
      parseCliArgs(["version", "--check", "--json", "--proxy", "http://127.0.0.1:7890"]),
    ).toEqual({ kind: "version", check: true, json: true, proxy: "http://127.0.0.1:7890" });
    expect(parseCliArgs(["--version", "--help"])).toEqual({ kind: "help" });
  });

  test("keeps an empty --proxy instead of silently dropping it", () => {
    expect(parseCliArgs(["-V", "--check", "--proxy", ""])).toEqual({
      kind: "version",
      check: true,
      json: false,
      proxy: "",
    });
    expect(parseCliArgs(["self-update", "--proxy", ""])).toEqual({
      kind: "self-update",
      check: false,
      json: false,
      yes: false,
      force: false,
      proxy: "",
    });
  });

  test("rejects unknown version flags", () => {
    expect(() => parseCliArgs(["--version", "--latest"])).toThrow("--latest");
  });

  test("prints only the version and never queries GitHub by default", async () => {
    const harness = createHarness();
    expect(await main(["--version"], harness.deps)).toBe(0);
    expect(harness.stdout).toEqual([`kiro-provider ${CLI_VERSION}`]);
    expect(harness.checks).toHaveLength(0);
    expect(harness.loaded).toEqual([]);
  });

  test("prints machine-readable version output", async () => {
    const harness = createHarness();
    expect(await main(["--version", "--json"], harness.deps)).toBe(0);
    expect(JSON.parse(harness.stdout.join("\n"))).toMatchObject({ version: CLI_VERSION });
    expect(harness.checks).toHaveLength(0);
  });

  test("--check reports the newest release without loading configuration", async () => {
    const harness = createHarness();
    expect(await main(["--version", "--check"], harness.deps)).toBe(0);
    expect(harness.checks).toEqual([{ currentVersion: CLI_VERSION }]);
    expect(harness.stdout).toEqual([
      `kiro-provider ${CLI_VERSION}`,
      `Latest release: 9.9.9 (${RELEASE_URL})`,
      "Update available. Install it with: kiro-provider self-update",
    ]);
    expect(harness.loaded).toEqual([]);
  });

  test("--check forwards the proxy flag", async () => {
    const harness = createHarness();
    expect(await main(["-V", "--check", "--proxy", "http://127.0.0.1:7890"], harness.deps)).toBe(0);
    expect(harness.checks).toEqual([
      { currentVersion: CLI_VERSION, proxyUrl: "http://127.0.0.1:7890" },
    ]);
  });

  test("--check leaves the documented environment fallback to the checker", async () => {
    const harness = createHarness();
    expect(await main(["-V", "--check"], harness.deps)).toBe(0);
    // No proxyUrl key at all, so checkForUpdate applies KIRO_PROVIDER_PROXY_URL
    // and the shell variables exactly as the documentation promises.
    expect(harness.checks).toEqual([{ currentVersion: CLI_VERSION }]);
  });

  test("--check forwards an explicitly empty --proxy so it suppresses the fallback", async () => {
    const harness = createHarness();
    expect(await main(["-V", "--check", "--proxy", ""], harness.deps)).toBe(0);
    expect(harness.checks).toEqual([{ currentVersion: CLI_VERSION, proxyUrl: "" }]);
  });

  test("--check --json emits one JSON document", async () => {
    const harness = createHarness();
    expect(await main(["--version", "--check", "--json"], harness.deps)).toBe(0);
    expect(JSON.parse(harness.stdout.join("\n"))).toEqual({
      version: CLI_VERSION,
      latest_version: "9.9.9",
      latest_tag: "v9.9.9",
      update_available: true,
      local_is_newer: false,
      release_url: RELEASE_URL,
    });
  });

  test("reports a failed lookup on stderr with a non-zero exit code", async () => {
    const harness = createHarness({
      check: async () => {
        throw new Error("GitHub rate-limited the request for the latest release (HTTP 403)");
      },
    });
    expect(await main(["--version", "--check"], harness.deps)).toBe(1);
    expect(harness.stderr).toEqual([
      "GitHub rate-limited the request for the latest release (HTTP 403)",
    ]);
    expect(harness.stdout).toEqual([]);
  });
});

describe("self-update", () => {
  test("parses its flags and normalizes a pinned tag", () => {
    expect(parseCliArgs(["self-update"])).toEqual({
      kind: "self-update",
      check: false,
      json: false,
      yes: false,
      force: false,
    });
    expect(
      parseCliArgs([
        "self-update",
        "--check",
        "--json",
        "-y",
        "--force",
        "--tag",
        "3.2.0",
        "--proxy",
        "http://127.0.0.1:7890",
      ]),
    ).toEqual({
      kind: "self-update",
      check: true,
      json: true,
      yes: true,
      force: true,
      tag: "v3.2.0",
      proxy: "http://127.0.0.1:7890",
    });
    expect(parseCliArgs(["self-update", "--help"])).toEqual({ kind: "help" });
  });

  test("rejects a tag that is not a release version", () => {
    expect(() => parseCliArgs(["self-update", "--tag", "nightly"])).toThrow(
      "Invalid self-update tag: nightly",
    );
  });

  test("forwards the parsed flags and prints the result", async () => {
    const harness = createHarness();
    expect(await main(["self-update", "--yes", "--tag", "3.2.0"], harness.deps)).toBe(0);
    expect(harness.updates).toEqual([
      {
        currentVersion: CLI_VERSION,
        check: false,
        force: false,
        assumeYes: true,
        tag: "v3.2.0",
      },
    ]);
    expect(harness.stdout[0]).toBe(`Updated kiro-provider ${CLI_VERSION} → 9.9.9`);
    expect(harness.stdout.at(-1)).toContain("systemctl --user restart kiro-provider.service");
    expect(harness.loaded).toEqual([]);
  });

  test("passes --check, --force, and --proxy through", async () => {
    const harness = createHarness({
      update: async (options) => ({
        status: "available",
        currentVersion: options.currentVersion,
        latestVersion: "9.9.9",
        releaseUrl: RELEASE_URL,
        asset: "kiro-provider-linux-x64",
        executablePath: "/home/dev/.local/bin/kiro-provider",
      }),
    });
    expect(
      await main(
        ["self-update", "--check", "--force", "--proxy", "http://127.0.0.1:7890"],
        harness.deps,
      ),
    ).toBe(0);
    expect(harness.updates).toEqual([
      {
        currentVersion: CLI_VERSION,
        check: true,
        force: true,
        assumeYes: false,
        proxyUrl: "http://127.0.0.1:7890",
      },
    ]);
    expect(harness.stdout[0]).toBe(`Update available: ${CLI_VERSION} → 9.9.9`);
  });

  test("keeps an explicitly empty --proxy so it suppresses the fallback", async () => {
    const harness = createHarness({
      update: async (options) => ({
        status: "up-to-date",
        currentVersion: options.currentVersion,
        latestVersion: options.currentVersion,
        releaseUrl: RELEASE_URL,
        localIsNewer: false,
      }),
    });
    expect(await main(["self-update", "--proxy", ""], harness.deps)).toBe(0);
    expect(harness.updates[0]?.proxyUrl).toBe("");
  });

  test("reports an up-to-date install as success", async () => {
    const harness = createHarness({
      update: async (options) => ({
        status: "up-to-date",
        currentVersion: options.currentVersion,
        latestVersion: options.currentVersion,
        releaseUrl: RELEASE_URL,
        localIsNewer: false,
      }),
    });
    expect(await main(["self-update"], harness.deps)).toBe(0);
    expect(harness.stdout).toEqual([`kiro-provider ${CLI_VERSION} is already the latest release.`]);
  });

  test("treats a declined confirmation as a failure and says how to skip it", async () => {
    const harness = createHarness({
      update: async (options) => ({
        status: "cancelled",
        currentVersion: options.currentVersion,
        latestVersion: "9.9.9",
        executablePath: "/home/dev/.local/bin/kiro-provider",
      }),
    });
    expect(await main(["self-update"], harness.deps)).toBe(1);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr).toEqual([
      "Update cancelled. /home/dev/.local/bin/kiro-provider was not changed.",
      "Use --yes for non-interactive confirmation.",
    ]);
  });

  test("hands the terminal confirmation prompt to the updater", async () => {
    const prompts: Array<(message: string) => Promise<boolean>> = [];
    const harness = createHarness();
    const deps: CliDependencies = {
      ...harness.deps,
      runSelfUpdate: async (options, dependencies) => {
        prompts.push(dependencies.confirm);
        expect(await dependencies.confirm("replace?")).toBe(true);
        return {
          status: "up-to-date",
          currentVersion: options.currentVersion,
          latestVersion: options.currentVersion,
          releaseUrl: RELEASE_URL,
          localIsNewer: false,
        };
      },
    };
    expect(await main(["self-update"], deps)).toBe(0);
    expect(prompts).toHaveLength(1);
  });

  test("surfaces an unsupported install as a non-zero exit code", async () => {
    const harness = createHarness({
      update: async () => {
        throw new Error("self-update only replaces the standalone release binary.");
      },
    });
    expect(await main(["self-update"], harness.deps)).toBe(1);
    expect(harness.stderr).toEqual(["self-update only replaces the standalone release binary."]);
    expect(harness.stdout).toEqual([]);
  });

  test("emits JSON for the machine-readable path", async () => {
    const harness = createHarness();
    expect(await main(["self-update", "--yes", "--json"], harness.deps)).toBe(0);
    expect(JSON.parse(harness.stdout.join("\n"))).toEqual({
      status: "updated",
      version: CLI_VERSION,
      latest_version: "9.9.9",
      asset: "kiro-provider-linux-x64",
      binary: "/home/dev/.local/bin/kiro-provider",
      sha256: "d".repeat(64),
      release_url: RELEASE_URL,
    });
  });
});
