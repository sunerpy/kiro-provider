import { describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import type { PipelineTokenRefresher } from "../src/core/pipeline.js";
import { buildServerDeps } from "../src/server/app.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

function config(proxyUrl: string | null): Config {
	return ConfigSchema.parse({ api_keys: ["sk-test"], proxy_url: proxyUrl });
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
		database.close();
	});
});
