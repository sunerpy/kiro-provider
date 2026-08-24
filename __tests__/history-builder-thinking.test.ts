import { describe, expect, test } from 'bun:test'
import { transformToSdkRequest } from '../src/kiro/transform/request-sdk.js'
import type { KiroAuthDetails } from '../src/kiro/types.js'

const AUTH: KiroAuthDetails = {
  refresh: 'refresh',
  access: 'access',
  expires: Date.now() + 3_600_000,
  authMethod: 'idc',
  region: 'us-east-1'
}

function assistantContents(secondContent: unknown): string[] {
  const request = transformToSdkRequest(
    {
      messages: [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'first thought' }],
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'first_tool', arguments: '{}' }
            }
          ]
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'first result' },
        {
          role: 'assistant',
          content: secondContent,
          tool_calls: [
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'second_tool', arguments: '{}' }
            }
          ]
        },
        { role: 'tool', tool_call_id: 'call_2', content: 'second result' },
        { role: 'user', content: 'finish' }
      ]
    },
    'gpt-5.6-sol',
    AUTH
  )

  return (request.conversationState.history ?? []).flatMap((entry) =>
    entry.assistantResponseMessage ? [entry.assistantResponseMessage.content] : []
  )
}

describe('history builder unsigned thinking handling', () => {
  test('does not replay thinking text as assistant content', () => {
    expect(
      assistantContents([
        { type: 'thinking', thinking: 'second thought' },
        { type: 'text', text: 'working' }
      ])
    ).toEqual(['', 'working', ''])
  })

  test('does not interpret closing-tag text inside ignored thinking blocks', () => {
    expect(
      assistantContents([
        { type: 'thinking', thinking: 'before </thinking> after' },
        { type: 'text', text: 'working' }
      ])
    ).toEqual(['', 'working', ''])
  })

  test('uses empty structural turns instead of textual placeholders', () => {
    expect(assistantContents('working')).toEqual(['', 'working', ''])
  })
})
