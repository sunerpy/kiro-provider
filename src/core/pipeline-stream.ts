import type { SdkStreamResponse } from "../kiro/transform/streaming/sdk-stream-runtime.js";
import { transformSdkStream } from "../kiro/transform/streaming/sdk-stream-transformer.js";
import { abortReason } from "./pipeline-runtime.js";
import { boundedCleanup, runCleanupSteps } from "./stream-cleanup.js";

export interface PipelineStreamResult {
  readonly sdkResponse: SdkStreamResponse;
  readonly model: string;
  readonly conversationId: string;
}

class StreamIdleTimeoutError extends Error {
  readonly name = "StreamIdleTimeoutError";

  constructor(readonly timeoutMs: number) {
    super(`SDK stream idle timeout after ${timeoutMs}ms`);
  }
}

type PipelineOutcome =
  | "normal-complete"
  | "external-abort"
  | "consumer-cancel"
  | "idle-timeout"
  | "upstream-error";

export function createPipelineStreamResponse(
  result: PipelineStreamResult,
  signal: AbortSignal,
  idleTimeoutMs: number,
  finalize: () => void,
): Response {
  const streamAbort = new AbortController();
  const composedSignal = AbortSignal.any([signal, streamAbort.signal]);
  const iterator = transformSdkStream(
    result.sdkResponse,
    result.model,
    result.conversationId,
    composedSignal,
  )[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let terminalOutcome: PipelineOutcome | undefined;
  let activeIdleTimer: ReturnType<typeof setTimeout> | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const clearIdleTimer = (): void => {
    if (activeIdleTimer === undefined) return;
    clearTimeout(activeIdleTimer);
    activeIdleTimer = undefined;
  };
  const claimTerminal = (outcome: PipelineOutcome): boolean => {
    if (terminalOutcome !== undefined) return false;
    terminalOutcome = outcome;
    return true;
  };
  const removeAbortListener = (): void => {
    composedSignal.removeEventListener("abort", onExternalAbort);
  };
  const beginTerminal = (outcome: PipelineOutcome, reason?: unknown): void => {
    if (!claimTerminal(outcome)) return;
    runCleanupSteps(
      removeAbortListener,
      clearIdleTimer,
      () => {
        if (outcome === "normal-complete") streamController?.close();
        else if (outcome !== "consumer-cancel") streamController?.error(reason);
      },
      finalize,
    );
    if (outcome !== "normal-complete" && outcome !== "consumer-cancel") {
      runCleanupSteps(() => {
        if (!streamAbort.signal.aborted) streamAbort.abort(reason);
      });
    }
    void boundedCleanup(() => iterator.return?.(undefined));
  };
  const onExternalAbort = (): void => {
    beginTerminal("external-abort", abortReason(composedSignal));
  };

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        composedSignal.addEventListener("abort", onExternalAbort, { once: true });
        if (composedSignal.aborted) onExternalAbort();
      },
      async pull(controller) {
        if (terminalOutcome !== undefined) return;
        activeIdleTimer = setTimeout(() => {
          activeIdleTimer = undefined;
          const error = new StreamIdleTimeoutError(idleTimeoutMs);
          beginTerminal("idle-timeout", error);
        }, idleTimeoutMs);
        try {
          const next = await iterator.next();
          if (terminalOutcome !== undefined) return;
          clearIdleTimer();
          if (next.done) {
            beginTerminal("normal-complete");
            return;
          }
          controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
        } catch (error) {
          if (terminalOutcome !== undefined) return;
          const streamError =
            error instanceof Error
              ? error
              : new TypeError("SDK stream failed with a non-Error reason", {
                  cause: error,
                });
          beginTerminal("upstream-error", streamError);
        }
      },
      cancel(reason) {
        beginTerminal("consumer-cancel", reason);
      },
    }),
    { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } },
  );
}
