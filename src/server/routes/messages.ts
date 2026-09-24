import type { Config } from "../../config/schema.js";
import { auditHash, auditLog } from "../../core/audit-log.js";
import { runChatCompletion } from "../../core/pipeline.js";
import { boundedCleanup } from "../../core/stream-cleanup.js";
import { estimateTokens } from "../../kiro/transform/response.js";
import {
  type ClientNormalization,
  isClientNormalization,
} from "../../protocol/client-normalization.js";
import {
  CANONICAL_OUTPUT_JSON_MEDIA_TYPE,
  CANONICAL_OUTPUT_STREAM_MEDIA_TYPE,
  parseCanonicalCompletion,
} from "../../protocol/output.js";
import { type AnthropicErrorType, anthropicError } from "../anthropic/errors.js";
import { adaptAnthropicMessagesRequest } from "../anthropic/request-adapter.js";
import {
  type AnthropicCompatibilityOptions,
  anthropicMessageResponse,
  anthropicSseAdapter,
} from "../anthropic/response-adapter.js";
import {
  type AnthropicStructuredOutputFailure,
  anthropicStructuredOutputFailureForCode,
  anthropicStructuredOutputFailureMessage,
  isAnthropicStructuredOutputFailureCode,
  STRUCTURED_OUTPUT_UNEXPECTED_TOOL_CALL_FAILURE,
} from "../anthropic/structured-output.js";
import {
  anthropicIngressErrors,
  buildPipelineOptions,
  createIngress,
  type RouteDependencies,
  readJsonBody,
  withRetryAfter,
} from "../ingress.js";
import { anthropicSessionAffinity, canonicalSessionLineage } from "../session-affinity.js";
import {
  LOCAL_STRUCTURED_OUTPUT_MAX_BUFFER_BYTES,
  STRUCTURED_OUTPUT_BUFFER_EXCEEDED_MESSAGE,
} from "../structured-output/local-profile.js";

export type MessagesDependencies = RouteDependencies;

const OUTPUT_TOKEN_LIMIT_MODE_HEADER = "x-kiro-output-token-limit-mode";

function unsupportedOutputTokenLimitMode(request: Request): "advisory" | undefined {
  return request.headers.get(OUTPUT_TOKEN_LIMIT_MODE_HEADER)?.trim().toLowerCase() === "advisory"
    ? "advisory"
    : undefined;
}

function pipelineErrorType(status: number): AnthropicErrorType {
  if (status === 429) return "rate_limit_error";
  if (status === 503) return "overloaded_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status >= 400 && status < 500) return "invalid_request_error";
  return "api_error";
}

function pipelineErrorDetails(value: unknown): {
  readonly message?: string;
  readonly code?: string;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    !("error" in value) ||
    typeof value.error !== "object" ||
    value.error === null
  ) {
    return {};
  }
  const error = value.error;
  return {
    ...("message" in error && typeof error.message === "string" ? { message: error.message } : {}),
    ...("code" in error && typeof error.code === "string" ? { code: error.code } : {}),
  };
}

export async function translatePipelineError(response: Response): Promise<Response> {
  let message = `Upstream request failed with HTTP ${response.status}`;
  let code: string | undefined;
  try {
    const details = pipelineErrorDetails(await response.json());
    if (details.message !== undefined) message = details.message;
    code = details.code;
  } catch {
    // Preserve the status-derived fallback when the upstream body is not JSON.
  }
  // Kiro quota exhaustion (402) is a capacity condition that clears when a
  // quota window resets, so Anthropic clients see the retryable rate-limit
  // class instead of a permanent invalid-request rejection. The structured
  // provider code stays visible in the message for operators.
  const translated =
    response.status === 402
      ? anthropicError(
          429,
          code !== undefined ? `${message} (code: ${code})` : message,
          "rate_limit_error",
        )
      : anthropicError(response.status, message, pipelineErrorType(response.status));
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter !== null) translated.headers.set("Retry-After", retryAfter);
  return translated;
}

/**
 * With a structured-output profile the pipeline itself may fail closed (one
 * dispatch, tool-call rejection, collected-text ceiling). Surface those coded
 * failures as the profile's 502 instead of the generic upstream translation.
 */
async function structuredOutputPipelineFailure(
  response: Response,
): Promise<AnthropicStructuredOutputFailure | undefined> {
  try {
    const details = pipelineErrorDetails(await response.clone().json());
    if (isAnthropicStructuredOutputFailureCode(details.code)) {
      return anthropicStructuredOutputFailureForCode(details.code);
    }
  } catch {
    // Not a JSON pipeline error; fall through to the ordinary translation.
  }
  return undefined;
}

function estimateInputTokens(value: unknown): number {
  return Math.max(1, estimateTokens(JSON.stringify(value)));
}

function claudeCodeIdentityHeader(
  request: Request,
  name: "x-claude-code-session-id" | "x-claude-code-agent-id",
): string | undefined {
  const value = request.headers.get(name)?.trim();
  return value && value.length <= 256 ? value : undefined;
}

// allow: SIZE_OK — owns one protocol boundary and its request-scoped resources.
export async function handleMessages(
  request: Request,
  config: Config,
  dependencies: MessagesDependencies,
): Promise<Response> {
  const ingress = createIngress(
    request,
    config,
    dependencies.createRequestIdleTimeoutLease,
    dependencies.diagnostics,
    dependencies.requestAdmission,
  );
  const bodyResult = await readJsonBody(request, config, ingress.signals, anthropicIngressErrors);
  if (!bodyResult.ok) {
    ingress.finalize();
    return bodyResult.response;
  }
  let clientNormalization: ClientNormalization | undefined;
  const normalizationMode = request.headers.get("x-kiro-client-normalization");
  const directoryHash = request.headers.get("x-kiro-working-directory-hash");
  if (normalizationMode !== null || directoryHash !== null) {
    const candidate = {
      kind: normalizationMode?.trim(),
      workingDirectoryHash: directoryHash?.trim().toLowerCase(),
    };
    if (!isClientNormalization(candidate)) {
      ingress.finalize();
      return anthropicError(400, "Invalid client normalization context", "invalid_request_error");
    }
    clientNormalization = candidate;
  }
  const adapted = adaptAnthropicMessagesRequest(
    bodyResult.value,
    {
      requireMaxTokens: true,
      ...(unsupportedOutputTokenLimitMode(request) !== undefined
        ? { unsupportedOutputTokenLimitMode: "advisory" as const }
        : {}),
    },
    config.protocol_projection_mode,
  );
  if (!adapted.ok) {
    auditLog("warn", "protocol_projection_rejected", {
      request_id: ingress.requestId,
      protocol: "anthropic-messages",
      projection_mode: config.protocol_projection_mode,
      code: adapted.code,
      param: adapted.param,
    });
    ingress.finalize();
    return anthropicError(400, adapted.message, "invalid_request_error");
  }
  const affinity = anthropicSessionAffinity(
    adapted.value.source,
    dependencies.tenantId,
    config.session_affinity_mode,
    claudeCodeIdentityHeader(request, "x-claude-code-session-id"),
    claudeCodeIdentityHeader(request, "x-claude-code-agent-id"),
  );
  let compatibility: AnthropicCompatibilityOptions = {
    ...(adapted.value.cacheControlCount > 0 ? { cacheControlObserved: true } : {}),
    ...(adapted.value.cacheControlCount > 0
      ? { promptCacheMode: config.kiro_prompt_cache_mode }
      : {}),
    ...(adapted.value.contextManagementRequested ? { contextManagementRequested: true } : {}),
    ...(adapted.value.thinkingDisplay !== undefined
      ? { thinkingDisplay: adapted.value.thinkingDisplay }
      : {}),
    ...(adapted.value.outputTokenLimitMode !== undefined
      ? { outputTokenLimitMode: adapted.value.outputTokenLimitMode }
      : {}),
    ...(adapted.value.reasoningReplayMode !== undefined
      ? { reasoningReplayMode: adapted.value.reasoningReplayMode }
      : {}),
    ...(adapted.value.toolResultImageMode !== undefined
      ? { toolResultImageMode: adapted.value.toolResultImageMode }
      : {}),
  };
  const localStructuredOutputProfile = adapted.value.localStructuredOutputProfile;
  const reportStructuredOutputFailure = (failure: AnthropicStructuredOutputFailure): void => {
    auditLog("warn", "anthropic_structured_output_failed", {
      request_id: ingress.requestId,
      model: adapted.value.body.model,
      stream: adapted.value.source.stream,
      code: failure.code,
    });
  };
  if (localStructuredOutputProfile !== undefined) {
    auditLog("info", "anthropic_structured_output_enforced", {
      request_id: ingress.requestId,
      model: adapted.value.body.model,
      stream: adapted.value.source.stream,
      local_profile: localStructuredOutputProfile.kind,
      schema_hash: auditHash(JSON.stringify(localStructuredOutputProfile.schema)),
      property_hash: auditHash(localStructuredOutputProfile.propertyName),
    });
    compatibility = {
      ...compatibility,
      localStructuredOutputProfile,
      onLocalStructuredOutputFailure: reportStructuredOutputFailure,
    };
  }
  if (adapted.value.cacheControlCount > 0) {
    auditLog("info", "anthropic_cache_control_observed", {
      request_id: ingress.requestId,
      marker_count: adapted.value.cacheControlCount,
      mode: config.kiro_prompt_cache_mode,
    });
  }
  if (adapted.value.reasoningReplayMode === "conflict-omitted") {
    auditLog("warn", "anthropic_reasoning_replay_conflict_omitted", {
      request_id: ingress.requestId,
      model: adapted.value.body.model,
      message_count: adapted.value.reasoningReplayConflictMessages,
      block_count: adapted.value.reasoningReplayConflictBlocks,
    });
  }
  if (adapted.value.toolResultImageMode === "multiple-lifted") {
    auditLog("warn", "anthropic_tool_result_images_multiple_lifted", {
      request_id: ingress.requestId,
      model: adapted.value.body.model,
      message_count: adapted.value.toolResultImageMessages,
      result_count: adapted.value.toolResultImageResults,
      image_count: adapted.value.toolResultImageBlocks,
    });
  }
  if (adapted.value.outputTokenLimitMode === "advisory") {
    auditLog("info", "anthropic_output_token_limit_unenforced", {
      request_id: ingress.requestId,
      model: adapted.value.body.model,
      requested_max_tokens: adapted.value.source.max_tokens,
    });
  }
  const lineage = canonicalSessionLineage(adapted.value.body, dependencies.tenantId);

  let streamOwnsRouteResources = false;
  try {
    ingress.disableIdleTimeout();
    const pipelineResponse = await (dependencies.runPipeline ?? runChatCompletion)({
      ...buildPipelineOptions({
        requestId: ingress.requestId,
        diagnostics: ingress.diagnostics,
        body: adapted.value.body,
        model: adapted.value.body.model,
        stream: adapted.value.source.stream,
        config,
        dependencies,
        affinity,
        lineage,
        deadlineSignal: ingress.signals.combined,
      }),
      ...(clientNormalization ? { clientNormalization } : {}),
      ...(localStructuredOutputProfile !== undefined
        ? {
            maxUpstreamDispatches: 1,
            collectedTextLimit: {
              maxBytes: LOCAL_STRUCTURED_OUTPUT_MAX_BUFFER_BYTES,
              code: "structured_output_buffer_exceeded",
              message: STRUCTURED_OUTPUT_BUFFER_EXCEEDED_MESSAGE,
            },
            unexpectedToolCallFailure: STRUCTURED_OUTPUT_UNEXPECTED_TOOL_CALL_FAILURE,
          }
        : {}),
    });
    // Re-read the live request signal: a client that left while the pipeline
    // ran must not receive a body that would keep the account lease busy.
    if (request.signal.aborted && !ingress.signals.deadline.aborted) {
      void boundedCleanup(() => pipelineResponse.body?.cancel());
      return anthropicIngressErrors.clientClosed();
    }

    const contentType = pipelineResponse.headers.get("Content-Type") ?? "";
    if (!pipelineResponse.ok) {
      if (localStructuredOutputProfile !== undefined) {
        const failure = await structuredOutputPipelineFailure(pipelineResponse);
        if (failure !== undefined) {
          reportStructuredOutputFailure(failure);
          return anthropicError(502, anthropicStructuredOutputFailureMessage(failure), "api_error");
        }
      }
      return await translatePipelineError(await withRetryAfter(pipelineResponse));
    }
    if (pipelineResponse.headers.get("x-kiro-reasoning-replay-mode") === "conflict-omitted") {
      compatibility = {
        ...compatibility,
        reasoningReplayMode: "conflict-omitted",
        outputReasoningOmitted: true,
      };
    }
    if (adapted.value.source.stream) {
      if (!contentType.includes(CANONICAL_OUTPUT_STREAM_MEDIA_TYPE)) {
        void boundedCleanup(() => pipelineResponse.body?.cancel());
        return anthropicError(
          502,
          "Pipeline returned an unsupported streaming response",
          "api_error",
        );
      }
      const streaming = anthropicSseAdapter(pipelineResponse, {
        model: adapted.value.body.model,
        inputTokens: estimateInputTokens(adapted.value.body),
        signals: ingress.signals,
        finalize: ingress.finalize,
        ...compatibility,
      });
      streamOwnsRouteResources = true;
      if (clientNormalization)
        streaming.headers.set("x-kiro-client-normalization", clientNormalization.kind);
      return streaming;
    }
    if (contentType.includes(CANONICAL_OUTPUT_JSON_MEDIA_TYPE)) {
      const completion = parseCanonicalCompletion(await pipelineResponse.json());
      if (completion && completion.model === adapted.value.body.model) {
        const response = anthropicMessageResponse(
          completion,
          adapted.value.body.model,
          compatibility,
        );
        if (clientNormalization)
          response.headers.set("x-kiro-client-normalization", clientNormalization.kind);
        return response;
      }
      return anthropicError(
        502,
        "Pipeline returned an invalid non-streaming response",
        "api_error",
      );
    }
    void boundedCleanup(() => pipelineResponse.body?.cancel());
    return anthropicError(502, "Pipeline returned an unsupported response", "api_error");
  } finally {
    if (!streamOwnsRouteResources) ingress.finalize();
  }
}

export async function handleMessageTokenCount(
  request: Request,
  config: Config,
  requestAdmission?: import("../request-admission.js").RequestAdmissionLease,
): Promise<Response> {
  const ingress = createIngress(request, config, undefined, undefined, requestAdmission);
  try {
    const bodyResult = await readJsonBody(request, config, ingress.signals, anthropicIngressErrors);
    if (!bodyResult.ok) return bodyResult.response;
    const adapted = adaptAnthropicMessagesRequest(
      bodyResult.value,
      unsupportedOutputTokenLimitMode(request) === "advisory"
        ? { unsupportedOutputTokenLimitMode: "advisory" }
        : {},
      config.protocol_projection_mode,
    );
    if (!adapted.ok) {
      return anthropicError(400, adapted.message, "invalid_request_error");
    }
    if (adapted.value.reasoningReplayMode === "conflict-omitted") {
      auditLog("warn", "anthropic_reasoning_replay_conflict_omitted", {
        request_id: ingress.requestId,
        model: adapted.value.body.model,
        message_count: adapted.value.reasoningReplayConflictMessages,
        block_count: adapted.value.reasoningReplayConflictBlocks,
      });
    }
    if (adapted.value.toolResultImageMode === "multiple-lifted") {
      auditLog("warn", "anthropic_tool_result_images_multiple_lifted", {
        request_id: ingress.requestId,
        model: adapted.value.body.model,
        message_count: adapted.value.toolResultImageMessages,
        result_count: adapted.value.toolResultImageResults,
        image_count: adapted.value.toolResultImageBlocks,
      });
    }
    const inputTokens = estimateInputTokens(adapted.value.body);
    return Response.json(
      { input_tokens: inputTokens },
      {
        headers: {
          "x-kiro-token-count-mode": "estimate",
          ...(adapted.value.cacheControlCount > 0
            ? { "x-kiro-prompt-cache-mode": config.kiro_prompt_cache_mode }
            : {}),
          ...(adapted.value.outputTokenLimitMode === "advisory"
            ? { "x-kiro-output-token-limit-mode": "advisory-unenforced" }
            : {}),
          ...(adapted.value.reasoningReplayMode === "conflict-omitted"
            ? { "x-kiro-reasoning-replay-mode": "conflict-omitted" }
            : {}),
          ...(adapted.value.toolResultImageMode === "multiple-lifted"
            ? { "x-kiro-tool-result-image-mode": "multiple-lifted" }
            : {}),
        },
      },
    );
  } finally {
    ingress.finalize();
  }
}
