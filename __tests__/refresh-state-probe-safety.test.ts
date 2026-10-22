import { describe, expect, test } from "bun:test";
import {
  fixtureTunnelAllowed,
  parseRefreshProbeArguments,
  refreshProbeEnvironment,
} from "../scripts/probe-refresh-state.js";
import { platformConfigRoot } from "../src/config/paths.js";

describe("offline refresh-state packaged probe safety boundary", () => {
  test("the real Windows path resolver selects private state despite inherited outside APPDATA", () => {
    const inherited = {
      HOME: "C:\\Users\\synthetic",
      APPDATA: "C:\\Users\\synthetic\\AppData\\Roaming",
    };
    const configRoot = "C:\\Temp\\synthetic-private\\config";
    const env = refreshProbeEnvironment(inherited, configRoot, "http://127.0.0.1:19001");
    expect(platformConfigRoot({ platform: "win32", env, homeDirectory: inherited.HOME })).toBe(
      configRoot,
    );
    expect(platformConfigRoot({ platform: "linux", env, homeDirectory: inherited.HOME })).toBe(
      configRoot,
    );
    expect(env.HOME).toBe(inherited.HOME);
    expect(inherited.APPDATA).toBe("C:\\Users\\synthetic\\AppData\\Roaming");
  });

  test("requires exactly one absolute local binary and refuses external state/config/endpoint overrides", () => {
    expect(parseRefreshProbeArguments(["--binary", "/tmp/synthetic-provider"])).toBe(
      "/tmp/synthetic-provider",
    );
    for (const args of [
      [],
      ["--binary", "relative-provider"],
      ["--binary", "https://example.invalid/provider"],
      ["--binary", "/tmp/synthetic-provider", "--state-dir", "/config/.config/kiro-provider"],
      [
        "--binary",
        "/tmp/synthetic-provider",
        "--config",
        "/config/.config/kiro-provider/config.json",
      ],
      [
        "--binary",
        "/tmp/synthetic-provider",
        "--endpoint",
        "https://oidc.us-east-1.amazonaws.com/token",
      ],
      ["--binary", "/tmp/synthetic-provider", "positional"],
    ])
      expect(() => parseRefreshProbeArguments(args)).toThrow("invalid_arguments");
  });

  test("preserves HOME without inheriting provider config, credentials, loaders or outside proxies", () => {
    const inherited = {
      HOME: "/synthetic-original-home",
      PATH: "/usr/bin",
      KIRO_PROVIDER_CONFIG: "/outside/config",
      KIRO_PROVIDER_API_KEYS: "outside-secret",
      AWS_ACCESS_KEY_ID: "outside-key",
      ANTHROPIC_API_KEY: "outside-key",
      BUN_OPTIONS: "--preload /outside/file",
      NODE_OPTIONS: "--require /outside/file",
      LD_PRELOAD: "/outside/file",
      HTTPS_PROXY: "http://outside.invalid:9000",
      XDG_CONFIG_HOME: "/outside/state",
    };
    const env = refreshProbeEnvironment(
      inherited,
      "/tmp/synthetic-task/config",
      "http://127.0.0.1:19001",
    );
    expect(env.HOME).toBe(inherited.HOME);
    expect(inherited.XDG_CONFIG_HOME).toBe("/outside/state");
    expect(env.XDG_CONFIG_HOME).toBe("/tmp/synthetic-task/config");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:19001");
    for (const key of [
      "KIRO_PROVIDER_CONFIG",
      "KIRO_PROVIDER_API_KEYS",
      "AWS_ACCESS_KEY_ID",
      "ANTHROPIC_API_KEY",
      "BUN_OPTIONS",
      "NODE_OPTIONS",
      "LD_PRELOAD",
    ])
      expect(env).not.toHaveProperty(key);
  });

  test("the local proxy tunnels only to the one self-created IPv4 endpoint", () => {
    expect(fixtureTunnelAllowed("127.0.0.1:19000", 19000)).toBe(true);
    for (const authority of [
      "oidc.us-east-1.amazonaws.com:443",
      "127.0.0.1:19001",
      "127.0.0.1.evil.invalid:19000",
      "localhost:19000",
      "[::1]:19000",
      "127.0.0.1:19000@evil.invalid:443",
      "http://127.0.0.1:19000",
    ])
      expect(fixtureTunnelAllowed(authority, 19000)).toBe(false);
    expect(fixtureTunnelAllowed("127.0.0.1:0", 0)).toBe(false);
    expect(fixtureTunnelAllowed("127.0.0.1:65536", 65536)).toBe(false);
  });
});
