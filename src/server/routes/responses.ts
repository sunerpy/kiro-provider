import { randomUUID } from "node:crypto";
import type { Config } from "../../config/schema.js";
import { auditLog } from "../../core/audit-log.js";
import { runChatCompletion } from "../../core/pipeline.js";
import { boundedCleanup } from "../../core/stream-cleanup.js";
import {
  CANONICAL_OUTPUT_JSON_MEDIA_TYPE,
  CANONICAL_OUTPUT_STREAM_MEDIA_TYPE,
  type CanonicalCompletion,
  type CanonicalOutputUsage,
  parseCanonicalCompletion,
} from "../../protocol/output.js";
import { openAiError } from "../errors.js";
import {
  buildPipelineOptions,
  createIngress,
  openAiIngressErrors,
  type RouteDependencies,
  readJsonBody,
  withRetryAfter,
} from "../ingress.js";
import { parseResponsesRequest } from "../request-schema.js";
import type {
  MessageOutputItem,
  OutputTextContent,
  ReasoningOutputItem,
  ResponseOutputItem,
  ResponseToolCallItem,
  ResponseUsage,
} from "../responses/events.js";
import { isGptSolReasoningPlaceholder } from "../responses/reasoning.js";
import { adaptResponsesRequest } from "../responses/request-adapter.js";
import { responsesSseAdapter } from "../responses/sse-adapter.js";
import {
  type ResponseRequestConfiguration,
  responseConfigurationFromCanonical,
  responseState,
} from "../responses/state.js";
import type { ResponsesToolBridge } from "../responses/tool-bridge.js";
import {
  canonicalSessionLineage,
  responsesSessionAffinity,
} from "../session-affinity.js";

export type ResponsesDependencies = RouteDependencies;

/**
 * Responses `usage` from a canonical completion. Kiro reports no cache or
 * reasoning token split, so the detail objects the Responses API always
 * carries are present with zero counts rather than omitted.
 */
export function responsesUsage(usage: CanonicalOutputUsage): ResponseUsage {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
}

/** A completed `output_text` part with the always-present empty `logprobs`. */
export function outputTextContent(
  text: string,
): OutputTextContent & { readonly logprobs: readonly [] } {
  return { type: "output_text", text, annotations: [], logprobs: [] };
}

/** Restored tool-call items are terminal in a non-stream response. */
export function completedToolCallItems(
  items: readonly ResponseToolCallItem[],
): readonly ResponseToolCallItem[] {
  return items.map((item) => ({ ...item, status: "completed" as const }));
}

function completedResponse(
  payload: CanonicalCompletion,
  model: string,
  bridge: ResponsesToolBridge,
  configuration: ResponseRequestConfiguration,
): Response {
  const restored = bridge.restoreCalls(
    payload.toolCalls.map((call) => ({
      itemId: `fc_${randomUUID()}`,
      id: call.id,
      name: call.name,
      arguments: call.input,
    })),
  );
  if (!restored.ok) {
    return openAiError(502, restored.message, "upstream_error", "upstream_protocol_error");
  }
  const output: ResponseOutputItem[] = [];
  const reasoningText = payload.reasoning?.text;
  const reasoningSummary =
    reasoningText !== undefined &&
    !isGptSolReasoningPlaceholder(model, reasoningText)
      ? [{ type: "summary_text" as const, text: reasoningText }]
      : [];
  if (reasoningSummary.length > 0 || payload.reasoning?.encryptedContent) {
    const reasoning: ReasoningOutputItem = {
      id: `rs_${randomUUID()}`,
      type: "reasoning",
      summary: reasoningSummary,
      ...(payload.reasoning?.encryptedContent
        ? { encrypted_content: payload.reasoning.encryptedContent }
        : {}),
    };
    output.push(reasoning);
  }
  if (payload.text.length > 0) {
    const message: MessageOutputItem = {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [outputTextContent(payload.text)],
    };
    output.push(message);
  }
  output.push(...completedToolCallItems(restored.items));
  return Response.json(
    responseState({
      id: `resp_${randomUUID()}`,
      status: "completed",
      model,
      output,
      usage: responsesUsage(payload.usage),
      configuration,
    }),
  );
}

// allow: SIZE_OK — mirrors the established ingress boundary and owns one response conversion.
export async function handleResponses(
  request: Request,
  config: Config,
  dependencies: ResponsesDependencies,
): Promise<Response> {
  const ingress = createIngress(request, config, dependencies.createRequestIdleTimeoutLease);
  const bodyResult = await readJsonBody(request, config, ingress.signals, openAiIngressErrors);
  if (!bodyResult.ok) {
    ingress.finalize();
    return bodyResult.response;
  }

  const parsed = parseResponsesRequest(bodyResult.value);
  if (!parsed.ok) {
    ingress.finalize();
    return parsed.response;
  }
  const affinity = responsesSessionAffinity(
    parsed.value,
    dependencies.tenantId,
    config.session_affinity_mode,
  );
  const adapted = adaptResponsesRequest(
    parsed.value,
    config.protocol_projection_mode,
  );
  if (!adapted.ok) {
    auditLog("warn", "protocol_projection_rejected", {
      protocol: "responses",
      projection_mode: config.protocol_projection_mode,
      code: adapted.code,
      param: adapted.param,
    });
    ingress.finalize();
    return openAiError(
      400,
      adapted.message ?? "input produced no messages",
      "invalid_request_error",
      adapted.code,
      adapted.param,
    );
  }
  const responseConfiguration = responseConfigurationFromCanonical(adapted.body);
  const lineage = canonicalSessionLineage(adapted.body, dependencies.tenantId);

  const stream = parsed.value.stream;
  let streamOwnsRouteResources = false;
  try {
    ingress.disableIdleTimeout();

    const pipelineResponse = await (dependencies.runPipeline ?? runChatCompletion)(
      buildPipelineOptions({
        body: adapted.body,
        model: adapted.body.model,
        stream,
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
      return openAiIngressErrors.clientClosed();
    }

    const contentType = pipelineResponse.headers.get("Content-Type") ?? "";
    if (!pipelineResponse.ok) return await withRetryAfter(pipelineResponse);
    if (stream) {
      if (!contentType.includes(CANONICAL_OUTPUT_STREAM_MEDIA_TYPE)) {
        void boundedCleanup(() => pipelineResponse.body?.cancel());
        return openAiError(
          500,
          "Pipeline returned an unsupported streaming response",
          "internal_error",
          "invalid_pipeline_response",
        );
      }
      const streaming = responsesSseAdapter(pipelineResponse, {
        model: adapted.body.model,
        signals: ingress.signals,
        finalize: ingress.finalize,
        bridge: adapted.bridge,
        configuration: responseConfiguration,
        includeEncryptedReasoning: adapted.body.includeEncryptedReasoning,
      });
      streamOwnsRouteResources = true;
      return streaming;
    }
    if (contentType.includes(CANONICAL_OUTPUT_JSON_MEDIA_TYPE)) {
      const payload = parseCanonicalCompletion(await pipelineResponse.json());
      if (payload && payload.model === adapted.body.model) {
        return completedResponse(
          payload,
          adapted.body.model,
          adapted.bridge,
          responseConfiguration,
        );
      }
      return openAiError(
        500,
        "Pipeline returned an invalid non-streaming response",
        "internal_error",
        "invalid_pipeline_response",
      );
    }
    void boundedCleanup(() => pipelineResponse.body?.cancel());
    return openAiError(
      500,
      "Pipeline returned an unsupported response",
      "internal_error",
      "invalid_pipeline_response",
    );
  } finally {
    if (!streamOwnsRouteResources) ingress.finalize();
  }
}
