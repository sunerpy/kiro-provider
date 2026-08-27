import { transformSdkOutputStream } from "../kiro/transform/streaming/sdk-output-transformer.js";
import type {
  SdkOutputFingerprint,
  SdkReasoningCaptureHandler,
  SdkStreamResponse,
} from "../kiro/transform/streaming/sdk-stream-runtime.js";
import { CANONICAL_OUTPUT_STREAM_CONTENT_TYPE } from "../protocol/output.js";
import { auditHash, auditLog } from "./audit-log.js";
import { abortReason } from "./pipeline-runtime.js";
import { boundedCleanup, runCleanupSteps } from "./stream-cleanup.js";

export interface PipelineStreamResult {
  readonly sdkResponse: SdkStreamResponse;
  readonly model: string;
  readonly conversationId: string;
  readonly captureReasoning?: SdkReasoningCaptureHandler;
  readonly emitEncryptedReasoning?: boolean;
  readonly emitAnthropicReasoningMetadata?: boolean;
  readonly fingerprintOutput?: SdkOutputFingerprint;
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
  const eventTypeCounts = new Map<string, number>();
  let rawEventCount = 0;
  let lastEventType: string | undefined;
  const eventTypeCountsJson = (): string =>
    JSON.stringify(Object.fromEntries([...eventTypeCounts.entries()].sort()));
  const streamAuditFields = (): Readonly<
    Record<string, string | number | undefined>
  > => ({
    model: result.model,
    conversation_hash: auditHash(result.conversationId),
    raw_event_count: rawEventCount,
    last_event_type: lastEventType,
    event_type_counts: eventTypeCountsJson(),
  });
  const streamAbort = new AbortController();
  const composedSignal = AbortSignal.any([signal, streamAbort.signal]);
  const iterator = transformSdkOutputStream(
    result.sdkResponse,
    result.model,
    result.conversationId,
    composedSignal,
    {
      ...(result.captureReasoning
        ? { captureReasoning: result.captureReasoning }
        : {}),
      emitEncryptedReasoning: result.emitEncryptedReasoning,
      emitAnthropicReasoningMetadata: result.emitAnthropicReasoningMetadata,
      ...(result.fingerprintOutput
        ? { fingerprintOutput: result.fingerprintOutput }
        : {}),
      onCompletionMetadata: () => {
        auditLog("info", "sdk_stream_completion_metadata_terminal", {
          model: result.model,
          conversation_hash: auditHash(result.conversationId),
        });
      },
      onRawEvent: (eventTypes) => {
        rawEventCount += 1;
        lastEventType = eventTypes.join("+");
        for (const eventType of eventTypes) {
          eventTypeCounts.set(eventType, (eventTypeCounts.get(eventType) ?? 0) + 1);
        }
      },
    },
  )[Symbol.asyncIterator]();
  let initialNext: ReturnType<typeof iterator.next> | undefined = iterator.next();
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
          auditLog("warn", "sdk_stream_idle_timeout", {
            ...streamAuditFields(),
            idle_timeout_ms: idleTimeoutMs,
          });
          beginTerminal("idle-timeout", error);
        }, idleTimeoutMs);
        try {
          const nextPromise = initialNext ?? iterator.next();
          initialNext = undefined;
          const next = await nextPromise;
          if (terminalOutcome !== undefined) return;
          clearIdleTimer();
          if (next.done) {
            auditLog("info", "sdk_stream_completed", streamAuditFields());
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
          auditLog("warn", "sdk_stream_upstream_error", {
            ...streamAuditFields(),
            error_type: streamError.name,
          });
          beginTerminal("upstream-error", streamError);
        }
      },
      cancel(reason) {
        beginTerminal("consumer-cancel", reason);
      },
    }),
    { headers: { "Content-Type": CANONICAL_OUTPUT_STREAM_CONTENT_TYPE } },
  );
}
