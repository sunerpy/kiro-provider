import { assistantOutputFingerprint } from "../../../protocol/canonical.js";
import { CANONICAL_OUTPUT_VERSION, type CanonicalOutputEvent } from "../../../protocol/output.js";
import {
  appendReasoningCapture,
  appendToolFragment,
  assertSupportedSdkEvent,
  createReasoningCaptureState,
  isCompletionMetadataEvent,
  isCompletionMeteringEvent,
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
  type UsageState,
  updateUsageState,
  validateCompletedToolCalls,
} from "./sdk-stream-runtime.js";

export type { SdkStreamEvent, SdkStreamResponse } from "./sdk-stream-runtime.js";

export interface TransformSdkOutputOptions {
  readonly captureReasoning?: SdkReasoningCaptureHandler;
  readonly emitEncryptedReasoning?: boolean;
  readonly emitAnthropicReasoningMetadata?: boolean;
  readonly fingerprintOutput?: SdkOutputFingerprint;
  readonly captureOutput?: SdkOutputCaptureHandler;
  readonly onCompletionWitness?: (kind: "token-usage-metadata" | "metering-clean-eof") => void;
  readonly onRawEvent?: (eventTypes: readonly string[]) => void;
}

export class MissingSdkOutputStreamError extends Error {
  readonly name = "MissingSdkOutputStreamError";
  readonly code = "missing_upstream_stream";

  constructor() {
    super("SDK response has no event stream");
  }
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

  try {
    yield {
      canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
      type: "started",
      conversationId,
      model,
      createdAt: Math.floor(Date.now() / 1000),
    };

    while (true) {
      const next = await nextSdkEvent(iterator, signal);
      if (next.kind === "aborted") {
        if (iterator.return) await iterator.return();
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
        appendToolFragment(toolCalls, event.toolUseEvent);
      }
    }
  } finally {
    if (!iteratorFinished && !iteratorClosed && iterator.return) {
      await iterator.return();
    }
  }

  if (completionWitness === undefined) throw new SemanticStreamTruncationError();
  if (completionWitness === "metering-clean-eof") {
    options.onCompletionWitness?.(completionWitness);
  }
  validateCompletedToolCalls(toolCalls);

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

  let ordinal = 0;
  for (const toolCall of toolCalls.values()) {
    yield {
      canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
      type: "tool_call_delta",
      index: ordinal,
      id: toolCall.toolUseId,
      name: toolCall.name,
      arguments: toolCall.input,
    };
    ordinal += 1;
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
