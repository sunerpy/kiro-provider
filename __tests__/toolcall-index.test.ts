import { describe, expect, test } from 'bun:test'
import {
  collectSdkChunks,
  contentOf,
  reasoningOf,
  toolCallStarts
} from './sdk-stream-test-helpers.js'

describe('tool-call index is a 0-based ordinal on the SDK path', () => {
  test('does not offset tool indices by reasoning and text blocks', async () => {
    const chunks = await collectSdkChunks([
      { reasoningContentEvent: { text: 'thinking' } },
      { assistantResponseEvent: { content: 'ok' } },
      { toolUseEvent: { name: 't1', toolUseId: 'id1', input: '{"a":1}', stop: true } },
      { toolUseEvent: { name: 't2', toolUseId: 'id2', input: '{"b":2}', stop: true } }
    ])

    const starts = toolCallStarts(chunks)
    expect(starts).toHaveLength(2)
    expect(starts.find((call) => call.id === 'id1')?.index).toBe(0)
    expect(starts.find((call) => call.id === 'id2')?.index).toBe(1)
    expect(reasoningOf(chunks)).toBe('thinking')
    expect(contentOf(chunks)).toBe('ok')
  })

  test('uses index zero for a tool-only response', async () => {
    const chunks = await collectSdkChunks([
      { toolUseEvent: { name: 't1', toolUseId: 'id1', input: '{"x":1}', stop: true } }
    ])

    expect(toolCallStarts(chunks)).toHaveLength(1)
    expect(toolCallStarts(chunks)[0]?.index).toBe(0)
  })
})
