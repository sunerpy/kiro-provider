import { z } from "zod";
import { EffortSchema } from "../kiro/regions.js";

export const ApiKeysSchema = z
	.array(z.string())
	.transform((apiKeys) =>
		apiKeys
			.map((apiKey) => apiKey.trim())
			.filter((apiKey) => apiKey.length > 0),
	)
	.refine((apiKeys) => apiKeys.length > 0, {
		message: "api_keys must contain at least one non-empty key",
	});

const ProxyUrlSchema = z
	.preprocess(
		(value) =>
			typeof value === "string" && value.trim().length === 0 ? null : value,
		z
			.string()
			.trim()
			.refine((url) => URL.canParse(url), {
				message: "proxy_url must be a valid URL",
			})
			.refine(
				(url) => {
					if (!URL.canParse(url)) return false;
					const protocol = new URL(url).protocol;
					return protocol === "http:" || protocol === "https:";
				},
				{ message: "proxy_url must be http(s)" },
			)
			.nullable(),
	)
	.default(null);

const OptionalPathSchema = z
	.preprocess(
		(value) =>
			typeof value === "string" && value.trim().length === 0 ? null : value,
		z.string().trim().min(1).nullable(),
	)
	.default(null);

export const ConfigSchema = z.object({
	host: z.string().default("127.0.0.1"),
	port: z.number().default(8787),
	api_keys: ApiKeysSchema,
	enable_legacy_chat_completions: z.boolean().default(false),
	protocol_projection_mode: z
		.enum(["safe", "legacy-user-prefix"])
		.default("safe"),
	session_affinity_mode: z
		.enum(["explicit-only", "legacy-initial-input"])
		.default("explicit-only"),
	proxy_url: ProxyUrlSchema,
	sdk_http_keep_alive: z.boolean().default(false),
	enforce_single_instance: z.boolean().default(true),
	instance_lock_path: OptionalPathSchema,
	runtime_endpoint_mode: z
		.enum(["legacy-q", "kiro-runtime"])
		.default("kiro-runtime"),
	dynamic_model_catalog: z.boolean().default(true),
	model_catalog_ttl_ms: z
		.number()
		.int()
		.min(1)
		.max(2_147_483_647)
		.default(900_000),
	model_catalog_stale_ttl_ms: z
		.number()
		.int()
		.min(1)
		.max(2_147_483_647)
		.default(86_400_000),
	model_catalog_request_timeout_ms: z
		.number()
		.int()
		.min(1)
		.max(2_147_483_647)
		.default(10_000),
		auth_source: z.enum(["opencode-shared", "local"]).default("local"),
	opencode_auth_db_path: OptionalPathSchema,
	default_region: z.string().default("us-east-1"),
	account_selection_strategy: z
		.enum(["sticky", "round-robin", "lowest-usage"])
		.default("lowest-usage"),
	rate_limit_max_retries: z.number().default(3),
	rate_limit_retry_delay_ms: z.number().default(5000),
	quota_recheck_interval_ms: z
		.number()
		.int()
		.min(1)
		.max(2_147_483_647)
		.default(900_000),
		quota_recheck_timeout_ms: z
		.number()
		.int()
		.min(1)
			.max(2_147_483_647)
			.default(10_000),
		quota_recheck_concurrency: z.number().int().min(1).max(32).default(4),
		account_maintenance_enabled: z.boolean().default(true),
		account_maintenance_interval_ms: z
			.number()
			.int()
			.min(1_000)
			.max(2_147_483_647)
			.default(60_000),
		account_maintenance_timeout_ms: z
			.number()
			.int()
			.min(1_000)
			.max(2_147_483_647)
			.default(120_000),
		account_maintenance_concurrency: z
			.number()
			.int()
			.min(1)
			.max(32)
			.default(4),
		usage_refresh_interval_ms: z
			.number()
			.int()
			.min(1_000)
			.max(2_147_483_647)
			.default(900_000),
		max_request_iterations: z.number().default(20),
	request_timeout_ms: z
		.number()
		.int()
		.min(1)
		.max(2_147_483_647)
		.default(120000),
	stream_idle_timeout_ms: z
		.number()
		.int()
		.min(1)
		.max(2_147_483_647)
		.default(60000),
	max_request_body_bytes: z.number().default(10485760),
	token_expiry_buffer_ms: z.number().default(300000),
	session_affinity_ttl_ms: z
		.number()
		.int()
		.min(1)
		.max(2_147_483_647)
		.default(86_400_000),
	session_affinity_max_entries: z.number().int().min(1).max(1_000_000).default(10_000),
	reasoning_replay_key_path: OptionalPathSchema,
	reasoning_replay_keys: z.array(z.string().trim().min(1)).default([]),
	reasoning_replay_ttl_ms: z
		.number()
		.int()
		.min(1)
		.max(2_147_483_647)
		.default(86_400_000),
	reasoning_replay_max_entries: z
		.number()
		.int()
		.min(1)
		.max(1_000_000)
		.default(10_000),
	effort: EffortSchema.nullable().default(null),
	auto_effort_mapping: z.boolean().default(true),
	log_level: z.string().default("info"),
	test_upstream_endpoint: z.string().url().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
