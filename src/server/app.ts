import { OPENCODE_SHARED_REMOVED_MESSAGE } from "../config/loader.js";
import type { Config } from "../config/schema.js";
import {
  AccountMaintenanceService,
  bindAccountMaintenanceLifecycle,
  type PipelineAccountMaintenance,
} from "../core/account-maintenance.js";
import { AccountManager } from "../core/account-manager.js";
import { auditHash, auditLog } from "../core/audit-log.js";
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
import { toOveragePolicy } from "../kiro/health.js";
import {
  ModelCapabilityService,
  type PipelineModelCapabilities,
} from "../kiro/model-capabilities.js";
import { ReasoningReplayStore } from "../reasoning/replay-store.js";
import { AccountsDatabase } from "../storage/accounts-db.js";
import { anthropicError } from "./anthropic/errors.js";
import { checkApiKey } from "./auth-gate.js";
import {
  anthropicInternalError,
  newRequestId,
  openAiError,
  openAiInternalError,
} from "./errors.js";
import type { RouteDependencies } from "./ingress.js";
import {
  createGracefulShutdown,
  DEFAULT_SHUTDOWN_DRAIN_MS,
  type ShutdownServer,
} from "./lifecycle.js";
import type { RequestIdleTimeoutLease, RequestIdleTimeoutLeaseMaker } from "./request-lifecycle.js";
import { handleChatCompletions } from "./routes/chat-completions.js";
import { handleHealth } from "./routes/health.js";
import { handleMessages, handleMessageTokenCount } from "./routes/messages.js";
import { handleModels } from "./routes/models.js";
import { handleReadiness } from "./routes/readiness.js";
import { handleResponses } from "./routes/responses.js";
import {
  acquireServiceInstanceLock,
  bindServiceInstanceLease,
  type InstanceLockAcquireOptions,
  type ServiceInstanceLease,
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
  readonly createTokenRefresher?: (
    accountManager: AccountManager,
    tokenExpiryBufferMs: number,
    proxyUrl?: string,
  ) => PipelineTokenRefresher;
  readonly createQuotaRechecker?: (
    accountManager: AccountManager,
    tokenRefresher: PipelineTokenRefresher,
    config: Config,
    proxyUrl?: string,
  ) => PipelineQuotaRechecker;
  readonly createAccountMaintenance?: (
    accountManager: AccountManager,
    tokenRefresher: PipelineTokenRefresher,
    quotaRechecker: PipelineQuotaRechecker,
    config: Config,
  ) => PipelineAccountMaintenance;
  readonly createReasoningReplayStore?: (
    database: AccountsDatabase,
    config: Config,
  ) => PipelineReasoningReplayStore;
  readonly createModelCapabilityService?: (config: Config) => PipelineModelCapabilities;
};

type RouteName = "health" | "ready" | "models" | "chat" | "responses" | "messages" | "count_tokens";

interface RouteDefinition {
  readonly name: RouteName;
  readonly methods: readonly string[];
  readonly protocol: "openai" | "anthropic";
}

/**
 * Method + path table for the public HTTP surface. One trailing slash is
 * tolerated. A known path with an unsupported method answers 405 with `Allow`;
 * that includes OPTIONS, because CORS preflight handling is out of scope for
 * this gateway (a same-origin client or the reverse proxy in front of it owns
 * CORS policy).
 */
const ROUTES: ReadonlyMap<string, RouteDefinition> = new Map<string, RouteDefinition>([
  ["/health", { name: "health", methods: ["GET", "HEAD"], protocol: "openai" }],
  ["/ready", { name: "ready", methods: ["GET"], protocol: "openai" }],
  ["/v1/models", { name: "models", methods: ["GET"], protocol: "openai" }],
  ["/v1/chat/completions", { name: "chat", methods: ["POST"], protocol: "openai" }],
  ["/v1/responses", { name: "responses", methods: ["POST"], protocol: "openai" }],
  ["/v1/messages", { name: "messages", methods: ["POST"], protocol: "anthropic" }],
  ["/v1/messages/count_tokens", { name: "count_tokens", methods: ["POST"], protocol: "anthropic" }],
]);

export function normalizeRoutePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function methodNotAllowed(route: RouteDefinition, method: string): Response {
  const message = `Method ${method} is not allowed for this route`;
  const response =
    route.protocol === "anthropic"
      ? anthropicError(405, message, "invalid_request_error")
      : openAiError(405, message, "invalid_request_error", "method_not_allowed");
  response.headers.set("Allow", route.methods.join(", "));
  return response;
}

function healthHead(): Response {
  return new Response(null, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export function createApp(config: Config, dependencies: AppDependencies): AppFetchHandler {
  return async (request: Request, server?: Bun.Server<undefined>): Promise<Response> => {
    const url = new URL(request.url);
    const pathname = normalizeRoutePath(url.pathname);
    const route = ROUTES.get(pathname);
    const anthropicRoute = route?.protocol === "anthropic";
    if (route && !route.methods.includes(request.method)) {
      return methodNotAllowed(route, request.method);
    }
    if (route?.name === "health") {
      return request.method === "HEAD" ? healthHead() : handleHealth();
    }
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
    const routeDependencies: RouteDependencies = {
      accountManager: dependencies.accountManager,
      tokenRefresher: dependencies.tokenRefresher,
      ...(dependencies.quotaRechecker ? { quotaRechecker: dependencies.quotaRechecker } : {}),
      tenantId: auth.tenantId,
      ...(dependencies.affinityStore ? { affinityStore: dependencies.affinityStore } : {}),
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
      switch (route?.name) {
        case "chat":
          if (!config.enable_legacy_chat_completions) {
            return openAiError(
              404,
              "Legacy Chat Completions is disabled; set enable_legacy_chat_completions to true",
              "invalid_request_error",
              "legacy_chat_completions_disabled",
            );
          }
          return await handleChatCompletions(request, config, routeDependencies);
        case "responses":
          return await handleResponses(request, config, routeDependencies);
        case "messages":
          return await handleMessages(request, config, routeDependencies);
        case "count_tokens":
          return await handleMessageTokenCount(request, config);
        case "models":
          return await handleModels(
            dependencies.modelCapabilities,
            dependencies.accountManager,
            dependencies.tokenRefresher,
            request.signal,
            dependencies.quotaRechecker,
          );
        case "ready":
          return handleReadiness(
            dependencies.accountManager,
            dependencies.reasoningReplayStore,
            dependencies.modelCapabilities,
          );
        default:
          return openAiError(404, "Route not found", "invalid_request_error", "not_found");
      }
    } catch (error) {
      // Fixed text plus a correlation id: exception prose can carry storage
      // paths, account ids, or upstream payloads and stays in the audit log.
      const requestId = newRequestId();
      auditLog("error", "request_handler_failed", {
        request_id: requestId,
        route: pathname,
        method: request.method,
        error_type: error instanceof Error ? error.name : typeof error,
        detail_hash: auditHash(error instanceof Error ? error.message : String(error)),
      });
      return anthropicRoute ? anthropicInternalError(requestId) : openAiInternalError(requestId);
    }
  };
}

export function buildServerDeps(
  config: Config,
  factories: ServerDependencyFactories = {},
): AppDependencies {
  if (config.auth_source === "opencode-shared") {
    throw new Error(OPENCODE_SHARED_REMOVED_MESSAGE);
  }
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
    factories.createModelCapabilityService?.(config) ?? new ModelCapabilityService(config);
  const proxyUrl = resolveProxyUrl(config);
  const accountManager = new AccountManager(
    database.getAccounts(),
    config.account_selection_strategy,
    database,
    { overagePolicy: toOveragePolicy(config) },
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
    factories.createAccountMaintenance?.(accountManager, tokenRefresher, quotaRechecker, config) ??
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

/** Bun's last-resort handler: a fixed 500 envelope, never a rendered error page. */
export function handleServeError(error: unknown): Response {
  const requestId = newRequestId();
  auditLog("error", "server_request_failed", {
    request_id: requestId,
    error_type: error instanceof Error ? error.name : typeof error,
    detail_hash: auditHash(error instanceof Error ? error.message : String(error)),
  });
  return openAiInternalError(requestId);
}

export function buildServeOptions(
  config: Config,
  dependencies: AppDependencies,
): Bun.Serve.Options<undefined> {
  return {
    hostname: config.host,
    port: config.port,
    // Compiled binaries rarely set NODE_ENV; never fall back to Bun's
    // development error pages with stack traces.
    development: false,
    // Let the runtime refuse oversized bodies before buffering them; the
    // streaming ingress check stays as defense in depth.
    maxRequestBodySize: config.max_request_body_bytes,
    fetch: createApp(config, dependencies),
    error: handleServeError,
  };
}

export interface ServerHandle extends ShutdownServer {
  readonly hostname?: string;
  readonly port?: number;
}

export interface ServerSignalSource {
  on(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
}

export interface StartServerOptions<S extends ServerHandle> {
  /** Server factory; defaults to `Bun.serve`. */
  readonly serve?: (options: Bun.Serve.Options<undefined>) => S;
  readonly factories?: ServerDependencyFactories;
  /** Where SIGTERM/SIGINT handlers are registered; defaults to `process`. */
  readonly signalSource?: ServerSignalSource;
  /** Terminates the process after shutdown; defaults to `process.exit`. */
  readonly exit?: (code: number) => void;
  readonly drainTimeoutMs?: number;
  readonly drainPollMs?: number;
  readonly lockOptions?: InstanceLockAcquireOptions;
}

/**
 * Starts the gateway with its single-instance lock, background maintenance,
 * and one shutdown routine shared by SIGTERM/SIGINT (exit 0) and lock
 * compromise (exit 1, fail closed): stop accepting, drain in-flight requests
 * within `drainTimeoutMs`, force-close, stop maintenance, release the lock,
 * exit.
 */
export function startServer<S extends ServerHandle = Bun.Server<undefined>>(
  config: Config,
  options: StartServerOptions<S> = {},
): S {
  const exit = options.exit ?? ((code: number): void => process.exit(code));
  const lease: ServiceInstanceLease | undefined = acquireServiceInstanceLock(config, {
    ...(options.lockOptions ?? {}),
    exit,
  });
  try {
    const dependencies = buildServerDeps(config, options.factories);
    const serve =
      options.serve ??
      ((serveOptions: Bun.Serve.Options<undefined>): S => Bun.serve(serveOptions) as unknown as S);
    const server = serve(buildServeOptions(config, dependencies));
    // Capture the runtime's own stop before the lifecycle bindings wrap it so
    // the shutdown routine controls when the lock is released.
    const rawStop = server.stop.bind(server);
    const shutdown = createGracefulShutdown({
      server: {
        stop: rawStop,
        get pendingRequests(): number | undefined {
          return server.pendingRequests;
        },
      },
      ...(dependencies.accountMaintenance ? { maintenance: dependencies.accountMaintenance } : {}),
      ...(lease ? { lease } : {}),
      exit,
      drainTimeoutMs: options.drainTimeoutMs ?? DEFAULT_SHUTDOWN_DRAIN_MS,
      ...(options.drainPollMs !== undefined ? { drainPollMs: options.drainPollMs } : {}),
    });
    const leasedServer = bindServiceInstanceLease(server, lease);
    const managedServer = bindAccountMaintenanceLifecycle(
      leasedServer,
      dependencies.accountMaintenance,
    );
    lease?.onCompromised(() => {
      void shutdown("lock_compromised", 1);
    });
    const signalSource = options.signalSource ?? process;
    signalSource.on("SIGTERM", () => {
      void shutdown("SIGTERM", 0);
    });
    signalSource.on("SIGINT", () => {
      void shutdown("SIGINT", 0);
    });
    return managedServer;
  } catch (error) {
    lease?.release();
    throw error;
  }
}
