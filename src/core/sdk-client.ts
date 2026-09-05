import { createHash } from "node:crypto";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import {
  CodeWhispererStreamingClient,
  type CodeWhispererStreamingClientConfig,
  type GenerateAssistantResponseCommand,
  type GenerateAssistantResponseCommandInput,
  type GenerateAssistantResponseCommandOutput,
} from "@aws/codewhisperer-streaming-client";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { HttpRequest } from "@smithy/protocol-http";
import type { BuildMiddleware } from "@smithy/types";
import { HttpsProxyAgent } from "https-proxy-agent";
import { KIRO_CONSTANTS } from "../kiro/constants.js";
import type { Effort, KiroAuthDetails } from "../kiro/types.js";
import { auditHash, auditLog } from "./audit-log.js";

interface ClientCacheEntry {
  readonly client: CodeWhispererStreamingClient;
  readonly accessTokenHash: string;
}

interface TransportCacheEntry {
  readonly handler: NodeHttpHandler;
}

/** Clients are keyed by transport: one credential-bound client per account transport. */
const clientCache = new Map<string, ClientCacheEntry>();
const transportCache = new Map<string, TransportCacheEntry>();
const transportKeysByAccount = new Map<string, Set<string>>();
/** The pipeline owns retries; a second retry layer in the SDK only obscures backoff. */
const SDK_MAX_ATTEMPTS = 1;
const SDK_MAX_SOCKETS = 50;
export const KIRO_RUNTIME_GENERATE_TARGET = "KiroRuntimeService.GenerateAssistantResponse";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merges request-field additions (for example effort) into an existing
 * additionalModelRequestFields object without dropping unrelated keys.
 */
export function mergeModelRequestFields(
  existing: unknown,
  additions: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const merged = isRecord(existing) ? { ...existing } : {};
  for (const [key, value] of Object.entries(additions)) {
    const current = merged[key];
    merged[key] =
      isRecord(current) && isRecord(value) ? mergeModelRequestFields(current, value) : value;
  }
  return merged;
}

function requestBodyText(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  throw new TypeError("Kiro systemPrompt injection requires a serialized JSON request body");
}

/**
 * Retargets the public SDK command to Kiro Runtime's newer operation and adds
 * its experimental top-level `systemPrompt` field after the public serializer
 * runs and before Content-Length and bearer signing.
 *
 * The npm CodeWhisperer client still targets
 * `AmazonCodeWhispererStreamingService.GenerateAssistantResponse`; Kiro
 * CLI V3/KAS targets `KiroRuntimeService.GenerateAssistantResponse` on the
 * same host. Keeping the middleware command-scoped prevents prompt leakage
 * through cached clients.
 */
export interface KiroRuntimeRequestOptions {
  readonly agentMode?: string;
  readonly systemPrompt?: string;
}

export function attachKiroRuntimeRequest(
  command: GenerateAssistantResponseCommand,
  options: KiroRuntimeRequestOptions = {},
): void {
  if (options.systemPrompt !== undefined && options.systemPrompt.length === 0) {
    throw new TypeError("Kiro systemPrompt must contain at least one byte");
  }
  const middleware: BuildMiddleware<
    GenerateAssistantResponseCommandInput,
    GenerateAssistantResponseCommandOutput
  > = (next) => async (args) => {
    if (!(args.request instanceof HttpRequest)) {
      throw new TypeError("Kiro systemPrompt injection requires a Smithy HttpRequest");
    }
    const body: unknown = JSON.parse(requestBodyText(args.request.body));
    if (!isRecord(body)) {
      throw new TypeError("Kiro systemPrompt injection requires a JSON object request");
    }
    if (!isRecord(body.conversationState)) {
      throw new TypeError("Kiro systemPrompt injection requires conversationState");
    }
    const conversationId = body.conversationState.conversationId;
    if (typeof conversationId !== "string" || conversationId.length === 0) {
      throw new TypeError("Kiro systemPrompt injection requires conversationId");
    }
    const agentMode = options.agentMode ?? args.request.headers["x-amzn-kiro-agent-mode"] ?? "vibe";
    delete args.request.headers["x-amzn-kiro-agent-mode"];
    args.request.path = "/";
    args.request.headers["content-type"] = "application/x-amz-json-1.0";
    args.request.headers["x-amz-target"] = KIRO_RUNTIME_GENERATE_TARGET;
    args.request.headers["x-amzn-kiro-client-attribution"] = "unrecognized";
    args.request.headers["x-kiro-attempt"] = "1;max=3";
    args.request.body = JSON.stringify({
      ...body,
      agentMode,
      conversationState: {
        ...body.conversationState,
        rootConversationId:
          typeof body.conversationState.rootConversationId === "string" &&
          body.conversationState.rootConversationId.length > 0
            ? body.conversationState.rootConversationId
            : conversationId,
      },
      ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    });
    return next(args);
  };
  command.middlewareStack.addRelativeTo(middleware, {
    relation: "after",
    toMiddleware: "serializerMiddleware",
    name: "injectKiroSystemPrompt",
    override: true,
  });
}

export function attachKiroRuntimeSystemPrompt(
  command: GenerateAssistantResponseCommand,
  systemPrompt: string,
): void {
  attachKiroRuntimeRequest(command, { systemPrompt });
}

/** @deprecated Use attachKiroRuntimeSystemPrompt. */
export const attachKiroSystemPrompt = attachKiroRuntimeSystemPrompt;

export function buildClientConfig(
  auth: KiroAuthDetails,
  region: string,
  resolvedEndpoint: string,
  proxyUrl?: string,
  requestHandler: NodeHttpHandler = createRequestHandler(proxyUrl, false),
): CodeWhispererStreamingClientConfig {
  return {
    region,
    endpoint: resolvedEndpoint,
    token: () => Promise.resolve({ token: auth.access }),
    maxAttempts: SDK_MAX_ATTEMPTS,
    retryMode: "standard",
    customUserAgent: [[KIRO_CONSTANTS.USER_AGENT]],
    requestHandler,
  };
}

type HandleArguments = Parameters<NodeHttpHandler["handle"]>;

interface DestroyableBody {
  readonly destroyed?: boolean;
  destroy(): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  once(event: "close", listener: () => void): unknown;
}

function isDestroyableBody(value: unknown): value is DestroyableBody {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "destroy") === "function" &&
    typeof Reflect.get(value, "on") === "function" &&
    typeof Reflect.get(value, "once") === "function"
  );
}

function isEventTargetSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "addEventListener") === "function" &&
    typeof Reflect.get(value, "aborted") === "boolean"
  );
}

/**
 * Re-arms abort on the streamed response body. NodeHttpHandler only destroys
 * the request while the listener it registered on the ClientRequest is alive,
 * and Bun emits ClientRequest "close" as soon as the response starts, so an
 * abort that fires while an event-stream body is still open never reaches the
 * socket. Destroying the IncomingMessage closes the upstream connection and
 * rejects any pending event-stream read (A1).
 */
function bindBodyAbort(body: unknown, signal: unknown): void {
  if (!isDestroyableBody(body) || !isEventTargetSignal(signal)) return;
  const onAbort = (): void => {
    if (body.destroyed) return;
    // Bun emits "aborted" on a destroyed IncomingMessage; never let it escape.
    body.on("error", () => undefined);
    body.destroy();
  };
  if (signal.aborted) {
    onAbort();
    return;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  body.once("close", () => signal.removeEventListener("abort", onAbort));
}

export class AbortableBodyHttpHandler extends NodeHttpHandler {
  override async handle(
    request: HandleArguments[0],
    options?: HandleArguments[1],
  ): ReturnType<NodeHttpHandler["handle"]> {
    const result = await super.handle(request, options);
    bindBodyAbort(result.response.body, options?.abortSignal);
    return result;
  }
}

function createRequestHandler(proxyUrl: string | undefined, keepAlive: boolean): NodeHttpHandler {
  if (proxyUrl) {
    const proxyAgent = new HttpsProxyAgent(proxyUrl, {
      keepAlive,
      maxSockets: SDK_MAX_SOCKETS,
    });
    return new AbortableBodyHttpHandler({
      httpAgent: proxyAgent,
      httpsAgent: proxyAgent,
    });
  }
  return new AbortableBodyHttpHandler({
    httpAgent: new HttpAgent({ keepAlive, maxSockets: SDK_MAX_SOCKETS }),
    httpsAgent: new HttpsAgent({ keepAlive, maxSockets: SDK_MAX_SOCKETS }),
  });
}

function fallbackAccountKey(auth: KiroAuthDetails): string {
  return createHash("sha256")
    .update("kiro-provider-sdk-account-v1\0")
    .update(auth.email ?? auth.refresh)
    .digest("hex");
}

function accessTokenHash(accessToken: string): string {
  return createHash("sha256")
    .update("kiro-provider-sdk-access-token-v1\0")
    .update(accessToken)
    .digest("hex");
}

function rememberTransportKey(accountKey: string, transportKey: string): void {
  const keys = transportKeysByAccount.get(accountKey) ?? new Set<string>();
  keys.add(transportKey);
  transportKeysByAccount.set(accountKey, keys);
}

/**
 * Builds or reuses the SDK client for one account transport.
 *
 * `effort` no longer shapes the client: effort request fields are merged into
 * the command input by the pipeline. The parameter is kept so existing
 * factories stay source-compatible and it is recorded in the pool audit event.
 */
export function createSdkClient(
  auth: KiroAuthDetails,
  region: string,
  effort?: Effort,
  endpoint?: string,
  proxyUrl?: string,
  accountId?: string,
  httpKeepAlive = false,
): CodeWhispererStreamingClient {
  const resolvedEndpoint = endpoint ?? `https://q.${region}.amazonaws.com`;
  const accountKey = accountId ?? fallbackAccountKey(auth);
  const transportKey = JSON.stringify([
    accountKey,
    region,
    resolvedEndpoint,
    proxyUrl ?? null,
    httpKeepAlive,
  ]);
  let transport = transportCache.get(transportKey);
  const transportPoolHit = transport !== undefined;
  if (!transport) {
    transport = { handler: createRequestHandler(proxyUrl, httpKeepAlive) };
    transportCache.set(transportKey, transport);
    rememberTransportKey(accountKey, transportKey);
  }
  const cachedEntry = clientCache.get(transportKey);
  const currentAccessTokenHash = accessTokenHash(auth.access);
  const tokenChanged =
    cachedEntry !== undefined && cachedEntry.accessTokenHash !== currentAccessTokenHash;
  if (tokenChanged) clientCache.delete(transportKey);
  const cached = tokenChanged ? undefined : cachedEntry;
  if (accountId !== undefined) {
    auditLog("info", "sdk_connection_pool_selected", {
      account_hash: auditHash(accountId),
      region,
      effort: effort ?? null,
      http_keep_alive: httpKeepAlive,
      transport_pool_hit: transportPoolHit,
      sdk_client_pool_hit: cached !== undefined,
      sdk_client_rebuilt_for_token_change: tokenChanged,
    });
  }
  if (cached) return cached.client;

  const client = new CodeWhispererStreamingClient(
    buildClientConfig(auth, region, resolvedEndpoint, proxyUrl, transport.handler),
  );

  client.middlewareStack.add(
    (next) => async (args) => {
      if (args.request instanceof HttpRequest) {
        args.request.headers["x-amzn-kiro-agent-mode"] = "vibe";
      }
      return next(args);
    },
    { step: "build", name: "addKiroHeaders" },
  );

  clientCache.set(transportKey, {
    client,
    accessTokenHash: currentAccessTokenHash,
  });
  return client;
}

/**
 * Destroys every transport built for one account and drops its clients.
 * Called when the account disappears from the database so its sockets and
 * agents do not outlive it.
 */
export function evictSdkClientsForAccount(accountId: string): void {
  const keys = transportKeysByAccount.get(accountId);
  if (!keys) return;
  transportKeysByAccount.delete(accountId);
  for (const transportKey of keys) {
    const transport = transportCache.get(transportKey);
    if (transport) {
      try {
        transport.handler.destroy();
      } catch {
        // A transport that fails to destroy must not block eviction.
      }
      transportCache.delete(transportKey);
    }
    clientCache.delete(transportKey);
  }
  auditLog("info", "sdk_clients_evicted", {
    account_hash: auditHash(accountId),
    transport_count: keys.size,
  });
}

export function clearSdkClientCache(): void {
  for (const entry of transportCache.values()) entry.handler.destroy();
  clientCache.clear();
  transportCache.clear();
  transportKeysByAccount.clear();
}
