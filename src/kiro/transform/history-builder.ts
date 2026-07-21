import { KIRO_CONSTANTS } from '../constants.js'
import type { CodeWhispererMessage } from '../types.js'
import { convertImagesToKiroFormat, extractAllImages, extractTextFromParts } from './image-handler.js'
import {
  getContentText,
  type MessageContentPart,
  type SourceMessage,
  type SourceToolCall
} from './message-transformer.js'
import { deduplicateToolResults, type ToolResult } from './tool-transformer.js'

interface AssistantResponse {
  content: string
  toolUses?: NonNullable<CodeWhispererMessage['assistantResponseMessage']>['toolUses']
}

function isContentPart(value: unknown): value is MessageContentPart {
  return typeof value === 'object' && value !== null
}

function parseToolCall(toolCall: SourceToolCall): NonNullable<AssistantResponse['toolUses']>[number] {
  const argumentsValue = toolCall.function?.arguments
  return {
    input: typeof argumentsValue === 'string' ? JSON.parse(argumentsValue) : argumentsValue,
    name: toolCall.function?.name ?? '',
    toolUseId: toolCall.id ?? ''
  }
}

export function collapseAgenticLoops(history: CodeWhispererMessage[]): CodeWhispererMessage[] {
  if (history.length < 4) return history
  const result: CodeWhispererMessage[] = []
  let index = 0
  while (index < history.length) {
    const entry = history[index]
    if (
      entry?.assistantResponseMessage?.toolUses &&
      index + 1 < history.length &&
      history[index + 1]?.userInputMessage?.userInputMessageContext?.toolResults
    ) {
      const sequenceStart = index
      let sequenceEnd = index
      while (sequenceEnd < history.length) {
        const assistant = history[sequenceEnd]
        const nextUser = sequenceEnd + 1 < history.length ? history[sequenceEnd + 1] : undefined
        if (
          !assistant?.assistantResponseMessage?.toolUses ||
          !nextUser?.userInputMessage?.userInputMessageContext?.toolResults
        ) {
          break
        }
        sequenceEnd += 2
      }

      const pairCount = (sequenceEnd - sequenceStart) / 2
      for (let pairIndex = sequenceStart; pairIndex < sequenceEnd; pairIndex += 2) {
        const assistant = history[pairIndex]
        const user = history[pairIndex + 1]
        if (!assistant || !user) continue
        if (pairCount > 1 && pairIndex !== sequenceStart) {
          const thinkingPrefix = assistant.assistantResponseMessage?.content.match(
            /^<thinking>[\s\S]*?<\/thinking>/
          )?.[0]
          result.push({
            assistantResponseMessage: {
              content: thinkingPrefix
                ? `${thinkingPrefix}\n\n[system: tool calling continues]`
                : '[system: tool calling continues]',
              toolUses: assistant.assistantResponseMessage?.toolUses
            }
          })
        } else {
          result.push(assistant)
        }
        result.push(user)
      }
      index = sequenceEnd
    } else {
      if (entry) result.push(entry)
      index++
    }
  }
  return result
}

export function buildHistory(messages: SourceMessage[], resolved: string): CodeWhispererMessage[] {
  const history: CodeWhispererMessage[] = []
  for (let index = 0; index < messages.length - 1; index++) {
    const message = messages[index]
    if (!message) continue

    if (message.role === 'user') {
      const userInput: NonNullable<CodeWhispererMessage['userInputMessage']> = {
        content: '',
        modelId: resolved,
        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
      }
      const toolResults: ToolResult[] = []
      if (Array.isArray(message.content)) {
        userInput.content = extractTextFromParts(message.content)
        for (const part of message.content) {
          if (!isContentPart(part) || part.type !== 'tool_result' || typeof part.tool_use_id !== 'string') continue
          toolResults.push({
            content: [{ text: getContentText(part.content ?? part) }],
            status: 'success',
            toolUseId: part.tool_use_id
          })
        }
        const unifiedImages = extractAllImages(message.content)
        if (unifiedImages.length > 0) {
          const converted = convertImagesToKiroFormat(unifiedImages)
          userInput.images = converted.images
          if (converted.omitted > 0) {
            userInput.content += `\n\n[${converted.omitted} image(s) omitted due to API limits]`
          }
        }
      } else {
        userInput.content = getContentText(message)
      }
      if (toolResults.length > 0) {
        userInput.userInputMessageContext = { toolResults: deduplicateToolResults(toolResults) }
      }
      if (history[history.length - 1]?.userInputMessage) {
        history.push({ assistantResponseMessage: { content: '[system: conversation continues]' } })
      }
      history.push({ userInputMessage: userInput })
      continue
    }

    if (message.role === 'tool') {
      const toolResults: ToolResult[] = []
      if (message.tool_results) {
        for (const toolResult of message.tool_results) {
          if (!toolResult.tool_call_id) continue
          toolResults.push({
            content: [{ text: getContentText(toolResult) }],
            status: 'success',
            toolUseId: toolResult.tool_call_id
          })
        }
      } else if (message.tool_call_id) {
        toolResults.push({
          content: [{ text: getContentText(message) }],
          status: 'success',
          toolUseId: message.tool_call_id
        })
      }
      if (history[history.length - 1]?.userInputMessage) {
        history.push({ assistantResponseMessage: { content: '[system: conversation continues]' } })
      }
      history.push({
        userInputMessage: {
          content: 'Tool results provided.',
          modelId: resolved,
          origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
          userInputMessageContext: { toolResults: deduplicateToolResults(toolResults) }
        }
      })
      continue
    }

    if (message.role !== 'assistant') continue
    const assistant: AssistantResponse = { content: '' }
    const toolUses: NonNullable<AssistantResponse['toolUses']> = []
    let thinking = ''
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!isContentPart(part)) continue
        if (part.type === 'text') assistant.content += typeof part.text === 'string' ? part.text : ''
        else if (part.type === 'thinking') {
          thinking +=
            typeof part.thinking === 'string'
              ? part.thinking
              : typeof part.text === 'string'
                ? part.text
                : ''
        } else if (
          part.type === 'tool_use' &&
          typeof part.id === 'string' &&
          typeof part.name === 'string'
        ) {
          toolUses.push({ input: part.input, name: part.name, toolUseId: part.id })
        }
      }
    } else {
      assistant.content = getContentText(message)
    }
    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) toolUses.push(parseToolCall(toolCall))
    }
    if (thinking) {
      const escapedThinking = thinking.replaceAll('</thinking>', '<\\/thinking>')
      assistant.content = assistant.content
        ? `<thinking>${escapedThinking}</thinking>\n\n${assistant.content}`
        : `<thinking>${escapedThinking}</thinking>`
    }
    if (toolUses.length > 0) assistant.toolUses = toolUses
    if (!assistant.content && !assistant.toolUses) continue

    const previous = history[history.length - 1]?.assistantResponseMessage
    if (previous) {
      if (assistant.content) {
        previous.content = previous.content ? `${previous.content}\n\n${assistant.content}` : assistant.content
      }
      if (assistant.toolUses) previous.toolUses = [...(previous.toolUses ?? []), ...assistant.toolUses]
    } else {
      history.push({ assistantResponseMessage: assistant })
    }
  }
  return collapseAgenticLoops(history)
}

export function injectSystemPrompt(
  history: CodeWhispererMessage[],
  system: string | undefined,
  resolved: string
): CodeWhispererMessage[] {
  if (!system) return history
  const firstUserMessage = history.find((entry) => entry.userInputMessage)
  if (firstUserMessage?.userInputMessage) {
    firstUserMessage.userInputMessage.content = `${system}\n\n${firstUserMessage.userInputMessage.content || ''}`
  } else {
    history.unshift({
      userInputMessage: {
        content: system,
        modelId: resolved,
        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
      }
    })
  }
  return history
}

export function historyHasToolCalling(history: CodeWhispererMessage[]): boolean {
  return history.some(
    (entry) =>
      Boolean(entry.assistantResponseMessage?.toolUses) ||
      Boolean(entry.userInputMessage?.userInputMessageContext?.toolResults)
  )
}

export function extractToolNamesFromHistory(history: CodeWhispererMessage[]): Set<string> {
  const toolNames = new Set<string>()
  for (const entry of history) {
    for (const toolUse of entry.assistantResponseMessage?.toolUses ?? []) {
      if (toolUse.name) toolNames.add(toolUse.name)
    }
  }
  return toolNames
}
