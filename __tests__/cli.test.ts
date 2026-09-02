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
import type { AccountRefreshSummary } from "../src/core/quota-rechecker.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import {
	ACCOUNTS_DB_PATH,
	type StoredAccount,
} from "../src/storage/accounts-db.js";

const config = ConfigSchema.parse({
	api_keys: ["sk-test"],
	auth_source: "local",
});

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

function refreshSummary(
	accounts: readonly StoredAccount[],
): AccountRefreshSummary {
	return {
		startedAt: 1,
		completedAt: 2,
		totalAccounts: accounts.length,
		tokenRenewed: 0,
		usageUpdated: accounts.length,
		failed: 0,
		timedOut: false,
		accounts: accounts.map((candidate) => ({
			accountId: candidate.id,
			email: candidate.email,
			before: {
				usedCount: candidate.usedCount ?? 0,
				limitCount: candidate.limitCount ?? 0,
				overageCount: candidate.overageCount ?? 0,
			},
			after: {
				usedCount: candidate.usedCount ?? 0,
				limitCount: candidate.limitCount ?? 0,
				overageCount: candidate.overageCount ?? 0,
			},
			tokenStatus: "not_needed",
			usageStatus: "updated",
			quotaStatus: "available",
		})),
	};
}

function createHarness(
	accounts: readonly StoredAccount[] = [],
	confirmResult = true,
): {
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
		readonly replaceAccount?: StoredAccount;
	}>;
	readonly refreshes: Array<{ readonly identifier?: string }>;
	readonly imports: Array<{ readonly from?: string; readonly force?: boolean }>;
	readonly removed: string[];
	readonly confirmations: string[];
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
		readonly replaceAccount?: StoredAccount;
	}> = [];
	const refreshes: Array<{ readonly identifier?: string }> = [];
	const removed: string[] = [];
	const confirmations: string[] = [];
	const imports: Array<{ readonly from?: string; readonly force?: boolean }> = [];
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
			return {
				account: options.replaceAccount ?? account(),
				removedDuplicateIds: [],
			};
		},
		runAccountRefresh: async (_loadedConfig, options) => {
			refreshes.push(options);
			const selected = options.identifier
				? accounts.filter(
						(candidate) =>
							candidate.id === options.identifier ||
							candidate.email === options.identifier,
					)
				: accounts;
			return refreshSummary(selected);
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
		confirm: async (message) => {
			confirmations.push(message);
			return confirmResult;
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
		refreshes,
		imports,
		removed,
		confirmations,
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
				"--force",
			]),
		).toEqual({
			kind: "accounts-import",
			from: "/tmp/opencode.db",
			force: true,
		});
		expect(parseCliArgs(["accounts", "import"])).toEqual({
			kind: "accounts-import",
			force: false,
		});
	});

	test("parses account listing, refresh, relogin, and confirmed removal", () => {
		expect(parseCliArgs(["accounts", "list", "--details"])).toEqual({
			kind: "accounts-list",
			mode: "details",
		});
		expect(
			parseCliArgs([
				"accounts",
				"refresh",
				"--all",
				"--config",
				"/tmp/config.json",
				"--json",
			]),
		).toEqual({
			kind: "accounts-refresh",
			configPath: "/tmp/config.json",
			json: true,
		});
		expect(
			parseCliArgs(["accounts", "refresh", "dev@example.com"]),
		).toEqual({
			kind: "accounts-refresh",
			identifier: "dev@example.com",
			json: false,
		});
		expect(
			parseCliArgs([
				"accounts",
				"relogin",
				"account-1",
				"--region",
				"eu-west-1",
			]),
		).toEqual({
			kind: "accounts-relogin",
			identifier: "account-1",
			region: "eu-west-1",
		});
		expect(
			parseCliArgs(["accounts", "remove", "account-1", "--yes"]),
		).toEqual({
			kind: "accounts-remove",
			identifier: "account-1",
			yes: true,
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
			argv: ["accounts", "refresh"],
			message: "accounts refresh requires exactly one <id|email> or --all",
		},
		{
			argv: ["accounts", "refresh", "--all", "account-1"],
			message: "accounts refresh requires exactly one <id|email> or --all",
		},
		{
			argv: ["accounts", "list", "--details", "--json"],
			message: "accounts list accepts only one of --details or --json",
		},
		{
			argv: ["accounts", "relogin"],
			message: "accounts relogin requires exactly one <id|email>",
		},
		{
			argv: ["accounts"],
			message: "accounts requires list, refresh, relogin, import, or remove",
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

	test("rejects local login when OpenCode owns shared authentication", async () => {
		const harness = createHarness();
		const dependencies: CliDependencies = {
			...harness.deps,
			loadConfig: () =>
				ConfigSchema.parse({
					api_keys: ["sk-test"],
					auth_source: "opencode-shared",
					opencode_auth_db_path: "/tmp/opencode/kiro.db",
				}),
		};

		const exitCode = await main(["login"], dependencies);

		expect(exitCode).toBe(1);
		expect(harness.logins).toHaveLength(0);
		expect(harness.stderr.join("\n")).toContain("opencode auth login");
		expect(harness.stderr.join("\n")).toContain("/tmp/opencode/kiro.db");
	});

	test("lists accounts without exposing credentials", async () => {
		const harness = createHarness([account()]);

		const exitCode = await main(["accounts", "list"], harness.deps);

		expect(exitCode).toBe(0);
		expect(harness.stdout).toHaveLength(3);
		expect(harness.stdout[0]).toContain("EMAIL");
		expect(harness.stdout[2]).toContain("dev@example.com");
		expect(harness.stdout[2]).toContain("4/100");
		expect(harness.stdout.join("\n")).not.toContain("access-secret");
		expect(harness.stdout.join("\n")).not.toContain("refresh-secret");
		expect(harness.loaded).toHaveLength(0);
	});

	test("lists account IDs and generations in details or JSON mode", async () => {
		const detailed = createHarness([account()]);
		const json = createHarness([account()]);

		expect(
			await main(["accounts", "list", "--details"], detailed.deps),
		).toBe(0);
		expect(detailed.stdout.join("\n")).toContain("account-1");
		expect(detailed.stdout.join("\n")).toContain("GENERATION");

		expect(await main(["accounts", "list", "--json"], json.deps)).toBe(0);
		const parsed = JSON.parse(json.stdout[0] ?? "[]");
		expect(parsed).toEqual([
			expect.objectContaining({
				id: "account-1",
				email: "dev@example.com",
				generation: 3,
				used_count: 4,
				limit_count: 100,
				rate_limit_reset_at: null,
			}),
		]);
		expect(json.stdout.join("\n")).not.toContain("access-secret");
		expect(json.stdout.join("\n")).not.toContain("refresh-secret");
	});

	test("refreshes all accounts or one resolved account", async () => {
		const all = createHarness([account()]);
		const one = createHarness([account()]);

		expect(
			await main(["accounts", "refresh", "--all"], all.deps),
		).toBe(0);
		expect(all.refreshes).toEqual([{}]);
		expect(all.stdout[0]).toContain("Refreshed 1 accounts");

		expect(
			await main(
				["accounts", "refresh", "dev@example.com", "--json"],
				one.deps,
			),
		).toBe(0);
		expect(one.refreshes).toEqual([{ identifier: "dev@example.com" }]);
		expect(JSON.parse(one.stdout[0] ?? "{}")).toMatchObject({
			totalAccounts: 1,
			usageUpdated: 1,
			failed: 0,
		});
	});

	test("returns a failure when a manual account refresh is incomplete", async () => {
		const harness = createHarness([account()]);
		const dependencies: CliDependencies = {
			...harness.deps,
			runAccountRefresh: async () => ({
				...refreshSummary([account()]),
				usageUpdated: 0,
				failed: 1,
				accounts: [
					{
						accountId: "account-1",
						email: "dev@example.com",
						before: { usedCount: 4, limitCount: 100, overageCount: 0 },
						after: { usedCount: 4, limitCount: 100, overageCount: 0 },
						tokenStatus: "failed",
						usageStatus: "skipped",
						quotaStatus: "available",
						error: "needs re-login",
					},
				],
			}),
		};

		const exitCode = await main(
			["accounts", "refresh", "account-1"],
			dependencies,
		);

		expect(exitCode).toBe(1);
		expect(harness.stdout.join("\n")).toContain("needs re-login");
	});

	test("relogs in one resolved account while preserving its ID", async () => {
		const selected = account({
			startUrl: "https://acme.awsapps.com/start",
		});
		const harness = createHarness([selected]);

		const exitCode = await main(
			["accounts", "relogin", "dev@example.com", "--region", "eu-west-1"],
			harness.deps,
		);

		expect(exitCode).toBe(0);
		expect(harness.logins).toEqual([
			{
				replaceAccount: selected,
				region: "eu-west-1",
			},
		]);
	});

	test("dispatches accounts import with an isolated database", async () => {
		const harness = createHarness();

		const exitCode = await main(
			["accounts", "import", "--from", "/tmp/opencode.db"],
			harness.deps,
		);

		expect(exitCode).toBe(0);
		expect(harness.loaded).toHaveLength(0);
		expect(harness.imports).toEqual([
			{ from: "/tmp/opencode.db", force: false },
		]);
		expect(harness.stderr).toEqual([
			"Accounts imported into the provider-owned local database. kiro-provider will now refresh access tokens, usage, and account health independently.",
		]);
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
		expect(harness.imports).toEqual([
			{ from: "/tmp/opencode.db", force: false },
		]);
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
		expect(harness.stdout).toHaveLength(3);
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
		expect(harness.confirmations[0]).toContain("account-1");
		expect(harness.stdout).toEqual([
			"Removed account dev@example.com [account-1]",
		]);
	});

	test("cancels account removal unless it is confirmed", async () => {
		const harness = createHarness([account()], false);

		const exitCode = await main(
			["accounts", "remove", "dev@example.com"],
			harness.deps,
		);

		expect(exitCode).toBe(1);
		expect(harness.removed).toEqual([]);
		expect(harness.stderr).toEqual([
			"Account removal cancelled. Use --yes for non-interactive confirmation.",
		]);
	});

	test("--yes removes without prompting", async () => {
		const harness = createHarness([account()], false);

		const exitCode = await main(
			["accounts", "remove", "account-1", "--yes"],
			harness.deps,
		);

		expect(exitCode).toBe(0);
		expect(harness.confirmations).toEqual([]);
		expect(harness.removed).toEqual(["account-1"]);
	});

	test("rejects ambiguous email identifiers and prints matching IDs", async () => {
		const harness = createHarness([
			account({ id: "account-a" }),
			account({ id: "account-b" }),
		]);

		const exitCode = await main(
			["accounts", "remove", "DEV@example.com", "--yes"],
			harness.deps,
		);

		expect(exitCode).toBe(1);
		expect(harness.removed).toEqual([]);
		expect(harness.stderr[0]).toContain("ambiguous");
		expect(harness.stderr[0]).toContain("account-a");
		expect(harness.stderr[0]).toContain("account-b");
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
		let usageProxyUrl: string | undefined;

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
				fetchUsage: async (_auth, usageOptions) => {
					usageProxyUrl = usageOptions?.proxyUrl;
					return {
						email: "dev@example.com",
						usedCount: 1,
						limitCount: 100,
						overageCount: 0,
					};
				},
				openDb: () => ({
					getAccounts: () => [],
					insertAccount: (managedAccount) => ({
						...managedAccount,
						generation: 1,
					}),
					removeAccount: () => undefined,
					close: () => undefined,
				}),
				stdout: () => undefined,
			},
		);

		// Then
		expect(authorizeProxyUrl).toBe(expectedProxyUrl);
		expect(pollProxyUrl).toBe(expectedProxyUrl);
		expect(usageProxyUrl).toBe(expectedProxyUrl);
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
					email: "builder-id@aws.amazon.com",
					clientId: "client-id",
					clientSecret: "client-secret",
					region: "eu-west-1",
					authMethod: "idc",
				}),
				fetchUsage: async () => ({
					email: "dev@example.com",
					usedCount: 1,
					limitCount: 100,
					overageCount: 0,
				}),
				openDb: (...paths: readonly string[]) => {
					dbPaths.push(paths[0]);
					return {
						getAccounts: () => [],
						insertAccount: (managedAccount) => {
							inserted.push(managedAccount);
							return { ...managedAccount, generation: 1 };
						},
						removeAccount: () => undefined,
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

	test("relogin verifies identity, preserves the account ID, and removes exact duplicates", async () => {
		const selected = account({
			id: "stable-account-id",
			startUrl: "https://acme.awsapps.com/start",
			lastUsed: 42,
			usedCount: 100,
			limitCount: 100,
		});
		const duplicate = account({
			id: "duplicate-account-id",
			startUrl: "https://acme.awsapps.com/start/",
		});
		const separateLogin = account({
			id: "separate-login-id",
			startUrl: "https://other.awsapps.com/start",
		});
		const inserted: ManagedAccount[] = [];
		const removed: string[] = [];
		const output: string[] = [];

		const result = await runLogin(
			config,
			{ replaceAccount: selected },
			{
				authorize: async (region, startUrl) => ({
					verificationUrl: "https://device.example/verify",
					verificationUriComplete:
						"https://device.example/verify?code=RELOGIN",
					userCode: "RELOGIN",
					deviceCode: "device-code",
					clientId: "new-client-id",
					clientSecret: "new-client-secret",
					interval: 5,
					expiresIn: 600,
					region: region ?? "us-east-1",
					startUrl: startUrl ?? "https://view.awsapps.com/start",
				}),
				poll: async () => ({
					refreshToken: "new-refresh-secret",
					accessToken: "new-access-secret",
					expiresAt: 987_654,
					email: "builder-id@aws.amazon.com",
					clientId: "new-client-id",
					clientSecret: "new-client-secret",
					region: "us-east-1",
					authMethod: "idc",
				}),
				fetchUsage: async () => ({
					email: "DEV@example.com",
					usedCount: 8,
					limitCount: 100,
					overageCount: 0,
				}),
				openDb: () => ({
					getAccounts: () => [selected, duplicate, separateLogin],
					insertAccount: (managedAccount) => {
						inserted.push(managedAccount);
						return { ...managedAccount, generation: 4 };
					},
					removeAccount: (id) => {
						removed.push(id);
					},
					close: () => undefined,
				}),
				stdout: (message) => output.push(message),
			},
		);

		expect(inserted).toHaveLength(1);
		expect(inserted[0]).toMatchObject({
			id: "stable-account-id",
			email: "DEV@example.com",
			startUrl: "https://acme.awsapps.com/start",
			clientId: "new-client-id",
			refreshToken: "new-refresh-secret",
			accessToken: "new-access-secret",
			lastUsed: 42,
			usedCount: 8,
			limitCount: 100,
			isHealthy: true,
			failCount: 0,
		});
		expect(removed).toEqual(["duplicate-account-id"]);
		expect(result.account.id).toBe("stable-account-id");
		expect(result.removedDuplicateIds).toEqual(["duplicate-account-id"]);
		expect(output).toEqual([
			"Open this URL to sign in:\nhttps://device.example/verify?code=RELOGIN",
			"Re-login successful: DEV@example.com [stable-account-id]",
			"Removed 1 duplicate account record(s).",
		]);
	});

	test("relogin rejects a different authenticated account before changing the database", async () => {
		let databaseOpened = false;

		await expect(
			runLogin(
				config,
				{ replaceAccount: account() },
				{
					authorize: async () => ({
						verificationUrl: "https://device.example/verify",
						verificationUriComplete:
							"https://device.example/verify?code=RELOGIN",
						userCode: "RELOGIN",
						deviceCode: "device-code",
						clientId: "new-client-id",
						clientSecret: "new-client-secret",
						interval: 5,
						expiresIn: 600,
						region: "us-east-1",
						startUrl: "https://view.awsapps.com/start",
					}),
					poll: async () => ({
						refreshToken: "new-refresh-secret",
						accessToken: "new-access-secret",
						expiresAt: 987_654,
						email: "builder-id@aws.amazon.com",
						clientId: "new-client-id",
						clientSecret: "new-client-secret",
						region: "us-east-1",
						authMethod: "idc",
					}),
					fetchUsage: async () => ({
						email: "other@example.com",
						usedCount: 0,
						limitCount: 100,
						overageCount: 0,
					}),
					openDb: () => {
						databaseOpened = true;
						throw new Error("database must not be opened");
					},
					stdout: () => undefined,
				},
			),
		).rejects.toThrow("No credentials were changed");

		expect(databaseOpened).toBe(false);
	});
});
