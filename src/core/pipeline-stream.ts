import {
  type ToolCallProgress,
  transformSdkOutputStream,
} from "../kiro/transform/streaming/sdk-output-transformer.js";
import type {
  SdkOutputCaptureHandler,
  SdkOutputFingerprint,
  SdkReasoningCaptureHandler,
  SdkStreamResponse,
} from "../kiro/transform/streaming/sdk-stream-runtime.js";
import type { Effort } from "../kiro/types.js";
import {
  CANONICAL_OUTPUT_STREAM_CONTENT_TYPE,
  type CanonicalOutputEvent,
} from "../protocol/output.js";
import { auditHash, auditLog } from "./audit-log.js";
import { abortReason } from "./pipeline-runtime.js";
import { boundedCleanup, runCleanupSteps } from "./stream-cleanup.js";
import { streamErrorAuditFields } from "./stream-error.js";

export interface PipelineStreamResult {
  readonly sdkResponse: SdkStreamResponse;
  readonly model: string;
  readonly conversationId: string;
  readonly telemetryContext?: StreamTelemetryContext;
  readonly captureReasoning?: SdkReasoningCaptureHandler;
  readonly emitEncryptedReasoning?: boolean;
  readonly emitAnthropicReasoningMetadata?: boolean;
  readonly fingerprintOutput?: SdkOutputFingerprint;
  readonly captureOutput?: SdkOutputCaptureHandler;
  /**
   * Aborts the upstream HTTP request behind sdkResponse. Invoked for every
   * abnormal terminal outcome; never for a normal completion.
   */
  readonly abortUpstream?: (reason?: unknown) => void;
  /**
   * Canonical stream the pipeline already opened and prefetched up to the
   * first semantic event (pre-publication retry). When absent the response
   * opens the stream itself.
   */
  readonly prepared?: PreparedCanonicalStream;
}

export class StreamIdleTimeoutError extends Error {
  readonly name = "StreamIdleTimeoutError";
  readonly code = "upstream_stream_idle_timeout";

  constructor(readonly timeoutMs: number) {
    super(`SDK stream idle timeout after ${timeoutMs}ms`);
  }
}

export type StreamTerminalProvenance =
  | "normal_complete"
  | "idle_timeout"
  | "upstream_error"
  | "consumer_cancel"
  | "external_abort";

export type StreamTelemetryMode = "stream" | "non-stream";

export type CompletionWitnessKind = "token-usage-metadata" | "metering-clean-eof";

type AuditFields = Readonly<Record<string, string | number | boolean | undefined>>;

export interface StreamTelemetryContext {
  readonly requestId?: string;
  readonly attempt?: number;
  readonly effort?: Effort;
  readonly accountHash?: string;
}

const SEMANTIC_EVENT_TYPES: ReadonlySet<CanonicalOutputEvent["type"]> = new Set<
  CanonicalOutputEvent["type"]
>(["reasoning_delta", "reasoning_redacted", "text_delta", "tool_call_delta", "completed"]);

/**
 * A semantic event is the first canonical event a client could act on. The
 * pipeline never retries an attempt once one has been produced, even if it
 * only sits in the prefetch buffer.
 */
export function isSemanticOutputEvent(event: CanonicalOutputEvent): boolean {
  return SEMANTIC_EVENT_TYPES.has(event.type);
}

/**
 * Per attempt-stream counters shared by the prefetch phase, the streaming
 * response, and the non-stream collector. Counts only, never content.
 */
export class StreamTelemetry {
  private readonly eventTypeCounts = new Map<string, number>();
  private rawEventCount = 0;
  private lastEventType: string | undefined;
  private canonicalEventCount = 0;
  private reasoningChars = 0;
  private visibleChars = 0;
  private toolCount = 0;
  private reasoningRedacted = false;
  private reasoningSigned = false;
  private reasoningEncrypted = false;
  private openToolIntents = 0;
  private witnessKind: CompletionWitnessKind | undefined;
  private completed: Extract<CanonicalOutputEvent, { readonly type: "completed" }> | undefined;
  private terminalEmitted = false;
  private semantic = false;

  constructor(
    readonly model: string,
    readonly conversationId: string,
    readonly mode: StreamTelemetryMode,
    private readonly context: StreamTelemetryContext = {},
  ) {}

  /** True once any semantic event was observed on this attempt-stream. */
  get semanticSeen(): boolean {
    return this.semantic;
  }

  get completionWitnessed(): boolean {
    return this.witnessKind !== undefined;
  }

  observeCanonicalEvent(event: CanonicalOutputEvent): void {
    this.canonicalEventCount += 1;
    if (isSemanticOutputEvent(event)) this.semantic = true;
    switch (event.type) {
      case "reasoning_delta":
        this.reasoningChars += event.text.length;
        break;
      case "reasoning_redacted":
        this.reasoningRedacted = true;
        break;
      case "reasoning_signature":
        this.reasoningSigned = true;
        break;
      case "reasoning_encrypted":
        this.reasoningEncrypted = true;
        break;
      case "text_delta":
        this.visibleChars += event.text.length;
        break;
      case "tool_call_delta":
        this.toolCount += 1;
        break;
      case "completed":
        this.completed = event;
        break;
      case "started":
        break;
    }
  }

  onRawEvent(eventTypes: readonly string[]): void {
    this.rawEventCount += 1;
    this.lastEventType = eventTypes.join("+");
    for (const eventType of eventTypes) {
      this.eventTypeCounts.set(eventType, (this.eventTypeCounts.get(eventType) ?? 0) + 1);
    }
  }

  onCompletionWitness(kind: CompletionWitnessKind): void {
    this.witnessKind = kind;
    auditLog("info", "sdk_stream_completion_witness", {
      request_id: this.context.requestId,
      attempt: this.context.attempt,
      model: this.model,
      conversation_hash: auditHash(this.conversationId),
      effort: this.context.effort,
      account_hash: this.context.accountHash,
      witness_kind: kind,
      mode: this.mode,
    });
  }

  onToolCallProgress(progress: ToolCallProgress): void {
    this.openToolIntents = progress.open;
  }

  /**
   * A completion that carried no reasoning, no visible text, and no tool call.
   * Signed, redacted, or encrypted reasoning envelopes count as reasoning.
   */
  isEmptyCompletion(): boolean {
    return (
      this.completed !== undefined &&
      this.completionWitnessed &&
      this.reasoningChars === 0 &&
      this.visibleChars === 0 &&
      this.toolCount === 0 &&
      !this.reasoningRedacted &&
      !this.reasoningSigned &&
      !this.reasoningEncrypted
    );
  }

  auditFields(): AuditFields {
    return {
      request_id: this.context.requestId,
      attempt: this.context.attempt,
      model: this.model,
      conversation_hash: auditHash(this.conversationId),
      effort: this.context.effort,
      account_hash: this.context.accountHash,
      mode: this.mode,
      raw_event_count: this.rawEventCount,
      last_event_type: this.lastEventType,
      event_type_counts: JSON.stringify(
        Object.fromEntries([...this.eventTypeCounts.entries()].sort()),
      ),
    };
  }

  terminalFields(provenance: StreamTerminalProvenance): AuditFields {
    return {
      ...this.auditFields(),
      terminal_provenance: provenance,
      completion_witnessed: this.completionWitnessed,
      witness_kind: this.witnessKind,
      canonical_event_count: this.canonicalEventCount,
      reasoning_chars: this.reasoningChars,
      visible_chars: this.visibleChars,
      tool_count: this.toolCount,
      tool_intent_open: this.openToolIntents > 0,
      reasoning_redacted: this.reasoningRedacted,
      finish_reason: this.completed?.finishReason,
      // Kiro exposes no stop marker: every canonical finishReason is derived
      // from the tool count. Present only when a completed event exists.
      finish_reason_synthesized: this.completed === undefined ? undefined : true,
    };
  }

  /** Emits `sdk_stream_terminal` exactly once per attempt-stream. */
  emitTerminal(provenance: StreamTerminalProvenance): boolean {
    if (this.terminalEmitted) return false;
    this.terminalEmitted = true;
    auditLog("info", "sdk_stream_terminal", this.terminalFields(provenance));
    return true;
  }
}

export function createStreamTelemetry(
  model: string,
  conversationId: string,
  mode: StreamTelemetryMode,
  context: StreamTelemetryContext = {},
): StreamTelemetry {
  return new StreamTelemetry(model, conversationId, mode, context);
}

export interface PreparedCanonicalStream {
  readonly iterator: AsyncGenerator<CanonicalOutputEvent>;
  /** Aborting this makes the transformer's pending upstream read resolve at once. */
  readonly streamAbort: AbortController;
  readonly composedSignal: AbortSignal;
  readonly telemetry: StreamTelemetry;
  /** Canonical events already consumed, in order; served before the live iterator. */
  readonly prefetched: CanonicalOutputEvent[];
}

/** Opens the canonical event stream for one SDK response without reading from it. */
export function prepareCanonicalStream(
  result: PipelineStreamResult,
  signal: AbortSignal,
): PreparedCanonicalStream {
  const telemetry = createStreamTelemetry(
    result.model,
    result.conversationId,
    "stream",
    result.telemetryContext,
  );
  const streamAbort = new AbortController();
  const composedSignal = AbortSignal.any([signal, streamAbort.signal]);
  const iterator = transformSdkOutputStream(
    result.sdkResponse,
    result.model,
    result.conversationId,
    composedSignal,
    {
      ...(result.captureReasoning ? { captureReasoning: result.captureReasoning } : {}),
      emitEncryptedReasoning: result.emitEncryptedReasoning,
      emitAnthropicReasoningMetadata: result.emitAnthropicReasoningMetadata,
      ...(result.fingerprintOutput ? { fingerprintOutput: result.fingerprintOutput } : {}),
      ...(result.captureOutput ? { captureOutput: result.captureOutput } : {}),
      onCompletionWitness: (kind) => telemetry.onCompletionWitness(kind),
      onRawEvent: (eventTypes) => telemetry.onRawEvent(eventTypes),
      onToolCallProgress: (progress) => telemetry.onToolCallProgress(progress),
    },
  )[Symbol.asyncIterator]();
  return { iterator, streamAbort, composedSignal, telemetry, prefetched: [] };
}

/**
 * Tears down a prepared stream the pipeline will not publish: unblocks the
 * transformer, destroys the upstream socket, and closes the iterator within
 * the bounded cleanup grace.
 */
export function abandonPreparedStream(
  prepared: PreparedCanonicalStream,
  abortUpstream: ((reason?: unknown) => void) | undefined,
  reason: unknown,
): void {
  runCleanupSteps(
    () => {
      if (!prepared.streamAbort.signal.aborted) prepared.streamAbort.abort(reason);
    },
    () => abortUpstream?.(reason),
  );
  void boundedCleanup(() => prepared.iterator.return?.(undefined));
}

type PipelineOutcome =
  | "normal-complete"
  | "external-abort"
  | "consumer-cancel"
  | "idle-timeout"
  | "upstream-error";

const TERMINAL_PROVENANCE: Readonly<Record<PipelineOutcome, StreamTerminalProvenance>> = {
  "normal-complete": "normal_complete",
  "external-abort": "external_abort",
  "consumer-cancel": "consumer_cancel",
  "idle-timeout": "idle_timeout",
  "upstream-error": "upstream_error",
};

export function createPipelineStreamResponse(
  result: PipelineStreamResult,
  signal: AbortSignal,
  idleTimeoutMs: number,
  finalize: () => void,
): Response {
  const prepared = result.prepared ?? prepareCanonicalStream(result, signal);
  const { iterator, streamAbort, composedSignal, telemetry } = prepared;
  const prefetched = prepared.prefetched.splice(0);
  // A fresh stream is primed to its `started` event; a prefetched one is
  // already suspended at its first semantic yield, and pulling further here
  // would leave a consumer cancel queued behind an upstream read.
  let initialNext: ReturnType<typeof iterator.next> | undefined =
    prefetched.length > 0 ? undefined : iterator.next();
  const encoder = new TextEncoder();
  const encode = (event: CanonicalOutputEvent): Uint8Array =>
    encoder.encode(`${JSON.stringify(event)}\n`);
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
    runCleanupSteps(() => telemetry.emitTerminal(TERMINAL_PROVENANCE[outcome]));
    runCleanupSteps(
      removeAbortListener,
      clearIdleTimer,
      () => {
        if (outcome === "normal-complete") streamController?.close();
        else if (outcome !== "consumer-cancel") streamController?.error(reason);
      },
      () => {
        // Destroy the upstream socket before the account lease is released so
        // the next request on this account never overlaps a still-open stream.
        if (outcome !== "normal-complete") result.abortUpstream?.(reason);
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
        if (composedSignal.aborted) {
          onExternalAbort();
          return;
        }
        // Events prefetched during the pre-publication phase are published
        // first so the client sees the same NDJSON stream as an unretried one.
        for (const event of prefetched) controller.enqueue(encode(event));
      },
      async pull(controller) {
        if (terminalOutcome !== undefined) return;
        activeIdleTimer = setTimeout(() => {
          activeIdleTimer = undefined;
          const error = new StreamIdleTimeoutError(idleTimeoutMs);
          auditLog("warn", "sdk_stream_idle_timeout", {
            ...telemetry.auditFields(),
            ...streamErrorAuditFields(error),
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
            auditLog("info", "sdk_stream_completed", telemetry.auditFields());
            beginTerminal("normal-complete");
            return;
          }
          telemetry.observeCanonicalEvent(next.value);
          controller.enqueue(encode(next.value));
        } catch (error) {
          if (terminalOutcome !== undefined) return;
          const streamError =
            error instanceof Error
              ? error
              : new TypeError("SDK stream failed with a non-Error reason", {
                  cause: error,
                });
          auditLog("warn", "sdk_stream_upstream_error", {
            ...telemetry.auditFields(),
            ...streamErrorAuditFields(streamError),
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
