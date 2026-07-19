import { describe, expect, test } from 'bun:test'
import {
  collectSdkChunks,
  contentOf,
  contentTextOf,
  reasoningOf,
  reasoningTextOf
} from './sdk-stream-test-helpers.js'

describe('transformSdkStream reasoningContentEvent handling', () => {
  test('keeps contiguous reasoning deltas before text deltas', async () => {
    const chunks = await collectSdkChunks([
      { reasoningContentEvent: { text: 'Let me' } },
      { reasoningContentEvent: { text: ' think' } },
      { assistantResponseEvent: { content: 'The answer' } },
      { assistantResponseEvent: { content: ' is 42' } }
    ])

    const firstContentIndex = chunks.findIndex((chunk) => contentTextOf(chunk) !== undefined)
    const lastReasoningIndex = chunks.reduce(
      (index, chunk, currentIndex) =>
        reasoningTextOf(chunk) === undefined ? index : currentIndex,
      -1
    )

    expect(reasoningOf(chunks)).toBe('Let me think')
    expect(contentOf(chunks)).toBe('The answer is 42')
    expect(lastReasoningIndex).toBeGreaterThan(-1)
    expect(lastReasoningIndex).toBeLessThan(firstContentIndex)
  })

  test('emits clean text without a reasoning delta for text-only responses', async () => {
    const chunks = await collectSdkChunks([
      { assistantResponseEvent: { content: 'Hello' } },
      { assistantResponseEvent: { content: ' world' } }
    ])

    expect(contentOf(chunks)).toBe('Hello world')
    expect(chunks.some((chunk) => reasoningTextOf(chunk) !== undefined)).toBe(false)
  })

  test('finalizes a reasoning-only response without visible content', async () => {
    const chunks = await collectSdkChunks([
      { reasoningContentEvent: { text: 'thinking...' } }
    ])

    expect(reasoningOf(chunks)).toBe('thinking...')
    expect(chunks.some((chunk) => contentTextOf(chunk) !== undefined)).toBe(false)
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('stop')
  })
})
