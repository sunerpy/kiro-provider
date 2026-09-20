import { auditHash, auditLog } from "../../../core/audit-log.js";
import { streamErrorAuditFields } from "../../../core/stream-error.js";
import { isRecord } from "../../../protocol/adapter-utils.js";
import { assistantOutputFingerprint } from "../../../protocol/canonical.js";
import { type CodeReference, parseCodeReferences } from "../../../protocol/code-references.js";
import { CANONICAL_OUTPUT_VERSION, type CanonicalOutputEvent } from "../../../protocol/output.js";
import {
  couldStillBeGpt56ReasoningPlaceholder,
  isFable51Model,
  isGpt56Model,
  isGpt56ReasoningPlaceholder,
} from "../../models.js";
import { type ReasoningReplayDecision, readReasoningPrefix } from "./reasoning-prefix.js";
import {
  appendReasoningCapture,
  appendToolFragment,
  assertSupportedSdkEvent,
  createReasoningCaptureState,
  isCompletionMetadataEvent,
  isCompletionMeteringEvent,
  type NextSdkEvent,
  nextSdkEvent,
  OutputPersistenceError,
  resolveReasoningCapture,
  resolveUsage,
  type SdkOutputCaptureHandler,
  type SdkOutputFingerprint,
  type SdkReasoningCaptureHandler,
  type SdkStreamEvent,
  SdkStreamProtocolError,
  type SdkStreamResponse,
  SemanticStreamTruncationError,
  sdkEventTypes,
  type ToolCallState,
  ToolCallViolation,
  type UsageState,
  updateUsageState,
  validateCompletedToolCalls,
} from "./sdk-stream-runtime.js";

export type { SdkStreamEvent, SdkStreamResponse } from "./sdk-stream-runtime.js";

/** Tool-call structure seen so far: calls without a stop marker versus stopped ones. */
export interface ToolCallProgress {
  readonly open: number;
  readonly stopped: number;
}

export interface TransformSdkOutputOptions {
  readonly inputTokenEstimate?: number | (() => number);
  readonly contextUsageWindow?: number;
  readonly diagnostics?: import("../../../core/request-diagnostics.js").RequestDiagnostics;
  readonly validateToolArguments?: import("../../../core/tool-output-validation.js").ValidateToolArguments;
  readonly maxToolArgumentsBytes?: number;
  readonly captureReasoning?: SdkReasoningCaptureHandler;
  readonly emitEncryptedReasoning?: boolean;
  readonly emitAnthropicReasoningMetadata?: boolean;
  readonly bufferLateGptReasoning?: boolean;
  readonly prefetchFableReasoning?: boolean;
  readonly reasoningReplayDecision?: ReasoningReplayDecision;
  readonly fingerprintOutput?: SdkOutputFingerprint;
  readonly captureOutput?: SdkOutputCaptureHandler;
  readonly onCompletionWitness?: (kind: "token-usage-metadata" | "metering-clean-eof") => void;
  readonly onRawEvent?: (eventTypes: readonly string[]) => void;
  /** Lets the transport retain its lease while asynchronous iterator teardown settles. */
  readonly onIteratorCleanup?: (cleanup: Promise<void>) => void;
  /** Fires after every raw tool fragment; counts only, never arguments. */
  readonly onToolCallProgress?: (progress: ToolCallProgress) => void;
}

const GPT_ANTHROPIC_PREFACE_MAX_EVENTS = 128;
const GPT_ANTHROPIC_PREFACE_MAX_BYTES = 1 << 20;

type BufferedAssistantEvent = Extract<
  CanonicalOutputEvent,
  { readonly type: "text_delta" | "tool_call_delta" }
>;

export class MissingSdkOutputStreamError extends Error {
  readonly name = "MissingSdkOutputStreamError";
  readonly code = "missing_upstream_stream";

  constructor() {
    super("SDK response has no event stream");
  }
}

function toolCallProgress(toolCalls: ReadonlyMap<string, ToolCallState>): ToolCallProgress {
  let stopped = 0;
  for (const toolCall of toolCalls.values()) if (toolCall.stopped) stopped += 1;
  return { open: toolCalls.size - stopped, stopped };
}

function closeIteratorWithoutBlocking(iterator: AsyncIterator<SdkStreamEvent>): Promise<void> {
  try {
    const closing = iterator.return?.();
    return Promise.resolve(closing).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    // Completion metadata is authoritative; cleanup failures must not erase it.
    return Promise.resolve();
  }
}

export async function* transformSdkOutputStream(
  sdkResponse: SdkStreamResponse,
  model: string,
  conversationId: string,
  signal?: AbortSignal,
  options: TransformSdkOutputOptions = {},
): AsyncGenerator<CanonicalOutputEvent> {
  const eventStream = sdkResponse.generateAssistantResponseResponse;
  if (!eventStream) throw new MissingSdkOutputStreamError();

  const toolCalls = new Map<string, ToolCallState>();
  const toolIndexes = new Map<string, number>();
  const pendingToolSurrogates = new Map<string, string>();
  const usage: UsageState = {};
  let codeReferences: readonly CodeReference[] = [];
  const reasoning = createReasoningCaptureState();
  const iterator = eventStream[Symbol.asyncIterator]();
  let textOnlyContent = "";
  let reasoningStarted = false;
  let assistantOutputStarted = false;
  let anthropicSignatureEmitted = false;
  let anthropicRedactedEmitted = false;
  let iteratorFinished = false;
  let iteratorClosed = false;
  const closeIterator = (): void => {
    const cleanup = closeIteratorWithoutBlocking(iterator);
    options.onIteratorCleanup?.(cleanup);
  };
  let completionWitness: "token-usage-metadata" | "metering-clean-eof" | undefined;
  let toolArgumentBytes = 0;
  const bufferLateGptReasoning =
    options.bufferLateGptReasoning === true &&
    options.emitAnthropicReasoningMetadata === true &&
    isGpt56Model(model);
  const bufferedAssistantEvents: BufferedAssistantEvent[] = [];
  let bufferedAssistantBytes = 0;
  let lateGptReasoningResolved = !bufferLateGptReasoning;
  let reasoningOmitted = false;
  let prefetched: SdkStreamEvent[] = [];
  let prefetchedIndex = 0;
  const observeRaw = (event: SdkStreamEvent): void => {
    options.onRawEvent?.(sdkEventTypes(event));
    assertSupportedSdkEvent(event);
  };

  const bufferAssistantEvent = (event: BufferedAssistantEvent): void => {
    const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    if (
      bufferedAssistantEvents.length >= GPT_ANTHROPIC_PREFACE_MAX_EVENTS ||
      bufferedAssistantBytes + bytes > GPT_ANTHROPIC_PREFACE_MAX_BYTES
    ) {
      throw new SdkStreamProtocolError(
        "Kiro delayed GPT reasoning metadata beyond the bounded assistant preface",
        "invalid_upstream_reasoning",
      );
    }
    bufferedAssistantEvents.push(event);
    bufferedAssistantBytes += bytes;
  };

  const takeBufferedAssistantEvents = (): BufferedAssistantEvent[] => {
    const events = bufferedAssistantEvents.splice(0);
    bufferedAssistantBytes = 0;
    return events;
  };

  try {
    if (
      options.prefetchFableReasoning === true &&
      options.emitAnthropicReasoningMetadata === true &&
      isFable51Model(model)
    ) {
      const prefix = await readReasoningPrefix(async () => {
        const next = await nextSdkEvent(iterator, signal);
        if (next.kind === "event" && !next.result.done) observeRaw(next.result.value);
        return next;
      });
      if (prefix.aborted) return;
      prefetched = prefix.events;
      iteratorFinished = prefix.done;
      reasoningOmitted = prefix.omitted;
      if (reasoningOmitted) {
        if (options.reasoningReplayDecision) {
          options.reasoningReplayDecision.mode = "conflict-omitted";
        }
        auditLog("warn", "anthropic_output_reasoning_conflict_omitted", {
          model: "claude-fable-5-1",
          direction: "output",
          reasoning_event_count: prefix.reasoningEvents,
          prefix_event_count: prefix.prefixEvents,
          prefix_bytes: prefix.prefixBytes,
        });
      }
    }
    yield {
      canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
      type: "started",
      conversationId,
      model,
      createdAt: Math.floor(Date.now() / 1000),
    };

    while (true) {
      let next: NextSdkEvent;
      let prefetchedEvent = false;
      try {
        if (prefetchedIndex < prefetched.length) {
          const value = prefetched[prefetchedIndex] as SdkStreamEvent;
          delete prefetched[prefetchedIndex++];
          prefetchedEvent = true;
          next = { kind: "event", result: { done: false, value } };
        } else if (iteratorFinished) {
          break;
        } else {
          next = await nextSdkEvent(iterator, signal);
        }
      } catch (transportError) {
        // A completion witness is authoritative: a transport failure while
        // draining the trailing bytes after it must not erase a complete
        // answer. Embedded error events never take this path; they are
        // rejected by assertSupportedSdkEvent below.
        if (completionWitness === undefined) throw transportError;
        auditLog("warn", "sdk_stream_transport_error_after_completion", {
          model,
          conversation_hash: auditHash(conversationId),
          witness_kind: completionWitness,
          ...streamErrorAuditFields(transportError, options.diagnostics),
        });
        iteratorClosed = true;
        closeIterator();
        break;
      }
      if (next.kind === "aborted") {
        closeIterator();
        iteratorClosed = true;
        return;
      }
      if (next.result.done) {
        iteratorFinished = true;
        break;
      }

      const event = next.result.value;
      if (!prefetchedEvent) observeRaw(event);
      if (
        reasoningOmitted &&
        event.reasoningContentEvent !== undefined &&
        ((event.reasoningContentEvent.text?.length ?? 0) > 0 ||
          (event.reasoningContentEvent.signature?.length ?? 0) > 0 ||
          event.reasoningContentEvent.redactedContent !== undefined)
      ) {
        throw new SdkStreamProtocolError(
          "Kiro emitted reasoning after the omitted prefix ended",
          "invalid_upstream_reasoning",
        );
      }
      if (event.codeReferenceEvent !== undefined) {
        const referenceEvent = event.codeReferenceEvent;
        const references =
          isRecord(referenceEvent) &&
          Object.keys(referenceEvent).every((key) => key === "references")
            ? parseCodeReferences(
                referenceEvent.references === undefined ? [] : referenceEvent.references,
              )
            : undefined;
        const combined =
          references === undefined
            ? undefined
            : parseCodeReferences([...codeReferences, ...references]);
        if (combined === undefined) {
          throw new SdkStreamProtocolError(
            "Kiro returned invalid code reference metadata",
            "invalid_upstream_response",
          );
        }
        codeReferences = combined;
      }
      updateUsageState(usage, event);
      appendReasoningCapture(reasoning, event.reasoningContentEvent);
      const eventReasoningText = event.reasoningContentEvent?.text ?? "";
      const suppressLateGptPlaceholder =
        bufferLateGptReasoning &&
        assistantOutputStarted &&
        !lateGptReasoningResolved &&
        eventReasoningText.length > 0 &&
        couldStillBeGpt56ReasoningPlaceholder(model, reasoning.text);

      if (isCompletionMetadataEvent(event)) {
        completionWitness = "token-usage-metadata";
        options.onCompletionWitness?.(completionWitness);
        iteratorClosed = true;
        closeIterator();
        break;
      }
      if (isCompletionMeteringEvent(event)) {
        completionWitness = "metering-clean-eof";
      }

      if (options.emitAnthropicReasoningMetadata) {
        if (reasoning.signatureConflict) {
          throw new SdkStreamProtocolError(
            "Kiro emitted conflicting reasoning signatures",
            "invalid_upstream_reasoning",
          );
        }
        if (reasoning.text.length > 0 && reasoning.redactedChunks.length > 0) {
          throw new SdkStreamProtocolError(
            "Kiro mixed visible and redacted reasoning payloads",
            "invalid_upstream_reasoning",
          );
        }
        const lateSignature =
          assistantOutputStarted &&
          event.reasoningContentEvent?.signature !== undefined &&
          event.reasoningContentEvent.signature.length > 0;
        const acceptsBufferedLateSignature =
          lateSignature &&
          bufferLateGptReasoning &&
          !lateGptReasoningResolved &&
          bufferedAssistantEvents.length > 0 &&
          (reasoningStarted ||
            reasoning.text.length === 0 ||
            isGpt56ReasoningPlaceholder(model, reasoning.text)) &&
          reasoning.redactedChunks.length === 0;
        if (lateSignature && !acceptsBufferedLateSignature) {
          throw new SdkStreamProtocolError(
            "Kiro emitted a reasoning signature after assistant output began",
            "invalid_upstream_reasoning",
          );
        }
        if (
          bufferLateGptReasoning &&
          assistantOutputStarted &&
          !lateGptReasoningResolved &&
          ((!suppressLateGptPlaceholder && eventReasoningText.length > 0) ||
            (event.reasoningContentEvent?.redactedContent?.byteLength ?? 0) > 0)
        ) {
          throw new SdkStreamProtocolError(
            "Kiro emitted visible GPT reasoning after assistant output began",
            "invalid_upstream_reasoning",
          );
        }
        if (acceptsBufferedLateSignature) {
          lateGptReasoningResolved = true;
          if (!reasoningStarted) {
            reasoningStarted = true;
            yield {
              canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
              type: "reasoning_delta",
              text: "",
            };
          }
          anthropicSignatureEmitted = true;
          yield {
            canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
            type: "reasoning_signature",
            signature: event.reasoningContentEvent?.signature as string,
          };
          for (const buffered of takeBufferedAssistantEvents()) yield buffered;
        }
      }

      const reasoningText = event.reasoningContentEvent?.text;
      if (reasoningText && !suppressLateGptPlaceholder) {
        reasoningStarted = true;
        yield {
          canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
          type: "reasoning_delta",
          text: reasoningText,
        };
      }

      const assistantText = event.assistantResponseEvent?.content;
      if (assistantText) {
        if (options.emitAnthropicReasoningMetadata) {
          const capturedBeforeText = resolveReasoningCapture(reasoning);
          if (!reasoningStarted && capturedBeforeText.signature !== undefined) {
            reasoningStarted = true;
            yield {
              canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
              type: "reasoning_delta",
              text: "",
            };
          }
          if (
            reasoningStarted &&
            !anthropicSignatureEmitted &&
            capturedBeforeText.signature !== undefined
          ) {
            anthropicSignatureEmitted = true;
            yield {
              canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
              type: "reasoning_signature",
              signature: capturedBeforeText.signature,
            };
          }
          if (
            !reasoningStarted &&
            !anthropicRedactedEmitted &&
            capturedBeforeText.redactedContent !== undefined
          ) {
            anthropicRedactedEmitted = true;
            yield {
              canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
              type: "reasoning_redacted",
              data: Buffer.from(capturedBeforeText.redactedContent).toString("base64"),
            };
          }
          if (
            capturedBeforeText.signature !== undefined ||
            capturedBeforeText.redactedContent !== undefined
          ) {
            lateGptReasoningResolved = true;
          }
        }
        assistantOutputStarted = true;
        textOnlyContent += assistantText;
        const outputEvent: BufferedAssistantEvent = {
          canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
          type: "text_delta",
          text: assistantText,
        };
        if (bufferLateGptReasoning && !lateGptReasoningResolved) {
          bufferAssistantEvent(outputEvent);
        } else {
          yield outputEvent;
        }
      }

      if (event.toolUseEvent) {
        if (options.emitAnthropicReasoningMetadata) {
          const capturedBeforeTool = resolveReasoningCapture(reasoning);
          if (!reasoningStarted && capturedBeforeTool.signature !== undefined) {
            reasoningStarted = true;
            yield {
              canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
              type: "reasoning_delta",
              text: "",
            };
          }
          if (
            reasoningStarted &&
            !anthropicSignatureEmitted &&
            capturedBeforeTool.signature !== undefined
          ) {
            anthropicSignatureEmitted = true;
            yield {
              canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
              type: "reasoning_signature",
              signature: capturedBeforeTool.signature,
            };
          }
          if (capturedBeforeTool.signature !== undefined) lateGptReasoningResolved = true;
        }
        assistantOutputStarted = true;
        const fragment = event.toolUseEvent;
        const previous = fragment.toolUseId ? toolCalls.get(fragment.toolUseId) : undefined;
        toolArgumentBytes += Buffer.byteLength(fragment.input ?? "", "utf8");
        const pending = pendingToolSurrogates.get(fragment.toolUseId ?? "") ?? "";
        const firstCode = fragment.input?.charCodeAt(0);
        if (pending && firstCode !== undefined && firstCode >= 0xdc00 && firstCode <= 0xdfff)
          toolArgumentBytes -= 2;
        if (!previous)
          toolArgumentBytes +=
            Buffer.byteLength(fragment.name ?? "", "utf8") +
            Buffer.byteLength(fragment.toolUseId ?? "", "utf8");
        if (
          options.maxToolArgumentsBytes !== undefined &&
          toolArgumentBytes > options.maxToolArgumentsBytes
        ) {
          throw new ToolCallViolation(
            "Upstream tool arguments exceeded the configured request-body budget",
            "upstream_tool_arguments_too_large",
            "arguments_too_large",
            {
              toolUseId: fragment.toolUseId,
              toolName: fragment.name,
              argumentsText: (previous?.input ?? "") + (fragment.input ?? ""),
              fragmentCount: (previous?.fragmentCount ?? 0) + 1,
            },
          );
        }
        appendToolFragment(toolCalls, event.toolUseEvent);
        options.onToolCallProgress?.(toolCallProgress(toolCalls));
        options.validateToolArguments?.assertName(event.toolUseEvent.name as string);
        const id = event.toolUseEvent.toolUseId as string;
        const first = !toolIndexes.has(id);
        if (first) toolIndexes.set(id, toolIndexes.size);
        const candidate = pending + (fragment.input ?? "");
        const lastCode = candidate.charCodeAt(candidate.length - 1);
        const holdLast = lastCode >= 0xd800 && lastCode <= 0xdbff;
        const delta = holdLast ? candidate.slice(0, -1) : candidate;
        pendingToolSurrogates.set(id, holdLast ? candidate.slice(-1) : "");
        for (const character of delta) {
          const code = character.codePointAt(0) as number;
          if (code >= 0xd800 && code <= 0xdfff)
            throw new SdkStreamProtocolError(
              "Upstream tool arguments contain an invalid Unicode scalar",
              "malformed_upstream_tool_arguments",
            );
        }
        if (first || delta.length > 0) {
          const outputEvent: BufferedAssistantEvent = {
            canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
            type: "tool_call_delta",
            index: toolIndexes.get(id) as number,
            ...(first ? { id, name: event.toolUseEvent.name } : {}),
            arguments: delta,
          };
          if (bufferLateGptReasoning && !lateGptReasoningResolved) {
            bufferAssistantEvent(outputEvent);
          } else {
            yield outputEvent;
          }
        }
      }
    }
  } finally {
    if (!iteratorFinished && !iteratorClosed && iterator.return) {
      closeIterator();
    }
  }

  if (completionWitness === undefined) throw new SemanticStreamTruncationError();
  if (completionWitness === "metering-clean-eof") {
    options.onCompletionWitness?.(completionWitness);
  }
  validateCompletedToolCalls(toolCalls, options.validateToolArguments);

  const captured = resolveReasoningCapture(reasoning);
  if (options.emitAnthropicReasoningMetadata) {
    if (!reasoningStarted && captured.signature !== undefined) {
      reasoningStarted = true;
      yield {
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "reasoning_delta",
        text: "",
      };
    }
    if (reasoningStarted && !anthropicSignatureEmitted && captured.signature !== undefined) {
      yield {
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "reasoning_signature",
        signature: captured.signature,
      };
    }
    if (!anthropicRedactedEmitted && captured.redactedContent !== undefined) {
      yield {
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "reasoning_redacted",
        data: Buffer.from(captured.redactedContent).toString("base64"),
      };
    }
  }

  if (
    bufferLateGptReasoning &&
    bufferedAssistantEvents.length > 0 &&
    (reasoningStarted || captured.text.length > 0) &&
    captured.signature === undefined
  ) {
    throw new SdkStreamProtocolError(
      "Kiro completed GPT reasoning without a signature before buffered assistant output",
      "invalid_upstream_reasoning",
    );
  }

  for (const buffered of takeBufferedAssistantEvents()) yield buffered;

  for (const toolCall of toolCalls.values()) {
    // Only the established no-input + stop + completion shape receives "{}".
    // It is not a repair for partial, blank, malformed, or cancelled arguments.
    if (!toolCall.inputReceived) {
      yield {
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "tool_call_delta",
        index: toolIndexes.get(toolCall.toolUseId) as number,
        arguments: toolCall.input,
      };
    }
  }

  const output = {
    text: textOnlyContent,
    toolCalls: [...toolCalls.values()].map((call) => ({
      id: call.toolUseId,
      name: call.name,
      input: call.input,
    })),
  };
  const outputFingerprint = (options.fingerprintOutput ?? assistantOutputFingerprint)(output);
  // Both captures are provider-local writes (replay keyring, lineage row) that run
  // after the upstream already delivered this output. Tagging their failures keeps
  // a local fault from being read as upstream silence and moving the next request
  // off an account that is demonstrably healthy.
  let encryptedContent: string | undefined;
  try {
    if (!reasoningOmitted) {
      encryptedContent = options.captureReasoning?.(captured, outputFingerprint);
    }
    options.captureOutput?.(output, outputFingerprint);
  } catch (error) {
    throw new OutputPersistenceError({ cause: error });
  }
  if (options.emitEncryptedReasoning && encryptedContent !== undefined) {
    yield {
      canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
      type: "reasoning_encrypted",
      encryptedContent,
    };
  }

  const tokenUsage = resolveUsage(usage, textOnlyContent, model, {
    inputTokenEstimate: options.inputTokenEstimate,
    contextUsageWindow: options.contextUsageWindow,
    toolCalls: output.toolCalls,
    reasoning: {
      ...(captured.signature !== undefined
        ? { reasoningText: { text: captured.text, signature: captured.signature } }
        : {}),
      ...(captured.redactedContent !== undefined
        ? { redactedContent: captured.redactedContent }
        : {}),
    },
  });
  const cacheRead = tokenUsage.reported?.cacheReadInputTokens;
  const cacheWrite = tokenUsage.reported?.cacheWriteInputTokens;
  const measuredInput = tokenUsage.reported?.inputTokens;
  const cacheHitRatio =
    measuredInput !== undefined && measuredInput > 0 && cacheRead !== undefined
      ? cacheRead / measuredInput
      : undefined;
  auditLog("info", "sdk_usage_resolved", {
    request_id: options.diagnostics?.requestId,
    model,
    input_source: tokenUsage.accounting?.input,
    output_source: tokenUsage.accounting?.output,
    context_source: tokenUsage.accounting?.context,
    input_tokens: tokenUsage.inputTokens,
    output_tokens: tokenUsage.outputTokens,
    context_tokens: tokenUsage.totalTokens,
    context_usage_percentage: tokenUsage.accounting?.contextUsagePercentage,
    context_usage_window: tokenUsage.accounting?.contextUsageWindow,
    percentage_saturated: tokenUsage.accounting?.percentageSaturated,
    metering_value: tokenUsage.accounting?.metering?.value,
    metering_unit: tokenUsage.accounting?.metering?.unit,
    cache_read_input_tokens: cacheRead,
    cache_write_input_tokens: cacheWrite,
    cache_hit_ratio: cacheHitRatio,
  });
  yield {
    canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
    type: "completed",
    finishReason: toolCalls.size > 0 ? "tool_calls" : "stop",
    usage: tokenUsage,
    ...(codeReferences.length > 0 ? { codeReferences } : {}),
  };
}
