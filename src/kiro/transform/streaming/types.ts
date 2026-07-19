export interface StreamDelta {
  readonly type: string
  readonly text?: string
  readonly thinking?: string
  readonly partial_json?: string
  readonly stop_reason?: string
}

export interface StreamContentBlock {
  readonly type: string
  readonly text?: string
  readonly thinking?: string
  readonly id?: string
  readonly name?: string
  readonly input?: Readonly<Record<string, unknown>>
}

export interface StreamUsage {
  readonly input_tokens?: number
  readonly output_tokens?: number
  readonly cache_creation_input_tokens?: number
  readonly cache_read_input_tokens?: number
}

export interface StreamEvent {
  readonly type: string
  readonly message?: unknown
  readonly content_block?: StreamContentBlock
  readonly delta?: StreamDelta
  readonly index?: number
  readonly usage?: StreamUsage
}

/** Mutable accumulator owned by one SDK stream transformation. */
export interface StreamState {
  thinkingRequested: boolean
  buffer: string
  inThinking: boolean
  thinkingExtracted: boolean
  thinkingBlockIndex: number | null
  textBlockIndex: number | null
  nextBlockIndex: number
  stoppedBlocks: Set<number>
}

/** Mutable accumulator for fragments belonging to one SDK tool call. */
export interface ToolCallState {
  readonly toolUseId: string
  readonly name: string
  input: string
}

export const THINKING_START_TAG = '<thinking>' as const
export const THINKING_END_TAG = '</thinking>' as const
