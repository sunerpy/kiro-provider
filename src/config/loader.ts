import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Config, ConfigSchema } from "./schema.js";

export type LoadConfigOptions = {
	readonly configPath?: string;
	readonly env?: Record<string, string | undefined>;
	readonly overrides?: Partial<Config>;
};

export class ConfigLoadError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ConfigLoadError";
	}
}

const PartialConfigSchema = ConfigSchema.partial();

function getDefaultConfigPath(env: Record<string, string | undefined>): string {
	const configHome = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
	return join(configHome, "kiro-provider", "config.json");
}

function readConfigFile(configPath: string): Partial<Config> {
	if (!existsSync(configPath)) {
		return {};
	}

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

function getEnvOverrides(
	env: Record<string, string | undefined>,
): Record<string, unknown> {
	const overrides: Record<string, unknown> = {};

	const stringFields = {
		KIRO_PROVIDER_HOST: "host",
		KIRO_PROVIDER_AUTH_SOURCE: "auth_source",
		KIRO_PROVIDER_DEFAULT_REGION: "default_region",
		KIRO_PROVIDER_ACCOUNT_SELECTION_STRATEGY: "account_selection_strategy",
		KIRO_PROVIDER_PROTOCOL_PROJECTION_MODE: "protocol_projection_mode",
		KIRO_PROVIDER_SESSION_AFFINITY_MODE: "session_affinity_mode",
		KIRO_PROVIDER_RUNTIME_ENDPOINT_MODE: "runtime_endpoint_mode",
		KIRO_PROVIDER_INSTANCE_LOCK_PATH: "instance_lock_path",
		KIRO_PROVIDER_EFFORT: "effort",
		KIRO_PROVIDER_LOG_LEVEL: "log_level",
		KIRO_PROVIDER_TEST_UPSTREAM: "test_upstream_endpoint",
	} as const;
	for (const [envName, field] of Object.entries(stringFields)) {
		const value = env[envName];
		if (value !== undefined) {
			overrides[field] = value;
		}
	}

	const numberFields = {
		KIRO_PROVIDER_PORT: "port",
		KIRO_PROVIDER_RATE_LIMIT_MAX_RETRIES: "rate_limit_max_retries",
		KIRO_PROVIDER_RATE_LIMIT_RETRY_DELAY_MS: "rate_limit_retry_delay_ms",
		KIRO_PROVIDER_QUOTA_RECHECK_INTERVAL_MS: "quota_recheck_interval_ms",
			KIRO_PROVIDER_QUOTA_RECHECK_TIMEOUT_MS: "quota_recheck_timeout_ms",
			KIRO_PROVIDER_QUOTA_RECHECK_CONCURRENCY: "quota_recheck_concurrency",
			KIRO_PROVIDER_ACCOUNT_MAINTENANCE_INTERVAL_MS:
				"account_maintenance_interval_ms",
			KIRO_PROVIDER_ACCOUNT_MAINTENANCE_TIMEOUT_MS:
				"account_maintenance_timeout_ms",
			KIRO_PROVIDER_ACCOUNT_MAINTENANCE_CONCURRENCY:
				"account_maintenance_concurrency",
			KIRO_PROVIDER_USAGE_REFRESH_INTERVAL_MS:
				"usage_refresh_interval_ms",
			KIRO_PROVIDER_MAX_REQUEST_ITERATIONS: "max_request_iterations",
		KIRO_PROVIDER_REQUEST_TIMEOUT_MS: "request_timeout_ms",
		KIRO_PROVIDER_STREAM_IDLE_TIMEOUT_MS: "stream_idle_timeout_ms",
		KIRO_PROVIDER_MODEL_CATALOG_TTL_MS: "model_catalog_ttl_ms",
		KIRO_PROVIDER_MODEL_CATALOG_STALE_TTL_MS: "model_catalog_stale_ttl_ms",
		KIRO_PROVIDER_MODEL_CATALOG_REQUEST_TIMEOUT_MS:
			"model_catalog_request_timeout_ms",
			KIRO_PROVIDER_MAX_REQUEST_BODY_BYTES: "max_request_body_bytes",
			KIRO_PROVIDER_TOKEN_EXPIRY_BUFFER_MS: "token_expiry_buffer_ms",
			KIRO_PROVIDER_SESSION_AFFINITY_TTL_MS: "session_affinity_ttl_ms",
		KIRO_PROVIDER_SESSION_AFFINITY_MAX_ENTRIES:
				"session_affinity_max_entries",
		KIRO_PROVIDER_REASONING_REPLAY_TTL_MS: "reasoning_replay_ttl_ms",
		KIRO_PROVIDER_REASONING_REPLAY_MAX_ENTRIES:
			"reasoning_replay_max_entries",
	} as const;
	for (const [envName, field] of Object.entries(numberFields)) {
		const value = env[envName];
		if (value !== undefined) {
			overrides[field] = Number(value);
		}
	}

	const apiKeys = env.KIRO_PROVIDER_API_KEYS;
	if (apiKeys !== undefined) {
		overrides.api_keys = apiKeys.split(",");
	}

	const proxyUrl = env.KIRO_PROVIDER_PROXY_URL;
	if (proxyUrl !== undefined) {
		overrides.proxy_url = proxyUrl.trim();
	}

	const openCodeAuthDbPath = env.KIRO_PROVIDER_OPENCODE_AUTH_DB_PATH;
	if (openCodeAuthDbPath !== undefined) {
		overrides.opencode_auth_db_path = openCodeAuthDbPath.trim();
	}

	const reasoningReplayKeyPath = env.KIRO_PROVIDER_REASONING_REPLAY_KEY_PATH;
	if (reasoningReplayKeyPath !== undefined) {
		overrides.reasoning_replay_key_path = reasoningReplayKeyPath.trim();
	}

	const reasoningReplayKeys = env.KIRO_PROVIDER_REASONING_REPLAY_KEYS;
	if (reasoningReplayKeys !== undefined) {
		overrides.reasoning_replay_keys = reasoningReplayKeys
			.split(",")
			.map((value) => value.trim())
			.filter((value) => value.length > 0);
	}

	const booleanFields = {
		KIRO_PROVIDER_ENABLE_LEGACY_CHAT_COMPLETIONS:
			"enable_legacy_chat_completions",
		KIRO_PROVIDER_SDK_HTTP_KEEP_ALIVE: "sdk_http_keep_alive",
			KIRO_PROVIDER_ENFORCE_SINGLE_INSTANCE: "enforce_single_instance",
			KIRO_PROVIDER_DYNAMIC_MODEL_CATALOG: "dynamic_model_catalog",
			KIRO_PROVIDER_ACCOUNT_MAINTENANCE_ENABLED:
				"account_maintenance_enabled",
			KIRO_PROVIDER_AUTO_EFFORT_MAPPING: "auto_effort_mapping",
	} as const;
	for (const [envName, field] of Object.entries(booleanFields)) {
		const value = env[envName];
		if (value !== undefined) {
			overrides[field] = parseBoolean(value);
		}
	}

	return overrides;
}

function formatZodError(error: z.ZodError): string {
	return error.issues
		.map(
			(issue) =>
				`${issue.path.length > 0 ? issue.path.join(".") : "config"}: ${issue.message}`,
		)
		.join(", ");
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
	const env = options.env ?? process.env;
	const configPath = options.configPath ?? getDefaultConfigPath(env);

	try {
		return ConfigSchema.parse({
			...readConfigFile(configPath),
			...getEnvOverrides(env),
			...options.overrides,
		});
	} catch (error) {
		if (error instanceof ConfigLoadError) {
			throw error;
		}
		if (error instanceof z.ZodError) {
			throw new ConfigLoadError(
				`Invalid configuration: ${formatZodError(error)}`,
				{ cause: error },
			);
		}
		throw error;
	}
}
