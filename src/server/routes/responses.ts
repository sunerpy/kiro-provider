import { randomUUID } from "node:crypto";
import type { Config } from "../../config/schema.js";
import { auditLog } from "../../core/audit-log.js";
import {
  type PipelineAccountManager,
  type PipelineAffinityStore,
  type PipelineClientFactory,
  type PipelineModelCapabilities,
  type PipelineQuotaRechecker,
  type PipelineReasoningReplayStore,
  type PipelineTokenRefresher,
  type RunChatCompletionOptions,
  runChatCompletion,
} from "../../core/pipeline.js";
import { boundedCleanup, runCleanupSteps } from "../../core/stream-cleanup.js";
import {
  CANONICAL_OUTPUT_JSON_MEDIA_TYPE,
  CANONICAL_OUTPUT_STREAM_MEDIA_TYPE,
  type CanonicalCompletion,
  parseCanonicalCompletion,
} from "../../protocol/output.js";
import { openAiError } from "../errors.js";
import type {
  IngressSignals,
  RequestIdleTimeoutLease,
} from "../request-lifecycle.js";
import { parseResponsesRequest } from "../request-schema.js";
import type {
  MessageOutputItem,
  ReasoningOutputItem,
  ResponseOutputItem,
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

export type ResponsesDependencies = {
  readonly accountManager: PipelineAccountManager;
  readonly tokenRefresher: PipelineTokenRefresher;
  readonly quotaRechecker?: PipelineQuotaRechecker;
  readonly tenantId?: string;
  readonly affinityStore?: PipelineAffinityStore;
  readonly reasoningReplayStore?: PipelineReasoningReplayStore;
  readonly modelCapabilities?: PipelineModelCapabilities;
  readonly makeClient?: PipelineClientFactory;
  readonly runPipeline?: (options: RunChatCompletionOptions) => Promise<Response>;
  readonly createRequestIdleTimeoutLease?: () => RequestIdleTimeoutLease | undefined;
};

type BodyReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly response: Response };

class RequestBodyTooLargeError extends Error {
  readonly name = "RequestBodyTooLargeError";

  constructor(readonly limit: number) {
    super(`Request body exceeds the ${limit} byte limit`);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Request deadline exceeded", "TimeoutError");
}

async function readRequestBody(
  request: Request,
  limit: number,
  signals: IngressSignals,
): Promise<BodyReadResult> {
  const reader = request.body?.getReader();
  if (!reader) return { ok: true, text: "" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectAbort: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    const reason = abortReason(signals.combined);
    rejectAbort?.(reason);
    void reader.cancel(reason);
  };
  signals.combined.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (signals.combined.aborted) throw abortReason(signals.combined);
      const next = await Promise.race([reader.read(), aborted]);
      if (signals.combined.aborted) throw abortReason(signals.combined);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new RequestBodyTooLargeError(limit);
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, text: new TextDecoder().decode(bytes) };
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      void reader.cancel(error).catch(() => undefined);
      return {
        ok: false,
        response: openAiError(413, error.message, "invalid_request_error", "request_too_large"),
      };
    }
    if (signals.deadline.aborted) {
      void reader.cancel(error).catch(() => undefined);
      return {
        ok: false,
        response: openAiError(504, "Request deadline exceeded", "timeout_error", "request_timeout"),
      };
    }
    if (signals.client.aborted) {
      void reader.cancel(error).catch(() => undefined);
      return {
        ok: false,
        response: openAiError(
          499,
          "Client closed request",
          "request_aborted",
          "client_disconnected",
        ),
      };
    }
    throw error;
  } finally {
    signals.combined.removeEventListener("abort", onAbort);
  }
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
      content: [
        { type: "output_text", text: payload.text, annotations: [] },
      ],
    };
    output.push(message);
  }
  output.push(...restored.items);
  return Response.json(
    responseState({
      id: `resp_${randomUUID()}`,
      status: "completed",
      model,
      output,
      usage: {
        input_tokens: payload.usage.inputTokens,
        output_tokens: payload.usage.outputTokens,
        total_tokens: payload.usage.totalTokens,
      } satisfies ResponseUsage,
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
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(new DOMException("Request deadline exceeded", "TimeoutError")),
    config.request_timeout_ms,
  );
  const combinedSignal = AbortSignal.any([deadlineController.signal, request.signal]);
  const ingressSignals: IngressSignals = {
    combined: combinedSignal,
    deadline: deadlineController.signal,
    client: request.signal,
  };
  const bodyResult = await readRequestBody(request, config.max_request_body_bytes, ingressSignals);
  if (!bodyResult.ok) {
    clearTimeout(deadlineTimer);
    return bodyResult.response;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bodyResult.text);
  } catch (error) {
    clearTimeout(deadlineTimer);
    if (!(error instanceof SyntaxError)) throw error;
    return openAiError(
      400,
      "Request body must contain valid JSON",
      "invalid_request_error",
      "invalid_json",
    );
  }

  const parsed = parseResponsesRequest(raw);
  if (!parsed.ok) {
    clearTimeout(deadlineTimer);
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
    clearTimeout(deadlineTimer);
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
  let lease: RequestIdleTimeoutLease | undefined;
  let streamOwnsRouteResources = false;
  const routeFinalize = (): void => {
    runCleanupSteps(
      () => clearTimeout(deadlineTimer),
      () => lease?.restore(),
    );
  };

  try {
    lease = dependencies.createRequestIdleTimeoutLease?.();
    lease?.disable();

    const pipelineResponse = await (dependencies.runPipeline ?? runChatCompletion)({
      body: adapted.body,
      model: adapted.body.model,
      stream,
      config,
      accountManager: dependencies.accountManager,
      tokenRefresher: dependencies.tokenRefresher,
      ...(dependencies.quotaRechecker
        ? { quotaRechecker: dependencies.quotaRechecker }
        : {}),
      ...(affinity ? { affinity } : {}),
      ...(lineage ? { lineage } : {}),
      ...(dependencies.affinityStore
        ? { affinityStore: dependencies.affinityStore }
        : {}),
      tenantId: dependencies.tenantId,
      ...(dependencies.reasoningReplayStore
        ? { reasoningReplayStore: dependencies.reasoningReplayStore }
        : {}),
      ...(dependencies.modelCapabilities
        ? { modelCapabilities: dependencies.modelCapabilities }
        : {}),
      deadlineSignal: combinedSignal,
      ...(dependencies.makeClient ? { makeClient: dependencies.makeClient } : {}),
    });
    if (request.signal.aborted && !deadlineController.signal.aborted) {
      void boundedCleanup(() => pipelineResponse.body?.cancel());
      return openAiError(499, "Client closed request", "request_aborted", "client_disconnected");
    }

    const contentType = pipelineResponse.headers.get("Content-Type") ?? "";
    if (!pipelineResponse.ok) return pipelineResponse;
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
        signals: ingressSignals,
        finalize: routeFinalize,
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
    if (!streamOwnsRouteResources) routeFinalize();
  }
}
