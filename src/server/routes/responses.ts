import { randomUUID } from "node:crypto";
import type { Config } from "../../config/schema.js";
import {
  type PipelineAccountManager,
  type PipelineAffinityStore,
  type PipelineClientFactory,
  type PipelineTokenRefresher,
  type RunChatCompletionOptions,
  runChatCompletion,
} from "../../core/pipeline.js";
import { boundedCleanup, runCleanupSteps } from "../../core/stream-cleanup.js";
import {
  type ChatWireCompletion,
  parseChatWireCompletion,
} from "../chat-wire.js";
import { openAiError } from "../errors.js";
import type {
  IngressSignals,
  RequestIdleTimeoutLease,
} from "../request-lifecycle.js";
import { parseChatCompletionRequest, parseResponsesRequest } from "../request-schema.js";
import type {
  MessageOutputItem,
  ReasoningOutputItem,
  ResponseOutputItem,
  ResponseUsage,
} from "../responses/events.js";
import { responsesToInternalChat } from "../responses/request-adapter.js";
import { responsesSseAdapter } from "../responses/sse-adapter.js";
import type { ResponsesToolBridge } from "../responses/tool-bridge.js";
import { responsesSessionAffinity } from "../session-affinity.js";

export type ResponsesDependencies = {
  readonly accountManager: PipelineAccountManager;
  readonly tokenRefresher: PipelineTokenRefresher;
  readonly tenantId?: string;
  readonly affinityStore?: PipelineAffinityStore;
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
  payload: ChatWireCompletion,
  model: string,
  bridge: ResponsesToolBridge,
): Response {
  const restored = bridge.restoreCalls(
    payload.message.toolCalls.map((call) => ({
      itemId: `fc_${randomUUID()}`,
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    })),
  );
  if (!restored.ok) {
    return openAiError(502, restored.message, "upstream_error", "upstream_protocol_error");
  }
  const output: ResponseOutputItem[] = [];
  if (payload.message.reasoningContent) {
    const reasoning: ReasoningOutputItem = {
      id: `rs_${randomUUID()}`,
      type: "reasoning",
      summary: [{ type: "summary_text", text: payload.message.reasoningContent }],
    };
    output.push(reasoning);
  }
  if (payload.message.content.length > 0) {
    const message: MessageOutputItem = {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: payload.message.content }],
    };
    output.push(message);
  }
  output.push(...restored.items);
  return Response.json({
    id: `resp_${randomUUID()}`,
    object: "response",
    status: "completed",
    model,
    output,
    usage: {
      input_tokens: payload.usage.inputTokens,
      output_tokens: payload.usage.outputTokens,
      total_tokens: payload.usage.totalTokens,
    } satisfies ResponseUsage,
  });
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
  if (
    parsed.value.previous_response_id !== undefined ||
    parsed.value.conversation !== undefined
  ) {
    clearTimeout(deadlineTimer);
    return openAiError(
      400,
      "Stateful Responses continuation is not supported; resend the complete input without previous_response_id or conversation",
      "invalid_request_error",
      "unsupported_stateful_responses",
    );
  }
  const affinity = responsesSessionAffinity(parsed.value, dependencies.tenantId);
  const adapted = responsesToInternalChat(parsed.value);
  if (!adapted.ok) {
    clearTimeout(deadlineTimer);
    const code = adapted.code === "empty_input" ? adapted.code : "invalid_request";
    return openAiError(
      400,
      adapted.message ?? "input produced no messages",
      "invalid_request_error",
      code,
    );
  }
  const internal = parseChatCompletionRequest(adapted.body);
  if (!internal.ok) {
    clearTimeout(deadlineTimer);
    return internal.response;
  }

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
      body: internal.value,
      model: internal.value.model,
      stream,
      config,
      accountManager: dependencies.accountManager,
      tokenRefresher: dependencies.tokenRefresher,
      ...(affinity ? { affinity } : {}),
      ...(dependencies.affinityStore
        ? { affinityStore: dependencies.affinityStore }
        : {}),
      deadlineSignal: combinedSignal,
      ...(dependencies.makeClient ? { makeClient: dependencies.makeClient } : {}),
    });
    if (request.signal.aborted && !deadlineController.signal.aborted) {
      void boundedCleanup(() => pipelineResponse.body?.cancel());
      return openAiError(499, "Client closed request", "request_aborted", "client_disconnected");
    }

    const contentType = pipelineResponse.headers.get("Content-Type") ?? "";
    if (stream && contentType.includes("application/x-ndjson")) {
      const streaming = responsesSseAdapter(pipelineResponse, {
        model: internal.value.model,
        signals: ingressSignals,
        finalize: routeFinalize,
        bridge: adapted.bridge,
      });
      streamOwnsRouteResources = true;
      return streaming;
    }
    if (contentType.includes("application/json")) {
      if (stream || !pipelineResponse.ok) return pipelineResponse;
      const completion: unknown = await pipelineResponse.json();
      const payload = parseChatWireCompletion(completion);
      if (payload) {
        return completedResponse(payload, internal.value.model, adapted.bridge);
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
