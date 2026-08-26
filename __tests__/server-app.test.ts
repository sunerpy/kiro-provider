import { describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import type {
	PipelineAccountManager,
	PipelineTokenRefresher,
} from "../src/core/pipeline.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import {
	buildServeOptions,
	buildServerDeps,
	createApp,
} from "../src/server/app.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

function config(
	proxyUrl: string | null,
	overrides: Partial<Config> = {},
): Config {
	return ConfigSchema.parse({
		api_keys: ["sk-test"],
		proxy_url: proxyUrl,
		auth_source: "local",
		...overrides,
	});
}

describe("buildServerDeps", () => {
	test.each([
		{
			label: "configured",
			proxyUrl: "http://p:1080",
			expectedProxyUrl: "http://p:1080",
		},
		{ label: "disabled", proxyUrl: null, expectedProxyUrl: undefined },
	])("passes the $label proxy URL to the production TokenRefresher assembly", ({
		proxyUrl,
		expectedProxyUrl,
		}) => {
			// Given
			const database = new AccountsDatabase(":memory:");
			try {
				let capturedProxyUrl: string | undefined;
				const tokenRefresher: PipelineTokenRefresher = {
					async refreshIfNeeded(account) {
						return account;
					},
					async forceRefresh(account) {
						return account;
					},
				};

				// When
				buildServerDeps(config(proxyUrl), {
					createDatabase: () => database,
					createTokenRefresher: (_accountManager, _bufferMs, resolvedProxyUrl) => {
						capturedProxyUrl = resolvedProxyUrl;
						return tokenRefresher;
					},
				});

				// Then
				expect(capturedProxyUrl).toBe(expectedProxyUrl);
			} finally {
				database.close();
			}
		});

	test("constructs the production token refresher when no refresher factory is supplied", () => {
		const database = new AccountsDatabase(":memory:");
		try {
			const dependencies = buildServerDeps(config(null), {
				createDatabase: () => database,
			});

			expect(dependencies.tokenRefresher.constructor.name).toBe("TokenRefresher");
		} finally {
			database.close();
		}
	});
});

class ThrowingAccountManager implements PipelineAccountManager {
	reconcileFromDb(): readonly ManagedAccount[] {
		throw new Error("selection failed");
	}

	selectHealthyAccount(): ManagedAccount | null {
		throw new Error("selection failed");
	}

	getAccountCount(): number {
		return 0;
	}

	toAuthDetails(_account: ManagedAccount): KiroAuthDetails {
		throw new Error("selection failed");
	}

	markRateLimited(_account: ManagedAccount, _resetTime: number): void {}

	markUnhealthy(
		_account: ManagedAccount,
		_reason: string,
		_recoveryTime?: number,
	): void {}
}

const passThroughRefresher: PipelineTokenRefresher = {
	async refreshIfNeeded(account) {
		return account;
	},
	async forceRefresh(account) {
		return account;
	},
};

describe("buildServeOptions", () => {
	test("omits Bun's global idleTimeout while preserving the server wiring", () => {
		const parsed = ConfigSchema.parse({
			api_keys: ["sk-test"],
			host: "127.0.0.2",
			port: 43210,
		});
		const dependencies = {
			accountManager: new ThrowingAccountManager(),
			tokenRefresher: passThroughRefresher,
		};

		const options: Bun.Serve.Options<undefined> = buildServeOptions(
			parsed,
			dependencies,
		);

		expect(Object.hasOwn(options, "idleTimeout")).toBe(false);
		expect(options.hostname).toBe(parsed.host);
		expect(options.port).toBe(parsed.port);
		expect(options.fetch).toBeFunction();
	});
});

describe("createApp", () => {
	const authorization = { Authorization: "Bearer sk-test" };
	const app = createApp(config(null), {
		accountManager: new ThrowingAccountManager(),
		tokenRefresher: passThroughRefresher,
	});
	const legacyChatApp = createApp(
		config(null, { enable_legacy_chat_completions: true }),
		{
			accountManager: new ThrowingAccountManager(),
			tokenRefresher: passThroughRefresher,
		},
	);

	test("checks authentication before route dispatch", async () => {
		const response = await app(new Request("http://x/missing"));
		const body: unknown = await response.json();

		expect(response.status).toBe(401);
		expect(body).toMatchObject({ error: { code: "missing_api_key" } });
	});

	test("dispatches the models route through the fetch handler", async () => {
		const response = await app(new Request("http://x/v1/models", { headers: authorization }));
		const body: unknown = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({ object: "list" });
		if (
			typeof body !== "object" ||
			body === null ||
			!("models" in body) ||
			!Array.isArray(body.models) ||
			body.models.length === 0
		) {
			throw new TypeError("Expected a non-empty Codex models catalog");
		}
		expect(body.models[0]).toMatchObject({
			supports_reasoning_summary_parameter: false,
			supports_search_tool: false,
			web_search_tool_type: null,
		});
	});

	test("dispatches the health route through the fetch handler", async () => {
		const response = await app(new Request("http://x/health"));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});

	test("reports readiness failures without exposing account details", async () => {
		const response = await app(new Request("http://x/ready", { headers: authorization }));

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			status: "not_ready",
			reason: "authentication_store_unavailable",
		});
	});

	test("returns an OpenAI-shaped 404 for an authenticated unknown route", async () => {
		const response = await app(new Request("http://x/missing", { headers: authorization }));
		const body: unknown = await response.json();

		expect(response.status).toBe(404);
		expect(body).toMatchObject({ error: { code: "not_found", message: "Route not found" } });
	});

	test("keeps legacy Chat Completions disabled unless explicitly enabled", async () => {
		const response = await app(
			new Request("http://x/v1/chat/completions", {
				method: "POST",
				headers: { ...authorization, "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "auto",
					messages: [{ role: "user", content: "hello" }],
				}),
			}),
		);
		const body: unknown = await response.json();

		expect(response.status).toBe(404);
		expect(body).toMatchObject({
			error: { code: "legacy_chat_completions_disabled" },
		});
	});

	test("converts unexpected chat-route exceptions into a 500 response", async () => {
		const response = await legacyChatApp(
			new Request("http://x/v1/chat/completions", {
				method: "POST",
				headers: { ...authorization, "Content-Type": "application/json" },
				body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hello" }] }),
			}),
		);
		const body: unknown = await response.json();

		expect(response.status).toBe(500);
		expect(body).toMatchObject({ error: { code: "Error", message: "selection failed" } });
	});

	test("converts a request-body stream failure into an internal error response", async () => {
		const failedBody = new ReadableStream<Uint8Array>({
			pull() {
				throw new Error("body stream failed");
			},
		});
		const response = await legacyChatApp(
			new Request("http://x/v1/chat/completions", {
				method: "POST",
				headers: { ...authorization, "Content-Type": "application/json" },
				body: failedBody,
			}),
		);
		const body: unknown = await response.json();

		expect(response.status).toBe(500);
		expect(body).toMatchObject({
			error: { code: "internal_error", message: "body stream failed" },
		});
	});
});
