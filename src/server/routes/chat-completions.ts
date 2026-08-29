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
  parseCanonicalCompletion,
} from "../../protocol/output.js";
import {
  canonicalCompletionToChat,
  canonicalOutputToChatSse,
} from "../chat-output.js";

import { openAiError } from "../errors.js";
import { chatToCanonical } from "../protocol/chat-adapter.js";
import type {
  IngressSignals,
  RequestIdleTimeoutLease,
} from "../request-lifecycle.js";
import { parseChatCompletionRequest } from "../request-schema.js";
import {
  canonicalSessionLineage,
  chatSessionAffinity,
} from "../session-affinity.js";

export type ChatCompletionDependencies = {
  readonly accountManager: PipelineAccountManager;
  readonly tokenRefresher: PipelineTokenRefresher;
  readonly quotaRechecker?: PipelineQuotaRechecker;
  readonly tenantId?: string;
  readonly affinityStore?: PipelineAffinityStore;
  readonly reasoningReplayStore?: PipelineReasoningReplayStore;
  readonly modelCapabilities?: PipelineModelCapabilities;
  readonly makeClient?: PipelineClientFactory;
  readonly createRequestIdleTimeoutLease?: () => RequestIdleTimeoutLease | undefined;
  readonly runPipeline?: (options: RunChatCompletionOptions) => Promise<Response>;
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
        response: openAiError(413, error.message, "invalid_request_error", "request_too_large"),
      };
    }
    if (signals.deadline.aborted) {
      void boundedCleanup(() => reader.cancel(error));
      return {
        ok: false,
        response: openAiError(504, "Request deadline exceeded", "timeout_error", "request_timeout"),
      };
    }
    if (signals.client.aborted) {
      void boundedCleanup(() => reader.cancel(error));
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


export async function handleChatCompletions(
  request: Request,
  config: Config,
  dependencies: ChatCompletionDependencies,
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

  const parsed = parseChatCompletionRequest(raw);
  if (!parsed.ok) {
    clearTimeout(deadlineTimer);
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
    clearTimeout(deadlineTimer);
    return openAiError(
      400,
      canonical.message,
      "invalid_request_error",
      canonical.code,
      canonical.param,
    );
  }
  const lineage = canonicalSessionLineage(canonical.value, dependencies.tenantId);

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
      body: canonical.value,
      model: parsed.value.model,
      stream: parsed.value.stream,
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
      if (
        !completion ||
        completion.model !== parsed.value.model
      ) {
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
      ingressSignals,
      routeFinalize,
      {
        expectedModel: parsed.value.model,
        includeUsage: parsed.value.stream_options?.include_usage === true,
      },
    );
    streamOwnsRouteResources = true;
    return streaming;
  } finally {
    if (!streamOwnsRouteResources) routeFinalize();
  }
}
