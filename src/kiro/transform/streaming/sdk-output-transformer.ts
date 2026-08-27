import { assistantOutputFingerprint } from "../../../protocol/canonical.js";
import {
  CANONICAL_OUTPUT_VERSION,
  type CanonicalOutputEvent,
} from "../../../protocol/output.js";
import {
  appendReasoningCapture,
  appendToolFragment,
  createReasoningCaptureState,
  nextSdkEvent,
  resolveReasoningCapture,
  resolveUsage,
  type SdkOutputFingerprint,
  type SdkReasoningCaptureHandler,
  type SdkStreamEvent,
  type SdkStreamResponse,
  type ToolCallState,
  type UsageState,
  updateUsageState,
} from "./sdk-stream-runtime.js";

export type { SdkStreamEvent, SdkStreamResponse } from "./sdk-stream-runtime.js";

export interface TransformSdkOutputOptions {
  readonly captureReasoning?: SdkReasoningCaptureHandler;
  readonly emitEncryptedReasoning?: boolean;
  readonly emitAnthropicReasoningMetadata?: boolean;
  readonly fingerprintOutput?: SdkOutputFingerprint;
  readonly onCompletionMetadata?: () => void;
  readonly onRawEvent?: (eventTypes: readonly string[]) => void;
}

export class MissingSdkOutputStreamError extends Error {
  readonly name = "MissingSdkOutputStreamError";

  constructor() {
    super("SDK response has no event stream");
  }
}

function isCompletionMetadataEvent(event: SdkStreamEvent): boolean {
  const tokenUsage = event.metadataEvent?.tokenUsage;
  return typeof tokenUsage === "object" && tokenUsage !== null;
}

function sdkEventTypes(event: SdkStreamEvent): readonly string[] {
  const record = event as Readonly<Record<string, unknown>>;
  const eventTypes = Object.keys(record)
    .filter(
      (key) =>
        (key.endsWith("Event") || key === "error" || key === "$unknown") &&
        record[key] !== undefined,
    )
    .sort();
  return eventTypes.length > 0 ? eventTypes : ["unknown"];
}

function closeIteratorWithoutBlocking(
  iterator: AsyncIterator<SdkStreamEvent>,
): void {
  try {
    const closing = iterator.return?.();
    if (closing) void Promise.resolve(closing).catch(() => undefined);
  } catch {
    // Completion metadata is authoritative; cleanup failures must not erase it.
  }
}

function normalizedToolInput(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input));
  } catch {
    return input;
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
      updateUsageState(usage, event);
      appendReasoningCapture(reasoning, event.reasoningContentEvent);

      if (isCompletionMetadataEvent(event)) {
        options.onCompletionMetadata?.();
        iteratorClosed = true;
        closeIteratorWithoutBlocking(iterator);
        break;
      }

      if (options.emitAnthropicReasoningMetadata) {
        if (reasoning.signatureConflict) {
          throw new TypeError("Kiro emitted conflicting reasoning signatures");
        }
        if (reasoning.text.length > 0 && reasoning.redactedChunks.length > 0) {
          throw new TypeError("Kiro mixed visible and redacted reasoning payloads");
        }
        if (
          assistantOutputStarted &&
          reasoningStarted &&
          event.reasoningContentEvent?.signature !== undefined &&
          event.reasoningContentEvent.signature.length > 0
        ) {
          throw new TypeError(
            "Kiro emitted a reasoning signature after assistant output began",
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
              data: Buffer.from(capturedBeforeText.redactedContent).toString(
                "base64",
              ),
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

  const captured = resolveReasoningCapture(reasoning);
  if (options.emitAnthropicReasoningMetadata) {
    if (
      reasoningStarted &&
      !anthropicSignatureEmitted &&
      captured.signature !== undefined
    ) {
      yield {
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "reasoning_signature",
        signature: captured.signature,
      };
    }
    if (
      !anthropicRedactedEmitted &&
      captured.redactedContent !== undefined
    ) {
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
      arguments: normalizedToolInput(toolCall.input),
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
  const outputFingerprint = (
    options.fingerprintOutput ?? assistantOutputFingerprint
  )(output);
  const encryptedContent = options.captureReasoning?.(
    captured,
    outputFingerprint,
  );
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
