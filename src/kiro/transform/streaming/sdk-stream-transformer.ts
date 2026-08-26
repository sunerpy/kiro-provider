import { assistantOutputFingerprint } from "../../../protocol/canonical.js";
import { convertToOpenAI, type OpenAIStreamChunk } from "./openai-converter.js";
import {
  appendReasoningCapture,
  appendToolFragment,
  createReasoningCaptureState,
  createToolCallEvents,
  nextSdkEvent,
  resolveReasoningCapture,
  resolveUsage,
  type SdkOutputFingerprint,
  type SdkReasoningCaptureHandler,
  type SdkStreamEvent,
  type SdkStreamResponse,
  type UsageState,
  updateUsageState,
} from "./sdk-stream-runtime.js";
import { createTextDeltaEvents, createThinkingDeltaEvents, stopBlock } from "./stream-state.js";
import type { StreamEvent, StreamState, ToolCallState } from "./types.js";

export type { SdkStreamEvent, SdkStreamResponse } from "./sdk-stream-runtime.js";

export interface TransformSdkStreamOptions {
  readonly captureReasoning?: SdkReasoningCaptureHandler;
  readonly emitEncryptedReasoning?: boolean;
  readonly emitAnthropicReasoningMetadata?: boolean;
  readonly fingerprintOutput?: SdkOutputFingerprint;
  readonly onCompletionMetadata?: () => void;
  readonly onRawEvent?: (eventTypes: readonly string[]) => void;
}

export class MissingSdkEventStreamError extends Error {
  readonly name = "MissingSdkEventStreamError";

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

function closeIteratorWithoutBlocking(iterator: AsyncIterator<SdkStreamEvent>): void {
  try {
    const closing = iterator.return?.();
    if (closing) void Promise.resolve(closing).catch(() => undefined);
  } catch {
    // Completion metadata is authoritative; cleanup failures must not erase it.
  }
}

function metadataChunk(
  conversationId: string,
  model: string,
  delta: Readonly<Record<string, unknown>>,
): OpenAIStreamChunk {
  return {
    id: conversationId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: null }],
  };
}

export async function* transformSdkStream(
  sdkResponse: SdkStreamResponse,
  model: string,
  conversationId: string,
  signal?: AbortSignal,
  options: TransformSdkStreamOptions = {},
): AsyncGenerator<OpenAIStreamChunk> {
  const eventStream = sdkResponse.generateAssistantResponseResponse;
  if (!eventStream) throw new MissingSdkEventStreamError();

  const streamState: StreamState = {
    thinkingRequested: true,
    buffer: "",
    inThinking: false,
    thinkingExtracted: false,
    thinkingBlockIndex: null,
    textBlockIndex: null,
    nextBlockIndex: 0,
    stoppedBlocks: new Set(),
  };
  const toolCalls = new Map<string, ToolCallState>();
  const usage: UsageState = {};
  const reasoning = createReasoningCaptureState();
  const iterator = eventStream[Symbol.asyncIterator]();
  let textOnlyContent = "";
  let reasoningStarted = false;
  let reasoningClosed = false;
  let anthropicSignatureEmitted = false;
  let anthropicRedactedEmitted = false;
  let iteratorFinished = false;
  let iteratorClosed = false;

  const convert = (event: StreamEvent): OpenAIStreamChunk | null =>
    convertToOpenAI(event, conversationId, model);

  try {
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
          reasoningClosed &&
          event.reasoningContentEvent?.signature !== undefined &&
          event.reasoningContentEvent.signature.length > 0
        ) {
          throw new TypeError("Kiro emitted a reasoning signature after assistant output began");
        }
      }

      const reasoningText = event.reasoningContentEvent?.text;
      if (reasoningText) {
        if (reasoningClosed) {
          streamState.thinkingBlockIndex = null;
          reasoningClosed = false;
        }
        reasoningStarted = true;
        for (const deltaEvent of createThinkingDeltaEvents(reasoningText, streamState)) {
          const chunk = convert(deltaEvent);
          if (chunk) yield chunk;
        }
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
            yield metadataChunk(conversationId, model, {
              reasoning_signature: capturedBeforeText.signature,
            });
          }
          if (
            !reasoningStarted &&
            !anthropicRedactedEmitted &&
            capturedBeforeText.redactedContent !== undefined
          ) {
            anthropicRedactedEmitted = true;
            yield metadataChunk(conversationId, model, {
              reasoning_redacted_content: Buffer.from(
                capturedBeforeText.redactedContent,
              ).toString("base64"),
            });
          }
        }
        textOnlyContent += assistantText;
        if (reasoningStarted && !reasoningClosed) {
          for (const stopEvent of stopBlock(streamState.thinkingBlockIndex, streamState)) {
            const chunk = convert(stopEvent);
            if (chunk) yield chunk;
          }
          reasoningClosed = true;
        }
        for (const textEvent of createTextDeltaEvents(assistantText, streamState)) {
          const chunk = convert(textEvent);
          if (chunk) yield chunk;
        }
      }

      if (event.toolUseEvent) appendToolFragment(toolCalls, event.toolUseEvent);
    }
  } finally {
    if (!iteratorFinished && !iteratorClosed && iterator.return) await iterator.return();
  }

  const captured = resolveReasoningCapture(reasoning);
  if (options.emitAnthropicReasoningMetadata) {
    if (
      reasoningStarted &&
      !reasoningClosed &&
      !anthropicSignatureEmitted &&
      captured.signature !== undefined
    ) {
      anthropicSignatureEmitted = true;
      yield metadataChunk(conversationId, model, {
        reasoning_signature: captured.signature,
      });
    }
    if (!anthropicRedactedEmitted && captured.redactedContent !== undefined) {
      anthropicRedactedEmitted = true;
      yield metadataChunk(conversationId, model, {
        reasoning_redacted_content: Buffer.from(captured.redactedContent).toString("base64"),
      });
    }
  }

  if (reasoningStarted && !reasoningClosed) {
    for (const stopEvent of stopBlock(streamState.thinkingBlockIndex, streamState)) {
      const chunk = convert(stopEvent);
      if (chunk) yield chunk;
    }
  }
  for (const stopEvent of stopBlock(streamState.textBlockIndex, streamState)) {
    const chunk = convert(stopEvent);
    if (chunk) yield chunk;
  }
  for (const toolEvent of createToolCallEvents(toolCalls)) {
    const chunk = convert(toolEvent);
    if (chunk) yield chunk;
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
  if (options.emitEncryptedReasoning && encryptedContent !== undefined) {
    yield metadataChunk(conversationId, model, {
      reasoning_encrypted_content: encryptedContent,
    });
  }

  const tokenUsage = resolveUsage(usage, textOnlyContent, model);
  const finalChunk = convert({
    type: "message_delta",
    delta: {
      type: "message_delta",
      stop_reason: toolCalls.size > 0 ? "tool_use" : "end_turn",
    },
    usage: {
      input_tokens: tokenUsage.inputTokens,
      output_tokens: tokenUsage.outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  });
  if (finalChunk) yield finalChunk;
}
