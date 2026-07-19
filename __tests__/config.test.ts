import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/loader.js";
import { ConfigSchema } from "../src/config/schema.js";

const temporaryDirectories: string[] = [];

function createConfigFile(config: unknown): string {
	const directory = mkdtempSync(join(tmpdir(), "kiro-provider-config-"));
	temporaryDirectories.push(directory);
	const configPath = join(directory, "config.json");
	writeFileSync(configPath, JSON.stringify(config), "utf8");
	return configPath;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("ConfigSchema", () => {
	test("applies defaults when only api_keys is provided", () => {
		const config = ConfigSchema.parse({ api_keys: ["sk-test"] });

		expect(config).toEqual({
			host: "127.0.0.1",
			port: 8787,
			api_keys: ["sk-test"],
			proxy_url: null,
			default_region: "us-east-1",
			account_selection_strategy: "lowest-usage",
			rate_limit_max_retries: 3,
			rate_limit_retry_delay_ms: 5000,
			max_request_iterations: 20,
			request_timeout_ms: 120000,
			stream_idle_timeout_ms: 60000,
			max_request_body_bytes: 10485760,
			token_expiry_buffer_ms: 300000,
			effort: null,
			auto_effort_mapping: true,
			log_level: "info",
		});
	});

	test.each([
		"http://127.0.0.1:1080",
		"https://proxy:8443",
		"HTTP://127.0.0.1:1080",
		"HTTPS://p:8443",
	])(
		"accepts the HTTP(S) proxy URL %s",
		(proxyUrl) => {
			const config = ConfigSchema.parse({ api_keys: ["sk-test"], proxy_url: proxyUrl });

			expect(config.proxy_url).toBe(proxyUrl);
		},
	);

	test.each([
		{ label: "omitted", input: {} },
		{ label: "null", input: { proxy_url: null } },
		{ label: "an empty string", input: { proxy_url: "" } },
		{ label: "whitespace", input: { proxy_url: "   " } },
	])("normalizes $label proxy_url to null", ({ input }) => {
		const config = ConfigSchema.parse({ api_keys: ["sk-test"], ...input });

		expect(config.proxy_url).toBeNull();
	});

	test.each(["abc", "ftp://x"])(
		"rejects the invalid proxy URL %s",
		(proxyUrl) => {
			expect(() =>
				ConfigSchema.parse({ api_keys: ["sk-test"], proxy_url: proxyUrl }),
			).toThrow(/proxy_url|http\(s\)/i);
		},
	);

	test.each([
		{ label: "an empty array", apiKeys: [] },
		{ label: "an empty string", apiKeys: [""] },
		{ label: "a whitespace-only string", apiKeys: [" "] },
	])("rejects api_keys containing $label", ({ apiKeys }) => {
		expect(() => ConfigSchema.parse({ api_keys: apiKeys })).toThrow(/api_keys/i);
	});

	test("accepts a valid effort", () => {
		const config = ConfigSchema.parse({ api_keys: ["sk-test"], effort: "high" });

		expect(config.effort).toBe("high");
	});

	test("accepts null effort", () => {
		const config = ConfigSchema.parse({ api_keys: ["sk-test"], effort: null });

		expect(config.effort).toBeNull();
	});

	test("rejects an invalid effort", () => {
		expect(() =>
			loadConfig({
				configPath: createConfigFile({ api_keys: ["sk-test"], effort: "bogus" }),
				env: {},
			}),
		).toThrow(/effort/i);
	});
});

describe("loadConfig", () => {
	test("wraps malformed JSON with the config path and parser failure", () => {
		const directory = mkdtempSync(join(tmpdir(), "kiro-provider-malformed-config-"));
		temporaryDirectories.push(directory);
		const configPath = join(directory, "config.json");
		writeFileSync(configPath, "{", "utf8");

		expect(() => loadConfig({ configPath, env: {} })).toThrow(
			new RegExp(
				`Unable to read configuration file ${configPath.replaceAll("/", "\\/")}: .*JSON.*(?:error|Expected)`,
				"i",
			),
		);
	});

	test("loads schema defaults from a missing config file when the environment supplies the required key", () => {
		const missingConfigPath = join(
			mkdtempSync(join(tmpdir(), "kiro-provider-missing-config-")),
			"missing.json",
		);
		temporaryDirectories.push(join(missingConfigPath, ".."));

		const config = loadConfig({
			configPath: missingConfigPath,
			env: { KIRO_PROVIDER_API_KEYS: "sk-env" },
		});

		expect(config).toMatchObject({
			host: "127.0.0.1",
			port: 8787,
			api_keys: ["sk-env"],
			proxy_url: null,
			default_region: "us-east-1",
			account_selection_strategy: "lowest-usage",
		});
	});

	test("lets environment values override file values", () => {
		const configPath = createConfigFile({
			api_keys: ["file-key"],
			host: "file.example",
			port: 9000,
		});

		const config = loadConfig({
			configPath,
			env: {
				KIRO_PROVIDER_API_KEYS: "env-key",
				KIRO_PROVIDER_HOST: "env.example",
				KIRO_PROVIDER_PORT: "9001",
			},
		});

		expect(config.api_keys).toEqual(["env-key"]);
		expect(config.host).toBe("env.example");
		expect(config.port).toBe(9001);
	});

	test("rejects an environment api_keys list containing only empty entries", () => {
		expect(() =>
			loadConfig({
				configPath: createConfigFile({ api_keys: ["file-key"] }),
				env: { KIRO_PROVIDER_API_KEYS: " ,, " },
			}),
		).toThrow(/api_keys/i);
	});

	test("trims and removes empty environment api_keys entries", () => {
		const config = loadConfig({
			configPath: createConfigFile({}),
			env: { KIRO_PROVIDER_API_KEYS: "sk-a, sk-b " },
		});

		expect(config.api_keys).toEqual(["sk-a", "sk-b"]);
	});

	test("coerces number and boolean environment values", () => {
		const config = loadConfig({
			configPath: createConfigFile({}),
			env: {
				KIRO_PROVIDER_API_KEYS: "sk-test",
				KIRO_PROVIDER_PORT: "9123",
				KIRO_PROVIDER_RATE_LIMIT_MAX_RETRIES: "7",
				KIRO_PROVIDER_AUTO_EFFORT_MAPPING: "false",
			},
		});

		expect(config.port).toBe(9123);
		expect(config.rate_limit_max_retries).toBe(7);
		expect(config.auto_effort_mapping).toBe(false);
	});

	test("maps every string, number, list, proxy, and boolean environment field", () => {
		const config = loadConfig({
			configPath: createConfigFile({}),
			env: {
				KIRO_PROVIDER_HOST: "env.example",
				KIRO_PROVIDER_PORT: "9123",
				KIRO_PROVIDER_API_KEYS: "sk-a,sk-b",
				KIRO_PROVIDER_PROXY_URL: " https://proxy.example:8443 ",
				KIRO_PROVIDER_DEFAULT_REGION: "eu-west-1",
				KIRO_PROVIDER_ACCOUNT_SELECTION_STRATEGY: "round-robin",
				KIRO_PROVIDER_RATE_LIMIT_MAX_RETRIES: "8",
				KIRO_PROVIDER_RATE_LIMIT_RETRY_DELAY_MS: "6000",
				KIRO_PROVIDER_MAX_REQUEST_ITERATIONS: "30",
				KIRO_PROVIDER_REQUEST_TIMEOUT_MS: "130000",
				KIRO_PROVIDER_STREAM_IDLE_TIMEOUT_MS: "70000",
				KIRO_PROVIDER_MAX_REQUEST_BODY_BYTES: "2097152",
				KIRO_PROVIDER_TOKEN_EXPIRY_BUFFER_MS: "240000",
				KIRO_PROVIDER_EFFORT: "high",
				KIRO_PROVIDER_AUTO_EFFORT_MAPPING: "0",
				KIRO_PROVIDER_LOG_LEVEL: "debug",
				KIRO_PROVIDER_TEST_UPSTREAM: "http://127.0.0.1:43127/mock",
			},
		});

		expect(config).toEqual({
			host: "env.example",
			port: 9123,
			api_keys: ["sk-a", "sk-b"],
			proxy_url: "https://proxy.example:8443",
			default_region: "eu-west-1",
			account_selection_strategy: "round-robin",
			rate_limit_max_retries: 8,
			rate_limit_retry_delay_ms: 6000,
			max_request_iterations: 30,
			request_timeout_ms: 130000,
			stream_idle_timeout_ms: 70000,
			max_request_body_bytes: 2097152,
			token_expiry_buffer_ms: 240000,
			effort: "high",
			auto_effort_mapping: false,
			log_level: "debug",
			test_upstream_endpoint: "http://127.0.0.1:43127/mock",
		});
	});

	test("accepts true boolean environment spellings and rejects unrecognized values", () => {
		for (const value of ["true", "1"]) {
			const config = loadConfig({
				configPath: createConfigFile({}),
				env: {
					KIRO_PROVIDER_API_KEYS: "sk-test",
					KIRO_PROVIDER_AUTO_EFFORT_MAPPING: value,
				},
			});
			expect(config.auto_effort_mapping).toBe(true);
		}
		expect(() =>
			loadConfig({
				configPath: createConfigFile({}),
				env: {
					KIRO_PROVIDER_API_KEYS: "sk-test",
					KIRO_PROVIDER_AUTO_EFFORT_MAPPING: "sometimes",
				},
			}),
		).toThrow(/auto_effort_mapping/i);
	});

	test("maps the test upstream environment value to the optional endpoint", () => {
		const config = loadConfig({
			configPath: createConfigFile({}),
			env: {
				KIRO_PROVIDER_API_KEYS: "sk-test",
				KIRO_PROVIDER_TEST_UPSTREAM: "http://127.0.0.1:43127/mock",
			},
		});

		expect(config.test_upstream_endpoint).toBe("http://127.0.0.1:43127/mock");
	});

	test("maps the proxy URL environment value", () => {
		const config = loadConfig({
			configPath: createConfigFile({}),
			env: {
				KIRO_PROVIDER_API_KEYS: "sk-test",
				KIRO_PROVIDER_PROXY_URL: "  https://proxy:8443  ",
			},
		});

		expect(config.proxy_url).toBe("https://proxy:8443");
	});

	test("lets the proxy URL environment value override the file value", () => {
		const config = loadConfig({
			configPath: createConfigFile({
				api_keys: ["file-key"],
				proxy_url: "http://file-proxy:8080",
			}),
			env: { KIRO_PROVIDER_PROXY_URL: "https://env-proxy:8443" },
		});

		expect(config.proxy_url).toBe("https://env-proxy:8443");
	});

	test("lets an empty proxy URL environment value clear the file value", () => {
		const config = loadConfig({
			configPath: createConfigFile({
				api_keys: ["file-key"],
				proxy_url: "http://file-proxy:8080",
			}),
			env: { KIRO_PROVIDER_PROXY_URL: "" },
		});

		expect(config.proxy_url).toBeNull();
	});

	test("keeps the file proxy URL when the environment value is unset", () => {
		const config = loadConfig({
			configPath: createConfigFile({
				api_keys: ["file-key"],
				proxy_url: "http://file-proxy:8080",
			}),
			env: {},
		});

		expect(config.proxy_url).toBe("http://file-proxy:8080");
	});

	test("applies explicit overrides after environment values", () => {
		const config = loadConfig({
			configPath: createConfigFile({
				api_keys: ["file-key"],
				proxy_url: "http://file-proxy:8080",
			}),
			env: { KIRO_PROVIDER_PROXY_URL: "https://env-proxy:8443" },
			overrides: { proxy_url: "http://cli-proxy:1080" },
		});

		expect(config.proxy_url).toBe("http://cli-proxy:1080");
	});

	test("applies overrides after environment and file values for the same field", () => {
		const config = loadConfig({
			configPath: createConfigFile({
				api_keys: ["file-key"],
				host: "file.example",
				port: 9000,
			}),
			env: {
				KIRO_PROVIDER_API_KEYS: "env-key",
				KIRO_PROVIDER_HOST: "env.example",
				KIRO_PROVIDER_PORT: "9001",
			},
			overrides: {
				api_keys: ["override-key"],
				host: "override.example",
				port: 9002,
				proxy_url: "",
			},
		});

		expect(config.api_keys).toEqual(["override-key"]);
		expect(config.host).toBe("override.example");
		expect(config.port).toBe(9002);
		expect(config.proxy_url).toBeNull();
	});
});
