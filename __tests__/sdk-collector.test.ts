import { describe, expect, test } from 'bun:test'
import { collectSdkResponse } from '../src/kiro/transform/sdk-collector.js'
import type {
  SdkStreamEvent,
  SdkStreamResponse
} from '../src/kiro/transform/streaming/sdk-stream-runtime.js'

function responseFrom(events: readonly SdkStreamEvent[]): SdkStreamResponse {
  const hasCompletion = events.some(
    (event) => event.metadataEvent?.tokenUsage !== undefined
  )
  return {
    generateAssistantResponseResponse: {
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
        for (const event of events) yield event
        if (!hasCompletion) {
          yield {
            metadataEvent: {
              tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
            }
          }
        }
      }
    }
  }
}

function exactResponse(events: readonly SdkStreamEvent[]): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
        for (const event of events) yield event
      }
    }
  }
}

describe('collectSdkResponse tool aggregation', () => {
  test('aggregates fragments with the same toolUseId into one tool call', async () => {
    const response = responseFrom([
      { toolUseEvent: { name: 'write', toolUseId: 'tool-1', input: '{"path":"a",' } },
      { toolUseEvent: { name: 'write', toolUseId: 'tool-1', input: '"content":"b"}' } },
      { toolUseEvent: { name: 'write', toolUseId: 'tool-1', input: '', stop: true } }
    ])

    const completion = await collectSdkResponse(response, 'claude-opus-4-8', 'conversation-1')

    expect(completion.toolCalls).toEqual([
      {
        id: 'tool-1',
        name: 'write',
        input: '{"path":"a","content":"b"}'
      }
    ])
    expect(completion.finishReason).toBe('tool_calls')
  })

  test('aggregates interleaved duplicate ids while preserving distinct tools', async () => {
    const response = responseFrom([
      { toolUseEvent: { name: 'first', toolUseId: 'tool-a', input: '{"x":' } },
      { toolUseEvent: { name: 'second', toolUseId: 'tool-b', input: '{"y":2}' } },
      { toolUseEvent: { name: 'second', toolUseId: 'tool-b', input: '', stop: true } },
      { toolUseEvent: { name: 'first', toolUseId: 'tool-a', input: '1}', stop: true } }
    ])

    const completion = await collectSdkResponse(response, 'auto', 'conversation-2')

    expect(completion.toolCalls).toEqual([
      {
        id: 'tool-a',
        name: 'first',
        input: '{"x":1}'
      },
      {
        id: 'tool-b',
        name: 'second',
        input: '{"y":2}'
      }
    ])
  })
})

describe('collectSdkResponse content and usage', () => {
  test('returns reasoning-only output separately from empty content', async () => {
    const response = responseFrom([
      { reasoningContentEvent: { text: 'inspect the constraints' } },
      { reasoningContentEvent: { text: ' then decide' } }
    ])

    const completion = await collectSdkResponse(response, 'claude-opus-4-8', 'reasoning-only')

    expect(completion.text).toBe('')
    expect(completion.reasoning?.text).toBe('inspect the constraints then decide')
    expect(completion.finishReason).toBe('stop')
  })

  test('collects reasoning and assistant text into separate message fields', async () => {
    const response = responseFrom([
      { reasoningContentEvent: { text: 'reason' } },
      { assistantResponseEvent: { content: 'answer ' } },
      { assistantResponseEvent: { content: 'complete' } }
    ])

    const completion = await collectSdkResponse(response, 'claude-opus-4-8', 'mixed-content')

    expect(completion.text).toBe('answer complete')
    expect(completion.reasoning?.text).toBe('reason')
  })

  test('maps metadata token usage to OpenAI usage', async () => {
    const response = responseFrom([
      { assistantResponseEvent: { content: 'answer' } },
      {
        metadataEvent: {
          tokenUsage: {
            uncachedInputTokens: 10,
            cacheReadInputTokens: 3,
            cacheWriteInputTokens: 2,
            outputTokens: 7,
            totalTokens: 22
          }
        }
      }
    ])

    const completion = await collectSdkResponse(response, 'auto', 'usage')

    expect(completion.usage).toEqual({
      inputTokens: 15,
      outputTokens: 7,
      totalTokens: 22
    })
  })
})

describe('collectSdkResponse fail-closed stream validation', () => {
  test('accepts valid metering followed by clean EOF as a completion witness', async () => {
    const completion = await collectSdkResponse(
      exactResponse([
        { assistantResponseEvent: { content: 'complete' } },
        { metadataEvent: {} },
        { contextUsageEvent: { contextUsagePercentage: 0.01 } },
        { meteringEvent: { usage: 0.03, unit: 'credit', unitPlural: 'credits' } }
      ]),
      'auto',
      'metering-complete'
    )

    expect(completion.text).toBe('complete')
    expect(completion.finishReason).toBe('stop')
  })

  test('rejects clean EOF without an authoritative completion witness', async () => {
    const pending = collectSdkResponse(
      exactResponse([{ assistantResponseEvent: { content: 'partial' } }]),
      'auto',
      'truncated'
    )

    await expect(pending).rejects.toMatchObject({
      name: 'SemanticStreamTruncationError',
      code: 'upstream_stream_incomplete'
    })
  })

  test('rejects empty or malformed metering events as completion witnesses', async () => {
    for (const meteringEvent of [
      {},
      { usage: Number.NaN, unit: 'credit' },
      { usage: -1, unit: 'credit' },
      { usage: 1, unit: '' }
    ]) {
      await expect(
        collectSdkResponse(
          exactResponse([
            { assistantResponseEvent: { content: 'partial' } },
            { meteringEvent }
          ]),
          'auto',
          'invalid-metering'
        )
      ).rejects.toMatchObject({ code: 'upstream_stream_incomplete' })
    }
  })

  test('rejects embedded errors and unknown event types', async () => {
    await expect(
      collectSdkResponse(
        exactResponse([{ error: { message: 'failed' } }]),
        'auto',
        'embedded-error'
      )
    ).rejects.toMatchObject({ code: 'upstream_stream_error' })
    await expect(
      collectSdkResponse(
        exactResponse([{ $unknown: ['futureEvent', {}] }]),
        'auto',
        'unknown-event'
      )
    ).rejects.toMatchObject({ code: 'unsupported_upstream_event' })
  })

  test('rejects malformed or incomplete tool calls', async () => {
    await expect(
      collectSdkResponse(
        exactResponse([
          { toolUseEvent: { name: 'write', toolUseId: 'tool-1', input: '{"x":1}' } },
          {
            metadataEvent: {
              tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
            }
          }
        ]),
        'auto',
        'incomplete-tool'
      )
    ).rejects.toMatchObject({
      name: 'ToolCallViolation',
      code: 'incomplete_upstream_tool_call',
      violationKind: 'missing_stop'
    })
    await expect(
      collectSdkResponse(
        exactResponse([
          { toolUseEvent: { name: 'write', toolUseId: 'tool-1', input: '{', stop: true } },
          {
            metadataEvent: {
              tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
            }
          }
        ]),
        'auto',
        'malformed-tool'
      )
    ).rejects.toMatchObject({
      name: 'ToolCallViolation',
      code: 'malformed_upstream_tool_arguments',
      violationKind: 'malformed_arguments',
      fragmentCount: 1
    })
    await expect(
      collectSdkResponse(
        exactResponse([
          { toolUseEvent: { name: 'write', input: '{}', stop: true } },
          {
            metadataEvent: {
              tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
            }
          }
        ]),
        'auto',
        'missing-tool-id'
      )
    ).rejects.toMatchObject({
      name: 'ToolCallViolation',
      code: 'invalid_upstream_tool_call',
      violationKind: 'missing_identity'
    })
  })

  test('keeps structural tool identity and ordering violations fatal', async () => {
    await expect(
      collectSdkResponse(
        exactResponse([
          { toolUseEvent: { name: 'write', toolUseId: 'tool-1', input: '{"x":' } },
          {
            toolUseEvent: {
              name: 'shell',
              toolUseId: 'tool-1',
              input: '1}',
              stop: true
            }
          }
        ]),
        'auto',
        'renamed-tool'
      )
    ).rejects.toMatchObject({
      name: 'ToolCallViolation',
      code: 'invalid_upstream_tool_call',
      violationKind: 'name_changed'
    })

    await expect(
      collectSdkResponse(
        exactResponse([
          {
            toolUseEvent: {
              name: 'write',
              toolUseId: 'tool-1',
              input: '{"x":1}',
              stop: true
            }
          },
          {
            toolUseEvent: {
              name: 'write',
              toolUseId: 'tool-1',
              input: ' trailing'
            }
          }
        ]),
        'auto',
        'arguments-after-stop'
      )
    ).rejects.toMatchObject({
      name: 'ToolCallViolation',
      code: 'invalid_upstream_tool_call',
      violationKind: 'arguments_after_stop'
    })
  })
})

test('collectSdkResponse stops an aborted iterator and calls return', async () => {
  const controller = new AbortController()
  let returnCalled = false
  let notifySecondNext: (() => void) | undefined
  const secondNextStarted = new Promise<void>((resolve) => {
    notifySecondNext = resolve
  })
  let eventIndex = 0
  const iterator: AsyncIterator<SdkStreamEvent> = {
    next(): Promise<IteratorResult<SdkStreamEvent>> {
      eventIndex += 1
      if (eventIndex === 1) {
        return Promise.resolve({
          done: false,
          value: { assistantResponseEvent: { content: 'partial' } }
        })
      }
      notifySecondNext?.()
      return new Promise<IteratorResult<SdkStreamEvent>>(() => undefined)
    },
    return(): Promise<IteratorResult<SdkStreamEvent>> {
      returnCalled = true
      return Promise.resolve({ done: true, value: undefined })
    }
  }
  const response: SdkStreamResponse = {
    generateAssistantResponseResponse: {
      [Symbol.asyncIterator](): AsyncIterator<SdkStreamEvent> {
        return iterator
      }
    }
  }

  const pending = collectSdkResponse(response, 'auto', 'aborted', controller.signal)
  await secondNextStarted
  controller.abort()
  await expect(pending).rejects.toBe(controller.signal.reason)
  expect(returnCalled).toBe(true)
})
