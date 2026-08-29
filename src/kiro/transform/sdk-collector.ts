import { assistantOutputFingerprint } from '../../protocol/canonical.js'
import {
  CANONICAL_OUTPUT_VERSION,
  type CanonicalCompletion,
  type CanonicalOutputReasoning
} from '../../protocol/output.js'
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
  type SdkStreamResponse,
  SemanticStreamTruncationError,
  type ToolCallState,
  type UsageState,
  updateUsageState,
  validateCompletedToolCalls
} from './streaming/sdk-stream-runtime.js'

export interface CollectSdkResponseOptions {
  readonly captureReasoning?: SdkReasoningCaptureHandler
  readonly emitEncryptedReasoning?: boolean
  readonly emitAnthropicReasoningMetadata?: boolean
  readonly fingerprintOutput?: SdkOutputFingerprint
  readonly captureOutput?: SdkOutputCaptureHandler
}

export class MissingSdkEventStreamError extends Error {
  readonly name = 'MissingSdkEventStreamError'

  constructor() {
    super('SDK response has no event stream')
  }
}

export async function collectSdkResponse(
  sdkResponse: SdkStreamResponse,
  model: string,
  conversationId: string,
  signal?: AbortSignal,
  options: CollectSdkResponseOptions = {}
): Promise<CanonicalCompletion> {
  const eventStream = sdkResponse.generateAssistantResponseResponse
  if (!eventStream) throw new MissingSdkEventStreamError()

  const iterator = eventStream[Symbol.asyncIterator]()
  const toolCalls = new Map<string, ToolCallState>()
  const usage: UsageState = {}
  let content = ''
  const reasoning = createReasoningCaptureState()
  let iteratorFinished = false
  let iteratorClosed = false
  let completionWitnessSeen = false

  try {
    while (true) {
      const next = await nextSdkEvent(iterator, signal)
      if (next.kind === 'aborted') {
        if (iterator.return) await iterator.return()
        iteratorClosed = true
        break
      }
      if (next.result.done) {
        iteratorFinished = true
        break
      }

      const event = next.result.value
      assertSupportedSdkEvent(event)
      updateUsageState(usage, event)
      appendReasoningCapture(reasoning, event.reasoningContentEvent)
      if (isCompletionMetadataEvent(event)) {
        completionWitnessSeen = true
        iteratorClosed = true
        try {
          const closing = iterator.return?.()
          if (closing) void Promise.resolve(closing).catch(() => undefined)
        } catch {
          // Completion metadata is authoritative; cleanup failures must not erase it.
        }
        break
      }
      if (isCompletionMeteringEvent(event)) completionWitnessSeen = true
      content += event.assistantResponseEvent?.content ?? ''
      appendToolFragment(toolCalls, event.toolUseEvent)
    }
  } finally {
    if (!iteratorFinished && !iteratorClosed && iterator.return) await iterator.return()
  }

  if (signal?.aborted) throw signal.reason
  if (!completionWitnessSeen) throw new SemanticStreamTruncationError()
  validateCompletedToolCalls(toolCalls)

  const resolvedUsage = resolveUsage(usage, content, model)
  const captured = resolveReasoningCapture(reasoning)
  const output = {
    text: content,
    toolCalls: Array.from(toolCalls.values(), (toolCall) => ({
      id: toolCall.toolUseId,
      name: toolCall.name,
      input: toolCall.input
    }))
  }
  const outputFingerprint = (options.fingerprintOutput ?? assistantOutputFingerprint)(output)
  const encryptedContent = options.captureReasoning?.(captured, outputFingerprint)
  options.captureOutput?.(output, outputFingerprint)
  const canonicalReasoning: CanonicalOutputReasoning = {
    ...(captured.text ? { text: captured.text } : {}),
    ...(options.emitAnthropicReasoningMetadata && captured.signature !== undefined
      ? { signature: captured.signature }
      : {}),
    ...(options.emitAnthropicReasoningMetadata && captured.redactedContent !== undefined
      ? { redactedContent: Buffer.from(captured.redactedContent).toString('base64') }
      : {}),
    ...(options.emitEncryptedReasoning && encryptedContent !== undefined
      ? { encryptedContent }
      : {})
  }

  return {
    canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
    conversationId,
    model,
    createdAt: Math.floor(Date.now() / 1000),
    text: content,
    ...(Object.keys(canonicalReasoning).length > 0 ? { reasoning: canonicalReasoning } : {}),
    toolCalls: output.toolCalls,
    finishReason: toolCalls.size > 0 ? 'tool_calls' : 'stop',
    usage: {
      inputTokens: resolvedUsage.inputTokens,
      outputTokens: resolvedUsage.outputTokens,
      totalTokens: resolvedUsage.inputTokens + resolvedUsage.outputTokens
    }
  }
}
