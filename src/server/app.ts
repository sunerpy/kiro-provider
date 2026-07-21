import type { Config } from "../config/schema.js";
import { AccountManager } from "../core/account-manager.js";
import type {
	PipelineAccountManager,
	PipelineClientFactory,
	PipelineTokenRefresher,
} from "../core/pipeline.js";
import { resolveProxyUrl } from "../core/proxy.js";
import { TokenRefresher } from "../core/token-refresher.js";
import { AccountsDatabase } from "../storage/accounts-db.js";
import { checkApiKey } from "./auth-gate.js";
import { openAiError } from "./errors.js";
import { handleChatCompletions } from "./routes/chat-completions.js";
import { handleHealth } from "./routes/health.js";
import { handleModels } from "./routes/models.js";
import { handleResponses } from "./routes/responses.js";

export type AppDependencies = {
	readonly accountManager: PipelineAccountManager;
	readonly tokenRefresher: PipelineTokenRefresher;
	readonly makeClient?: PipelineClientFactory;
};

export type AppFetchHandler = (request: Request) => Promise<Response>;

export type ServerDependencyFactories = {
	readonly createDatabase?: () => AccountsDatabase;
	readonly createTokenRefresher?: (
		accountManager: AccountManager,
		tokenExpiryBufferMs: number,
		proxyUrl?: string,
	) => PipelineTokenRefresher;
};

export function createApp(
	config: Config,
	dependencies: AppDependencies,
): AppFetchHandler {
	return async (request: Request): Promise<Response> => {
		const auth = checkApiKey(request, config.api_keys);
		if (!auth.ok) return auth.response;

		const url = new URL(request.url);
		try {
				if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
					return await handleChatCompletions(request, config, dependencies);
				}
				if (request.method === "POST" && url.pathname === "/v1/responses") {
					return await handleResponses(request, config, dependencies);
				}
			if (request.method === "GET" && url.pathname === "/v1/models") {
				return handleModels();
			}
			if (request.method === "GET" && url.pathname === "/health") {
				return handleHealth();
			}
			return openAiError(
				404,
				"Route not found",
				"invalid_request_error",
				"not_found",
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Internal server error";
			return openAiError(500, message, "internal_error", "internal_error");
		}
	};
}

export function buildServerDeps(
	config: Config,
	factories: ServerDependencyFactories = {},
): AppDependencies {
	const database = factories.createDatabase?.() ?? new AccountsDatabase();
	const accountManager = new AccountManager(
		database.getAccounts(),
		config.account_selection_strategy,
		database,
	);
	const proxyUrl = resolveProxyUrl(config);
	const tokenRefresher = factories.createTokenRefresher
		? factories.createTokenRefresher(
				accountManager,
				config.token_expiry_buffer_ms,
				proxyUrl,
			)
		: new TokenRefresher(
				accountManager,
				config.token_expiry_buffer_ms,
				proxyUrl,
			);
	return { accountManager, tokenRefresher };
}

export function startServer(config: Config): ReturnType<typeof Bun.serve> {
	return Bun.serve({
		hostname: config.host,
		port: config.port,
		fetch: createApp(config, buildServerDeps(config)),
	});
}
