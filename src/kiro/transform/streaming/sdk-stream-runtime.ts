import { getContextWindowSize } from '../../models.js'
import { estimateTokens } from '../response.js'
import type { StreamEvent, ToolCallState } from './types.js'

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
  readonly reasoningContentEvent?: { readonly text?: string }
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

export function createToolCallEvents(toolCalls: ReadonlyMap<string, ToolCallState>): StreamEvent[] {
  const events: StreamEvent[] = []
  let ordinal = 0

  for (const toolCall of toolCalls.values()) {
    let inputJson = toolCall.input
    try {
      inputJson = JSON.stringify(JSON.parse(toolCall.input))
    } catch {
      inputJson = toolCall.input
    }

    events.push(
      {
        type: 'content_block_start',
        index: ordinal,
        content_block: {
          type: 'tool_use',
          id: toolCall.toolUseId,
          name: toolCall.name,
          input: {}
        }
      },
      {
        type: 'content_block_delta',
        index: ordinal,
        delta: { type: 'input_json_delta', partial_json: inputJson }
      },
      { type: 'content_block_stop', index: ordinal }
    )
    ordinal += 1
  }

  return events
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
