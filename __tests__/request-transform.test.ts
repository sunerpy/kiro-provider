import { describe, expect, test } from 'bun:test'
import { transformToSdkRequest } from '../src/kiro/transform/request-sdk.js'
import type { CodeWhispererMessage, KiroAuthDetails, SdkPreparedRequest } from '../src/kiro/types.js'

const auth: KiroAuthDetails = {
  refresh: 'r',
  access: 'access-token',
  expires: Date.now() + 3_600_000,
  authMethod: 'idc',
  region: 'us-east-1'
}

const authWithProfile: KiroAuthDetails = {
  ...auth,
  profileArn: 'arn:aws:codewhisperer:eu-west-1:123456789012:profile/ABC'
}

function currentUserInput(request: SdkPreparedRequest): NonNullable<CodeWhispererMessage['userInputMessage']> {
  const input = request.conversationState.currentMessage.userInputMessage
  if (!input) throw new Error('Expected current user input')
  return input
}

function firstHistoryUserContent(request: SdkPreparedRequest): string | undefined {
  return request.conversationState.history?.find((entry) => entry.userInputMessage)?.userInputMessage?.content
}

describe('transformToSdkRequest — currentMessage structure', () => {
  test('single user message produces the required wire shape', () => {
    const request = transformToSdkRequest(
      { messages: [{ role: 'user', content: 'hello world' }] },
      'claude-sonnet-4-5',
      auth
    )

    expect(currentUserInput(request)).toMatchObject({
      content: 'hello world',
      modelId: 'claude-sonnet-4.5',
      origin: 'AI_EDITOR'
    })
    expect(request.conversationState.chatTriggerType).toBe('MANUAL')
    expect(typeof request.conversationState.conversationId).toBe('string')
    expect(request.streaming).toBe(true)
    expect(request.effectiveModel).toBe('claude-sonnet-4.5')
  })

  test('accepts a JSON string body', () => {
    const request = transformToSdkRequest(
      JSON.stringify({ messages: [{ role: 'user', content: 'str-body' }] }),
      'claude-sonnet-4-5',
      auth
    )

    expect(currentUserInput(request).content).toBe('str-body')
  })

  test('throws when there are no messages', () => {
    expect(() => transformToSdkRequest({ messages: [] }, 'claude-sonnet-4-5', auth)).toThrow('No messages')
  })
})

describe('transformToSdkRequest — system and thinking injection', () => {
  test('injects top-level and role system messages into leading history', () => {
    const request = transformToSdkRequest(
      {
        system: 'TOP',
        messages: [
          { role: 'system', content: 'ROLE-A' },
          { role: 'system', content: 'ROLE-B' },
          { role: 'user', content: 'hi' }
        ]
      },
      'claude-sonnet-4-5',
      auth
    )

    expect(firstHistoryUserContent(request)).toBe('TOP\n\nROLE-A\n\nROLE-B')
    expect(currentUserInput(request).content).toBe('hi')
  })

  test('prepends a thinking prefix once', () => {
    const request = transformToSdkRequest(
      { system: 'SYS', messages: [{ role: 'user', content: 'q' }] },
      'claude-sonnet-4-5',
      auth,
      true,
      15_000
    )

    expect(firstHistoryUserContent(request)).toBe(
      '<thinking_mode>enabled</thinking_mode><max_thinking_length>15000</max_thinking_length>\nSYS'
    )
  })

  test('does not duplicate an existing thinking marker', () => {
    const request = transformToSdkRequest(
      {
        system: '<thinking_mode>enabled</thinking_mode> already',
        messages: [{ role: 'user', content: 'q' }]
      },
      'claude-sonnet-4-5',
      auth,
      true
    )

    expect(firstHistoryUserContent(request)).toBe('<thinking_mode>enabled</thinking_mode> already')
  })
})

describe('transformToSdkRequest — tools and history', () => {
  test('converts supplied tools into CodeWhisperer tool specifications', () => {
    const request = transformToSdkRequest(
      {
        messages: [{ role: 'user', content: 'use a tool' }],
        tools: [
          {
            function: {
              name: 'get_time',
              description: 'get the time',
              parameters: { type: 'object', properties: {} }
            }
          }
        ]
      },
      'claude-sonnet-4-5',
      auth
    )

    expect(currentUserInput(request).userInputMessageContext?.tools).toEqual([
      {
        toolSpecification: {
          name: 'get_time',
          description: 'get the time',
          inputSchema: { json: { type: 'object', properties: {} } }
        }
      }
    ])
  })

  test('matches a current tool result to its historical tool use', () => {
    const request = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'run it' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'runner', input: { x: 1 } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'done' }] }
        ]
      },
      'claude-sonnet-4-5',
      auth
    )

    expect(currentUserInput(request).userInputMessageContext?.toolResults).toEqual([
      { content: [{ text: 'done' }], status: 'success', toolUseId: 'tu1' }
    ])
    expect(
      request.conversationState.history?.find((entry) => entry.assistantResponseMessage?.toolUses)
        ?.assistantResponseMessage?.toolUses?.[0]?.toolUseId
    ).toBe('tu1')
  })

  test('deduplicates repeated current tool results', () => {
    const request = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'run it' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'runner', input: {} }] },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tu1', content: 'first' },
              { type: 'tool_result', tool_use_id: 'tu1', content: 'duplicate' }
            ]
          }
        ]
      },
      'claude-sonnet-4-5',
      auth
    )

    expect(currentUserInput(request).userInputMessageContext?.toolResults).toEqual([
      { content: [{ text: 'first' }], status: 'success', toolUseId: 'tu1' }
    ])
  })

  test('reconstructs an orphaned tool call before its result', () => {
    const request = transformToSdkRequest(
      {
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'orphan', name: 'lookup', input: { q: 'x' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'found' }] }
        ]
      },
      'claude-sonnet-4-5',
      auth
    )

    expect(request.conversationState.history?.at(-1)?.assistantResponseMessage?.toolUses).toEqual([
      { input: { q: 'x' }, name: 'lookup', toolUseId: 'orphan' }
    ])
    expect(currentUserInput(request).userInputMessageContext?.toolResults?.[0]?.toolUseId).toBe('orphan')
  })

  test('inlines a tool result whose call cannot be found', () => {
    const request = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'lead' },
          { role: 'assistant', content: 'no tool use here' },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ghost', content: 'stray-output' }] }
        ]
      },
      'claude-sonnet-4-5',
      auth
    )

    expect(currentUserInput(request).content).toContain('[Output for tool call ghost]')
    expect(currentUserInput(request).content).toContain('stray-output')
    expect(currentUserInput(request).userInputMessageContext?.toolResults).toBeUndefined()
  })

  test('infers placeholder tool definitions from historical tool uses', () => {
    const request = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'run it' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tu1', name: 'historical_tool', input: { count: 2, enabled: true } }]
          },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'done' }] }
        ]
      },
      'claude-sonnet-4-5',
      auth
    )

    expect(currentUserInput(request).userInputMessageContext?.tools).toEqual([
      {
        toolSpecification: {
          name: 'historical_tool',
          description: 'Tool historical_tool',
          inputSchema: {
            json: {
              type: 'object',
              properties: { count: { type: 'number' }, enabled: { type: 'boolean' } }
            }
          }
        }
      }
    ])
  })

  test('appends a current assistant turn with thinking and tool calls to history', () => {
    const request = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'q' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'deliberating' },
              { type: 'text', text: 'final' }
            ],
            tool_calls: [{ id: 'x1', function: { name: 'g', arguments: '{"k":2}' } }]
          }
        ]
      },
      'claude-sonnet-4-5',
      auth
    )

    const assistant = request.conversationState.history?.at(-1)?.assistantResponseMessage
    expect(assistant?.content).toBe('<thinking>deliberating</thinking>\n\nfinal')
    expect(assistant?.toolUses).toEqual([{ input: { k: 2 }, name: 'g', toolUseId: 'x1' }])
    expect(currentUserInput(request).content).toBe('[system: conversation continues]')
  })

  test('merges adjacent user messages before building history', () => {
    const request = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'first' },
          { role: 'user', content: 'second' }
        ]
      },
      'claude-sonnet-4-5',
      auth
    )

    expect(currentUserInput(request).content).toBe('first\nsecond')
  })
})

describe('transformToSdkRequest — images', () => {
  test('extracts current-turn data URL images', () => {
    const request = transformToSdkRequest(
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'inspect' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }
            ]
          }
        ]
      },
      'claude-sonnet-4-5',
      auth
    )

    expect(currentUserInput(request).images?.[0]?.format).toBe('png')
    expect(Array.from(currentUserInput(request).images?.[0]?.source.bytes ?? [])).toEqual([1, 2, 3])
  })
})

describe('transformToSdkRequest — profile and region', () => {
  test('copies profileArn and derives region from it', () => {
    const request = transformToSdkRequest(
      { messages: [{ role: 'user', content: 'q' }] },
      'claude-sonnet-4-5',
      authWithProfile
    )

    expect(request.profileArn).toBe(authWithProfile.profileArn)
    expect(request.region).toBe('eu-west-1')
  })

  test('falls back to auth.region when profileArn is absent', () => {
    const request = transformToSdkRequest(
      { messages: [{ role: 'user', content: 'q' }] },
      'claude-sonnet-4-5',
      auth
    )

    expect(request.profileArn).toBeUndefined()
    expect(request.region).toBe('us-east-1')
  })
})

describe('transformToSdkRequest — authoritative effort resolution', () => {
  const effortBody = (reasoningEffort?: string) => ({
    messages: [{ role: 'user', content: 'reason' }],
    reasoning_effort: reasoningEffort
  })

  test('model variant overrides request and global effort', () => {
    const request = transformToSdkRequest(effortBody('low'), 'gpt-5.6-sol-high', auth, true, 8_000, {
      effort: 'medium'
    })

    expect(request.effort).toBe('high')
  })

  test('request reasoning_effort overrides global effort', () => {
    const request = transformToSdkRequest(effortBody('high'), 'gpt-5.6-sol', auth, true, 8_000, {
      effort: 'medium'
    })

    expect(request.effort).toBe('high')
  })

  test('global effort overrides automatic budget mapping', () => {
    const request = transformToSdkRequest(effortBody(), 'gpt-5.6-sol', auth, true, 8_000, {
      effort: 'high'
    })

    expect(request.effort).toBe('high')
  })

  test('maps budget when thinking and automatic mapping are enabled', () => {
    const request = transformToSdkRequest(effortBody(), 'gpt-5.6-sol', auth, true, 8_000)

    expect(request.effort).toBe('low')
  })

  test('falls back to medium when thinking and automatic mapping are disabled', () => {
    const request = transformToSdkRequest(effortBody(), 'gpt-5.6-sol', auth, true, 8_000, {
      autoEffortMapping: false
    })

    expect(request.effort).toBe('medium')
  })

  test('omits effort for a non-thinking request without explicit effort', () => {
    const request = transformToSdkRequest(effortBody(), 'gpt-5.6-sol', auth)

    expect(request.effort).toBeUndefined()
  })
})
