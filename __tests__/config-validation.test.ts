import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_ENV_VARIABLES, ConfigLoadError, loadConfig } from "../src/config/loader.js";
import { defaultConfigPath, legacyConfigRoot, platformConfigRoot } from "../src/config/paths.js";
import { ConfigSchema } from "../src/config/schema.js";
import { resetAuditLogLevel } from "../src/core/audit-log.js";

const temporaryDirectories: string[] = [];

function createConfigFile(config: unknown, mode?: number): string {
  const directory = mkdtempSync(join(tmpdir(), "kiro-provider-config-validation-"));
  temporaryDirectories.push(directory);
  const configPath = join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify(config), { encoding: "utf8", mode: 0o600 });
  if (mode !== undefined) chmodSync(configPath, mode);
  return configPath;
}

afterEach(() => {
  resetAuditLogLevel();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

type NumericField = {
  readonly field: string;
  readonly envName: string;
  readonly min: number;
  readonly max: number;
};

/** Every integer field with its accepted closed range. */
const numericFields: NumericField[] = [
  { field: "port", envName: "KIRO_PROVIDER_PORT", min: 0, max: 65_535 },
  {
    field: "rate_limit_max_retries",
    envName: "KIRO_PROVIDER_RATE_LIMIT_MAX_RETRIES",
    min: 0,
    max: 100,
  },
  {
    field: "rate_limit_retry_delay_ms",
    envName: "KIRO_PROVIDER_RATE_LIMIT_RETRY_DELAY_MS",
    min: 1,
    max: 2_147_483_647,
  },
  {
    field: "max_request_iterations",
    envName: "KIRO_PROVIDER_MAX_REQUEST_ITERATIONS",
    min: 1,
    max: 1_000,
  },
  {
    field: "max_request_body_bytes",
    envName: "KIRO_PROVIDER_MAX_REQUEST_BODY_BYTES",
    min: 1,
    max: 2_147_483_647,
  },
  {
    field: "token_expiry_buffer_ms",
    envName: "KIRO_PROVIDER_TOKEN_EXPIRY_BUFFER_MS",
    min: 1,
    max: 2_147_483_647,
  },
  {
    field: "model_catalog_ttl_ms",
    envName: "KIRO_PROVIDER_MODEL_CATALOG_TTL_MS",
    min: 1,
    max: 2_147_483_647,
  },
  {
    field: "model_catalog_stale_ttl_ms",
    envName: "KIRO_PROVIDER_MODEL_CATALOG_STALE_TTL_MS",
    min: 1,
    max: 2_147_483_647,
  },
  {
    field: "model_catalog_request_timeout_ms",
    envName: "KIRO_PROVIDER_MODEL_CATALOG_REQUEST_TIMEOUT_MS",
    min: 1,
    max: 2_147_483_647,
  },
  {
    field: "quota_recheck_interval_ms",
    envName: "KIRO_PROVIDER_QUOTA_RECHECK_INTERVAL_MS",
    min: 1,
    max: 2_147_483_647,
  },
  {
    field: "quota_recheck_timeout_ms",
    envName: "KIRO_PROVIDER_QUOTA_RECHECK_TIMEOUT_MS",
    min: 1,
    max: 2_147_483_647,
  },
  {
    field: "quota_recheck_concurrency",
    envName: "KIRO_PROVIDER_QUOTA_RECHECK_CONCURRENCY",
    min: 1,
    max: 32,
  },
  {
    field: "account_maintenance_interval_ms",
    envName: "KIRO_PROVIDER_ACCOUNT_MAINTENANCE_INTERVAL_MS",
    min: 1_000,
    max: 2_147_483_647,
  },
  {
    field: "account_maintenance_timeout_ms",
    envName: "KIRO_PROVIDER_ACCOUNT_MAINTENANCE_TIMEOUT_MS",
    min: 1_000,
    max: 2_147_483_647,
  },
  {
    field: "account_maintenance_concurrency",
    envName: "KIRO_PROVIDER_ACCOUNT_MAINTENANCE_CONCURRENCY",
    min: 1,
    max: 32,
  },
  {
    field: "usage_refresh_interval_ms",
    envName: "KIRO_PROVIDER_USAGE_REFRESH_INTERVAL_MS",
    min: 1_000,
    max: 2_147_483_647,
  },
  {
    field: "request_timeout_ms",
    envName: "KIRO_PROVIDER_REQUEST_TIMEOUT_MS",
    min: 1,
    max: 2_147_483_647,
  },
  {
    field: "stream_idle_timeout_ms",
    envName: "KIRO_PROVIDER_STREAM_IDLE_TIMEOUT_MS",
    min: 1,
    max: 2_147_483_647,
  },
  {
    field: "stream_max_attempts",
    envName: "KIRO_PROVIDER_STREAM_MAX_ATTEMPTS",
    min: 1,
    max: 10,
  },
  {
    field: "overage_threshold",
    envName: "KIRO_PROVIDER_OVERAGE_THRESHOLD",
    min: 0,
    max: 1_000_000,
  },
  {
    field: "session_affinity_ttl_ms",
    envName: "KIRO_PROVIDER_SESSION_AFFINITY_TTL_MS",
    min: 1,
    max: 2_147_483_647,
  },
  {
    field: "session_affinity_max_entries",
    envName: "KIRO_PROVIDER_SESSION_AFFINITY_MAX_ENTRIES",
    min: 1,
    max: 1_000_000,
  },
  {
    field: "reasoning_replay_ttl_ms",
    envName: "KIRO_PROVIDER_REASONING_REPLAY_TTL_MS",
    min: 1,
    max: 2_147_483_647,
  },
  {
    field: "reasoning_replay_max_entries",
    envName: "KIRO_PROVIDER_REASONING_REPLAY_MAX_ENTRIES",
    min: 1,
    max: 1_000_000,
  },
];

describe("ConfigSchema numeric bounds", () => {
  test("covers every integer environment variable", () => {
    const integerEnvFields = CONFIG_ENV_VARIABLES.filter(({ kind }) => kind === "integer").map(
      ({ field }) => field as string,
    );
    expect([...integerEnvFields].sort()).toEqual(numericFields.map(({ field }) => field).sort());
  });

  test.each(numericFields)("accepts the closed range for $field", ({ field, min, max }) => {
    for (const value of [min, max, Math.floor((min + max) / 2)]) {
      const parsed = ConfigSchema.safeParse({
        api_keys: ["sk-test"],
        [field]: value,
      });
      expect(parsed.success).toBe(true);
    }
  });

  test.each(numericFields)(
    "rejects below-minimum, negative, fractional, and over-maximum $field",
    ({ field, min, max }) => {
      const rejected = [min - 1, -1, min + 0.5, max + 1, Number.NaN, Number.POSITIVE_INFINITY];
      for (const value of rejected) {
        const parsed = ConfigSchema.safeParse({
          api_keys: ["sk-test"],
          [field]: value,
        });
        expect(parsed.success).toBe(false);
      }
    },
  );

  test("rejects zero for every field whose minimum is at least one", () => {
    for (const { field, min } of numericFields) {
      if (min < 1) continue;
      expect(ConfigSchema.safeParse({ api_keys: ["sk-test"], [field]: 0 }).success).toBe(false);
    }
  });

  test("accepts zero retries but rejects negative retries", () => {
    expect(
      ConfigSchema.safeParse({ api_keys: ["sk-test"], rate_limit_max_retries: 0 }).success,
    ).toBe(true);
    expect(
      ConfigSchema.safeParse({ api_keys: ["sk-test"], rate_limit_max_retries: -1 }).success,
    ).toBe(false);
  });

  test("rejects the port values the audit found accepted and keeps 0 as ephemeral", () => {
    for (const port of [70_000, 8787.5, -1, 65_536]) {
      expect(ConfigSchema.safeParse({ api_keys: ["sk-test"], port }).success).toBe(false);
    }
    expect(ConfigSchema.parse({ api_keys: ["sk-test"], port: 0 }).port).toBe(0);
  });
});

describe("ConfigSchema enums and strings", () => {
  test("accepts every supported region and rejects unknown regions", () => {
    expect(
      ConfigSchema.parse({ api_keys: ["sk-test"], default_region: "eu-west-1" }).default_region,
    ).toBe("eu-west-1");
    for (const region of ["moon-1", "US-EAST-1", "", " us-east-1"]) {
      expect(
        ConfigSchema.safeParse({ api_keys: ["sk-test"], default_region: region }).success,
      ).toBe(false);
    }
  });

  test("narrows log_level to debug, info, warn, error", () => {
    for (const level of ["debug", "info", "warn", "error"] as const) {
      expect(ConfigSchema.parse({ api_keys: ["sk-test"], log_level: level }).log_level).toBe(level);
    }
    for (const level of ["verbose", "INFO", "trace", ""]) {
      expect(ConfigSchema.safeParse({ api_keys: ["sk-test"], log_level: level }).success).toBe(
        false,
      );
    }
  });

  test("rejects an empty or whitespace host", () => {
    for (const host of ["", "   "]) {
      expect(ConfigSchema.safeParse({ api_keys: ["sk-test"], host }).success).toBe(false);
    }
    expect(ConfigSchema.parse({ api_keys: ["sk-test"], host: " 0.0.0.0 " }).host).toBe("0.0.0.0");
  });
});

describe("loadConfig environment parsing", () => {
  test("treats an empty environment variable as unset for every field", () => {
    const env: Record<string, string> = { KIRO_PROVIDER_API_KEYS: "sk-test" };
    for (const { env: envName } of CONFIG_ENV_VARIABLES) {
      if (envName === "KIRO_PROVIDER_API_KEYS") continue;
      env[envName] = "";
    }
    env.KIRO_PROVIDER_PORT = "   ";

    const config = loadConfig({
      configPath: createConfigFile({ port: 9100, log_level: "warn" }),
      env,
    });

    expect(config.port).toBe(9100);
    expect(config.log_level).toBe("warn");
    expect(config.max_request_body_bytes).toBe(10_485_760);
    expect(config.max_request_iterations).toBe(20);
  });

  test("an empty api_keys environment variable leaves the file keys in place", () => {
    const config = loadConfig({
      configPath: createConfigFile({ api_keys: ["file-key"] }),
      env: { KIRO_PROVIDER_API_KEYS: "" },
    });

    expect(config.api_keys).toEqual(["file-key"]);
  });

  test.each([
    { value: "0x1f90", reason: "hexadecimal" },
    { value: "8787.5", reason: "fractional" },
    { value: "1e3", reason: "exponent" },
    { value: "8787abc", reason: "trailing garbage" },
    { value: "Infinity", reason: "infinity" },
    { value: "NaN", reason: "NaN" },
  ])("rejects the $reason port $value naming the variable", ({ value }) => {
    let caught: unknown;
    try {
      loadConfig({
        configPath: createConfigFile({}),
        env: { KIRO_PROVIDER_API_KEYS: "sk-test", KIRO_PROVIDER_PORT: value },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigLoadError);
    expect((caught as Error).message).toContain("KIRO_PROVIDER_PORT");
    expect((caught as Error).message).toContain(value);
  });

  test("rejects integers beyond the safe range", () => {
    expect(() =>
      loadConfig({
        configPath: createConfigFile({}),
        env: {
          KIRO_PROVIDER_API_KEYS: "sk-test",
          KIRO_PROVIDER_MAX_REQUEST_BODY_BYTES: "99999999999999999999",
        },
      }),
    ).toThrow(/KIRO_PROVIDER_MAX_REQUEST_BODY_BYTES/);
  });

  test("accepts surrounding whitespace and an explicit sign on integers", () => {
    const config = loadConfig({
      configPath: createConfigFile({}),
      env: {
        KIRO_PROVIDER_API_KEYS: "sk-test",
        KIRO_PROVIDER_PORT: " 9123 ",
        KIRO_PROVIDER_RATE_LIMIT_MAX_RETRIES: "+2",
      },
    });

    expect(config.port).toBe(9123);
    expect(config.rate_limit_max_retries).toBe(2);
  });

  test.each([
    { envName: "KIRO_PROVIDER_PORT", value: "70000", field: "port" },
    {
      envName: "KIRO_PROVIDER_MAX_REQUEST_ITERATIONS",
      value: "0",
      field: "max_request_iterations",
    },
    {
      envName: "KIRO_PROVIDER_MAX_REQUEST_BODY_BYTES",
      value: "0",
      field: "max_request_body_bytes",
    },
    {
      envName: "KIRO_PROVIDER_TOKEN_EXPIRY_BUFFER_MS",
      value: "-5",
      field: "token_expiry_buffer_ms",
    },
    {
      envName: "KIRO_PROVIDER_RATE_LIMIT_RETRY_DELAY_MS",
      value: "0",
      field: "rate_limit_retry_delay_ms",
    },
  ])(
    "reports out-of-range $envName=$value with the field and variable",
    ({ envName, value, field }) => {
      let message = "";
      try {
        loadConfig({
          configPath: createConfigFile({}),
          env: { KIRO_PROVIDER_API_KEYS: "sk-test", [envName]: value },
        });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain(field);
      expect(message).toContain(`(from ${envName})`);
    },
  );

  test("rejects an unsupported region and log level from the environment", () => {
    expect(() =>
      loadConfig({
        configPath: createConfigFile({}),
        env: {
          KIRO_PROVIDER_API_KEYS: "sk-test",
          KIRO_PROVIDER_DEFAULT_REGION: "moon-1",
        },
      }),
    ).toThrow(/default_region.*KIRO_PROVIDER_DEFAULT_REGION/);
    expect(() =>
      loadConfig({
        configPath: createConfigFile({}),
        env: {
          KIRO_PROVIDER_API_KEYS: "sk-test",
          KIRO_PROVIDER_LOG_LEVEL: "verbose",
        },
      }),
    ).toThrow(/log_level.*KIRO_PROVIDER_LOG_LEVEL/);
  });

  test("trims string environment values before validation", () => {
    const config = loadConfig({
      configPath: createConfigFile({}),
      env: {
        KIRO_PROVIDER_API_KEYS: "sk-test",
        KIRO_PROVIDER_DEFAULT_REGION: " eu-west-1 ",
        KIRO_PROVIDER_LOG_LEVEL: " error ",
      },
    });

    expect(config.default_region).toBe("eu-west-1");
    expect(config.log_level).toBe("error");
  });
});

describe("loadConfig unknown keys", () => {
  test("rejects an unknown key and suggests the closest field", () => {
    let caught: unknown;
    try {
      loadConfig({
        configPath: createConfigFile({
          api_keys: ["sk-test"],
          enable_legacy_chat_completion: true,
        }),
        env: {},
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigLoadError);
    expect((caught as Error).message).toContain("unknown key");
    expect((caught as Error).message).toContain('"enable_legacy_chat_completion"');
    expect((caught as Error).message).toContain('did you mean "enable_legacy_chat_completions"?');
  });

  test("lists every unknown key and omits a suggestion for unrelated names", () => {
    let message = "";
    try {
      loadConfig({
        configPath: createConfigFile({
          api_keys: ["sk-test"],
          prot: 8787,
          completely_unrelated_setting_name: 1,
        }),
        env: {},
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("unknown keys");
    expect(message).toContain('"prot" (did you mean "port"?)');
    expect(message).toContain('"completely_unrelated_setting_name"');
    expect(message).not.toContain('"completely_unrelated_setting_name" (did you mean');
  });

  test("still accepts a file that uses only known keys", () => {
    const config = loadConfig({
      configPath: createConfigFile({
        api_keys: ["sk-test"],
        enable_legacy_chat_completions: true,
      }),
      env: {},
    });

    expect(config.enable_legacy_chat_completions).toBe(true);
  });
});

describe("loadConfig file permissions", () => {
  test("warns once when the config file is group or world readable", () => {
    const configPath = createConfigFile({ api_keys: ["sk-test"] }, 0o644);
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      loadConfig({ configPath, env: {}, platform: "linux" });

      const warnings = errorSpy.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .filter((entry) => entry.event === "config_file_permissions_loose");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        level: "warn",
        path: configPath,
        mode: "0644",
        recommended_mode: "0600",
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("does not warn for a 0600 file or on win32", () => {
    const strictPath = createConfigFile({ api_keys: ["sk-test"] }, 0o600);
    const loosePath = createConfigFile({ api_keys: ["sk-test"] }, 0o644);
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      loadConfig({ configPath: strictPath, env: {}, platform: "linux" });
      loadConfig({ configPath: loosePath, env: {}, platform: "win32" });

      const warnings = errorSpy.mock.calls.filter(([line]) =>
        String(line).includes("config_file_permissions_loose"),
      );
      expect(warnings).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("platform config paths", () => {
  test("uses XDG_CONFIG_HOME or ~/.config on POSIX", () => {
    expect(
      platformConfigRoot({
        platform: "linux",
        env: { XDG_CONFIG_HOME: "/xdg" },
        homeDirectory: "/home/u",
      }),
    ).toBe("/xdg");
    expect(platformConfigRoot({ platform: "darwin", env: {}, homeDirectory: "/Users/u" })).toBe(
      "/Users/u/.config",
    );
    expect(
      platformConfigRoot({
        platform: "linux",
        env: { XDG_CONFIG_HOME: "  " },
        homeDirectory: "/home/u",
      }),
    ).toBe("/home/u/.config");
  });

  test("uses APPDATA or the roaming profile on win32", () => {
    expect(
      platformConfigRoot({
        platform: "win32",
        env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming", XDG_CONFIG_HOME: "/ignored" },
        homeDirectory: "C:\\Users\\u",
      }),
    ).toBe("C:\\Users\\u\\AppData\\Roaming");
    expect(platformConfigRoot({ platform: "win32", env: {}, homeDirectory: "/home/u" })).toBe(
      join("/home/u", "AppData", "Roaming"),
    );
    expect(legacyConfigRoot({ env: {}, homeDirectory: "/home/u" })).toBe("/home/u/.config");
  });

  test("prefers the APPDATA config on win32 but falls back to the legacy ~/.config file", () => {
    const options = {
      platform: "win32",
      env: { APPDATA: "/appdata" },
      homeDirectory: "/home/u",
    };
    const preferred = join("/appdata", "kiro-provider", "config.json");
    const legacy = join("/home/u", ".config", "kiro-provider", "config.json");

    expect(defaultConfigPath({ ...options, exists: () => false })).toBe(preferred);
    expect(defaultConfigPath({ ...options, exists: (path) => path === legacy })).toBe(legacy);
    expect(defaultConfigPath({ ...options, exists: () => true })).toBe(preferred);
  });

  test("never consults the legacy fallback on POSIX", () => {
    let probed = 0;
    expect(
      defaultConfigPath({
        platform: "linux",
        env: {},
        homeDirectory: "/home/u",
        exists: () => {
          probed += 1;
          return false;
        },
      }),
    ).toBe("/home/u/.config/kiro-provider/config.json");
    expect(probed).toBe(0);
  });

  test("loadConfig resolves the platform default path from the injected environment", () => {
    const directory = mkdtempSync(join(tmpdir(), "kiro-provider-xdg-"));
    temporaryDirectories.push(directory);
    const configDirectory = join(directory, "kiro-provider");
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(
      join(configDirectory, "config.json"),
      JSON.stringify({ api_keys: ["xdg-key"], port: 9200 }),
      { encoding: "utf8", mode: 0o600 },
    );

    const config = loadConfig({
      env: { XDG_CONFIG_HOME: directory },
      platform: "linux",
    });

    expect(config.api_keys).toEqual(["xdg-key"]);
    expect(config.port).toBe(9200);
  });
});
