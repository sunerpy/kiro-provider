import type { ToolCall } from '../types.js'

export function parseBracketToolCalls(text: string): ToolCall[] {
  const toolCalls: ToolCall[] = []
  const pattern = /\[Called\s+(\w+)\s+with\s+args:\s*(\{[^}]*(?:\{[^}]*\}[^}]*)*\})\]/gs
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const functionName = match[1]
    const argumentsText = match[2]
    if (!functionName || !argumentsText) continue
    try {
      toolCalls.push({
        toolUseId: generateToolUseId(),
        name: functionName,
        input: JSON.parse(argumentsText)
      })
    } catch {}
  }
  return toolCalls
}

export function deduplicateToolCalls(toolCalls: ToolCall[]): ToolCall[] {
  const seen = new Set<string>()
  const unique: ToolCall[] = []
  for (const toolCall of toolCalls) {
    if (!seen.has(toolCall.toolUseId)) {
      seen.add(toolCall.toolUseId)
      unique.push(toolCall)
    }
  }
  return unique
}

export function cleanToolCallsFromText(text: string, toolCalls: ToolCall[]): string {
  let cleaned = text
  for (const toolCall of toolCalls) {
    const escapedName = toolCall.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    cleaned = cleaned.replace(
      new RegExp(
        `\\[Called\\s+${escapedName}\\s+with\\s+args:\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}\\]`,
        'gs'
      ),
      ''
    )
  }
  return cleaned.replace(/\s+/g, ' ').trim()
}

export const DSML_MARKER = '<\uFF5CDSML\uFF5Cfunction_calls'

interface DialectMatch {
  start: number
  end: number
  toolCalls: ToolCall[]
}

function generateToolUseId(): string {
  return `tool_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
}

function computeCodeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const fence = /```[\s\S]*?```/g
  for (let match = fence.exec(text); match !== null; match = fence.exec(text)) {
    ranges.push([match.index, match.index + match[0].length])
  }

  const isInsideFence = (index: number): boolean =>
    ranges.some(([start, end]) => index >= start && index < end)
  const inline = /`[^`\n]+`/g
  for (let match = inline.exec(text); match !== null; match = inline.exec(text)) {
    if (!isInsideFence(match.index)) ranges.push([match.index, match.index + match[0].length])
  }
  return ranges
}

function overlapsRange(start: number, end: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart)
}

function parseInvokeParameters(body: string): Record<string, unknown> {
  const input: Record<string, unknown> = {}
  const parameterPattern = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g
  for (
    let match = parameterPattern.exec(body);
    match !== null;
    match = parameterPattern.exec(body)
  ) {
    const key = match[1]
    if (key === undefined) continue
    const value = match[2] ?? ''
    try {
      input[key] = JSON.parse(value)
    } catch {
      input[key] = value
    }
  }
  return input
}

function toolCallFromInvoke(name: string, body: string): ToolCall {
  return { toolUseId: generateToolUseId(), name, input: parseInvokeParameters(body) }
}

function matchAnthropicXml(
  text: string,
  codeRanges: Array<[number, number]>,
  claimed: Array<[number, number]>
): DialectMatch[] {
  const matches: DialectMatch[] = []
  const blockPattern = /<function_calls>[\s\S]*?<\/function_calls>/g
  for (
    let blockMatch = blockPattern.exec(text);
    blockMatch !== null;
    blockMatch = blockPattern.exec(text)
  ) {
    const start = blockMatch.index
    const end = start + blockMatch[0].length
    if (overlapsRange(start, end, codeRanges)) continue
    const invokePattern = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g
    const toolCalls: ToolCall[] = []
    for (
      let invokeMatch = invokePattern.exec(blockMatch[0]);
      invokeMatch !== null;
      invokeMatch = invokePattern.exec(blockMatch[0])
    ) {
      const name = invokeMatch[1]
      if (name) toolCalls.push(toolCallFromInvoke(name, invokeMatch[2] ?? ''))
    }
    if (toolCalls.length === 0) continue
    matches.push({ start, end, toolCalls })
    claimed.push([start, end])
  }

  const invokePattern = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g
  for (
    let standaloneMatch = invokePattern.exec(text);
    standaloneMatch !== null;
    standaloneMatch = invokePattern.exec(text)
  ) {
    const start = standaloneMatch.index
    const end = start + standaloneMatch[0].length
    const name = standaloneMatch[1]
    if (!name || overlapsRange(start, end, codeRanges) || overlapsRange(start, end, claimed)) continue
    matches.push({ start, end, toolCalls: [toolCallFromInvoke(name, standaloneMatch[2] ?? '')] })
    claimed.push([start, end])
  }
  return matches
}

function matchDsml(
  text: string,
  codeRanges: Array<[number, number]>,
  claimed: Array<[number, number]>
): DialectMatch[] {
  const matches: DialectMatch[] = []
  let from = 0
  for (;;) {
    const start = text.indexOf(DSML_MARKER, from)
    if (start === -1) break
    const rest = text.slice(start + DSML_MARKER.length)
    const closingMatch = /<\uFF5C[^>]*?end[^>]*?>|<\/\uFF5CDSML[^>]*?>/.exec(rest)
    const end =
      closingMatch !== null
        ? start + DSML_MARKER.length + closingMatch.index + closingMatch[0].length
        : text.length
    from = end
    if (overlapsRange(start, end, codeRanges) || overlapsRange(start, end, claimed)) continue

    const span = text.slice(start, end)
    const toolCalls: ToolCall[] = []
    const nameMatch = /name["\uFF5C=:\s]+["']?([A-Za-z0-9_]+)/.exec(span)
    const jsonMatch = /(\{[\s\S]*\})/.exec(span)
    if (nameMatch?.[1] && jsonMatch?.[1]) {
      try {
        toolCalls.push({
          toolUseId: generateToolUseId(),
          name: nameMatch[1],
          input: JSON.parse(jsonMatch[1])
        })
      } catch {}
    }
    matches.push({ start, end, toolCalls })
    claimed.push([start, end])
  }
  return matches
}

function matchBracket(
  text: string,
  codeRanges: Array<[number, number]>,
  claimed: Array<[number, number]>
): DialectMatch[] {
  const matches: DialectMatch[] = []
  const pattern = /\[Called\s+(\w+)\s+with\s+args:\s*(\{[^}]*(?:\{[^}]*\}[^}]*)*\})\]/gs
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const start = match.index
    const end = start + match[0].length
    const name = match[1]
    const argumentsText = match[2]
    if (!name || !argumentsText || overlapsRange(start, end, codeRanges) || overlapsRange(start, end, claimed)) {
      continue
    }
    let input: Record<string, unknown>
    try {
      input = JSON.parse(argumentsText)
    } catch {
      continue
    }
    matches.push({ start, end, toolCalls: [{ toolUseId: generateToolUseId(), name, input }] })
    claimed.push([start, end])
  }
  return matches
}

export function parseTextToolCalls(text: string): { toolCalls: ToolCall[]; cleanedText: string } {
  if (!text) return { toolCalls: [], cleanedText: text }
  const codeRanges = computeCodeRanges(text)
  const claimed: Array<[number, number]> = []
  const matches = [
    ...matchAnthropicXml(text, codeRanges, claimed),
    ...matchDsml(text, codeRanges, claimed),
    ...matchBracket(text, codeRanges, claimed)
  ]
  if (matches.length === 0) return { toolCalls: [], cleanedText: text }
  matches.sort((left, right) => left.start - right.start)

  const toolCalls: ToolCall[] = []
  let cleanedText = ''
  let cursor = 0
  for (const match of matches) {
    if (match.start < cursor) continue
    cleanedText += text.slice(cursor, match.start)
    cursor = match.end
    toolCalls.push(...match.toolCalls)
  }
  cleanedText += text.slice(cursor)
  return { toolCalls, cleanedText }
}
