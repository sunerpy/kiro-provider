import type { Config } from "../../config/schema.js";
import { auditLog } from "../../core/audit-log.js";
import { runChatCompletion } from "../../core/pipeline.js";
import { boundedCleanup } from "../../core/stream-cleanup.js";
import { estimateTokens } from "../../kiro/transform/response.js";
import {
  CANONICAL_OUTPUT_JSON_MEDIA_TYPE,
  CANONICAL_OUTPUT_STREAM_MEDIA_TYPE,
  parseCanonicalCompletion,
} from "../../protocol/output.js";
import { type AnthropicErrorType, anthropicError } from "../anthropic/errors.js";
import { adaptAnthropicMessagesRequest } from "../anthropic/request-adapter.js";
import { anthropicMessageResponse, anthropicSseAdapter } from "../anthropic/response-adapter.js";
import {
  anthropicIngressErrors,
  buildPipelineOptions,
  createIngress,
  type RouteDependencies,
  readJsonBody,
  withRetryAfter,
} from "../ingress.js";
import { anthropicSessionAffinity, canonicalSessionLineage } from "../session-affinity.js";

export type MessagesDependencies = RouteDependencies;

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

function estimateInputTokens(value: unknown): number {
  return Math.max(1, estimateTokens(JSON.stringify(value)));
}

// allow: SIZE_OK — owns one protocol boundary and its request-scoped resources.
export async function handleMessages(
  request: Request,
  config: Config,
  dependencies: MessagesDependencies,
): Promise<Response> {
  const ingress = createIngress(request, config, dependencies.createRequestIdleTimeoutLease);
  const bodyResult = await readJsonBody(request, config, ingress.signals, anthropicIngressErrors);
  if (!bodyResult.ok) {
    ingress.finalize();
    return bodyResult.response;
  }
  const adapted = adaptAnthropicMessagesRequest(
    bodyResult.value,
    {
      requireMaxTokens: true,
    },
    config.protocol_projection_mode,
  );
  if (!adapted.ok) {
    auditLog("warn", "protocol_projection_rejected", {
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
  );
  const lineage = canonicalSessionLineage(adapted.value.body, dependencies.tenantId);

  let streamOwnsRouteResources = false;
  try {
    ingress.disableIdleTimeout();
    const pipelineResponse = await (dependencies.runPipeline ?? runChatCompletion)(
      buildPipelineOptions({
        body: adapted.value.body,
        model: adapted.value.body.model,
        stream: adapted.value.source.stream,
        config,
        dependencies,
        affinity,
        lineage,
        deadlineSignal: ingress.signals.combined,
      }),
    );
    // Re-read the live request signal: a client that left while the pipeline
    // ran must not receive a body that would keep the account lease busy.
    if (request.signal.aborted && !ingress.signals.deadline.aborted) {
      void boundedCleanup(() => pipelineResponse.body?.cancel());
      return anthropicIngressErrors.clientClosed();
    }

    const contentType = pipelineResponse.headers.get("Content-Type") ?? "";
    if (!pipelineResponse.ok) {
      return await translatePipelineError(await withRetryAfter(pipelineResponse));
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
      });
      streamOwnsRouteResources = true;
      return streaming;
    }
    if (contentType.includes(CANONICAL_OUTPUT_JSON_MEDIA_TYPE)) {
      const completion = parseCanonicalCompletion(await pipelineResponse.json());
      if (completion && completion.model === adapted.value.body.model) {
        return anthropicMessageResponse(completion, adapted.value.body.model);
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

export async function handleMessageTokenCount(request: Request, config: Config): Promise<Response> {
  const ingress = createIngress(request, config);
  try {
    const bodyResult = await readJsonBody(request, config, ingress.signals, anthropicIngressErrors);
    if (!bodyResult.ok) return bodyResult.response;
    const adapted = adaptAnthropicMessagesRequest(
      bodyResult.value,
      {},
      config.protocol_projection_mode,
    );
    if (!adapted.ok) {
      return anthropicError(400, adapted.message, "invalid_request_error");
    }
    const inputTokens = estimateInputTokens(adapted.value.body);
    return Response.json(
      { input_tokens: inputTokens },
      { headers: { "x-kiro-token-count-mode": "estimate" } },
    );
  } finally {
    ingress.finalize();
  }
}
