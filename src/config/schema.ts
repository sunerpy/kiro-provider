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

export const ConfigSchema = z.object({
	host: z.string().default("127.0.0.1"),
	port: z.number().default(8787),
	api_keys: ApiKeysSchema,
	proxy_url: ProxyUrlSchema,
	default_region: z.string().default("us-east-1"),
	account_selection_strategy: z
		.enum(["sticky", "round-robin", "lowest-usage"])
		.default("lowest-usage"),
	rate_limit_max_retries: z.number().default(3),
	rate_limit_retry_delay_ms: z.number().default(5000),
	max_request_iterations: z.number().default(20),
	request_timeout_ms: z.number().default(120000),
	stream_idle_timeout_ms: z.number().default(60000),
	max_request_body_bytes: z.number().default(10485760),
	token_expiry_buffer_ms: z.number().default(300000),
	effort: EffortSchema.nullable().default(null),
	auto_effort_mapping: z.boolean().default(true),
	log_level: z.string().default("info"),
	test_upstream_endpoint: z.string().url().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
