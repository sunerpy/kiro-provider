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
		KIRO_PROVIDER_DEFAULT_REGION: "default_region",
		KIRO_PROVIDER_ACCOUNT_SELECTION_STRATEGY: "account_selection_strategy",
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
		KIRO_PROVIDER_MAX_REQUEST_ITERATIONS: "max_request_iterations",
		KIRO_PROVIDER_REQUEST_TIMEOUT_MS: "request_timeout_ms",
		KIRO_PROVIDER_STREAM_IDLE_TIMEOUT_MS: "stream_idle_timeout_ms",
		KIRO_PROVIDER_MAX_REQUEST_BODY_BYTES: "max_request_body_bytes",
		KIRO_PROVIDER_TOKEN_EXPIRY_BUFFER_MS: "token_expiry_buffer_ms",
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

	const autoEffortMapping = env.KIRO_PROVIDER_AUTO_EFFORT_MAPPING;
	if (autoEffortMapping !== undefined) {
		overrides.auto_effort_mapping = parseBoolean(autoEffortMapping);
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
