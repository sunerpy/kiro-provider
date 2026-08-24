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
import { openAiError } from "../errors.js";
import type {
  IngressSignals,
  RequestIdleTimeoutLease,
} from "../request-lifecycle.js";
import { parseChatCompletionRequest } from "../request-schema.js";
import { chatSessionAffinity } from "../session-affinity.js";

export type ChatCompletionDependencies = {
  readonly accountManager: PipelineAccountManager;
  readonly tokenRefresher: PipelineTokenRefresher;
  readonly tenantId?: string;
  readonly affinityStore?: PipelineAffinityStore;
  readonly makeClient?: PipelineClientFactory;
  readonly createRequestIdleTimeoutLease?: () => RequestIdleTimeoutLease | undefined;
  readonly runPipeline?: (options: RunChatCompletionOptions) => Promise<Response>;
};

type BodyReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly response: Response };

type ChatAdapterOutcome =
  | "normal-complete"
  | "deadline"
  | "client-abort"
  | "consumer-cancel"
  | "upstream-error";

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

export function ndjsonToSse(
  response: Response,
  signals: IngressSignals,
  finalize: () => void,
): Response {
  const upstream = response.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let terminalOutcome: ChatAdapterOutcome | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const errorFrame = encoder.encode(
    `data: ${JSON.stringify({
      error: {
        message: "Upstream stream error",
        type: "upstream_error",
      },
    })}\n\n`,
  );
  const claimTerminal = (outcome: ChatAdapterOutcome): boolean => {
    if (terminalOutcome !== undefined) return false;
    terminalOutcome = outcome;
    return true;
  };
  const removeDeadlineListener = (): void => {
    signals.deadline.removeEventListener("abort", onDeadlineAbort);
  };
  const removeClientListener = (): void => {
    signals.client.removeEventListener("abort", onClientAbort);
  };
  const beginTerminal = (outcome: ChatAdapterOutcome, reason?: unknown): void => {
    if (!claimTerminal(outcome)) return;
    runCleanupSteps(
      removeDeadlineListener,
      removeClientListener,
      () => {
        if (outcome === "normal-complete") {
          streamController?.enqueue(encoder.encode("data: [DONE]\n\n"));
        } else if (outcome === "deadline" || outcome === "upstream-error") {
          streamController?.enqueue(errorFrame);
        }
      },
      () => {
        if (outcome !== "consumer-cancel") streamController?.close();
      },
      finalize,
    );
    void boundedCleanup(() => reader.cancel(reason));
  };
  const onDeadlineAbort = (): void => {
    beginTerminal(
      "deadline",
      signals.deadline.reason instanceof Error
        ? signals.deadline.reason
        : new DOMException("Request deadline exceeded", "TimeoutError"),
    );
  };
  const onClientAbort = (): void => {
    beginTerminal(
      "client-abort",
      signals.client.reason instanceof Error
        ? signals.client.reason
        : new DOMException("Client closed request", "AbortError"),
    );
  };

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        signals.deadline.addEventListener("abort", onDeadlineAbort, { once: true });
        signals.client.addEventListener("abort", onClientAbort, { once: true });
        if (signals.deadline.aborted) onDeadlineAbort();
        else if (signals.client.aborted) onClientAbort();
      },
      async pull(controller) {
        if (terminalOutcome !== undefined) return;
        try {
          while (true) {
            if (terminalOutcome !== undefined) return;
            const newline = buffer.indexOf("\n");
            if (newline >= 0) {
              const line = buffer.slice(0, newline).trimEnd();
              buffer = buffer.slice(newline + 1);
              if (line.length > 0) {
                controller.enqueue(encoder.encode(`data: ${line}\n\n`));
                return;
              }
              continue;
            }

            const next = await reader.read();
            if (terminalOutcome !== undefined) return;
            if (!next.done) {
              buffer += decoder.decode(next.value, { stream: true });
              continue;
            }

            buffer += decoder.decode();
            const finalLine = buffer.trim();
            buffer = "";
            if (finalLine.length > 0) {
              controller.enqueue(encoder.encode(`data: ${finalLine}\n\n`));
              return;
            }
            beginTerminal("normal-complete");
            return;
          }
        } catch (error) {
          if (terminalOutcome !== undefined) return;
          beginTerminal("upstream-error", error);
        }
      },
      cancel(reason) {
        beginTerminal("consumer-cancel", reason);
      },
    }),
    {
      status: response.status,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    },
  );
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
  const affinity = chatSessionAffinity(parsed.value, dependencies.tenantId);

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
      body: parsed.value,
      model: parsed.value.model,
      stream: parsed.value.stream,
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
    if (!parsed.value.stream || contentType.includes("application/json")) {
      return pipelineResponse;
    }
    if (!contentType.includes("application/x-ndjson")) {
      void boundedCleanup(() => pipelineResponse.body?.cancel());
      return openAiError(
        500,
        "Pipeline returned an unsupported streaming response",
        "internal_error",
        "invalid_pipeline_response",
      );
    }
    const streaming = ndjsonToSse(pipelineResponse, ingressSignals, routeFinalize);
    streamOwnsRouteResources = true;
    return streaming;
  } finally {
    if (!streamOwnsRouteResources) routeFinalize();
  }
}
