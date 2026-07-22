import type {
  ResponsesAdditionalToolsItem,
  ResponsesContentPart,
  ResponsesFunctionCallItem,
  ResponsesFunctionCallOutputItem,
  ResponsesInputItem,
  ResponsesMessageItem,
  ResponsesReasoningItem,
  ResponsesRequest
} from '../request-schema.js'

type InternalContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } }
  | { readonly type: 'thinking'; readonly thinking: string }

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

type InternalTool = {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description?: string
    readonly parameters?: Record<string, unknown>
  }
}

export interface InternalChatBody {
  readonly model: string
  readonly stream: boolean
  readonly messages: InternalMessage[]
  readonly tools?: InternalTool[]
  readonly tool_choice?: 'auto'
  readonly reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh'
}

export type ResponsesToInternalChatResult =
  | { readonly ok: true; readonly body: InternalChatBody }
  | { readonly ok: false; readonly code: 'empty_input' }

function isMessageItem(item: ResponsesInputItem): item is ResponsesMessageItem {
  return item.type === 'message'
}

function isFunctionCallItem(item: ResponsesInputItem): item is ResponsesFunctionCallItem {
  return item.type === 'function_call'
}

function isFunctionCallOutputItem(
  item: ResponsesInputItem
): item is ResponsesFunctionCallOutputItem {
  return item.type === 'function_call_output'
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

function visibleReasoning(item: ResponsesReasoningItem): string {
  return [
    ...(item.summary ?? []).map((part) => part.text),
    ...(item.content ?? []).map((part) => part.reasoning_text)
  ]
    .filter((text) => text.length > 0)
    .join('\n')
}

function normalizedEffort(
  effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined
): InternalChatBody['reasoning_effort'] | undefined {
  if (effort === 'minimal') return 'low'
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') {
    return effort
  }
  return undefined
}

function thinkingPart(text: string): InternalContentPart {
  return { type: 'thinking', thinking: text }
}

function normalizeFunctionOutput(output: ResponsesFunctionCallOutputItem['output']): string {
  if (typeof output === 'string') return output
  return output.flatMap((part) => (part.text === undefined ? [] : [part.text])).join('\n')
}

function topLevelTool(tool: NonNullable<ResponsesRequest['tools']>[number]): InternalTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {})
    }
  }
}

export function responsesToInternalChat(req: ResponsesRequest): ResponsesToInternalChatResult {
  const messages: InternalMessage[] = []
  const tools = (req.tools ?? []).map(topLevelTool)
  const toolNames = new Set(tools.map((tool) => tool.function.name))
  const skippedUnknownParts = { count: 0 }
  let skippedUnknownItems = 0
  let skippedAdditionalTools = 0
  let executableInputSeen = false
  let pendingReasoning = ''

  if (req.instructions && req.instructions.length > 0) {
    messages.push({ role: 'system', content: req.instructions })
  }

  if (typeof req.input === 'string') {
    messages.push({ role: 'user', content: req.input })
    executableInputSeen = true
  } else {
    const flushPendingReasoning = (): void => {
      if (!pendingReasoning) return
      messages.push({ role: 'assistant', content: [thinkingPart(pendingReasoning)] })
      pendingReasoning = ''
      executableInputSeen = true
    }

    for (const item of req.input) {
      if (isReasoningItem(item)) {
        const text = visibleReasoning(item)
        if (text) pendingReasoning = pendingReasoning ? `${pendingReasoning}\n${text}` : text
        continue
      }

      if (isFunctionCallItem(item)) {
        messages.push({
          role: 'assistant',
          ...(pendingReasoning ? { content: [thinkingPart(pendingReasoning)] } : {}),
          tool_calls: [
            {
              id: item.call_id,
              type: 'function',
              function: { name: item.name, arguments: item.arguments }
            }
          ]
        })
        pendingReasoning = ''
        executableInputSeen = true
        continue
      }

      if (isMessageItem(item)) {
        if (item.role !== 'assistant') flushPendingReasoning()
        const content = mapContentParts(item.content, skippedUnknownParts)
        if (item.role === 'assistant') {
          messages.push({
            role: 'assistant',
            content: pendingReasoning ? [thinkingPart(pendingReasoning), ...content] : content
          })
          pendingReasoning = ''
          executableInputSeen = true
        } else {
          messages.push({ role: item.role === 'developer' ? 'system' : item.role, content })
          if (item.role === 'user') executableInputSeen = true
        }
        continue
      }

      if (isFunctionCallOutputItem(item)) {
        flushPendingReasoning()
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content: normalizeFunctionOutput(item.output)
        })
        executableInputSeen = true
        continue
      }

      if (isAdditionalToolsItem(item)) {
        for (const tool of item.tools) {
          if (
            tool.type !== 'function' ||
            typeof tool.name !== 'string' ||
            tool.name.length === 0 ||
            typeof tool.parameters !== 'object' ||
            tool.parameters === null ||
            Array.isArray(tool.parameters) ||
            toolNames.has(tool.name)
          ) {
            skippedAdditionalTools++
            continue
          }
          tools.push({
            type: 'function',
            function: {
              name: tool.name,
              ...(typeof tool.description === 'string'
                ? { description: tool.description }
                : {}),
              parameters: Object.fromEntries(Object.entries(tool.parameters))
            }
          })
          toolNames.add(tool.name)
        }
        continue
      }

      flushPendingReasoning()
      skippedUnknownItems++
    }
    flushPendingReasoning()
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
    ...(tools.length > 0 || req.tools !== undefined ? { tools } : {}),
    ...(req.tool_choice !== undefined ? { tool_choice: req.tool_choice } : {}),
    ...(effort !== undefined ? { reasoning_effort: effort } : {})
  }
  return { ok: true, body }
}
