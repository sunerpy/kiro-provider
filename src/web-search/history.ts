import { textPart } from "../protocol/adapter-utils.js";
import type {
  CanonicalContentPart,
  CanonicalMessage,
  CanonicalProtocol,
  CanonicalRequest,
} from "../protocol/canonical.js";
import type { ReasoningReplayKeyring } from "../reasoning/keyring.js";
import {
  citationVisibleFingerprint,
  openReference,
  resultVisibleFingerprint,
  sourceIdentity,
} from "./crypto.js";
import type { HostedWebSearchDeclaration } from "./declarations.js";
import { WebSearchError } from "./errors.js";
import { webSearchQueryFingerprint } from "./mcp-client.js";
import { type ProjectedSource, pageAge } from "./projection.js";
import type { PendingHostedCall } from "./session.js";
import type { WebSearchSnapshot, WebSearchSnapshotStore } from "./snapshot-store.js";

/**
 * Restores hosted search history from authenticated snapshots.
 *
 * Protocol adapters describe each hosted call in the client's history by its
 * public identity and the visible fields the client returned. Only an
 * authenticated snapshot can turn that description into model-visible Kiro
 * history: the exact wire tool use, the exact tool result the model saw, and
 * the owner that generated it. Anything the snapshot cannot vouch for is a
 * typed rejection; history is never trusted, rewritten or silently dropped.
 */

export const HOSTED_CALL_METADATA = "hostedWebSearch" as const;

export interface HostedHistorySourceView {
  readonly url: string;
  readonly title: string;
  readonly pageAge?: string | null;
  /** Messages `encrypted_content`. */
  readonly encryptedContent?: unknown;
}

export interface HostedHistoryCall {
  readonly callId: string;
  readonly query: string;
  /** Canonical index of the assistant message whose toolCalls hold this call. */
  readonly assistantMessage: number;
  /** Placeholder tool result (message and part index) the restoration fills. */
  readonly result: { readonly message: number; readonly part: number };
  readonly publicState:
    | { readonly kind: "completed"; readonly sources?: readonly HostedHistorySourceView[] }
    | { readonly kind: "failed"; readonly errorCode?: string }
    | { readonly kind: "pending" };
  readonly path: string;
}

export interface HostedHistoryCitation {
  readonly encryptedIndex: unknown;
  readonly url: string;
  readonly title: string;
  readonly citedText: string;
  readonly path: string;
}

export interface HostedHistory {
  readonly calls: readonly HostedHistoryCall[];
  readonly citations: readonly HostedHistoryCitation[];
}

/** The account, region, profile and Kiro conversation that recorded a history. */
export interface HostedOwnerLock {
  readonly accountId: string;
  readonly region: string;
  readonly profileArn?: string;
  readonly conversationId: string;
}

export interface RestoredHostedHistory {
  readonly body: CanonicalRequest;
  readonly pending: readonly PendingHostedCall[];
  readonly ownerLock?: HostedOwnerLock;
  readonly historySources: ReadonlyArray<{
    readonly callId: string;
    readonly sources: readonly ProjectedSource[];
  }>;
  readonly restoredCalls: number;
  readonly restoredBytes: number;
}

function invalid(message: string, param?: string): WebSearchError {
  return new WebSearchError(message, "web_search_replay_invalid", 400, param);
}

function verifyMessagesSources(
  snapshot: WebSearchSnapshot,
  visible: readonly HostedHistorySourceView[],
  keyring: ReasoningReplayKeyring,
  tenantId: string,
  path: string,
): void {
  const sources = snapshot.result?.sources ?? [];
  if (visible.length !== sources.length) {
    throw invalid("Web search result sources do not match the authenticated search", path);
  }
  for (const [index, entry] of visible.entries()) {
    const source = sources[index] as ProjectedSource;
    const age = pageAge(source);
    const opened = openReference(
      keyring,
      tenantId,
      snapshot.callId,
      "result",
      entry.encryptedContent,
    );
    if (!opened.ok) {
      throw new WebSearchError(
        "Web search result content failed authentication",
        opened.code,
        opened.code === "web_search_replay_key_unavailable" ? 503 : 400,
        `${path}.${index}.encrypted_content`,
      );
    }
    if (
      opened.reference.ordinal !== source.ordinal ||
      opened.reference.sourceIdentity !== sourceIdentity(source) ||
      opened.reference.visibleFingerprint !==
        resultVisibleFingerprint({
          url: entry.url,
          title: entry.title,
          pageAge: entry.pageAge ?? null,
        }) ||
      entry.url !== source.url ||
      entry.title !== source.title ||
      (entry.pageAge ?? null) !== age
    ) {
      throw invalid(
        "Web search result does not match its authenticated source",
        `${path}.${index}`,
      );
    }
  }
}

function verifyResponsesSources(
  snapshot: WebSearchSnapshot,
  visible: readonly HostedHistorySourceView[] | undefined,
  path: string,
): void {
  if (visible === undefined) return;
  const urls = (snapshot.result?.sources ?? []).map((source) => source.url);
  if (visible.length !== urls.length || visible.some((entry, index) => entry.url !== urls[index])) {
    throw invalid("web_search_call sources do not match the authenticated search", path);
  }
}

function groupIndex(snapshot: WebSearchSnapshot, wireId: string): number {
  const index = snapshot.wire.group.indexOf(wireId);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

export function restoreHostedHistory(input: {
  readonly body: CanonicalRequest;
  readonly history: HostedHistory;
  readonly protocol: CanonicalProtocol;
  readonly tenantId: string;
  readonly store: WebSearchSnapshotStore;
  readonly keyring: () => ReasoningReplayKeyring;
  readonly maxHistoryBytes: number;
  readonly reserveBytes?: (bytes: number) => boolean;
  readonly declaration?: HostedWebSearchDeclaration;
}): RestoredHostedHistory {
  const { history } = input;
  if (history.calls.length === 0 && history.citations.length === 0) {
    return {
      body: input.body,
      pending: [],
      historySources: [],
      restoredCalls: 0,
      restoredBytes: 0,
    };
  }
  const snapshots = new Map<string, WebSearchSnapshot>();
  let restoredBytes = 0;
  // Every authenticated snapshot binds the request to the owner that recorded
  // it, whatever its state; one history never spans two owners.
  let ownerLock: HostedOwnerLock | undefined;
  const read = (callId: string, path: string): WebSearchSnapshot => {
    const known = snapshots.get(callId);
    if (known !== undefined) return known;
    const snapshot = input.store.read(input.tenantId, callId);
    restoredBytes += snapshot.payloadBytes;
    if (restoredBytes > input.maxHistoryBytes) {
      throw new WebSearchError(
        "Web search history exceeds the restorable size for one request",
        "web_search_history_too_large",
      );
    }
    const owner = snapshot.owner;
    if (ownerLock === undefined) {
      ownerLock = {
        accountId: owner.accountId,
        region: owner.region,
        ...(owner.profileArn !== undefined ? { profileArn: owner.profileArn } : {}),
        conversationId: owner.conversationId,
      };
    } else if (
      ownerLock.accountId !== owner.accountId ||
      ownerLock.region !== owner.region ||
      ownerLock.profileArn !== owner.profileArn ||
      ownerLock.conversationId !== owner.conversationId
    ) {
      throw invalid("Web search history belongs to different owners", path);
    }
    snapshots.set(callId, snapshot);
    return snapshot;
  };
  const seen = new Set<string>();
  const pending: PendingHostedCall[] = [];
  const historySources: Array<{ callId: string; sources: readonly ProjectedSource[] }> = [];
  const messages = input.body.messages.map((message) => ({
    ...message,
    content: [...message.content],
    toolCalls: [...message.toolCalls],
  }));
  for (const call of history.calls) {
    if (seen.has(call.callId)) throw invalid("Web search call appears more than once", call.path);
    seen.add(call.callId);
    const snapshot = read(call.callId, call.path);
    if (snapshot.protocol !== input.protocol) {
      throw invalid("Web search history belongs to another protocol", call.path);
    }
    if (snapshot.queryFingerprint !== webSearchQueryFingerprint(call.query)) {
      throw invalid("Web search query does not match the authenticated search", call.path);
    }
    const status = snapshot.status;
    if (status === "executing") {
      throw new WebSearchError(
        "Another request is executing this web search call",
        "web_search_replay_pending",
        409,
        call.path,
      );
    }
    if (status === "uncertain" || status === "prepared") {
      throw new WebSearchError(
        "This web search call has no recorded outcome and cannot be replayed",
        "web_search_replay_uncertain",
        409,
        call.path,
      );
    }
    const publicState = call.publicState;
    if (publicState.kind === "pending") {
      // Deferred or paused calls run now; a call an interrupted attempt already
      // finished is reused rather than searched again.
      if (input.declaration === undefined) {
        throw new WebSearchError(
          "A pending web search requires the hosted search tool in the current request",
          "web_search_pending_unauthorized",
          400,
          call.path,
        );
      }
      if (input.declaration.fingerprint !== snapshot.declarationFingerprint) {
        throw new WebSearchError(
          "The current web search declaration differs from the one that recorded this pending call",
          "web_search_pending_unauthorized",
          400,
          call.path,
        );
      }
      pending.push({
        callId: call.callId,
        query: call.query,
        status: status === "paused" ? "paused" : "deferred",
        messageIndex: call.result.message,
        partIndex: call.result.part,
      });
      if (status === "completed" && snapshot.result !== undefined) {
        historySources.push({ callId: call.callId, sources: snapshot.result.sources });
      }
    } else if (publicState.kind === "completed") {
      if (status !== "completed" || snapshot.result === undefined) {
        throw invalid("Web search result does not match the authenticated search state", call.path);
      }
      if (input.protocol === "anthropic-messages") {
        verifyMessagesSources(
          snapshot,
          publicState.sources ?? [],
          input.keyring(),
          input.tenantId,
          `${call.path}.content`,
        );
      } else {
        verifyResponsesSources(snapshot, publicState.sources, call.path);
      }
      historySources.push({ callId: call.callId, sources: snapshot.result.sources });
    } else {
      if (
        status !== "failed" ||
        snapshot.error === undefined ||
        (publicState.errorCode !== undefined && publicState.errorCode !== snapshot.error.code)
      ) {
        throw invalid("Web search error does not match the authenticated search state", call.path);
      }
    }
    // Rewrite the public identity into the exact wire call and result.
    const assistant = messages[call.assistantMessage];
    const toolIndex = assistant?.toolCalls.findIndex((entry) => entry.id === call.callId) ?? -1;
    if (assistant === undefined || toolIndex < 0) {
      throw new TypeError("Hosted history call was not projected");
    }
    assistant.toolCalls[toolIndex] = {
      ...(assistant.toolCalls[toolIndex] as CanonicalMessage["toolCalls"][number]),
      id: snapshot.wire.toolUseId,
      name: snapshot.wire.toolName,
      input: { query: call.query },
    };
    const resultMessage = messages[call.result.message];
    const part = resultMessage?.content[call.result.part];
    if (
      resultMessage === undefined ||
      part?.type !== "tool_result" ||
      part.toolCallId !== call.callId
    ) {
      throw new TypeError("Hosted history result was not projected");
    }
    const modelText =
      publicState.kind === "pending" && status !== "completed" && status !== "failed"
        ? ""
        : status === "completed"
          ? snapshot.result?.modelText
          : snapshot.error?.modelText;
    resultMessage.content[call.result.part] = {
      ...part,
      toolCallId: snapshot.wire.toolUseId,
      content: modelText ? [textPart(modelText, part.path)] : [],
      isError: status === "failed",
    };
  }
  for (const citation of history.citations) {
    const opened = openReference(
      input.keyring(),
      input.tenantId,
      "",
      "citation",
      citation.encryptedIndex,
    );
    if (!opened.ok) {
      throw new WebSearchError(
        "Web search citation failed authentication",
        opened.code,
        opened.code === "web_search_replay_key_unavailable" ? 503 : 400,
        citation.path,
      );
    }
    const snapshot = read(opened.reference.callId, citation.path);
    const source = snapshot.result?.sources.find(
      (candidate) => candidate.ordinal === opened.reference.ordinal,
    );
    if (
      snapshot.status !== "completed" ||
      source === undefined ||
      opened.reference.sourceIdentity !== sourceIdentity(source) ||
      opened.reference.visibleFingerprint !==
        citationVisibleFingerprint({
          url: citation.url,
          title: citation.title,
          citedText: citation.citedText,
        }) ||
      citation.url !== source.url ||
      citation.title !== source.title
    ) {
      throw invalid("Web search citation does not match its authenticated source", citation.path);
    }
  }
  // Keep each restored tool group in the order Kiro emitted it.
  for (const message of messages) {
    if (message.toolCalls.length < 2) continue;
    const owners = message.toolCalls.map((call) =>
      [...snapshots.values()].find((snapshot) => snapshot.wire.group.includes(call.id)),
    );
    const owner = owners.find((candidate) => candidate !== undefined);
    if (owner === undefined) continue;
    message.toolCalls.sort(
      (left, right) => groupIndex(owner, left.id) - groupIndex(owner, right.id),
    );
    const order = new Map(message.toolCalls.map((call, index) => [call.id, index] as const));
    const next = messages[messages.indexOf(message) + 1];
    if (next !== undefined) {
      const results = next.content.filter(
        (part): part is Extract<CanonicalContentPart, { type: "tool_result" }> =>
          part.type === "tool_result" && order.has(part.toolCallId),
      );
      if (results.length === next.content.filter((part) => part.type === "tool_result").length) {
        const sorted = [...results].sort(
          (left, right) => (order.get(left.toolCallId) ?? 0) - (order.get(right.toolCallId) ?? 0),
        );
        let cursor = 0;
        next.content = next.content.map((part) =>
          part.type === "tool_result" ? (sorted[cursor++] as typeof part) : part,
        );
      }
    }
  }
  if (input.reserveBytes !== undefined && restoredBytes > 0 && !input.reserveBytes(restoredBytes)) {
    throw new WebSearchError(
      "Provider request capacity cannot hold this web search history",
      "web_search_history_too_large",
      503,
    );
  }
  return {
    body: { ...input.body, messages },
    pending,
    ...(ownerLock !== undefined ? { ownerLock } : {}),
    historySources,
    restoredCalls: history.calls.length,
    restoredBytes,
  };
}

export { HOSTED_CALL_METADATA as hostedCallMetadataKey };
