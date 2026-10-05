import type { CanonicalProtocol } from "../protocol/canonical.js";
import type { ReasoningReplayKeyring } from "../reasoning/keyring.js";
import type {
  AccountsDatabase,
  WebSearchSnapshotRecord,
  WebSearchSnapshotStatus,
} from "../storage/accounts-db.js";
import {
  openSnapshotPayload,
  sealSnapshotPayload,
  snapshotLookupHash,
  sourceIdentity,
} from "./crypto.js";
import { WebSearchError } from "./errors.js";
import type { WebSearchErrorCode, WebSearchRpcFailure } from "./mcp-client.js";
import type { ProjectedSource } from "./projection.js";

/**
 * Encrypted, tenant-isolated ledger of hosted search calls.
 *
 * One row per public call identity records how the call was bound and how it
 * ended, so a later request can restore the exact tool use and tool result the
 * owner Kiro conversation saw. State moves only forward:
 *
 *   prepared -> deferred | paused -> executing -> completed | failed | uncertain
 *   prepared -> executing
 *
 * Every transition is a compare-and-swap on the row generation, so a pending
 * call is claimed by exactly one executor. A call that was executing when the
 * process stopped, or whose execution was cancelled after dispatch, becomes
 * `uncertain` and is never offered for execution again.
 */

export const WEB_SEARCH_SNAPSHOT_VERSION = 1 as const;
/** Expired snapshots stay as content-free tombstones this long, to report expiry. */
export const WEB_SEARCH_TOMBSTONE_GRACE_MS = 7 * 24 * 60 * 60_000;

export interface WebSearchOwnerBinding {
  readonly accountId: string;
  readonly region: string;
  readonly profileArn?: string;
  readonly conversationId: string;
}

export interface WebSearchWireMapping {
  readonly toolUseId: string;
  readonly toolName: string;
  /** Wire ids of the whole tool group, in the order Kiro emitted them. */
  readonly group: readonly string[];
}

export interface WebSearchSnapshotBinding {
  readonly protocol: CanonicalProtocol;
  readonly wireModel: string;
  readonly owner: WebSearchOwnerBinding;
  readonly wire: WebSearchWireMapping;
  readonly declarationFingerprint: string;
  readonly toolDefinitionFingerprint: string;
  readonly queryFingerprint: string;
}

export interface WebSearchSnapshotResult {
  /** Exact tool result text the model received. */
  readonly modelText: string;
  readonly sources: readonly ProjectedSource[];
  readonly retrievedCount: number;
  readonly filteredCount: number;
  readonly budgetDroppedCount: number;
}

export interface WebSearchSnapshotFailure {
  readonly code: WebSearchErrorCode;
  readonly failure: WebSearchRpcFailure | "max_uses_exceeded" | "unauthorized";
  /** Exact tool result text the model received for this failure. */
  readonly modelText: string;
}

export type WebSearchPendingReason = "mixed_tool_group" | "deadline" | "iteration_limit";

interface SnapshotPayload extends WebSearchSnapshotBinding {
  readonly v: typeof WEB_SEARCH_SNAPSHOT_VERSION;
  readonly tenantId: string;
  readonly callId: string;
  readonly state: WebSearchSnapshotStatus;
  readonly pendingReason?: WebSearchPendingReason;
  readonly result?: WebSearchSnapshotResult;
  readonly error?: WebSearchSnapshotFailure;
  readonly createdAt: number;
}

export interface WebSearchSnapshot extends WebSearchSnapshotBinding {
  readonly callId: string;
  readonly status: WebSearchSnapshotStatus;
  readonly pendingReason?: WebSearchPendingReason;
  readonly result?: WebSearchSnapshotResult;
  readonly error?: WebSearchSnapshotFailure;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly generation: number;
  /** Decrypted bytes, charged against the per-request history budget. */
  readonly payloadBytes: number;
}

export interface ClaimedWebSearchSnapshot extends WebSearchSnapshot {
  readonly status: "executing";
}

export type PendingStatus = "prepared" | "deferred" | "paused";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validPayload(
  value: unknown,
  tenantId: string,
  callId: string,
  status: WebSearchSnapshotStatus,
): value is SnapshotPayload {
  if (!isRecord(value)) return false;
  if (
    value.v !== WEB_SEARCH_SNAPSHOT_VERSION ||
    value.tenantId !== tenantId ||
    value.callId !== callId ||
    !isString(value.wireModel) ||
    (value.protocol !== "responses" && value.protocol !== "anthropic-messages") ||
    !isString(value.declarationFingerprint) ||
    !isString(value.toolDefinitionFingerprint) ||
    !isString(value.queryFingerprint) ||
    typeof value.createdAt !== "number"
  ) {
    return false;
  }
  const owner = value.owner;
  const wire = value.wire;
  if (
    !isRecord(owner) ||
    !isString(owner.accountId) ||
    !isString(owner.region) ||
    !isString(owner.conversationId) ||
    (owner.profileArn !== undefined && !isString(owner.profileArn)) ||
    !isRecord(wire) ||
    !isString(wire.toolUseId) ||
    !isString(wire.toolName) ||
    !Array.isArray(wire.group) ||
    !wire.group.every(isString) ||
    !wire.group.includes(wire.toolUseId)
  ) {
    return false;
  }
  // The sealed content must agree with the plaintext state it was written for.
  const written = value.state;
  if (status === "completed") return written === "completed" && isRecord(value.result);
  if (status === "failed") return written === "failed" && isRecord(value.error);
  if (status === "uncertain" || status === "executing") {
    return (
      written === "executing" ||
      written === "prepared" ||
      written === "deferred" ||
      written === "paused"
    );
  }
  return written === status && value.result === undefined && value.error === undefined;
}

export class WebSearchSnapshotStore {
  #keyring: ReasoningReplayKeyring | undefined;

  constructor(
    private readonly database: AccountsDatabase,
    private readonly loadKeyring: () => ReasoningReplayKeyring,
    private readonly options: {
      readonly capacityBytes: number;
      readonly reservationBytes: number;
      readonly now?: () => number;
    },
  ) {}

  #now(): number {
    return (this.options.now ?? Date.now)();
  }

  #ring(): ReasoningReplayKeyring {
    if (this.#keyring !== undefined) return this.#keyring;
    try {
      this.#keyring = this.loadKeyring();
    } catch {
      throw new WebSearchError(
        "Web search snapshot keys are unavailable",
        "web_search_store_unavailable",
        503,
      );
    }
    return this.#keyring;
  }

  #seal(tenantId: string, callId: string, payload: SnapshotPayload) {
    const sealed = sealSnapshotPayload(this.#ring(), tenantId, callId, payload);
    return { sealed, payloadBytes: sealed.ciphertext.byteLength };
  }

  /** Startup recovery: anything still executing belongs to a stopped process. */
  recoverInterruptedExecutions(): number {
    return this.database.markExecutingWebSearchSnapshotsUncertain(this.#now());
  }

  prune(): number {
    return this.database.pruneWebSearchSnapshots(this.#now(), WEB_SEARCH_TOMBSTONE_GRACE_MS);
  }

  /**
   * Records a call before anything can execute it. The reservation charges a
   * full result against the cache, so the later completion always fits.
   */
  prepare(input: {
    readonly tenantId: string;
    readonly callId: string;
    readonly status: PendingStatus;
    readonly binding: WebSearchSnapshotBinding;
    readonly pendingReason?: WebSearchPendingReason;
    readonly expiresAt: number;
  }): void {
    const now = this.#now();
    const payload: SnapshotPayload = {
      v: WEB_SEARCH_SNAPSHOT_VERSION,
      tenantId: input.tenantId,
      callId: input.callId,
      state: input.status,
      ...input.binding,
      ...(input.pendingReason !== undefined ? { pendingReason: input.pendingReason } : {}),
      createdAt: now,
    };
    const { sealed, payloadBytes } = this.#seal(input.tenantId, input.callId, payload);
    let outcome: ReturnType<AccountsDatabase["insertWebSearchSnapshot"]>;
    try {
      outcome = this.database.insertWebSearchSnapshot(
        {
          lookupHash: snapshotLookupHash(input.tenantId, input.callId),
          version: WEB_SEARCH_SNAPSHOT_VERSION,
          status: input.status,
          ...sealed,
          payloadBytes,
          reservedBytes: Math.max(payloadBytes, this.options.reservationBytes),
          createdAt: now,
          expiresAt: input.expiresAt,
        },
        this.options.capacityBytes,
        now,
      );
    } catch {
      throw new WebSearchError(
        "Web search snapshot storage is unavailable",
        "web_search_store_unavailable",
        503,
      );
    }
    if (outcome === "capacity") {
      throw new WebSearchError(
        "Web search snapshot capacity is exhausted",
        "web_search_cache_full",
        503,
      );
    }
    if (outcome === "exists") {
      throw new WebSearchError(
        "Web search call identity already exists",
        "web_search_store_unavailable",
        503,
      );
    }
  }

  /** Reads and authenticates one snapshot; every unusable state is typed. */
  read(tenantId: string, callId: string): WebSearchSnapshot {
    let record: WebSearchSnapshotRecord | undefined;
    try {
      record = this.database.getWebSearchSnapshot(snapshotLookupHash(tenantId, callId));
    } catch {
      throw new WebSearchError(
        "Web search snapshot storage is unavailable",
        "web_search_store_unavailable",
        503,
      );
    }
    if (record === undefined) {
      throw new WebSearchError(
        "Web search history references an unknown search call",
        "web_search_replay_not_found",
      );
    }
    if (record.status === "expired" || record.expiresAt <= this.#now()) {
      throw new WebSearchError(
        "Web search history references an expired search snapshot",
        "web_search_replay_expired",
      );
    }
    if (record.version !== WEB_SEARCH_SNAPSHOT_VERSION) {
      throw new WebSearchError(
        "Web search snapshot version is not supported",
        "web_search_replay_invalid",
      );
    }
    const payload = openSnapshotPayload(this.#ring(), tenantId, callId, record);
    if (!validPayload(payload, tenantId, callId, record.status)) {
      throw new WebSearchError(
        "Web search snapshot failed authentication",
        "web_search_replay_invalid",
      );
    }
    return {
      callId,
      status: record.status,
      protocol: payload.protocol,
      wireModel: payload.wireModel,
      owner: payload.owner,
      wire: payload.wire,
      declarationFingerprint: payload.declarationFingerprint,
      toolDefinitionFingerprint: payload.toolDefinitionFingerprint,
      queryFingerprint: payload.queryFingerprint,
      ...(payload.pendingReason !== undefined ? { pendingReason: payload.pendingReason } : {}),
      ...(payload.result !== undefined ? { result: payload.result } : {}),
      ...(payload.error !== undefined ? { error: payload.error } : {}),
      createdAt: payload.createdAt,
      expiresAt: record.expiresAt,
      generation: record.generation,
      payloadBytes: record.ciphertext.byteLength,
    };
  }

  /**
   * Atomically moves a pending call to `executing`. Losing the race, or finding
   * the call in any non-pending state, is a typed refusal: a completed call is
   * reused by the caller, never executed twice.
   */
  claim(
    tenantId: string,
    callId: string,
    from: readonly PendingStatus[],
  ): ClaimedWebSearchSnapshot {
    const snapshot = this.read(tenantId, callId);
    if (snapshot.status === "uncertain") {
      throw new WebSearchError(
        "The pending web search may already have run; it cannot be executed again",
        "web_search_replay_uncertain",
        409,
      );
    }
    if (!from.includes(snapshot.status as PendingStatus)) {
      throw new WebSearchError(
        "The web search call is not pending",
        "web_search_replay_pending",
        409,
      );
    }
    const now = this.#now();
    const claimed = this.database.transitionWebSearchSnapshot(
      snapshotLookupHash(tenantId, callId),
      { generation: snapshot.generation, statuses: from },
      { status: "executing" },
      now,
    );
    if (!claimed) {
      throw new WebSearchError(
        "Another request already claimed this web search call",
        "web_search_replay_pending",
        409,
      );
    }
    return { ...snapshot, status: "executing", generation: snapshot.generation + 1 };
  }

  /**
   * Claims every listed pending call or none of them, in one transaction, so
   * a concurrent continuation can never take part of a group whose other
   * calls this request is about to run. Refusals are typed like `claim`.
   */
  claimGroup(
    tenantId: string,
    callIds: readonly string[],
    from: readonly PendingStatus[],
  ): ClaimedWebSearchSnapshot[] {
    const snapshots = callIds.map((callId) => {
      const snapshot = this.read(tenantId, callId);
      if (snapshot.status === "uncertain") {
        throw new WebSearchError(
          "The pending web search may already have run; it cannot be executed again",
          "web_search_replay_uncertain",
          409,
        );
      }
      if (!from.includes(snapshot.status as PendingStatus)) {
        throw new WebSearchError(
          "The web search call is not pending",
          "web_search_replay_pending",
          409,
        );
      }
      return snapshot;
    });
    let claimed: boolean;
    try {
      claimed = this.database.transitionWebSearchSnapshotsAtomically(
        snapshots.map((snapshot) => ({
          lookupHash: snapshotLookupHash(tenantId, snapshot.callId),
          expected: { generation: snapshot.generation, statuses: from },
          update: { status: "executing" as const },
        })),
        this.#now(),
      );
    } catch {
      throw new WebSearchError(
        "Web search snapshot storage is unavailable",
        "web_search_store_unavailable",
        503,
      );
    }
    if (!claimed) {
      throw new WebSearchError(
        "Another request already claimed a call of this web search group",
        "web_search_replay_pending",
        409,
      );
    }
    return snapshots.map((snapshot) => ({
      ...snapshot,
      status: "executing" as const,
      generation: snapshot.generation + 1,
    }));
  }

  /**
   * Best effort for a pending call that was recorded but never published and
   * could not be removed: it becomes uncertain, so it can never run.
   */
  retireUnpublished(
    tenantId: string,
    callId: string,
    expected: { readonly generation: number; readonly statuses: readonly PendingStatus[] },
  ): boolean {
    try {
      return this.database.transitionWebSearchSnapshot(
        snapshotLookupHash(tenantId, callId),
        expected,
        { status: "uncertain" },
        this.#now(),
      );
    } catch {
      return false;
    }
  }

  #finish(
    tenantId: string,
    snapshot: ClaimedWebSearchSnapshot,
    status: "completed" | "failed",
    outcome: {
      readonly result?: WebSearchSnapshotResult;
      readonly error?: WebSearchSnapshotFailure;
    },
  ): WebSearchSnapshot {
    const payload: SnapshotPayload = {
      v: WEB_SEARCH_SNAPSHOT_VERSION,
      tenantId,
      callId: snapshot.callId,
      state: status,
      protocol: snapshot.protocol,
      wireModel: snapshot.wireModel,
      owner: snapshot.owner,
      wire: snapshot.wire,
      declarationFingerprint: snapshot.declarationFingerprint,
      toolDefinitionFingerprint: snapshot.toolDefinitionFingerprint,
      queryFingerprint: snapshot.queryFingerprint,
      ...(outcome.result !== undefined ? { result: outcome.result } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      createdAt: snapshot.createdAt,
    };
    const { sealed, payloadBytes } = this.#seal(tenantId, snapshot.callId, payload);
    const written = this.database.transitionWebSearchSnapshot(
      snapshotLookupHash(tenantId, snapshot.callId),
      { generation: snapshot.generation, statuses: ["executing"] },
      { status, sealed, payloadBytes, reservedBytes: payloadBytes },
      this.#now(),
    );
    if (!written) {
      throw new WebSearchError(
        "Web search snapshot changed while it was executing",
        "web_search_store_unavailable",
        503,
      );
    }
    return {
      ...snapshot,
      status,
      ...(outcome.result !== undefined ? { result: outcome.result } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      generation: snapshot.generation + 1,
      payloadBytes,
    };
  }

  complete(
    tenantId: string,
    snapshot: ClaimedWebSearchSnapshot,
    result: WebSearchSnapshotResult,
  ): WebSearchSnapshot {
    return this.#finish(tenantId, snapshot, "completed", { result });
  }

  fail(
    tenantId: string,
    snapshot: ClaimedWebSearchSnapshot,
    error: WebSearchSnapshotFailure,
  ): WebSearchSnapshot {
    return this.#finish(tenantId, snapshot, "failed", { error });
  }

  /** Best effort: the execution outcome is unknown, so the call can never resume. */
  markUncertain(tenantId: string, snapshot: ClaimedWebSearchSnapshot): boolean {
    try {
      return this.database.transitionWebSearchSnapshot(
        snapshotLookupHash(tenantId, snapshot.callId),
        { generation: snapshot.generation, statuses: ["executing"] },
        { status: "uncertain" },
        this.#now(),
      );
    } catch {
      return false;
    }
  }

  /**
   * Best effort: removes a call this request recorded but never published
   * (`generation` and `statuses` as recorded). Returns false when the row
   * moved on or storage failed; the caller then falls back to `uncertain`.
   */
  discard(
    tenantId: string,
    callId: string,
    expected: {
      readonly generation: number;
      readonly statuses: readonly WebSearchSnapshotStatus[];
    },
  ): boolean {
    try {
      return this.database.deleteUnpublishedWebSearchSnapshot(
        snapshotLookupHash(tenantId, callId),
        expected,
      );
    } catch {
      return false;
    }
  }

  /** Keeps a snapshot alive at least until `expiresAt` (stored Responses resources). */
  extend(tenantId: string, callId: string, expiresAt: number): boolean {
    try {
      return this.database.extendWebSearchSnapshot(
        snapshotLookupHash(tenantId, callId),
        expiresAt,
        this.#now(),
      );
    } catch {
      return false;
    }
  }
}

/** Identity digest of a projected source as recorded in its snapshot. */
export function projectedSourceIdentity(source: ProjectedSource): string {
  return sourceIdentity(source);
}
