import {
  type ToolCallProgress,
  transformSdkOutputStream,
} from "../kiro/transform/streaming/sdk-output-transformer.js";
import {
  OutputPersistenceError,
  type SdkOutputCaptureHandler,
  type SdkOutputFingerprint,
  type SdkReasoningCaptureHandler,
  type SdkStreamResponse,
} from "../kiro/transform/streaming/sdk-stream-runtime.js";
import type { Effort } from "../kiro/types.js";
import {
  CANONICAL_OUTPUT_STREAM_CONTENT_TYPE,
  type CanonicalOutputEvent,
} from "../protocol/output.js";
import { auditHash, auditLog } from "./audit-log.js";
import { abortReason } from "./pipeline-runtime.js";
import type { RequestDiagnostics } from "./request-diagnostics.js";
import { boundedCleanup, runCleanupSteps } from "./stream-cleanup.js";
import { streamErrorAuditFields } from "./stream-error.js";

export interface PipelineStreamResult {
  readonly inputTokenEstimate?: number | (() => number);
  readonly contextUsageWindow?: number;
  readonly validateToolArguments?: import("./tool-output-validation.js").ValidateToolArguments;
  readonly maxToolArgumentsBytes?: number;
  readonly sdkResponse: SdkStreamResponse;
  readonly model: string;
  readonly conversationId: string;
  readonly telemetryContext?: StreamTelemetryContext;
  readonly captureReasoning?: SdkReasoningCaptureHandler;
  readonly emitEncryptedReasoning?: boolean;
  readonly emitAnthropicReasoningMetadata?: boolean;
  readonly bufferLateGptReasoning?: boolean;
  readonly prefetchFableReasoning?: boolean;
  readonly reasoningReplayDecision?: import("../kiro/transform/streaming/reasoning-prefix.js").ReasoningReplayDecision;
  readonly fingerprintOutput?: SdkOutputFingerprint;
  readonly captureOutput?: SdkOutputCaptureHandler;
  /**
   * Aborts the upstream HTTP request behind sdkResponse. Invoked for every
   * abnormal terminal outcome; never for a normal completion.
   */
  readonly abortUpstream?: (reason?: unknown) => void;
  /**
   * Fires once for the published stream, right after the terminal audit event.
   * Used to keep short-term per-affinity health state; receives provenance and
   * frame-timing verdicts only, never content. Throwing is contained by the
   * cleanup runner and cannot break stream teardown.
   */
  readonly onTerminal?: (report: StreamTerminalReport) => void;
  /**
   * Canonical stream primed at its started event after upstream acceptance.
   * When absent the response
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

/** How a published stream ended, in the terms a health tracker needs. */
export interface StreamTerminalReport {
  readonly provenance: StreamTerminalProvenance;
  /**
   * The terminal was this request's own deadline rather than a client-driven
   * abort. Both surface as `external_abort`, but only the deadline can be
   * upstream evidence.
   */
  readonly requestDeadline: boolean;
  /** `StreamTelemetry.upstreamWentQuiet` at the moment of the terminal. */
  readonly upstreamQuiet: boolean;
  /**
   * The stream ended on a provider-local write failing (reasoning replay or the
   * output-lineage row), not on anything the upstream did. The client still sees
   * the same retryable upstream-family error, but the terminal is not evidence
   * about the account and must not count toward its health.
   */
  readonly localPersistence: boolean;
}

export type StreamTelemetryMode = "stream" | "non-stream";

export type CompletionWitnessKind = "token-usage-metadata" | "metering-clean-eof";

type AuditFields = Readonly<Record<string, string | number | boolean | undefined>>;

export interface StreamTelemetryContext {
  readonly diagnostics?: RequestDiagnostics;
  readonly requestId?: string;
  readonly attempt?: number;
  readonly effort?: Effort;
  readonly accountHash?: string;
  /** Injectable clock for frame-age assertions. Defaults to `Date.now`. */
  readonly now?: () => number;
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
 * Shortest outstanding upstream read that can count as a wedged conversation.
 *
 * Below a second, silence is indistinguishable from ordinary upstream latency,
 * and a stream that published a single frame has no productive span to compare
 * against. Any deadline short enough to make this unreachable is also too short
 * to publish a stream worth failing over.
 */
const MIN_UPSTREAM_QUIET_MS = 1_000;

/**
 * Per attempt-stream counters shared by the prefetch phase, the streaming
 * response, and the non-stream collector. Counts only, never content.
 */
export class StreamTelemetry {
  readonly #activityListeners = new Set<() => void>();
  readonly #toolIndexes = new Set<number>();

  /**
   * Arms the idle watchdog for one outstanding read of the canonical stream, and
   * stamps when that read began so `upstreamWentQuiet` can tell real upstream
   * silence from a consumer that stopped pulling.
   *
   * Paired with `onUpstreamReadSettled`, which the caller invokes when that read
   * resolves. A raw frame is deliberately not the pairing signal: one frame can
   * carry several canonical events, so a read can resolve out of the
   * transformer's own buffer with no frame behind it, and a frame can arrive
   * while the read it belongs to is still pending.
   */
  watchIdle(timeoutMs: number, onTimeout: () => void): () => void {
    this.upstreamReadStartedAt = this.#now();
    let timer: ReturnType<typeof setTimeout>;
    const reset = (): void => {
      clearTimeout(timer);
      timer = setTimeout(onTimeout, timeoutMs);
    };
    this.#activityListeners.add(reset);
    reset();
    return () => {
      clearTimeout(timer);
      this.#activityListeners.delete(reset);
    };
  }
  private readonly eventTypeCounts = new Map<string, number>();
  private rawEventCount = 0;
  private lastEventType: string | undefined;
  private firstFrameAt: number | undefined;
  private lastFrameAt: number | undefined;
  /** When the currently outstanding read began; `undefined` between pulls. */
  private upstreamReadStartedAt: number | undefined;
  private canonicalEventCount = 0;
  private reasoningChars = 0;
  private visibleChars = 0;
  private toolCount = 0;
  private reasoningRedacted = false;
  private reasoningSigned = false;
  private reasoningEncrypted = false;
  private openToolIntents = 0;
  private stoppedToolIntents = 0;
  private toolDeltaCount = 0;
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

  get completedSeen(): boolean {
    return this.completed !== undefined;
  }

  /** Tool fragments alone did not form an actionable result in the old collector. */
  get collectorSemanticSeen(): boolean {
    return (
      this.reasoningChars > 0 ||
      this.visibleChars > 0 ||
      this.reasoningRedacted ||
      this.completed !== undefined
    );
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
        this.#toolIndexes.add(event.index);
        this.toolDeltaCount += 1;
        break;
      case "completed":
        this.toolCount = this.#toolIndexes.size;
        this.completed = event;
        break;
      case "started":
        break;
    }
  }

  onRawEvent(eventTypes: readonly string[]): void {
    this.context.diagnostics?.rawFrame();
    for (const listener of this.#activityListeners) listener();
    this.rawEventCount += 1;
    this.lastFrameAt = this.#now();
    this.firstFrameAt ??= this.lastFrameAt;
    this.lastEventType = eventTypes.join("+");
    for (const eventType of eventTypes) {
      this.eventTypeCounts.set(eventType, (this.eventTypeCounts.get(eventType) ?? 0) + 1);
    }
  }

  /**
   * The read armed by `watchIdle` resolved, so nothing is outstanding until the
   * consumer pulls again and there is no evidence either way about the upstream.
   */
  onUpstreamReadSettled(): void {
    this.upstreamReadStartedAt = undefined;
  }

  onCompletionWitness(kind: CompletionWitnessKind): void {
    this.context.diagnostics?.witness();
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
    this.stoppedToolIntents = progress.stopped;
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

  #now(): number {
    return (this.context.now ?? Date.now)();
  }

  /**
   * Whether the upstream had abandoned this stream by now: a read has been
   * outstanding against it long enough to outlast the time it spent producing.
   *
   * The point is to tell a wedged conversation, which stops emitting and stays
   * stopped, apart from a stream that was still flowing when something outside
   * it (a request deadline, a client) ended it.
   *
   * Silence is only measured while a read is outstanding. This stream is pulled
   * by the consumer, so a client that stops reading also stops `iterator.next()`
   * from being called: the last-frame age then grows without the upstream having
   * been asked for anything, and downstream backpressure would read as an
   * upstream stall. Between pulls there is no outstanding read and therefore no
   * evidence either way.
   *
   * Within an outstanding read, silence runs from the later of the read's start
   * and the last frame, because a frame can arrive while the read that will
   * consume it is still pending — a live upstream must not look quiet, and a
   * frame that arrived before this read started must not make it look live.
   *
   * The comparison against productive time is a ratio rather than an absolute
   * threshold because the request deadline can be shorter than the idle
   * watchdog, and in that configuration no absolute silence is ever reached.
   * `MIN_UPSTREAM_QUIET_MS` only rules out the degenerate end of that ratio,
   * where a stream that published a single frame would otherwise make any
   * silence at all look decisive.
   */
  upstreamWentQuiet(): boolean {
    if (this.upstreamReadStartedAt === undefined) return false;
    const quietSince = Math.max(this.upstreamReadStartedAt, this.lastFrameAt ?? 0);
    const silenceMs = Math.max(0, this.#now() - quietSince);
    if (silenceMs < MIN_UPSTREAM_QUIET_MS) return false;
    const productiveMs =
      this.firstFrameAt === undefined || this.lastFrameAt === undefined
        ? 0
        : Math.max(0, this.lastFrameAt - this.firstFrameAt);
    return silenceMs >= productiveMs;
  }

  /**
   * Frame-level shape of a stall, for the idle-timeout log: how long the
   * upstream has been silent and how much tool structure it left unfinished.
   *
   * `sdk_stream_terminal` already carries these counts, but the timeout log is
   * what an operator reads first, and a stall that dies on an unterminated tool
   * call looks nothing like one that dies after a clean `stop`. Durations and
   * counts only; tool names and arguments never cross this boundary.
   */
  stallFields(): AuditFields {
    return {
      last_frame_age_ms:
        this.lastFrameAt === undefined ? undefined : Math.max(0, this.#now() - this.lastFrameAt),
      canonical_event_count: this.canonicalEventCount,
      reasoning_chars: this.reasoningChars,
      visible_chars: this.visibleChars,
      tool_count: this.toolCount,
      tool_delta_count: this.toolDeltaCount,
      tool_intent_count: this.openToolIntents + this.stoppedToolIntents,
      tool_intent_open_count: this.openToolIntents,
      tool_intent_stopped_count: this.stoppedToolIntents,
      tool_intent_open: this.openToolIntents > 0,
      // Kiro's per-fragment `stop` marker, aggregated: true only when every
      // tool intent seen on this stream carried it and the stream still stalled.
      tool_intent_all_stopped: this.openToolIntents === 0 && this.stoppedToolIntents > 0,
      completion_witnessed: this.completionWitnessed,
    };
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
      tool_delta_count: this.toolDeltaCount,
      tool_intent_count: this.openToolIntents + this.stoppedToolIntents,
      tool_intent_open_count: this.openToolIntents,
      tool_intent_stopped_count: this.stoppedToolIntents,
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
  readonly upstreamCleanup?: () => Promise<void>;
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
  let upstreamCleanup = Promise.resolve();
  const iterator = transformSdkOutputStream(
    result.sdkResponse,
    result.model,
    result.conversationId,
    composedSignal,
    {
      inputTokenEstimate: result.inputTokenEstimate,
      contextUsageWindow: result.contextUsageWindow,
      ...(result.captureReasoning ? { captureReasoning: result.captureReasoning } : {}),
      emitEncryptedReasoning: result.emitEncryptedReasoning,
      emitAnthropicReasoningMetadata: result.emitAnthropicReasoningMetadata,
      bufferLateGptReasoning: result.bufferLateGptReasoning,
      prefetchFableReasoning: result.prefetchFableReasoning,
      reasoningReplayDecision: result.reasoningReplayDecision,
      ...(result.fingerprintOutput ? { fingerprintOutput: result.fingerprintOutput } : {}),
      ...(result.captureOutput ? { captureOutput: result.captureOutput } : {}),
      onCompletionWitness: (kind) => telemetry.onCompletionWitness(kind),
      onRawEvent: (eventTypes) => telemetry.onRawEvent(eventTypes),
      onIteratorCleanup: (cleanup) => {
        upstreamCleanup = cleanup;
      },
      onToolCallProgress: (progress) => telemetry.onToolCallProgress(progress),
      maxToolArgumentsBytes: result.maxToolArgumentsBytes,
      validateToolArguments: result.validateToolArguments,
      diagnostics: result.telemetryContext?.diagnostics,
    },
  )[Symbol.asyncIterator]();
  return {
    iterator,
    streamAbort,
    composedSignal,
    telemetry,
    prefetched: [],
    upstreamCleanup: () => upstreamCleanup,
  };
}

function cleanupPreparedStream(prepared: PreparedCanonicalStream): Promise<void> {
  return boundedCleanup(async () => {
    try {
      await prepared.iterator.return?.(undefined);
    } finally {
      await prepared.upstreamCleanup?.();
    }
  });
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
): Promise<void> {
  runCleanupSteps(
    () => {
      if (!prepared.streamAbort.signal.aborted) prepared.streamAbort.abort(reason);
    },
    () => abortUpstream?.(reason),
  );
  return cleanupPreparedStream(prepared);
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
  finalize: (cleanup?: Promise<void>) => void,
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
  let terminalCleanup: Promise<void> | undefined;
  let stopIdleWatch: (() => void) | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const clearIdleTimer = (): void => {
    stopIdleWatch?.();
    stopIdleWatch = undefined;
  };
  const claimTerminal = (outcome: PipelineOutcome): boolean => {
    if (terminalOutcome !== undefined) return false;
    terminalOutcome = outcome;
    return true;
  };
  const removeAbortListener = (): void => {
    composedSignal.removeEventListener("abort", onExternalAbort);
  };
  const beginTerminal = (
    outcome: PipelineOutcome,
    reason?: unknown,
    requestDeadline = false,
  ): Promise<void> => {
    if (!claimTerminal(outcome)) return terminalCleanup ?? Promise.resolve();
    let completeCleanup = (): void => {};
    const cleanupFinished = new Promise<void>((resolve) => {
      completeCleanup = resolve;
    });
    terminalCleanup = cleanupFinished;
    // Read before the cleanup steps run, so the silence verdict describes the
    // stream as the terminal found it.
    const report: StreamTerminalReport = {
      provenance: TERMINAL_PROVENANCE[outcome],
      requestDeadline,
      upstreamQuiet: telemetry.upstreamWentQuiet(),
      localPersistence: reason instanceof OutputPersistenceError,
    };
    runCleanupSteps(() => telemetry.emitTerminal(TERMINAL_PROVENANCE[outcome]));
    runCleanupSteps(() => result.onTerminal?.(report));
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
      // Notify lifecycle owners immediately; capacity owners can await the
      // supplied promise without delaying cancellation or creating a teardown
      // dependency cycle with the SDK iterator's return().
      () => finalize(cleanupFinished),
    );
    if (outcome !== "normal-complete") {
      runCleanupSteps(() => {
        if (!streamAbort.signal.aborted) streamAbort.abort(reason);
      });
    }
    void cleanupPreparedStream(prepared).then(completeCleanup, completeCleanup);
    return terminalCleanup;
  };
  const onExternalAbort = (): void => {
    const requestDeadline =
      composedSignal.reason instanceof Error && composedSignal.reason.name === "TimeoutError";
    result.telemetryContext?.diagnostics?.cancel(
      requestDeadline ? "request_deadline" : "external_abort",
    );
    void beginTerminal("external-abort", abortReason(composedSignal), requestDeadline);
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
        stopIdleWatch = telemetry.watchIdle(idleTimeoutMs, () => {
          const error = new StreamIdleTimeoutError(idleTimeoutMs);
          result.telemetryContext?.diagnostics?.failure(error, "upstream_stream");
          auditLog("warn", "sdk_stream_idle_timeout", {
            ...telemetry.auditFields(),
            ...telemetry.stallFields(),
            ...streamErrorAuditFields(error, result.telemetryContext?.diagnostics),
            idle_timeout_ms: idleTimeoutMs,
          });
          void beginTerminal("idle-timeout", error);
        });
        try {
          const nextPromise = initialNext ?? iterator.next();
          initialNext = undefined;
          const next = await nextPromise;
          // Paired with the `watchIdle` above: this read is over whether it was
          // served by a fresh frame or out of the transformer's buffer.
          telemetry.onUpstreamReadSettled();
          if (terminalOutcome !== undefined) return;
          clearIdleTimer();
          if (next.done) {
            auditLog("info", "sdk_stream_completed", telemetry.auditFields());
            await beginTerminal("normal-complete");
            return;
          }
          telemetry.observeCanonicalEvent(next.value);
          controller.enqueue(encode(next.value));
        } catch (error) {
          telemetry.onUpstreamReadSettled();
          if (terminalOutcome !== undefined) return;
          const streamError =
            error instanceof Error
              ? error
              : new TypeError("SDK stream failed with a non-Error reason", {
                  cause: error,
                });
          auditLog("warn", "sdk_stream_upstream_error", {
            ...telemetry.auditFields(),
            ...streamErrorAuditFields(streamError, result.telemetryContext?.diagnostics),
          });
          result.telemetryContext?.diagnostics?.failure(streamError, "upstream_stream");
          await beginTerminal("upstream-error", streamError);
        }
      },
      cancel(reason) {
        // Web Streams closes the stream before invoking its underlying cancel
        // callback. Terminal attribution still needs to run, but the controller
        // is no longer writable even when we already observed `completed`.
        streamController = undefined;
        if (telemetry.completedSeen) {
          return beginTerminal("normal-complete");
        }
        if (!telemetry.completionWitnessed)
          result.telemetryContext?.diagnostics?.cancel("consumer_cancel");
        return beginTerminal("consumer-cancel", reason);
      },
    }),
    {
      headers: {
        "Content-Type": CANONICAL_OUTPUT_STREAM_CONTENT_TYPE,
        ...(result.reasoningReplayDecision?.mode === "conflict-omitted"
          ? { "x-kiro-reasoning-replay-mode": "conflict-omitted" }
          : {}),
      },
    },
  );
}
