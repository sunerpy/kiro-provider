import type { Config } from "../../config/schema.js";
import { auditLog } from "../../core/audit-log.js";
import {
  type PipelineAccountManager,
  type PipelineAffinityStore,
  type PipelineClientFactory,
  type PipelineReasoningReplayStore,
  type PipelineTokenRefresher,
  type RunChatCompletionOptions,
  runChatCompletion,
} from "../../core/pipeline.js";
import { boundedCleanup, runCleanupSteps } from "../../core/stream-cleanup.js";
import { estimateTokens } from "../../kiro/transform/response.js";
import { type AnthropicErrorType, anthropicError } from "../anthropic/errors.js";
import { adaptAnthropicMessagesRequest } from "../anthropic/request-adapter.js";
import {
  anthropicMessageResponse,
  anthropicSseAdapter,
} from "../anthropic/response-adapter.js";
import { parseChatWireCompletion } from "../chat-wire.js";
import type {
  IngressSignals,
  RequestIdleTimeoutLease,
} from "../request-lifecycle.js";
import { anthropicSessionAffinity } from "../session-affinity.js";

export type MessagesDependencies = {
  readonly accountManager: PipelineAccountManager;
  readonly tokenRefresher: PipelineTokenRefresher;
  readonly tenantId?: string;
  readonly affinityStore?: PipelineAffinityStore;
  readonly reasoningReplayStore?: PipelineReasoningReplayStore;
  readonly makeClient?: PipelineClientFactory;
  readonly runPipeline?: (options: RunChatCompletionOptions) => Promise<Response>;
  readonly createRequestIdleTimeoutLease?: () => RequestIdleTimeoutLease | undefined;
};

type BodyReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly response: Response };

type JsonReadResult =
  | { readonly ok: true; readonly value: unknown }
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
    void boundedCleanup(() => reader.cancel(reason));
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
      void boundedCleanup(() => reader.cancel(error));
      return {
        ok: false,
        response: anthropicError(413, error.message, "request_too_large"),
      };
    }
    if (signals.deadline.aborted) {
      void boundedCleanup(() => reader.cancel(error));
      return {
        ok: false,
        response: anthropicError(504, "Request deadline exceeded", "api_error"),
      };
    }
    if (signals.client.aborted) {
      void boundedCleanup(() => reader.cancel(error));
      return {
        ok: false,
        response: anthropicError(499, "Client closed request", "api_error"),
      };
    }
    throw error;
  } finally {
    signals.combined.removeEventListener("abort", onAbort);
  }
}

async function readJsonBody(
  request: Request,
  config: Config,
  signals: IngressSignals,
): Promise<JsonReadResult> {
  const body = await readRequestBody(request, config.max_request_body_bytes, signals);
  if (!body.ok) return body;
  try {
    return { ok: true, value: JSON.parse(body.text) };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return {
      ok: false,
      response: anthropicError(
        400,
        "Request body must contain valid JSON",
        "invalid_request_error",
      ),
    };
  }
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

async function translatePipelineError(response: Response): Promise<Response> {
  let message = `Upstream request failed with HTTP ${response.status}`;
  try {
    const value: unknown = await response.json();
    if (
      typeof value === "object" &&
      value !== null &&
      "error" in value &&
      typeof value.error === "object" &&
      value.error !== null &&
      "message" in value.error &&
      typeof value.error.message === "string"
    ) {
      message = value.error.message;
    }
  } catch {
    // Preserve the status-derived fallback when the upstream body is not JSON.
  }
  return anthropicError(response.status, message, pipelineErrorType(response.status));
}

function createIngress(request: Request, config: Config): {
  readonly signals: IngressSignals;
  readonly finalize: () => void;
} {
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(new DOMException("Request deadline exceeded", "TimeoutError")),
    config.request_timeout_ms,
  );
  return {
    signals: {
      combined: AbortSignal.any([deadlineController.signal, request.signal]),
      deadline: deadlineController.signal,
      client: request.signal,
    },
    finalize: () => clearTimeout(deadlineTimer),
  };
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
  const ingress = createIngress(request, config);
  const bodyResult = await readJsonBody(request, config, ingress.signals);
  if (!bodyResult.ok) {
    ingress.finalize();
    return bodyResult.response;
  }
  const adapted = adaptAnthropicMessagesRequest(bodyResult.value, {
    requireMaxTokens: true,
  }, config.protocol_projection_mode);
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

  let lease: RequestIdleTimeoutLease | undefined;
  let streamOwnsRouteResources = false;
  const routeFinalize = (): void => {
    runCleanupSteps(
      ingress.finalize,
      () => lease?.restore(),
    );
  };

  try {
    lease = dependencies.createRequestIdleTimeoutLease?.();
    lease?.disable();
    const pipelineResponse = await (dependencies.runPipeline ?? runChatCompletion)({
      body: adapted.value.body,
      model: adapted.value.body.model,
      stream: adapted.value.source.stream,
      config,
      accountManager: dependencies.accountManager,
      tokenRefresher: dependencies.tokenRefresher,
      ...(affinity ? { affinity } : {}),
      ...(dependencies.affinityStore
        ? { affinityStore: dependencies.affinityStore }
        : {}),
      tenantId: dependencies.tenantId,
      ...(dependencies.reasoningReplayStore
        ? { reasoningReplayStore: dependencies.reasoningReplayStore }
        : {}),
      deadlineSignal: ingress.signals.combined,
      ...(dependencies.makeClient ? { makeClient: dependencies.makeClient } : {}),
    });
    if (request.signal.aborted && !ingress.signals.deadline.aborted) {
      void boundedCleanup(() => pipelineResponse.body?.cancel());
      return anthropicError(499, "Client closed request", "api_error");
    }

    const contentType = pipelineResponse.headers.get("Content-Type") ?? "";
    if (!pipelineResponse.ok) return await translatePipelineError(pipelineResponse);
    if (
      adapted.value.source.stream &&
      contentType.includes("application/x-ndjson")
    ) {
      const streaming = anthropicSseAdapter(pipelineResponse, {
        model: adapted.value.body.model,
        inputTokens: estimateInputTokens(adapted.value.body),
        signals: ingress.signals,
        finalize: routeFinalize,
      });
      streamOwnsRouteResources = true;
      return streaming;
    }
    if (contentType.includes("application/json")) {
      if (adapted.value.source.stream) {
        return anthropicError(
          502,
          "Pipeline returned a non-streaming response for a streaming request",
          "api_error",
        );
      }
      const completion = parseChatWireCompletion(await pipelineResponse.json());
      if (completion) {
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
    if (!streamOwnsRouteResources) routeFinalize();
  }
}

export async function handleMessageTokenCount(
  request: Request,
  config: Config,
): Promise<Response> {
  const ingress = createIngress(request, config);
  try {
    const bodyResult = await readJsonBody(request, config, ingress.signals);
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
