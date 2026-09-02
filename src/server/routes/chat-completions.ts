import type { Config } from "../../config/schema.js";
import { auditLog } from "../../core/audit-log.js";
import { runChatCompletion } from "../../core/pipeline.js";
import { boundedCleanup } from "../../core/stream-cleanup.js";
import {
  CANONICAL_OUTPUT_JSON_MEDIA_TYPE,
  CANONICAL_OUTPUT_STREAM_MEDIA_TYPE,
  parseCanonicalCompletion,
} from "../../protocol/output.js";
import { canonicalCompletionToChat, canonicalOutputToChatSse } from "../chat-output.js";
import { openAiError } from "../errors.js";
import {
  buildPipelineOptions,
  createIngress,
  openAiIngressErrors,
  type RouteDependencies,
  readJsonBody,
  withRetryAfter,
} from "../ingress.js";
import { chatToCanonical } from "../protocol/chat-adapter.js";
import { parseChatCompletionRequest } from "../request-schema.js";
import { canonicalSessionLineage, chatSessionAffinity } from "../session-affinity.js";

export type ChatCompletionDependencies = RouteDependencies;

export async function handleChatCompletions(
  request: Request,
  config: Config,
  dependencies: ChatCompletionDependencies,
): Promise<Response> {
  const ingress = createIngress(request, config, dependencies.createRequestIdleTimeoutLease);
  const bodyResult = await readJsonBody(request, config, ingress.signals, openAiIngressErrors);
  if (!bodyResult.ok) {
    ingress.finalize();
    return bodyResult.response;
  }

  const parsed = parseChatCompletionRequest(bodyResult.value);
  if (!parsed.ok) {
    ingress.finalize();
    return parsed.response;
  }
  const affinity = chatSessionAffinity(
    parsed.value,
    dependencies.tenantId,
    config.session_affinity_mode,
  );
  const canonical = chatToCanonical(parsed.value, config.protocol_projection_mode);
  if (!canonical.ok) {
    auditLog("warn", "protocol_projection_rejected", {
      protocol: "chat-completions",
      projection_mode: config.protocol_projection_mode,
      code: canonical.code,
      param: canonical.param,
    });
    ingress.finalize();
    return openAiError(
      400,
      canonical.message,
      "invalid_request_error",
      canonical.code,
      canonical.param,
    );
  }
  const lineage = canonicalSessionLineage(canonical.value, dependencies.tenantId);

  let streamOwnsRouteResources = false;
  try {
    ingress.disableIdleTimeout();

    const pipelineResponse = await (dependencies.runPipeline ?? runChatCompletion)(
      buildPipelineOptions({
        body: canonical.value,
        model: parsed.value.model,
        stream: parsed.value.stream,
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
    if (!parsed.value.stream) {
      if (!contentType.includes(CANONICAL_OUTPUT_JSON_MEDIA_TYPE)) {
        void boundedCleanup(() => pipelineResponse.body?.cancel());
        return openAiError(
          500,
          "Pipeline returned an unsupported non-streaming response",
          "internal_error",
          "invalid_pipeline_response",
        );
      }
      const completion = parseCanonicalCompletion(await pipelineResponse.json());
      if (!completion || completion.model !== parsed.value.model) {
        return openAiError(
          500,
          "Pipeline returned an invalid canonical completion",
          "internal_error",
          "invalid_pipeline_response",
        );
      }
      return canonicalCompletionToChat(completion);
    }
    if (!contentType.includes(CANONICAL_OUTPUT_STREAM_MEDIA_TYPE)) {
      void boundedCleanup(() => pipelineResponse.body?.cancel());
      return openAiError(
        500,
        "Pipeline returned an unsupported streaming response",
        "internal_error",
        "invalid_pipeline_response",
      );
    }
    const streaming = canonicalOutputToChatSse(
      pipelineResponse,
      ingress.signals,
      ingress.finalize,
      {
        expectedModel: parsed.value.model,
        includeUsage: parsed.value.stream_options?.include_usage === true,
      },
    );
    streamOwnsRouteResources = true;
    return streaming;
  } finally {
    if (!streamOwnsRouteResources) ingress.finalize();
  }
}
