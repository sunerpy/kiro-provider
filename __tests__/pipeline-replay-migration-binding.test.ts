import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import { auditHash } from "../src/core/audit-log.js";
import {
  type PipelineAccountManager,
  type PipelineAffinityStore,
  type PipelineReasoningReplayStore,
  type PipelineTokenRefresher,
  runChatCompletion,
} from "../src/core/pipeline.js";
import { accountQueueDepth, acquireAccountQueue } from "../src/core/pipeline-runtime.js";
import type {
  SdkStreamEvent,
  SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import { assistantOutputFingerprint, type CanonicalRequest } from "../src/protocol/canonical.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";
import { type AuditRecord, captureAuditEvents } from "./audit-test-helpers.js";
import { canonicalRequest, message } from "./canonical-test-helpers.js";

/**
 * Regression coverage for the production incident where a Codex thread that
 * carried signed reasoning replays was migrated to another account merely
 * because its origin account had one request in flight, the new binding was
 * persisted before Kiro accepted anything, and the upstream then rejected the
 * migrated history with HTTP 400 `REQUEST_BODY_INVALID`. Every client retry on
 * that thread then reproduced the failure on the rewritten binding.
 */

const THREAD = { keyHash: "thread-1", source: "responses.client_metadata.thread_id" } as const;
const ORIGIN = "account-a";
const TARGET = "account-b";
/** An idle third account: a rejected migration must never hop onto it. */
const THIRD = "account-c";
const ORIGIN_CONVERSATION = "conversation-a";
const REJECTION_MESSAGE = "Improperly formed request.";
const STORE_FAULT_MESSAGE = "database or disk is full /var/lib/kiro-provider/accounts.db";

function account(id: string, overrides: Partial<ManagedAccount> = {}): ManagedAccount {
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
    ...overrides,
  };
}

/** Honors the preferred account when it is a candidate, otherwise round-robins. */
class PreferredAccountManager implements PipelineAccountManager {
  readonly rateLimited: string[] = [];
  readonly quotaExhausted: string[] = [];
  readonly unhealthy: string[] = [];
  private cursor = 0;

  constructor(readonly accounts: ManagedAccount[]) {}

  reconcileFromDb(): readonly ManagedAccount[] {
    return this.accounts;
  }

  selectHealthyAccount(
    preferredAccountId?: string,
    eligibleAccountIds?: ReadonlySet<string>,
  ): ManagedAccount | null {
    const now = Date.now();
    const selectable = this.accounts.filter(
      (candidate) =>
        candidate.isHealthy &&
        candidate.rateLimitResetTime <= now &&
        (eligibleAccountIds?.has(candidate.id) ?? true),
    );
    if (selectable.length === 0) return null;
    const preferred = selectable.find((candidate) => candidate.id === preferredAccountId);
    if (preferred) return preferred;
    const selected = selectable[this.cursor % selectable.length];
    this.cursor += 1;
    return selected ?? null;
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

  markRateLimited(selected: ManagedAccount, resetTime: number): void {
    selected.rateLimitResetTime = resetTime;
    this.rateLimited.push(selected.id);
  }

  markQuotaExhausted(selected: ManagedAccount, recheckAfter: number): void {
    if ((selected.limitCount ?? 0) > 0) {
      selected.usedCount = Math.max(selected.usedCount ?? 0, selected.limitCount ?? 0);
    }
    selected.rateLimitResetTime = Math.max(selected.rateLimitResetTime, recheckAfter);
    this.quotaExhausted.push(selected.id);
  }

  markUnhealthy(selected: ManagedAccount, reason: string): void {
    selected.failCount += 1;
    selected.isHealthy = selected.failCount < 10 && !reason.includes("InvalidTokenException");
    selected.unhealthyReason = reason;
    this.unhealthy.push(selected.id);
  }
}

class FakeTokenRefresher implements PipelineTokenRefresher {
  async refreshIfNeeded(
    selected: ManagedAccount,
    _auth: KiroAuthDetails,
    signal?: AbortSignal,
  ): Promise<ManagedAccount> {
    if (!signal) throw new TypeError("pipeline must pass a refresh AbortSignal");
    return selected;
  }

  async forceRefresh(selected: ManagedAccount, signal?: AbortSignal): Promise<ManagedAccount> {
    if (!signal) throw new TypeError("pipeline must pass a force-refresh AbortSignal");
    return selected;
  }
}

function config(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    api_keys: ["sk-test"],
    request_timeout_ms: 5_000,
    stream_idle_timeout_ms: 1_000,
    rate_limit_retry_delay_ms: 10,
    reasoning_replay_account_failover: "verified",
    ...overrides,
  });
}

function responseFrom(events: readonly SdkStreamEvent[]): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
        for (const event of events) yield event;
        yield {
          metadataEvent: {
            tokenUsage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
          },
        };
      },
    },
  };
}

/**
 * The stateless Responses lane projects through the CodeWhisperer operation,
 * so the replay must be minted in (and the request must stay in) the verified
 * `responses:gpt-5.6-sol:us-east-1:codewhisperer:profile:reasoning_text` cell.
 */
function reasoningReplayRequest(): CanonicalRequest {
  const outputFingerprint = assistantOutputFingerprint({ text: "prior answer", toolCalls: [] });
  return {
    canonicalVersion: 1,
    protocol: "responses",
    projectionMode: "safe",
    model: "gpt-5.6-sol",
    stream: false,
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
        lookup: { kind: "responses-token", encryptedContent: "kr1_test" },
        outputFingerprint,
        insertBeforeMessage: 0,
        path: "input.0",
      },
    ],
    includeEncryptedReasoning: true,
  };
}

function reasoningReplayStore(): PipelineReasoningReplayStore {
  return {
    readiness: () => ({ writable: true, keyringAvailable: true, missingKeyIds: [] }),
    store: () => undefined,
    resolveResponses: (_token, _context, insertBeforeMessage) => ({
      accountId: ORIGIN,
      conversationId: ORIGIN_CONVERSATION,
      portable: true as const,
      provenance: {
        protocol: "responses" as const,
        region: "us-east-1",
        profileArn: `arn:aws:codewhisperer:us-east-1:123456789012:profile/${ORIGIN}`,
        runtimeProtocol: "codewhisperer" as const,
        upstreamOperation: "GenerateAssistantResponse" as const,
        issuedAt: Date.now() - 1_000,
        expiresAt: Date.now() + 60_000,
      },
      replay: {
        insertBeforeMessage,
        content: {
          kind: "reasoning_text",
          text: "signed reasoning",
          signature: "native signature",
        },
      },
    }),
    resolveChat: () => {
      throw new TypeError("Chat replay is not used by this test");
    },
  };
}

/** The exact shape the SDK raises for Kiro's `REQUEST_BODY_INVALID` rejection. */
function requestBodyInvalid(): unknown {
  return {
    name: "ValidationException",
    message: REJECTION_MESSAGE,
    reason: "REQUEST_BODY_INVALID",
    $metadata: { httpStatusCode: 400 },
  };
}

async function errorBody(response: Response): Promise<{
  readonly error: { readonly message: string; readonly type: string; readonly code?: string };
}> {
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("error" in body) ||
    typeof body.error !== "object" ||
    body.error === null ||
    !("message" in body.error) ||
    typeof body.error.message !== "string" ||
    !("type" in body.error) ||
    typeof body.error.type !== "string"
  ) {
    throw new TypeError("Expected an OpenAI error envelope");
  }
  const code = "code" in body.error ? body.error.code : undefined;
  return {
    error: {
      message: body.error.message,
      type: body.error.type,
      ...(typeof code === "string" ? { code } : {}),
    },
  };
}

interface Dispatch {
  readonly accountId: string;
  readonly conversationId: string;
  /** Stored thread binding observed at the moment the SDK send ran. */
  readonly bindingAtSend:
    | { readonly accountId: string; readonly conversationId: string }
    | undefined;
}

type SendBehaviour = (dispatch: Dispatch) => Promise<SdkStreamResponse>;

const succeed: SendBehaviour = async () =>
  responseFrom([{ assistantResponseEvent: { content: "continued" } }]);

function reject(beforeThrow?: () => void): SendBehaviour {
  return async () => {
    beforeThrow?.();
    throw requestBodyInvalid();
  };
}

/** The shape Bun's SQLite driver raises when the accounts database cannot be written. */
function storeFault(): Error {
  const error = new Error(STORE_FAULT_MESSAGE);
  error.name = "SQLiteError";
  (error as Error & { code: string }).code = "SQLITE_FULL";
  return error;
}

/**
 * Delegates to the real database but fails every `rebindSessionAffinity`, the
 * write a migration commit performs after Kiro already accepted the attempt.
 */
function faultingRebind(store: AccountsDatabase): PipelineAffinityStore {
  return {
    getSessionAffinity: (keyHash, now) => store.getSessionAffinity(keyHash, now),
    claimSessionAffinity: (...args) => store.claimSessionAffinity(...args),
    rebindSessionAffinity: () => {
      throw storeFault();
    },
    resolveOutputLineage: (keyHash, now) => store.resolveOutputLineage(keyHash, now),
    recordOutputLineage: (...args) => store.recordOutputLineage(...args),
  };
}

function fixture(options: {
  readonly concurrency: number;
  readonly originExhausted?: boolean;
  readonly replays?: boolean;
  /** `false` sends the replay without an explicit session affinity or store. */
  readonly affinity?: false;
  /** Adds an idle third account with the lowest usage of all. */
  readonly thirdAccount?: boolean;
  /** Makes every binding rebind (the migration commit write) throw. */
  readonly commitFault?: boolean;
  readonly behaviours: Readonly<Record<string, SendBehaviour>>;
}) {
  const affinityStore = new AccountsDatabase(":memory:");
  affinityStore.claimSessionAffinity(
    THREAD.keyHash,
    ORIGIN,
    ORIGIN_CONVERSATION,
    Date.now(),
    60_000,
    100,
  );
  const accounts = [
    account(
      ORIGIN,
      options.originExhausted
        ? { usedCount: 10_000, limitCount: 10_000 }
        : { usedCount: 500, limitCount: 10_000 },
    ),
    account(TARGET, { usedCount: 1, limitCount: 10_000 }),
    ...(options.thirdAccount ? [account(THIRD, { usedCount: 0, limitCount: 10_000 })] : []),
  ];
  const manager = new PreferredAccountManager(accounts);
  const dispatches: Dispatch[] = [];
  const binding = () => affinityStore.getSessionAffinity(THREAD.keyHash);
  const run = (stream: boolean): Promise<Response> =>
    runChatCompletion({
      body: {
        ...(options.replays === false
          ? canonicalRequest([message("user", "hello")], { model: "gpt-5.6-sol" })
          : reasoningReplayRequest()),
        stream,
      },
      model: "gpt-5.6-sol",
      stream,
      config: config({ account_inference_concurrency: options.concurrency }),
      accountManager: manager,
      tokenRefresher: new FakeTokenRefresher(),
      tenantId: "tenant-a",
      reasoningReplayStore: reasoningReplayStore(),
      ...(options.affinity === false
        ? {}
        : {
            affinity: THREAD,
            affinityStore: options.commitFault ? faultingRebind(affinityStore) : affinityStore,
          }),
      makeClient: (...factoryArgs) => {
        const accountId = factoryArgs[5];
        if (accountId === undefined) throw new TypeError("makeClient received no account id");
        return {
          async send(command): Promise<SdkStreamResponse> {
            const conversationId = (command.input.conversationState as { conversationId?: string })
              .conversationId;
            if (typeof conversationId !== "string") {
              throw new TypeError("dispatched command has no conversation id");
            }
            const stored = binding();
            const dispatch: Dispatch = {
              accountId,
              conversationId,
              bindingAtSend: stored
                ? { accountId: stored.accountId, conversationId: stored.conversationId }
                : undefined,
            };
            dispatches.push(dispatch);
            const behaviour = options.behaviours[accountId];
            if (!behaviour) throw new TypeError("unexpected account dispatched");
            return behaviour(dispatch);
          },
        };
      },
    });
  return {
    affinityStore,
    accounts,
    dispatches,
    binding,
    run,
    close: () => affinityStore.close(),
  };
}

async function holdOrigin(concurrency: number): Promise<() => void> {
  const release = await acquireAccountQueue(ORIGIN, new AbortController().signal, concurrency);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

const ORIGIN_BINDING = { accountId: ORIGIN, conversationId: ORIGIN_CONVERSATION };

let audit: ReturnType<typeof captureAuditEvents>;
beforeEach(() => {
  audit = captureAuditEvents();
});
afterEach(() => {
  audit.restore();
  expect(accountQueueDepth(ORIGIN)).toBe(0);
  expect(accountQueueDepth(TARGET)).toBe(0);
  expect(accountQueueDepth(THIRD)).toBe(0);
});

/** The outcome of every account selection this request made, in order. */
function selectionOutcomes(): readonly unknown[] {
  return audit.events("account_selection_completed").map((record) => record.outcome);
}

/**
 * Every migration audit record may carry only hashes, enums and counts: no
 * account id, conversation id, or upstream message text may cross the boundary.
 */
function expectSanitized(record: AuditRecord, dispatches: readonly Dispatch[]): void {
  const serialized = JSON.stringify(record);
  for (const secret of [
    ORIGIN,
    TARGET,
    THIRD,
    ORIGIN_CONVERSATION,
    REJECTION_MESSAGE,
    STORE_FAULT_MESSAGE,
    ...dispatches.map((dispatch) => dispatch.conversationId),
  ]) {
    expect(serialized).not.toContain(secret);
  }
  expect(record).not.toHaveProperty("message");
  expect(record).not.toHaveProperty("error_message");
}

describe("portable reasoning replay prefers its origin account", () => {
  for (const stream of [false, true]) {
    test(`stream=${stream}: a merely busy origin below its concurrency ceiling keeps the thread`, async () => {
      const f = fixture({ concurrency: 10, behaviours: { [ORIGIN]: succeed, [TARGET]: succeed } });
      const releaseOrigin = await holdOrigin(10);
      try {
        const response = await f.run(stream);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("continued");
        // Pre-fix: the least-queued filter dropped the busy origin and the
        // request was dispatched to the idle account with a fresh conversation.
        expect(f.dispatches.map((d) => [d.accountId, d.conversationId])).toEqual([
          [ORIGIN, ORIGIN_CONVERSATION],
        ]);
        expect(audit.events("reasoning_replay_account_migrated")).toHaveLength(0);
        expect(audit.events("reasoning_replay_migration_committed")).toHaveLength(0);
        expect(f.binding()).toMatchObject(ORIGIN_BINDING);
      } finally {
        releaseOrigin();
        f.close();
      }
    });
  }

  test("a request without portable replays still spreads to the least-queued account", async () => {
    const f = fixture({
      concurrency: 10,
      replays: false,
      behaviours: { [ORIGIN]: succeed, [TARGET]: succeed },
    });
    const releaseOrigin = await holdOrigin(10);
    try {
      const response = await f.run(false);
      expect(response.status).toBe(200);
      expect(f.dispatches.map((d) => d.accountId)).toEqual([TARGET]);
      expect(f.dispatches[0]?.conversationId).not.toBe(ORIGIN_CONVERSATION);
      expect(f.binding()).toMatchObject({
        accountId: TARGET,
        conversationId: f.dispatches[0]?.conversationId,
      });
      expect(audit.events("reasoning_replay_account_migrated")).toHaveLength(0);
    } finally {
      releaseOrigin();
      f.close();
    }
  });
});

describe("portable reasoning replay migration binding is committed only after acceptance", () => {
  for (const stream of [false, true]) {
    test(`stream=${stream}: an origin at capacity migrates and the binding moves after the upstream accepted`, async () => {
      const f = fixture({ concurrency: 1, behaviours: { [ORIGIN]: succeed, [TARGET]: succeed } });
      const releaseOrigin = await holdOrigin(1);
      try {
        const response = await f.run(stream);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("continued");
        expect(f.dispatches).toHaveLength(1);
        const dispatch = f.dispatches[0];
        if (!dispatch) throw new Error("missing dispatch");
        expect(dispatch.accountId).toBe(TARGET);
        expect(dispatch.conversationId).not.toBe(ORIGIN_CONVERSATION);
        // The stored row must still name the origin while the migrated request
        // is on the wire; Kiro has not accepted anything yet.
        expect(dispatch.bindingAtSend).toEqual(ORIGIN_BINDING);
        // ... and name the new cell exactly as dispatched once it was accepted.
        expect(f.binding()).toMatchObject({
          accountId: TARGET,
          conversationId: dispatch.conversationId,
        });

        const migrated = audit.events("reasoning_replay_account_migrated");
        expect(migrated).toHaveLength(1);
        expect(migrated[0]).toMatchObject({
          from_account_hash: auditHash(ORIGIN),
          to_account_hash: auditHash(TARGET),
          replay_count: 1,
          binding: "deferred",
        });
        const committed = audit.events("reasoning_replay_migration_committed");
        expect(committed).toHaveLength(1);
        expect(committed[0]).toMatchObject({
          level: "info",
          from_account_hash: auditHash(ORIGIN),
          to_account_hash: auditHash(TARGET),
          conversation_hash: auditHash(dispatch.conversationId),
          replay_count: 1,
        });
        for (const record of [...migrated, ...committed]) expectSanitized(record, f.dispatches);
        expect(audit.events("reasoning_replay_migration_rejected")).toHaveLength(0);
      } finally {
        releaseOrigin();
        f.close();
      }
    });
  }
});

describe("rejected portable reasoning replay migration", () => {
  for (const stream of [false, true]) {
    test(`stream=${stream}: REQUEST_BODY_INVALID on the migrated account falls back to the origin once`, async () => {
      const releaseOrigin = await holdOrigin(1);
      const f = fixture({
        concurrency: 1,
        behaviours: {
          // Kiro rejects the migrated history at headers; the origin frees up
          // meanwhile so the bounded fallback can queue on it.
          [TARGET]: reject(releaseOrigin),
          [ORIGIN]: succeed,
        },
      });
      try {
        const response = await f.run(stream);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("continued");
        expect(f.dispatches.map((d) => d.accountId)).toEqual([TARGET, ORIGIN]);
        expect(f.dispatches[0]?.conversationId).not.toBe(ORIGIN_CONVERSATION);
        expect(f.dispatches[0]?.bindingAtSend).toEqual(ORIGIN_BINDING);
        // The fallback reuses the original binding, not a fresh conversation.
        expect(f.dispatches[1]?.conversationId).toBe(ORIGIN_CONVERSATION);
        expect(f.dispatches[1]?.bindingAtSend).toEqual(ORIGIN_BINDING);
        expect(f.binding()).toMatchObject(ORIGIN_BINDING);

        const rejected = audit.events("reasoning_replay_migration_rejected");
        expect(rejected).toHaveLength(1);
        expect(rejected[0]).toMatchObject({
          level: "warn",
          from_account_hash: auditHash(ORIGIN),
          to_account_hash: auditHash(TARGET),
          replay_count: 1,
          upstream_status: 400,
          upstream_code: "REQUEST_BODY_INVALID",
          fallback: "origin",
        });
        expect(rejected[0]).not.toHaveProperty("fallback_blocked_reason");
        expect(audit.events("reasoning_replay_migration_committed")).toHaveLength(0);
        for (const record of [...rejected, ...audit.events("reasoning_replay_account_migrated")]) {
          expectSanitized(record, f.dispatches);
        }
      } finally {
        releaseOrigin();
        f.close();
      }
    });

    test(`stream=${stream}: a fallback that is rejected too is terminal with the upstream 400`, async () => {
      const releaseOrigin = await holdOrigin(1);
      const f = fixture({
        concurrency: 1,
        behaviours: { [TARGET]: reject(releaseOrigin), [ORIGIN]: reject() },
      });
      try {
        const response = await f.run(stream);
        expect(response.status).toBe(400);
        expect(await errorBody(response)).toMatchObject({
          error: { code: "request_body_invalid", type: "upstream_error" },
        });
        // Exactly one fallback: migrated attempt, origin attempt, nothing else.
        expect(f.dispatches.map((d) => [d.accountId, d.conversationId])).toEqual([
          [TARGET, expect.not.stringContaining(ORIGIN_CONVERSATION)],
          [ORIGIN, ORIGIN_CONVERSATION],
        ]);
        expect(audit.events("reasoning_replay_migration_rejected")).toHaveLength(1);
        expect(audit.events("reasoning_replay_migration_committed")).toHaveLength(0);
        expect(f.binding()).toMatchObject(ORIGIN_BINDING);
      } finally {
        releaseOrigin();
        f.close();
      }
    });
  }

  test("an unselectable origin cannot take the fallback and the thread keeps its origin binding", async () => {
    const f = fixture({
      concurrency: 10,
      originExhausted: true,
      behaviours: { [TARGET]: reject(), [ORIGIN]: succeed },
    });
    try {
      const first = await f.run(false);
      expect(first.status).toBe(400);
      expect(await errorBody(first)).toMatchObject({
        error: {
          code: "reasoning_replay_migration_rejected",
          type: "upstream_error",
          message:
            "Kiro rejected the request after its signed reasoning history was migrated to another account, and the original account is unavailable",
        },
      });
      expect(f.dispatches.map((d) => d.accountId)).toEqual([TARGET]);
      expect(f.dispatches[0]?.bindingAtSend).toEqual(ORIGIN_BINDING);
      const rejected = audit.events("reasoning_replay_migration_rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        from_account_hash: auditHash(ORIGIN),
        to_account_hash: auditHash(TARGET),
        upstream_status: 400,
        upstream_code: "REQUEST_BODY_INVALID",
        fallback: "none",
        fallback_blocked_reason: "origin_unselectable",
      });
      expectSanitized(rejected[0] as AuditRecord, f.dispatches);
      // Pre-fix the row already named the failed target; the client's retry
      // then repeated the same rejected shape forever.
      expect(f.binding()).toMatchObject(ORIGIN_BINDING);

      // A client retry on the same thread resolves the origin binding again and
      // migrates afresh instead of silently sticking to the rejected target.
      const second = await f.run(false);
      expect(second.status).toBe(400);
      expect(await errorBody(second)).toMatchObject({
        error: { code: "reasoning_replay_migration_rejected" },
      });
      expect(f.dispatches.map((d) => d.accountId)).toEqual([TARGET, TARGET]);
      expect(f.dispatches[1]?.bindingAtSend).toEqual(ORIGIN_BINDING);
      expect(f.dispatches[1]?.conversationId).not.toBe(f.dispatches[0]?.conversationId);
      const migrated = audit.events("reasoning_replay_account_migrated");
      expect(migrated).toHaveLength(2);
      for (const record of migrated) {
        expect(record).toMatchObject({
          from_account_hash: auditHash(ORIGIN),
          to_account_hash: auditHash(TARGET),
          binding: "deferred",
        });
      }
      expect(audit.events("reasoning_replay_migration_committed")).toHaveLength(0);
      expect(f.binding()).toMatchObject(ORIGIN_BINDING);
    } finally {
      f.close();
    }
  });
});

describe("a binding commit that fails locally keeps the accepted answer", () => {
  for (const stream of [false, true]) {
    test(`stream=${stream}: a storage fault after acceptance is audited, not echoed, and the upstream stream is drained`, async () => {
      let upstreamFinished = false;
      const f = fixture({
        concurrency: 1,
        commitFault: true,
        behaviours: {
          [ORIGIN]: succeed,
          [TARGET]: async () => ({
            generateAssistantResponseResponse: {
              async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
                try {
                  yield { assistantResponseEvent: { content: "continued" } };
                  yield {
                    metadataEvent: {
                      tokenUsage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
                    },
                  };
                } finally {
                  upstreamFinished = true;
                }
              },
            },
          }),
        },
      });
      const releaseOrigin = await holdOrigin(1);
      try {
        const response = await f.run(stream);
        expect(response.status).toBe(200);
        const body = await response.text();
        // Pre-fix: the SQLite text became the client's 500 error message and,
        // in the stream lane, the accepted upstream iterator was never closed.
        expect(body).toContain("continued");
        expect(body).not.toContain("disk is full");
        expect(body).not.toContain("SQLITE_FULL");
        expect(upstreamFinished).toBe(true);
        expect(f.dispatches.map((d) => d.accountId)).toEqual([TARGET]);
        expect(f.dispatches[0]?.bindingAtSend).toEqual(ORIGIN_BINDING);
        // The row never moved; the next request re-resolves the origin.
        expect(f.binding()).toMatchObject(ORIGIN_BINDING);

        const failed = audit.events("reasoning_replay_migration_commit_failed");
        expect(failed).toHaveLength(1);
        expect(failed[0]).toMatchObject({
          level: "warn",
          from_account_hash: auditHash(ORIGIN),
          to_account_hash: auditHash(TARGET),
          conversation_hash: auditHash(f.dispatches[0]?.conversationId ?? ""),
          replay_count: 1,
          error_type: "SQLiteError",
          error_code: "SQLITE_FULL",
        });
        expectSanitized(failed[0] as AuditRecord, f.dispatches);
        expect(audit.events("reasoning_replay_migration_committed")).toHaveLength(0);
        expect(audit.events("reasoning_replay_migration_rejected")).toHaveLength(0);
        expect(audit.events("upstream_attempt_failed")).toHaveLength(0);
      } finally {
        releaseOrigin();
        f.close();
      }
    });
  }
});

describe("attempts after a committed migration extend the committed cell", () => {
  test("an empty-completion replacement stays on the committed cell and is not reported as a second migration", async () => {
    let targetSends = 0;
    const f = fixture({
      concurrency: 1,
      behaviours: {
        [ORIGIN]: succeed,
        [TARGET]: async () => {
          targetSends += 1;
          return targetSends === 1
            ? responseFrom([])
            : responseFrom([{ assistantResponseEvent: { content: "continued" } }]);
        },
      },
    });
    const releaseOrigin = await holdOrigin(1);
    try {
      const response = await f.run(false);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("continued");
      const [first, second] = f.dispatches;
      if (!first || !second) throw new Error("expected two dispatches");
      expect(f.dispatches).toHaveLength(2);
      expect([first.accountId, second.accountId]).toEqual([TARGET, TARGET]);
      expect(second.conversationId).toBe(first.conversationId);
      expect(first.bindingAtSend).toEqual(ORIGIN_BINDING);
      // The commit happened before the replacement attempt was bound.
      expect(second.bindingAtSend).toEqual({
        accountId: TARGET,
        conversationId: first.conversationId,
      });
      expect(f.binding()).toMatchObject({
        accountId: TARGET,
        conversationId: first.conversationId,
      });
      expect(audit.events("sdk_stream_empty_completion_retry")).toHaveLength(1);
      expect(audit.events("reasoning_replay_migration_committed")).toHaveLength(1);
      // Pre-fix the re-bind logged a second migration with binding:"none",
      // although the stored binding had just been committed to that account.
      const migrated = audit.events("reasoning_replay_account_migrated");
      expect(migrated.map((record) => record.binding)).toEqual(["deferred"]);
    } finally {
      releaseOrigin();
      f.close();
    }
  });

  test("a rejected second hop falls back to the committed cell, never to a conversation Kiro did not accept", async () => {
    // Accounts: A (origin, at capacity), B, C. The request migrates to B; B
    // accepts but answers empty, so the binding is committed to (B, convB) and
    // the replacement attempt runs while B is at capacity too, which spreads
    // it to C. C rejects the history: the fallback must return to (B, convB).
    let releaseCompetitor: (() => void) | undefined;
    let competitor: Promise<() => void> | undefined;
    let targetSends = 0;
    const f = fixture({
      concurrency: 1,
      thirdAccount: true,
      behaviours: {
        [ORIGIN]: succeed,
        [TARGET]: async () => {
          targetSends += 1;
          if (targetSends === 1) {
            // Another request queues on B while this one is in flight, so B is
            // at capacity when the empty-completion replacement is selected.
            competitor = acquireAccountQueue(TARGET, new AbortController().signal, 1);
            void competitor.then((release) => {
              releaseCompetitor = release;
            });
            return responseFrom([]);
          }
          return responseFrom([{ assistantResponseEvent: { content: "continued" } }]);
        },
        [THIRD]: async () => {
          releaseOrigin();
          releaseCompetitor?.();
          throw requestBodyInvalid();
        },
      },
    });
    const releaseOrigin = await holdOrigin(1);
    try {
      const response = await f.run(false);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("continued");
      const [onTarget, onThird, fallback] = f.dispatches;
      if (!onTarget || !onThird || !fallback) throw new Error("expected three dispatches");
      expect(f.dispatches).toHaveLength(3);
      expect(onTarget.accountId).toBe(TARGET);
      expect(onTarget.bindingAtSend).toEqual(ORIGIN_BINDING);
      const committedCell = { accountId: TARGET, conversationId: onTarget.conversationId };
      expect(onThird.accountId).toBe(THIRD);
      expect(onThird.bindingAtSend).toEqual(committedCell);
      // Pre-fix the fallback went to A with a brand-new conversation and the
      // row was already rewritten to it before A had accepted anything.
      expect([fallback.accountId, fallback.conversationId]).toEqual([
        TARGET,
        onTarget.conversationId,
      ]);
      expect(fallback.bindingAtSend).toEqual(committedCell);
      expect(f.binding()).toMatchObject(committedCell);
      // No dispatch ever saw a stored row naming a conversation Kiro had not accepted.
      for (const dispatch of f.dispatches) {
        expect(dispatch.bindingAtSend).toBeDefined();
        expect([ORIGIN_CONVERSATION, onTarget.conversationId]).toContain(
          dispatch.bindingAtSend?.conversationId ?? "",
        );
      }

      expect(audit.events("reasoning_replay_migration_committed")).toHaveLength(1);
      const migrated = audit.events("reasoning_replay_account_migrated");
      expect(migrated).toHaveLength(2);
      expect(migrated[0]).toMatchObject({
        from_account_hash: auditHash(ORIGIN),
        to_account_hash: auditHash(TARGET),
        binding: "deferred",
      });
      expect(migrated[1]).toMatchObject({
        from_account_hash: auditHash(TARGET),
        to_account_hash: auditHash(THIRD),
        binding: "deferred",
      });
      const rejected = audit.events("reasoning_replay_migration_rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        from_account_hash: auditHash(TARGET),
        to_account_hash: auditHash(THIRD),
        fallback: "origin",
      });
      for (const record of [...migrated, ...rejected]) expectSanitized(record, f.dispatches);
    } finally {
      releaseOrigin();
      if (competitor) (await competitor)();
      f.close();
    }
  });
});

describe("the fallback after a rejected migration is bounded to the origin", () => {
  for (const stream of [false, true]) {
    test(`stream=${stream}: a still-busy origin is queued on, not bypassed`, async () => {
      const releaseOrigin = await holdOrigin(1);
      const f = fixture({
        concurrency: 1,
        thirdAccount: true,
        behaviours: {
          // The origin frees up only after the rejection has been classified,
          // so the fallback selection finds it at capacity first.
          [TARGET]: async () => {
            setTimeout(releaseOrigin, 100);
            throw requestBodyInvalid();
          },
          [ORIGIN]: succeed,
          [THIRD]: succeed,
        },
      });
      try {
        const response = await f.run(stream);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("continued");
        expect(selectionOutcomes()).toEqual(["selected", "capacity-wait", "selected"]);
        expect(f.dispatches.map((d) => [d.accountId, d.conversationId])).toEqual([
          [TARGET, expect.not.stringContaining(ORIGIN_CONVERSATION)],
          [ORIGIN, ORIGIN_CONVERSATION],
        ]);
        expect(f.binding()).toMatchObject(ORIGIN_BINDING);
        expect(audit.events("reasoning_replay_migration_committed")).toHaveLength(0);
      } finally {
        releaseOrigin();
        f.close();
      }
    });

    test(`stream=${stream}: an origin that fails the fallback with 429 ends the request with the stored rejection`, async () => {
      const releaseOrigin = await holdOrigin(1);
      const f = fixture({
        concurrency: 1,
        thirdAccount: true,
        behaviours: {
          [TARGET]: reject(releaseOrigin),
          [ORIGIN]: async () => {
            throw {
              name: "ThrottlingException",
              message: "Too many requests",
              $metadata: { httpStatusCode: 429 },
            };
          },
          [THIRD]: succeed,
        },
      });
      try {
        const response = await f.run(stream);
        expect(response.status).toBe(400);
        expect(await errorBody(response)).toMatchObject({
          error: { code: "reasoning_replay_migration_rejected", type: "upstream_error" },
        });
        // The switch excluded the origin; the idle third account must not
        // receive the rejected history, so selection returns the stored terminal.
        expect(f.dispatches.map((d) => d.accountId)).toEqual([TARGET, ORIGIN]);
        expect(f.dispatches[1]?.conversationId).toBe(ORIGIN_CONVERSATION);
        expect(selectionOutcomes()).toEqual(["selected", "selected", "result"]);
        const rejected = audit.events("reasoning_replay_migration_rejected");
        expect(rejected).toHaveLength(1);
        expect(rejected[0]).toMatchObject({ fallback: "origin" });
        expect(audit.events("reasoning_replay_migration_committed")).toHaveLength(0);
        expect(f.binding()).toMatchObject(ORIGIN_BINDING);
      } finally {
        releaseOrigin();
        f.close();
      }
    });
  }
});

describe("portable reasoning replay migration without a session affinity store", () => {
  for (const stream of [false, true]) {
    test(`stream=${stream}: an accepted migration commits nothing to storage and reports binding "none"`, async () => {
      const f = fixture({
        concurrency: 1,
        affinity: false,
        behaviours: { [ORIGIN]: succeed, [TARGET]: succeed },
      });
      const releaseOrigin = await holdOrigin(1);
      try {
        const response = await f.run(stream);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("continued");
        expect(f.dispatches.map((d) => d.accountId)).toEqual([TARGET]);
        expect(f.dispatches[0]?.conversationId).not.toBe(ORIGIN_CONVERSATION);
        const migrated = audit.events("reasoning_replay_account_migrated");
        expect(migrated).toHaveLength(1);
        expect(migrated[0]).toMatchObject({
          from_account_hash: auditHash(ORIGIN),
          to_account_hash: auditHash(TARGET),
          binding: "none",
        });
        const committed = audit.events("reasoning_replay_migration_committed");
        expect(committed).toHaveLength(1);
        for (const record of [...migrated, ...committed]) expectSanitized(record, f.dispatches);
        // The database the fixture seeded was never handed to the pipeline.
        expect(f.binding()).toMatchObject(ORIGIN_BINDING);
      } finally {
        releaseOrigin();
        f.close();
      }
    });

    test(`stream=${stream}: a rejected migration falls back to the replay's provenance conversation`, async () => {
      const releaseOrigin = await holdOrigin(1);
      const f = fixture({
        concurrency: 1,
        affinity: false,
        behaviours: { [TARGET]: reject(releaseOrigin), [ORIGIN]: succeed },
      });
      try {
        const response = await f.run(stream);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("continued");
        expect(f.dispatches.map((d) => [d.accountId, d.conversationId])).toEqual([
          [TARGET, expect.not.stringContaining(ORIGIN_CONVERSATION)],
          [ORIGIN, ORIGIN_CONVERSATION],
        ]);
        expect(audit.events("reasoning_replay_migration_rejected")).toHaveLength(1);
        expect(audit.events("reasoning_replay_migration_committed")).toHaveLength(0);
      } finally {
        releaseOrigin();
        f.close();
      }
    });
  }
});
