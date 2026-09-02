import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigLoadError,
  loadConfig,
  OPENCODE_SHARED_REMOVED_MESSAGE,
} from "../src/config/loader.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function configFile(body: Record<string, unknown>): string {
  const directory = mkdtempSync(join(tmpdir(), "kiro-auth-source-"));
  directories.push(directory);
  const path = join(directory, "config.json");
  writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
  return path;
}

describe("removed opencode-shared authentication mode", () => {
  test("loadConfig fails fast with the migration message", () => {
    const configPath = configFile({ api_keys: ["sk-test"], auth_source: "opencode-shared" });

    expect(() => loadConfig({ configPath, env: {} })).toThrow(ConfigLoadError);
    expect(() => loadConfig({ configPath, env: {} })).toThrow(OPENCODE_SHARED_REMOVED_MESSAGE);
    expect(OPENCODE_SHARED_REMOVED_MESSAGE).toContain("kiro-provider accounts import");
  });

  test("the environment override is rejected the same way", () => {
    const configPath = configFile({ api_keys: ["sk-test"] });

    expect(() =>
      loadConfig({ configPath, env: { KIRO_PROVIDER_AUTH_SOURCE: "opencode-shared" } }),
    ).toThrow(OPENCODE_SHARED_REMOVED_MESSAGE);
  });

  test("a deprecated opencode_auth_db_path still loads but warns once", () => {
    const configPath = configFile({
      api_keys: ["sk-test"],
      opencode_auth_db_path: "/tmp/opencode/kiro.db",
    });
    const stderr = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const config = loadConfig({ configPath, env: {} });
      expect(config.auth_source).toBe("local");
      expect(config.opencode_auth_db_path).toBe("/tmp/opencode/kiro.db");
      const events = stderr.mock.calls
        .map(([line]) => JSON.parse(String(line)) as { event?: string })
        .filter((entry) => entry.event === "config_opencode_auth_db_path_deprecated");
      expect(events).toHaveLength(1);
    } finally {
      stderr.mockRestore();
    }
  });

  test("a local configuration without the deprecated key emits no migration warning", () => {
    const configPath = configFile({ api_keys: ["sk-test"] });
    const stderr = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      loadConfig({ configPath, env: {} });
      const events = stderr.mock.calls
        .map(([line]) => JSON.parse(String(line)) as { event?: string })
        .filter((entry) => entry.event === "config_opencode_auth_db_path_deprecated");
      expect(events).toHaveLength(0);
    } finally {
      stderr.mockRestore();
    }
  });
});
