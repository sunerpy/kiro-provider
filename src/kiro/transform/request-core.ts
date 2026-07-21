import { randomUUID } from 'node:crypto'
import { KIRO_CONSTANTS } from '../constants.js'
import { resolveModelVariant } from '../models.js'
import type { CodeWhispererMessage, CodeWhispererRequest, Effort, KiroAuthDetails } from '../types.js'
import {
  buildHistory,
  extractToolNamesFromHistory,
  historyHasToolCalling,
  injectSystemPrompt
} from './history-builder.js'
import { convertImagesToKiroFormat, extractAllImages, extractTextFromParts } from './image-handler.js'
import {
  findOriginalToolCall,
  getContentText,
  mergeAdjacentMessages,
  type SourceMessage
} from './message-transformer.js'
import {
  convertToolsToCodeWhisperer,
  deduplicateToolResults,
  type ToolInput,
  type ToolResult
} from './tool-transformer.js'

export interface RequestTransformResult {
  readonly request: CodeWhispererRequest
  readonly resolved: string
  readonly convId: string
  readonly variantEffort?: Effort
}

type ToolUse = NonNullable<
  NonNullable<CodeWhispererMessage['assistantResponseMessage']>['toolUses']
>[number]
type KiroImages = NonNullable<NonNullable<CodeWhispererMessage['userInputMessage']>['images']>

interface RequestBody {
  readonly messages: SourceMessage[]
  readonly tools: ToolInput[]
  readonly system: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isSourceMessage(value: unknown): value is SourceMessage {
  return isRecord(value)
}

function isToolInput(value: unknown): value is ToolInput {
  return isRecord(value)
}

function parseBody(body: unknown): RequestBody {
  const parsed: unknown = typeof body === 'string' ? JSON.parse(body) : body
  if (!isRecord(parsed)) return { messages: [], tools: [], system: '' }
  return {
    messages: Array.isArray(parsed.messages) ? parsed.messages.filter(isSourceMessage) : [],
    tools: Array.isArray(parsed.tools) ? parsed.tools.filter(isToolInput) : [],
    system: typeof parsed.system === 'string' ? parsed.system : ''
  }
}

function jsonSchemaTypeOf(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'string'
  const valueType = typeof value
  return valueType === 'number' || valueType === 'boolean' || valueType === 'string' || valueType === 'object'
    ? valueType
    : 'string'
}

function inferToolSpecFromHistory(
  name: string,
  toolUses: readonly ToolUse[]
): NonNullable<CodeWhispererMessage['userInputMessage']>['userInputMessageContext'] extends infer Context
  ? Context extends { tools?: infer Tools }
    ? Tools extends Array<infer Tool>
      ? Tool
      : never
    : never
  : never {
  const sample = toolUses?.find((toolUse) => toolUse.name === name && isRecord(toolUse.input))
  const properties: Record<string, unknown> = {}
  if (sample && isRecord(sample.input)) {
    for (const [key, value] of Object.entries(sample.input)) properties[key] = { type: jsonSchemaTypeOf(value) }
  }
  const json: Record<string, unknown> =
    Object.keys(properties).length > 0 ? { type: 'object', properties } : { type: 'object' }
  return { toolSpecification: { name, description: `Tool ${name}`, inputSchema: { json } } }
}

function appendCurrentAssistant(history: CodeWhispererMessage[], message: SourceMessage): void {
  const assistant: NonNullable<CodeWhispererMessage['assistantResponseMessage']> = { content: '' }
  const toolUses: NonNullable<typeof assistant.toolUses> = []
  let thinking = ''
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!isRecord(part)) continue
      if (part.type === 'text' && typeof part.text === 'string') assistant.content += part.text
      else if (part.type === 'thinking') {
        thinking += typeof part.thinking === 'string' ? part.thinking : typeof part.text === 'string' ? part.text : ''
      } else if (part.type === 'tool_use' && typeof part.id === 'string' && typeof part.name === 'string') {
        toolUses.push({ input: part.input, name: part.name, toolUseId: part.id })
      }
    }
  } else {
    assistant.content = getContentText(message)
  }
  for (const toolCall of message.tool_calls ?? []) {
    if (typeof toolCall.id !== 'string' || typeof toolCall.function?.name !== 'string') continue
    const args = toolCall.function.arguments
    toolUses.push({
      input: typeof args === 'string' ? JSON.parse(args) : args,
      name: toolCall.function.name,
      toolUseId: toolCall.id
    })
  }
  if (thinking) {
    const escapedThinking = thinking.replaceAll('</thinking>', '<\\/thinking>')
    assistant.content = assistant.content
      ? `<thinking>${escapedThinking}</thinking>\n\n${assistant.content}`
      : `<thinking>${escapedThinking}</thinking>`
  }
  if (toolUses.length > 0) assistant.toolUses = toolUses
  if (assistant.content || assistant.toolUses) history.push({ assistantResponseMessage: assistant })
}

function collectCurrentUserContent(message: SourceMessage): {
  content: string
  toolResults: ToolResult[]
  images: KiroImages
} {
  let content = ''
  const toolResults: ToolResult[] = []
  const images: KiroImages = []
  if (message.role === 'tool') {
    const results = message.tool_results ?? [{ content: message.content, tool_call_id: message.tool_call_id }]
    for (const result of results) {
      if (typeof result.tool_call_id !== 'string') continue
      toolResults.push({ content: [{ text: getContentText(result) }], status: 'success', toolUseId: result.tool_call_id })
    }
  } else if (Array.isArray(message.content)) {
    content = extractTextFromParts(message.content)
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== 'tool_result' || typeof part.tool_use_id !== 'string') continue
      toolResults.push({
        content: [{ text: getContentText(part.content ?? part) }],
        status: 'success',
        toolUseId: part.tool_use_id
      })
    }
    const converted = convertImagesToKiroFormat(extractAllImages(message.content))
    images.push(...converted.images)
    if (converted.omitted > 0) content += `\n\n[${converted.omitted} image(s) omitted due to API limits]`
  } else {
    content = getContentText(message)
  }
  if (!content) content = toolResults.length > 0 ? 'Tool results provided.' : '[system: conversation continues]'
  return { content, toolResults, images }
}

function originalToolUse(messages: SourceMessage[], result: ToolResult): ToolUse | undefined {
  const original = findOriginalToolCall(messages, result.toolUseId)
  if (!isRecord(original)) return undefined
  const fn = isRecord(original.function) ? original.function : undefined
  const name = typeof original.name === 'string' ? original.name : typeof fn?.name === 'string' ? fn.name : 'tool'
  const rawInput = original.input ?? fn?.arguments
  return {
    name,
    toolUseId: result.toolUseId,
    input: typeof rawInput === 'string' ? JSON.parse(rawInput) : (rawInput ?? {})
  }
}

export function buildCodeWhispererRequest(
  body: unknown,
  model: string,
  auth: KiroAuthDetails,
  think = false,
  budget = 20_000
): RequestTransformResult {
  const requestBody = parseBody(body)
  if (requestBody.messages.length === 0) throw new Error('No messages')
  const { wireId: resolved, effort: variantEffort } = resolveModelVariant(model)
  const systemMessages = requestBody.messages.filter((message) => message.role === 'system')
  const messages = mergeAdjacentMessages(requestBody.messages.filter((message) => message.role !== 'system'))
  let system = requestBody.system
  const extractedSystem = systemMessages.map(getContentText).join('\n\n')
  if (extractedSystem) system = system ? `${system}\n\n${extractedSystem}` : extractedSystem
  if (think && !system.includes('<thinking_mode>')) {
    const prefix = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`
    system = system ? `${prefix}\n${system}` : prefix
  }
  const trailing = messages.at(-1)
  if (trailing?.role === 'assistant' && getContentText(trailing) === '{') messages.pop()
  const currentMessage = messages.at(-1)
  if (!currentMessage) throw new Error('Empty')

  let history = buildHistory(messages, resolved)
  const isRealUserMessage =
    currentMessage.role === 'user' &&
    !(Array.isArray(currentMessage.content) && currentMessage.content.some((part) => isRecord(part) && part.type === 'tool_result'))
  const previousMessage = messages.at(-2)
  if (isRealUserMessage && previousMessage?.role === 'assistant' && history.at(-1)?.userInputMessage) {
    const previousText = getContentText(previousMessage)
    if (previousText) history.push({ assistantResponseMessage: { content: previousText } })
  }
  history = injectSystemPrompt(history, system, resolved)

  let content = '[system: conversation continues]'
  let toolResults: ToolResult[] = []
  let images: KiroImages = []
  if (currentMessage.role === 'assistant') {
    appendCurrentAssistant(history, currentMessage)
  } else {
    if (history.at(-1) && !history.at(-1)?.assistantResponseMessage) {
      history.push({ assistantResponseMessage: { content: '[system: conversation continues]' } })
    }
    const current = collectCurrentUserContent(currentMessage)
    content = current.content
    toolResults = current.toolResults
    images = current.images
  }

  const historicalToolUses = history.flatMap((entry) => entry.assistantResponseMessage?.toolUses ?? [])
  const historicalIds = new Set(historicalToolUses.map((toolUse) => toolUse.toolUseId))
  const matchedResults: ToolResult[] = []
  const orphaned: Array<{ call: ToolUse; result: ToolResult }> = []
  for (const result of toolResults) {
    if (historicalIds.has(result.toolUseId)) matchedResults.push(result)
    else {
      const call = originalToolUse(requestBody.messages, result)
      if (call) orphaned.push({ call, result })
      else content += `\n\n[Output for tool call ${result.toolUseId}]:\n${result.content[0]?.text ?? ''}`
    }
  }
  if (orphaned.length > 0) {
    if (!history.at(-1) || history.at(-1)?.assistantResponseMessage) {
      history.push({ userInputMessage: { content: 'Running tools...', modelId: resolved, origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR } })
    }
    history.push({
      assistantResponseMessage: { content: 'I will execute the following tools.', toolUses: orphaned.map(({ call }) => call) }
    })
    matchedResults.push(...orphaned.map(({ result }) => result))
  }

  const currentInput: NonNullable<CodeWhispererMessage['userInputMessage']> = {
    content,
    modelId: resolved,
    origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
  }
  if (images.length > 0) currentInput.images = images
  const suppliedTools = convertToolsToCodeWhisperer(requestBody.tools)
    .filter((tool) => typeof tool.toolSpecification.name === 'string')
    .map((tool) => ({
      toolSpecification: { ...tool.toolSpecification, name: tool.toolSpecification.name ?? '' }
    }))
  if (matchedResults.length > 0 || suppliedTools.length > 0) {
    currentInput.userInputMessageContext = {}
    if (matchedResults.length > 0) currentInput.userInputMessageContext.toolResults = deduplicateToolResults(matchedResults)
    if (suppliedTools.length > 0) currentInput.userInputMessageContext.tools = suppliedTools
  }
  if (historyHasToolCalling(history)) {
    const existingTools = currentInput.userInputMessageContext?.tools ?? []
    const existingNames = new Set(existingTools.map((tool) => tool.toolSpecification.name))
    const missingNames = [...extractToolNamesFromHistory(history)].filter((name) => !existingNames.has(name))
    if (missingNames.length > 0) {
      currentInput.userInputMessageContext ??= {}
      currentInput.userInputMessageContext.tools = [
        ...existingTools,
        ...missingNames.map((name) => inferToolSpecFromHistory(name, historicalToolUses))
      ]
    }
  }

  const convId = randomUUID()
  const request: CodeWhispererRequest = {
    conversationState: {
      chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
      conversationId: convId,
      currentMessage: { userInputMessage: currentInput },
      ...(history.length > 0 ? { history } : {})
    },
    ...(auth.profileArn ? { profileArn: auth.profileArn } : {})
  }
  return variantEffort === undefined
    ? { request, resolved, convId }
    : { request, resolved, convId, variantEffort }
}
