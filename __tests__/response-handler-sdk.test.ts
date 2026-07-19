import { describe, expect, test } from 'bun:test'
import {
  type SdkStreamEvent,
  type SdkStreamResponse,
  transformSdkStream
} from '../src/kiro/transform/streaming/sdk-stream-transformer.js'
import { collectSdkChunks, contentOf, reasoningOf } from './sdk-stream-test-helpers.js'

describe('transformSdkStream direct SDK streaming contract', () => {
  test('streams assistant response events directly as OpenAI chunks', async () => {
    const chunks = await collectSdkChunks([
      { assistantResponseEvent: { content: 'A' } },
      { assistantResponseEvent: { content: 'B' } }
    ])

    expect(contentOf(chunks)).toBe('AB')
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('stop')
  })

  test('streams reasoning and assistant content on separate delta fields', async () => {
    const chunks = await collectSdkChunks([
      { reasoningContentEvent: { text: 'thinking...' } },
      { assistantResponseEvent: { content: 'answer' } }
    ])

    expect(reasoningOf(chunks)).toBe('thinking...')
    expect(contentOf(chunks)).toBe('answer')
  })

  test('aborting mid-stream stops iteration and calls the source iterator return method', async () => {
    const controller = new AbortController()
    let returnCalled = false
    const response = makeBlockingSdkResponse(
      { reasoningContentEvent: { text: 'first' } },
      () => {
        returnCalled = true
      }
    )
    const transformed = transformSdkStream(response, 'auto', 'abort-test', controller.signal)

    const first = await transformed.next()
    const pending = transformed.next()
    controller.abort()
    const stopped = await pending

    expect(first.done).toBe(false)
    expect(stopped.done).toBe(true)
    expect(returnCalled).toBe(true)
  })
})

function makeBlockingSdkResponse(
  firstEvent: SdkStreamEvent,
  onReturn: () => void
): SdkStreamResponse {
  let deliveredFirstEvent = false
  const iterator: AsyncIterator<SdkStreamEvent> = {
    next(): Promise<IteratorResult<SdkStreamEvent>> {
      if (!deliveredFirstEvent) {
        deliveredFirstEvent = true
        return Promise.resolve({ done: false, value: firstEvent })
      }
      return new Promise<IteratorResult<SdkStreamEvent>>(() => undefined)
    },
    return(): Promise<IteratorResult<SdkStreamEvent>> {
      onReturn()
      return Promise.resolve({ done: true, value: undefined })
    }
  }
  const eventStream: AsyncIterable<SdkStreamEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<SdkStreamEvent> {
      return iterator
    }
  }
  return { generateAssistantResponseResponse: eventStream }
}
