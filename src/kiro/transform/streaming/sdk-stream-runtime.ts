import type { CanonicalAssistantOutput } from '../../../protocol/canonical.js'
import { getContextWindowSize } from '../../models.js'
import { estimateTokens } from '../response.js'

/** Mutable accumulator for fragments belonging to one SDK tool call. */
export interface ToolCallState {
  readonly toolUseId: string
  readonly name: string
  input: string
}

export interface SdkTokenUsage {
  readonly inputTokens?: number
  readonly uncachedInputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly cacheReadInputTokens?: number
  readonly cacheWriteInputTokens?: number
  readonly contextUsagePercentage?: number
}

export interface SdkStreamEvent {
  readonly reasoningContentEvent?: {
    readonly text?: string
    readonly signature?: string
    readonly redactedContent?: Uint8Array
  }
  readonly assistantResponseEvent?: { readonly content?: string }
  readonly toolUseEvent?: {
    readonly name?: string
    readonly toolUseId?: string
    readonly input?: string
    readonly stop?: boolean
  }
  readonly metadataEvent?: {
    readonly tokenUsage?: SdkTokenUsage
    readonly contextUsagePercentage?: number
  }
  readonly contextUsageEvent?: { readonly contextUsagePercentage?: number }
}

export interface SdkReasoningCapture {
  readonly text: string
  readonly signature?: string
  readonly redactedContent?: Uint8Array
}

export interface SdkReasoningCaptureState {
  text: string
  signature: string
  signatureConflict: boolean
  redactedChunks: Uint8Array[]
}

export type SdkReasoningCaptureHandler = (
  capture: SdkReasoningCapture,
  outputFingerprint: string
) => string | undefined

export type SdkOutputFingerprint = (output: CanonicalAssistantOutput) => string

export function createReasoningCaptureState(): SdkReasoningCaptureState {
  return { text: '', signature: '', signatureConflict: false, redactedChunks: [] }
}

export function appendReasoningCapture(
  state: SdkReasoningCaptureState,
  event: SdkStreamEvent['reasoningContentEvent']
): void {
  if (!event) return
  state.text += event.text ?? ''
  if (event.signature !== undefined && event.signature.length > 0) {
    if (state.signature.length > 0 && state.signature !== event.signature) {
      state.signatureConflict = true
    }
    state.signature = event.signature
  }
  if (event.redactedContent && event.redactedContent.byteLength > 0) {
    state.redactedChunks.push(event.redactedContent)
  }
}

export function resolveReasoningCapture(
  state: SdkReasoningCaptureState
): SdkReasoningCapture {
  const redactedLength = state.redactedChunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0
  )
  let redactedContent: Uint8Array | undefined
  if (redactedLength > 0) {
    redactedContent = new Uint8Array(redactedLength)
    let offset = 0
    for (const chunk of state.redactedChunks) {
      redactedContent.set(chunk, offset)
      offset += chunk.byteLength
    }
  }
  const mixedTextAndRedacted = state.text.length > 0 && redactedContent !== undefined
  const completeSignedText =
    state.text.length > 0 &&
    state.signature.length > 0 &&
    !state.signatureConflict &&
    redactedContent === undefined
  const completeRedacted = state.text.length === 0 && redactedContent !== undefined
  return {
    text: state.text,
    ...(completeSignedText ? { signature: state.signature } : {}),
    ...(!mixedTextAndRedacted && completeRedacted ? { redactedContent } : {})
  }
}

export interface SdkStreamResponse {
  readonly generateAssistantResponseResponse?: AsyncIterable<SdkStreamEvent>
}

export type NextSdkEvent =
  | { readonly kind: 'event'; readonly result: IteratorResult<SdkStreamEvent> }
  | { readonly kind: 'aborted' }

export interface UsageState {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  contextUsagePercentage?: number
}

export async function nextSdkEvent(
  iterator: AsyncIterator<SdkStreamEvent>,
  signal?: AbortSignal
): Promise<NextSdkEvent> {
  if (signal?.aborted) return { kind: 'aborted' }

  const nextPromise = iterator.next()
  if (!signal) return { kind: 'event', result: await nextPromise }

  return new Promise<NextSdkEvent>((resolve, reject) => {
    const onAbort = (): void => resolve({ kind: 'aborted' })
    signal.addEventListener('abort', onAbort, { once: true })
    void nextPromise.then(
      (result) => {
        signal.removeEventListener('abort', onAbort)
        resolve({ kind: 'event', result })
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

export function appendToolFragment(
  toolCalls: Map<string, ToolCallState>,
  event: SdkStreamEvent['toolUseEvent']
): void {
  if (!event?.name || !event.toolUseId) return

  const existing = toolCalls.get(event.toolUseId)
  if (existing) {
    existing.input += event.input ?? ''
    return
  }

  toolCalls.set(event.toolUseId, {
    toolUseId: event.toolUseId,
    name: event.name,
    input: event.input ?? ''
  })
}

export function updateUsageState(usage: UsageState, event: SdkStreamEvent): void {
  const tokenUsage = event.metadataEvent?.tokenUsage
  if (tokenUsage) {
    usage.outputTokens = tokenUsage.outputTokens ?? usage.outputTokens
    usage.totalTokens = tokenUsage.totalTokens ?? usage.totalTokens
    usage.inputTokens =
      tokenUsage.inputTokens ??
      (tokenUsage.uncachedInputTokens === undefined
        ? usage.inputTokens
        : tokenUsage.uncachedInputTokens +
          (tokenUsage.cacheReadInputTokens ?? 0) +
          (tokenUsage.cacheWriteInputTokens ?? 0))
  }

  usage.contextUsagePercentage =
    event.contextUsageEvent?.contextUsagePercentage ??
    event.metadataEvent?.contextUsagePercentage ??
    tokenUsage?.contextUsagePercentage ??
    usage.contextUsagePercentage
}

export function resolveUsage(
  usage: UsageState,
  textOnlyContent: string,
  model: string
): { readonly inputTokens: number; readonly outputTokens: number } {
  const outputTokens = usage.outputTokens ?? estimateTokens(textOnlyContent)
  let inputTokens = usage.inputTokens

  if (inputTokens === undefined && usage.totalTokens !== undefined) {
    inputTokens = Math.max(0, usage.totalTokens - outputTokens)
  }
  if (
    inputTokens === undefined &&
    usage.contextUsagePercentage !== undefined &&
    usage.contextUsagePercentage > 0
  ) {
    const totalTokens = Math.round(
      (getContextWindowSize(model) * usage.contextUsagePercentage) / 100
    )
    inputTokens = Math.max(0, totalTokens - outputTokens)
  }

  return { inputTokens: inputTokens ?? 0, outputTokens }
}
