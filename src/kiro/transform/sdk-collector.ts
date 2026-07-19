import {
  appendToolFragment,
  nextSdkEvent,
  resolveUsage,
  type SdkStreamResponse,
  type UsageState,
  updateUsageState
} from './streaming/sdk-stream-runtime.js'
import type { ToolCallState } from './streaming/types.js'

export interface OpenAIToolCall {
  readonly id: string
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly arguments: string
  }
}

export interface OpenAICompletionMessage {
  readonly role: 'assistant'
  readonly content: string
  readonly reasoning_content?: string
  readonly tool_calls?: readonly OpenAIToolCall[]
}

export interface OpenAIChatCompletion {
  readonly id: string
  readonly object: 'chat.completion'
  readonly created: number
  readonly model: string
  readonly choices: readonly [
    {
      readonly index: 0
      readonly message: OpenAICompletionMessage
      readonly finish_reason: 'stop' | 'tool_calls'
    }
  ]
  readonly usage: {
    readonly prompt_tokens: number
    readonly completion_tokens: number
    readonly total_tokens: number
  }
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
  signal?: AbortSignal
): Promise<OpenAIChatCompletion> {
  const eventStream = sdkResponse.generateAssistantResponseResponse
  if (!eventStream) throw new MissingSdkEventStreamError()

  const iterator = eventStream[Symbol.asyncIterator]()
  const toolCalls = new Map<string, ToolCallState>()
  const usage: UsageState = {}
  let content = ''
  let reasoningContent = ''
  let iteratorFinished = false
  let iteratorClosed = false

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
      updateUsageState(usage, event)
      reasoningContent += event.reasoningContentEvent?.text ?? ''
      content += event.assistantResponseEvent?.content ?? ''
      appendToolFragment(toolCalls, event.toolUseEvent)
    }
  } finally {
    if (!iteratorFinished && !iteratorClosed && iterator.return) await iterator.return()
  }

  const resolvedUsage = resolveUsage(usage, content, model)
  const message: OpenAICompletionMessage = {
    role: 'assistant',
    content,
    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    ...(toolCalls.size > 0
      ? {
          tool_calls: Array.from(toolCalls.values(), (toolCall) => ({
            id: toolCall.toolUseId,
            type: 'function' as const,
            function: { name: toolCall.name, arguments: toolCall.input }
          }))
        }
      : {})
  }

  return {
    id: conversationId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.size > 0 ? 'tool_calls' : 'stop'
      }
    ],
    usage: {
      prompt_tokens: resolvedUsage.inputTokens,
      completion_tokens: resolvedUsage.outputTokens,
      total_tokens: resolvedUsage.inputTokens + resolvedUsage.outputTokens
    }
  }
}
