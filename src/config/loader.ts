import { existsSync, readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { auditLog } from "../core/audit-log.js";
import { defaultConfigPath } from "./paths.js";
import { type Config, ConfigSchema } from "./schema.js";

export const OPENCODE_SHARED_REMOVED_MESSAGE =
  'auth_source "opencode-shared" was removed in kiro-provider 0.7.0. Copy the OpenCode accounts once with "kiro-provider accounts import [--from <path>]", then set auth_source to "local" or delete the key; the provider-owned store (~/.config/kiro-provider/accounts.db) is the only authentication authority.';

/**
 * Post-parse migration checks for settings that no longer select behavior.
 * The removed shared mode fails fast with an actionable message instead of a
 * generic enum error; the deprecated database path only warns.
 */
export function applyRemovedAuthSourceMigration(config: Config): Config {
  if (config.auth_source === "opencode-shared") {
    throw new ConfigLoadError(OPENCODE_SHARED_REMOVED_MESSAGE);
  }
  if (config.opencode_auth_db_path !== null) {
    auditLog("warn", "config_opencode_auth_db_path_deprecated", {
      hint: "opencode_auth_db_path is ignored since 0.7.0 and will be removed; pass --from to kiro-provider accounts import instead",
    });
  }
  return config;
}

export type LoadConfigOptions = {
  readonly configPath?: string;
  readonly env?: Record<string, string | undefined>;
  readonly overrides?: Partial<Config>;
  /** Overrides `process.platform`; used for config-path and permission rules. */
  readonly platform?: NodeJS.Platform | string;
};

export class ConfigLoadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigLoadError";
  }
}

const PartialConfigSchema = ConfigSchema.partial().strict();
const CONFIG_FIELDS = Object.keys(ConfigSchema.shape);

type EnvValueKind = "string" | "integer" | "boolean" | "list";

type EnvVariable = {
  readonly env: string;
  readonly field: keyof Config;
  readonly kind: EnvValueKind;
};

/**
 * Every supported `KIRO_PROVIDER_*` environment override. Exported so the
 * documentation parity test can assert that each variable is documented.
 */
export const CONFIG_ENV_VARIABLES: readonly EnvVariable[] = [
  { env: "KIRO_PROVIDER_HOST", field: "host", kind: "string" },
  { env: "KIRO_PROVIDER_PORT", field: "port", kind: "integer" },
  { env: "KIRO_PROVIDER_API_KEYS", field: "api_keys", kind: "list" },
  {
    env: "KIRO_PROVIDER_ENABLE_LEGACY_CHAT_COMPLETIONS",
    field: "enable_legacy_chat_completions",
    kind: "boolean",
  },
  {
    env: "KIRO_PROVIDER_PROTOCOL_PROJECTION_MODE",
    field: "protocol_projection_mode",
    kind: "string",
  },
  {
    env: "KIRO_PROVIDER_SESSION_AFFINITY_MODE",
    field: "session_affinity_mode",
    kind: "string",
  },
  { env: "KIRO_PROVIDER_PROXY_URL", field: "proxy_url", kind: "string" },
  {
    env: "KIRO_PROVIDER_SDK_HTTP_KEEP_ALIVE",
    field: "sdk_http_keep_alive",
    kind: "boolean",
  },
  {
    env: "KIRO_PROVIDER_ENFORCE_SINGLE_INSTANCE",
    field: "enforce_single_instance",
    kind: "boolean",
  },
  {
    env: "KIRO_PROVIDER_INSTANCE_LOCK_PATH",
    field: "instance_lock_path",
    kind: "string",
  },
  {
    env: "KIRO_PROVIDER_RUNTIME_ENDPOINT_MODE",
    field: "runtime_endpoint_mode",
    kind: "string",
  },
  {
    env: "KIRO_PROVIDER_DYNAMIC_MODEL_CATALOG",
    field: "dynamic_model_catalog",
    kind: "boolean",
  },
  {
    env: "KIRO_PROVIDER_MODEL_CATALOG_TTL_MS",
    field: "model_catalog_ttl_ms",
    kind: "integer",
  },
  {
    env: "KIRO_PROVIDER_MODEL_CATALOG_STALE_TTL_MS",
    field: "model_catalog_stale_ttl_ms",
    kind: "integer",
  },
  {
    env: "KIRO_PROVIDER_MODEL_CATALOG_REQUEST_TIMEOUT_MS",
    field: "model_catalog_request_timeout_ms",
    kind: "integer",
  },
  { env: "KIRO_PROVIDER_AUTH_SOURCE", field: "auth_source", kind: "string" },
  {
    env: "KIRO_PROVIDER_OPENCODE_AUTH_DB_PATH",
    field: "opencode_auth_db_path",
    kind: "string",
  },
  {
    env: "KIRO_PROVIDER_DEFAULT_REGION",
    field: "default_region",
    kind: "string",
  },
  {
    env: "KIRO_PROVIDER_ACCOUNT_SELECTION_STRATEGY",
    field: "account_selection_strategy",
    kind: "string",
  },
  {
    env: "KIRO_PROVIDER_RATE_LIMIT_MAX_RETRIES",
    field: "rate_limit_max_retries",
    kind: "integer",
  },
  {
    env: "KIRO_PROVIDER_RATE_LIMIT_RETRY_DELAY_MS",
    field: "rate_limit_retry_delay_ms",
    kind: "integer",
  },
  {
    env: "KIRO_PROVIDER_QUOTA_RECHECK_INTERVAL_MS",
    field: "quota_recheck_interval_ms",
    kind: "integer",
  },
  {
    env: "KIRO_PROVIDER_QUOTA_RECHECK_TIMEOUT_MS",
    field: "quota_recheck_timeout_ms",
    kind: "integer",
  },
  {
    env: "KIRO_PROVIDER_QUOTA_RECHECK_CONCURRENCY",
    field: "quota_recheck_concurrency",
    kind: "integer",
  },
  {
    env: "KIRO_PROVIDER_ACCOUNT_MAINTENANCE_ENABLED",
    field: "account_maintenance_enabled",
    kind: "boolean",
  },
  {
    env: "KIRO_PROVIDER_ACCOUNT_MAINTENANCE_INTERVAL_MS",
    field: "account_maintenance_interval_ms",
    kind: "integer",
  },
  {
    env: "KIRO_PROVIDER_ACCOUNT_MAINTENANCE_TIMEOUT_MS",
    field: "account_maintenance_timeout_ms",
    kind: "integer",
  },
  {
    env: "KIRO_PROVIDER_ACCOUNT_MAINTENANCE_CONCURRENCY",
    field: "account_maintenance_concurrency",
    kind: "integer",
  },
  {
    env: "KIRO_PROVIDER_USAGE_REFRESH_INTERVAL_MS",
    field: "usage_refresh_interval_ms",
    kind: "integer",
  },
  {
    env: "KIRO_PROVIDER_MAX_REQUEST_ITERATIONS",
    field: "max_request_iterations",
    kind: "integer",
  },
  {
    env: "KIRO_PROVIDER_REQUEST_TIMEOUT_MS",
    field: "request_timeout_ms",
    kind: "integer",
  },
  {
    env: "KIRO_PROVIDER_STREAM_IDLE_TIMEOUT_MS",
    field: "stream_idle_timeout_ms",
    kind: "integer",
  },
  {
    env: "KIRO_PROVIDER_MAX_REQUEST_BODY_BYTES",
    field: "max_request_body_bytes",
    kind: "integer",
  },
  {
    env: "KIRO_PROVIDER_TOKEN_EXPIRY_BUFFER_MS",
    field: "token_expiry_buffer_ms",
    kind: "integer",
  },
  {
    env: "KIRO_PROVIDER_SESSION_AFFINITY_TTL_MS",
    field: "session_affinity_ttl_ms",
    kind: "integer",
  },
  {
    env: "KIRO_PROVIDER_SESSION_AFFINITY_MAX_ENTRIES",
    field: "session_affinity_max_entries",
    kind: "integer",
  },
  {
    env: "KIRO_PROVIDER_REASONING_REPLAY_KEY_PATH",
    field: "reasoning_replay_key_path",
    kind: "string",
  },
  {
    env: "KIRO_PROVIDER_REASONING_REPLAY_KEYS",
    field: "reasoning_replay_keys",
    kind: "list",
  },
  {
    env: "KIRO_PROVIDER_REASONING_REPLAY_TTL_MS",
    field: "reasoning_replay_ttl_ms",
    kind: "integer",
  },
  {
    env: "KIRO_PROVIDER_REASONING_REPLAY_MAX_ENTRIES",
    field: "reasoning_replay_max_entries",
    kind: "integer",
  },
  { env: "KIRO_PROVIDER_EFFORT", field: "effort", kind: "string" },
  {
    env: "KIRO_PROVIDER_AUTO_EFFORT_MAPPING",
    field: "auto_effort_mapping",
    kind: "boolean",
  },
  { env: "KIRO_PROVIDER_LOG_LEVEL", field: "log_level", kind: "string" },
  {
    env: "KIRO_PROVIDER_TEST_UPSTREAM",
    field: "test_upstream_endpoint",
    kind: "string",
  },
];

/** An unset or empty/whitespace-only environment variable means "not set". */
function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

const INTEGER_PATTERN = /^[+-]?\d+$/;

function parseIntegerEnv(envName: string, value: string): number {
  const trimmed = value.trim();
  if (!INTEGER_PATTERN.test(trimmed)) {
    throw new ConfigLoadError(
      `Invalid environment variable ${envName}: expected a decimal integer, got "${value}"`,
    );
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new ConfigLoadError(
      `Invalid environment variable ${envName}: integer out of range, got "${value}"`,
    );
  }
  return parsed;
}

function parseBoolean(value: string): boolean | string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  return value;
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

type EnvOverrides = {
  readonly values: Record<string, unknown>;
  /** Field name -> environment variable that supplied it. */
  readonly sources: ReadonlyMap<string, string>;
};

function getEnvOverrides(env: Record<string, string | undefined>): EnvOverrides {
  const values: Record<string, unknown> = {};
  const sources = new Map<string, string>();
  for (const { env: envName, field, kind } of CONFIG_ENV_VARIABLES) {
    const value = emptyToUndefined(env[envName]);
    if (value === undefined) continue;
    switch (kind) {
      case "integer":
        values[field] = parseIntegerEnv(envName, value);
        break;
      case "boolean":
        values[field] = parseBoolean(value);
        break;
      case "list":
        values[field] = parseList(value);
        break;
      case "string":
        values[field] = value.trim();
        break;
    }
    sources.set(field, envName);
  }
  return { values, sources };
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0] as number;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j] as number;
      const left = previous[j - 1] as number;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      previous[j] = Math.min(above + 1, left + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[b.length] as number;
}

function suggestField(unknownKey: string): string | undefined {
  const normalized = unknownKey.toLowerCase();
  let best: { field: string; distance: number } | undefined;
  for (const field of CONFIG_FIELDS) {
    const distance = levenshtein(normalized, field);
    if (best === undefined || distance < best.distance) {
      best = { field, distance };
    }
  }
  if (!best) return undefined;
  const prefixRelated = best.field.startsWith(normalized) || normalized.startsWith(best.field);
  return best.distance <= 3 || prefixRelated ? best.field : undefined;
}

function describeUnknownKeys(keys: readonly string[]): string {
  const described = keys.map((key) => {
    const suggestion = suggestField(key);
    return suggestion ? `"${key}" (did you mean "${suggestion}"?)` : `"${key}"`;
  });
  return `unknown key${keys.length === 1 ? "" : "s"} ${described.join(", ")}`;
}

function formatZodIssue(issue: z.ZodIssue, sources?: ReadonlyMap<string, string>): string {
  if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    return describeUnknownKeys(issue.keys);
  }
  const field = issue.path.length > 0 ? issue.path.join(".") : "config";
  const source = sources?.get(String(issue.path[0]));
  return `${field}: ${issue.message}${source ? ` (from ${source})` : ""}`;
}

function formatZodError(error: z.ZodError, sources?: ReadonlyMap<string, string>): string {
  return error.issues.map((issue) => formatZodIssue(issue, sources)).join(", ");
}

function warnOnLoosePermissions(configPath: string, platform: string): void {
  if (platform === "win32") return;
  let mode: number;
  try {
    mode = statSync(configPath).mode & 0o777;
  } catch {
    return;
  }
  if ((mode & 0o077) === 0) return;
  auditLog("warn", "config_file_permissions_loose", {
    path: configPath,
    mode: `0${mode.toString(8)}`,
    recommended_mode: "0600",
    hint: "the file may contain api_keys; run chmod 600 on it",
  });
}

function readConfigFile(configPath: string, platform: string): Partial<Config> {
  if (!existsSync(configPath)) {
    return {};
  }
  warnOnLoosePermissions(configPath, platform);

  try {
    const rawConfig: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    return PartialConfigSchema.parse(rawConfig);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ConfigLoadError(
        `Invalid configuration file ${configPath}: ${formatZodError(error)}`,
        {
          cause: error,
        },
      );
    }
    if (error instanceof Error) {
      throw new ConfigLoadError(
        `Unable to read configuration file ${configPath}: ${error.message}`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const configPath = options.configPath ?? defaultConfigPath({ env, platform });

  let sources: ReadonlyMap<string, string> | undefined;
  try {
    const fileConfig = readConfigFile(configPath, platform);
    const envOverrides = getEnvOverrides(env);
    sources = new Map(
      [...envOverrides.sources].filter(([field]) => !(field in (options.overrides ?? {}))),
    );
    const config = ConfigSchema.parse({
      ...fileConfig,
      ...envOverrides.values,
      ...options.overrides,
    });
    return applyRemovedAuthSourceMigration(config);
  } catch (error) {
    if (error instanceof ConfigLoadError) {
      throw error;
    }
    if (error instanceof z.ZodError) {
      throw new ConfigLoadError(`Invalid configuration: ${formatZodError(error, sources)}`, {
        cause: error,
      });
    }
    throw error;
  }
}
