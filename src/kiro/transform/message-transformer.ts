import type { CodeWhispererMessage } from '../types.js'

export interface MessageContentPart {
  type?: string
  text?: unknown
  id?: string
  name?: string
  input?: unknown
  thinking?: unknown
  tool_use_id?: string
  content?: unknown
  [key: string]: unknown
}

export interface SourceToolCall {
  id?: string
  function?: {
    name?: string
    arguments?: unknown
  }
  [key: string]: unknown
}

export interface SourceToolResult {
  content?: unknown
  tool_call_id?: string
  [key: string]: unknown
}

export interface SourceMessage {
  role?: string
  content?: unknown
  text?: unknown
  tool_calls?: SourceToolCall[]
  tool_results?: SourceToolResult[]
  tool_call_id?: string
  [key: string]: unknown
}

function isContentPart(value: unknown): value is MessageContentPart {
  return typeof value === 'object' && value !== null
}

export function sanitizeHistory(history: CodeWhispererMessage[]): CodeWhispererMessage[] {
  const result: CodeWhispererMessage[] = []
  for (let index = 0; index < history.length; index++) {
    const message = history[index]
    if (!message) continue
    if (message.assistantResponseMessage?.toolUses) {
      const next = history[index + 1]
      if (next?.userInputMessage?.userInputMessageContext?.toolResults) result.push(message)
    } else if (message.userInputMessage?.userInputMessageContext?.toolResults) {
      const previous = result[result.length - 1]
      if (previous?.assistantResponseMessage?.toolUses) result.push(message)
    } else {
      result.push(message)
    }
  }

  while (result.length > 0) {
    const first = result[0]
    if (first?.userInputMessage && !first.userInputMessage.userInputMessageContext?.toolResults) break
    result.shift()
  }
  if (result.length === 0) return []

  while (result.length > 0 && result[result.length - 1]?.assistantResponseMessage) result.pop()
  return result
}

export function findOriginalToolCall(messages: SourceMessage[], toolUseId: string): unknown | null {
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.id === toolUseId) return toolCall
      }
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isContentPart(part) && part.type === 'tool_use' && part.id === toolUseId) return part
      }
    }
  }
  return null
}

export function mergeAdjacentMessages(messages: SourceMessage[]): SourceMessage[] {
  const merged: SourceMessage[] = []
  for (const message of messages) {
    if (merged.length === 0) {
      merged.push({ ...message })
      continue
    }
    const last = merged[merged.length - 1]
    if (!last || message.role !== last.role) {
      merged.push({ ...message })
      continue
    }

    if (Array.isArray(last.content) && Array.isArray(message.content)) {
      last.content.push(...message.content)
    } else if (typeof last.content === 'string' && typeof message.content === 'string') {
      last.content += `\n${message.content}`
    } else if (Array.isArray(last.content) && typeof message.content === 'string') {
      last.content.push({ type: 'text', text: message.content })
    } else if (typeof last.content === 'string' && Array.isArray(message.content)) {
      last.content = [{ type: 'text', text: last.content }, ...message.content]
    }

    if (message.tool_calls) {
      if (!last.tool_calls) last.tool_calls = []
      last.tool_calls.push(...message.tool_calls)
    }
    if (message.role === 'tool') {
      if (!last.tool_results) {
        last.tool_results = [{ content: last.content, tool_call_id: last.tool_call_id }]
      }
      last.tool_results.push({ content: message.content, tool_call_id: message.tool_call_id })
    }
  }
  return merged
}

export function getContentText(message: unknown): string {
  if (message === null || message === undefined) return ''
  if (typeof message === 'string') return message
  if (!isContentPart(message)) return ''
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part): part is MessageContentPart => isContentPart(part) && part.type === 'text')
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('')
  }
  return typeof message.text === 'string' ? message.text : ''
}
