export interface ToolInput {
  type?: string
  name?: string
  description?: string
  input_schema?: Record<string, unknown>
  function?: {
    name?: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export interface CodeWhispererTool {
  toolSpecification: {
    name: string | undefined
    description: string
    inputSchema: { json: Record<string, unknown> }
  }
}

export interface ToolResult {
  toolUseId: string
  content: Array<{ text?: string }>
  status?: string
}

export function convertToolsToCodeWhisperer(tools: ToolInput[]): CodeWhispererTool[] {
  return tools.map((tool) => ({
    toolSpecification: {
      name: tool.name || tool.function?.name,
      description: (tool.description || tool.function?.description || '').substring(0, 9216),
      inputSchema: { json: tool.input_schema || tool.function?.parameters || {} }
    }
  }))
}

export function deduplicateToolResults<T extends { toolUseId: string }>(results: T[]): T[] {
  const unique: T[] = []
  const seen = new Set<string>()
  for (const result of results) {
    if (!seen.has(result.toolUseId)) {
      seen.add(result.toolUseId)
      unique.push(result)
    }
  }
  return unique
}
