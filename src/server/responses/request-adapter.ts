import type {
  ResponsesAdditionalToolsItem,
  ResponsesAgentMessageItem,
  ResponsesContentPart,
  ResponsesCustomToolCallItem,
  ResponsesCustomToolCallOutputItem,
  ResponsesFunctionCallItem,
  ResponsesFunctionCallOutputItem,
  ResponsesInputItem,
  ResponsesMessageItem,
  ResponsesReasoningItem,
  ResponsesRequest
} from '../request-schema.js'
import {
  createResponsesToolBridge,
  type InternalTool,
  type ResponsesToolBridge
} from './tool-bridge.js'

type InternalContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } }
  | { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: string }

type InternalMessage =
  | { readonly role: 'system' | 'user'; readonly content: string | InternalContentPart[] }
  | {
      readonly role: 'assistant'
      readonly content?: InternalContentPart[]
      readonly tool_calls?: Array<{
        readonly id: string
        readonly type: 'function'
        readonly function: { readonly name: string; readonly arguments: string }
      }>
    }
  | { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string }

export interface InternalChatBody {
  readonly model: string
  readonly stream: boolean
  readonly messages: InternalMessage[]
  readonly tools?: InternalTool[]
  readonly tool_choice?: 'auto'
  readonly reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export type ResponsesToInternalChatResult =
  | { readonly ok: true; readonly body: InternalChatBody; readonly bridge: ResponsesToolBridge }
  | {
      readonly ok: false
      readonly code: 'empty_input' | 'invalid_tool_declaration' | 'invalid_tool_history'
      readonly message?: string
    }

function isMessageItem(item: ResponsesInputItem): item is ResponsesMessageItem {
  return (
    item.type === 'message' ||
    (item.type === undefined && 'role' in item && 'content' in item)
  )
}

function isAgentMessageItem(item: ResponsesInputItem): item is ResponsesAgentMessageItem {
  return item.type === 'agent_message'
}

function isFunctionCallItem(item: ResponsesInputItem): item is ResponsesFunctionCallItem {
  return item.type === 'function_call'
}

function isCustomToolCallItem(item: ResponsesInputItem): item is ResponsesCustomToolCallItem {
  return item.type === 'custom_tool_call'
}

function isFunctionCallOutputItem(
  item: ResponsesInputItem
): item is ResponsesFunctionCallOutputItem {
  return item.type === 'function_call_output'
}

function isCustomToolCallOutputItem(
  item: ResponsesInputItem
): item is ResponsesCustomToolCallOutputItem {
  return item.type === 'custom_tool_call_output'
}

function isAdditionalToolsItem(
  item: ResponsesInputItem
): item is ResponsesAdditionalToolsItem {
  return item.type === 'additional_tools'
}

function isReasoningItem(item: ResponsesInputItem): item is ResponsesReasoningItem {
  return item.type === 'reasoning'
}

function mapContentParts(
  parts: ResponsesContentPart[],
  skippedUnknownParts: { count: number }
): InternalContentPart[] {
  const mapped: InternalContentPart[] = []
  for (const part of parts) {
    if (
      (part.type === 'input_text' || part.type === 'output_text') &&
      'text' in part &&
      typeof part.text === 'string'
    ) {
      mapped.push({ type: 'text', text: part.text })
      continue
    }
    if (
      part.type === 'input_image' &&
      'image_url' in part &&
      typeof part.image_url === 'string'
    ) {
      mapped.push({ type: 'image_url', image_url: { url: part.image_url } })
      continue
    }
    skippedUnknownParts.count++
  }
  return mapped
}

function mapMessageContent(
  content: ResponsesMessageItem['content'],
  skippedUnknownParts: { count: number }
): string | InternalContentPart[] {
  return typeof content === 'string'
    ? content
    : mapContentParts(content, skippedUnknownParts)
}

function assistantContent(
  content: string | InternalContentPart[]
): InternalContentPart[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content
}

function normalizedEffort(
  effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined
): InternalChatBody['reasoning_effort'] | undefined {
  if (effort === 'minimal') return 'low'
  if (
    effort === 'low' ||
    effort === 'medium' ||
    effort === 'high' ||
    effort === 'xhigh' ||
    effort === 'max'
  ) {
    return effort
  }
  return undefined
}

function normalizeFunctionOutput(
  output: ResponsesFunctionCallOutputItem['output'] | ResponsesCustomToolCallOutputItem['output']
): string {
  if (typeof output === 'string') return output
  return output.flatMap((part) => (part.text === undefined ? [] : [part.text])).join('\n')
}

export function responsesToInternalChat(req: ResponsesRequest): ResponsesToInternalChatResult {
  const bridgeResult = createResponsesToolBridge(req)
  if (!bridgeResult.ok) {
    return {
      ok: false,
      code: bridgeResult.code,
      message: bridgeResult.message
    }
  }
  const bridge = bridgeResult.bridge
  const messages: InternalMessage[] = []
  const tools = [...bridge.internalTools]
  const declarationsPresent =
    req.tools !== undefined ||
    (typeof req.input !== 'string' && req.input.some((item) => isAdditionalToolsItem(item)))
  const skippedUnknownParts = { count: 0 }
  let skippedUnknownItems = 0
  let skippedAdditionalTools = 0
  let executableInputSeen = false

  if (req.instructions && req.instructions.length > 0) {
    messages.push({ role: 'system', content: req.instructions })
  }

  if (typeof req.input === 'string') {
    messages.push({ role: 'user', content: req.input })
    executableInputSeen = true
  } else {
    for (const item of req.input) {
      if (isReasoningItem(item)) {
        continue
      }

      if (isFunctionCallItem(item) || isCustomToolCallItem(item)) {
        messages.push({
          role: 'assistant',
          tool_calls: [bridge.lowerCall(item)]
        })
        executableInputSeen = true
        continue
      }

      if (isMessageItem(item)) {
        const content = mapMessageContent(item.content, skippedUnknownParts)
        if (item.role === 'assistant') {
          messages.push({ role: 'assistant', content: assistantContent(content) })
          executableInputSeen = true
        } else {
          messages.push({ role: item.role === 'developer' ? 'system' : item.role, content })
          if (item.role === 'user') executableInputSeen = true
        }
        continue
      }

      if (isAgentMessageItem(item)) {
        const content = mapContentParts(item.content, skippedUnknownParts)
        messages.push({ role: 'user', content })
        executableInputSeen = true
        continue
      }

      if (isFunctionCallOutputItem(item) || isCustomToolCallOutputItem(item)) {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: item.call_id,
              content: normalizeFunctionOutput(item.output)
            }
          ]
        })
        executableInputSeen = true
        continue
      }

      if (isAdditionalToolsItem(item)) {
        skippedAdditionalTools += item.tools.filter(
          (tool) => tool.type !== 'function' && tool.type !== 'custom' && tool.type !== 'namespace'
        ).length
        continue
      }

      skippedUnknownItems++
    }
  }

  void skippedUnknownItems
  void skippedUnknownParts.count
  void skippedAdditionalTools

  if (!executableInputSeen) return { ok: false, code: 'empty_input' }

  const effort = normalizedEffort(req.reasoning?.effort)
  const body: InternalChatBody = {
    model: req.model,
    stream: req.stream,
    messages,
    ...(tools.length > 0 || declarationsPresent ? { tools } : {}),
    ...(req.tool_choice !== undefined ? { tool_choice: req.tool_choice } : {}),
    ...(effort !== undefined ? { reasoning_effort: effort } : {})
  }
  return { ok: true, body, bridge }
}
