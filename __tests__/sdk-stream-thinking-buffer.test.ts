import { describe, expect, test } from 'bun:test'
import {
  collectSdkChunks,
  contentOf,
  reasoningOf,
  toolCallOf,
  toolCallStarts
} from './sdk-stream-test-helpers.js'

describe('transformSdkStream thinking tag buffer', () => {
  test('extracts a complete thinking block and streams trailing text', async () => {
    const chunks = await collectSdkChunks([
      { assistantResponseEvent: { content: '<thinking>plan the work</thinking>the reply' } }
    ])

    expect(reasoningOf(chunks)).toBe('plan the work')
    expect(contentOf(chunks)).toBe('the reply')
  })

  test('preserves text before a thinking block', async () => {
    const chunks = await collectSdkChunks([
      {
        assistantResponseEvent: {
          content: 'intro text <thinking>hidden reasoning</thinking>final'
        }
      }
    ])

    expect(contentOf(chunks)).toBe('intro text final')
    expect(reasoningOf(chunks)).toBe('hidden reasoning')
  })

  test('holds a split opening tag until it is complete', async () => {
    const chunks = await collectSdkChunks([
      { assistantResponseEvent: { content: 'pre <thin' } },
      { assistantResponseEvent: { content: 'king>secret</thinking>visible' } }
    ])

    expect(contentOf(chunks)).toBe('pre visible')
    expect(contentOf(chunks)).not.toContain('<thin')
    expect(reasoningOf(chunks)).toBe('secret')
  })

  test('holds a split closing tag until it is complete', async () => {
    const chunks = await collectSdkChunks([
      { assistantResponseEvent: { content: '<thinking>reasoning part one </thin' } },
      { assistantResponseEvent: { content: 'king>reply part' } }
    ])

    expect(reasoningOf(chunks)).toBe('reasoning part one ')
    expect(reasoningOf(chunks)).not.toContain('</thin')
    expect(contentOf(chunks)).toBe('reply part')
  })

  test('strips the separator after a thinking block', async () => {
    const chunks = await collectSdkChunks([
      { assistantResponseEvent: { content: '<thinking>x</thinking>\n\nvisible after strip' } }
    ])

    expect(reasoningOf(chunks)).toBe('x')
    expect(contentOf(chunks)).toBe('visible after strip')
  })

  test('flushes an unclosed thinking block as reasoning', async () => {
    const chunks = await collectSdkChunks([
      { assistantResponseEvent: { content: '<thinking>reasoning that never ' } },
      { assistantResponseEvent: { content: 'closes properly' } }
    ])

    expect(reasoningOf(chunks)).toBe('reasoning that never closes properly')
    expect(contentOf(chunks)).toBe('')
  })

  test('flushes plain text held for partial-tag detection', async () => {
    const chunks = await collectSdkChunks([
      { assistantResponseEvent: { content: 'just a normal answer' } }
    ])

    expect(contentOf(chunks)).toBe('just a normal answer')
    expect(reasoningOf(chunks)).toBe('')
  })

  test('streams later content after thinking extraction', async () => {
    const chunks = await collectSdkChunks([
      { assistantResponseEvent: { content: '<thinking>done</thinking>first' } },
      { assistantResponseEvent: { content: ' second' } },
      { assistantResponseEvent: { content: ' third' } }
    ])

    expect(reasoningOf(chunks)).toBe('done')
    expect(contentOf(chunks)).toBe('first second third')
  })
})

describe('transformSdkStream tool aggregation and dialect gate', () => {
  test('aggregates fragmented tool input by toolUseId', async () => {
    const chunks = await collectSdkChunks([
      { toolUseEvent: { name: 'write', toolUseId: 'tid', input: '{"path":"a",' } },
      { toolUseEvent: { name: 'write', toolUseId: 'tid', input: '"content":"b"}' } },
      { toolUseEvent: { name: 'write', toolUseId: 'tid', input: '', stop: true } }
    ])

    const calls = chunks.map(toolCallOf).filter((call) => call !== undefined)
    const argumentsText = calls.map((call) => call.function?.arguments ?? '').join('')
    expect(toolCallStarts(chunks)).toHaveLength(1)
    expect(argumentsText).toBe('{"path":"a","content":"b"}')
  })

  test('keeps reasoning while suppressing and structuring a dialect tool call', async () => {
    const chunks = await collectSdkChunks([
      { assistantResponseEvent: { content: '<thinking>decide</thinking>Let me read. ' } },
      { assistantResponseEvent: { content: '<invoke name="read"><parameter name="path">/x' } },
      { assistantResponseEvent: { content: '</parameter></invoke>' } }
    ])

    expect(reasoningOf(chunks)).toBe('decide')
    expect(contentOf(chunks)).toBe('Let me read. ')
    expect(contentOf(chunks)).not.toContain('<invoke')
    expect(toolCallStarts(chunks)[0]?.function?.name).toBe('read')
  })

  test('recovers text after a complete dialect tool call at finalization', async () => {
    const chunks = await collectSdkChunks([
      { assistantResponseEvent: { content: 'A ' } },
      {
        assistantResponseEvent: {
          content: '<invoke name="ls"><parameter name="p">.</parameter></invoke> tail text'
        }
      }
    ])

    expect(contentOf(chunks)).toBe('A  tail text')
    expect(contentOf(chunks)).not.toContain('<invoke')
    expect(toolCallStarts(chunks)).toHaveLength(1)
  })
})

describe('transformSdkStream usage and finalization', () => {
  test('derives input usage from metadata context percentage', async () => {
    const chunks = await collectSdkChunks(
      [
        { assistantResponseEvent: { content: 'hello world answer' } },
        { metadataEvent: { contextUsagePercentage: 10 } }
      ],
      'claude-sonnet-4-5'
    )

    const usage = chunks.find((chunk) => chunk.usage !== undefined)?.usage
    expect(usage?.prompt_tokens).toBeGreaterThan(0)
    expect(usage?.total_tokens).toBeGreaterThan(usage?.completion_tokens ?? 0)
  })

  test('uses direct metadata token counts when provided', async () => {
    const chunks = await collectSdkChunks([
      { assistantResponseEvent: { content: 'answer' } },
      { metadataEvent: { tokenUsage: { inputTokens: 12, outputTokens: 3 } } }
    ])

    expect(chunks.find((chunk) => chunk.usage !== undefined)?.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 3,
      total_tokens: 15
    })
  })

  test('sets finish reason from the presence of tool calls', async () => {
    const withTool = await collectSdkChunks([
      { toolUseEvent: { name: 'x', toolUseId: 't', input: '{}', stop: true } }
    ])
    const withoutTool = await collectSdkChunks([
      { assistantResponseEvent: { content: 'hi' } }
    ])

    expect(withTool.find((chunk) => chunk.choices[0]?.finish_reason)?.choices[0]?.finish_reason).toBe(
      'tool_calls'
    )
    expect(
      withoutTool.find((chunk) => chunk.choices[0]?.finish_reason)?.choices[0]?.finish_reason
    ).toBe('stop')
  })

  test('rejects an SDK response without an event stream', async () => {
    const { transformSdkStream } = await import(
      '../src/kiro/transform/streaming/sdk-stream-transformer.js'
    )

    await expect(async () => {
      for await (const chunk of transformSdkStream({}, 'auto', 'id')) {
        void chunk
      }
    }).toThrow('SDK response has no event stream')
  })
})
