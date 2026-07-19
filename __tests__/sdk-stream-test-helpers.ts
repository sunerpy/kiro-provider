import type { OpenAIStreamChunk } from '../src/kiro/transform/streaming/openai-converter.js'
import {
  type SdkStreamEvent,
  type SdkStreamResponse,
  transformSdkStream
} from '../src/kiro/transform/streaming/sdk-stream-transformer.js'

export function makeSdkResponse(events: readonly SdkStreamEvent[]): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const event of events) yield event
    })()
  }
}

export async function collectSdkChunks(
  events: readonly SdkStreamEvent[],
  model = 'auto',
  conversationId = 'chatcmpl-test',
  signal?: AbortSignal
): Promise<OpenAIStreamChunk[]> {
  const chunks: OpenAIStreamChunk[] = []
  for await (const chunk of transformSdkStream(
    makeSdkResponse(events),
    model,
    conversationId,
    signal
  )) {
    chunks.push(chunk)
  }
  return chunks
}

export function reasoningTextOf(chunk: OpenAIStreamChunk): string | undefined {
  const value = chunk.choices[0]?.delta.reasoning_content
  return typeof value === 'string' ? value : undefined
}

export function contentTextOf(chunk: OpenAIStreamChunk): string | undefined {
  const value = chunk.choices[0]?.delta.content
  return typeof value === 'string' ? value : undefined
}

export function reasoningOf(chunks: readonly OpenAIStreamChunk[]): string {
  return chunks.map(reasoningTextOf).filter(isString).join('')
}

export function contentOf(chunks: readonly OpenAIStreamChunk[]): string {
  return chunks.map(contentTextOf).filter(isString).join('')
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

export function toolCallOf(chunk: OpenAIStreamChunk): ToolCallDelta | undefined {
  const calls = chunk.choices[0]?.delta.tool_calls
  if (!Array.isArray(calls)) return undefined
  const call: unknown = calls[0]
  if (!isRecord(call)) return undefined

  const functionValue = call.function
  const functionCall = isRecord(functionValue)
    ? {
        name: typeof functionValue.name === 'string' ? functionValue.name : undefined,
        arguments:
          typeof functionValue.arguments === 'string' ? functionValue.arguments : undefined
      }
    : undefined

  return {
    index: typeof call.index === 'number' ? call.index : undefined,
    id: typeof call.id === 'string' ? call.id : undefined,
    type: typeof call.type === 'string' ? call.type : undefined,
    function: functionCall
  }
}

export function toolCallStarts(chunks: readonly OpenAIStreamChunk[]): ToolCallDelta[] {
  return chunks
    .map(toolCallOf)
    .filter((call): call is ToolCallDelta => call?.type === 'function' && call.id !== undefined)
}

function isString(value: string | undefined): value is string {
  return value !== undefined
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}
