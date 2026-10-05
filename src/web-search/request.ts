import type { Config } from "../config/schema.js";
import { resolveModelVariant } from "../kiro/models.js";
import type { CanonicalProtocol, CanonicalRequest } from "../protocol/canonical.js";
import { type HostedWebSearchDeclaration, isVerifiedWebSearchModel } from "./declarations.js";
import { WebSearchError } from "./errors.js";
import { type HostedHistory, type HostedOwnerLock, restoreHostedHistory } from "./history.js";
import { HostedSearchSession, type WebSearchDependencies } from "./session.js";

/**
 * Prepares one public request that declares hosted search or carries hosted
 * search history. The current declaration is the only authorization for new
 * searches; history is rebuilt from authenticated snapshots before anything
 * is dispatched and stays readable when new searches are disabled.
 */

export interface HostedRequestPreparation {
  readonly body: CanonicalRequest;
  readonly session?: HostedSearchSession;
  readonly ownerLock?: HostedOwnerLock;
  readonly restoredCallIds: readonly string[];
}

export function prepareHostedRequest(input: {
  readonly protocol: Extract<CanonicalProtocol, "responses" | "anthropic-messages">;
  readonly body: CanonicalRequest;
  readonly declaration?: HostedWebSearchDeclaration;
  readonly history: HostedHistory;
  readonly config: Config;
  readonly webSearch?: WebSearchDependencies;
  readonly tenantId?: string;
  readonly reserveBytes?: (bytes: number) => boolean;
  readonly deadlineAt: number;
  readonly includeSources: boolean;
  /** A stored response that will reference this request's snapshots. */
  readonly minimumExpiresAt?: number;
}): HostedRequestPreparation {
  const { declaration, history } = input;
  if (declaration === undefined && history.calls.length === 0 && history.citations.length === 0) {
    return { body: input.body, restoredCallIds: [] };
  }
  if (declaration !== undefined) {
    if (!input.config.web_search_enabled) {
      throw new WebSearchError(
        "Web search is not enabled on this provider",
        "web_search_disabled",
        400,
        declaration.path,
      );
    }
    let wireModel: string | undefined;
    try {
      wireModel = resolveModelVariant(input.body.model).wireId;
    } catch {
      wireModel = undefined;
    }
    if (wireModel === undefined || !isVerifiedWebSearchModel(input.protocol, wireModel)) {
      throw new WebSearchError(
        `Web search is not available for model ${input.body.model}`,
        "unsupported_web_search_model",
        400,
        "model",
      );
    }
  }
  const { webSearch, tenantId } = input;
  if (webSearch === undefined || tenantId === undefined) {
    throw new WebSearchError(
      "Web search history storage is unavailable",
      "web_search_store_unavailable",
      503,
    );
  }
  const restored = restoreHostedHistory({
    body: input.body,
    history,
    protocol: input.protocol,
    tenantId,
    store: webSearch.store,
    keyring: webSearch.keyring,
    maxHistoryBytes: input.config.web_search_max_history_bytes,
    ...(input.reserveBytes ? { reserveBytes: input.reserveBytes } : {}),
    ...(declaration ? { declaration } : {}),
  });
  const restoredCallIds = history.calls.map((call) => call.callId);
  if (input.minimumExpiresAt !== undefined) {
    // History a new stored response refers to must outlive that response.
    for (const callId of restoredCallIds) {
      if (webSearch.store.extend(tenantId, callId, input.minimumExpiresAt)) continue;
      // Report why it cannot be kept (expired, removed, storage); never store
      // a response whose history would end first.
      webSearch.store.read(tenantId, callId);
      throw new WebSearchError(
        "Web search history could not be kept for the stored response",
        "web_search_store_unavailable",
        503,
      );
    }
  }
  const ownerLock = restored.ownerLock ? { ownerLock: restored.ownerLock } : {};
  if (declaration === undefined) return { body: restored.body, ...ownerLock, restoredCallIds };
  const session = new HostedSearchSession({
    protocol: input.protocol,
    declaration,
    tenantId,
    config: input.config,
    store: webSearch.store,
    keyring: webSearch.keyring,
    ...(webSearch.definitions ? { definitions: webSearch.definitions } : {}),
    ...(webSearch.fetch ? { fetch: webSearch.fetch } : {}),
    includeSources: input.includeSources,
    pending: restored.pending,
    historySources: restored.historySources,
    ...(input.minimumExpiresAt !== undefined ? { minimumExpiresAt: input.minimumExpiresAt } : {}),
    ...(input.reserveBytes ? { reserveBytes: input.reserveBytes } : {}),
    deadlineAt: input.deadlineAt,
  });
  return { body: restored.body, session, ...ownerLock, restoredCallIds };
}
