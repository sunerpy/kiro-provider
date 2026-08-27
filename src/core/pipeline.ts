import {
  GenerateAssistantResponseCommand,
  type GenerateAssistantResponseCommandInput,
} from "@aws/codewhisperer-streaming-client";
import { randomUUID } from "node:crypto";
import {
  assistantOutputFingerprint,
  type CanonicalAssistantOutput,
  type CanonicalRequest,
  type ResolvedReasoningReplay,
} from "../protocol/canonical.js";
import { CANONICAL_OUTPUT_JSON_CONTENT_TYPE } from "../protocol/output.js";
import { ReasoningReplayError } from "../reasoning/replay-store.js";
import { EffortSchema } from "../kiro/regions.js";
import { transformToSdkRequest } from "../kiro/transform/request-sdk.js";
import { RequestTransformError } from "../kiro/transform/errors.js";
import { collectSdkResponse } from "../kiro/transform/sdk-collector.js";
import type { SdkStreamResponse } from "../kiro/transform/streaming/sdk-stream-runtime.js";
import type { SdkReasoningCaptureHandler } from "../kiro/transform/streaming/sdk-stream-runtime.js";
import type { SdkOutputFingerprint } from "../kiro/transform/streaming/sdk-stream-runtime.js";
import { openAiError } from "../server/errors.js";
import { classifyError, normalizeSdkError } from "./error-classifier.js";
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

export type {
  PipelineAccountManager,
  PipelineAffinityStore,
  PipelineClientFactory,
  PipelineReasoningReplayStore,
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
      readonly releaseAccount: () => void;
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
  if (!options.tenantId) {
    throw new ReasoningReplayError(
      "Reasoning replay requires an authenticated tenant context",
      "reasoning_replay_context_required",
    );
  }
  let accountId = binding?.accountId;
  let conversationId = binding?.conversationId;
  const replays: ResolvedReasoningReplay[] = [];
  for (const replay of options.body.reasoningReplays) {
    if (replay.lookup.kind === "anthropic-direct") {
      if (accountId === undefined || conversationId === undefined) {
        throw new ReasoningReplayError(
          "Anthropic signed thinking replay requires an existing account/conversation affinity",
          "reasoning_replay_context_required",
        );
      }
      replays.push({
        insertBeforeMessage: replay.insertBeforeMessage,
        content: replay.lookup.content,
      });
      continue;
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
} {
  const canonical = options.body;
  const emitEncryptedReasoning = canonical.includeEncryptedReasoning === true;
  const emitAnthropicReasoningMetadata = canonical.protocol === "anthropic-messages";
  if (!options.reasoningReplayStore || !options.tenantId) {
    return {
      emitEncryptedReasoning,
      emitAnthropicReasoningMetadata,
      ...(canonical ? { fingerprintOutput: canonicalOutputFingerprint(canonical) } : {}),
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
  };
}

async function executeLoop(
  options: RunChatCompletionOptions,
  signal: AbortSignal,
): Promise<CompletionResult> {
  const { think, budget } = thinkingOptions(options.body, options.model);
  const forcedRefreshAccountIds = new Set<string>();
  const serverErrors = new Map<string, number>();
  let retryCount = 0;
  let iterations = 0;
  let binding =
    options.affinity && options.affinityStore
      ? options.affinityStore.getSessionAffinity(options.affinity.keyHash)
      : undefined;
  const replayState = resolveReplayState(options, binding);
  const replayLocked = replayState.accountId !== undefined;
  let preferredAccountId = replayState.accountId ?? binding?.accountId;
  let requestAccountId: string | undefined;
  let requestConversationId = replayState.conversationId ?? binding?.conversationId;

  while (true) {
    if (signal.aborted) throw abortReason(signal);
    iterations += 1;
    if (iterations > options.config.max_request_iterations) {
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

    options.accountManager.reconcileFromDb();
    const selected = options.accountManager.selectHealthyAccount(preferredAccountId);
    if (!selected || (replayState.accountId !== undefined && selected.id !== replayState.accountId)) {
      if (replayLocked) return replayUnavailable();
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
      affinity_source: options.affinity?.source,
      affinity_bound: options.affinity !== undefined,
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
        options.config.test_upstream_endpoint,
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
      upstreamStarted = true;
      const sdkResponse = await abortable(client.send(command, { abortSignal: signal }), signal);
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
        };
      }
      const completion = await collectSdkResponse(
        sdkResponse,
        options.model,
        prepared.conversationId,
        signal,
        captureOptions,
      );
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
        throw caught;
      }
      const error = normalizeSdkError(caught);
      const serverErrorCount = error.status === 500 ? (serverErrors.get(account.id) ?? 0) + 1 : 0;
      if (error.status === 500) serverErrors.set(account.id, serverErrorCount);
      const classification = classifyError(error, {
        accountId: account.id,
        accountCount: options.accountManager.getAccountCount(),
        retryCount,
        maxRetries: options.config.rate_limit_max_retries,
        serverErrorCount,
        retryDelayMs: options.config.rate_limit_retry_delay_ms,
        forcedRefreshAccountIds,
      });

      switch (classification.action) {
        case "refresh-then-retry":
          await abortable(options.tokenRefresher.forceRefresh(account, signal), signal);
          continue;
        case "retry":
          retryCount += 1;
          await abortableSleep(classification.retryAfterMs ?? 0, signal);
          continue;
        case "switch":
          if (replayLocked) return replayUnavailable();
          if (error.reason === "TEMPORARILY_SUSPENDED") {
            options.accountManager.markUnhealthy(
              account,
              `InvalidTokenException: Account Suspended: ${error.message}`,
            );
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
