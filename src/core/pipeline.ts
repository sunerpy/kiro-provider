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
} from "../kiro/transform/streaming/sdk-stream-runtime.js";
import { openAiError } from "../server/errors.js";
import {
  classifyError,
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
import type { RunChatCompletionOptions } from "./pipeline-types.js";
import { createSdkClient } from "./sdk-client.js";
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
      ...(canonical ? { fingerprintOutput: canonicalOutputFingerprint(canonical) } : {}),
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

async function executeLoop(
  options: RunChatCompletionOptions,
  signal: AbortSignal,
): Promise<CompletionResult> {
  const { think, budget } = thinkingOptions(options.body, options.model);
  const forcedRefreshAccountIds = new Set<string>();
  const serverErrors = new Map<string, number>();
  const requestExcludedAccountIds = new Set<string>();
  const reportedQuotaExhaustedAccountIds = new Set<string>();
  const refreshNetworkRetriedAccountIds = new Set<string>();
  let lastAuthenticationFailure: NormalizedSdkError | undefined;
  let lastQuotaFailure: NormalizedSdkError | undefined;
  let lastRefreshFailure: RefreshFailure | undefined;
  let retryCount = 0;
  let iterations = 0;
  let binding =
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
  const replayLocked = replayState.accountId !== undefined;
  let preferredAccountId = replayState.accountId ?? effectiveBinding?.accountId;
  let requestAccountId = replayState.accountId ?? effectiveBinding?.accountId;
  let requestConversationId =
    replayState.conversationId ?? effectiveBinding?.conversationId;
  const modelRejectedAccountIds = new Set<string>();

  /**
   * A refresh failure before the upstream call started is an account-level
   * fault, not a request fault: exclude the account for this request and let
   * the loop pick another one. A first NETWORK_ERROR gets one bounded retry on
   * the same account before it is excluded.
   */
  const excludeAfterRefreshFailure = (
    failed: ManagedAccount,
    failure: RefreshFailure,
  ): "retry" | "switch" => {
    const reason = refreshFailureReason(failure);
    const refreshTokenDead =
      failure instanceof KiroTokenRefreshError && isRefreshTokenDead(reason);
    const networkError =
      failure instanceof KiroTokenRefreshError && failure.code === "NETWORK_ERROR";
    lastRefreshFailure = failure;
    if (networkError && !refreshNetworkRetriedAccountIds.has(failed.id)) {
      refreshNetworkRetriedAccountIds.add(failed.id);
      auditLog("warn", "account_token_refresh_retry", {
        account_hash: auditHash(failed.id),
        error_code: failure.code,
      });
      return "retry";
    }
    requestExcludedAccountIds.add(failed.id);
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
    preferredAccountId = undefined;
    requestAccountId = undefined;
    requestConversationId = undefined;
    return "switch";
  };

  if (options.quotaRechecker) {
    await options.quotaRechecker.recheckDueAccounts(
      options.accountManager.reconcileFromDb(),
      signal,
      replayState.accountId ?? effectiveBinding?.accountId,
    );
  }

  while (true) {
    if (signal.aborted) throw abortReason(signal);
    iterations += 1;
    if (iterations > options.config.max_request_iterations) {
      if (lastAuthenticationFailure) {
        return {
          kind: "response",
          response: terminalError(
            lastAuthenticationFailure.status ?? 403,
            lastAuthenticationFailure.message,
            lastAuthenticationFailure.code ?? "upstream_authentication_failed",
          ),
        };
      }
      if (lastQuotaFailure) {
        return {
          kind: "response",
          response: terminalError(
            402,
            lastQuotaFailure.message,
            lastQuotaFailure.code ?? "quota_exhausted",
          ),
        };
      }
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

    const accounts = options.accountManager.reconcileFromDb();
    const requestCandidates = accounts.filter(
      (account) =>
        !modelRejectedAccountIds.has(account.id) &&
        !requestExcludedAccountIds.has(account.id),
    );
    const quotaExhaustedAccounts = requestCandidates.filter(isQuotaExhausted);
    const newlyReportedQuotaAccounts = quotaExhaustedAccounts.filter(
      (account) => !reportedQuotaExhaustedAccountIds.has(account.id),
    );
    for (const account of newlyReportedQuotaAccounts) {
      reportedQuotaExhaustedAccountIds.add(account.id);
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
        (accountId) => !modelRejectedAccountIds.has(accountId),
      ),
    );
    const selected = options.accountManager.selectHealthyAccount(
      preferredAccountId,
      eligibleAccountIds,
    );
    if (!selected || (replayState.accountId !== undefined && selected.id !== replayState.accountId)) {
      if (replayLocked) return replayUnavailable();
      if (candidateAccountIds.length === 0 && lastAuthenticationFailure) {
        return {
          kind: "response",
          response: terminalError(
            lastAuthenticationFailure.status ?? 403,
            lastAuthenticationFailure.message,
            lastAuthenticationFailure.code ?? "upstream_authentication_failed",
          ),
        };
      }
      if (
        candidateAccountIds.length === 0 &&
        (quotaExhaustedAccounts.length > 0 || lastQuotaFailure)
      ) {
        return {
          kind: "response",
          response: terminalError(
            402,
            lastQuotaFailure?.message ?? "All eligible Kiro accounts have exhausted their quota",
            lastQuotaFailure?.code ?? "quota_exhausted",
          ),
        };
      }
      if (candidateAccountIds.length === 0 && lastRefreshFailure !== undefined) {
        return refreshFailureResponse();
      }
      if (
        modelRejectedAccountIds.size > 0 ||
        (cachedEligible !== undefined && eligibleAccountIds.size === 0)
      ) {
        return modelAvailabilityError(options);
      }
      return {
        kind: "response",
        response: openAiError(
          503,
          "All accounts are unhealthy or rate-limited",
          "service_unavailable",
          "no_healthy_accounts",
        ),
      };
    }

    const now = Date.now();
    if (options.affinity && options.affinityStore) {
      if (!binding) {
        const claimed = options.affinityStore.claimSessionAffinity(
          options.affinity.keyHash,
          selected.id,
          requestConversationId ?? randomUUID(),
          now,
          options.config.session_affinity_ttl_ms,
          options.config.session_affinity_max_entries,
        );
        binding = claimed;
        preferredAccountId = claimed.accountId;
        requestConversationId = claimed.conversationId;
        if (
          replayLocked &&
          (claimed.accountId !== replayState.accountId ||
            claimed.conversationId !== replayState.conversationId)
        ) {
          throw new ReasoningReplayError(
            "Session affinity conflicts with signed reasoning replay",
            "reasoning_replay_context_mismatch",
          );
        }
        if (claimed.accountId !== selected.id) continue;
      } else if (binding.accountId === selected.id) {
        binding = options.affinityStore.claimSessionAffinity(
          options.affinity.keyHash,
          selected.id,
          binding.conversationId,
          now,
          options.config.session_affinity_ttl_ms,
          options.config.session_affinity_max_entries,
        );
        requestConversationId = binding.conversationId;
      } else {
        binding = options.affinityStore.rebindSessionAffinity(
          options.affinity.keyHash,
          selected.id,
          randomUUID(),
          now,
          options.config.session_affinity_ttl_ms,
          options.config.session_affinity_max_entries,
        );
        requestConversationId = binding.conversationId;
      }
    } else if (!replayLocked && requestAccountId !== selected.id) {
      requestAccountId = selected.id;
      requestConversationId = randomUUID();
    }

    preferredAccountId = selected.id;
    auditLog("info", "upstream_affinity_selected", {
      projection_mode: options.config.protocol_projection_mode,
      session_affinity_mode: options.config.session_affinity_mode,
      affinity_source: options.affinity?.source ?? options.lineage?.source,
      affinity_bound: binding !== undefined || lineageBinding !== undefined,
      affinity_kind:
        binding !== undefined
          ? "explicit"
          : lineageBinding !== undefined
            ? "history-lineage"
            : undefined,
      account_hash: auditHash(selected.id),
      conversation_hash:
        requestConversationId === undefined
          ? undefined
          : auditHash(requestConversationId),
      reasoning_replay_locked: replayLocked,
    });
    const releaseAccount = await acquireAccountQueue(selected.id, signal);
    let accountLeaseOwned = true;
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
          if (replayLocked) return replayUnavailable();
          modelRejectedAccountIds.add(account.id);
          preferredAccountId = undefined;
          requestAccountId = undefined;
          requestConversationId = undefined;
          continue;
        }
      }
      const parsedEffort = EffortSchema.safeParse(options.config.effort);
      const prepared = transformToSdkRequest(options.body, options.model, auth, think, budget, {
        autoEffortMapping: options.config.auto_effort_mapping,
        conversationId: requestConversationId,
        resolvedReasoningReplays: replayState.replays,
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
      const commandInput: unknown = {
        conversationState: prepared.conversationState,
        ...(prepared.profileArn ? { profileArn: prepared.profileArn } : {}),
        ...(prepared.additionalModelRequestFields
          ? {
              additionalModelRequestFields:
                prepared.additionalModelRequestFields,
            }
          : {}),
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
        accountLeaseOwned = false;
        return {
          kind: "stream",
          sdkResponse,
          model: options.model,
          conversationId: prepared.conversationId,
          ...captureOptions,
          releaseAccount,
          abortUpstream,
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
        kind: "response",
        response: Response.json(completion, {
          headers: { "Content-Type": CANONICAL_OUTPUT_JSON_CONTENT_TYPE },
        }),
      };
    } catch (caught) {
      if (signal.aborted) throw abortReason(signal);
      if (!upstreamStarted) {
        if (caught instanceof RequestTransformError || caught instanceof ReasoningReplayError) {
          throw caught;
        }
        if (replayLocked) return replayUnavailable();
        if (isRefreshFailure(caught)) {
          if (excludeAfterRefreshFailure(account, caught) === "retry") {
            await abortableSleep(options.config.rate_limit_retry_delay_ms, signal);
          }
          continue;
        }
        throw caught;
      }
      if (caught instanceof SemanticStreamTruncationError) {
        if (retryCount < options.config.rate_limit_max_retries) {
          retryCount += 1;
          await abortableSleep(
            options.config.rate_limit_retry_delay_ms * 2 ** (retryCount - 1),
            signal,
          );
          continue;
        }
        return {
          kind: "response",
          response: terminalError(502, caught.message, caught.code),
        };
      }
      if (caught instanceof SdkStreamProtocolError) {
        return {
          kind: "response",
          response: terminalError(502, caught.message, caught.code),
        };
      }
      const error = normalizeSdkError(caught);
      const serverErrorCount = error.status === 500 ? (serverErrors.get(account.id) ?? 0) + 1 : 0;
      if (error.status === 500) serverErrors.set(account.id, serverErrorCount);
      const classification = classifyError(error, {
        accountId: account.id,
        accountCount: Math.max(1, eligibleAccountIds.size),
        retryCount,
        maxRetries: options.config.rate_limit_max_retries,
        serverErrorCount,
        retryDelayMs: options.config.rate_limit_retry_delay_ms,
        forcedRefreshAccountIds,
      });

      switch (classification.action) {
        case "refresh-then-retry":
          try {
            await abortable(options.tokenRefresher.forceRefresh(account, signal), signal);
          } catch (refreshError) {
            if (signal.aborted) throw abortReason(signal);
            if (!isRefreshFailure(refreshError)) throw refreshError;
            if (replayLocked) return replayUnavailable();
            if (excludeAfterRefreshFailure(account, refreshError) === "retry") {
              await abortableSleep(options.config.rate_limit_retry_delay_ms, signal);
            }
          }
          continue;
        case "retry":
          retryCount += 1;
          await abortableSleep(classification.retryAfterMs ?? 0, signal);
          continue;
        case "switch":
          if (replayLocked) return replayUnavailable();
          requestExcludedAccountIds.add(account.id);
          if (
            error.status === 401 ||
            (error.status === 403 && isAccessTokenError(error.message))
          ) {
            lastAuthenticationFailure = error;
          }
          if (error.status === 402) lastQuotaFailure = error;
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
          preferredAccountId = undefined;
          requestAccountId = undefined;
          if (!options.affinityStore) requestConversationId = undefined;
          continue;
        case "fail":
          if (isInvalidReasoningSignature(error)) {
            return {
              kind: "response",
              response: openAiError(
                400,
                error.message,
                "invalid_request_error",
                "invalid_reasoning_signature",
              ),
            };
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
          return {
            kind: "response",
            response: terminalError(
              classification.terminalStatus ?? classification.status ?? 500,
              error.message,
              error.code,
            ),
          };
      }
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
    return openAiError(500, normalized.message, "internal_error", normalized.code);
  } finally {
    if (!streamOwnsResources) {
      releaseAccount?.();
      releaseSession?.();
      deadline.dispose();
    }
  }
}
