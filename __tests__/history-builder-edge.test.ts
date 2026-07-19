import { describe, expect, test } from 'bun:test'
import { buildHistory, collapseAgenticLoops } from '../src/kiro/transform/history-builder.js'
import type { CodeWhispererMessage } from '../src/kiro/types.js'

const MODEL = 'claude-sonnet-4.5'

describe('buildHistory edge behavior', () => {
  test('converts user tool-result parts and omits images beyond the Kiro limit', () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }

    const history = buildHistory(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'inspect' },
            { type: 'tool_result', tool_use_id: 'call-1', content: 'done' },
            image,
            image,
            image,
            image,
            image
          ]
        },
        { role: 'assistant', content: 'current' }
      ],
      MODEL
    )

    expect(history[0]?.userInputMessage?.images).toHaveLength(4)
    expect(history[0]?.userInputMessage?.content).toContain('[1 image(s) omitted due to API limits]')
    expect(history[0]?.userInputMessage?.userInputMessageContext?.toolResults).toEqual([
      { content: [{ text: 'done' }], status: 'success', toolUseId: 'call-1' }
    ])
  })

  test('converts batched tool-role results and separates them from a preceding user turn', () => {
    const history = buildHistory(
      [
        { role: 'user', content: 'run tools' },
        {
          role: 'tool',
          tool_results: [
            { content: 'ignored because it has no id' },
            { tool_call_id: 'call-2', content: 'batched result' }
          ]
        },
        { role: 'user', content: 'current' }
      ],
      MODEL
    )

    expect(history[1]).toEqual({
      assistantResponseMessage: { content: '[system: conversation continues]' }
    })
    expect(history[2]?.userInputMessage?.userInputMessageContext?.toolResults).toEqual([
      { content: [{ text: 'batched result' }], status: 'success', toolUseId: 'call-2' }
    ])
  })

  test('uses thinking text fallback and merges adjacent assistant content and tools', () => {
    const history = buildHistory(
      [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'fallback thought' },
            { type: 'text', text: 'first answer' }
          ]
        },
        {
          role: 'assistant',
          content: 'second answer',
          tool_calls: [{ id: 'call-3', function: { name: 'lookup', arguments: { q: 'x' } } }]
        },
        { role: 'user', content: 'current' }
      ],
      MODEL
    )

    expect(history).toEqual([
      {
        assistantResponseMessage: {
          content: '<thinking>fallback thought</thinking>\n\nfirst answer\n\nsecond answer',
          toolUses: [{ input: { q: 'x' }, name: 'lookup', toolUseId: 'call-3' }]
        }
      }
    ])
  })
})

describe('collapseAgenticLoops edge behavior', () => {
  test('retains a long non-agentic history in order', () => {
    const history: CodeWhispererMessage[] = [
      { userInputMessage: { content: 'one', modelId: MODEL, origin: 'AI_EDITOR' } },
      { assistantResponseMessage: { content: 'two' } },
      { userInputMessage: { content: 'three', modelId: MODEL, origin: 'AI_EDITOR' } },
      { assistantResponseMessage: { content: 'four' } }
    ]

    expect(collapseAgenticLoops(history)).toEqual(history)
  })
})
