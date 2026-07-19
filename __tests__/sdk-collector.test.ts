import { describe, expect, test } from 'bun:test'
import { collectSdkResponse } from '../src/kiro/transform/sdk-collector.js'
import type {
  SdkStreamEvent,
  SdkStreamResponse
} from '../src/kiro/transform/streaming/sdk-stream-runtime.js'

function responseFrom(events: readonly SdkStreamEvent[]): SdkStreamResponse {
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

    expect(completion.choices[0]?.message.tool_calls).toEqual([
      {
        id: 'tool-1',
        type: 'function',
        function: { name: 'write', arguments: '{"path":"a","content":"b"}' }
      }
    ])
    expect(completion.choices[0]?.finish_reason).toBe('tool_calls')
  })

  test('aggregates interleaved duplicate ids while preserving distinct tools', async () => {
    const response = responseFrom([
      { toolUseEvent: { name: 'first', toolUseId: 'tool-a', input: '{"x":' } },
      { toolUseEvent: { name: 'second', toolUseId: 'tool-b', input: '{"y":2}' } },
      { toolUseEvent: { name: 'first', toolUseId: 'tool-a', input: '1}' } }
    ])

    const completion = await collectSdkResponse(response, 'auto', 'conversation-2')

    expect(completion.choices[0]?.message.tool_calls).toEqual([
      {
        id: 'tool-a',
        type: 'function',
        function: { name: 'first', arguments: '{"x":1}' }
      },
      {
        id: 'tool-b',
        type: 'function',
        function: { name: 'second', arguments: '{"y":2}' }
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

    expect(completion.choices[0]?.message).toEqual({
      role: 'assistant',
      content: '',
      reasoning_content: 'inspect the constraints then decide'
    })
    expect(completion.choices[0]?.finish_reason).toBe('stop')
  })

  test('collects reasoning and assistant text into separate message fields', async () => {
    const response = responseFrom([
      { reasoningContentEvent: { text: 'reason' } },
      { assistantResponseEvent: { content: 'answer ' } },
      { assistantResponseEvent: { content: 'complete' } }
    ])

    const completion = await collectSdkResponse(response, 'claude-opus-4-8', 'mixed-content')

    expect(completion.choices[0]?.message.content).toBe('answer complete')
    expect(completion.choices[0]?.message.reasoning_content).toBe('reason')
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
      prompt_tokens: 15,
      completion_tokens: 7,
      total_tokens: 22
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
  const completion = await pending

  expect(completion.choices[0]?.message.content).toBe('partial')
  expect(returnCalled).toBe(true)
})
