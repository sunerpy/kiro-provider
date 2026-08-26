import type { ToolCall } from '../../types.js'

export interface DialectGateResult {
  readonly toolCalls: readonly ToolCall[]
  readonly remainderText: string
}

/** Compatibility no-op: streamed model text is never reinterpreted as a tool call. */
export class DialectGate {
  ingest(text: string): string {
    return text
  }

  get suppressing(): boolean {
    return false
  }

  finalize(): DialectGateResult {
    return { toolCalls: [], remainderText: '' }
  }
}
