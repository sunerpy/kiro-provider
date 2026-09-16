import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import { AffinityStallTracker } from "../src/core/affinity-stall.js";
import { auditHash } from "../src/core/audit-log.js";
import {
  type PipelineAccountManager,
  type PipelineReasoningReplayStore,
  type PipelineSdkClient,
  type PipelineTokenRefresher,
  runChatCompletion,
} from "../src/core/pipeline.js";
import type { PipelineAffinityStore, PipelineSessionAffinity } from "../src/core/pipeline-types.js";
import type {
  SdkStreamEvent,
  SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import { assistantOutputFingerprint, type CanonicalRequest } from "../src/protocol/canonical.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import { canonicalRequest, message } from "./canonical-test-helpers.js";

/**
 * A wedged upstream conversation keeps a session affinity pinned to the account
 * and conversation that stalled, so every retry of that session walks back into
 * the same silence. After enough consecutive abnormal published terminals the
 * next independent request must be allowed to pick again — never by replaying a
 * committed stream, and never over a reasoning replay owner lock.
 */

const AFFINITY: PipelineSessionAffinity = {
  keyHash: "wedged-session",
  source: "anthropic.header.x-claude-code-session-id",
};

const IDLE_MS = 150;

function account(id: string): ManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    authMethod: "desktop",
    region: "us-east-1",
    profileArn: `arn:aws:codewhisperer:us-east-1:123456789012:profile/${id}`,
    refreshToken: `${id}-refresh`,
    accessToken: `${id}-access`,
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
  };
}

/**
 * Honours a preferred account when one is offered and otherwise hands out the
 * first healthy account, so "the binding was honoured" and "the binding was
 * dropped" resolve to different accounts.
 */
class PreferredAccountManager implements PipelineAccountManager {
  readonly preferredRequests: Array<string | undefined> = [];

  constructor(readonly accounts: ManagedAccount[]) {}

  reconcileFromDb(): readonly ManagedAccount[] {
    return this.accounts;
  }

  selectHealthyAccount(
    preferredAccountId?: string,
    eligibleAccountIds?: ReadonlySet<string>,
  ): ManagedAccount | null {
    this.preferredRequests.push(preferredAccountId);
    const selectable = this.accounts.filter(
      (candidate) => candidate.isHealthy && (eligibleAccountIds?.has(candidate.id) ?? true),
    );
    return (
      selectable.find((candidate) => candidate.id === preferredAccountId) ?? selectable[0] ?? null
    );
  }

  getAccountCount(): number {
    return this.accounts.length;
  }

  toAuthDetails(selected: ManagedAccount): KiroAuthDetails {
    return {
      refresh: selected.refreshToken,
      access: selected.accessToken,
      expires: selected.expiresAt,
      authMethod: selected.authMethod,
      region: selected.region,
      email: selected.email,
      ...(selected.profileArn ? { profileArn: selected.profileArn } : {}),
    };
  }

  markRateLimited(): void {}
  markUnhealthy(): void {}
}

/**
 * Mimics what `sticky`, `round-robin` and `lowest-usage` can all do: rank the
 * account that just stalled best again even with no preference offered. Dropping
 * the preference cannot move selection off it — only withholding it from the
 * eligible set can, which is what these tests check.
 */
class StickyAccountManager extends PreferredAccountManager {
  readonly eligibleRequests: Array<readonly string[]> = [];

  constructor(
    accounts: ManagedAccount[],
    readonly stickyAccountId: string,
  ) {
    super(accounts);
  }

  override selectHealthyAccount(
    preferredAccountId?: string,
    eligibleAccountIds?: ReadonlySet<string>,
  ): ManagedAccount | null {
    this.preferredRequests.push(preferredAccountId);
    this.eligibleRequests.push([...(eligibleAccountIds ?? [])].sort());
    const selectable = this.accounts.filter(
      (candidate) => candidate.isHealthy && (eligibleAccountIds?.has(candidate.id) ?? true),
    );
    return (
      selectable.find((candidate) => candidate.id === preferredAccountId) ??
      selectable.find((candidate) => candidate.id === this.stickyAccountId) ??
      selectable[0] ??
      null
    );
  }
}

function unhealthy(id: string): ManagedAccount {
  return { ...account(id), isHealthy: false };
}

const LINEAGE = {
  lookupKeyHash: "lineage-key",
  source: "canonical.assistant-output",
  outputKeyHash: (fingerprint: string) => `lineage-${fingerprint}`,
} as const;

const refresher: PipelineTokenRefresher = {
  refreshIfNeeded: async (selected) => selected,
  forceRefresh: async (selected) => selected,
};

function config(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    api_keys: ["sk-test"],
    request_timeout_ms: 5_000,
    stream_idle_timeout_ms: IDLE_MS,
    rate_limit_retry_delay_ms: 1,
    stream_max_attempts: 1,
    retry_empty_completion: false,
    ...overrides,
  });
}

function completingResponse(): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
        yield { assistantResponseEvent: { content: "done" } };
        yield {
          metadataEvent: { tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        };
      },
    },
  };
}

/** Publishes a semantic frame, then goes silent so the idle watchdog terminates it. */
function stallingResponse(): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      [Symbol.asyncIterator](): AsyncIterator<SdkStreamEvent> {
        let sent = false;
        return {
          next(): Promise<IteratorResult<SdkStreamEvent>> {
            if (sent) return new Promise<IteratorResult<SdkStreamEvent>>(() => undefined);
            sent = true;
            return Promise.resolve({
              done: false,
              value: { assistantResponseEvent: { content: "partial" } },
            });
          },
          return: () => Promise.resolve({ done: true, value: undefined }),
        };
      },
    },
  };
}

/**
 * Publishes a single frame carrying two canonical events, then goes silent. The
 * second event is served out of the transformer's own buffer, so the read that
 * delivers it resolves without the upstream being asked for anything.
 */
function bufferedPairResponse(): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      [Symbol.asyncIterator](): AsyncIterator<SdkStreamEvent> {
        let sent = false;
        return {
          next(): Promise<IteratorResult<SdkStreamEvent>> {
            if (sent) return new Promise<IteratorResult<SdkStreamEvent>>(() => undefined);
            sent = true;
            return Promise.resolve({
              done: false,
              value: {
                reasoningContentEvent: { text: "thinking" },
                assistantResponseEvent: { content: "partial" },
              },
            });
          },
          return: () => Promise.resolve({ done: true, value: undefined }),
        };
      },
    },
  };
}

/** Keeps emitting frames, so a deadline lands on a stream that never went quiet. */
function flowingResponse(): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
        for (;;) {
          yield { assistantResponseEvent: { content: "chunk" } };
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      },
    },
  };
}

function clientWith(response: () => SdkStreamResponse): PipelineSdkClient {
  return { send: async () => response() };
}

function nonStreamRequest(): CanonicalRequest {
  return canonicalRequest([message("user", "hello")], {
    model: "claude-opus-4-8",
    protocol: "anthropic-messages",
    stream: false,
  });
}

function streamRequest(): CanonicalRequest {
  return canonicalRequest([message("user", "hello")], {
    model: "claude-opus-4-8",
    protocol: "anthropic-messages",
    stream: true,
  });
}

function replayRequest(): CanonicalRequest {
  return {
    canonicalVersion: 1,
    protocol: "anthropic-messages",
    projectionMode: "v3-auto",
    model: "claude-sonnet-5",
    stream: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "prior answer", path: "input.1.content.0.text" }],
        toolCalls: [],
        path: "input.1",
      },
      {
        role: "user",
        content: [{ type: "text", text: "continue", path: "input.2.content.0.text" }],
        toolCalls: [],
        path: "input.2",
      },
    ],
    tools: [],
    toolChoice: "auto",
    reasoningReplays: [
      {
        lookup: { kind: "anthropic-token", signature: "kr1_test" },
        outputFingerprint: assistantOutputFingerprint({ text: "prior answer", toolCalls: [] }),
        insertBeforeMessage: 0,
        path: "input.0",
      },
    ],
    includeEncryptedReasoning: true,
  };
}

/** Owner-bound replay: the token names both the account and the conversation. */
function ownerLockedReplayStore(
  accountId: string,
  conversationId: string,
): PipelineReasoningReplayStore {
  return {
    readiness: () => ({ writable: true, keyringAvailable: true, missingKeyIds: [] }),
    store: () => undefined,
    resolveResponses: (_token, _context, insertBeforeMessage) => ({
      accountId,
      conversationId,
      replay: {
        insertBeforeMessage,
        content: { kind: "reasoning_text", text: "signed reasoning", signature: "native" },
      },
    }),
    resolveChat: () => {
      throw new TypeError("Chat replay is not used by this test");
    },
  };
}

/**
 * A store whose lineage write fails the way a full disk or a locked database
 * would, after the upstream has already delivered the whole output.
 */
function failingLineageStore(store: AccountsDatabase): PipelineAffinityStore {
  return {
    getSessionAffinity: (keyHash, now) => store.getSessionAffinity(keyHash, now),
    claimSessionAffinity: (...args) => store.claimSessionAffinity(...args),
    rebindSessionAffinity: (...args) => store.rebindSessionAffinity(...args),
    resolveOutputLineage: (keyHash, now) => store.resolveOutputLineage(keyHash, now),
    recordOutputLineage: () => {
      throw new TypeError("database is locked");
    },
  };
}

function seedBinding(store: AccountsDatabase, accountId: string, conversationId: string): void {
  store.claimSessionAffinity(AFFINITY.keyHash, accountId, conversationId, Date.now(), 60_000, 100);
}

/**
 * Brings the tracker to `count` consecutive stalls inside the window, recorded
 * against the account that stalled the way a published terminal would.
 */
function seedStalls(
  tracker: AffinityStallTracker,
  count: number,
  accountId = "account-a",
  keyHash: string = AFFINITY.keyHash,
): void {
  const now = Date.now();
  for (let index = 0; index < count; index += 1) {
    tracker.record(keyHash, now, 600_000, 100, accountId);
  }
}

let audit: ReturnType<typeof captureAuditEvents>;

beforeEach(() => {
  audit = captureAuditEvents();
});

afterEach(() => {
  audit.restore();
});

describe("recording published stall terminals against an affinity", () => {
  test("an idle-timed-out published stream records a stall and arms the failover", async () => {
    const store = new AccountsDatabase(":memory:");
    const tracker = new AffinityStallTracker();
    try {
      seedBinding(store, "account-a", "conversation-a");
      const response = await runChatCompletion({
        requestId: "req-stall-1",
        body: streamRequest(),
        model: "claude-opus-4-8",
        stream: true,
        config: config({ session_affinity_stall_failover_threshold: 1 }),
        accountManager: new PreferredAccountManager([account("account-a"), account("account-b")]),
        tokenRefresher: refresher,
        affinity: AFFINITY,
        affinityStore: store,
        affinityStalls: tracker,
        makeClient: () => clientWith(stallingResponse),
      });

      await expect(response.text()).rejects.toMatchObject({ name: "StreamIdleTimeoutError" });

      expect(audit.events("session_affinity_stall_recorded")).toEqual([
        expect.objectContaining({
          level: "warn",
          request_id: "req-stall-1",
          protocol: "anthropic-messages",
          affinity_source: AFFINITY.source,
          affinity_hash: auditHash(AFFINITY.keyHash),
          terminal_provenance: "idle_timeout",
          stall_count: 1,
          stall_span_ms: 0,
          stall_threshold: 1,
          stall_window_ms: 600_000,
          failover_armed: true,
        }),
      ]);
      expect(tracker.peek(AFFINITY.keyHash, Date.now(), 600_000)?.count).toBe(1);
      // The raw session key never reaches the log; only its hash does.
      expect(JSON.stringify(audit.events("session_affinity_stall_recorded"))).not.toContain(
        AFFINITY.keyHash,
      );
    } finally {
      store.close();
    }
  });

  test("a healthy published stream clears the streak", async () => {
    const store = new AccountsDatabase(":memory:");
    const tracker = new AffinityStallTracker();
    try {
      seedBinding(store, "account-a", "conversation-a");
      seedStalls(tracker, 1);
      const response = await runChatCompletion({
        body: streamRequest(),
        model: "claude-opus-4-8",
        stream: true,
        config: config(),
        accountManager: new PreferredAccountManager([account("account-a"), account("account-b")]),
        tokenRefresher: refresher,
        affinity: AFFINITY,
        affinityStore: store,
        affinityStalls: tracker,
        makeClient: () => clientWith(completingResponse),
      });
      await response.text();

      expect(tracker.peek(AFFINITY.keyHash, Date.now(), 600_000)).toBeUndefined();
      expect(audit.events("session_affinity_stall_recorded")).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("counts the request deadline when it lands on an upstream that went quiet", async () => {
    const store = new AccountsDatabase(":memory:");
    const tracker = new AffinityStallTracker();
    try {
      seedBinding(store, "account-a", "conversation-a");
      // The deadline is shorter than the idle watchdog, so the wedged stream can
      // only ever terminate as an abort. Ignoring it with the client cancels
      // would leave this configuration permanently below the threshold. It still
      // has to outlast `MIN_UPSTREAM_QUIET_MS`, which is what separates a wedged
      // conversation from ordinary upstream latency.
      const response = await runChatCompletion({
        body: streamRequest(),
        model: "claude-opus-4-8",
        stream: true,
        config: config({
          session_affinity_stall_failover_threshold: 1,
          request_timeout_ms: 1_400,
          stream_idle_timeout_ms: 5_000,
        }),
        accountManager: new PreferredAccountManager([account("account-a"), account("account-b")]),
        tokenRefresher: refresher,
        affinity: AFFINITY,
        affinityStore: store,
        affinityStalls: tracker,
        makeClient: () => clientWith(stallingResponse),
      });

      await expect(response.text()).rejects.toBeDefined();

      expect(audit.events("session_affinity_stall_recorded")).toEqual([
        expect.objectContaining({
          terminal_provenance: "external_abort",
          stall_count: 1,
          failover_armed: true,
        }),
      ]);
      expect(tracker.peek(AFFINITY.keyHash, Date.now(), 600_000)?.count).toBe(1);
    } finally {
      store.close();
    }
  });

  test("ignores a request deadline that lands while the consumer has stopped reading", async () => {
    const store = new AccountsDatabase(":memory:");
    const tracker = new AffinityStallTracker();
    try {
      seedBinding(store, "account-a", "conversation-a");
      const response = await runChatCompletion({
        body: streamRequest(),
        model: "claude-opus-4-8",
        stream: true,
        config: config({
          session_affinity_stall_failover_threshold: 1,
          request_timeout_ms: 1_400,
          stream_idle_timeout_ms: 5_000,
        }),
        accountManager: new PreferredAccountManager([account("account-a"), account("account-b")]),
        tokenRefresher: refresher,
        affinity: AFFINITY,
        affinityStore: store,
        affinityStalls: tracker,
        makeClient: () => clientWith(flowingResponse),
      });

      // The published stream is pulled by its consumer, so a client that reads one
      // chunk and stops also stops the upstream from being asked for anything. The
      // last frame then ages without evidence, and treating that as upstream
      // silence would fail a healthy binding over on downstream backpressure.
      const reader = response.body?.getReader();
      if (!reader) throw new Error("expected a published stream body");
      await reader.read();
      await new Promise((resolve) => setTimeout(resolve, 1_800));

      expect(audit.events("session_affinity_stall_recorded")).toEqual([]);
      expect(tracker.size).toBe(0);

      await reader.cancel().catch(() => undefined);
    } finally {
      store.close();
    }
  });

  test("ignores a request deadline that lands after a read served from the buffer", async () => {
    const store = new AccountsDatabase(":memory:");
    const tracker = new AffinityStallTracker();
    try {
      seedBinding(store, "account-a", "conversation-a");
      const response = await runChatCompletion({
        body: streamRequest(),
        model: "claude-opus-4-8",
        stream: true,
        config: config({
          session_affinity_stall_failover_threshold: 1,
          request_timeout_ms: 1_400,
          stream_idle_timeout_ms: 5_000,
        }),
        accountManager: new PreferredAccountManager([account("account-a"), account("account-b")]),
        tokenRefresher: refresher,
        affinity: AFFINITY,
        affinityStore: store,
        affinityStalls: tracker,
        makeClient: () => clientWith(bufferedPairResponse),
      });

      // One frame can carry several canonical events, so the read that delivers
      // the second one resumes the transformer without reaching the upstream. A
      // raw frame is therefore not what ends a read: tying the silence stamp to
      // frames would leave it armed here, and a deadline landing while the client
      // has stopped reading would count as an upstream stall.
      const reader = response.body?.getReader();
      if (!reader) throw new Error("expected a published stream body");
      await reader.read();
      await reader.read();
      await new Promise((resolve) => setTimeout(resolve, 1_800));

      expect(audit.events("session_affinity_stall_recorded")).toEqual([]);
      expect(tracker.size).toBe(0);

      await reader.cancel().catch(() => undefined);
    } finally {
      store.close();
    }
  });

  test("excludes the account that stalled, not the replacement a failed failover stored", async () => {
    const store = new AccountsDatabase(":memory:");
    const tracker = new AffinityStallTracker();
    // Sticky ranks the stalled account best again, so only withholding it from
    // the eligible set can move selection off it.
    const manager = new StickyAccountManager(
      [account("account-a"), account("account-b")],
      "account-a",
    );
    try {
      // What an earlier failover that died after rebinding leaves behind: storage
      // names the replacement it never got to prove, while the streak is still
      // armed against the account that actually stalled.
      seedBinding(store, "account-b", "conversation-b");
      seedStalls(tracker, 2, "account-a");
      const selectedAccountIds: Array<string | undefined> = [];
      const response = await runChatCompletion({
        body: streamRequest(),
        model: "claude-opus-4-8",
        stream: true,
        config: config({ session_affinity_stall_failover_threshold: 2 }),
        accountManager: manager,
        tokenRefresher: refresher,
        affinity: AFFINITY,
        affinityStore: store,
        affinityStalls: tracker,
        makeClient: (...factoryArgs) => {
          selectedAccountIds.push(factoryArgs[5]);
          return clientWith(completingResponse);
        },
      });
      await response.text();

      // Excluding by stored account would hold out account-b and hand the request
      // straight back to the wedged account-a.
      expect(selectedAccountIds).toEqual(["account-b"]);
      expect(manager.eligibleRequests[0]).toEqual(["account-b"]);
    } finally {
      store.close();
    }
  });

  test("keeps a lineage quarantine armed while the wedged lineage row survives", async () => {
    const store = new AccountsDatabase(":memory:");
    const tracker = new AffinityStallTracker();
    const manager = new StickyAccountManager(
      [account("account-a"), account("account-b")],
      "account-a",
    );
    try {
      store.recordOutputLineage(
        LINEAGE.lookupKeyHash,
        "account-a",
        "conversation-a",
        Date.now(),
        60_000,
        100,
      );
      seedStalls(tracker, 1, "account-a", LINEAGE.lookupKeyHash);
      const selectedAccountIds: Array<string | undefined> = [];
      const runOnce = async (): Promise<void> => {
        const response = await runChatCompletion({
          body: streamRequest(),
          model: "claude-opus-4-8",
          stream: true,
          config: config({ session_affinity_stall_failover_threshold: 1 }),
          accountManager: manager,
          tokenRefresher: refresher,
          lineage: LINEAGE,
          affinityStore: store,
          affinityStalls: tracker,
          makeClient: (...factoryArgs) => {
            selectedAccountIds.push(factoryArgs[5]);
            return clientWith(completingResponse);
          },
        });
        await response.text();
      };

      await runOnce();

      // A healthy answer on the replacement account does not make the stored
      // lineage row healthy: it still keys the previous history and still resolves
      // to the account that stalled. Retiring the streak here would let the client
      // re-sending that same history walk back into it unprotected.
      expect(tracker.peek(LINEAGE.lookupKeyHash, Date.now(), 600_000)?.count).toBe(1);

      await runOnce();

      expect(selectedAccountIds).toEqual(["account-b", "account-b"]);
      expect(audit.events("session_affinity_stall_failover")).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  test("keeps a sub-threshold lineage streak when another account answered", async () => {
    const store = new AccountsDatabase(":memory:");
    const tracker = new AffinityStallTracker();
    try {
      store.recordOutputLineage(
        LINEAGE.lookupKeyHash,
        "account-a",
        "conversation-a",
        Date.now(),
        60_000,
        100,
      );
      seedStalls(tracker, 1, "account-a", LINEAGE.lookupKeyHash);
      const selectedAccountIds: Array<string | undefined> = [];
      const response = await runChatCompletion({
        body: streamRequest(),
        model: "claude-opus-4-8",
        stream: true,
        // Two stalls arm the failover, so this request still honours the binding.
        config: config({ session_affinity_stall_failover_threshold: 2 }),
        accountManager: new PreferredAccountManager([unhealthy("account-a"), account("account-b")]),
        tokenRefresher: refresher,
        lineage: LINEAGE,
        affinityStore: store,
        affinityStalls: tracker,
        makeClient: (...factoryArgs) => {
          selectedAccountIds.push(factoryArgs[5]);
          return clientWith(completingResponse);
        },
      });
      await response.text();

      // The bound account was simply unselectable this time, so the answer came
      // from elsewhere and the lineage row still names the account that stalled.
      // Retiring the streak on it would restart the count from zero every time
      // the binding is unavailable, and the threshold would never be reached.
      expect(selectedAccountIds).toEqual(["account-b"]);
      expect(tracker.peek(LINEAGE.lookupKeyHash, Date.now(), 600_000)?.count).toBe(1);
      expect(audit.events("session_affinity_stall_failover")).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("retires a sub-threshold lineage streak when the bound cell answers", async () => {
    const store = new AccountsDatabase(":memory:");
    const tracker = new AffinityStallTracker();
    try {
      store.recordOutputLineage(
        LINEAGE.lookupKeyHash,
        "account-a",
        "conversation-a",
        Date.now(),
        60_000,
        100,
      );
      seedStalls(tracker, 1, "account-a", LINEAGE.lookupKeyHash);
      const selectedAccountIds: Array<string | undefined> = [];
      const response = await runChatCompletion({
        body: streamRequest(),
        model: "claude-opus-4-8",
        stream: true,
        config: config({ session_affinity_stall_failover_threshold: 2 }),
        accountManager: new PreferredAccountManager([account("account-a"), account("account-b")]),
        tokenRefresher: refresher,
        lineage: LINEAGE,
        affinityStore: store,
        affinityStalls: tracker,
        makeClient: (...factoryArgs) => {
          selectedAccountIds.push(factoryArgs[5]);
          return clientWith(completingResponse);
        },
      });
      await response.text();

      // The row's own account and conversation answered, so the row is proven
      // healthy and holding the streak would fail a working binding over later.
      expect(selectedAccountIds).toEqual(["account-a"]);
      expect(tracker.size).toBe(0);
    } finally {
      store.close();
    }
  });

  test("never counts a stream that failed on a provider-local write", async () => {
    const store = new AccountsDatabase(":memory:");
    const tracker = new AffinityStallTracker();
    try {
      const response = await runChatCompletion({
        requestId: "req-local-persistence",
        body: streamRequest(),
        model: "claude-opus-4-8",
        stream: true,
        config: config({ session_affinity_stall_failover_threshold: 1 }),
        accountManager: new PreferredAccountManager([account("account-a"), account("account-b")]),
        tokenRefresher: refresher,
        lineage: LINEAGE,
        affinityStore: failingLineageStore(store),
        affinityStalls: tracker,
        makeClient: () => clientWith(completingResponse),
      });

      // The upstream completed; only the local write failed. The client contract is
      // unchanged — a retryable upstream-family stream error — but the terminal is
      // not account evidence.
      await expect(response.text()).rejects.toMatchObject({
        name: "OutputPersistenceError",
        code: "local_output_persistence_failed",
      });
      expect(audit.events("sdk_stream_upstream_error")).toHaveLength(1);
      expect(audit.events("session_affinity_stall_recorded")).toEqual([]);
      expect(tracker.size).toBe(0);
    } finally {
      store.close();
    }
  });

  test("retires an armed streak when only the provider-local write failed", async () => {
    const store = new AccountsDatabase(":memory:");
    const tracker = new AffinityStallTracker();
    try {
      seedBinding(store, "account-a", "conversation-a");
      seedStalls(tracker, 1);
      const selectedAccountIds: Array<string | undefined> = [];
      const response = await runChatCompletion({
        requestId: "req-local-persistence-armed",
        body: streamRequest(),
        model: "claude-opus-4-8",
        stream: true,
        config: config({ session_affinity_stall_failover_threshold: 1 }),
        accountManager: new PreferredAccountManager([account("account-a"), account("account-b")]),
        tokenRefresher: refresher,
        affinity: AFFINITY,
        lineage: LINEAGE,
        affinityStore: failingLineageStore(store),
        affinityStalls: tracker,
        makeClient: (...factoryArgs) => {
          selectedAccountIds.push(factoryArgs[5]);
          return clientWith(completingResponse);
        },
      });

      await expect(response.text()).rejects.toMatchObject({
        name: "OutputPersistenceError",
      });

      // The armed streak already moved this request to the replacement account and
      // rebound the key to it. That account then delivered a witnessed answer and
      // only the local write failed, so holding the streak would keep re-binding
      // every following request for a fault no failover can repair.
      expect(selectedAccountIds).toEqual(["account-b"]);
      expect(tracker.size).toBe(0);
    } finally {
      store.close();
    }
  });

  test("ignores a request deadline that lands while frames are still flowing", async () => {
    const store = new AccountsDatabase(":memory:");
    const tracker = new AffinityStallTracker();
    try {
      seedBinding(store, "account-a", "conversation-a");
      const response = await runChatCompletion({
        body: streamRequest(),
        model: "claude-opus-4-8",
        stream: true,
        config: config({
          session_affinity_stall_failover_threshold: 1,
          request_timeout_ms: 250,
          stream_idle_timeout_ms: 5_000,
        }),
        accountManager: new PreferredAccountManager([account("account-a"), account("account-b")]),
        tokenRefresher: refresher,
        affinity: AFFINITY,
        affinityStore: store,
        affinityStalls: tracker,
        makeClient: () => clientWith(flowingResponse),
      });

      await expect(response.text()).rejects.toBeDefined();

      // A deadline too short for a long answer is not evidence about the account,
      // so it must not push an otherwise healthy binding toward a failover.
      expect(audit.events("session_affinity_stall_recorded")).toEqual([]);
      expect(tracker.size).toBe(0);
    } finally {
      store.close();
    }
  });

  test("threshold 0 disables the streak entirely", async () => {
    const store = new AccountsDatabase(":memory:");
    const tracker = new AffinityStallTracker();
    try {
      seedBinding(store, "account-a", "conversation-a");
      const response = await runChatCompletion({
        body: streamRequest(),
        model: "claude-opus-4-8",
        stream: true,
        config: config({ session_affinity_stall_failover_threshold: 0 }),
        accountManager: new PreferredAccountManager([account("account-a"), account("account-b")]),
        tokenRefresher: refresher,
        affinity: AFFINITY,
        affinityStore: store,
        affinityStalls: tracker,
        makeClient: () => clientWith(stallingResponse),
      });

      await expect(response.text()).rejects.toMatchObject({ name: "StreamIdleTimeoutError" });

      expect(tracker.size).toBe(0);
      expect(audit.events("session_affinity_stall_recorded")).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("failing a wedged affinity over on the next independent request", () => {
  test("honours the stored binding while the streak is below the threshold", async () => {
    const store = new AccountsDatabase(":memory:");
    const tracker = new AffinityStallTracker();
    const manager = new PreferredAccountManager([account("account-b"), account("account-a")]);
    try {
      seedBinding(store, "account-a", "conversation-a");
      seedStalls(tracker, 1);
      const selectedAccountIds: Array<string | undefined> = [];
      const response = await runChatCompletion({
        body: streamRequest(),
        model: "claude-opus-4-8",
        stream: true,
        config: config({ session_affinity_stall_failover_threshold: 2 }),
        accountManager: manager,
        tokenRefresher: refresher,
        affinity: AFFINITY,
        affinityStore: store,
        affinityStalls: tracker,
        makeClient: (...factoryArgs) => {
          selectedAccountIds.push(factoryArgs[5]);
          return clientWith(completingResponse);
        },
      });
      await response.text();

      expect(manager.preferredRequests).toContain("account-a");
      expect(selectedAccountIds).toEqual(["account-a"]);
      expect(store.getSessionAffinity(AFFINITY.keyHash)).toMatchObject({
        accountId: "account-a",
        conversationId: "conversation-a",
      });
      expect(audit.events("session_affinity_stall_failover")).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("drops the binding at the threshold and rebinds to a fresh account and conversation", async () => {
    const store = new AccountsDatabase(":memory:");
    const tracker = new AffinityStallTracker();
    const manager = new PreferredAccountManager([account("account-b"), account("account-a")]);
    try {
      seedBinding(store, "account-a", "conversation-a");
      seedStalls(tracker, 2);
      const selectedAccountIds: Array<string | undefined> = [];
      const response = await runChatCompletion({
        requestId: "req-failover",
        body: streamRequest(),
        model: "claude-opus-4-8",
        stream: true,
        config: config({ session_affinity_stall_failover_threshold: 2 }),
        accountManager: manager,
        tokenRefresher: refresher,
        affinity: AFFINITY,
        affinityStore: store,
        affinityStalls: tracker,
        makeClient: (...factoryArgs) => {
          selectedAccountIds.push(factoryArgs[5]);
          return clientWith(completingResponse);
        },
      });
      await response.text();

      // The wedged account is no longer offered as the preference, so selection
      // is free to move, and the stored row is overwritten rather than re-adopted.
      expect(manager.preferredRequests).not.toContain("account-a");
      expect(selectedAccountIds).toEqual(["account-b"]);
      const rebound = store.getSessionAffinity(AFFINITY.keyHash);
      expect(rebound).toMatchObject({ accountId: "account-b" });
      expect(rebound?.conversationId).not.toBe("conversation-a");
      expect(audit.events("session_affinity_stall_failover")).toEqual([
        expect.objectContaining({
          level: "warn",
          request_id: "req-failover",
          affinity_source: AFFINITY.source,
          affinity_hash: auditHash(AFFINITY.keyHash),
          stall_count: 2,
          stall_threshold: 2,
          quarantined_binding: true,
          quarantined_lineage: false,
        }),
      ]);
      // The replacement stream completed normally, and that healthy terminal is
      // what retires the streak, so the new binding is not re-quarantined.
      expect(tracker.peek(AFFINITY.keyHash, Date.now(), 600_000)).toBeUndefined();
      expect(JSON.stringify(audit.events("session_affinity_stall_failover"))).not.toContain(
        AFFINITY.keyHash,
      );
    } finally {
      store.close();
    }
  });

  test("a successful non-stream completion retires the streak it failed over on", async () => {
    const store = new AccountsDatabase(":memory:");
    const tracker = new AffinityStallTracker();
    const manager = new StickyAccountManager(
      [account("account-a"), account("account-b")],
      "account-a",
    );
    try {
      seedBinding(store, "account-a", "conversation-a");
      seedStalls(tracker, 2);
      const selectedAccountIds: Array<string | undefined> = [];
      const response = await runChatCompletion({
        body: nonStreamRequest(),
        model: "claude-opus-4-8",
        stream: false,
        config: config({ session_affinity_stall_failover_threshold: 2 }),
        accountManager: manager,
        tokenRefresher: refresher,
        affinity: AFFINITY,
        affinityStore: store,
        affinityStalls: tracker,
        makeClient: (...factoryArgs) => {
          selectedAccountIds.push(factoryArgs[5]);
          return clientWith(completingResponse);
        },
      });
      await response.json();

      // The quarantine applies to this lane too, so its successes have to retire
      // the streak; otherwise every following non-stream request would re-drop the
      // replacement binding and mint another conversation until the window elapsed.
      expect(selectedAccountIds).toEqual(["account-b"]);
      expect(tracker.peek(AFFINITY.keyHash, Date.now(), 600_000)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("never moves a reasoning replay owner lock, however long the streak", async () => {
    const store = new AccountsDatabase(":memory:");
    const tracker = new AffinityStallTracker();
    const manager = new PreferredAccountManager([account("account-b"), account("account-a")]);
    try {
      seedBinding(store, "account-a", "conversation-a");
      seedStalls(tracker, 5);
      const selectedAccountIds: Array<string | undefined> = [];
      const response = await runChatCompletion({
        body: replayRequest(),
        model: "claude-sonnet-5",
        stream: true,
        config: config({ session_affinity_stall_failover_threshold: 2 }),
        accountManager: manager,
        tokenRefresher: refresher,
        tenantId: "tenant-a",
        reasoningReplayStore: ownerLockedReplayStore("account-a", "conversation-a"),
        affinity: AFFINITY,
        affinityStore: store,
        affinityStalls: tracker,
        makeClient: (...factoryArgs) => {
          selectedAccountIds.push(factoryArgs[5]);
          return clientWith(completingResponse);
        },
      });
      await response.text();

      expect(selectedAccountIds).toEqual(["account-a"]);
      expect(store.getSessionAffinity(AFFINITY.keyHash)).toMatchObject({
        accountId: "account-a",
        conversationId: "conversation-a",
      });
      expect(audit.events("session_affinity_stall_failover")).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("withholds the stalled account from selection when the strategy still ranks it best", async () => {
    const store = new AccountsDatabase(":memory:");
    const tracker = new AffinityStallTracker();
    const manager = new StickyAccountManager(
      [account("account-a"), account("account-b")],
      "account-a",
    );
    try {
      seedBinding(store, "account-a", "conversation-a");
      seedStalls(tracker, 2);
      const selectedAccountIds: Array<string | undefined> = [];
      const response = await runChatCompletion({
        body: streamRequest(),
        model: "claude-opus-4-8",
        stream: true,
        config: config({ session_affinity_stall_failover_threshold: 2 }),
        accountManager: manager,
        tokenRefresher: refresher,
        affinity: AFFINITY,
        affinityStore: store,
        affinityStalls: tracker,
        makeClient: (...factoryArgs) => {
          selectedAccountIds.push(factoryArgs[5]);
          return clientWith(completingResponse);
        },
      });
      await response.text();

      // Clearing the preference is not what moved it: the wedged account was
      // absent from the candidate set the manager was asked to choose from.
      expect(manager.eligibleRequests[0]).toEqual(["account-b"]);
      expect(selectedAccountIds).toEqual(["account-b"]);
      expect(store.getSessionAffinity(AFFINITY.keyHash)).toMatchObject({
        accountId: "account-b",
      });
    } finally {
      store.close();
    }
  });

  test("keeps the stall evidence when the failover request dies before a replacement exists", async () => {
    const store = new AccountsDatabase(":memory:");
    const tracker = new AffinityStallTracker();
    try {
      seedBinding(store, "account-a", "conversation-a");
      seedStalls(tracker, 2);
      // The failover is decided, then selection finds nothing to move to. The
      // stored row still points at the wedged account, so discarding the streak
      // here would send the next request straight back into the same stall.
      const blocked = await runChatCompletion({
        body: streamRequest(),
        model: "claude-opus-4-8",
        stream: true,
        config: config({ session_affinity_stall_failover_threshold: 2 }),
        accountManager: new PreferredAccountManager([
          unhealthy("account-a"),
          unhealthy("account-b"),
        ]),
        tokenRefresher: refresher,
        affinity: AFFINITY,
        affinityStore: store,
        affinityStalls: tracker,
        makeClient: () => clientWith(completingResponse),
      });

      expect(blocked.status).toBe(503);
      expect(audit.events("session_affinity_stall_failover")).toHaveLength(1);
      expect(tracker.peek(AFFINITY.keyHash, Date.now(), 600_000)?.count).toBe(2);
      expect(store.getSessionAffinity(AFFINITY.keyHash)).toMatchObject({
        accountId: "account-a",
        conversationId: "conversation-a",
      });

      // Still armed, so the next request that does have somewhere to go recovers.
      const manager = new StickyAccountManager(
        [account("account-a"), account("account-b")],
        "account-a",
      );
      const selectedAccountIds: Array<string | undefined> = [];
      const recovered = await runChatCompletion({
        body: streamRequest(),
        model: "claude-opus-4-8",
        stream: true,
        config: config({ session_affinity_stall_failover_threshold: 2 }),
        accountManager: manager,
        tokenRefresher: refresher,
        affinity: AFFINITY,
        affinityStore: store,
        affinityStalls: tracker,
        makeClient: (...factoryArgs) => {
          selectedAccountIds.push(factoryArgs[5]);
          return clientWith(completingResponse);
        },
      });
      await recovered.text();

      expect(selectedAccountIds).toEqual(["account-b"]);
      expect(store.getSessionAffinity(AFFINITY.keyHash)).toMatchObject({ accountId: "account-b" });
      // The healthy terminal is what retires the streak, not the act of failing over.
      expect(tracker.peek(AFFINITY.keyHash, Date.now(), 600_000)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("still serves the request from the stalled account when it is the only candidate", async () => {
    const store = new AccountsDatabase(":memory:");
    const tracker = new AffinityStallTracker();
    const manager = new StickyAccountManager([account("account-a")], "account-a");
    try {
      seedBinding(store, "account-a", "conversation-a");
      seedStalls(tracker, 2);
      const selectedAccountIds: Array<string | undefined> = [];
      const response = await runChatCompletion({
        body: streamRequest(),
        model: "claude-opus-4-8",
        stream: true,
        config: config({ session_affinity_stall_failover_threshold: 2 }),
        accountManager: manager,
        tokenRefresher: refresher,
        affinity: AFFINITY,
        affinityStore: store,
        affinityStalls: tracker,
        makeClient: (...factoryArgs) => {
          selectedAccountIds.push(factoryArgs[5]);
          return clientWith(completingResponse);
        },
      });
      await response.text();

      // The quarantine is a routing preference, not a ban: with nothing else to
      // choose the request is still served, on a fresh conversation.
      expect(selectedAccountIds).toEqual(["account-a"]);
      const rebound = store.getSessionAffinity(AFFINITY.keyHash);
      expect(rebound).toMatchObject({ accountId: "account-a" });
      expect(rebound?.conversationId).not.toBe("conversation-a");
    } finally {
      store.close();
    }
  });

  test("counts stalls for a lineage-only continuation that carries no affinity key", async () => {
    const store = new AccountsDatabase(":memory:");
    const tracker = new AffinityStallTracker();
    const manager = new StickyAccountManager(
      [account("account-a"), account("account-b")],
      "account-a",
    );
    try {
      store.recordOutputLineage(
        LINEAGE.lookupKeyHash,
        "account-a",
        "conversation-a",
        Date.now(),
        60_000,
        100,
      );
      // No affinity key at all: under the default explicit-only mode this is
      // what an ordinary multi-turn client without a session header looks like.
      const stalled = await runChatCompletion({
        requestId: "req-lineage-stall",
        body: streamRequest(),
        model: "claude-opus-4-8",
        stream: true,
        config: config({ session_affinity_stall_failover_threshold: 1 }),
        accountManager: manager,
        tokenRefresher: refresher,
        lineage: LINEAGE,
        affinityStore: store,
        affinityStalls: tracker,
        makeClient: () => clientWith(stallingResponse),
      });
      await expect(stalled.text()).rejects.toMatchObject({ name: "StreamIdleTimeoutError" });

      expect(tracker.peek(LINEAGE.lookupKeyHash, Date.now(), 600_000)?.count).toBe(1);
      expect(audit.events("session_affinity_stall_recorded")).toEqual([
        expect.objectContaining({
          request_id: "req-lineage-stall",
          affinity_source: LINEAGE.source,
          affinity_hash: auditHash(LINEAGE.lookupKeyHash),
          stall_count: 1,
          failover_armed: true,
        }),
      ]);

      const selectedAccountIds: Array<string | undefined> = [];
      const healthy = await runChatCompletion({
        body: streamRequest(),
        model: "claude-opus-4-8",
        stream: true,
        config: config({ session_affinity_stall_failover_threshold: 1 }),
        accountManager: manager,
        tokenRefresher: refresher,
        lineage: LINEAGE,
        affinityStore: store,
        affinityStalls: tracker,
        makeClient: (...factoryArgs) => {
          selectedAccountIds.push(factoryArgs[5]);
          return clientWith(completingResponse);
        },
      });
      await healthy.text();

      expect(selectedAccountIds).toEqual(["account-b"]);
      expect(audit.events("session_affinity_stall_failover")).toEqual([
        expect.objectContaining({
          affinity_source: LINEAGE.source,
          affinity_hash: auditHash(LINEAGE.lookupKeyHash),
          quarantined_binding: false,
          quarantined_lineage: true,
        }),
      ]);
    } finally {
      store.close();
    }
  });

  test("quarantines an output-lineage binding when no session binding is stored", async () => {
    const store = new AccountsDatabase(":memory:");
    const tracker = new AffinityStallTracker();
    const manager = new PreferredAccountManager([account("account-b"), account("account-a")]);
    try {
      store.recordOutputLineage(
        "lineage-key",
        "account-a",
        "conversation-a",
        Date.now(),
        60_000,
        100,
      );
      seedStalls(tracker, 2);
      const selectedAccountIds: Array<string | undefined> = [];
      const response = await runChatCompletion({
        body: streamRequest(),
        model: "claude-opus-4-8",
        stream: true,
        config: config({ session_affinity_stall_failover_threshold: 2 }),
        accountManager: manager,
        tokenRefresher: refresher,
        affinity: AFFINITY,
        lineage: {
          lookupKeyHash: "lineage-key",
          source: "canonical.assistant-output",
          outputKeyHash: (fingerprint) => `lineage-${fingerprint}`,
        },
        affinityStore: store,
        affinityStalls: tracker,
        makeClient: (...factoryArgs) => {
          selectedAccountIds.push(factoryArgs[5]);
          return clientWith(completingResponse);
        },
      });
      await response.text();

      expect(selectedAccountIds).toEqual(["account-b"]);
      expect(audit.events("session_affinity_stall_failover")).toEqual([
        expect.objectContaining({
          quarantined_binding: false,
          quarantined_lineage: true,
        }),
      ]);
    } finally {
      store.close();
    }
  });
});
