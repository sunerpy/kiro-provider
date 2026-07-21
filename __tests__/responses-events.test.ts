import { describe, expect, test } from 'bun:test'
import {
  CODEX_RECOGNIZED_TYPES,
  formatSseEvent,
  functionCallArgumentsDelta,
  OPTIONAL_IGNORED_TYPES,
  outputItemAdded,
  outputItemDone,
  outputTextDelta,
  reasoningSummaryTextDelta,
  reasoningSummaryTextDone,
  responseCompleted,
  responseCreated,
  responseFailed
} from '../src/server/responses/events.js'

const messageAddedItem = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  content: []
} as const

const reasoningAddedItem = {
  id: 'rs_1',
  type: 'reasoning',
  summary: []
} as const

const messageDoneItem = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'Hello' }]
} as const

const reasoningDoneItem = {
  id: 'rs_1',
  type: 'reasoning',
  summary: [{ type: 'summary_text', text: 'Checked the contract' }]
} as const

const functionCallDoneItem = {
  type: 'function_call',
  call_id: 'call_1',
  name: 'shell',
  arguments: '{"command":["ls"]}'
} as const

describe('Responses event constructors', () => {
  test('responseCreated uses the exact recognized type and response shape', () => {
    // Given / When
    const event = responseCreated({ responseId: 'resp_1', model: 'auto', sequenceNumber: 0 })

    // Then
    expect(event.type).toBe('response.created')
    expect(CODEX_RECOGNIZED_TYPES).toContain('response.created')
    expect(event).toEqual({
      type: 'response.created',
      sequence_number: 0,
      response: {
        id: 'resp_1',
        object: 'response',
        status: 'in_progress',
        model: 'auto',
        output: []
      }
    })
  })

  test('outputItemAdded uses the exact recognized type and preserves a reasoning seed item', () => {
    // Given / When
    const event = outputItemAdded({ item: reasoningAddedItem, outputIndex: 0, sequenceNumber: 1 })

    // Then
    expect(event.type).toBe('response.output_item.added')
    expect(CODEX_RECOGNIZED_TYPES).toContain('response.output_item.added')
    expect(event).toEqual({
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: { id: 'rs_1', type: 'reasoning', summary: [] }
    })
  })

  test('outputTextDelta uses the exact recognized type and carries all indices', () => {
    // Given / When
    const event = outputTextDelta({
      itemId: 'msg_1',
      outputIndex: 1,
      contentIndex: 0,
      delta: 'Hello',
      sequenceNumber: 2
    })

    // Then
    expect(event.type).toBe('response.output_text.delta')
    expect(CODEX_RECOGNIZED_TYPES).toContain('response.output_text.delta')
    expect(event).toEqual({
      type: 'response.output_text.delta',
      sequence_number: 2,
      item_id: 'msg_1',
      output_index: 1,
      content_index: 0,
      delta: 'Hello'
    })
  })

  test('reasoningSummaryTextDelta uses the exact recognized type and summary index', () => {
    // Given / When
    const event = reasoningSummaryTextDelta({
      itemId: 'rs_1',
      outputIndex: 0,
      summaryIndex: 0,
      delta: 'Checked',
      sequenceNumber: 3
    })

    // Then
    expect(event.type).toBe('response.reasoning_summary_text.delta')
    expect(CODEX_RECOGNIZED_TYPES).toContain('response.reasoning_summary_text.delta')
    expect(event).toEqual({
      type: 'response.reasoning_summary_text.delta',
      sequence_number: 3,
      item_id: 'rs_1',
      output_index: 0,
      summary_index: 0,
      delta: 'Checked'
    })
  })

  test('reasoningSummaryTextDone uses the exact recognized type and accumulated text', () => {
    // Given / When
    const event = reasoningSummaryTextDone({
      itemId: 'rs_1',
      outputIndex: 0,
      summaryIndex: 0,
      text: 'Checked the contract',
      sequenceNumber: 4
    })

    // Then
    expect(event.type).toBe('response.reasoning_summary_text.done')
    expect(CODEX_RECOGNIZED_TYPES).toContain('response.reasoning_summary_text.done')
    expect(event).toEqual({
      type: 'response.reasoning_summary_text.done',
      sequence_number: 4,
      item_id: 'rs_1',
      output_index: 0,
      summary_index: 0,
      text: 'Checked the contract'
    })
  })

  test.each([
    { label: 'message', item: messageDoneItem },
    { label: 'reasoning', item: reasoningDoneItem },
    { label: 'function call', item: functionCallDoneItem }
  ])('outputItemDone uses the exact recognized type and complete $label item', ({ item }) => {
    // Given / When
    const event = outputItemDone({ item, outputIndex: 0, sequenceNumber: 5 })

    // Then
    expect(event.type).toBe('response.output_item.done')
    expect(CODEX_RECOGNIZED_TYPES).toContain('response.output_item.done')
    expect(event).toEqual({
      type: 'response.output_item.done',
      sequence_number: 5,
      output_index: 0,
      item
    })
  })

  test('responseCompleted uses the exact recognized type and complete response shape', () => {
    // Given
    const usage = {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 2 },
      output_tokens: 4,
      output_tokens_details: { reasoning_tokens: 1 },
      total_tokens: 14
    }

    // When
    const event = responseCompleted({
      responseId: 'resp_1',
      model: 'auto',
      output: [reasoningDoneItem, messageDoneItem, functionCallDoneItem],
      usage,
      sequenceNumber: 6
    })

    // Then
    expect(event.type).toBe('response.completed')
    expect(CODEX_RECOGNIZED_TYPES).toContain('response.completed')
    expect(event).toEqual({
      type: 'response.completed',
      sequence_number: 6,
      response: {
        id: 'resp_1',
        object: 'response',
        status: 'completed',
        model: 'auto',
        output: [reasoningDoneItem, messageDoneItem, functionCallDoneItem],
        usage
      }
    })
  })

  test('responseFailed uses the exact recognized type and nested error shape', () => {
    // Given / When
    const event = responseFailed({
      responseId: 'resp_1',
      model: 'auto',
      error: { code: 'upstream_error', message: 'Upstream stream failed' },
      sequenceNumber: 7
    })

    // Then
    expect(event.type).toBe('response.failed')
    expect(CODEX_RECOGNIZED_TYPES).toContain('response.failed')
    expect(event).toEqual({
      type: 'response.failed',
      sequence_number: 7,
      response: {
        id: 'resp_1',
        object: 'response',
        status: 'failed',
        model: 'auto',
        error: { code: 'upstream_error', message: 'Upstream stream failed' }
      }
    })
  })

  test('functionCallArgumentsDelta is optional, codex-ignored, and not recognized', () => {
    // Given / When
    const event = functionCallArgumentsDelta({
      itemId: 'fc_1',
      outputIndex: 2,
      delta: '{"command":',
      sequenceNumber: 8
    })

    // Then
    expect(event.type).toBe('response.function_call_arguments.delta')
    expect(OPTIONAL_IGNORED_TYPES).toContain('response.function_call_arguments.delta')
    expect(CODEX_RECOGNIZED_TYPES).not.toContain('response.function_call_arguments.delta')
    expect(event).toEqual({
      type: 'response.function_call_arguments.delta',
      sequence_number: 8,
      item_id: 'fc_1',
      output_index: 2,
      delta: '{"command":'
    })
  })

  test('type groups contain only the contract literals emitted or intentionally ignored', () => {
    expect(CODEX_RECOGNIZED_TYPES).toEqual([
      'response.created',
      'response.output_item.added',
      'response.output_text.delta',
      'response.output_item.done',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.done',
      'response.completed',
      'response.failed'
    ])
    expect(OPTIONAL_IGNORED_TYPES).toEqual([
      'response.function_call_arguments.delta',
      'response.output_text.done'
    ])
  })
})

describe('formatSseEvent', () => {
  test('writes matching event and data type lines followed by a blank line', () => {
    // Given
    const event = outputItemAdded({ item: messageAddedItem, outputIndex: 0, sequenceNumber: 9 })

    // When
    const serialized = formatSseEvent(event)
    const [eventLine, dataLine] = serialized.trimEnd().split('\n')
    const data: unknown = JSON.parse(dataLine?.slice('data: '.length) ?? '')

    // Then
    expect(serialized).toBe(`event: response.output_item.added\ndata: ${JSON.stringify(event)}\n\n`)
    expect(eventLine).toBe('event: response.output_item.added')
    expect(data).toMatchObject({ type: 'response.output_item.added' })
  })
})
