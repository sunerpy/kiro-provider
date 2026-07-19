import { describe, expect, test } from 'bun:test'
import { transformToSdkRequest } from '../src/kiro/transform/request-sdk.js'
import type { CodeWhispererMessage, KiroAuthDetails, SdkPreparedRequest } from '../src/kiro/types.js'

const AUTH: KiroAuthDetails = {
  refresh: 'refresh',
  access: 'access',
  expires: Date.now() + 3_600_000,
  authMethod: 'idc',
  region: 'us-east-1'
}

function currentUserInput(request: SdkPreparedRequest): NonNullable<CodeWhispererMessage['userInputMessage']> {
  const input = request.conversationState.currentMessage.userInputMessage
  if (!input) throw new TypeError('Expected a current user input')
  return input
}

describe('request transform edge behavior', () => {
  test('appends current assistant content-part tool calls and thinking text fallback', () => {
    const request = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'prepare' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', text: 'fallback thought' },
              { type: 'tool_use', id: 'current-call', name: 'lookup', input: { q: 'x' } }
            ]
          }
        ]
      },
      'claude-sonnet-4-5',
      AUTH
    )

    expect(request.conversationState.history?.at(-1)?.assistantResponseMessage).toEqual({
      content: '<thinking>fallback thought</thinking>',
      toolUses: [{ input: { q: 'x' }, name: 'lookup', toolUseId: 'current-call' }]
    })
  })

  test('appends a current assistant string as history content', () => {
    const request = transformToSdkRequest(
      { messages: [{ role: 'user', content: 'prepare' }, { role: 'assistant', content: 'answer' }] },
      'claude-sonnet-4-5',
      AUTH
    )

    expect(request.conversationState.history?.at(-1)?.assistantResponseMessage?.content).toBe('answer')
  })

  test('reconstructs an OpenAI orphan tool call with parsed arguments', () => {
    const request = transformToSdkRequest(
      {
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'orphan-openai', function: { name: 'search', arguments: '{"q":"docs"}' } }]
          },
          { role: 'tool', tool_call_id: 'orphan-openai', content: 'found' }
        ]
      },
      'claude-sonnet-4-5',
      AUTH
    )

    expect(request.conversationState.history?.at(-1)?.assistantResponseMessage?.toolUses).toEqual([
      { input: { q: 'docs' }, name: 'search', toolUseId: 'orphan-openai' }
    ])
    expect(currentUserInput(request).userInputMessageContext?.toolResults).toEqual([
      { content: [{ text: 'found' }], status: 'success', toolUseId: 'orphan-openai' }
    ])
  })

  test('reconstructs a tool result when the original call lacks a history-safe name', () => {
    const request = transformToSdkRequest(
      {
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'nameless-call', input: { value: 7 } }]
          },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'nameless-call', content: 'seven' }] }
        ]
      },
      'claude-sonnet-4-5',
      AUTH
    )

    expect(request.conversationState.history?.at(-1)?.assistantResponseMessage?.toolUses).toEqual([
      { input: { value: 7 }, name: 'tool', toolUseId: 'nameless-call' }
    ])
    expect(currentUserInput(request).userInputMessageContext?.toolResults).toEqual([
      { content: [{ text: 'seven' }], status: 'success', toolUseId: 'nameless-call' }
    ])
  })

  test('infers array, null, and unsupported input schema types from history', () => {
    const request = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'run' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'typed-call',
                name: 'typed_tool',
                input: { items: [1], nullable: null, unsupported: undefined }
              }
            ]
          },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'typed-call', content: 'done' }] }
        ]
      },
      'claude-sonnet-4-5',
      AUTH
    )

    expect(
      currentUserInput(request).userInputMessageContext?.tools?.[0]?.toolSpecification.inputSchema.json
    ).toEqual({
      type: 'object',
      properties: {
        items: { type: 'array' },
        nullable: { type: 'string' },
        unsupported: { type: 'string' }
      }
    })
  })
})
