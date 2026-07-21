export const CODEX_RECOGNIZED_TYPES = [
  'response.created',
  'response.output_item.added',
  'response.output_text.delta',
  'response.output_item.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.completed',
  'response.failed'
] as const

// Codex ignores these event types; they exist only for stricter Responses clients.
export const OPTIONAL_IGNORED_TYPES = [
  'response.function_call_arguments.delta',
  'response.output_text.done'
] as const

export type CodexRecognizedType = (typeof CODEX_RECOGNIZED_TYPES)[number]
export type OptionalIgnoredType = (typeof OPTIONAL_IGNORED_TYPES)[number]

export type OutputTextContent = {
  readonly type: 'output_text'; readonly text: string
}

export type SummaryText = {
  readonly type: 'summary_text'; readonly text: string
}

export type MessageOutputItem = {
  readonly id: string; readonly type: 'message'; readonly role: 'assistant'
  readonly content: readonly OutputTextContent[]
}

export type ReasoningOutputItem = {
  readonly id: string; readonly type: 'reasoning'
  readonly summary: readonly SummaryText[]
}

export type FunctionCallOutputItem = {
  readonly id?: string; readonly type: 'function_call'; readonly call_id: string
  readonly name: string; readonly arguments: string
}

export type ResponseOutputItem =
  | MessageOutputItem
  | ReasoningOutputItem
  | FunctionCallOutputItem

export type ResponseUsage = {
  readonly input_tokens: number; readonly output_tokens: number; readonly total_tokens: number
  readonly input_tokens_details?: Readonly<Record<string, number>>
  readonly output_tokens_details?: Readonly<Record<string, number>>
}

export type ResponseError = {
  readonly code: string; readonly message: string
}

export type ResponseCreatedEvent = {
  readonly type: 'response.created'
  readonly sequence_number: number
  readonly response: {
    readonly id: string; readonly object: 'response'; readonly status: 'in_progress'
    readonly model: string
    readonly output: readonly []
  }
}

export type OutputItemAddedEvent = {
  readonly type: 'response.output_item.added'; readonly sequence_number: number
  readonly output_index: number
  readonly item: ResponseOutputItem
}

export type OutputTextDeltaEvent = {
  readonly type: 'response.output_text.delta'; readonly sequence_number: number
  readonly item_id: string; readonly output_index: number; readonly content_index: number
  readonly delta: string
}

export type ReasoningSummaryTextDeltaEvent = {
  readonly type: 'response.reasoning_summary_text.delta'; readonly sequence_number: number
  readonly item_id: string; readonly output_index: number; readonly summary_index: number
  readonly delta: string
}

export type ReasoningSummaryTextDoneEvent = {
  readonly type: 'response.reasoning_summary_text.done'; readonly sequence_number: number
  readonly item_id: string; readonly output_index: number; readonly summary_index: number
  readonly text: string
}

export type OutputItemDoneEvent = {
  readonly type: 'response.output_item.done'; readonly sequence_number: number
  readonly output_index: number
  readonly item: ResponseOutputItem
}

export type ResponseCompletedEvent = {
  readonly type: 'response.completed'
  readonly sequence_number: number
  readonly response: {
    readonly id: string; readonly object: 'response'; readonly status: 'completed'
    readonly model: string
    readonly output: readonly ResponseOutputItem[]
    readonly usage: ResponseUsage
  }
}

export type ResponseFailedEvent = {
  readonly type: 'response.failed'
  readonly sequence_number: number
  readonly response: {
    readonly id: string; readonly object: 'response'; readonly status: 'failed'
    readonly model: string
    readonly error: ResponseError
  }
}

export type FunctionCallArgumentsDeltaEvent = {
  readonly type: 'response.function_call_arguments.delta'; readonly sequence_number: number
  readonly item_id: string; readonly output_index: number
  readonly delta: string
}

export type ResponsesEvent =
  | ResponseCreatedEvent
  | OutputItemAddedEvent
  | OutputTextDeltaEvent
  | ReasoningSummaryTextDeltaEvent
  | ReasoningSummaryTextDoneEvent
  | OutputItemDoneEvent
  | ResponseCompletedEvent
  | ResponseFailedEvent
  | FunctionCallArgumentsDeltaEvent

export function responseCreated(input: {
  readonly responseId: string
  readonly model: string
  readonly sequenceNumber: number
}): ResponseCreatedEvent {
  return {
    type: 'response.created',
    sequence_number: input.sequenceNumber,
    response: {
      id: input.responseId,
      object: 'response',
      status: 'in_progress',
      model: input.model,
      output: []
    }
  }
}

export function outputItemAdded(input: {
  readonly item: ResponseOutputItem
  readonly outputIndex: number
  readonly sequenceNumber: number
}): OutputItemAddedEvent {
  return {
    type: 'response.output_item.added',
    sequence_number: input.sequenceNumber,
    output_index: input.outputIndex,
    item: input.item
  }
}

export function outputTextDelta(input: {
  readonly itemId: string
  readonly outputIndex: number
  readonly contentIndex: number
  readonly delta: string
  readonly sequenceNumber: number
}): OutputTextDeltaEvent {
  return {
    type: 'response.output_text.delta',
    sequence_number: input.sequenceNumber,
    item_id: input.itemId,
    output_index: input.outputIndex,
    content_index: input.contentIndex,
    delta: input.delta
  }
}

export function reasoningSummaryTextDelta(input: {
  readonly itemId: string
  readonly outputIndex: number
  readonly summaryIndex: number
  readonly delta: string
  readonly sequenceNumber: number
}): ReasoningSummaryTextDeltaEvent {
  return {
    type: 'response.reasoning_summary_text.delta',
    sequence_number: input.sequenceNumber,
    item_id: input.itemId,
    output_index: input.outputIndex,
    summary_index: input.summaryIndex,
    delta: input.delta
  }
}

export function reasoningSummaryTextDone(input: {
  readonly itemId: string
  readonly outputIndex: number
  readonly summaryIndex: number
  readonly text: string
  readonly sequenceNumber: number
}): ReasoningSummaryTextDoneEvent {
  return {
    type: 'response.reasoning_summary_text.done',
    sequence_number: input.sequenceNumber,
    item_id: input.itemId,
    output_index: input.outputIndex,
    summary_index: input.summaryIndex,
    text: input.text
  }
}

export function outputItemDone(input: {
  readonly item: ResponseOutputItem
  readonly outputIndex: number
  readonly sequenceNumber: number
}): OutputItemDoneEvent {
  return {
    type: 'response.output_item.done',
    sequence_number: input.sequenceNumber,
    output_index: input.outputIndex,
    item: input.item
  }
}

export function responseCompleted(input: {
  readonly responseId: string
  readonly model: string
  readonly output: readonly ResponseOutputItem[]
  readonly usage: ResponseUsage
  readonly sequenceNumber: number
}): ResponseCompletedEvent {
  return {
    type: 'response.completed',
    sequence_number: input.sequenceNumber,
    response: {
      id: input.responseId,
      object: 'response',
      status: 'completed',
      model: input.model,
      output: input.output,
      usage: input.usage
    }
  }
}

export function responseFailed(input: {
  readonly responseId: string
  readonly model: string
  readonly error: ResponseError
  readonly sequenceNumber: number
}): ResponseFailedEvent {
  return {
    type: 'response.failed',
    sequence_number: input.sequenceNumber,
    response: {
      id: input.responseId,
      object: 'response',
      status: 'failed',
      model: input.model,
      error: input.error
    }
  }
}

export function functionCallArgumentsDelta(input: {
  readonly itemId: string
  readonly outputIndex: number
  readonly delta: string
  readonly sequenceNumber: number
}): FunctionCallArgumentsDeltaEvent {
  return {
    type: 'response.function_call_arguments.delta',
    sequence_number: input.sequenceNumber,
    item_id: input.itemId,
    output_index: input.outputIndex,
    delta: input.delta
  }
}

export function formatSseEvent(event: ResponsesEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}
