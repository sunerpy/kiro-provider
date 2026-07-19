import { describe, expect, test } from "bun:test";
import { runLogin } from "../src/cli/login.js";
import {
	CLI_USAGE,
	type CliDependencies,
	main,
	parseCliArgs,
} from "../src/cli/main.js";
import { loadConfig } from "../src/config/loader.js";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import {
	ACCOUNTS_DB_PATH,
	type StoredAccount,
} from "../src/storage/accounts-db.js";

const config = ConfigSchema.parse({ api_keys: ["sk-test"] });

function account(overrides: Partial<StoredAccount> = {}): StoredAccount {
	return {
		id: "account-1",
		email: "dev@example.com",
		authMethod: "idc",
		region: "us-east-1",
		refreshToken: "refresh-secret",
		accessToken: "access-secret",
		expiresAt: Date.now() + 3_600_000,
		rateLimitResetTime: 0,
		isHealthy: true,
		failCount: 0,
		usedCount: 4,
		limitCount: 100,
		generation: 3,
		...overrides,
	};
}

function createHarness(accounts: readonly StoredAccount[] = []): {
	readonly deps: CliDependencies;
	readonly stdout: string[];
	readonly stderr: string[];
	readonly loaded: Array<{
		readonly configPath?: string;
		readonly overrides?: Partial<Config>;
	}>;
	readonly served: Array<{ readonly host: string; readonly port: number }>;
	readonly logins: Array<{
		readonly startUrl?: string;
		readonly region?: string;
	}>;
	readonly imports: Array<{ readonly from?: string }>;
	readonly removed: string[];
	readonly dbPaths: Array<string | undefined>;
} {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const loaded: Array<{
		readonly configPath?: string;
		readonly overrides?: Partial<Config>;
	}> = [];
	const served: Array<{ readonly host: string; readonly port: number }> = [];
	const logins: Array<{
		readonly startUrl?: string;
		readonly region?: string;
	}> = [];
	const removed: string[] = [];
	const imports: Array<{ readonly from?: string }> = [];
	const dbPaths: Array<string | undefined> = [];
	const deps: CliDependencies = {
		loadConfig: (options) => {
			loaded.push(options);
			return ConfigSchema.parse({
				...config,
				...options.overrides,
			});
		},
		startServer: (loadedConfig) => {
			served.push({ host: loadedConfig.host, port: loadedConfig.port });
			return {
				hostname: loadedConfig.host,
				port: loadedConfig.port,
				stop: () => undefined,
			};
		},
		runLogin: async (_loadedConfig, options) => {
			logins.push(options);
		},
		runImportAccounts: (options) => {
			imports.push(options);
		},
		openDb: (...paths: readonly string[]) => {
			dbPaths.push(paths[0]);
			return {
			getAccounts: () => [...accounts],
			insertAccount: (managedAccount) => ({ ...managedAccount, generation: 1 }),
			removeAccount: (id) => {
				removed.push(id);
			},
			close: () => undefined,
			};
		},
		stdout: (message) => stdout.push(message),
		stderr: (message) => stderr.push(message),
	};
	return {
		deps,
		stdout,
		stderr,
		loaded,
		served,
		logins,
		imports,
		removed,
		dbPaths,
	};
}

describe("parseCliArgs", () => {
	test("parses serve overrides", () => {
		const command = parseCliArgs([
			"serve",
			"--config",
			"/tmp/kiro.json",
			"--host",
			"0.0.0.0",
			"--port",
			"9443",
			"--proxy",
			"http://127.0.0.1:1080",
		]);

			expect(command).toEqual({
			kind: "serve",
			configPath: "/tmp/kiro.json",
			host: "0.0.0.0",
			port: 9443,
				proxy: "http://127.0.0.1:1080",
			});
		});

		test("preserves an explicitly empty proxy value", () => {
		const command = parseCliArgs(["serve", "--proxy", ""]);

		expect(command).toEqual({ kind: "serve", proxy: "" });
	});

		test("rejects --proxy without a value", () => {
			expect(() => parseCliArgs(["serve", "--proxy"])).toThrow();
		});

		test("parses login options", () => {
		const command = parseCliArgs([
			"login",
			"--config",
			"/tmp/kiro.json",
			"--start-url",
			"https://acme.awsapps.com/start",
			"--region",
			"eu-west-1",
		]);

		expect(command).toEqual({
			kind: "login",
			configPath: "/tmp/kiro.json",
			startUrl: "https://acme.awsapps.com/start",
			region: "eu-west-1",
		});
	});

	test("parses accounts import options", () => {
		expect(
			parseCliArgs([
				"accounts",
				"import",
				"--from",
				"/tmp/opencode.db",
				"--config",
				"/tmp/config.json",
			]),
		).toEqual({
			kind: "accounts-import",
			from: "/tmp/opencode.db",
			configPath: "/tmp/config.json",
		});
	});

	test.each([
		{ argv: ["serve", "--port", "0"], message: "Invalid port: 0" },
		{ argv: ["serve", "--port", "65536"], message: "Invalid port: 65536" },
		{ argv: ["serve", "--port", "1.5"], message: "Invalid port: 1.5" },
	])("rejects invalid serve port $argv", ({ argv, message }) => {
		expect(() => parseCliArgs(argv)).toThrow(message);
	});

	test.each([
		{
			argv: ["serve", "--host"],
			message: "Option '--host <value>' argument missing",
		},
		{ argv: ["serve", "--unknown"], message: "Unknown option '--unknown'" },
		{
			argv: ["accounts", "remove"],
			message: "accounts remove requires exactly one <id|email>",
		},
		{
			argv: ["accounts", "remove", "one", "two"],
			message: "accounts remove requires exactly one <id|email>",
		},
		{
			argv: ["accounts"],
			message: "accounts requires list, import, or remove",
		},
		{
			argv: ["accounts", "rename"],
			message: "Unknown accounts command: rename",
		},
	])("rejects malformed command arguments: $message", ({ argv, message }) => {
		expect(() => parseCliArgs(argv)).toThrow(message);
	});
});

describe("main", () => {
	test("prints usage for --help without dispatching", async () => {
		const harness = createHarness();

		const exitCode = await main(["--help"], harness.deps);

		expect(exitCode).toBe(0);
		expect(harness.stdout).toEqual([CLI_USAGE]);
		expect(harness.loaded).toHaveLength(0);
		expect(harness.served).toHaveLength(0);
	});

	test("prints an error and usage for an unknown command", async () => {
		const harness = createHarness();

		const exitCode = await main(["launch"], harness.deps);

		expect(exitCode).toBe(1);
		expect(harness.stderr[0]).toContain("Unknown command: launch");
		expect(harness.stderr[1]).toBe(CLI_USAGE);
	});

	test("loads serve config with CLI overrides and starts the server", async () => {
		const harness = createHarness();

		const exitCode = await main(
			[
				"serve",
				"--config",
				"/tmp/kiro.json",
				"--host",
				"0.0.0.0",
					"--port",
					"9443",
					"--proxy",
					"http://127.0.0.1:1080",
				],
			harness.deps,
		);

		expect(exitCode).toBe(0);
		expect(harness.loaded).toEqual([
				{
					configPath: "/tmp/kiro.json",
					overrides: {
						host: "0.0.0.0",
						port: 9443,
						proxy_url: "http://127.0.0.1:1080",
					},
				},
			]);
		expect(harness.served).toEqual([{ host: "0.0.0.0", port: 9443 }]);
		expect(harness.stdout).toEqual(["Listening on http://0.0.0.0:9443"]);
	});

	test("omits proxy_url from serve overrides when --proxy is absent", async () => {
		const harness = createHarness();

		const exitCode = await main(["serve"], harness.deps);

		expect(exitCode).toBe(0);
		expect(harness.loaded).toEqual([{ overrides: {} }]);
		expect(harness.loaded[0]?.overrides).not.toHaveProperty("proxy_url");
	});

	test("lets an empty --proxy override clear an environment proxy", async () => {
		const harness = createHarness();
		const dependencies: CliDependencies = {
			...harness.deps,
			loadConfig: (options) => {
				harness.loaded.push(options);
				return loadConfig({
					...options,
					configPath: "/missing-config.json",
					env: {
						KIRO_PROVIDER_API_KEYS: "sk-test",
						KIRO_PROVIDER_PROXY_URL: "http://env-proxy:8080",
					},
				});
			},
		};

		const exitCode = await main(["serve", "--proxy", ""], dependencies);

		expect(exitCode).toBe(0);
		expect(harness.loaded[0]?.overrides).toEqual({ proxy_url: "" });
	});

	test("fails before server start when --proxy is not a valid URL", async () => {
		const harness = createHarness();
		const dependencies: CliDependencies = {
			...harness.deps,
			loadConfig: (options) =>
				loadConfig({
					...options,
					env: { KIRO_PROVIDER_API_KEYS: "sk-test" },
				}),
		};

		const exitCode = await main(["serve", "--proxy", "abc"], dependencies);

		expect(exitCode).toBe(1);
		expect(harness.served).toHaveLength(0);
		expect(harness.stderr.join("\n")).toContain("proxy_url");
		expect(harness.stderr.join("\n")).toContain("url");
	});

	test("prints the actual address only after the server binds", async () => {
		const harness = createHarness();
		const callOrder: string[] = [];
		const dependencies: CliDependencies = {
			...harness.deps,
			startServer: () => {
				callOrder.push("startServer");
				return {
					hostname: "127.0.0.1",
					port: 41_237,
					stop: () => undefined,
				};
			},
			stdout: (message) => {
				callOrder.push(`stdout:${message}`);
				harness.stdout.push(message);
			},
		};

		const exitCode = await main(["serve", "--port", "9443"], dependencies);

		expect(exitCode).toBe(0);
		expect(callOrder).toEqual([
			"startServer",
			"stdout:Listening on http://127.0.0.1:41237",
		]);
	});

	test("does not print Listening when the server bind fails", async () => {
		const harness = createHarness();
		const dependencies: CliDependencies = {
			...harness.deps,
			startServer: () => {
				throw new Error("Failed to start server. Is port 8787 in use?");
			},
		};

		const exitCode = await main(["serve"], dependencies);

		expect(exitCode).toBe(1);
		expect(harness.stdout).toHaveLength(0);
		expect(harness.stderr).toEqual([
			"Failed to start server. Is port 8787 in use?",
		]);
	});

	test("warns when serve routes to a test upstream endpoint", async () => {
		const harness = createHarness();
		const dependencies: CliDependencies = {
			...harness.deps,
			loadConfig: () =>
				ConfigSchema.parse({
					api_keys: ["sk-test"],
					test_upstream_endpoint: "http://127.0.0.1:43127",
				}),
		};

		const exitCode = await main(["serve"], dependencies);

		expect(exitCode).toBe(0);
		expect(harness.stderr).toEqual([
			"WARNING: test_upstream_endpoint is set (http://127.0.0.1:43127); routing upstream to a NON-production endpoint. Unset it for normal use.",
		]);
	});

	test("does not warn when serve uses the production upstream", async () => {
		const harness = createHarness();

		const exitCode = await main(["serve"], harness.deps);

		expect(exitCode).toBe(0);
		expect(harness.stderr).toHaveLength(0);
	});

	test("keeps serve fail-closed when api_keys validation fails", async () => {
		const harness = createHarness();
		const dependencies: CliDependencies = {
			...harness.deps,
			loadConfig: () => {
				throw new Error("Invalid configuration: api_keys: Required");
			},
		};

		const exitCode = await main(["serve"], dependencies);

		expect(exitCode).toBe(1);
		expect(harness.served).toHaveLength(0);
		expect(harness.stderr).toEqual([
			"Invalid configuration: api_keys: Required",
		]);
	});

	test("dispatches login with the selected IdC settings", async () => {
		const harness = createHarness();

		const exitCode = await main(
			[
				"login",
				"--start-url",
				"https://acme.awsapps.com/start",
				"--region",
				"eu-west-1",
			],
			harness.deps,
		);

		expect(exitCode).toBe(0);
		expect(harness.logins).toEqual([
			{
				startUrl: "https://acme.awsapps.com/start",
				region: "eu-west-1",
			},
		]);
	});

	test("lists accounts without exposing credentials", async () => {
		const harness = createHarness([account()]);

		const exitCode = await main(["accounts", "list"], harness.deps);

		expect(exitCode).toBe(0);
		expect(harness.stdout).toEqual([
			"dev@example.com\tus-east-1\thealthy\tgeneration=3\tused=4/100",
		]);
		expect(harness.stdout.join("\n")).not.toContain("access-secret");
		expect(harness.stdout.join("\n")).not.toContain("refresh-secret");
		expect(harness.loaded).toHaveLength(0);
	});

	test("dispatches accounts import with an isolated database", async () => {
		const harness = createHarness();

		const exitCode = await main(
			[
				"accounts",
				"import",
				"--from",
				"/tmp/opencode.db",
				"--config",
				"/tmp/config.json",
			],
			harness.deps,
		);

		expect(exitCode).toBe(0);
		expect(harness.loaded).toHaveLength(0);
		expect(harness.imports).toEqual([{ from: "/tmp/opencode.db" }]);
	});

	test("imports accounts when api_keys validation would fail", async () => {
		const harness = createHarness();
		const dependencies: CliDependencies = {
			...harness.deps,
			loadConfig: () => {
				throw new Error("Invalid configuration: api_keys: Required");
			},
		};

		const exitCode = await main(
			["accounts", "import", "--from", "/tmp/opencode.db"],
			dependencies,
		);

		expect(exitCode).toBe(0);
		expect(harness.imports).toEqual([{ from: "/tmp/opencode.db" }]);
	});

	test("lists accounts when api_keys validation would fail", async () => {
		const harness = createHarness([account()]);
		const dependencies: CliDependencies = {
			...harness.deps,
			loadConfig: () => {
				throw new Error("Invalid configuration: api_keys: Required");
			},
		};

		const exitCode = await main(["accounts", "list"], dependencies);

		expect(exitCode).toBe(0);
		expect(harness.stdout).toHaveLength(1);
	});

	test("removes accounts when api_keys validation would fail", async () => {
		const harness = createHarness([account()]);
		const dependencies: CliDependencies = {
			...harness.deps,
			loadConfig: () => {
				throw new Error("Invalid configuration: api_keys: Required");
			},
		};

		const exitCode = await main(
			["accounts", "remove", "dev@example.com"],
			dependencies,
		);

		expect(exitCode).toBe(0);
		expect(harness.removed).toEqual(["account-1"]);
	});

	test("opens one environment-derived database path for every accounts command", async () => {
		const harness = createHarness([account()]);

		await main(["accounts", "list"], harness.deps);
		await main(
			["accounts", "import", "--from", "/tmp/opencode.db"],
			harness.deps,
		);
		await main(
			["accounts", "remove", "dev@example.com"],
			harness.deps,
		);

		expect(harness.dbPaths).toEqual([
			ACCOUNTS_DB_PATH,
			ACCOUNTS_DB_PATH,
			ACCOUNTS_DB_PATH,
		]);
	});

	test("removes an account by email through the tombstone API", async () => {
		const harness = createHarness([account()]);

		const exitCode = await main(
			["accounts", "remove", "dev@example.com"],
			harness.deps,
		);

		expect(exitCode).toBe(0);
		expect(harness.removed).toEqual(["account-1"]);
		expect(harness.stdout).toEqual(["Removed account dev@example.com"]);
	});

	test("returns a failure without removing anything when an account is not found", async () => {
		const harness = createHarness([account()]);

		const exitCode = await main(
			["accounts", "remove", "missing@example.com"],
			harness.deps,
		);

		expect(exitCode).toBe(1);
		expect(harness.removed).toEqual([]);
		expect(harness.stdout).toEqual([]);
		expect(harness.stderr).toEqual(["Account not found: missing@example.com"]);
	});
});

describe("runLogin", () => {
	test.each([
		{
			label: "configured",
			proxyUrl: "http://p:1080",
			expectedProxyUrl: "http://p:1080",
		},
		{ label: "disabled", proxyUrl: null, expectedProxyUrl: undefined },
	])("passes the $label proxy URL to device authorization and polling", async ({
		proxyUrl,
		expectedProxyUrl,
	}) => {
		// Given
		let authorizeProxyUrl: string | undefined;
		let pollProxyUrl: string | undefined;

		// When
		await runLogin(
			ConfigSchema.parse({ api_keys: ["sk-test"], proxy_url: proxyUrl }),
			{},
			{
				authorize: async (...args) => {
					authorizeProxyUrl = args[2];
					return {
						verificationUrl: "https://device.example/verify",
						verificationUriComplete: "https://device.example/verify?code=ABCD",
						userCode: "ABCD",
						deviceCode: "device-code",
						clientId: "client-id",
						clientSecret: "client-secret",
						interval: 5,
						expiresIn: 600,
						region: "us-east-1",
						startUrl: "https://view.awsapps.com/start",
					};
				},
				poll: async (...args) => {
					pollProxyUrl = args[7];
					return {
						refreshToken: "refresh-secret",
						accessToken: "access-secret",
						expiresAt: 123_456,
						email: "dev@example.com",
						clientId: "client-id",
						clientSecret: "client-secret",
						region: "us-east-1",
						authMethod: "idc",
					};
				},
				openDb: () => ({
					insertAccount: (managedAccount) => ({
						...managedAccount,
						generation: 1,
					}),
					close: () => undefined,
				}),
				stdout: () => undefined,
			},
		);

		// Then
		expect(authorizeProxyUrl).toBe(expectedProxyUrl);
		expect(pollProxyUrl).toBe(expectedProxyUrl);
	});

	test("prints the verification URL and persists through insertAccount", async () => {
		const inserted: ManagedAccount[] = [];
		const output: string[] = [];
		let closed = false;
		const dbPaths: Array<string | undefined> = [];

		await runLogin(
			config,
			{
				startUrl: "https://acme.awsapps.com/landing/",
				region: "eu-west-1",
			},
			{
				authorize: async (region, startUrl) => ({
					verificationUrl: "https://device.example/verify",
					verificationUriComplete: "https://device.example/verify?code=ABCD",
					userCode: "ABCD",
					deviceCode: "device-code",
					clientId: "client-id",
					clientSecret: "client-secret",
					interval: 5,
					expiresIn: 600,
					region: region ?? "us-east-1",
					startUrl: startUrl ?? "https://view.awsapps.com/start",
				}),
				poll: async () => ({
					refreshToken: "refresh-secret",
					accessToken: "access-secret",
					expiresAt: 123_456,
					email: "dev@example.com",
					clientId: "client-id",
					clientSecret: "client-secret",
					region: "eu-west-1",
					authMethod: "idc",
				}),
				openDb: (...paths: readonly string[]) => {
					dbPaths.push(paths[0]);
					return {
					insertAccount: (managedAccount) => {
						inserted.push(managedAccount);
						return { ...managedAccount, generation: 1 };
					},
					close: () => {
						closed = true;
					},
					};
				},
				stdout: (message) => output.push(message),
			},
		);

		expect(inserted).toHaveLength(1);
		expect(inserted[0]).toMatchObject({
			email: "dev@example.com",
			region: "eu-west-1",
			oidcRegion: "eu-west-1",
			startUrl: "https://acme.awsapps.com/landing/start",
			authMethod: "idc",
		});
		expect(closed).toBe(true);
		expect(dbPaths).toEqual([ACCOUNTS_DB_PATH]);
		expect(output).toEqual([
			"Open this URL to sign in:\nhttps://device.example/verify?code=ABCD",
			"Login successful: dev@example.com",
		]);
	});
});
