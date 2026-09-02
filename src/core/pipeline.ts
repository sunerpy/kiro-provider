import {
  GenerateAssistantResponseCommand,
  type GenerateAssistantResponseCommandInput,
} from "@aws/codewhisperer-streaming-client";
import { randomUUID } from "node:crypto";
import {
  assistantLineageFingerprint,
  assistantOutputFingerprint,
  type CanonicalAssistantOutput,
  type CanonicalRequest,
  type ResolvedReasoningReplay,
} from "../protocol/canonical.js";
import { CANONICAL_OUTPUT_JSON_CONTENT_TYPE } from "../protocol/output.js";
import { ReasoningReplayError } from "../reasoning/replay-store.js";
import { EffortSchema } from "../kiro/regions.js";
import { KIRO_CONSTANTS } from "../kiro/constants.js";
import { buildEffortRequestFields } from "../kiro/effort.js";
import { KiroTokenRefreshError } from "../kiro/errors.js";
import {
  isAccessTokenError,
  isQuotaExhausted,
  isRefreshTokenDead,
  toDeadReason,
} from "../kiro/health.js";
import type { ManagedAccount } from "../kiro/types.js";
import { transformToSdkRequest } from "../kiro/transform/request-sdk.js";
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
} from "./error-classifier.js";
import { auditHash, auditLog } from "./audit-log.js";
import {
  abortable,
  abortableSleep,
  abortReason,
  acquireAccountQueue,
  acquireSessionQueue,
  createPipelineDeadline,
} from "./pipeline-runtime.js";
import { createPipelineStreamResponse } from "./pipeline-stream.js";
import { resolveProxyUrl } from "./proxy.js";
import type { PipelineAffinityBinding, RunChatCompletionOptions } from "./pipeline-types.js";
import { createSdkClient, mergeModelRequestFields } from "./sdk-client.js";
import { normalizeStreamFailure } from "./stream-error.js";
import { AccountUnavailableError } from "./token-refresher.js";

export type {
  PipelineAccountManager,
  PipelineAffinityStore,
  PipelineClientFactory,
  PipelineReasoningReplayStore,
  PipelineModelCapabilities,
  PipelineQuotaRechecker,
  PipelineSdkClient,
  PipelineTokenRefresher,
  RunChatCompletionOptions,
} from "./pipeline-types.js";

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
      readonly fingerprintOutput?: SdkOutputFingerprint;
      readonly captureOutput?: SdkOutputCaptureHandler;
      readonly releaseAccount: () => void;
      /** Aborts the upstream HTTP request of this attempt; idempotent. */
      readonly abortUpstream: (reason?: unknown) => void;
    };

interface ReplayState {
  readonly accountId?: string;
  readonly conversationId?: string;
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

/**
 * Kiro rejects a tampered or foreign thinking signature with HTTP 400
 * `ValidationException: ... Invalid `signature` in `thinking` block`. That is
 * a client input error, never an account or transient fault.
 */
function isInvalidReasoningSignature(error: NormalizedSdkError): boolean {
  return error.status === 400 && INVALID_REASONING_SIGNATURE_PATTERN.test(error.message);
}

function isSelectableNow(account: ManagedAccount, now: number): boolean {
  return account.isHealthy && account.rateLimitResetTime <= now && !isQuotaExhausted(account);
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
    (account) => eligibleAccountIds.has(account.id) && isSelectableNow(account, now),
  ).length;
}

/** Shortest wait until a currently rate-limited, otherwise usable candidate frees up. */
function shortestRateLimitWaitMs(
  candidates: readonly ManagedAccount[],
  eligibleAccountIds: ReadonlySet<string>,
  now: number,
): number | undefined {
  const waits = candidates
    .filter(
      (account) =>
        eligibleAccountIds.has(account.id) &&
        account.isHealthy &&
        !isQuotaExhausted(account) &&
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

function persistQuotaExhaustion(
  options: RunChatCompletionOptions,
  account: ManagedAccount,
): void {
  const recheckAfter =
    Date.now() +
    options.config.quota_recheck_interval_ms;
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

function modelAvailabilityError(
  options: RunChatCompletionOptions,
): CompletionResult {
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

function runtimeEndpoint(
  options: RunChatCompletionOptions,
  region: string,
): string | undefined {
  if (options.config.test_upstream_endpoint) {
    return options.config.test_upstream_endpoint;
  }
  return options.config.runtime_endpoint_mode === "kiro-runtime"
    ? KIRO_CONSTANTS.RUNTIME_ENDPOINT.replace("{{region}}", region)
    : undefined;
}

function canonicalOutputFingerprint(request: CanonicalRequest): SdkOutputFingerprint {
  const toolsByWireName = new Map(request.tools.map((tool) => [tool.wireName, tool] as const));
  return (output: CanonicalAssistantOutput): string =>
    assistantOutputFingerprint({
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
    });
}

function replayUnavailable(): CompletionResult {
  return {
    kind: "response",
    response: openAiError(
      503,
      "The account bound to signed reasoning replay is currently unavailable",
      "service_unavailable",
      "reasoning_replay_account_unavailable",
    ),
  };
}

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
    return { replays: [] };
  }
  let accountId = binding?.accountId;
  let conversationId = binding?.conversationId;
  const replays: ResolvedReasoningReplay[] = [];
  for (const replay of options.body.reasoningReplays) {
    if (replay.lookup.kind === "anthropic-direct") {
      // Kiro validates replayed thinking signatures itself and accepts a valid
      // signature in any conversation and on any account (probe evidence,
      // docs/audits/kiro-protocol-evidence-probe-2026-09-02.zh.md), so the
      // signed block is forwarded as-is without an affinity requirement.
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
      ...(accountId !== undefined ? { accountId } : {}),
      ...(conversationId !== undefined ? { conversationId } : {}),
    };
    const resolved =
      replay.lookup.kind === "responses-token"
        ? store.resolveResponses(
            replay.lookup.encryptedContent,
            context,
            replay.insertBeforeMessage,
          )
        : store.resolveChat(
            replay.lookup.reasoningText,
            context,
            replay.insertBeforeMessage,
          );
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
    replays.push(resolved.replay);
  }
  return {
    ...(accountId !== undefined ? { accountId } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
    replays,
  };
}

function reasoningCaptureOptions(
  options: RunChatCompletionOptions,
  accountId: string,
  conversationId: string,
): {
  readonly captureReasoning?: SdkReasoningCaptureHandler;
  readonly emitEncryptedReasoning: boolean;
  readonly emitAnthropicReasoningMetadata: boolean;
  readonly fingerprintOutput?: SdkOutputFingerprint;
  readonly captureOutput?: SdkOutputCaptureHandler;
} {
  const canonical = options.body;
  const emitEncryptedReasoning = canonical.includeEncryptedReasoning === true;
  const emitAnthropicReasoningMetadata = canonical.protocol === "anthropic-messages";
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
      fingerprintOutput: canonicalOutputFingerprint(canonical),
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
      }),
    emitEncryptedReasoning,
    emitAnthropicReasoningMetadata,
    fingerprintOutput: canonicalOutputFingerprint(canonical),
    ...(captureOutput ? { captureOutput } : {}),
  };
}

/**
 * Mutable per-request state shared by the executeLoop phases. Every set/map is
 * scoped to one request; nothing here outlives runChatCompletion.
 */
interface LoopState {
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
  /** Account the request is bound to before selection (replay lock or affinity). */
  readonly boundAccountId: string | undefined;
  preferredAccountId: string | undefined;
  requestAccountId: string | undefined;
  requestConversationId: string | undefined;
}

interface AttemptSelection {
  readonly selected: ManagedAccount;
  readonly accounts: readonly ManagedAccount[];
  readonly eligibleAccountIds: ReadonlySet<string>;
}

type SelectionOutcome =
  | { readonly kind: "selected"; readonly selection: AttemptSelection }
  | { readonly kind: "wait"; readonly waitMs: number }
  | { readonly kind: "result"; readonly result: CompletionResult };

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
    };

type LoopDirective =
  | { readonly kind: "continue" }
  | { readonly kind: "return"; readonly result: CompletionResult };

const CONTINUE: LoopDirective = { kind: "continue" };

function returning(result: CompletionResult): LoopDirective {
  return { kind: "return", result };
}

/** Phase 1: resolve affinity/lineage/replay bindings into the initial loop state. */
function resolveBinding(options: RunChatCompletionOptions): LoopState {
  const startedAt = Date.now();
  const binding =
    options.affinity && options.affinityStore
      ? options.affinityStore.getSessionAffinity(options.affinity.keyHash)
      : undefined;
  const lineageBinding =
    binding === undefined &&
    options.lineage?.lookupKeyHash !== undefined &&
    options.affinityStore
      ? options.affinityStore.resolveOutputLineage(options.lineage.lookupKeyHash)
      : undefined;
  const effectiveBinding = binding ?? lineageBinding;
  const replayState = resolveReplayState(options, effectiveBinding);
  const boundAccountId = replayState.accountId ?? effectiveBinding?.accountId;
  return {
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
    replayLocked: replayState.accountId !== undefined,
    boundAccountId,
    preferredAccountId: boundAccountId,
    requestAccountId: boundAccountId,
    requestConversationId: replayState.conversationId ?? effectiveBinding?.conversationId,
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
  const refreshTokenDead =
    failure instanceof KiroTokenRefreshError && isRefreshTokenDead(reason);
  const networkError =
    failure instanceof KiroTokenRefreshError && failure.code === "NETWORK_ERROR";
  state.lastRefreshFailure = failure;
  if (networkError && !state.refreshNetworkRetriedAccountIds.has(failed.id)) {
    state.refreshNetworkRetriedAccountIds.add(failed.id);
    auditLog("warn", "account_token_refresh_retry", {
      account_hash: auditHash(failed.id),
      error_code: failure.code,
    });
    return "retry";
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
): Promise<LoopDirective> {
  if (excludeAfterRefreshFailure(options, state, failed, failure) === "retry") {
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
    isSelectableNow(account, recheckNow),
  );
  const lockedAccountExhausted =
    state.replayLocked &&
    recheckAccounts.some(
      (account) => account.id === state.boundAccountId && isQuotaExhausted(account),
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
  const quotaExhaustedAccounts = requestCandidates.filter(isQuotaExhausted);
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
    .filter((account) => !isQuotaExhausted(account))
    .map((account) => account.id);
  const cachedEligible = options.modelCapabilities?.eligibleAccountIds(
    options.model,
    candidateAccountIds,
  );
  const eligibleAccountIds = new Set(
    [...(cachedEligible ?? candidateAccountIds)].filter(
      (accountId) => !state.modelRejectedAccountIds.has(accountId),
    ),
  );
  const selected = options.accountManager.selectHealthyAccount(
    state.preferredAccountId,
    eligibleAccountIds,
  );
  if (
    selected &&
    (state.replayState.accountId === undefined || selected.id === state.replayState.accountId)
  ) {
    return { kind: "selected", selection: { selected, accounts, eligibleAccountIds } };
  }

  if (state.replayLocked) return { kind: "result", result: replayUnavailable() };
  if (candidateAccountIds.length === 0 && state.lastAuthenticationFailure) {
    return { kind: "result", result: authenticationFailureResult(state.lastAuthenticationFailure) };
  }
  if (
    candidateAccountIds.length === 0 &&
    (quotaExhaustedAccounts.length > 0 || state.lastQuotaFailure)
  ) {
    return { kind: "result", result: quotaFailureResult(state.lastQuotaFailure) };
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
  if (options.affinity && options.affinityStore) {
    if (!state.binding) {
      const claimed = options.affinityStore.claimSessionAffinity(
        options.affinity.keyHash,
        selected.id,
        state.requestConversationId ?? randomUUID(),
        now,
        options.config.session_affinity_ttl_ms,
        options.config.session_affinity_max_entries,
      );
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
    } else if (state.binding.accountId === selected.id) {
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
        randomUUID(),
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

  state.preferredAccountId = selected.id;
  auditLog("info", "upstream_affinity_selected", {
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
    const initialAuth = options.accountManager.toAuthDetails(selected);
    account = await abortable(
      options.tokenRefresher.refreshIfNeeded(selected, initialAuth, signal),
      signal,
    );
    const auth = options.accountManager.toAuthDetails(account);
    if (options.modelCapabilities) {
      const availability = await abortable(
        options.modelCapabilities.ensureAccountModel(
          account,
          auth,
          options.model,
          signal,
        ),
        signal,
      );
      if (!availability.supported) {
        auditLog("warn", "account_model_unavailable", {
          account_hash: auditHash(account.id),
          model_hash: auditHash(options.model),
          capability_source: availability.source,
        });
        return { kind: "model-unavailable", account };
      }
    }
    const parsedEffort = EffortSchema.safeParse(options.config.effort);
    const prepared = transformToSdkRequest(options.body, options.model, auth, think, budget, {
      autoEffortMapping: options.config.auto_effort_mapping,
      conversationId: state.requestConversationId,
      resolvedReasoningReplays: state.replayState.replays,
      ...(parsedEffort.success ? { effort: parsedEffort.data } : {}),
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
    );
    // Effort travels in the command input (B7); the SDK client no longer
    // re-parses and re-serializes the request body to inject it.
    const wireModel =
      prepared.conversationState.currentMessage.userInputMessage?.modelId ??
      prepared.effectiveModel;
    const additionalModelRequestFields = prepared.effort
      ? mergeModelRequestFields(
          prepared.additionalModelRequestFields,
          buildEffortRequestFields(wireModel, prepared.effort),
        )
      : prepared.additionalModelRequestFields;
    const commandInput: unknown = {
      conversationState: prepared.conversationState,
      ...(prepared.profileArn ? { profileArn: prepared.profileArn } : {}),
      ...(additionalModelRequestFields ? { additionalModelRequestFields } : {}),
    };
    if (!isSdkCommandInput(commandInput)) {
      throw new TypeError("Transformed request is not a valid SDK command input");
    }
    const command = new GenerateAssistantResponseCommand(commandInput);
    // Each attempt owns an AbortController so the upstream socket can be
    // destroyed on idle timeout, consumer cancel, or a failed collection
    // even though the ingress signal itself never fires (A1).
    const attempt = new AbortController();
    const abortUpstream = (reason?: unknown): void => {
      if (!attempt.signal.aborted) attempt.abort(reason);
    };
    upstreamStarted = true;
    const sdkResponse = await abortable(
      client.send(command, { abortSignal: AbortSignal.any([signal, attempt.signal]) }),
      signal,
    );
    const captureOptions = reasoningCaptureOptions(
      options,
      account.id,
      prepared.conversationId,
    );
    if (options.stream) {
      return {
        kind: "result",
        leaseTransferred: true,
        result: {
          kind: "stream",
          sdkResponse,
          model: options.model,
          conversationId: prepared.conversationId,
          ...captureOptions,
          releaseAccount,
          abortUpstream,
        },
      };
    }
    let completion: Awaited<ReturnType<typeof collectSdkResponse>>;
    try {
      completion = await collectSdkResponse(
        sdkResponse,
        options.model,
        prepared.conversationId,
        signal,
        captureOptions,
      );
    } catch (collectError) {
      abortUpstream(collectError);
      throw collectError;
    }
    if (signal.aborted) throw abortReason(signal);
    return {
      kind: "result",
      leaseTransferred: false,
      result: {
        kind: "response",
        response: Response.json(completion, {
          headers: { "Content-Type": CANONICAL_OUTPUT_JSON_CONTENT_TYPE },
        }),
      },
    };
  } catch (caught) {
    return { kind: "failed", account, caught, upstreamStarted };
  }
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
    if (state.replayLocked) return returning(replayUnavailable());
    if (isRefreshFailure(caught)) {
      return continueAfterRefreshFailure(options, signal, state, account, caught);
    }
    throw caught;
  }
  if (isStreamFailureError(caught)) {
    // Nothing has been sent to the client on the non-stream path, so a
    // retryable stream failure gets the same bounded retry as truncation;
    // fatal ones (and exhausted retries) terminate as 502 consistently.
    const streamFailure = normalizeStreamFailure(caught, "upstream_protocol_error");
    if (
      streamFailure.disposition === "retryable" &&
      state.retryCount < options.config.rate_limit_max_retries
    ) {
      state.retryCount += 1;
      auditLog("warn", "non_stream_failure_retry", {
        account_hash: auditHash(account.id),
        error_code: streamFailure.code,
        retry_count: state.retryCount,
      });
      await abortableSleep(
        options.config.rate_limit_retry_delay_ms * 2 ** (state.retryCount - 1),
        signal,
      );
      return CONTINUE;
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
      try {
        await abortable(options.tokenRefresher.forceRefresh(account, signal), signal);
      } catch (refreshError) {
        if (signal.aborted) throw abortReason(signal);
        if (!isRefreshFailure(refreshError)) throw refreshError;
        if (state.replayLocked) return returning(replayUnavailable());
        return continueAfterRefreshFailure(options, signal, state, account, refreshError);
      }
      return CONTINUE;
    case "retry":
      state.retryCount += 1;
      await abortableSleep(classification.retryAfterMs ?? 0, signal);
      return CONTINUE;
    case "switch":
      if (state.replayLocked) return returning(replayUnavailable());
      state.requestExcludedAccountIds.add(account.id);
      if (
        error.status === 401 ||
        (error.status === 403 && isAccessTokenError(error.message))
      ) {
        state.lastAuthenticationFailure = error;
      }
      if (error.status === 402) state.lastQuotaFailure = error;
      if (error.reason === "TEMPORARILY_SUSPENDED") {
        options.accountManager.markUnhealthy(
          account,
          `InvalidTokenException: Account Suspended: ${error.message}`,
        );
      } else if (error.status === 402) {
        persistQuotaExhaustion(options, account);
      } else {
        options.accountManager.markRateLimited(
          account,
          Date.now() +
            (classification.retryAfterMs ?? options.config.rate_limit_retry_delay_ms),
        );
      }
      forgetPreferredAccount(state);
      return CONTINUE;
    case "fail":
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
      if (error.status === 402) {
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
          error.code,
        ),
      });
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

    const selectionOutcome = selectAttemptAccount(options, state);
    if (selectionOutcome.kind === "result") return selectionOutcome.result;
    if (selectionOutcome.kind === "wait") {
      await abortableSleep(selectionOutcome.waitMs + 1, signal);
      continue;
    }
    const { selection } = selectionOutcome;
    if (bindAttemptAffinity(options, state, selection.selected) === "reselect") continue;

    const releaseAccount = await acquireAccountQueue(selection.selected.id, signal);
    let accountLeaseOwned = true;
    try {
      const outcome = await runAttempt(options, signal, state, selection.selected, releaseAccount);
      if (outcome.kind === "result") {
        accountLeaseOwned = !outcome.leaseTransferred;
        return outcome.result;
      }
      if (outcome.kind === "model-unavailable") {
        if (state.replayLocked) return replayUnavailable();
        state.modelRejectedAccountIds.add(outcome.account.id);
        forgetPreferredAccount(state);
        continue;
      }
      const directive = await applyClassification(options, signal, state, selection, outcome);
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
  const deadline = createPipelineDeadline(
    options.deadlineSignal,
    options.config.request_timeout_ms,
  );
  let releaseSession: (() => void) | undefined;
  let releaseAccount: (() => void) | undefined;
  let streamOwnsResources = false;
  try {
    if (options.affinity) {
      releaseSession = await acquireSessionQueue(
        options.affinity.keyHash,
        deadline.signal,
      );
    } else if (options.lineage?.lookupKeyHash !== undefined) {
      releaseSession = await acquireSessionQueue(
        options.lineage.lookupKeyHash,
        deadline.signal,
      );
    }
    const result = await executeLoop(options, deadline.signal);
    if (result.kind === "response") return result.response;

    releaseAccount = result.releaseAccount;
    const streamAccountRelease = releaseAccount;
    const streamSessionRelease = releaseSession;
    const response = (options.createStreamResponse ?? createPipelineStreamResponse)(
      result,
      deadline.signal,
      options.config.stream_idle_timeout_ms,
      () => {
        streamAccountRelease();
        streamSessionRelease?.();
        deadline.dispose();
      },
    );
    releaseAccount = undefined;
    releaseSession = undefined;
    streamOwnsResources = true;
    return response;
  } catch (error) {
    if (error instanceof RequestTransformError) {
      return openAiError(
        400,
        error.message,
        "invalid_request_error",
        error.code,
        error.param,
      );
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
      return openAiError(504, "Request deadline exceeded", "timeout_error", "request_timeout");
    }
    const normalized = normalizeSdkError(error);
    if (normalized.status !== undefined) {
      // A status-bearing upstream error that escaped the loop keeps its envelope.
      return openAiError(500, normalized.message, "internal_error", normalized.code);
    }
    // B16: never echo arbitrary exception text (paths, ids, SQL) to the client.
    // The correlation id ties the fixed response to the hashed audit record.
    const requestId = newRequestId();
    auditLog("error", "pipeline_internal_error", {
      request_id: requestId,
      error_type: error instanceof Error ? error.name : typeof error,
      error_code: normalized.code,
      error_message_hash: auditHash(normalized.message),
    });
    return openAiInternalError(requestId);
  } finally {
    if (!streamOwnsResources) {
      releaseAccount?.();
      releaseSession?.();
      deadline.dispose();
    }
  }
}
