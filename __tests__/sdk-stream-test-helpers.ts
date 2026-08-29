import { transformSdkOutputStream } from '../src/kiro/transform/streaming/sdk-output-transformer.js'
import type {
  SdkStreamEvent,
  SdkStreamResponse
} from '../src/kiro/transform/streaming/sdk-stream-runtime.js'
import type { CanonicalOutputEvent } from '../src/protocol/output.js'

export function makeSdkResponse(events: readonly SdkStreamEvent[]): SdkStreamResponse {
  const hasCompletion = events.some(
    (event) => event.metadataEvent?.tokenUsage !== undefined
  )
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const event of events) yield event
      if (!hasCompletion) {
        yield {
          metadataEvent: {
            tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
          }
        }
      }
    })()
  }
}

export async function collectSdkEvents(
  events: readonly SdkStreamEvent[],
  model = 'auto',
  conversationId = 'chatcmpl-test',
  signal?: AbortSignal
): Promise<CanonicalOutputEvent[]> {
  const outputEvents: CanonicalOutputEvent[] = []
  for await (const event of transformSdkOutputStream(
    makeSdkResponse(events),
    model,
    conversationId,
    signal
  )) {
    outputEvents.push(event)
  }
  return outputEvents
}

export function reasoningTextOf(event: CanonicalOutputEvent): string | undefined {
  return event.type === 'reasoning_delta' ? event.text : undefined
}

export function contentTextOf(event: CanonicalOutputEvent): string | undefined {
  return event.type === 'text_delta' ? event.text : undefined
}

export function reasoningOf(events: readonly CanonicalOutputEvent[]): string {
  return events.map(reasoningTextOf).filter(isString).join('')
}

export function completionOf(
  events: readonly CanonicalOutputEvent[]
): Extract<CanonicalOutputEvent, { readonly type: 'completed' }> | undefined {
  return events.find(
    (event): event is Extract<CanonicalOutputEvent, { readonly type: 'completed' }> =>
      event.type === 'completed'
  )
}

export function contentOf(events: readonly CanonicalOutputEvent[]): string {
  return events.map(contentTextOf).filter(isString).join('')
}

export interface ToolCallDelta {
  readonly index?: number
  readonly id?: string
  readonly type?: string
  readonly function?: {
    readonly name?: string
    readonly arguments?: string
  }
}

export function toolCallOf(event: CanonicalOutputEvent): ToolCallDelta | undefined {
  if (event.type !== 'tool_call_delta') return undefined
  return {
    index: event.index,
    id: event.id,
    type: event.id !== undefined ? 'function' : undefined,
    function: {
      name: event.name,
      arguments: event.arguments
    }
  }
}

export function toolCallStarts(events: readonly CanonicalOutputEvent[]): ToolCallDelta[] {
  return events
    .map(toolCallOf)
    .filter((call): call is ToolCallDelta => call?.type === 'function' && call.id !== undefined)
}

function isString(value: string | undefined): value is string {
  return value !== undefined
}
