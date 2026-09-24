import {
  GenerateAssistantResponseCommand,
  type GenerateAssistantResponseCommandInput,
} from "@aws/codewhisperer-streaming-client";
import { randomUUID } from "node:crypto";
import { leastQueuedAccountIds, reserveAccountCapacity } from "./account-capacity.js";
import {
  assistantLineageFingerprint,
  assistantOutputFingerprint,
  type CanonicalAssistantOutput,
  type CanonicalRequest,
  type ResolvedReasoningReplay,
  textFromParts,
} from "../protocol/canonical.js";
import {
  type ClientNormalization,
  normalizedAssistantOutputFingerprint,
} from "../protocol/client-normalization.js";
import {
  CANONICAL_OUTPUT_JSON_CONTENT_TYPE,
  type CanonicalOutputEvent,
} from "../protocol/output.js";
import { ReasoningReplayError } from "../reasoning/replay-store.js";
import { EffortSchema } from "../kiro/regions.js";
import { extractRegionFromArn, KIRO_CONSTANTS } from "../kiro/constants.js";
import { buildEffortRequestFields, buildThinkingRequestFields } from "../kiro/effort.js";
import { isFable51Model, isGpt56Model } from "../kiro/models.js";
import type { ReasoningReplayDecision } from "../kiro/transform/streaming/reasoning-prefix.js";
import { boundedCleanup, runCleanupSteps } from "./stream-cleanup.js";
import { KiroTokenRefreshError } from "../kiro/errors.js";
import {
  isAccessTokenError,
  isPermanentError,
  isQuotaExhausted,
  isRefreshTokenDead,
  toDeadReason,
  type OveragePolicy,
  toOveragePolicy,
} from "../kiro/health.js";
import type { ManagedAccount } from "../kiro/types.js";
import { transformToSdkRequest } from "../kiro/transform/request-sdk.js";
import { estimateSdkInputTokens } from "../kiro/transform/usage-estimator.js";
import { RequestTransformError } from "../kiro/transform/errors.js";
import { collectSdkResponse } from "../kiro/transform/sdk-collector.js";
import type { SdkStreamResponse } from "../kiro/transform/streaming/sdk-stream-runtime.js";
import type { SdkOutputCaptureHandler } from "../kiro/transform/streaming/sdk-stream-runtime.js";
import type { SdkReasoningCaptureHandler } from "../kiro/transform/streaming/sdk-stream-runtime.js";
import type { SdkOutputFingerprint } from "../kiro/transform/streaming/sdk-stream-runtime.js";
import {
  SemanticStreamTruncationError,
  SdkStreamProtocolError,
  ToolCallViolation,
} from "../kiro/transform/streaming/sdk-stream-runtime.js";
import { newRequestId, openAiError, openAiInternalError } from "../server/errors.js";
import {
  classifyError,
  isRetryableServerStatus,
  normalizeSdkError,
  type NormalizedSdkError,
  isQuotaExhaustionClassification,
} from "./error-classifier.js";
import { type AffinityStallSnapshot, affinityStallTracker } from "./affinity-stall.js";
import { auditHash, auditLog } from "./audit-log.js";
import {
  abortable,
  abortableSleep,
  abortReason,
  accountQueueDepth,
  acquireSessionQueue,
  createPipelineDeadline,
} from "./pipeline-runtime.js";
import {
  abandonPreparedStream,
  createPipelineStreamResponse,
  createStreamTelemetry,
  type PreparedCanonicalStream,
  prepareCanonicalStream,
  StreamIdleTimeoutError,
  type StreamTelemetry,
  type StreamTerminalReport,
} from "./pipeline-stream.js";
import { resolveProxyUrl } from "./proxy.js";
import type {
  PipelineAffinityBinding,
  PipelineReasoningReplayStore,
  RunChatCompletionOptions,
} from "./pipeline-types.js";
import {
  attachKiroRuntimeRequest,
  createSdkClient,
  mergeModelRequestFields,
} from "./sdk-client.js";
import {
  normalizeStreamFailure,
  type StreamFailure,
  streamErrorAuditFields,
} from "./stream-error.js";
import { AccountUnavailableError } from "./token-refresher.js";
import { sendAcceptedStream } from "./upstream-acceptance.js";
import { RequestDiagnostics } from "./request-diagnostics.js";
import { toolOutputValidator } from "./tool-output-validation.js";
import { isSelectableAccount } from "./account-selection.js";

export type {
  PipelineAccountManager,
  PipelineAffinityStore,
  PipelineClientFactory,
  PipelineReasoningReplayStore,
  PipelineModelCapabilities,
  PipelineNativeContextCapabilities,
  PipelineQuotaRechecker,
  PipelineSdkClient,
  PipelineTokenRefresher,
  RunChatCompletionOptions,
} from "./pipeline-types.js";

function hasInstructionInput(request: CanonicalRequest): boolean {
  return request.messages.some(
    (message) => message.role === "system" || message.role === "developer",
  );
}

type CompletionResult =
  | { readonly kind: "response"; readonly response: Response }
  | {
      readonly kind: "stream";
      readonly sdkResponse: SdkStreamResponse;
      readonly model: string;
      readonly conversationId: string;
      readonly captureReasoning?: SdkReasoningCaptureHandler;
      readonly emitEncryptedReasoning: boolean;
      readonly emitAnthropicReasoningMetadata: boolean;
      readonly bufferLateGptReasoning: boolean;
      readonly prefetchFableReasoning: boolean;
      readonly reasoningReplayDecision: ReasoningReplayDecision;
      readonly fingerprintOutput?: SdkOutputFingerprint;
      readonly captureOutput?: SdkOutputCaptureHandler;
      readonly releaseAccount: () => void;
      /** Aborts the upstream HTTP request of this attempt; idempotent. */
      readonly abortUpstream: (reason?: unknown) => void;
      /** Canonical stream prefetched up to its first semantic event. */
      readonly prepared: PreparedCanonicalStream;
    };

interface ReplayState {
  /** Owner-bound replay account. Only provenance-authenticated cells omit it. */
  readonly accountId?: string;
  readonly conversationId?: string;
  readonly preferredAccountId?: string;
  readonly preferredConversationId?: string;
  readonly portableCount: number;
  readonly legacyPortableCount: number;
  readonly portableRegion?: string;
  readonly portableRuntimeProtocol?: "codewhisperer" | "kiro-runtime";
  readonly portableProfileRequired?: true;
  readonly portableProfileArn?: string;
  readonly replays: readonly ResolvedReasoningReplay[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSdkCommandInput(value: unknown): value is GenerateAssistantResponseCommandInput {
  if (!isRecord(value)) return false;
  const conversationState = value.conversationState;
  return (
    isRecord(conversationState) &&
    typeof conversationState.conversationId === "string" &&
    isRecord(conversationState.currentMessage) &&
    typeof conversationState.chatTriggerType === "string"
  );
}

function thinkingOptions(
  body: CanonicalRequest,
  model: string,
): { readonly think: boolean; readonly budget: number } {
  return {
    think: model.endsWith("-thinking") || body.thinking?.enabled === true,
    budget: body.thinking?.budgetTokens ?? 20_000,
  };
}

function terminalError(status: number, message: string, code?: string): Response {
  return openAiError(status, message, "upstream_error", code);
}

// B16: both halves of the pipeline/server internal-error envelope share one
// implementation so clients see one shape and operators one request_id format.
export { INTERNAL_ERROR_MESSAGE } from "../server/errors.js";

type StreamFailureError =
  | SemanticStreamTruncationError
  | SdkStreamProtocolError
  | ToolCallViolation;

/** Typed failures raised while consuming an already-open Kiro event stream. */
function isStreamFailureError(error: unknown): error is StreamFailureError {
  return (
    error instanceof SemanticStreamTruncationError ||
    error instanceof SdkStreamProtocolError ||
    error instanceof ToolCallViolation
  );
}

type RefreshFailure = KiroTokenRefreshError | AccountUnavailableError;

function isRefreshFailure(error: unknown): error is RefreshFailure {
  return error instanceof KiroTokenRefreshError || error instanceof AccountUnavailableError;
}

function refreshFailureReason(failure: RefreshFailure): string {
  const code = failure instanceof KiroTokenRefreshError ? failure.code : undefined;
  return code ? `${code}: ${failure.message}` : failure.message;
}

const INVALID_REASONING_SIGNATURE_PATTERN = /invalid\s+`?signature`?\s+in\s+`?thinking`?\s+block/i;
/** SDK `ValidationExceptionReason` for a rejected replayed thinking signature. */
const INVALID_REASONING_SIGNATURE_REASON = "THINKING_SIGNATURE_INVALID";

/**
 * Kiro rejects a tampered or foreign thinking signature with HTTP 400
 * `ValidationException` carrying `reason: THINKING_SIGNATURE_INVALID` (and the
 * message "Invalid `signature` in `thinking` block"). That is a client input
 * error, never an account or transient fault. The structured reason is
 * authoritative; the message pattern remains as the fallback.
 */
function isInvalidReasoningSignature(error: NormalizedSdkError): boolean {
  if (error.reason === INVALID_REASONING_SIGNATURE_REASON) return true;
  return error.status === 400 && INVALID_REASONING_SIGNATURE_PATTERN.test(error.message);
}

/** SDK `ValidationExceptionReason` Kiro returns for a history it cannot parse at all. */
const REQUEST_BODY_INVALID_REASON = "REQUEST_BODY_INVALID";

/**
 * Kiro's answer to a signed reasoning history that does not fit the account
 * it was migrated to: HTTP 400 `REQUEST_BODY_INVALID` ("Improperly formed
 * request."; in production this reason followed only migrated dispatches, never
 * a fresh one) or a refused replayed signature. The rejection arrives at the
 * response headers before any output exists. A missing status covers the same
 * reason delivered without an HTTP envelope.
 */
function isMigrationRejection(error: NormalizedSdkError): boolean {
  return (
    (error.status === undefined || error.status === 400) &&
    (error.reason === REQUEST_BODY_INVALID_REASON || isInvalidReasoningSignature(error))
  );
}

/**
 * Alternatives the classifier may switch to: accounts that are eligible for
 * the model AND selectable right now. Counting rate-limited or unhealthy
 * accounts here made a single-usable-account deployment switch away from its
 * only account and end in 503 instead of honoring retry-after (B3).
 */
function countSelectableAlternatives(
  options: RunChatCompletionOptions,
  accounts: readonly ManagedAccount[],
  eligibleAccountIds: ReadonlySet<string>,
): number {
  const counted = options.accountManager.countSelectableAccounts?.(eligibleAccountIds);
  if (counted !== undefined) return counted;
  const now = Date.now();
  return accounts.filter(
    (account) => eligibleAccountIds.has(account.id) && isSelectableAccount(account, now),
  ).length;
}

/** Shortest wait until a currently rate-limited, otherwise usable candidate frees up. */
function shortestRateLimitWaitMs(
  candidates: readonly ManagedAccount[],
  eligibleAccountIds: ReadonlySet<string>,
  now: number,
  policy: OveragePolicy,
): number | undefined {
  const waits = candidates
    .filter(
      (account) =>
        eligibleAccountIds.has(account.id) &&
        account.isHealthy &&
        !isQuotaExhausted(account, policy) &&
        account.rateLimitResetTime > now,
    )
    .map((account) => account.rateLimitResetTime - now);
  return waits.length === 0 ? undefined : Math.min(...waits);
}

function refreshFailureResponse(): CompletionResult {
  return {
    kind: "response",
    response: openAiError(
      503,
      "Token refresh failed for every usable Kiro account",
      "service_unavailable",
      "upstream_token_refresh_failed",
    ),
  };
}

function persistQuotaExhaustion(options: RunChatCompletionOptions, account: ManagedAccount): void {
  const recheckAfter = Date.now() + options.config.quota_recheck_interval_ms;
  if (options.accountManager.markQuotaExhausted) {
    options.accountManager.markQuotaExhausted(account, recheckAfter);
  } else {
    options.accountManager.markRateLimited(account, recheckAfter);
  }
  auditLog("warn", "quota_exhausted_account_persisted", {
    account_hash: auditHash(account.id),
    recheck_after: recheckAfter,
  });
}

function modelAvailabilityError(options: RunChatCompletionOptions): CompletionResult {
  const known = options.modelCapabilities?.isKnownModel(options.model) ?? false;
  return {
    kind: "response",
    response: openAiError(
      known ? 503 : 400,
      known
        ? `Model ${options.model} is not available to any currently usable Kiro account`
        : `Model ${options.model} is not supported by Kiro`,
      known ? "service_unavailable" : "invalid_request_error",
      known ? "model_unavailable_for_accounts" : "unsupported_model",
      "model",
    ),
  };
}

function runtimeEndpoint(options: RunChatCompletionOptions, region: string): string | undefined {
  if (options.config.test_upstream_endpoint) {
    return options.config.test_upstream_endpoint;
  }
  return options.config.runtime_endpoint_mode === "kiro-runtime"
    ? KIRO_CONSTANTS.RUNTIME_ENDPOINT.replace("{{region}}", region)
    : undefined;
}

function canonicalOutputFingerprint(
  request: CanonicalRequest,
  normalization?: ClientNormalization,
): SdkOutputFingerprint {
  const toolsByWireName = new Map(request.tools.map((tool) => [tool.wireName, tool] as const));
  return (output: CanonicalAssistantOutput): string => {
    const restored = {
      text: output.text,
      toolCalls: output.toolCalls.map((call) => {
        const declaration = toolsByWireName.get(call.name);
        if (!declaration) return call;
        if (declaration.publicType !== "custom") {
          return { ...call, name: declaration.name };
        }
        let input = call.input;
        try {
          const parsed: unknown = JSON.parse(call.input);
          if (
            isRecord(parsed) &&
            Object.keys(parsed).length === 1 &&
            typeof parsed.input === "string"
          ) {
            input = parsed.input;
          }
        } catch {
          // The Responses bridge will report malformed custom output; preserve raw input here.
        }
        return { ...call, name: declaration.name, input };
      }),
    };
    return normalization
      ? normalizedAssistantOutputFingerprint(restored, normalization)
      : assistantOutputFingerprint(restored);
  };
}

function replayNormalization(
  options: RunChatCompletionOptions,
  messageIndex: number,
): { clientNormalization?: ClientNormalization; normalizedOutputFingerprint?: string } {
  if (!options.clientNormalization) return {};
  const message = options.body.messages[messageIndex];
  if (!message || message.role !== "assistant") {
    throw new ReasoningReplayError(
      "Reasoning replay does not reference assistant output",
      "invalid_reasoning_replay",
    );
  }
  return {
    clientNormalization: options.clientNormalization,
    normalizedOutputFingerprint: normalizedAssistantOutputFingerprint(
      {
        text: textFromParts(message.content),
        toolCalls: message.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          input: JSON.stringify(call.input),
        })),
      },
      options.clientNormalization,
    ),
  };
}

function replayAccountError(
  status: number,
  message: string,
  code: string,
  retryAfterMs?: number,
): CompletionResult {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (retryAfterMs !== undefined) {
    headers.set("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  }
  return {
    kind: "response",
    response: new Response(
      JSON.stringify({
        error: {
          message,
          type:
            status === 429
              ? "rate_limit_error"
              : status === 402
                ? "insufficient_quota"
                : status === 401 || status === 403
                  ? "authentication_error"
                  : "service_unavailable",
          code,
          ...(retryAfterMs !== undefined ? { retry_after_ms: retryAfterMs } : {}),
        },
      }),
      { status, headers },
    ),
  };
}

function replayUnavailable(): CompletionResult {
  return replayAccountError(
    503,
    "The account bound to signed reasoning replay is currently unavailable",
    "reasoning_replay_account_unavailable",
  );
}

function replayLockedSelectionResult(
  options: RunChatCompletionOptions,
  state: LoopState,
  accounts: readonly ManagedAccount[],
  eligibleAccountIds: ReadonlySet<string>,
): SelectionOutcome {
  const bound = accounts.find((account) => account.id === state.boundAccountId);
  if (!bound) {
    return { kind: "result", result: replayUnavailable() };
  }
  const now = Date.now();
  const remainingMs = options.config.request_timeout_ms - (now - state.startedAt);
  if (isQuotaExhausted(bound, overagePolicy(options))) {
    const retryAfterMs =
      bound.rateLimitResetTime > now ? bound.rateLimitResetTime - now : undefined;
    return {
      kind: "result",
      result: replayAccountError(
        402,
        "The account bound to signed reasoning replay has exhausted its included quota",
        "reasoning_replay_account_quota_exhausted",
        retryAfterMs,
      ),
    };
  }
  if (bound.isHealthy && bound.rateLimitResetTime > now) {
    const waitMs = bound.rateLimitResetTime - now;
    if (waitMs <= remainingMs) {
      auditLog("info", "reasoning_replay_rate_limit_wait", {
        wait_ms: waitMs,
        remaining_ms: remainingMs,
      });
      return { kind: "wait", waitMs };
    }
    return {
      kind: "result",
      result: replayAccountError(
        429,
        "The account bound to signed reasoning replay is temporarily rate-limited",
        "reasoning_replay_account_rate_limited",
        waitMs,
      ),
    };
  }
  if (!bound.isHealthy && isPermanentError(bound.unhealthyReason)) {
    return {
      kind: "result",
      result: replayAccountError(
        403,
        "The account bound to signed reasoning replay requires re-authentication",
        "reasoning_replay_account_reauthentication_required",
      ),
    };
  }
  if (!eligibleAccountIds.has(bound.id)) {
    return {
      kind: "result",
      result: replayAccountError(
        503,
        `Model ${options.model} is unavailable on the account bound to signed reasoning replay`,
        "reasoning_replay_model_unavailable",
      ),
    };
  }
  return {
    kind: "result",
    result: replayAccountError(
      503,
      "The account bound to signed reasoning replay is unhealthy",
      "reasoning_replay_account_unhealthy",
    ),
  };
}

function verifiedPortableReplay(
  options: RunChatCompletionOptions,
  resolved: ReturnType<PipelineReasoningReplayStore["resolveResponses"]>,
  legacyOrigins?: ReadonlyMap<string, ManagedAccount>,
):
  | {
      readonly region: string;
      readonly runtimeProtocol: "codewhisperer" | "kiro-runtime";
      readonly profileRequired: true;
      readonly profileArn?: string;
      readonly legacyCurrentCell?: true;
    }
  | undefined {
  if (options.config.reasoning_replay_account_failover !== "verified") return undefined;
  const provenance = resolved.provenance;
  if (resolved.portable === true && provenance) {
    if (
      provenance.protocol !== options.body.protocol ||
      !provenance.profileArn ||
      provenance.upstreamOperation !== "GenerateAssistantResponse"
    )
      return undefined;
    // Cells are added only after the direct A -> B/new-conversation probe passes.
    // Every dimension comes from the authenticated mint envelope; mutable account
    // rows and the protocol used to present a token are never provenance.
    const key = `${provenance.protocol}:${options.model}:${provenance.region}:${provenance.runtimeProtocol}:profile:${resolved.replay.content.kind}`;
    const sameProfile = VERIFIED_SAME_PROFILE_REPLAY_CELLS.has(key);
    return VERIFIED_PORTABLE_REPLAY_CELLS.has(key) || sameProfile
      ? {
          region: provenance.region,
          runtimeProtocol: provenance.runtimeProtocol,
          profileRequired: true,
          ...(sameProfile ? { profileArn: provenance.profileArn } : {}),
        }
      : undefined;
  }
  if (
    (resolved.legacyPortable !== true && resolved.databaseLegacy !== true) ||
    options.config.reasoning_replay_legacy_account_failover !== "verified-current-cell" ||
    (options.body.projectionMode !== "v3-auto" &&
      options.body.projectionMode !== "native-context-safe" &&
      options.body.projectionMode !== "legacy-user-prefix")
  )
    return undefined;
  const origin = legacyOrigins?.get(resolved.accountId);
  if (!origin?.profileArn) return undefined;
  // Explicit recovery for authenticated kr1 records and pre-release kr2/v2.
  // The store validates tenant/model/output/owner/content and the record TTL
  // or persisted transition cutoff before supplying the legacy marker. The
  // operator attests the missing mint dimensions using the current owner cell.
  const region = extractRegionFromArn(origin.profileArn) ?? origin.region;
  const runtimeProtocol =
    options.body.projectionMode === "legacy-user-prefix" ? "codewhisperer" : "kiro-runtime";
  const key = `${options.body.protocol}:${options.model}:${region}:${runtimeProtocol}:profile:${resolved.replay.content.kind}`;
  return VERIFIED_PORTABLE_REPLAY_CELLS.has(key)
    ? {
        region,
        runtimeProtocol,
        profileRequired: true,
        legacyCurrentCell: true,
      }
    : undefined;
}

const VERIFIED_PORTABLE_REPLAY_CELLS = new Set([
  // 2026-09-15, Kiro CLI 2.21.1 / KiroRuntime us-east-1: three consecutive
  // account-A -> account-B + new-conversation tool-result replays passed at max.
  "responses:gpt-5.6-sol:us-east-1:kiro-runtime:profile:reasoning_text",
  // 2026-09-16: direct account-A -> B/new-conversation signed tool replay;
  // Responses stateless v3-auto currently projects through this SDK operation.
  "responses:gpt-5.6-sol:us-east-1:codewhisperer:profile:reasoning_text",
  // The same direct signed-thinking probe passed 3/3 with Claude Sonnet 5;
  // Messages still preserves its own public thinking/signature contract.
  "anthropic-messages:claude-sonnet-5:us-east-1:kiro-runtime:profile:reasoning_text",
  // 2026-09-16: Opus 5 at xhigh, signed reasoning + complete tool result,
  // source-account -> another account/new conversation passed 3/3.
  "anthropic-messages:claude-opus-5:us-east-1:kiro-runtime:profile:reasoning_text",
]);

const VERIFIED_SAME_PROFILE_REPLAY_CELLS = new Set([
  // 2026-09-17: Fable 5.1, max/xhigh, stable system/tools/message prefix:
  // A -> B/new-conversation plus another tool-history turn passed; tampering
  // with the signature was rejected. The probe covered one shared profile.
  // Legacy records lack the authenticated mint profile and are not admitted.
  "anthropic-messages:claude-fable-5-1:us-east-1:kiro-runtime:profile:reasoning_text",
]);

function resolveReplayState(
  options: RunChatCompletionOptions,
  binding:
    | {
        readonly accountId: string;
        readonly conversationId: string;
      }
    | undefined,
): ReplayState {
  if (options.body.reasoningReplays.length === 0) {
    return { replays: [], portableCount: 0, legacyPortableCount: 0 };
  }
  // Session affinity is a routing preference, not replay authorization. The
  // authenticated replay envelope determines strict ownership; verified cells
  // may deliberately rebind a fork to another account/conversation.
  let accountId: string | undefined;
  let conversationId: string | undefined;
  let preferredAccountId = binding?.accountId;
  let preferredConversationId = binding?.conversationId;
  let portableCount = 0;
  let legacyPortableCount = 0;
  let portableRegion: string | undefined;
  let portableRuntimeProtocol: "codewhisperer" | "kiro-runtime" | undefined;
  let portableProfileRequired: true | undefined;
  let portableProfileArn: string | undefined;
  const legacyOrigins =
    options.config.reasoning_replay_legacy_account_failover === "verified-current-cell"
      ? new Map(options.accountManager.reconcileFromDb().map((account) => [account.id, account]))
      : undefined;
  const replays: ResolvedReasoningReplay[] = [];
  const tokenItems = options.body.reasoningReplays.flatMap((replay, index) => {
    if (replay.lookup.kind !== "responses-token" && replay.lookup.kind !== "anthropic-token") {
      return [];
    }
    if (!options.tenantId) {
      throw new ReasoningReplayError(
        "Reasoning replay requires an authenticated tenant context",
        "reasoning_replay_context_required",
      );
    }
    const token =
      replay.lookup.kind === "responses-token"
        ? replay.lookup.encryptedContent
        : replay.lookup.signature;
    return [
      {
        index,
        token,
        context: {
          tenantId: options.tenantId,
          model: options.body.model,
          outputFingerprint: replay.outputFingerprint,
          ...replayNormalization(options, replay.insertBeforeMessage),
          ...(replay.compatibleOutputFingerprints !== undefined
            ? { compatibleOutputFingerprints: replay.compatibleOutputFingerprints }
            : {}),
          ...(accountId !== undefined ? { accountId } : {}),
          ...(conversationId !== undefined ? { conversationId } : {}),
        },
        insertBeforeMessage: replay.insertBeforeMessage,
      },
    ];
  });
  const tokenResolutions = new Map<
    number,
    ReturnType<PipelineReasoningReplayStore["resolveResponses"]>
  >();
  if (tokenItems.length > 0) {
    const store = options.reasoningReplayStore;
    if (!store) {
      throw new ReasoningReplayError(
        "Reasoning replay storage is unavailable",
        "reasoning_replay_store_unavailable",
        true,
      );
    }
    const resolved = store.resolveResponsesBatch
      ? store.resolveResponsesBatch(tokenItems)
      : tokenItems.map((item) =>
          store.resolveResponses(item.token, item.context, item.insertBeforeMessage),
        );
    for (const [position, item] of tokenItems.entries()) {
      const resolution = resolved[position];
      if (resolution) tokenResolutions.set(item.index, resolution);
    }
  }
  for (const [index, replay] of options.body.reasoningReplays.entries()) {
    if (replay.lookup.kind === "anthropic-direct") {
      // Kiro validates replayed thinking signatures itself and accepts a valid
      // signature in any conversation and on any account (probe evidence,
      // docs/audits/kiro-protocol-evidence-probe-2026-09-02.zh.md).
      replays.push({
        insertBeforeMessage: replay.insertBeforeMessage,
        content: replay.lookup.content,
      });
      continue;
    }
    if (!options.tenantId) {
      throw new ReasoningReplayError(
        "Reasoning replay requires an authenticated tenant context",
        "reasoning_replay_context_required",
      );
    }
    const store = options.reasoningReplayStore;
    if (!store) {
      throw new ReasoningReplayError(
        "Reasoning replay storage is unavailable",
        "reasoning_replay_store_unavailable",
        true,
      );
    }
    const context = {
      tenantId: options.tenantId,
      model: options.body.model,
      outputFingerprint: replay.outputFingerprint,
      ...replayNormalization(options, replay.insertBeforeMessage),
      ...(replay.compatibleOutputFingerprints !== undefined
        ? { compatibleOutputFingerprints: replay.compatibleOutputFingerprints }
        : {}),
      ...(accountId !== undefined ? { accountId } : {}),
      ...(conversationId !== undefined ? { conversationId } : {}),
    };
    const resolved =
      replay.lookup.kind === "chat-hash"
        ? store.resolveChat(replay.lookup.reasoningText, context, replay.insertBeforeMessage)
        : tokenResolutions.get(index);
    if (!resolved) {
      throw new ReasoningReplayError(
        "Reasoning replay batch resolution was incomplete",
        "reasoning_replay_not_found",
      );
    }
    const verified = verifiedPortableReplay(options, resolved, legacyOrigins);
    if (verified !== undefined) {
      if (
        (portableRegion !== undefined && portableRegion !== verified.region) ||
        (portableRuntimeProtocol !== undefined &&
          portableRuntimeProtocol !== verified.runtimeProtocol) ||
        (portableProfileArn !== undefined &&
          verified.profileArn !== undefined &&
          portableProfileArn !== verified.profileArn)
      ) {
        throw new ReasoningReplayError(
          "Portable reasoning replay items resolve to different verified mint cells",
          "reasoning_replay_context_mismatch",
        );
      }
      portableRegion = verified.region;
      portableRuntimeProtocol = verified.runtimeProtocol;
      portableProfileRequired = verified.profileRequired;
      portableProfileArn ??= verified.profileArn;
      portableCount += 1;
      if (verified.legacyCurrentCell) legacyPortableCount += 1;
      preferredAccountId ??= resolved.accountId;
      preferredConversationId ??= resolved.conversationId;
    } else {
      if (
        (accountId !== undefined && accountId !== resolved.accountId) ||
        (conversationId !== undefined && conversationId !== resolved.conversationId)
      ) {
        throw new ReasoningReplayError(
          "Reasoning replay items resolve to different accounts or conversations",
          "reasoning_replay_context_mismatch",
        );
      }
      accountId = resolved.accountId;
      conversationId = resolved.conversationId;
      preferredAccountId = resolved.accountId;
      preferredConversationId = resolved.conversationId;
    }
    const legacyInstructionProjection =
      resolved.replay.instructionProjection === undefined &&
      resolved.portable === true &&
      resolved.provenance?.protocol === "anthropic-messages" &&
      resolved.provenance.runtimeProtocol === "kiro-runtime" &&
      options.body.protocol === "anthropic-messages" &&
      options.model === "claude-fable-5-1" &&
      options.body.projectionMode === "v3-auto" &&
      replay.insertBeforeMessage > 0;
    replays.push(
      legacyInstructionProjection
        ? {
            ...resolved.replay,
            instructionProjection: {
              version: 1,
              legacyPrefixMessages: replay.insertBeforeMessage,
            },
            legacyProjectionUnversioned: true,
          }
        : resolved.replay,
    );
  }
  if (legacyPortableCount > 0) {
    auditLog("warn", "reasoning_replay_legacy_failover_admitted", {
      protocol: options.body.protocol,
      model: options.model,
      region: portableRegion,
      replay_count: legacyPortableCount,
    });
  }
  return {
    ...(accountId !== undefined ? { accountId } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(preferredAccountId !== undefined ? { preferredAccountId } : {}),
    ...(preferredConversationId !== undefined ? { preferredConversationId } : {}),
    ...(portableRegion !== undefined ? { portableRegion } : {}),
    ...(portableRuntimeProtocol !== undefined ? { portableRuntimeProtocol } : {}),
    ...(portableProfileRequired ? { portableProfileRequired } : {}),
    ...(portableProfileArn !== undefined ? { portableProfileArn } : {}),
    portableCount,
    legacyPortableCount,
    replays,
  };
}

function reasoningCaptureOptions(
  options: RunChatCompletionOptions,
  accountId: string,
  conversationId: string,
  mint: {
    readonly region: string;
    readonly profileArn?: string;
    readonly runtimeProtocol: "codewhisperer" | "kiro-runtime";
    readonly legacyPrefixMessages?: number;
  },
): {
  readonly captureReasoning?: SdkReasoningCaptureHandler;
  readonly emitEncryptedReasoning: boolean;
  readonly emitAnthropicReasoningMetadata: boolean;
  readonly bufferLateGptReasoning: boolean;
  readonly prefetchFableReasoning: boolean;
  readonly reasoningReplayDecision: ReasoningReplayDecision;
  readonly fingerprintOutput?: SdkOutputFingerprint;
  readonly captureOutput?: SdkOutputCaptureHandler;
} {
  const canonical = options.body;
  const emitEncryptedReasoning =
    canonical.includeEncryptedReasoning === true ||
    (canonical.protocol === "responses" && canonical.store !== false) ||
    canonical.protocol === "anthropic-messages";
  const emitAnthropicReasoningMetadata = canonical.protocol === "anthropic-messages";
  const bufferLateGptReasoning =
    emitAnthropicReasoningMetadata &&
    canonical.thinking?.enabled === true &&
    isGpt56Model(canonical.model);
  const prefetchFableReasoning =
    emitAnthropicReasoningMetadata &&
    canonical.thinking?.enabled === true &&
    canonical.thinking.display !== "summarized" &&
    isFable51Model(canonical.model);
  const reasoningReplayDecision: ReasoningReplayDecision = {};
  const captureOutput =
    options.lineage && options.affinityStore
      ? (output: CanonicalAssistantOutput): void => {
          if (output.text.length === 0 && output.toolCalls.length === 0) return;
          const lineageFingerprint = assistantLineageFingerprint(canonical, output);
          const keyHash = options.lineage?.outputKeyHash(lineageFingerprint);
          if (keyHash === undefined) return;
          options.affinityStore?.recordOutputLineage(
            keyHash,
            accountId,
            conversationId,
            Date.now(),
            options.config.session_affinity_ttl_ms,
            options.config.session_affinity_max_entries,
          );
          auditLog("info", "output_lineage_recorded", {
            protocol: canonical.protocol,
            lineage_source: options.lineage?.source,
            lineage_hash: auditHash(keyHash),
            account_hash: auditHash(accountId),
            conversation_hash: auditHash(conversationId),
          });
        }
      : undefined;
  if (!options.reasoningReplayStore || !options.tenantId) {
    return {
      emitEncryptedReasoning,
      emitAnthropicReasoningMetadata,
      bufferLateGptReasoning,
      prefetchFableReasoning,
      reasoningReplayDecision,
      fingerprintOutput: canonicalOutputFingerprint(canonical, options.clientNormalization),
      ...(captureOutput ? { captureOutput } : {}),
    };
  }
  return {
    captureReasoning: (capture, outputFingerprint) =>
      options.reasoningReplayStore?.store(capture, {
        tenantId: options.tenantId as string,
        model: canonical.model,
        accountId,
        conversationId,
        outputFingerprint,
        ...(options.clientNormalization
          ? { clientNormalization: options.clientNormalization }
          : {}),
        protocol: canonical.protocol,
        region: mint.region,
        ...(mint.profileArn !== undefined ? { profileArn: mint.profileArn } : {}),
        runtimeProtocol: mint.runtimeProtocol,
        upstreamOperation: "GenerateAssistantResponse",
        instructionProjection: {
          version: 1,
          ...(mint.legacyPrefixMessages !== undefined
            ? { legacyPrefixMessages: mint.legacyPrefixMessages }
            : {}),
        },
      }),
    emitEncryptedReasoning,
    emitAnthropicReasoningMetadata,
    bufferLateGptReasoning,
    prefetchFableReasoning,
    reasoningReplayDecision,
    fingerprintOutput: canonicalOutputFingerprint(canonical, options.clientNormalization),
    ...(captureOutput ? { captureOutput } : {}),
  };
}

/**
 * A portable-replay migration whose binding has not been committed yet. The
 * attempt runs on `toAccountId`/`toConversationId`; the stored binding (when
 * there is one) still names `fromAccountId`, so a rejection leaves it intact
 * and the client's retry can return to the origin.
 */
interface PendingMigration {
  readonly fromAccountId: string;
  readonly fromConversationId: string | undefined;
  readonly toAccountId: string;
  readonly toConversationId: string;
  readonly replayCount: number;
  readonly legacyReplayCount: number;
}

/** The single bounded return to the origin after Kiro rejected a migration. */
interface MigrationFallback {
  readonly accountId: string;
  readonly conversationId?: string;
  /** Returned unchanged when the origin cannot serve the fallback after all. */
  readonly terminal: CompletionResult;
}

/**
 * Mutable per-request state shared by the executeLoop phases. Every set/map is
 * scoped to one request; nothing here outlives runChatCompletion.
 */
interface LoopState {
  /**
   * Migration made by the current attempt, awaiting upstream acceptance before
   * its binding is stored. Reset at the start of every bind; cleared by the
   * commit or by the rejection handler.
   */
  pendingMigration: PendingMigration | undefined;
  /** The one origin fallback after a rejected migration has been used. */
  migrationFallbackSpent: boolean;
  /** Restricts selection to the origin while the fallback attempt is pending. */
  migrationFallback: MigrationFallback | undefined;
  readonly forcedRefreshAccountIds: Set<string>;
  readonly serverErrors: Map<string, number>;
  readonly requestExcludedAccountIds: Set<string>;
  readonly reportedQuotaExhaustedAccountIds: Set<string>;
  readonly refreshNetworkRetriedAccountIds: Set<string>;
  readonly modelRejectedAccountIds: Set<string>;
  lastAuthenticationFailure: NormalizedSdkError | undefined;
  lastQuotaFailure: NormalizedSdkError | undefined;
  lastRefreshFailure: RefreshFailure | undefined;
  retryCount: number;
  iterations: number;
  readonly startedAt: number;
  binding: PipelineAffinityBinding | undefined;
  readonly lineageBinding: PipelineAffinityBinding | undefined;
  readonly replayState: ReplayState;
  readonly replayLocked: boolean;
  /**
   * The stored affinity binding was dropped for repeated stalls, so the first
   * claim must overwrite it instead of re-adopting it. Cleared once that
   * overwrite happens, so later attempts in this request extend the replacement.
   * This is per-request state; the cross-request stall streak is independent.
   */
  affinityQuarantined: boolean;
  /**
   * Accounts the streak was actually recorded against. Held out of selection for
   * the rest of the request, because dropping the preference alone does not stop
   * a strategy from ranking the stalled account best again.
   *
   * Taken from the streak rather than from the stored binding: a failover rebinds
   * storage to its replacement before that replacement serves anything, so after
   * a failover that died late the stored account is the unproven replacement and
   * excluding it would re-select the wedged account.
   */
  readonly quarantinedAccountIds: ReadonlySet<string>;
  /**
   * The cell the stored history-lineage row names, when that row is what keys
   * this request's stall streak.
   *
   * A healthy answer retires the streak only when it came from that exact
   * account and conversation. The lineage row is keyed by the *previous*
   * assistant output and is never rewritten by this request — a new answer
   * records a new key — so whenever the request is served elsewhere the wedged
   * row survives intact and the client re-sending that same history resolves
   * straight back to it. That happens on a threshold quarantine, and equally
   * when the bound account was merely unselectable this time (rate limited,
   * unhealthy, model-ineligible) while the streak was still below the
   * threshold; clearing on either would strand the history with no protection.
   *
   * `undefined` when no such row keys the streak: an explicit affinity binding
   * keys it on a row `bindAttemptAffinity` rewrites to whatever account served,
   * so there a healthy answer does prove the stored row healthy.
   */
  readonly lineageStallRow: PipelineAffinityBinding | undefined;
  /** Account the request is bound to before selection (replay lock or affinity). */
  readonly boundAccountId: string | undefined;
  preferredAccountId: string | undefined;
  requestAccountId: string | undefined;
  requestConversationId: string | undefined;
  /** Upstream streams opened for this request; bounded by stream_max_attempts. */
  streamAttempts: number;
  /** Actual SDK send calls made for this provider request. */
  sdkDispatches: number;
  /** Accounts that already spent their same-account pre-publication retry. */
  readonly streamRetriedAccountIds: Set<string>;
  /** The one-shot empty-completion replacement attempt has been spent. */
  emptyCompletionRetried: boolean;
  /** Most recent pre-publication stream failure, for the no-candidates terminal. */
  lastStreamFailure: StreamFailure | undefined;
}

interface AttemptSelection {
  readonly selected: ManagedAccount;
  readonly accounts: readonly ManagedAccount[];
  readonly eligibleAccountIds: ReadonlySet<string>;
}

type SelectionOutcome =
  | { readonly kind: "selected"; readonly selection: AttemptSelection }
  | { readonly kind: "capacity-wait"; readonly accountIds: ReadonlySet<string> }
  | { readonly kind: "wait"; readonly waitMs: number }
  | { readonly kind: "result"; readonly result: CompletionResult };

type ReadySelectionOutcome = Exclude<SelectionOutcome, { readonly kind: "capacity-wait" }>;

type AttemptOutcome =
  | {
      readonly kind: "result";
      readonly result: CompletionResult;
      /** True when a stream result now owns the account lease. */
      readonly leaseTransferred: boolean;
    }
  | { readonly kind: "model-unavailable"; readonly account: ManagedAccount }
  | {
      readonly kind: "failed";
      readonly account: ManagedAccount;
      readonly caught: unknown;
      readonly upstreamStarted: boolean;
    }
  | {
      /**
       * The attempt-stream failed before any semantic event existed, so nothing
       * reached a client buffer and a replacement attempt is safe.
       */
      readonly kind: "stream-failed";
      readonly account: ManagedAccount;
      readonly caught: unknown;
      readonly failure: StreamFailure;
    }
  | {
      /** Kiro completed with no output at all; one same-account replacement follows. */
      readonly kind: "empty-completion";
      readonly account: ManagedAccount;
    };

type LoopDirective =
  | { readonly kind: "continue" }
  | { readonly kind: "return"; readonly result: CompletionResult };

const CONTINUE: LoopDirective = { kind: "continue" };

function returning(result: CompletionResult): LoopDirective {
  return { kind: "return", result };
}

/**
 * A few protocol profiles must make exactly one auditable inference attempt.
 * This budget is deliberately independent of the normal retry knobs: those
 * knobs cover distinct failure classes and can otherwise combine into more
 * SDK sends than any single setting suggests.
 */
function hasRemainingUpstreamDispatchBudget(
  options: RunChatCompletionOptions,
  state: LoopState,
): boolean {
  return (
    options.maxUpstreamDispatches === undefined ||
    state.sdkDispatches < options.maxUpstreamDispatches
  );
}

function reportUpstreamDispatchBudgetExhausted(
  options: RunChatCompletionOptions,
  state: LoopState,
  outcome: string,
): void {
  auditLog("warn", "upstream_dispatch_budget_exhausted", {
    request_id: options.requestId,
    dispatches: state.sdkDispatches,
    max_dispatches: options.maxUpstreamDispatches,
    outcome,
    mode: options.stream ? "stream" : "non-stream",
  });
}

/**
 * The binding key this request's stall streak is counted against.
 *
 * An explicit session affinity key when the client supplied one, otherwise the
 * history-lineage lookup key. Under the default `explicit-only` affinity mode a
 * multi-turn client that sends no session header still resolves a stored
 * binding through lineage, so counting only against `affinity` would leave
 * exactly that path permanently below the threshold and its wedged binding
 * sticky forever.
 */
function affinityStallKey(
  options: RunChatCompletionOptions,
): { readonly keyHash: string; readonly source: string } | undefined {
  if (options.affinity) return options.affinity;
  if (options.lineage?.lookupKeyHash !== undefined) {
    return { keyHash: options.lineage.lookupKeyHash, source: options.lineage.source };
  }
  return undefined;
}

/**
 * Reads the short-term stall streak for this request's binding key and decides
 * whether the stored binding has earned a quarantine.
 *
 * This is a routing decision for a *new* request, taken before any upstream
 * call: it never replays a committed stream, and the caller only consults it
 * once the reasoning replay envelope is known to carry no owner lock.
 */
function resolveAffinityStall(
  options: RunChatCompletionOptions,
  key: { readonly keyHash: string } | undefined,
  now: number,
): AffinityStallSnapshot | undefined {
  const threshold = options.config.session_affinity_stall_failover_threshold;
  if (threshold <= 0 || key === undefined || !options.affinityStore) return undefined;
  const stall = (options.affinityStalls ?? affinityStallTracker).peek(
    key.keyHash,
    now,
    options.config.session_affinity_stall_window_ms,
  );
  return stall !== undefined && stall.count >= threshold ? stall : undefined;
}

/** Phase 1: resolve affinity/lineage/replay bindings into the initial loop state. */
function resolveBinding(options: RunChatCompletionOptions): LoopState {
  const startedAt = Date.now();
  const storedBinding =
    options.affinity && options.affinityStore
      ? options.affinityStore.getSessionAffinity(options.affinity.keyHash)
      : undefined;
  const storedLineage =
    storedBinding === undefined &&
    options.lineage?.lookupKeyHash !== undefined &&
    options.affinityStore
      ? options.affinityStore.resolveOutputLineage(options.lineage.lookupKeyHash)
      : undefined;
  // Resolved from the stored bindings so replay ownership and portability are
  // decided exactly as they are without a quarantine; the bindings only seed
  // soft preferences here.
  const replayState = resolveReplayState(options, storedBinding ?? storedLineage);
  const replayLocked = replayState.accountId !== undefined;
  // A wedged Kiro conversation keeps answering with partial output and then
  // going silent, so every request that re-resolves the same binding reproduces
  // the stall. After enough consecutive failures the binding stops being a
  // useful preference and this request selects from scratch. An owner-locked
  // replay is exempt: its account and conversation are authorization, not
  // preference, and bindAttemptAffinity would reject a conflicting claim.
  const stallKey = affinityStallKey(options);
  const stall = replayLocked ? undefined : resolveAffinityStall(options, stallKey, startedAt);
  const binding = stall === undefined ? storedBinding : undefined;
  const lineageBinding = stall === undefined ? storedLineage : undefined;
  const effectiveBinding = binding ?? lineageBinding;
  const boundAccountId = replayState.accountId ?? effectiveBinding?.accountId;
  // Quarantine also drops the soft replay preference: a portable replay is
  // valid on any verified cell, and keeping the preference would steer the
  // request straight back to the account that just stalled. The hard
  // portability constraints (region, runtime protocol, profile) stay in
  // replayState and are still enforced during selection.
  const preferredAccountId =
    boundAccountId ?? (stall === undefined ? replayState.preferredAccountId : undefined);
  if (stall !== undefined && stallKey !== undefined) {
    // Deciding the failover deliberately does not clear the streak. This request
    // can still die before a replacement exists (no healthy account, model
    // eligibility, deadline), so clearing here would delete the only stall
    // evidence while storage still resolves the wedged account. The streak is
    // therefore evidence about the binding key, retired by a healthy answer whose
    // binding storage agrees with, or by the window elapsing.
    auditLog("warn", "session_affinity_stall_failover", {
      request_id: options.requestId,
      protocol: options.body.protocol,
      model: options.model,
      affinity_source: stallKey.source,
      affinity_hash: auditHash(stallKey.keyHash),
      stall_count: stall.count,
      stall_span_ms: Math.max(0, stall.lastAt - stall.firstAt),
      stall_threshold: options.config.session_affinity_stall_failover_threshold,
      quarantined_binding: storedBinding !== undefined,
      quarantined_lineage: storedBinding === undefined && storedLineage !== undefined,
    });
  }
  return {
    pendingMigration: undefined,
    migrationFallbackSpent: false,
    migrationFallback: undefined,
    forcedRefreshAccountIds: new Set<string>(),
    serverErrors: new Map<string, number>(),
    requestExcludedAccountIds: new Set<string>(),
    reportedQuotaExhaustedAccountIds: new Set<string>(),
    refreshNetworkRetriedAccountIds: new Set<string>(),
    modelRejectedAccountIds: new Set<string>(),
    lastAuthenticationFailure: undefined,
    lastQuotaFailure: undefined,
    lastRefreshFailure: undefined,
    retryCount: 0,
    iterations: 0,
    startedAt,
    binding,
    lineageBinding,
    replayState,
    replayLocked,
    affinityQuarantined: stall !== undefined,
    // The recorded accounts are the evidence. The stored row's account is only a
    // fallback for a streak recorded before any account was known, so a
    // quarantine never degrades into excluding nothing at all.
    quarantinedAccountIds:
      stall === undefined
        ? new Set<string>()
        : stall.accountIds.size > 0
          ? new Set(stall.accountIds)
          : new Set(
              [(storedBinding ?? storedLineage)?.accountId].filter(
                (accountId): accountId is string => accountId !== undefined,
              ),
            ),
    // Recorded whether or not the streak reached the threshold: a sub-threshold
    // streak whose bound account happens to be unselectable is served elsewhere
    // too, and the row it left behind is just as wedged.
    lineageStallRow: options.affinity === undefined ? storedLineage : undefined,
    boundAccountId,
    preferredAccountId,
    requestAccountId: preferredAccountId,
    requestConversationId:
      replayState.conversationId ??
      effectiveBinding?.conversationId ??
      (stall === undefined ? replayState.preferredConversationId : undefined),
    streamAttempts: 0,
    sdkDispatches: 0,
    streamRetriedAccountIds: new Set<string>(),
    emptyCompletionRetried: false,
    lastStreamFailure: undefined,
  };
}

/** Drops the sticky preference so the next selection starts from scratch. */
function forgetPreferredAccount(state: LoopState): void {
  state.preferredAccountId = undefined;
  state.requestAccountId = undefined;
  state.requestConversationId = undefined;
}

/**
 * A refresh failure before the upstream call started is an account-level
 * fault, not a request fault: exclude the account for this request and let
 * the loop pick another one. A first NETWORK_ERROR gets one bounded retry on
 * the same account before it is excluded.
 */
function excludeAfterRefreshFailure(
  options: RunChatCompletionOptions,
  state: LoopState,
  failed: ManagedAccount,
  failure: RefreshFailure,
): "retry" | "switch" {
  const reason = refreshFailureReason(failure);
  const refreshTokenDead = failure instanceof KiroTokenRefreshError && isRefreshTokenDead(reason);
  const networkError = failure instanceof KiroTokenRefreshError && failure.code === "NETWORK_ERROR";
  state.lastRefreshFailure = failure;
  if (networkError && !state.refreshNetworkRetriedAccountIds.has(failed.id)) {
    state.refreshNetworkRetriedAccountIds.add(failed.id);
    auditLog("warn", "account_token_refresh_retry", {
      account_hash: auditHash(failed.id),
      error_code: failure.code,
    });
    return "retry";
  }
  if (state.replayLocked) {
    if (failure instanceof KiroTokenRefreshError) {
      if (refreshTokenDead) {
        options.accountManager.markUnhealthy(failed, toDeadReason(reason));
      } else {
        options.accountManager.markRateLimited(
          failed,
          Date.now() + options.config.rate_limit_retry_delay_ms,
        );
      }
    }
    auditLog("warn", "reasoning_replay_account_refresh_failed", {
      account_hash: auditHash(failed.id),
      error_type: failure.name,
      error_code: failure instanceof KiroTokenRefreshError ? failure.code : undefined,
      refresh_token_dead: refreshTokenDead,
    });
    return "switch";
  }
  state.requestExcludedAccountIds.add(failed.id);
  if (failure instanceof KiroTokenRefreshError) {
    if (refreshTokenDead) {
      options.accountManager.markUnhealthy(failed, toDeadReason(reason));
    } else {
      options.accountManager.markRateLimited(
        failed,
        Date.now() + options.config.rate_limit_retry_delay_ms,
      );
    }
  }
  auditLog("warn", "account_token_refresh_failed", {
    account_hash: auditHash(failed.id),
    error_type: failure.name,
    error_code: failure instanceof KiroTokenRefreshError ? failure.code : undefined,
    refresh_token_dead: refreshTokenDead,
  });
  forgetPreferredAccount(state);
  return "switch";
}

/** Runs the refresh-failure policy and sleeps once when it asks for a same-account retry. */
async function continueAfterRefreshFailure(
  options: RunChatCompletionOptions,
  signal: AbortSignal,
  state: LoopState,
  failed: ManagedAccount,
  failure: RefreshFailure,
  source: "initial" | "forced" = "initial",
): Promise<LoopDirective> {
  const action = excludeAfterRefreshFailure(options, state, failed, failure);
  if (state.replayLocked) {
    if (
      failure instanceof KiroTokenRefreshError &&
      isRefreshTokenDead(refreshFailureReason(failure))
    ) {
      return returning(
        replayAccountError(
          403,
          "The account bound to signed reasoning replay requires re-authentication",
          "reasoning_replay_account_reauthentication_required",
        ),
      );
    }
    if (failure instanceof AccountUnavailableError) return returning(replayUnavailable());
    // An initial NETWORK_ERROR receives the existing one bounded same-account
    // retry. A forced refresh follows an upstream credential rejection and must
    // surface its own typed failure instead of re-sending the rejected token.
    if (action !== "retry" || source === "forced") {
      return returning(
        replayAccountError(
          503,
          "Token refresh failed for the account bound to signed reasoning replay",
          "reasoning_replay_account_refresh_failed",
        ),
      );
    }
  }
  if (action === "retry") {
    await abortableSleep(options.config.rate_limit_retry_delay_ms, signal);
  }
  return CONTINUE;
}

/**
 * B6: authoritative quota probes stay off the request hot path when the
 * request can proceed anyway; the rechecker dedupes and bounds them. They are
 * awaited only when nothing selectable remains or the replay-locked account
 * is exhausted.
 */
async function scheduleQuotaRecheck(
  options: RunChatCompletionOptions,
  signal: AbortSignal,
  state: LoopState,
): Promise<void> {
  const rechecker = options.quotaRechecker;
  if (!rechecker) return;
  const recheckAccounts = options.accountManager.reconcileFromDb();
  const recheckNow = Date.now();
  const usableCandidate = recheckAccounts.some((account) =>
    isSelectableAccount(account, recheckNow),
  );
  const lockedAccountExhausted =
    state.replayLocked &&
    recheckAccounts.some(
      (account) =>
        account.id === state.boundAccountId && isQuotaExhausted(account, overagePolicy(options)),
    );
  if (usableCandidate && !lockedAccountExhausted) {
    void rechecker
      .recheckDueAccounts(recheckAccounts, new AbortController().signal, state.boundAccountId)
      .catch((error: unknown) => {
        auditLog("warn", "quota_recheck_background_failed", {
          error_type: error instanceof Error ? error.name : typeof error,
        });
      });
    return;
  }
  await rechecker.recheckDueAccounts(recheckAccounts, signal, state.boundAccountId);
}

function authenticationFailureResult(failure: NormalizedSdkError): CompletionResult {
  return {
    kind: "response",
    response: terminalError(
      failure.status ?? 403,
      failure.message,
      failure.code ?? "upstream_authentication_failed",
    ),
  };
}

/** The overage gate the pipeline applies; prefers the manager's policy so both agree. */
function overagePolicy(options: RunChatCompletionOptions): OveragePolicy {
  return options.accountManager.getOveragePolicy?.() ?? toOveragePolicy(options.config);
}

/** Every eligible account is healthy and within quota but held back by paid overage. */
function paidOverageBlockedResult(): CompletionResult {
  return {
    kind: "response",
    response: terminalError(
      402,
      "All eligible Kiro accounts are blocked by paid overage; set stop_on_overage to false or raise overage_threshold to keep using them",
      "paid_overage_blocked",
    ),
  };
}

function quotaFailureResult(failure: NormalizedSdkError | undefined): CompletionResult {
  return {
    kind: "response",
    response: terminalError(
      402,
      failure?.message ?? "All eligible Kiro accounts have exhausted their quota",
      failure?.code ?? "quota_exhausted",
    ),
  };
}

/** Terminal result once max_request_iterations is exceeded. */
function iterationsExhaustedResult(
  options: RunChatCompletionOptions,
  state: LoopState,
): CompletionResult {
  if (state.lastAuthenticationFailure) {
    return authenticationFailureResult(state.lastAuthenticationFailure);
  }
  if (state.lastQuotaFailure) return quotaFailureResult(state.lastQuotaFailure);
  return {
    kind: "response",
    response: openAiError(
      500,
      `Exceeded max iterations (${options.config.max_request_iterations})`,
      "request_error",
      "max_request_iterations",
    ),
  };
}

/**
 * The account a request carrying portable signed reasoning should stay on: its
 * preferred (bound) account, whenever that account is a candidate and can take
 * one more request.
 *
 * The least-queued spread treats a single in-flight request as a reason to
 * move elsewhere. For a replay-carrying thread that means re-projecting the
 * whole signed history into a fresh conversation on a foreign account, which
 * Kiro rejected outright (400 REQUEST_BODY_INVALID) for 8 of 91 production
 * migrations while no fresh dispatch ever failed that way. So the origin wins
 * ahead of the spread while it is below its concurrency ceiling; only an origin
 * at capacity still shares idle capacity elsewhere, which keeps the verified
 * failover useful for a rate-limited or exhausted owner. Requests without
 * portable replays keep the plain spread.
 */
function portableReplayOrigin(
  options: RunChatCompletionOptions,
  state: LoopState,
  candidateIds: ReadonlySet<string>,
): string | undefined {
  const preferred = state.preferredAccountId;
  if (state.replayState.portableCount === 0 || preferred === undefined) return undefined;
  if (!candidateIds.has(preferred)) return undefined;
  return accountQueueDepth(preferred) < options.config.account_inference_concurrency
    ? preferred
    : undefined;
}

/**
 * Phase 2: pick the account for this attempt. Reports newly excluded
 * quota-exhausted accounts, applies model eligibility, and when nothing is
 * selectable decides between a terminal result and waiting out a rate limit.
 */
function selectAttemptAccount(
  options: RunChatCompletionOptions,
  state: LoopState,
): SelectionOutcome {
  const accounts = options.accountManager.reconcileFromDb();
  const requestCandidates = accounts.filter(
    (account) =>
      !state.modelRejectedAccountIds.has(account.id) &&
      !state.requestExcludedAccountIds.has(account.id),
  );
  const policy = overagePolicy(options);
  const quotaExhaustedAccounts = requestCandidates.filter((account) =>
    isQuotaExhausted(account, policy),
  );
  const newlyReportedQuotaAccounts = quotaExhaustedAccounts.filter(
    (account) => !state.reportedQuotaExhaustedAccountIds.has(account.id),
  );
  for (const account of newlyReportedQuotaAccounts) {
    state.reportedQuotaExhaustedAccountIds.add(account.id);
  }
  if (newlyReportedQuotaAccounts.length > 0) {
    auditLog("info", "quota_exhausted_accounts_excluded", {
      account_count: newlyReportedQuotaAccounts.length,
    });
  }
  const candidateAccountIds = requestCandidates
    .filter((account) => !isQuotaExhausted(account, policy))
    .map((account) => account.id);
  const cachedEligible = options.modelCapabilities?.eligibleAccountIds(
    options.model,
    candidateAccountIds,
  );
  const eligibleAccountIds = new Set(
    [...(cachedEligible ?? candidateAccountIds)].filter(
      (accountId) =>
        !state.modelRejectedAccountIds.has(accountId) &&
        (state.replayState.portableRegion === undefined ||
          (() => {
            const account = accounts.find((candidate) => candidate.id === accountId);
            if (!account) return false;
            const region = extractRegionFromArn(account.profileArn) ?? account.region;
            return (
              region === state.replayState.portableRegion &&
              (!state.replayState.portableProfileRequired || account.profileArn !== undefined) &&
              (state.replayState.portableProfileArn === undefined ||
                account.profileArn === state.replayState.portableProfileArn)
            );
          })()),
    ),
  );
  // A quarantined binding has to move off the account that stalled, and
  // dropping the preference is not enough to do it: `sticky` still points at
  // that account, `round-robin` can land on it again, and `lowest-usage` can
  // rank it best, after which the rebind would only change the conversation and
  // the stall would repeat. Hold it out of the candidate set instead, and fall
  // back to it only when nothing else can serve the request, so a
  // single-account deployment still gets an answer.
  //
  // After a rejected migration the request may return to its origin exactly
  // once; that attempt is restricted to the origin the same way an owner lock
  // is, so it can never turn into a migration onto a third account.
  const fallbackAccountId = state.migrationFallback?.accountId;
  const selectionNow = Date.now();
  const selectable = accounts.filter(
    (account) =>
      eligibleAccountIds.has(account.id) &&
      isSelectableAccount(account, selectionNow, policy) &&
      (!state.replayLocked || account.id === state.replayState.accountId) &&
      (fallbackAccountId === undefined || account.id === fallbackAccountId),
  );
  const notQuarantined = selectable.filter(
    (account) => !state.quarantinedAccountIds.has(account.id),
  );
  const candidates = !state.replayLocked && notQuarantined.length > 0 ? notQuarantined : selectable;
  const candidateIds = new Set(candidates.map((account) => account.id));
  const replayOrigin = portableReplayOrigin(options, state, candidateIds);
  const available =
    replayOrigin === undefined
      ? leastQueuedAccountIds(candidates, candidateIds, policy)
      : new Set([replayOrigin]);
  if (
    available.size > 0 &&
    [...available].every(
      (id) => accountQueueDepth(id) >= options.config.account_inference_concurrency,
    )
  ) {
    // Do not bind an unaccepted request behind one arbitrarily selected busy
    // account. Any of these already-qualified accounts may become free first.
    return { kind: "capacity-wait", accountIds: candidateIds };
  }
  const selected = options.accountManager.selectHealthyAccount(state.preferredAccountId, available);
  if (
    selected &&
    (state.replayState.accountId === undefined || selected.id === state.replayState.accountId)
  ) {
    return { kind: "selected", selection: { selected, accounts, eligibleAccountIds } };
  }

  if (state.migrationFallback !== undefined) {
    // The origin stopped being selectable between the rejection and this
    // selection. Projecting the same signed history onto yet another account
    // would repeat the rejected shape, so the request ends with the rejection
    // it already earned.
    return { kind: "result", result: state.migrationFallback.terminal };
  }
  if (state.replayLocked) {
    return replayLockedSelectionResult(options, state, accounts, eligibleAccountIds);
  }
  if (candidateAccountIds.length === 0 && state.lastAuthenticationFailure) {
    return { kind: "result", result: authenticationFailureResult(state.lastAuthenticationFailure) };
  }
  if (
    candidateAccountIds.length === 0 &&
    state.lastQuotaFailure === undefined &&
    options.accountManager.blockedByOverageOnly?.(
      new Set(requestCandidates.map((account) => account.id)),
    ) === true
  ) {
    return { kind: "result", result: paidOverageBlockedResult() };
  }
  if (
    candidateAccountIds.length === 0 &&
    (quotaExhaustedAccounts.length > 0 || state.lastQuotaFailure)
  ) {
    return { kind: "result", result: quotaFailureResult(state.lastQuotaFailure) };
  }
  if (candidateAccountIds.length === 0 && state.lastStreamFailure !== undefined) {
    return { kind: "result", result: streamFailureResult(undefined, state.lastStreamFailure) };
  }
  if (candidateAccountIds.length === 0 && state.lastRefreshFailure !== undefined) {
    return { kind: "result", result: refreshFailureResponse() };
  }
  if (
    state.modelRejectedAccountIds.size > 0 ||
    (cachedEligible !== undefined && eligibleAccountIds.size === 0)
  ) {
    return { kind: "result", result: modelAvailabilityError(options) };
  }
  // Every remaining candidate is merely rate-limited: wait for the shortest
  // reset if it fits the request deadline instead of failing.
  const waitNow = Date.now();
  const waitMs = shortestRateLimitWaitMs(
    requestCandidates,
    new Set(cachedEligible ?? candidateAccountIds),
    waitNow,
    overagePolicy(options),
  );
  const remainingMs = options.config.request_timeout_ms - (waitNow - state.startedAt);
  if (waitMs !== undefined && waitMs <= remainingMs) {
    auditLog("info", "rate_limit_wait_for_reset", {
      wait_ms: waitMs,
      remaining_ms: remainingMs,
    });
    return { kind: "wait", waitMs };
  }
  return {
    kind: "result",
    result: {
      kind: "response",
      response: openAiError(
        503,
        "All accounts are unhealthy or rate-limited",
        "service_unavailable",
        "no_healthy_accounts",
      ),
    },
  };
}

/**
 * Phase 3: claim or rebind the session affinity for the selected account and
 * fix the Kiro conversation id for this attempt. Returns "reselect" when a
 * concurrent claim bound the session to a different account.
 */
function bindAttemptAffinity(
  options: RunChatCompletionOptions,
  state: LoopState,
  selected: ManagedAccount,
): "proceed" | "reselect" {
  const now = Date.now();
  // A migration recorded by an earlier attempt of this request was never
  // committed (that attempt failed before acceptance), so this bind starts over.
  state.pendingMigration = undefined;
  const migratedPortableReplay =
    state.replayState.portableCount > 0 &&
    state.replayState.preferredAccountId !== undefined &&
    selected.id !== state.replayState.preferredAccountId;
  // An already committed migration binds `selected`; extending that row is the
  // ordinary claim below, not a new migration.
  const deferredMigration = migratedPortableReplay && state.binding?.accountId !== selected.id;
  const deferredBinding =
    deferredMigration && options.affinity !== undefined && options.affinityStore !== undefined;
  // The cell this migration leaves. Once an earlier attempt of this request
  // committed a migration, the stored binding names that accepted cell, and a
  // rejected second hop has to fall back there: falling back to the
  // resolve-time owner would rebind the thread to a conversation Kiro never
  // accepted, which is exactly the defect deferred commits remove.
  const migrationOrigin =
    state.binding?.accountId ?? (state.replayState.preferredAccountId as string);
  if (migratedPortableReplay) {
    state.requestAccountId = selected.id;
    state.requestConversationId = randomUUID();
  }
  if (deferredMigration) {
    // Nothing is stored yet. Upstream acceptance commits the binding
    // (commitPendingMigration); until then the stored row keeps naming the
    // origin, so a rejection at the headers leaves the thread where it was.
    state.pendingMigration = {
      fromAccountId: migrationOrigin,
      fromConversationId:
        state.binding?.conversationId ?? state.replayState.preferredConversationId,
      toAccountId: selected.id,
      toConversationId: state.requestConversationId as string,
      replayCount: state.replayState.portableCount,
      legacyReplayCount: state.replayState.legacyPortableCount,
    };
  } else if (options.affinity && options.affinityStore) {
    if (!state.binding) {
      // A quarantined key still has its stalled row in storage, and
      // claimSessionAffinity would re-adopt it: the delete only covers expired
      // rows and the insert is OR IGNORE, so the stored account would win and
      // the loop would bounce on "reselect". Overwrite it instead, so the
      // selected account and a fresh conversation actually take effect.
      // replayLocked is false whenever the quarantine is set, so this discards
      // no owner-locked conversation.
      const claimed = state.affinityQuarantined
        ? options.affinityStore.rebindSessionAffinity(
            options.affinity.keyHash,
            selected.id,
            randomUUID(),
            now,
            options.config.session_affinity_ttl_ms,
            options.config.session_affinity_max_entries,
          )
        : options.affinityStore.claimSessionAffinity(
            options.affinity.keyHash,
            selected.id,
            state.requestConversationId ?? randomUUID(),
            now,
            options.config.session_affinity_ttl_ms,
            options.config.session_affinity_max_entries,
          );
      // Per-request only: a later attempt must extend the replacement binding
      // rather than mint yet another conversation. The cross-request streak is
      // untouched and still governs the next request.
      state.affinityQuarantined = false;
      state.binding = claimed;
      state.preferredAccountId = claimed.accountId;
      state.requestConversationId = claimed.conversationId;
      if (
        state.replayLocked &&
        (claimed.accountId !== state.replayState.accountId ||
          claimed.conversationId !== state.replayState.conversationId)
      ) {
        throw new ReasoningReplayError(
          "Session affinity conflicts with signed reasoning replay",
          "reasoning_replay_context_mismatch",
        );
      }
      if (claimed.accountId !== selected.id) return "reselect";
    } else if (
      state.binding.accountId === selected.id &&
      (!state.replayLocked || state.binding.conversationId === state.replayState.conversationId)
    ) {
      state.binding = options.affinityStore.claimSessionAffinity(
        options.affinity.keyHash,
        selected.id,
        state.binding.conversationId,
        now,
        options.config.session_affinity_ttl_ms,
        options.config.session_affinity_max_entries,
      );
      state.requestConversationId = state.binding.conversationId;
    } else {
      state.binding = options.affinityStore.rebindSessionAffinity(
        options.affinity.keyHash,
        selected.id,
        state.replayLocked ? (state.replayState.conversationId as string) : randomUUID(),
        now,
        options.config.session_affinity_ttl_ms,
        options.config.session_affinity_max_entries,
      );
      state.requestConversationId = state.binding.conversationId;
    }
  } else if (!state.replayLocked && state.requestAccountId !== selected.id) {
    state.requestAccountId = selected.id;
    state.requestConversationId = randomUUID();
  }

  // Only a migration this bind actually makes is reported. A later attempt of
  // this request that lands on the already committed cell (an empty-completion
  // replacement, the fallback of a rejected second hop) extends that binding
  // and is not a second migration.
  if (deferredMigration) {
    auditLog("info", "reasoning_replay_account_migrated", {
      request_id: options.requestId,
      protocol: options.body.protocol,
      model: options.model,
      from_account_hash: auditHash(migrationOrigin),
      to_account_hash: auditHash(selected.id),
      replay_count: state.replayState.portableCount,
      legacy_replay_count: state.replayState.legacyPortableCount,
      binding: deferredBinding ? "deferred" : "none",
    });
  }

  state.preferredAccountId = selected.id;
  auditLog("info", "upstream_affinity_selected", {
    request_id: options.requestId,
    projection_mode: options.config.protocol_projection_mode,
    session_affinity_mode: options.config.session_affinity_mode,
    affinity_source: options.affinity?.source ?? options.lineage?.source,
    affinity_bound: state.binding !== undefined || state.lineageBinding !== undefined,
    affinity_kind:
      state.binding !== undefined
        ? "explicit"
        : state.lineageBinding !== undefined
          ? "history-lineage"
          : undefined,
    account_hash: auditHash(selected.id),
    conversation_hash:
      state.requestConversationId === undefined
        ? undefined
        : auditHash(state.requestConversationId),
    reasoning_replay_locked: state.replayLocked,
  });
  return "proceed";
}

/**
 * Phase 4: one upstream attempt on the selected account: refresh, model
 * availability, request projection, SDK send, and (non-stream) collection.
 * Never throws for attempt errors; they come back as a "failed" outcome so the
 * caller can classify them with the refreshed account in hand.
 */
async function runAttempt(
  options: RunChatCompletionOptions,
  signal: AbortSignal,
  state: LoopState,
  selected: ManagedAccount,
  releaseAccount: () => void,
): Promise<AttemptOutcome> {
  const { think, budget } = thinkingOptions(options.body, options.model);
  let account = selected;
  let upstreamStarted = false;
  try {
    options.diagnostics?.phase("token_refresh");
    const initialAuth = options.accountManager.toAuthDetails(selected);
    account = await abortable(
      options.tokenRefresher.refreshIfNeeded(selected, initialAuth, signal),
      signal,
    );
    const auth = options.accountManager.toAuthDetails(account);
    options.diagnostics?.phase("request_validation");
    if (options.modelCapabilities) {
      const availability = await abortable(
        options.modelCapabilities.ensureAccountModel(account, auth, options.model, signal),
        signal,
      );
      if (!availability.supported) {
        auditLog("warn", "account_model_unavailable", {
          request_id: options.requestId,
          account_hash: auditHash(account.id),
          model_hash: auditHash(options.model),
          capability_source: availability.source,
        });
        return { kind: "model-unavailable", account };
      }
    }
    let nativeSystemPromptEnabled = false;
    if (
      (options.body.projectionMode === "v3-auto" ||
        options.body.projectionMode === "native-context-safe" ||
        (options.body.protocol === "responses" &&
          options.body.projectionMode === "legacy-user-prefix")) &&
      hasInstructionInput(options.body)
    ) {
      const capability = options.nativeContextCapabilities
        ? await abortable(
            options.nativeContextCapabilities.ensureAccountNativeContext(account, auth, signal),
            signal,
          )
        : {
            status: "unknown" as const,
            source: "probe-error" as const,
            featureCount: 0,
            systemFieldInjection: false,
            systemPromptMigration: false,
          };
      auditLog("debug", "native_context_capability_selected", {
        request_id: options.requestId,
        account_hash: auditHash(account.id),
        status: capability.status,
        source: capability.source,
        feature_count: capability.featureCount,
        system_field_injection: capability.systemFieldInjection,
        system_prompt_migration: capability.systemPromptMigration,
      });
      if (
        options.body.projectionMode === "native-context-safe" &&
        capability.status !== "available"
      ) {
        throw new RequestTransformError(
          capability.status === "unknown"
            ? "Kiro Runtime native instruction capability could not be verified; native-context-safe remains fail-closed"
            : "Kiro Runtime did not advertise system_field_injection for this account; native-context-safe remains fail-closed",
          "native_context_capability_unavailable",
        );
      }
      nativeSystemPromptEnabled = capability.status === "available";
    }
    const parsedEffort = EffortSchema.safeParse(options.config.effort);
    const promptCaching = options.modelCapabilities?.promptCaching?.(account.id, options.model);
    const prepared = transformToSdkRequest(options.body, options.model, auth, think, budget, {
      autoEffortMapping: options.config.auto_effort_mapping,
      conversationId: state.requestConversationId,
      nativeSystemPromptEnabled,
      resolvedReasoningReplays: state.replayState.replays,
      promptCaching: {
        mode: options.config.kiro_prompt_cache_mode,
        supported: promptCaching?.supportsPromptCaching === true,
        ...(promptCaching?.maximumCacheCheckpointsPerRequest !== undefined
          ? { maximumCheckpoints: promptCaching.maximumCacheCheckpointsPerRequest }
          : {}),
        ...(promptCaching?.minimumTokensPerCacheCheckpoint !== undefined
          ? { minimumTokens: promptCaching.minimumTokensPerCacheCheckpoint }
          : {}),
      },
      ...(parsedEffort.success ? { effort: parsedEffort.data } : {}),
    });
    if (
      state.replayState.portableRuntimeProtocol !== undefined &&
      prepared.runtimeProtocol !== state.replayState.portableRuntimeProtocol
    ) {
      throw new ReasoningReplayError(
        "Reasoning replay request does not match the authenticated upstream operation",
        "reasoning_replay_context_mismatch",
      );
    }
    options.onProjection?.(prepared.diagnostics);
    if (prepared.diagnostics.projection.legacyPrefixMessages !== undefined) {
      auditLog("info", "reasoning_replay_projection_compatibility", {
        protocol: options.body.protocol,
        model: options.model,
        prefix_message_count: prepared.diagnostics.projection.legacyPrefixMessages,
      });
    }
    // Keep the invariant at the actual send boundary as well as at every known
    // retry decision. A future retry path cannot accidentally bypass the
    // profile's hard inference ceiling.
    if (!hasRemainingUpstreamDispatchBudget(options, state)) {
      reportUpstreamDispatchBudgetExhausted(options, state, "dispatch-guard");
      return {
        kind: "result",
        leaseTransferred: false,
        result: {
          kind: "response",
          response: terminalError(
            502,
            "Upstream inference dispatch budget was exhausted",
            "upstream_dispatch_budget_exhausted",
          ),
        },
      };
    }
    const plannedAttempt = state.sdkDispatches + 1;
    const conversationHash = auditHash(prepared.conversationId);
    const accountHash = auditHash(account.id);
    auditLog("debug", "request_projection_completed", {
      request_id: options.requestId,
      attempt: plannedAttempt,
      model: options.model,
      conversation_hash: conversationHash,
      projection_mode: prepared.diagnostics.projection.projectionMode,
      instruction_channel: prepared.diagnostics.projection.instructionChannel,
      input_message_count: prepared.diagnostics.projection.inputMessageCount,
      output_message_count: prepared.diagnostics.projection.outputMessageCount,
      prefix_instruction_count: prepared.diagnostics.projection.prefixInstructionCount,
      trailing_instruction_count: prepared.diagnostics.projection.trailingInstructionCount,
      prefix_action: prepared.diagnostics.projection.prefixAction,
      suffix_action: prepared.diagnostics.projection.suffixAction,
    });
    auditLog("debug", "request_history_built", {
      request_id: options.requestId,
      attempt: plannedAttempt,
      model: options.model,
      conversation_hash: conversationHash,
      history_message_count: prepared.diagnostics.history.historyMessageCount,
      current_role: prepared.diagnostics.history.currentRole,
      current_text_chars: prepared.diagnostics.history.currentTextChars,
      current_has_text: prepared.diagnostics.history.currentTextChars > 0,
      current_image_count: prepared.diagnostics.history.currentImageCount,
      current_document_count: prepared.diagnostics.history.currentDocumentCount,
      current_tool_result_count: prepared.diagnostics.history.currentToolResultCount,
      reasoning_replay_count: prepared.diagnostics.history.reasoningReplayCount,
    });
    const makeClient = options.makeClient ?? createSdkClient;
    const client = makeClient(
      auth,
      prepared.region,
      prepared.effort,
      runtimeEndpoint(options, prepared.region),
      resolveProxyUrl(options.config),
      account.id,
      options.config.sdk_http_keep_alive,
      prepared.runtimeProtocol,
    );
    // Effort travels in the command input (B7); the SDK client no longer
    // re-parses and re-serializes the request body to inject it.
    const wireModel =
      prepared.conversationState.currentMessage.userInputMessage?.modelId ??
      prepared.effectiveModel;
    let additionalModelRequestFields = prepared.effort
      ? mergeModelRequestFields(
          prepared.additionalModelRequestFields,
          buildEffortRequestFields(wireModel, prepared.effort),
        )
      : prepared.additionalModelRequestFields;
    const thinkingRequestFields = buildThinkingRequestFields(
      wireModel,
      options.body.thinking?.enabled === true,
      options.body.thinking?.display,
    );
    if (thinkingRequestFields !== undefined) {
      additionalModelRequestFields = mergeModelRequestFields(
        additionalModelRequestFields,
        thinkingRequestFields,
      );
    }
    const commandInput: unknown = {
      conversationState: prepared.conversationState,
      ...(prepared.profileArn ? { profileArn: prepared.profileArn } : {}),
      ...(additionalModelRequestFields ? { additionalModelRequestFields } : {}),
    };
    if (!isSdkCommandInput(commandInput)) {
      throw new TypeError("Transformed request is not a valid SDK command input");
    }
    const command = new GenerateAssistantResponseCommand(commandInput);
    if (prepared.runtimeProtocol === "kiro-runtime") {
      attachKiroRuntimeRequest(command, {
        ...(prepared.systemPrompt !== undefined ? { systemPrompt: prepared.systemPrompt } : {}),
      });
    }
    // Each attempt owns an AbortController so the upstream socket can be
    // destroyed on idle timeout, consumer cancel, or a failed collection
    // even though the ingress signal itself never fires (A1).
    const attempt = new AbortController();
    const abortUpstream = (reason?: unknown): void => {
      if (!attempt.signal.aborted) attempt.abort(reason);
    };
    state.sdkDispatches = plannedAttempt;
    options.diagnostics?.addSecrets([
      account.id,
      account.email,
      account.accessToken,
      account.refreshToken,
      auth.access,
      auth.refresh,
      auth.clientSecret,
      auth.profileArn,
    ]);
    options.diagnostics?.dispatch(plannedAttempt);
    auditLog("info", "sdk_dispatch_started", {
      request_id: options.requestId,
      attempt: plannedAttempt,
      model: options.model,
      effective_model: prepared.effectiveModel,
      effort: prepared.effort,
      account_hash: accountHash,
      conversation_hash: conversationHash,
      mode: options.stream ? "stream" : "non-stream",
      upstream_operation:
        prepared.runtimeProtocol === "kiro-runtime" ? "kiro-runtime" : "codewhisperer",
    });
    upstreamStarted = true;
    const sendOptions = {
      abortSignal: AbortSignal.any([signal, attempt.signal]),
      onResponseHeaders: (metadata: import("./upstream-acceptance.js").UpstreamHeaders): void => {
        options.diagnostics?.headers(metadata.status, metadata.headers);
      },
    };
    let sdkResponse: SdkStreamResponse;
    try {
      sdkResponse = await abortable(
        options.stream
          ? sendAcceptedStream(client, command, sendOptions)
          : client.send(command, sendOptions),
        signal,
      );
    } catch (error) {
      abortUpstream(error);
      throw error;
    }
    options.diagnostics?.accepted();
    const captureOptions = reasoningCaptureOptions(options, account.id, prepared.conversationId, {
      region: prepared.region,
      ...(prepared.profileArn !== undefined ? { profileArn: prepared.profileArn } : {}),
      runtimeProtocol: prepared.runtimeProtocol,
      ...(prepared.diagnostics.projection.legacyPrefixMessages !== undefined
        ? { legacyPrefixMessages: prepared.diagnostics.projection.legacyPrefixMessages }
        : {}),
    });
    const attemptContext: AttemptStreamContext = {
      options,
      signal,
      state,
      account,
      conversationId: prepared.conversationId,
      sdkResponse,
      captureOptions,
      abortUpstream,
      sdkAttempt: plannedAttempt,
      effort: prepared.effort,
      accountHash,
      inputTokenEstimate: () => estimateSdkInputTokens(prepared),
      contextUsageWindow: options.modelCapabilities?.contextUsageWindow?.(
        account.id,
        options.model,
      ),
    };
    state.streamAttempts += 1;
    return options.stream
      ? await runStreamAttempt(attemptContext, releaseAccount)
      : await runCollectAttempt(attemptContext);
  } catch (caught) {
    if (!signal.aborted) options.diagnostics?.failure(caught);
    return { kind: "failed", account, caught, upstreamStarted };
  }
}

interface AttemptStreamContext {
  readonly inputTokenEstimate: () => number;
  readonly contextUsageWindow: number | undefined;
  readonly options: RunChatCompletionOptions;
  readonly signal: AbortSignal;
  readonly state: LoopState;
  readonly account: ManagedAccount;
  readonly conversationId: string;
  readonly sdkResponse: SdkStreamResponse;
  readonly captureOptions: ReturnType<typeof reasoningCaptureOptions>;
  readonly abortUpstream: (reason?: unknown) => void;
  readonly sdkAttempt: number;
  readonly effort: ReturnType<typeof transformToSdkRequest>["effort"];
  readonly accountHash: string;
}

/**
 * Typed stream failures with an unknown code are protocol faults; anything
 * else that escapes the transformer (SDK decoder, socket) is a stream error.
 */
function classifyStreamFailure(caught: unknown): StreamFailure {
  return normalizeStreamFailure(
    caught,
    isStreamFailureError(caught) ? "upstream_protocol_error" : "upstream_stream_error",
  );
}

/** Terminal 502 for a stream failure; typed errors keep their message, others the contract text. */
function streamFailureResult(caught: unknown, failure: StreamFailure): CompletionResult {
  const message = isStreamFailureError(caught) ? caught.message : failure.message;
  return { kind: "response", response: terminalError(502, message, failure.code) };
}

/** Rate-limit backoff: exponential on the base delay with up to 25% jitter. */
function streamRetryDelayMs(baseMs: number, failedAttempts: number): number {
  const exponential = baseMs * 2 ** Math.max(0, failedAttempts - 1);
  return Math.round(exponential * (1 + Math.random() * 0.25));
}

function toStreamError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new TypeError("SDK stream failed with a non-Error reason", { cause: error });
}

/**
 * One canonical event with the stream idle timeout and the ingress signal
 * applied. Rejects with StreamIdleTimeoutError or the abort reason; the
 * underlying iterator promise is left to settle on its own after teardown.
 */
function nextWithIdleTimeout(
  iterator: AsyncGenerator<CanonicalOutputEvent>,
  signal: AbortSignal,
  idleTimeoutMs: number,
  telemetry: StreamTelemetry,
): Promise<IteratorResult<CanonicalOutputEvent>> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      stopIdleWatch();
      telemetry.onUpstreamReadSettled();
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(abortReason(signal));
    };
    const stopIdleWatch = telemetry.watchIdle(idleTimeoutMs, () => {
      cleanup();
      reject(new StreamIdleTimeoutError(idleTimeoutMs));
    });
    signal.addEventListener("abort", onAbort, { once: true });
    iterator.next().then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

type PrefetchOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "failed"; readonly error: Error };

/**
 * Prime only the local lifecycle after the SDK accepted the upstream request.
 * A tool's complete arguments are not a prerequisite for publishing headers.
 * Once this stream is handed off, subsequent failures cannot replay generation.
 */
async function prefetchStreamStart(
  prepared: PreparedCanonicalStream,
  signal: AbortSignal,
  idleTimeoutMs: number,
  abortUpstream: (reason?: unknown) => void,
): Promise<PrefetchOutcome> {
  const { iterator, telemetry, prefetched } = prepared;
  const externalAbort = async (): Promise<never> => {
    const reason = abortReason(signal);
    telemetry.emitTerminal("external_abort");
    await abandonPreparedStream(prepared, abortUpstream, reason);
    throw reason;
  };
  const fail = async (error: Error): Promise<PrefetchOutcome> => {
    const idle = error instanceof StreamIdleTimeoutError;
    auditLog("warn", idle ? "sdk_stream_idle_timeout" : "sdk_stream_upstream_error", {
      ...telemetry.auditFields(),
      ...(idle ? telemetry.stallFields() : {}),
      ...streamErrorAuditFields(error),
      ...(idle ? { idle_timeout_ms: idleTimeoutMs } : {}),
      phase: "prefetch",
    });
    telemetry.emitTerminal(idle ? "idle_timeout" : "upstream_error");
    await abandonPreparedStream(prepared, abortUpstream, error);
    return { kind: "failed", error };
  };
  while (true) {
    let next: IteratorResult<CanonicalOutputEvent>;
    try {
      next = await nextWithIdleTimeout(iterator, signal, idleTimeoutMs, telemetry);
    } catch (error) {
      if (signal.aborted) return externalAbort();
      return fail(toStreamError(error));
    }
    if (next.done) {
      // The transformer only ends early when its signal aborted.
      if (signal.aborted) return externalAbort();
      return fail(new SemanticStreamTruncationError());
    }
    telemetry.observeCanonicalEvent(next.value);
    prefetched.push(next.value);
    if (next.value.type === "started") return { kind: "accepted" };
    return fail(
      new SdkStreamProtocolError("Canonical stream omitted its start", "upstream_protocol_error"),
    );
  }
}

/**
 * B-empty: a witnessed completion with no reasoning, text, or tool call gets
 * one same-account replacement attempt when the knob allows and the attempt
 * budget has room. No health or rate-limit state changes.
 */
function shouldRetryEmptyCompletion(
  options: RunChatCompletionOptions,
  state: LoopState,
  telemetry: StreamTelemetry,
): boolean {
  return (
    options.config.retry_empty_completion &&
    !state.emptyCompletionRetried &&
    state.streamAttempts < options.config.stream_max_attempts &&
    hasRemainingUpstreamDispatchBudget(options, state) &&
    telemetry.isEmptyCompletion()
  );
}

function recordEmptyCompletionRetry(
  context: AttemptStreamContext,
  telemetry: StreamTelemetry,
): AttemptOutcome {
  const { options, state, account } = context;
  state.emptyCompletionRetried = true;
  auditLog("warn", "sdk_stream_empty_completion_retry", {
    ...telemetry.auditFields(),
    attempt: state.streamAttempts,
    max_attempts: options.config.stream_max_attempts,
    account_hash: auditHash(account.id),
  });
  return { kind: "empty-completion", account };
}

/**
 * Keeps the short-term stall streak for this request's binding key in step with
 * how the published stream actually ended.
 *
 * Only published streams count. A pre-publication failure already gets an
 * in-request replacement attempt and nothing reached the client, so counting it
 * would arm the failover for a fault the pipeline healed on its own.
 * A client-driven cancel says nothing about upstream health and is ignored. This
 * request's own deadline is different: when it fires on an upstream that had
 * already gone quiet, it is the same wedged-conversation signature the idle
 * watchdog reports, and it is the only terminal available whenever the deadline
 * is the shorter of the two. A deadline that lands while frames are still
 * flowing is a long stream, not a stalled one.
 *
 * Stall *recording* stays out of the non-stream lane: `runCollectAttempt` emits
 * its terminal before deciding whether to retry, so the same `upstream_error`
 * covers both a healed attempt and a committed 500 and cannot be counted
 * honestly. Its successes still clear the streak, through `clearAffinityStall`.
 *
 * A terminal the provider caused itself counts as health, not as a stall:
 * `localPersistence` marks a stream that ended because storing reasoning or the
 * lineage row failed, which happens only after a witnessed upstream answer, so
 * it retires the streak the same way a completion does.
 */
/**
 * Retires the streak on health evidence `recordAffinityTerminal` cannot see: a
 * non-stream completion that is actually being returned to the client.
 *
 * The quarantine applies to both lanes, so without this a key that reached the
 * threshold would keep re-quarantining every non-stream request — minting a new
 * conversation each time — until the window elapsed, even though the account it
 * moved to answers fine.
 *
 * A healthy answer only retires the streak when storage agrees: see
 * `LoopState.lineageStallRow`.
 */
function clearAffinityStall(
  options: RunChatCompletionOptions,
  state: LoopState,
  accountId: string,
  conversationId: string,
): void {
  const key = affinityStallKey(options);
  if (options.config.session_affinity_stall_failover_threshold <= 0 || key === undefined) return;
  const row = state.lineageStallRow;
  // Anything other than the row's own cell answering leaves the row unproven.
  if (row !== undefined && (row.accountId !== accountId || row.conversationId !== conversationId))
    return;
  (options.affinityStalls ?? affinityStallTracker).clear(key.keyHash);
}

function recordAffinityTerminal(
  options: RunChatCompletionOptions,
  state: LoopState,
  accountId: string,
  conversationId: string,
  report: StreamTerminalReport,
): void {
  const key = affinityStallKey(options);
  if (options.config.session_affinity_stall_failover_threshold <= 0 || key === undefined) return;
  // A provider-local write failing says nothing about the account: the capture
  // only runs after a witnessed, fully validated upstream answer, and no other
  // account can repair a local keyring or database fault. So this terminal is
  // treated as the completion it really is — counting it would quarantine a
  // healthy cell, and merely skipping the count would leave an already-armed
  // streak in place, re-binding every following request for a fault failover
  // cannot fix.
  if (report.localPersistence) {
    clearAffinityStall(options, state, accountId, conversationId);
    return;
  }
  const tracker = options.affinityStalls ?? affinityStallTracker;
  const keyHash = key.keyHash;
  const provenance = report.provenance;
  if (provenance === "normal_complete") {
    clearAffinityStall(options, state, accountId, conversationId);
    return;
  }
  if (provenance === "external_abort") {
    if (!report.requestDeadline || !report.upstreamQuiet) return;
  } else if (provenance !== "idle_timeout" && provenance !== "upstream_error") return;
  const stall = tracker.record(
    keyHash,
    Date.now(),
    options.config.session_affinity_stall_window_ms,
    options.config.session_affinity_max_entries,
    accountId,
  );
  auditLog("warn", "session_affinity_stall_recorded", {
    request_id: options.requestId,
    protocol: options.body.protocol,
    model: options.model,
    affinity_source: key.source,
    affinity_hash: auditHash(keyHash),
    terminal_provenance: provenance,
    stall_count: stall.count,
    stall_span_ms: Math.max(0, stall.lastAt - stall.firstAt),
    stall_window_ms: options.config.session_affinity_stall_window_ms,
    stall_threshold: options.config.session_affinity_stall_failover_threshold,
    failover_armed: stall.count >= options.config.session_affinity_stall_failover_threshold,
  });
}

/** An error's class name or `code` when it is a plain identifier; never its message. */
function safeErrorIdentifier(
  value: unknown,
  diagnostics: RunChatCompletionOptions["diagnostics"],
): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)) return undefined;
  return diagnostics ? diagnostics.identifier(value) : value;
}

/**
 * Stores the binding of a migrated portable replay once the upstream accepted
 * the attempt: the first semantic stream event, or a completed non-stream
 * collection. Acceptance is the only proof that the migrated signed history is
 * usable on its new account; committing at bind time left the stored row
 * naming a cell Kiro had just rejected, so every client retry on that thread
 * repeated the same rejection.
 *
 * The overwrite deliberately also replaces a quarantined row: the migrated
 * account just proved itself, so the replacement is the row later attempts of
 * this request extend.
 *
 * The write runs after `upstreamStarted`, so it must not throw: an exception
 * here would be classified as an upstream failure, echo the storage error text
 * to the client, and in the stream lane orphan an accepted upstream stream
 * that nothing abandons before the lease is released. A provider-local write
 * failing says nothing about the answer Kiro already accepted (the same stance
 * `recordAffinityTerminal` takes for `localPersistence`), so the answer is
 * served, the stored row keeps naming the origin, and the failure is audited
 * with identifiers only. The next request re-resolves the origin binding and
 * migrates afresh if it still has to.
 */
function commitPendingMigration(context: AttemptStreamContext): void {
  const { options, state, account, conversationId } = context;
  const pending = state.pendingMigration;
  if (pending === undefined) return;
  state.pendingMigration = undefined;
  const fields = {
    request_id: options.requestId,
    protocol: options.body.protocol,
    model: options.model,
    from_account_hash: auditHash(pending.fromAccountId),
    to_account_hash: auditHash(account.id),
    conversation_hash: auditHash(conversationId),
    replay_count: pending.replayCount,
  };
  if (options.affinity && options.affinityStore) {
    let committed: PipelineAffinityBinding;
    try {
      committed = options.affinityStore.rebindSessionAffinity(
        options.affinity.keyHash,
        account.id,
        conversationId,
        Date.now(),
        options.config.session_affinity_ttl_ms,
        options.config.session_affinity_max_entries,
      );
    } catch (error) {
      auditLog("warn", "reasoning_replay_migration_commit_failed", {
        ...fields,
        error_type:
          safeErrorIdentifier(
            error instanceof Error ? error.name : undefined,
            options.diagnostics,
          ) ?? (error instanceof Error ? "Error" : typeof error),
        error_code: safeErrorIdentifier(
          error !== null && typeof error === "object" && "code" in error ? error.code : undefined,
          options.diagnostics,
        ),
      });
      return;
    }
    state.binding = committed;
    state.affinityQuarantined = false;
  }
  auditLog("info", "reasoning_replay_migration_committed", fields);
}

/**
 * Stream attempt: upstream acceptance commits the streaming boundary.
 */
async function runStreamAttempt(
  context: AttemptStreamContext,
  releaseAccount: () => void,
): Promise<AttemptOutcome> {
  const { options, signal, account, conversationId, sdkResponse, captureOptions } = context;
  const streamResult = {
    kind: "stream" as const,
    sdkResponse,
    maxToolArgumentsBytes: options.config.max_request_body_bytes,
    validateToolArguments: options.validateToolArguments,
    model: options.model,
    conversationId,
    inputTokenEstimate: context.inputTokenEstimate,
    contextUsageWindow: context.contextUsageWindow,
    telemetryContext: {
      requestId: options.requestId,
      attempt: context.sdkAttempt,
      effort: context.effort,
      accountHash: context.accountHash,
      diagnostics: options.diagnostics,
    },
    ...captureOptions,
    releaseAccount,
    abortUpstream: context.abortUpstream,
    onTerminal: (report: StreamTerminalReport) =>
      recordAffinityTerminal(options, context.state, account.id, conversationId, report),
  };
  const prepared = prepareCanonicalStream(streamResult, signal);
  const prefetch = await prefetchStreamStart(
    prepared,
    signal,
    options.config.stream_idle_timeout_ms,
    context.abortUpstream,
  );
  if (prefetch.kind === "failed") {
    if (captureOptions.prefetchFableReasoning) {
      return {
        kind: "result",
        leaseTransferred: false,
        result: streamFailureResult(prefetch.error, classifyStreamFailure(prefetch.error)),
      };
    }
    return {
      kind: "stream-failed",
      account,
      caught: prefetch.error,
      failure: classifyStreamFailure(prefetch.error),
    };
  }
  // The first semantic event is on hand: Kiro accepted this history here.
  commitPendingMigration(context);
  return { kind: "result", leaseTransferred: true, result: { ...streamResult, prepared } };
}

/**
 * Non-stream attempt: collect the whole canonical stream. Nothing is
 * published until the end, so a failure before the first semantic event takes
 * the same pre-publication retry as the stream path; later failures keep the
 * disposition-based routing in applyClassification.
 */
async function runCollectAttempt(context: AttemptStreamContext): Promise<AttemptOutcome> {
  const { options, signal, state, account, conversationId, sdkResponse, captureOptions } = context;
  const telemetry = createStreamTelemetry(options.model, conversationId, "non-stream", {
    diagnostics: options.diagnostics,
    requestId: options.requestId,
    attempt: context.sdkAttempt,
    effort: context.effort,
    accountHash: context.accountHash,
  });
  let completion: Awaited<ReturnType<typeof collectSdkResponse>>;
  let upstreamCleanup = Promise.resolve();
  const collectAbort = new AbortController();
  const collectSignal = AbortSignal.any([signal, collectAbort.signal]);
  const stopIdleWatch = captureOptions.prefetchFableReasoning
    ? telemetry.watchIdle(options.config.stream_idle_timeout_ms, () => {
        const error = new StreamIdleTimeoutError(options.config.stream_idle_timeout_ms);
        collectAbort.abort(error);
        context.abortUpstream(error);
      })
    : undefined;
  try {
    completion = await collectSdkResponse(
      sdkResponse,
      options.model,
      conversationId,
      collectSignal,
      {
        ...captureOptions,
        inputTokenEstimate: context.inputTokenEstimate,
        contextUsageWindow: context.contextUsageWindow,
        maxToolArgumentsBytes: options.config.max_request_body_bytes,
        textLimit: options.collectedTextLimit,
        validateToolArguments: options.validateToolArguments,
        diagnostics: options.diagnostics,
        onCompletionWitness: (kind) => telemetry.onCompletionWitness(kind),
        onRawEvent: (eventTypes) => telemetry.onRawEvent(eventTypes),
        onToolCallProgress: (progress) => telemetry.onToolCallProgress(progress),
        onCanonicalEvent: (event) => telemetry.observeCanonicalEvent(event),
        onIteratorCleanup: (cleanup) => {
          upstreamCleanup = cleanup;
        },
      },
    );
  } catch (collectError) {
    const aborted = signal.aborted;
    const idle = collectError instanceof StreamIdleTimeoutError;
    if (!aborted) {
      auditLog("warn", idle ? "sdk_stream_idle_timeout" : "sdk_stream_upstream_error", {
        ...telemetry.auditFields(),
        ...streamErrorAuditFields(collectError, options.diagnostics),
        error_name: options.diagnostics?.identifier(
          collectError instanceof Error ? collectError.name : typeof collectError,
        ),
      });
    }
    telemetry.emitTerminal(aborted ? "external_abort" : idle ? "idle_timeout" : "upstream_error");
    context.abortUpstream(collectError);
    await boundedCleanup(() => upstreamCleanup);
    if (aborted) throw abortReason(signal);
    if (captureOptions.prefetchFableReasoning) {
      return {
        kind: "result",
        leaseTransferred: false,
        result: streamFailureResult(collectError, classifyStreamFailure(collectError)),
      };
    }
    if (!telemetry.collectorSemanticSeen) {
      return {
        kind: "stream-failed",
        account,
        caught: collectError,
        failure: classifyStreamFailure(collectError),
      };
    }
    throw collectError;
  } finally {
    stopIdleWatch?.();
    telemetry.onUpstreamReadSettled();
  }
  await boundedCleanup(() => upstreamCleanup);
  if (signal.aborted) {
    telemetry.emitTerminal("external_abort");
    throw abortReason(signal);
  }
  auditLog("info", "sdk_stream_completed", telemetry.auditFields());
  telemetry.emitTerminal("normal_complete");
  // Kiro accepted and completed this history here; an empty-completion
  // replacement below stays on the same, now committed, cell.
  commitPendingMigration(context);
  if (
    captureOptions.reasoningReplayDecision.mode === undefined &&
    shouldRetryEmptyCompletion(options, state, telemetry)
  ) {
    return recordEmptyCompletionRetry(context, telemetry);
  }
  // This completion is the answer, so the cell that served it is demonstrably
  // healthy.
  clearAffinityStall(options, state, account.id, conversationId);
  return {
    kind: "result",
    leaseTransferred: false,
    result: {
      kind: "response",
      response: Response.json(completion, {
        headers: {
          "Content-Type": CANONICAL_OUTPUT_JSON_CONTENT_TYPE,
          ...(captureOptions.reasoningReplayDecision.mode === "conflict-omitted"
            ? { "x-kiro-reasoning-replay-mode": "conflict-omitted" }
            : {}),
        },
      }),
    },
  };
}

/**
 * Phase 5a: pre-publication stream failure. Fatal dispositions and an
 * exhausted stream_max_attempts budget terminate with the failure code. A
 * retryable failure is first retried on the same account; when that account
 * fails again and another selectable account exists it is excluded for this
 * request so normal selection switches (the lease is released by the loop).
 */
async function applyStreamFailure(
  options: RunChatCompletionOptions,
  signal: AbortSignal,
  state: LoopState,
  selection: AttemptSelection,
  outcome: Extract<AttemptOutcome, { kind: "stream-failed" }>,
): Promise<LoopDirective> {
  const { account, caught, failure } = outcome;
  if (signal.aborted) throw abortReason(signal);
  options.diagnostics?.failure(caught, "upstream_stream");
  state.lastStreamFailure = failure;
  const terminal = returning(streamFailureResult(caught, failure));
  if (failure.disposition === "fatal") return terminal;
  if (!hasRemainingUpstreamDispatchBudget(options, state)) {
    reportUpstreamDispatchBudgetExhausted(options, state, "stream-failed");
    return terminal;
  }
  const maxAttempts = options.config.stream_max_attempts;
  if (state.streamAttempts >= maxAttempts) {
    auditLog("warn", "sdk_stream_attempts_exhausted", {
      attempt: state.streamAttempts,
      max_attempts: maxAttempts,
      error_code: failure.code,
      account_hash: auditHash(account.id),
      mode: options.stream ? "stream" : "non-stream",
    });
    return terminal;
  }
  const alternativeIds = new Set(selection.eligibleAccountIds);
  alternativeIds.delete(account.id);
  const alternatives = state.replayLocked
    ? 0
    : countSelectableAlternatives(options, selection.accounts, alternativeIds);
  const sameAccount = !state.streamRetriedAccountIds.has(account.id) || alternatives === 0;
  state.streamRetriedAccountIds.add(account.id);
  if (!sameAccount) {
    state.requestExcludedAccountIds.add(account.id);
    forgetPreferredAccount(state);
  }
  auditLog("warn", "sdk_stream_attempt_retry", {
    attempt: state.streamAttempts,
    max_attempts: maxAttempts,
    error_code: failure.code,
    same_account: sameAccount,
    account_hash: auditHash(account.id),
    mode: options.stream ? "stream" : "non-stream",
  });
  options.diagnostics?.phase("retry_backoff");
  await abortableSleep(
    streamRetryDelayMs(options.config.rate_limit_retry_delay_ms, state.streamAttempts),
    signal,
  );
  return CONTINUE;
}

type MigrationFallbackBlockedReason =
  | "fallback_spent"
  | "origin_missing"
  | "origin_unselectable"
  | "origin_ineligible"
  | "origin_quarantined"
  | "dispatch_budget";

/**
 * Why the request cannot return to its origin after a rejected migration, or
 * undefined when it can. Selectability (quota, health, rate limit) is judged
 * before the selection's eligibility set, because that set already excludes
 * quota-exhausted accounts and would otherwise report an exhausted origin as
 * model-ineligible.
 */
function migrationFallbackBlockedReason(
  options: RunChatCompletionOptions,
  state: LoopState,
  selection: AttemptSelection,
  originAccountId: string,
): MigrationFallbackBlockedReason | undefined {
  if (state.migrationFallbackSpent) return "fallback_spent";
  const origin = selection.accounts.find((account) => account.id === originAccountId);
  if (origin === undefined) return "origin_missing";
  if (!isSelectableAccount(origin, Date.now(), overagePolicy(options))) {
    return "origin_unselectable";
  }
  if (
    !selection.eligibleAccountIds.has(originAccountId) ||
    state.requestExcludedAccountIds.has(originAccountId) ||
    state.modelRejectedAccountIds.has(originAccountId)
  ) {
    return "origin_ineligible";
  }
  if (state.quarantinedAccountIds.has(originAccountId)) return "origin_quarantined";
  if (!hasRemainingUpstreamDispatchBudget(options, state)) return "dispatch_budget";
  return undefined;
}

/**
 * Kiro rejected the migrated attempt at its headers, so nothing was published
 * and the stored binding still names the origin. The safest continuation is
 * one bounded return to that origin with its original conversation; when the
 * origin cannot serve, the request ends with a typed rejection instead of a
 * third projection of the same history onto yet another account.
 *
 * The fallback attempt reuses the ordinary bind path: `selected` equals the
 * stored binding's account, so the claim extends that binding and the origin
 * conversation goes on the wire. Whatever fails afterwards takes normal
 * classification; `pendingMigration` is already cleared, so there is never a
 * second fallback.
 */
function rejectMigration(
  options: RunChatCompletionOptions,
  state: LoopState,
  selection: AttemptSelection,
  pending: PendingMigration,
  error: NormalizedSdkError,
): LoopDirective {
  state.pendingMigration = undefined;
  const terminal: CompletionResult = {
    kind: "response",
    response: terminalError(
      400,
      "Kiro rejected the request after its signed reasoning history was migrated to another account, and the original account is unavailable",
      "reasoning_replay_migration_rejected",
    ),
  };
  const blocked = migrationFallbackBlockedReason(options, state, selection, pending.fromAccountId);
  auditLog("warn", "reasoning_replay_migration_rejected", {
    request_id: options.requestId,
    protocol: options.body.protocol,
    model: options.model,
    from_account_hash: auditHash(pending.fromAccountId),
    to_account_hash: auditHash(pending.toAccountId),
    replay_count: pending.replayCount,
    upstream_status: error.status,
    upstream_code: error.reason,
    fallback: blocked === undefined ? "origin" : "none",
    fallback_blocked_reason: blocked,
  });
  if (blocked !== undefined) return returning(terminal);
  state.migrationFallbackSpent = true;
  state.migrationFallback = {
    accountId: pending.fromAccountId,
    ...(pending.fromConversationId !== undefined
      ? { conversationId: pending.fromConversationId }
      : {}),
    terminal,
  };
  state.preferredAccountId = pending.fromAccountId;
  state.requestAccountId = pending.fromAccountId;
  state.requestConversationId = pending.fromConversationId;
  return CONTINUE;
}

/**
 * Phase 5: turn an attempt failure into the next loop step. Rethrows request
 * faults and aborts, retries or switches accounts for upstream faults, and
 * produces the terminal response otherwise.
 */
async function applyClassification(
  options: RunChatCompletionOptions,
  signal: AbortSignal,
  state: LoopState,
  selection: AttemptSelection,
  failure: Extract<AttemptOutcome, { kind: "failed" }>,
): Promise<LoopDirective> {
  const { account, caught, upstreamStarted } = failure;
  if (signal.aborted) throw abortReason(signal);
  if (!upstreamStarted) {
    if (caught instanceof RequestTransformError || caught instanceof ReasoningReplayError) {
      throw caught;
    }
    if (isRefreshFailure(caught)) {
      return continueAfterRefreshFailure(options, signal, state, account, caught);
    }
    if (state.replayLocked) return returning(replayUnavailable());
    throw caught;
  }
  if (isStreamFailureError(caught)) {
    // Nothing has been sent to the client on the non-stream path, so a
    // retryable stream failure gets the same bounded retry as truncation;
    // fatal ones (and exhausted retries) terminate as 502 consistently.
    const streamFailure = normalizeStreamFailure(caught, "upstream_protocol_error");
    if (
      streamFailure.disposition === "retryable" &&
      hasRemainingUpstreamDispatchBudget(options, state) &&
      state.retryCount < options.config.rate_limit_max_retries
    ) {
      state.retryCount += 1;
      auditLog("warn", "non_stream_failure_retry", {
        account_hash: auditHash(account.id),
        error_code: streamFailure.code,
        retry_count: state.retryCount,
      });
      options.diagnostics?.phase("retry_backoff");
      await abortableSleep(
        options.config.rate_limit_retry_delay_ms * 2 ** (state.retryCount - 1),
        signal,
      );
      return CONTINUE;
    }
    if (
      streamFailure.disposition === "retryable" &&
      !hasRemainingUpstreamDispatchBudget(options, state)
    ) {
      reportUpstreamDispatchBudgetExhausted(options, state, "non-stream-failed");
    }
    return returning({
      kind: "response",
      response: terminalError(502, caught.message, caught.code),
    });
  }
  const error = normalizeSdkError(caught);
  const retryableServerStatus = isRetryableServerStatus(error.status);
  const serverErrorCount = retryableServerStatus
    ? (state.serverErrors.get(account.id) ?? 0) + 1
    : 0;
  if (retryableServerStatus) state.serverErrors.set(account.id, serverErrorCount);
  const classification = classifyError(error, {
    accountId: account.id,
    accountCount: Math.max(
      1,
      countSelectableAlternatives(options, selection.accounts, selection.eligibleAccountIds),
    ),
    retryCount: state.retryCount,
    maxRetries: options.config.rate_limit_max_retries,
    serverErrorCount,
    retryDelayMs: options.config.rate_limit_retry_delay_ms,
    forcedRefreshAccountIds: state.forcedRefreshAccountIds,
  });

  switch (classification.action) {
    case "refresh-then-retry":
      if (!hasRemainingUpstreamDispatchBudget(options, state)) {
        reportUpstreamDispatchBudgetExhausted(options, state, "refresh-then-retry");
        return returning({
          kind: "response",
          response: terminalError(classification.status, error.message, error.code),
        });
      }
      // Record the forced refresh before attempting it: the classifier reads
      // this set and turns the next credential rejection on the same account
      // into a switch or terminal failure, so this path runs once per account.
      state.forcedRefreshAccountIds.add(classification.forcedRefreshAccountId);
      try {
        options.diagnostics?.phase("token_refresh");
        await abortable(options.tokenRefresher.forceRefresh(account, signal), signal);
      } catch (refreshError) {
        if (signal.aborted) throw abortReason(signal);
        if (!isRefreshFailure(refreshError)) throw refreshError;
        return continueAfterRefreshFailure(options, signal, state, account, refreshError, "forced");
      }
      return CONTINUE;
    case "retry":
      if (!hasRemainingUpstreamDispatchBudget(options, state)) {
        reportUpstreamDispatchBudgetExhausted(options, state, "retry");
        return returning({
          kind: "response",
          response: terminalError(classification.status ?? 502, error.message, error.code),
        });
      }
      state.retryCount += 1;
      options.diagnostics?.phase("retry_backoff");
      await abortableSleep(classification.retryAfterMs ?? 0, signal);
      return CONTINUE;
    case "switch": {
      const authenticationRejected =
        error.status === 401 || (error.status === 403 && isAccessTokenError(error.message));
      if (authenticationRejected) {
        state.lastAuthenticationFailure = error;
      }
      if (isQuotaExhaustionClassification(classification)) state.lastQuotaFailure = error;
      if (authenticationRejected && state.replayLocked) {
        options.accountManager.markUnhealthy(account, toDeadReason(error.message));
      } else if (error.reason === "TEMPORARILY_SUSPENDED") {
        options.accountManager.markUnhealthy(
          account,
          `InvalidTokenException: Account Suspended: ${error.message}`,
        );
      } else if (isQuotaExhaustionClassification(classification)) {
        persistQuotaExhaustion(options, account);
      } else {
        options.accountManager.markRateLimited(
          account,
          Date.now() + (classification.retryAfterMs ?? options.config.rate_limit_retry_delay_ms),
        );
      }
      if (!hasRemainingUpstreamDispatchBudget(options, state)) {
        reportUpstreamDispatchBudgetExhausted(options, state, "switch");
        return returning({
          kind: "response",
          response: terminalError(
            classification.status ?? 502,
            error.message,
            classification.code ?? error.code,
          ),
        });
      }
      if (state.replayLocked) {
        if (error.status === 429) {
          state.retryCount += 1;
          if (state.retryCount >= options.config.rate_limit_max_retries) {
            const retryAfterMs =
              classification.retryAfterMs ?? options.config.rate_limit_retry_delay_ms;
            return returning(
              replayAccountError(
                429,
                "The account bound to signed reasoning replay remains rate-limited",
                "reasoning_replay_account_rate_limited",
                retryAfterMs,
              ),
            );
          }
        }
        return CONTINUE;
      }
      state.requestExcludedAccountIds.add(account.id);
      forgetPreferredAccount(state);
      return CONTINUE;
    }
    case "fail": {
      const pending = state.pendingMigration;
      if (
        pending !== undefined &&
        pending.toAccountId === account.id &&
        isMigrationRejection(error)
      ) {
        return rejectMigration(options, state, selection, pending, error);
      }
      if (isInvalidReasoningSignature(error)) {
        return returning({
          kind: "response",
          response: openAiError(
            400,
            error.message,
            "invalid_request_error",
            "invalid_reasoning_signature",
          ),
        });
      }
      if (isQuotaExhaustionClassification(classification)) {
        persistQuotaExhaustion(options, account);
      }
      if (error.reason === "TEMPORARILY_SUSPENDED") {
        options.accountManager.markUnhealthy(
          account,
          `InvalidTokenException: Account Suspended: ${error.message}`,
        );
      }
      return returning({
        kind: "response",
        response: terminalError(
          classification.terminalStatus ?? classification.status ?? 500,
          error.message,
          classification.code ?? error.code,
        ),
      });
    }
  }
}

/**
 * Orchestrates one request: resolve bindings, then repeat select -> bind ->
 * attempt -> classify until a terminal result, a stream hand-off, or an abort.
 */
async function executeLoop(
  options: RunChatCompletionOptions,
  signal: AbortSignal,
): Promise<CompletionResult> {
  const state = resolveBinding(options);
  await scheduleQuotaRecheck(options, signal, state);

  while (true) {
    if (signal.aborted) throw abortReason(signal);
    state.iterations += 1;
    if (state.iterations > options.config.max_request_iterations) {
      return iterationsExhaustedResult(options, state);
    }

    const acquireCapacity = () =>
      reserveAccountCapacity<ReadySelectionOutcome>(
        () => {
          const selectionStarted = performance.now();
          const outcome = selectAttemptAccount(options, state);
          auditLog("info", "account_selection_completed", {
            request_id: options.requestId,
            duration_ms: Math.max(0, Math.round(performance.now() - selectionStarted)),
            outcome: outcome.kind,
            replay_locked: state.replayLocked,
          });
          return outcome.kind === "capacity-wait"
            ? { kind: "wait", accountIds: outcome.accountIds }
            : {
                kind: "ready",
                value: outcome,
                ...(outcome.kind === "selected"
                  ? { accountId: outcome.selection.selected.id }
                  : {}),
              };
        },
        signal,
        options.config.account_inference_concurrency,
      );
    const reservation = await (options.diagnostics?.waitForQueue(
      "capacity",
      acquireCapacity,
      (value) => value.lease !== undefined,
    ) ?? acquireCapacity());
    const selectionOutcome = reservation.value;
    if (selectionOutcome.kind === "result") return selectionOutcome.result;
    if (selectionOutcome.kind === "wait") {
      await abortableSleep(selectionOutcome.waitMs + 1, signal);
      continue;
    }
    const { selection } = selectionOutcome;
    const lease = reservation.lease;
    if (!lease) throw new TypeError("Selected account has no capacity reservation");
    const acquire = () => lease;
    const releaseAccount = await (options.diagnostics?.waitForQueue("account", acquire) ??
      acquire());
    let accountLeaseOwned = true;
    try {
      if (signal.aborted) throw abortReason(signal);
      if (bindAttemptAffinity(options, state, selection.selected) === "reselect") continue;
      const outcome = await runAttempt(options, signal, state, selection.selected, releaseAccount);
      if (outcome.kind === "result") {
        accountLeaseOwned = !outcome.leaseTransferred;
        return outcome.result;
      }
      if (outcome.kind === "model-unavailable") {
        if (state.replayLocked) {
          return replayAccountError(
            503,
            `Model ${options.model} is unavailable on the account bound to signed reasoning replay`,
            "reasoning_replay_model_unavailable",
          );
        }
        state.modelRejectedAccountIds.add(outcome.account.id);
        forgetPreferredAccount(state);
        continue;
      }
      // The preferred account is unchanged, so selection returns to it.
      if (outcome.kind === "empty-completion") continue;
      const directive =
        outcome.kind === "stream-failed"
          ? await applyStreamFailure(options, signal, state, selection, outcome)
          : await applyClassification(options, signal, state, selection, outcome);
      if (directive.kind === "return") return directive.result;
    } finally {
      if (accountLeaseOwned) releaseAccount();
    }
  }
}

/**
 * Runs one OpenAI chat completion through the serialized Kiro SDK pipeline.
 * The optional deadlineSignal is the single ingress signal passed unchanged to
 * queue waiting, refresh, retry sleeps, SDK send, and response consumption.
 */
export async function runChatCompletion(options: RunChatCompletionOptions): Promise<Response> {
  const requestId = options.requestId ?? newRequestId();
  const diagnostics =
    options.diagnostics ?? new RequestDiagnostics(requestId, options.config.api_keys);
  const tracedOptions: RunChatCompletionOptions = { ...options, requestId, diagnostics };
  const deadline = createPipelineDeadline(
    tracedOptions.deadlineSignal,
    tracedOptions.config.request_timeout_ms,
  );
  let releaseSession: (() => void) | undefined;
  let releaseAccount: (() => void) | undefined;
  let streamOwnsResources = false;
  try {
    const sessionKey = tracedOptions.affinity?.keyHash ?? tracedOptions.lineage?.lookupKeyHash;
    if (sessionKey !== undefined) {
      releaseSession = await diagnostics.waitForQueue("session", () =>
        acquireSessionQueue(sessionKey, deadline.signal),
      );
    }
    diagnostics.phase("request_validation");
    const validateToolArguments = toolOutputValidator(
      options.body.tools.map((tool) => ({
        name: tool.wireName,
        schema: tool.inputSchema,
        path: tool.path,
        publicType: tool.publicType,
      })),
      options.body.toolChoice !== "none",
      options.unexpectedToolCallFailure,
    );
    const result = await executeLoop({ ...tracedOptions, validateToolArguments }, deadline.signal);
    if (result.kind === "response") return await diagnostics.response(result.response);

    releaseAccount = result.releaseAccount;
    const streamAccountRelease = releaseAccount;
    const streamSessionRelease = releaseSession;
    let response: Response;
    try {
      response = (tracedOptions.createStreamResponse ?? createPipelineStreamResponse)(
        result,
        deadline.signal,
        tracedOptions.config.stream_idle_timeout_ms,
        (cleanup) => {
          deadline.dispose();
          const release = (): void => {
            streamAccountRelease();
            streamSessionRelease?.();
            diagnostics.cleanup();
            runCleanupSteps(() => tracedOptions.onCleanup?.());
          };
          if (cleanup) void cleanup.then(release, release);
          else release();
        },
      );
    } catch (constructionError) {
      // The prefetched upstream stream must not outlive a failed hand-off.
      result.prepared.telemetry.emitTerminal("external_abort");
      await abandonPreparedStream(result.prepared, result.abortUpstream, constructionError);
      throw constructionError;
    }
    releaseAccount = undefined;
    releaseSession = undefined;
    streamOwnsResources = true;
    return await diagnostics.response(response);
  } catch (error) {
    if (error instanceof RequestTransformError) {
      auditLog("warn", "request_transform_rejected", {
        request_id: requestId,
        stage: "request_transform",
        protocol: tracedOptions.body.protocol,
        model: tracedOptions.model,
        projection_mode: tracedOptions.body.projectionMode,
        code: error.code,
        param: error.param,
      });
      return openAiError(400, error.message, "invalid_request_error", error.code, error.param);
    }
    if (error instanceof ReasoningReplayError) {
      return openAiError(
        error.retryable ? 503 : 400,
        error.message,
        error.retryable ? "service_unavailable" : "invalid_request_error",
        error.code,
      );
    }
    if (deadline.signal.aborted) {
      diagnostics.cancel(
        deadline.signal.reason instanceof Error && deadline.signal.reason.name === "TimeoutError"
          ? "request_deadline"
          : "external_abort",
      );
      const clientAbort = ["client_disconnect", "consumer_cancel"].includes(
        diagnostics.snapshot().cancel_source ?? "",
      );
      return await diagnostics.response(
        openAiError(
          clientAbort ? 499 : 504,
          clientAbort ? "Client closed request" : "Request deadline exceeded",
          clientAbort ? "request_aborted" : "timeout_error",
          clientAbort ? "client_disconnected" : "request_timeout",
        ),
      );
    }
    const normalized = normalizeSdkError(error);
    if (normalized.status !== undefined) {
      // A status-bearing upstream error that escaped the loop keeps its envelope.
      diagnostics.failure(error);
      return await diagnostics.response(
        openAiError(
          normalized.status >= 400 ? normalized.status : 502,
          normalized.message,
          "upstream_error",
          normalized.code,
        ),
      );
    }
    // B16: never echo arbitrary exception text (paths, ids, SQL) to the client.
    // The correlation id ties the fixed response to the hashed audit record.
    auditLog("error", "pipeline_internal_error", {
      request_id: requestId,
      error_type: diagnostics.identifier(error instanceof Error ? error.name : typeof error),
      error_code: diagnostics.identifier(normalized.code),
      error_message_hash: auditHash(normalized.message),
    });
    return openAiInternalError(requestId);
  } finally {
    if (!streamOwnsResources) {
      releaseAccount?.();
      releaseSession?.();
      deadline.dispose();
      diagnostics.cleanup();
      runCleanupSteps(() => tracedOptions.onCleanup?.());
    }
  }
}
