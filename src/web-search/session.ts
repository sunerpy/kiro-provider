import { randomBytes } from "node:crypto";
import type { Config } from "../config/schema.js";
import { auditLog } from "../core/audit-log.js";
import { resolveProxyUrl } from "../core/proxy.js";
import type { SdkReasoningCapture } from "../kiro/transform/streaming/sdk-stream-runtime.js";
import type { KiroAuthDetails, ManagedAccount } from "../kiro/types.js";
import type {
  CanonicalAssistantOutput,
  CanonicalRequest,
  CanonicalToolDeclaration,
} from "../protocol/canonical.js";
import type { CanonicalOutputEventV2 } from "../protocol/output-v2.js";
import type { ReasoningReplayKeyring } from "../reasoning/keyring.js";
import { citedTextExcerpt } from "./citations.js";
import {
  citationVisibleFingerprint,
  resultVisibleFingerprint,
  sealReference,
  sourceIdentity,
} from "./crypto.js";
import type { HostedWebSearchDeclaration } from "./declarations.js";
import { WebSearchError } from "./errors.js";
import { hostedSegmentFingerprint } from "./fingerprint.js";
import {
  callWebSearch,
  listWebSearchTool,
  type McpCallContext,
  type WebSearchCallOutcome,
  type WebSearchErrorCode,
  type WebSearchFetch,
  type WebSearchToolDefinition,
  webSearchErrorCode,
  webSearchQueryFingerprint,
} from "./mcp-client.js";
import { type ProjectedSource, pageAge, projectSearchResult } from "./projection.js";
import type {
  ClaimedWebSearchSnapshot,
  WebSearchPendingReason,
  WebSearchSnapshot,
  WebSearchSnapshotBinding,
  WebSearchSnapshotFailure,
  WebSearchSnapshotStore,
} from "./snapshot-store.js";

/** The hosted tool keeps the backend's own name on the wire. */
export const HOSTED_WEB_SEARCH_WIRE_NAME = "web_search";
/** Argument validation is semantic (empty/oversized query), never a schema rejection. */
export const HOSTED_WEB_SEARCH_ARGUMENT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
};
const TOOL_DEFINITION_TTL_MS = 15 * 60_000;

/** Per-process cache of the backend `tools/list` declaration per account and region. */
export class WebSearchToolDefinitionCache {
  readonly #entries = new Map<
    string,
    { readonly definition: WebSearchToolDefinition; readonly expiresAt: number }
  >();
  readonly #inflight = new Map<string, Promise<WebSearchToolDefinition>>();

  constructor(
    private readonly ttlMs = TOOL_DEFINITION_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async get(
    key: string,
    load: () => Promise<WebSearchToolDefinition>,
  ): Promise<WebSearchToolDefinition> {
    const cached = this.#entries.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.definition;
    const running = this.#inflight.get(key);
    if (running !== undefined) return running;
    const loading = load().then(
      (definition) => {
        this.#entries.set(key, { definition, expiresAt: this.now() + this.ttlMs });
        this.#inflight.delete(key);
        return definition;
      },
      (error: unknown) => {
        this.#inflight.delete(key);
        throw error;
      },
    );
    this.#inflight.set(key, loading);
    return loading;
  }

  clear(): void {
    this.#entries.clear();
  }
}

export const sharedWebSearchToolDefinitions = new WebSearchToolDefinitionCache();

/** Process-wide web search services a route needs to build a request session. */
export interface WebSearchDependencies {
  readonly store: WebSearchSnapshotStore;
  /** The protected reasoning replay keyring; web search derives its own subkeys. */
  readonly keyring: () => ReasoningReplayKeyring;
  readonly fetch?: WebSearchFetch;
  readonly definitions?: WebSearchToolDefinitionCache;
}

/**
 * Snapshot capacity charged when a call is recorded, before it runs: the
 * completed payload holds the model text and the projected sources, each
 * bounded by `web_search_max_result_bytes`, plus a fixed binding overhead.
 */
export function webSearchReservationBytes(
  config: Pick<Config, "web_search_max_result_bytes">,
): number {
  return config.web_search_max_result_bytes * 2 + 64 * 1024;
}

/** A deferred or paused call from history that this request must execute first. */
export interface PendingHostedCall {
  readonly callId: string;
  readonly query: string;
  readonly status: "deferred" | "paused";
  /** Canonical message and content-part index of its placeholder tool result. */
  readonly messageIndex: number;
  readonly partIndex: number;
}

export interface HostedSearchSessionInit {
  readonly protocol: "responses" | "anthropic-messages";
  /** Current declaration: the only authorization for new calls in this request. */
  readonly declaration?: HostedWebSearchDeclaration;
  readonly tenantId: string;
  readonly config: Config;
  readonly store: WebSearchSnapshotStore;
  readonly keyring: () => ReasoningReplayKeyring;
  readonly definitions?: WebSearchToolDefinitionCache;
  readonly fetch?: WebSearchFetch;
  readonly includeSources: boolean;
  readonly pending?: readonly PendingHostedCall[];
  /** Sources of completed calls restored from this request's history. */
  readonly historySources?: ReadonlyArray<{
    readonly callId: string;
    readonly sources: readonly ProjectedSource[];
  }>;
  /** A stored Responses resource that will reference these snapshots. */
  readonly minimumExpiresAt?: number;
  /** Shared admission budget for retrieved result bytes. */
  readonly reserveBytes?: (bytes: number) => boolean;
  /** Request deadline; bounds every RPC together with web_search_timeout_ms. */
  readonly deadlineAt: number;
  readonly now?: () => number;
}

export interface ExecutedHostedCall {
  readonly callId: string;
  readonly wireId: string;
  readonly ok: boolean;
  /** Exact text handed back to Kiro as this call's tool result. */
  readonly modelText: string;
  readonly events: readonly CanonicalOutputEventV2[];
  readonly dispatched: boolean;
}

function v2<T extends CanonicalOutputEventV2["type"]>(
  type: T,
  body: Omit<
    Extract<CanonicalOutputEventV2, { readonly type: T }>,
    "canonicalOutputVersion" | "type"
  >,
): CanonicalOutputEventV2 {
  return { canonicalOutputVersion: 2, type, ...body } as CanonicalOutputEventV2;
}

function parseQuery(input: string): unknown {
  try {
    const parsed: unknown = JSON.parse(input);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { readonly query?: unknown }).query
      : undefined;
  } catch {
    return undefined;
  }
}

function errorModelText(code: WebSearchErrorCode): string {
  return JSON.stringify({ error: code });
}

export class HostedSearchSession {
  readonly protocol: "responses" | "anthropic-messages";
  readonly declaration: HostedWebSearchDeclaration | undefined;
  readonly includeSources: boolean;
  readonly #init: HostedSearchSessionInit;
  readonly #publicIds = new Map<string, string>();
  #generationKey = randomBytes(8).toString("hex");
  readonly #pendingDone = new Map<string, ExecutedHostedCall>();
  /** Calls this request claimed whose outcome is not recorded yet. */
  readonly #active = new Map<string, ClaimedWebSearchSnapshot>();
  readonly #sources = new Map<string, readonly ProjectedSource[]>();
  #definition: WebSearchToolDefinition | undefined;
  #capture: SdkReasoningCapture | undefined;
  #dispatched = 0;
  #succeeded = 0;

  constructor(init: HostedSearchSessionInit) {
    this.#init = init;
    this.protocol = init.protocol;
    this.declaration = init.declaration;
    this.includeSources = init.includeSources;
  }

  get tenantId(): string {
    return this.#init.tenantId;
  }

  get config(): Config {
    return this.#init.config;
  }

  get pending(): readonly PendingHostedCall[] {
    return this.#init.pending ?? [];
  }

  get historySources(): ReadonlyArray<{
    readonly callId: string;
    readonly sources: readonly ProjectedSource[];
  }> {
    return this.#init.historySources ?? [];
  }

  get webSearchRequests(): number {
    return this.#succeeded;
  }

  get dispatchedCalls(): number {
    return this.#dispatched;
  }

  get toolDefinitionFingerprint(): string | undefined {
    return this.#definition?.fingerprint;
  }

  now(): number {
    return (this.#init.now ?? Date.now)();
  }

  /** Remaining request time, never negative. */
  remainingMs(): number {
    return Math.max(0, this.#init.deadlineAt - this.now());
  }

  /** Effective per-request ceiling on dispatched searches. */
  get callBudget(): number {
    const providerLimit = this.#init.config.web_search_max_calls;
    const maxUses = this.declaration?.maxUses;
    return maxUses === undefined ? providerLimit : Math.min(maxUses, providerLimit);
  }

  /** Starts the next generation; its Responses items share the returned key. */
  beginGeneration(): string {
    this.#generationKey = randomBytes(8).toString("hex");
    return this.#generationKey;
  }

  publicIdFor(wireId: string): string {
    const existing = this.#publicIds.get(wireId);
    if (existing !== undefined) return existing;
    const id =
      this.protocol === "responses"
        ? `ws_${this.#generationKey}${randomBytes(8).toString("hex")}`
        : `srvtoolu_${randomBytes(16).toString("hex")}`;
    this.#publicIds.set(wireId, id);
    return id;
  }

  isHostedWireName(name: string): boolean {
    return this.declaration !== undefined && name === HOSTED_WEB_SEARCH_WIRE_NAME;
  }

  /**
   * Wraps the ordinary output fingerprint so hosted segments use their own
   * version. `restore` maps client tool calls to their public identities exactly
   * as the ordinary fingerprint does; hosted calls take their public call id.
   */
  fingerprint(
    output: CanonicalAssistantOutput,
    restore: (output: CanonicalAssistantOutput) => CanonicalAssistantOutput,
    ordinary: (output: CanonicalAssistantOutput) => string,
  ): string {
    const hosted = output.toolCalls.filter((call) => this.isHostedWireName(call.name));
    if (hosted.length === 0) return ordinary(output);
    const clients = restore({
      text: output.text,
      toolCalls: output.toolCalls.filter((call) => !this.isHostedWireName(call.name)),
    });
    return hostedSegmentFingerprint(
      {
        text: output.text,
        toolCalls: [
          ...hosted.map((call) => ({
            id: this.publicIdFor(call.id),
            name: "web_search",
            input: call.input,
          })),
          ...clients.toolCalls,
        ],
      },
      hosted.map((call) => this.publicIdFor(call.id)),
    );
  }

  recordCapture(capture: SdkReasoningCapture | undefined): void {
    this.#capture = capture;
  }

  takeCapture(): SdkReasoningCapture | undefined {
    const capture = this.#capture;
    this.#capture = undefined;
    return capture;
  }

  mcpContext(auth: KiroAuthDetails, region: string, signal: AbortSignal): McpCallContext {
    if (!auth.profileArn) {
      throw new WebSearchError(
        "Web search requires an account with a bound Kiro profile",
        "web_search_unavailable",
        503,
      );
    }
    return {
      accessToken: auth.access,
      profileArn: auth.profileArn,
      region,
      ...(this.#init.config.test_upstream_endpoint !== undefined
        ? { endpoint: this.#init.config.test_upstream_endpoint }
        : {}),
      ...(resolveProxyUrl(this.#init.config) !== undefined
        ? { proxyUrl: resolveProxyUrl(this.#init.config) }
        : {}),
      ...(this.#init.fetch ? { fetch: this.#init.fetch } : {}),
      signal,
      timeoutMs: Math.max(1, Math.min(this.#init.config.web_search_timeout_ms, this.remainingMs())),
    };
  }

  /** The backend's declaration for this owner account, fetched through the provider client. */
  async toolDeclaration(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    region: string,
    signal: AbortSignal,
  ): Promise<CanonicalToolDeclaration | undefined> {
    const declaration = this.declaration;
    if (declaration === undefined) return undefined;
    const definitions = this.#init.definitions ?? sharedWebSearchToolDefinitions;
    let definition: WebSearchToolDefinition;
    try {
      definition = await definitions.get(`${account.id}\0${region}`, () =>
        listWebSearchTool(this.mcpContext(auth, region, signal)),
      );
    } catch (error) {
      if (error instanceof WebSearchError) throw error;
      if (signal.aborted) throw signal.reason;
      throw new WebSearchError(
        "Kiro web search is unavailable for the selected account",
        "web_search_unavailable",
        503,
      );
    }
    this.#definition = definition;
    return {
      publicType: "function",
      name: HOSTED_WEB_SEARCH_WIRE_NAME,
      wireName: HOSTED_WEB_SEARCH_WIRE_NAME,
      description: definition.description,
      descriptionPath: declaration.path,
      inputSchema: definition.inputSchema,
      path: declaration.path,
      sourceMetadata: { hosted: "web_search" },
    };
  }

  binding(input: {
    readonly wireModel: string;
    readonly account: ManagedAccount;
    readonly region: string;
    readonly profileArn?: string;
    readonly conversationId: string;
    readonly wireId: string;
    readonly group: readonly string[];
    readonly query: string;
  }): WebSearchSnapshotBinding {
    return {
      protocol: this.protocol,
      wireModel: input.wireModel,
      owner: {
        accountId: input.account.id,
        region: input.region,
        ...(input.profileArn !== undefined ? { profileArn: input.profileArn } : {}),
        conversationId: input.conversationId,
      },
      wire: { toolUseId: input.wireId, toolName: HOSTED_WEB_SEARCH_WIRE_NAME, group: input.group },
      declarationFingerprint: this.declaration?.fingerprint ?? "",
      toolDefinitionFingerprint: this.#definition?.fingerprint ?? "",
      queryFingerprint: webSearchQueryFingerprint(input.query),
    };
  }

  snapshotExpiresAt(): number {
    return Math.max(
      this.now() + this.#init.config.web_search_replay_ttl_ms,
      this.#init.minimumExpiresAt ?? 0,
    );
  }

  /**
   * Records the calls this response publishes without executing them, all or
   * none: they are published only after every one of them is recorded.
   */
  deferGroup(
    calls: ReadonlyArray<{
      readonly callId: string;
      readonly status: "deferred" | "paused";
      readonly reason: WebSearchPendingReason;
      readonly binding: WebSearchSnapshotBinding;
    }>,
  ): void {
    const recorded: Array<{ readonly callId: string; readonly status: "deferred" | "paused" }> = [];
    try {
      for (const call of calls) {
        this.#init.store.prepare({
          tenantId: this.tenantId,
          callId: call.callId,
          status: call.status,
          binding: call.binding,
          pendingReason: call.reason,
          expiresAt: this.snapshotExpiresAt(),
        });
        recorded.push(call);
      }
    } catch (error) {
      // Nothing was published: leave no pending call (or capacity) behind; a
      // row that cannot be removed becomes uncertain so it can never run.
      for (const call of recorded) {
        const expected = { generation: 1, statuses: [call.status] };
        if (!this.#init.store.discard(this.tenantId, call.callId, expected)) {
          this.#init.store.retireUnpublished(this.tenantId, call.callId, expected);
        }
      }
      throw error;
    }
  }

  #sourceViews(callId: string, sources: readonly ProjectedSource[]) {
    const keyring = this.protocol === "anthropic-messages" ? this.#init.keyring() : undefined;
    return sources.map((source) => {
      const age = pageAge(source);
      return {
        ordinal: source.ordinal,
        url: source.url,
        title: source.title,
        pageAge: age,
        ...(keyring !== undefined
          ? {
              encryptedContent: sealReference(keyring, this.tenantId, {
                purpose: "result",
                callId,
                ordinal: source.ordinal,
                sourceIdentity: sourceIdentity(source),
                visibleFingerprint: resultVisibleFingerprint({
                  url: source.url,
                  title: source.title,
                  pageAge: age,
                }),
              }),
            }
          : {}),
      };
    });
  }

  /** Public citation fields for a cited source; Messages also seals `encrypted_index`. */
  citation(callId: string, source: ProjectedSource) {
    const citedText = citedTextExcerpt(source);
    return {
      callId,
      ordinal: source.ordinal,
      url: source.url,
      title: source.title,
      citedText,
      ...(this.protocol === "anthropic-messages"
        ? {
            encryptedIndex: sealReference(this.#init.keyring(), this.tenantId, {
              purpose: "citation",
              callId,
              ordinal: source.ordinal,
              sourceIdentity: sourceIdentity(source),
              visibleFingerprint: citationVisibleFingerprint({
                url: source.url,
                title: source.title,
                citedText,
              }),
            }),
          }
        : {}),
    };
  }

  #failure(
    snapshot: ClaimedWebSearchSnapshot,
    code: WebSearchErrorCode,
    failure: WebSearchSnapshotFailure["failure"],
    dispatched: boolean,
  ): ExecutedHostedCall {
    const modelText = errorModelText(code);
    auditLog("info", "web_search_call_finished", {
      protocol: this.protocol,
      outcome: "error",
      error_code: code,
      failure,
      dispatched,
    });
    try {
      this.#init.store.fail(this.tenantId, snapshot, { code, failure, modelText });
    } catch (error) {
      this.#init.store.markUncertain(this.tenantId, snapshot);
      throw error instanceof WebSearchError
        ? error
        : new WebSearchError(
            "Web search snapshot storage is unavailable",
            "web_search_store_unavailable",
            503,
          );
    }
    return {
      callId: snapshot.callId,
      wireId: snapshot.wire.toolUseId,
      ok: false,
      modelText,
      dispatched,
      events: [v2("search_call_failed", { callId: snapshot.callId, errorCode: code })],
    };
  }

  /**
   * Executes one claimed call: budget, query validation, byte reservation, the
   * RPC under the request cancellation chain, filtering, and the snapshot
   * outcome. A cancellation after dispatch records `uncertain` and rethrows.
   */
  async execute(
    snapshot: ClaimedWebSearchSnapshot,
    query: unknown,
    auth: KiroAuthDetails,
    region: string,
    signal: AbortSignal,
  ): Promise<ExecutedHostedCall> {
    try {
      return await this.#execute(snapshot, query, auth, region, signal);
    } finally {
      // Completed, failed or uncertain: the outcome is recorded either way.
      this.#active.delete(snapshot.callId);
    }
  }

  async #execute(
    snapshot: ClaimedWebSearchSnapshot,
    query: unknown,
    auth: KiroAuthDetails,
    region: string,
    signal: AbortSignal,
  ): Promise<ExecutedHostedCall> {
    if (this.#dispatched >= this.callBudget) {
      return this.#failure(snapshot, "max_uses_exceeded", "max_uses_exceeded", false);
    }
    if (typeof query !== "string") {
      return this.#failure(snapshot, "invalid_tool_input", "query_empty", false);
    }
    const maxBytes = this.#init.config.web_search_max_result_bytes;
    if (this.#init.reserveBytes !== undefined && !this.#init.reserveBytes(maxBytes)) {
      return this.#failure(snapshot, "too_many_requests", "http_throttled", false);
    }
    let outcome: WebSearchCallOutcome;
    try {
      const context = this.mcpContext(auth, region, signal);
      this.#dispatched += 1;
      outcome = await callWebSearch(context, query, maxBytes);
    } catch (error) {
      this.#init.store.markUncertain(this.tenantId, snapshot);
      throw error;
    }
    if (!outcome.ok) {
      if (outcome.failure === "aborted" || signal.aborted) {
        this.#init.store.markUncertain(this.tenantId, snapshot);
        throw signal.reason ?? new DOMException("Web search was cancelled", "AbortError");
      }
      if (!outcome.dispatched) this.#dispatched -= 1;
      return this.#failure(
        snapshot,
        webSearchErrorCode(outcome.failure),
        outcome.failure,
        outcome.dispatched,
      );
    }
    const projection = projectSearchResult(outcome.result, outcome.resultText, {
      ...(this.declaration?.filter !== undefined ? { filter: this.declaration.filter } : {}),
      contextSize: this.declaration?.contextSize ?? "medium",
    });
    try {
      this.#init.store.complete(this.tenantId, snapshot, {
        modelText: projection.modelText,
        sources: projection.sources,
        retrievedCount: projection.retrievedCount,
        filteredCount: projection.filteredCount,
        budgetDroppedCount: projection.budgetDroppedCount,
      });
    } catch (error) {
      this.#init.store.markUncertain(this.tenantId, snapshot);
      throw error instanceof WebSearchError
        ? error
        : new WebSearchError(
            "Web search snapshot storage is unavailable",
            "web_search_store_unavailable",
            503,
          );
    }
    this.#succeeded += 1;
    this.#sources.set(snapshot.callId, projection.sources);
    auditLog("info", "web_search_call_finished", {
      protocol: this.protocol,
      outcome: "success",
      dispatched: true,
      duration_ms: outcome.durationMs,
      response_bytes: outcome.responseBytes,
      retrieved_count: projection.retrievedCount,
      source_count: projection.sources.length,
      filtered_count: projection.filteredCount,
      budget_dropped_count: projection.budgetDroppedCount,
    });
    return {
      callId: snapshot.callId,
      wireId: snapshot.wire.toolUseId,
      ok: true,
      modelText: projection.modelText,
      dispatched: true,
      events: [
        v2("search_result", {
          callId: snapshot.callId,
          sources: this.#sourceViews(snapshot.callId, projection.sources),
        }),
        v2("search_call_completed", { callId: snapshot.callId }),
      ],
    };
  }

  /** A claimed call this response cannot finish: its outcome becomes uncertain. */
  abandon(snapshot: ClaimedWebSearchSnapshot): void {
    this.#active.delete(snapshot.callId);
    this.#init.store.markUncertain(this.tenantId, snapshot);
  }

  /**
   * Settles every claim whose execution never recorded an outcome, before the
   * request lets go of its lease: such a call may have run, so it becomes
   * uncertain and can never execute again.
   */
  abandonActive(): void {
    for (const snapshot of [...this.#active.values()]) this.abandon(snapshot);
  }

  /**
   * Records and claims every fresh call of one generation, all or none. When a
   * later call cannot be recorded, the calls already claimed were never
   * published or dispatched and are removed again.
   */
  startGroup(
    calls: ReadonlyArray<{ readonly callId: string; readonly binding: WebSearchSnapshotBinding }>,
  ): ClaimedWebSearchSnapshot[] {
    const claimed: ClaimedWebSearchSnapshot[] = [];
    let prepared: string | undefined;
    try {
      for (const call of calls) {
        this.#init.store.prepare({
          tenantId: this.tenantId,
          callId: call.callId,
          status: "prepared",
          binding: call.binding,
          expiresAt: this.snapshotExpiresAt(),
        });
        prepared = call.callId;
        const snapshot = this.#init.store.claim(this.tenantId, call.callId, ["prepared"]);
        prepared = undefined;
        claimed.push(snapshot);
        this.#active.set(snapshot.callId, snapshot);
      }
      return claimed;
    } catch (error) {
      if (prepared !== undefined) {
        const expected = { generation: 1, statuses: ["prepared" as const] };
        if (!this.#init.store.discard(this.tenantId, prepared, expected)) {
          this.#init.store.retireUnpublished(this.tenantId, prepared, expected);
        }
      }
      for (const snapshot of claimed) {
        this.#active.delete(snapshot.callId);
        const removed = this.#init.store.discard(this.tenantId, snapshot.callId, {
          generation: snapshot.generation,
          statuses: ["executing"],
        });
        if (!removed) this.#init.store.markUncertain(this.tenantId, snapshot);
      }
      throw error;
    }
  }

  /**
   * Executes the deferred or paused calls a continuation request carries, once
   * per request: a retried dispatch reuses the recorded outcome. The caller has
   * already pinned the request to the snapshot owner.
   */
  async executePending(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    region: string,
    signal: AbortSignal,
  ): Promise<readonly ExecutedHostedCall[]> {
    const runnable: PendingHostedCall[] = [];
    for (const pending of this.pending) {
      if (this.#pendingDone.has(pending.callId)) continue;
      const recorded = this.#init.store.read(this.tenantId, pending.callId);
      if (recorded.owner.accountId !== account.id) {
        throw new WebSearchError(
          "The pending web search is bound to another account",
          "web_search_replay_owner_unavailable",
          503,
        );
      }
      if (recorded.status === "completed" || recorded.status === "failed") {
        // An earlier attempt already executed this call: reuse, never search twice.
        this.#pendingDone.set(pending.callId, this.#reuse(recorded));
        continue;
      }
      runnable.push(pending);
    }
    // Every call still pending is claimed together before any of them runs,
    // so a concurrent continuation can never take part of the group.
    const claimed = this.#init.store.claimGroup(
      this.tenantId,
      runnable.map((pending) => pending.callId),
      ["deferred", "paused"],
    );
    for (const snapshot of claimed) this.#active.set(snapshot.callId, snapshot);
    let next = 0;
    try {
      for (; next < runnable.length; next += 1) {
        const pending = runnable[next] as PendingHostedCall;
        const result = await this.execute(
          claimed[next] as ClaimedWebSearchSnapshot,
          pending.query,
          auth,
          region,
          signal,
        );
        this.#pendingDone.set(pending.callId, result);
      }
    } finally {
      // Claimed calls this request will not run may already be visible as
      // executing to others: they become uncertain, never pending again.
      for (const snapshot of claimed.slice(next + 1)) this.abandon(snapshot);
    }
    return this.pending.map(
      (pending) => this.#pendingDone.get(pending.callId) as ExecutedHostedCall,
    );
  }

  /** Fills the placeholder tool results of executed pending calls. */
  withPendingResults(
    body: CanonicalRequest,
    executed: readonly ExecutedHostedCall[],
  ): CanonicalRequest {
    if (executed.length === 0) return body;
    const byCall = new Map(executed.map((call) => [call.callId, call] as const));
    const messages = body.messages.map((message, messageIndex) => {
      const targets = this.pending.filter((pending) => pending.messageIndex === messageIndex);
      if (targets.length === 0) return message;
      const content = message.content.map((part, partIndex) => {
        const target = targets.find((pending) => pending.partIndex === partIndex);
        const result = target === undefined ? undefined : byCall.get(target.callId);
        if (part.type !== "tool_result" || result === undefined) return part;
        return {
          ...part,
          content: [{ type: "text" as const, text: result.modelText, path: part.path }],
          isError: !result.ok,
        };
      });
      return { ...message, content };
    });
    return { ...body, messages };
  }

  parseQuery(input: string): unknown {
    return parseQuery(input);
  }

  /** Sources an executed or restored call handed to the model in this request. */
  sourcesForCitation(callId: string): readonly ProjectedSource[] {
    return this.#sources.get(callId) ?? [];
  }

  /** Public events for a call that already completed or failed in an earlier attempt. */
  #reuse(snapshot: WebSearchSnapshot): ExecutedHostedCall {
    if (snapshot.status === "completed" && snapshot.result !== undefined) {
      this.#sources.set(snapshot.callId, snapshot.result.sources);
      return {
        callId: snapshot.callId,
        wireId: snapshot.wire.toolUseId,
        ok: true,
        modelText: snapshot.result.modelText,
        dispatched: false,
        events: [
          v2("search_result", {
            callId: snapshot.callId,
            sources: this.#sourceViews(snapshot.callId, snapshot.result.sources),
          }),
          v2("search_call_completed", { callId: snapshot.callId }),
        ],
      };
    }
    const code = snapshot.error?.code ?? "unavailable";
    return {
      callId: snapshot.callId,
      wireId: snapshot.wire.toolUseId,
      ok: false,
      modelText: snapshot.error?.modelText ?? errorModelText(code),
      dispatched: false,
      events: [v2("search_call_failed", { callId: snapshot.callId, errorCode: code })],
    };
  }
}

export function snapshotModelText(snapshot: WebSearchSnapshot): string | undefined {
  if (snapshot.status === "completed") return snapshot.result?.modelText;
  if (snapshot.status === "failed") return snapshot.error?.modelText;
  return undefined;
}

export { hostedSegmentFingerprint } from "./fingerprint.js";
