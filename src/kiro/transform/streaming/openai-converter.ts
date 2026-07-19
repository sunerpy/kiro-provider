import type { StreamEvent } from './types.js'

export interface OpenAIStreamChoice {
  readonly index: number
  readonly delta: Readonly<Record<string, unknown>>
  readonly finish_reason: 'tool_calls' | 'stop' | null
}

export interface OpenAIStreamChunk {
  readonly id: string
  readonly object: 'chat.completion.chunk'
  readonly created: number
  readonly model: string
  readonly choices: readonly OpenAIStreamChoice[]
  readonly usage?: {
    readonly prompt_tokens: number
    readonly completion_tokens: number
    readonly total_tokens: number
  }
}

export function convertToOpenAI(
  event: StreamEvent,
  id: string,
  model: string
): OpenAIStreamChunk | null {
  const choices: OpenAIStreamChoice[] = []

  if (event.type === 'content_block_delta') {
    if (event.delta?.type === 'text_delta') {
      choices.push({
        index: 0,
        delta: { content: event.delta.text ?? '' },
        finish_reason: null
      })
    } else if (event.delta?.type === 'thinking_delta') {
      if (event.delta.thinking) {
        choices.push({
          index: 0,
          delta: { reasoning_content: event.delta.thinking },
          finish_reason: null
        })
      }
    } else if (event.delta?.type === 'input_json_delta') {
      choices.push({
        index: 0,
        delta: {
          tool_calls: [
            {
              index: event.index,
              function: { arguments: event.delta.partial_json ?? '' }
            }
          ]
        },
        finish_reason: null
      })
    }
  } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    choices.push({
      index: 0,
      delta: {
        tool_calls: [
          {
            index: event.index,
            id: event.content_block.id,
            type: 'function',
            function: { name: event.content_block.name, arguments: '' }
          }
        ]
      },
      finish_reason: null
    })
  } else if (event.type === 'message_delta') {
    choices.push({
      index: 0,
      delta: {},
      finish_reason: event.delta?.stop_reason === 'tool_use' ? 'tool_calls' : 'stop'
    })
  } else {
    return null
  }

  if (choices.length === 0) return null

  const base = {
    id,
    object: 'chat.completion.chunk' as const,
    created: Math.floor(Date.now() / 1000),
    model,
    choices
  }

  if (event.type !== 'message_delta') return base

  const promptTokens = event.usage?.input_tokens ?? 0
  const completionTokens = event.usage?.output_tokens ?? 0
  return {
    ...base,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    }
  }
}
