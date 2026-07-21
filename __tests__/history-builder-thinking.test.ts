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

describe('history builder thinking preservation', () => {
  test('preserves the thinking prefix on collapsed second-and-later tool pairs', () => {
    expect(
      assistantContents([
        { type: 'thinking', thinking: 'second thought' },
        { type: 'text', text: 'working' }
      ])
    ).toEqual([
      '<thinking>first thought</thinking>',
      '<thinking>second thought</thinking>\n\n[system: tool calling continues]',
      '[system: conversation continues]'
    ])
  })

  test('preserves the full thinking prefix when reasoning contains a literal closing tag', () => {
    expect(
      assistantContents([
        { type: 'thinking', thinking: 'before </thinking> after' },
        { type: 'text', text: 'working' }
      ])
    ).toEqual([
      '<thinking>first thought</thinking>',
      '<thinking>before <\\/thinking> after</thinking>\n\n[system: tool calling continues]',
      '[system: conversation continues]'
    ])
  })

  test('keeps the existing non-thinking collapse placeholder unchanged', () => {
    expect(assistantContents('working')).toEqual([
      '<thinking>first thought</thinking>',
      '[system: tool calling continues]',
      '[system: conversation continues]'
    ])
  })
})
