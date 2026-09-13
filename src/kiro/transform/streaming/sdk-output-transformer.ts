import { auditHash, auditLog } from "../../../core/audit-log.js";
import { streamErrorAuditFields } from "../../../core/stream-error.js";
import { assistantOutputFingerprint } from "../../../protocol/canonical.js";
import { CANONICAL_OUTPUT_VERSION, type CanonicalOutputEvent } from "../../../protocol/output.js";
import {
  appendReasoningCapture,
  appendToolFragment,
  assertSupportedSdkEvent,
  createReasoningCaptureState,
  isCompletionMetadataEvent,
  isCompletionMeteringEvent,
  type NextSdkEvent,
  nextSdkEvent,
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
  readonly diagnostics?: import("../../../core/request-diagnostics.js").RequestDiagnostics;
  readonly validateToolArguments?: import("../../../core/tool-output-validation.js").ValidateToolArguments;
  readonly maxToolArgumentsBytes?: number;
  readonly captureReasoning?: SdkReasoningCaptureHandler;
  readonly emitEncryptedReasoning?: boolean;
  readonly emitAnthropicReasoningMetadata?: boolean;
  readonly fingerprintOutput?: SdkOutputFingerprint;
  readonly captureOutput?: SdkOutputCaptureHandler;
  readonly onCompletionWitness?: (kind: "token-usage-metadata" | "metering-clean-eof") => void;
  readonly onRawEvent?: (eventTypes: readonly string[]) => void;
  /** Fires after every raw tool fragment; counts only, never arguments. */
  readonly onToolCallProgress?: (progress: ToolCallProgress) => void;
}

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

function closeIteratorWithoutBlocking(iterator: AsyncIterator<SdkStreamEvent>): void {
  try {
    const closing = iterator.return?.();
    if (closing) void Promise.resolve(closing).catch(() => undefined);
  } catch {
    // Completion metadata is authoritative; cleanup failures must not erase it.
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
  const reasoning = createReasoningCaptureState();
  const iterator = eventStream[Symbol.asyncIterator]();
  let textOnlyContent = "";
  let reasoningStarted = false;
  let assistantOutputStarted = false;
  let anthropicSignatureEmitted = false;
  let anthropicRedactedEmitted = false;
  let iteratorFinished = false;
  let iteratorClosed = false;
  let completionWitness: "token-usage-metadata" | "metering-clean-eof" | undefined;
  let toolArgumentBytes = 0;

  try {
    yield {
      canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
      type: "started",
      conversationId,
      model,
      createdAt: Math.floor(Date.now() / 1000),
    };

    while (true) {
      let next: NextSdkEvent;
      try {
        next = await nextSdkEvent(iterator, signal);
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
        closeIteratorWithoutBlocking(iterator);
        break;
      }
      if (next.kind === "aborted") {
        closeIteratorWithoutBlocking(iterator);
        iteratorClosed = true;
        return;
      }
      if (next.result.done) {
        iteratorFinished = true;
        break;
      }

      const event = next.result.value;
      options.onRawEvent?.(sdkEventTypes(event));
      assertSupportedSdkEvent(event);
      updateUsageState(usage, event);
      appendReasoningCapture(reasoning, event.reasoningContentEvent);

      if (isCompletionMetadataEvent(event)) {
        completionWitness = "token-usage-metadata";
        options.onCompletionWitness?.(completionWitness);
        iteratorClosed = true;
        closeIteratorWithoutBlocking(iterator);
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
        if (
          assistantOutputStarted &&
          reasoningStarted &&
          event.reasoningContentEvent?.signature !== undefined &&
          event.reasoningContentEvent.signature.length > 0
        ) {
          throw new SdkStreamProtocolError(
            "Kiro emitted a reasoning signature after assistant output began",
            "invalid_upstream_reasoning",
          );
        }
      }

      const reasoningText = event.reasoningContentEvent?.text;
      if (reasoningText) {
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
        }
        assistantOutputStarted = true;
        textOnlyContent += assistantText;
        yield {
          canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
          type: "text_delta",
          text: assistantText,
        };
      }

      if (event.toolUseEvent) {
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
          yield {
            canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
            type: "tool_call_delta",
            index: toolIndexes.get(id) as number,
            ...(first ? { id, name: event.toolUseEvent.name } : {}),
            arguments: delta,
          };
        }
      }
    }
  } finally {
    if (!iteratorFinished && !iteratorClosed && iterator.return) {
      closeIteratorWithoutBlocking(iterator);
    }
  }

  if (completionWitness === undefined) throw new SemanticStreamTruncationError();
  if (completionWitness === "metering-clean-eof") {
    options.onCompletionWitness?.(completionWitness);
  }
  validateCompletedToolCalls(toolCalls, options.validateToolArguments);

  const captured = resolveReasoningCapture(reasoning);
  if (options.emitAnthropicReasoningMetadata) {
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
  const encryptedContent = options.captureReasoning?.(captured, outputFingerprint);
  options.captureOutput?.(output, outputFingerprint);
  if (options.emitEncryptedReasoning && encryptedContent !== undefined) {
    yield {
      canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
      type: "reasoning_encrypted",
      encryptedContent,
    };
  }

  const tokenUsage = resolveUsage(usage, textOnlyContent, model);
  yield {
    canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
    type: "completed",
    finishReason: toolCalls.size > 0 ? "tool_calls" : "stop",
    usage: {
      inputTokens: tokenUsage.inputTokens,
      outputTokens: tokenUsage.outputTokens,
      totalTokens: tokenUsage.inputTokens + tokenUsage.outputTokens,
    },
  };
}
