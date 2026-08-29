import {
	defaultOpenCodeAuthDbPath,
	OpenCodeAuthStore,
} from "../auth/opencode-auth-store.js";
import type { Config } from "../config/schema.js";
import {
	AccountMaintenanceService,
	bindAccountMaintenanceLifecycle,
	type PipelineAccountMaintenance,
} from "../core/account-maintenance.js";
import { AccountManager } from "../core/account-manager.js";
import { auditLog } from "../core/audit-log.js";
import {
	OpenCodeAccountManager,
	OpenCodeTokenRefresher,
} from "../core/opencode-auth-runtime.js";
import type {
  PipelineAccountManager,
  PipelineAffinityStore,
  PipelineClientFactory,
  PipelineQuotaRechecker,
  PipelineReasoningReplayStore,
  PipelineTokenRefresher,
} from "../core/pipeline.js";
import { resolveProxyUrl } from "../core/proxy.js";
import { QuotaRechecker } from "../core/quota-rechecker.js";
import {
  boundedCleanup,
  CLEANUP_GRACE_MS,
  runCleanupSteps,
  safeStep,
} from "../core/stream-cleanup.js";
import { TokenRefresher } from "../core/token-refresher.js";
import {
	ModelCapabilityService,
	type PipelineModelCapabilities,
} from "../kiro/model-capabilities.js";
import { ReasoningReplayStore } from "../reasoning/replay-store.js";
import { AccountsDatabase } from "../storage/accounts-db.js";
import { anthropicError } from "./anthropic/errors.js";
import { checkApiKey } from "./auth-gate.js";
import { openAiError } from "./errors.js";
import type {
  RequestIdleTimeoutLease,
  RequestIdleTimeoutLeaseMaker,
} from "./request-lifecycle.js";
import { handleChatCompletions } from "./routes/chat-completions.js";
import { handleHealth } from "./routes/health.js";
import {
  handleMessages,
  handleMessageTokenCount,
} from "./routes/messages.js";
import { handleModels } from "./routes/models.js";
import { handleReadiness } from "./routes/readiness.js";
import { handleResponses } from "./routes/responses.js";
import {
	acquireServiceInstanceLock,
	bindServiceInstanceLease,
} from "./single-instance.js";

export type {
  RequestIdleTimeoutLease,
  RequestIdleTimeoutLeaseMaker,
} from "./request-lifecycle.js";

export type AppDependencies = {
  readonly accountManager: PipelineAccountManager;
  readonly tokenRefresher: PipelineTokenRefresher;
  readonly quotaRechecker?: PipelineQuotaRechecker;
  readonly accountMaintenance?: PipelineAccountMaintenance;
  readonly affinityStore?: PipelineAffinityStore;
  readonly reasoningReplayStore?: PipelineReasoningReplayStore;
  readonly modelCapabilities?: PipelineModelCapabilities;
  readonly makeClient?: PipelineClientFactory;
  readonly createRequestIdleTimeoutLease?: RequestIdleTimeoutLeaseMaker;
};

export type AppFetchHandler = (
  request: Request,
  server?: Bun.Server<undefined>,
) => Promise<Response>;

export const RESTORED_IDLE_TIMEOUT_SECONDS = 10;

export function createRequestIdleTimeoutLease(
  request: Request,
  server: Bun.Server<undefined>,
): RequestIdleTimeoutLease {
  let state: "idle" | "disabled" | "restored" = "idle";
  return {
    disable: () => {
      if (state !== "idle") return;
      state = "disabled";
      server.timeout(request, 0);
    },
    restore: () => {
      if (state !== "disabled") return;
      state = "restored";
      server.timeout(request, RESTORED_IDLE_TIMEOUT_SECONDS);
    },
  };
}

export { boundedCleanup, CLEANUP_GRACE_MS, runCleanupSteps, safeStep };

export type ServerDependencyFactories = {
	readonly createDatabase?: () => AccountsDatabase;
	readonly createOpenCodeAuthStore?: (path: string) => OpenCodeAuthStore;
	readonly createTokenRefresher?: (
		accountManager: AccountManager,
		tokenExpiryBufferMs: number,
		proxyUrl?: string,
	) => PipelineTokenRefresher;
	readonly createOpenCodeTokenRefresher?: (
		accountManager: OpenCodeAccountManager,
		store: OpenCodeAuthStore,
		tokenExpiryBufferMs: number,
		proxyUrl?: string,
	) => PipelineTokenRefresher;
	readonly createQuotaRechecker?: (
		accountManager: AccountManager | OpenCodeAccountManager,
		tokenRefresher: PipelineTokenRefresher,
		config: Config,
		proxyUrl?: string,
	) => PipelineQuotaRechecker;
	readonly createAccountMaintenance?: (
		accountManager: AccountManager | OpenCodeAccountManager,
		tokenRefresher: PipelineTokenRefresher,
		quotaRechecker: PipelineQuotaRechecker,
		config: Config,
	) => PipelineAccountMaintenance;
	readonly createReasoningReplayStore?: (
		database: AccountsDatabase,
		config: Config,
	) => PipelineReasoningReplayStore;
	readonly createModelCapabilityService?: (
		config: Config,
	) => PipelineModelCapabilities;
};

export function createApp(config: Config, dependencies: AppDependencies): AppFetchHandler {
  return async (request: Request, server?: Bun.Server<undefined>): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return handleHealth();
    }
    const anthropicRoute =
      url.pathname === "/v1/messages" ||
      url.pathname === "/v1/messages/count_tokens";
    const auth = anthropicRoute
      ? checkApiKey(request, config.api_keys, (status, message) =>
          anthropicError(status, message, "authentication_error"),
        )
      : checkApiKey(request, config.api_keys);
    if (!auth.ok) return auth.response;

    const maker: RequestIdleTimeoutLeaseMaker =
      dependencies.createRequestIdleTimeoutLease ?? createRequestIdleTimeoutLease;
    const leaseFactory: (() => RequestIdleTimeoutLease | undefined) | undefined = server
      ? () => maker(request, server)
      : undefined;
    const routeDependencies = {
      accountManager: dependencies.accountManager,
      tokenRefresher: dependencies.tokenRefresher,
      ...(dependencies.quotaRechecker
        ? { quotaRechecker: dependencies.quotaRechecker }
        : {}),
      tenantId: auth.tenantId,
      ...(dependencies.affinityStore
        ? { affinityStore: dependencies.affinityStore }
        : {}),
      ...(dependencies.reasoningReplayStore
        ? { reasoningReplayStore: dependencies.reasoningReplayStore }
        : {}),
      ...(dependencies.modelCapabilities
        ? { modelCapabilities: dependencies.modelCapabilities }
        : {}),
      ...(dependencies.makeClient ? { makeClient: dependencies.makeClient } : {}),
      ...(leaseFactory ? { createRequestIdleTimeoutLease: leaseFactory } : {}),
    };
    try {
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        if (!config.enable_legacy_chat_completions) {
          return openAiError(
            404,
            "Legacy Chat Completions is disabled; set enable_legacy_chat_completions to true",
            "invalid_request_error",
            "legacy_chat_completions_disabled",
          );
        }
        return await handleChatCompletions(request, config, routeDependencies);
      }
      if (request.method === "POST" && url.pathname === "/v1/responses") {
        return await handleResponses(request, config, routeDependencies);
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        return await handleMessages(request, config, routeDependencies);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/messages/count_tokens"
      ) {
        return await handleMessageTokenCount(request, config);
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        return await handleModels(
          dependencies.modelCapabilities,
          dependencies.accountManager,
          dependencies.tokenRefresher,
          request.signal,
          dependencies.quotaRechecker,
        );
      }
      if (request.method === "GET" && url.pathname === "/ready") {
        return handleReadiness(
          dependencies.accountManager,
          dependencies.reasoningReplayStore,
          dependencies.modelCapabilities,
        );
      }
      return openAiError(404, "Route not found", "invalid_request_error", "not_found");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal server error";
      if (anthropicRoute) {
        return anthropicError(500, message, "api_error");
      }
      return openAiError(500, message, "internal_error", "internal_error");
    }
  };
}

export function buildServerDeps(
	config: Config,
	factories: ServerDependencyFactories = {},
): AppDependencies {
	if (config.protocol_projection_mode === "legacy-user-prefix") {
		auditLog("warn", "legacy_protocol_projection_enabled", {
			projection_mode: config.protocol_projection_mode,
			planned_removal: "v0.7.0",
		});
	}
	if (config.session_affinity_mode === "legacy-initial-input") {
		auditLog("warn", "legacy_session_affinity_enabled", {
			session_affinity_mode: config.session_affinity_mode,
			risk: "identical_initial_input_can_alias_independent_sessions",
			planned_removal: "v0.7.0",
		});
	}
	const database = factories.createDatabase?.() ?? new AccountsDatabase();
	const reasoningReplayStore =
		factories.createReasoningReplayStore?.(database, config) ??
		new ReasoningReplayStore(database, config);
	const modelCapabilities =
		factories.createModelCapabilityService?.(config) ??
		new ModelCapabilityService(config);
	const proxyUrl = resolveProxyUrl(config);
	if (config.auth_source === "opencode-shared") {
		const authStorePath =
			config.opencode_auth_db_path ?? defaultOpenCodeAuthDbPath();
		const authStore =
			factories.createOpenCodeAuthStore?.(authStorePath) ??
			new OpenCodeAuthStore(authStorePath);
		const accountManager = new OpenCodeAccountManager(
			authStore,
			config.account_selection_strategy,
		);
		const tokenRefresher = factories.createOpenCodeTokenRefresher
			? factories.createOpenCodeTokenRefresher(
					accountManager,
					authStore,
					config.token_expiry_buffer_ms,
					proxyUrl,
				)
			: new OpenCodeTokenRefresher(
					accountManager,
					authStore,
					config.token_expiry_buffer_ms,
					proxyUrl,
				);
		const quotaRechecker =
			factories.createQuotaRechecker?.(
				accountManager,
				tokenRefresher,
				config,
				proxyUrl,
			) ??
				new QuotaRechecker({
					accountManager,
					tokenRefresher,
					intervalMs: config.quota_recheck_interval_ms,
					usageRefreshIntervalMs: config.usage_refresh_interval_ms,
					timeoutMs: config.quota_recheck_timeout_ms,
				concurrency: config.quota_recheck_concurrency,
					proxyUrl,
				});
		const accountMaintenance =
			factories.createAccountMaintenance?.(
				accountManager,
				tokenRefresher,
				quotaRechecker,
				config,
			) ??
			new AccountMaintenanceService({
				enabled: config.account_maintenance_enabled,
				intervalMs: config.account_maintenance_interval_ms,
				timeoutMs: config.account_maintenance_timeout_ms,
				concurrency: config.account_maintenance_concurrency,
				tokenExpiryBufferMs: config.token_expiry_buffer_ms,
				accountManager,
				tokenRefresher,
				usageRefresher: quotaRechecker,
			});
		return {
			accountManager,
			tokenRefresher,
			quotaRechecker,
			accountMaintenance,
			affinityStore: database,
			reasoningReplayStore,
			modelCapabilities,
		};
	}

	const accountManager = new AccountManager(
		database.getAccounts(),
		config.account_selection_strategy,
		database,
	);
	const tokenRefresher = factories.createTokenRefresher
    ? factories.createTokenRefresher(accountManager, config.token_expiry_buffer_ms, proxyUrl)
    : new TokenRefresher(accountManager, config.token_expiry_buffer_ms, proxyUrl);
  const quotaRechecker =
    factories.createQuotaRechecker?.(accountManager, tokenRefresher, config, proxyUrl) ??
    new QuotaRechecker({
      accountManager,
      tokenRefresher,
      intervalMs: config.quota_recheck_interval_ms,
      usageRefreshIntervalMs: config.usage_refresh_interval_ms,
      timeoutMs: config.quota_recheck_timeout_ms,
      concurrency: config.quota_recheck_concurrency,
      proxyUrl,
    });
  const accountMaintenance =
    factories.createAccountMaintenance?.(
      accountManager,
      tokenRefresher,
      quotaRechecker,
      config,
    ) ??
    new AccountMaintenanceService({
      enabled: config.account_maintenance_enabled,
      intervalMs: config.account_maintenance_interval_ms,
      timeoutMs: config.account_maintenance_timeout_ms,
      concurrency: config.account_maintenance_concurrency,
      tokenExpiryBufferMs: config.token_expiry_buffer_ms,
      accountManager,
      tokenRefresher,
      usageRefresher: quotaRechecker,
    });
  return {
    accountManager,
    tokenRefresher,
    quotaRechecker,
    accountMaintenance,
    affinityStore: database,
    reasoningReplayStore,
    modelCapabilities,
  };
}

export function buildServeOptions(
  config: Config,
  dependencies: AppDependencies,
): Bun.Serve.Options<undefined> {
  return {
    hostname: config.host,
    port: config.port,
    fetch: createApp(config, dependencies),
  };
}

export function startServer(config: Config): ReturnType<typeof Bun.serve> {
	const lease = acquireServiceInstanceLock(config);
	try {
		const dependencies = buildServerDeps(config);
		const server = Bun.serve(buildServeOptions(config, dependencies));
		const leasedServer = bindServiceInstanceLease(server, lease);
		return bindAccountMaintenanceLifecycle(
			leasedServer,
			dependencies.accountMaintenance,
		);
	} catch (error) {
		lease?.release();
		throw error;
	}
}
