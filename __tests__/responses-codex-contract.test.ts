import { describe, expect, test } from 'bun:test'
import { buildCodeWhispererRequest } from '../src/kiro/transform/request-core.js'
import type { KiroAuthDetails } from '../src/kiro/types.js'
import {
  parseChatCompletionRequest,
  parseResponsesRequest,
  type ResponsesRequest
} from '../src/server/request-schema.js'
import {
  type InternalChatBody,
  responsesToInternalChat
} from '../src/server/responses/request-adapter.js'

const MODEL = 'gpt-5.6-sol'
const AUTH: KiroAuthDetails = {
  refresh: 'refresh-token',
  access: 'access-token',
  expires: Date.now() + 60_000,
  authMethod: 'desktop',
  region: 'us-east-1'
}
const FIXTURE_DIRECTORY = new URL('./fixtures/', import.meta.url)

async function loadFixture(name: string): Promise<unknown> {
  return Bun.file(new URL(name, FIXTURE_DIRECTORY)).json()
}

function parseValid(raw: unknown): ResponsesRequest {
  const parsed = parseResponsesRequest(raw)
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) throw new TypeError('Expected a valid Responses request')
  return parsed.value
}

function adaptValidFull(
  raw: unknown
): Extract<ReturnType<typeof responsesToInternalChat>, { ok: true }> {
  const adapted = responsesToInternalChat(parseValid(raw))
  expect(adapted.ok).toBe(true)
  if (!adapted.ok) throw new TypeError(`Expected an adapted body, received ${adapted.code}`)

  const internal = parseChatCompletionRequest(adapted.body)
  expect(internal.ok).toBe(true)
  if (!internal.ok) throw new TypeError('Adapted body did not pass internal chat validation')
  return adapted
}

function adaptValid(raw: unknown): InternalChatBody {
  return adaptValidFull(raw).body
}

async function expectInvalid(raw: unknown): Promise<void> {
  const parsed = parseResponsesRequest(raw)
  expect(parsed.ok).toBe(false)
  if (parsed.ok) throw new TypeError('Expected an invalid Responses request')
  expect(parsed.response.status).toBe(400)
}

describe('Codex Responses schema contract', () => {
  test.each(['system', 'developer', 'user', 'assistant'])('accepts the %s message role', (role) => {
    parseValid({
      model: MODEL,
      input: [{ type: 'message', role, content: [{ type: 'input_text', text: 'content' }] }]
    })
  })

  test.each([
    ['string', 'tool output'],
    ['content item array', [{ type: 'input_text', text: 'tool output' }]]
  ])('accepts function_call_output with %s output', (_name, output) => {
    parseValid({
      model: MODEL,
      input: [{ type: 'function_call_output', call_id: 'call_1', output }]
    })
  })

  test.each(['', '   '])('normalizes an empty no-argument function call to JSON: %j', (argumentsText) => {
    const parsed = parseValid({
      model: MODEL,
      input: [
        {
          type: 'function_call',
          call_id: 'call_no_args',
          name: 'list_resources',
          arguments: argumentsText
        },
        { type: 'function_call_output', call_id: 'call_no_args', output: 'done' }
      ]
    })
    expect(parsed.input[0]).toMatchObject({ arguments: '{}' })

    const adapted = responsesToInternalChat(parsed)
    expect(adapted.ok).toBe(true)
    if (!adapted.ok) throw new TypeError(`Expected an adapted body, received ${adapted.code}`)
    expect(adapted.body.messages[0]).toMatchObject({
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_no_args',
          function: { name: 'list_resources', arguments: '{}' }
        }
      ]
    })
  })

  test('accepts custom and namespace declarations plus custom call history', () => {
    parseValid({
      model: MODEL,
      tools: [
        {
          type: 'custom',
          name: 'apply_patch',
          description: 'Apply a patch',
          format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' }
        },
        {
          type: 'namespace',
          name: 'collaboration',
          tools: [
            {
              type: 'function',
              name: 'spawn_agent',
              parameters: { type: 'object' }
            }
          ]
        }
      ],
      input: [
        { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch', input: 'PATCH' },
        { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'Done' }
      ]
    })
  })

  test('accepts an additional_tools item before the unknown-item branch', () => {
    parseValid({
      model: MODEL,
      input: [
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [{ type: 'function', name: 'wait', parameters: { type: 'object' } }]
        },
        { type: 'message', role: 'user', content: [] }
      ]
    })
  })

  test('accepts Codex dynamic namespace children and normalizes inputSchema', () => {
    const body = adaptValid({
      model: MODEL,
      input: [
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [
            {
              type: 'namespace',
              name: 'codex_app',
              description: 'Codex desktop tools',
              tools: [
                {
                  name: 'open_in_codex',
                  description: 'Open an artifact',
                  inputSchema: {
                    type: 'object',
                    properties: { target: { type: 'string' } },
                    required: ['target']
                  },
                  deferLoading: true
                }
              ]
            }
          ]
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'open it' }]
        }
      ]
    })

    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'kiro_ns_0',
          description: 'Codex desktop tools\n\nOpen an artifact',
          parameters: {
            type: 'object',
            properties: { target: { type: 'string' } },
            required: ['target']
          }
        }
      }
    ])
  })

  test('continues to accept a genuinely unknown input item', () => {
    const parsed = parseValid({ model: MODEL, input: [{ type: 'future_item', payload: true }] })
    expect(parsed.input).toEqual([{ type: 'future_item', payload: true }])
  })

  test.each([
    ['malformed message', { type: 'message', role: 'developer' }],
    ['malformed function output', { type: 'function_call_output', call_id: 'call_1', output: 42 }],
    ['malformed additional tools', { type: 'additional_tools', role: 'developer' }]
  ])('rejects %s as a known item with an invalid payload', async (_name, item) => {
    await expectInvalid({ model: MODEL, input: [item] })
  })
})

describe('Codex Responses adapter contract', () => {
  test('maps developer instructions to non-executable system messages', () => {
    const body = adaptValid({
      model: MODEL,
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'DEVELOPER_SENTINEL' }]
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run' }] }
      ]
    })
    expect(body.messages).toEqual([
      { role: 'system', content: [{ type: 'text', text: 'DEVELOPER_SENTINEL' }] },
      { role: 'user', content: [{ type: 'text', text: 'run' }] }
    ])
  })

  test.each([
    ['string', 'plain', 'plain'],
    [
      'text array',
      [
        { type: 'input_text', text: 'first' },
        { type: 'output_text', text: 'second' }
      ],
      'first\nsecond'
    ],
    [
      'mixed text and image array',
      [
        { type: 'input_text', text: 'first' },
        { type: 'input_image', image_url: 'IMAGE_URL_REDACTED' },
        { type: 'output_text', text: 'second' }
      ],
      'first\nsecond'
    ],
    ['all non-text array', [{ type: 'input_image', image_url: 'IMAGE_URL_REDACTED' }], ''],
    ['empty array', [], '']
  ])('normalizes %s function output deterministically', (_name, output, expected) => {
    const body = adaptValid({
      model: MODEL,
      input: [{ type: 'function_call_output', call_id: 'call_1', output }]
    })
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: expected }]
      }
    ])
  })

  test('merges supported tools stably while top-level definitions win name conflicts', () => {
    const body = adaptValid({
      model: MODEL,
      input: [
        {
          type: 'additional_tools',
          tools: [
            { type: 'custom', name: 'exec' },
            { type: 'function', name: 'duplicate', description: 'additional duplicate' },
            { type: 'function', name: 'additional_only', parameters: { type: 'object' } },
            { type: 'namespace', name: 'collaboration', tools: [] },
            { type: 'future_tool', name: 'future' }
          ]
        },
        { type: 'message', role: 'user', content: [] }
      ],
      tools: [
        { type: 'function', name: 'top_level', description: 'top level first' },
        { type: 'function', name: 'duplicate', description: 'top level wins' }
      ]
    })
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'top_level', description: 'top level first' }
      },
      {
        type: 'function',
        function: { name: 'duplicate', description: 'top level wins' }
      },
      {
        type: 'function',
        function: {
          name: 'kiro_custom_0',
          parameters: {
            type: 'object',
            properties: {
              input: { type: 'string' }
            },
            required: ['input'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: { name: 'additional_only', parameters: { type: 'object' } }
      }
    ])
  })

  test('returns empty_input for developer and additional_tools without executable input', () => {
    const adapted = responsesToInternalChat(
      parseValid({
        model: MODEL,
        input: [
          {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: 'DEVELOPER_SENTINEL' }]
          },
          { type: 'additional_tools', tools: [{ type: 'function', name: 'wait' }] }
        ]
      })
    )
    expect(adapted).toEqual({ ok: false, code: 'empty_input' })
  })

  test('treats function_call_output without a user message as executable input', () => {
    const body = adaptValid({
      model: MODEL,
      input: [{ type: 'function_call_output', call_id: 'call_1', output: '' }]
    })
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '' }]
      }
    ])
  })

  test('rejects duplicate children within one namespace declaration', () => {
    const adapted = responsesToInternalChat(
      parseValid({
        model: MODEL,
        input: [{ type: 'message', role: 'user', content: [] }],
        tools: [
          {
            type: 'namespace',
            name: 'duplicate_namespace',
            tools: [
              { type: 'function', name: 'same', parameters: { type: 'object' } },
              { type: 'function', name: 'same', parameters: { type: 'object' } }
            ]
          }
        ]
      })
    )
    expect(adapted).toMatchObject({ ok: false, code: 'invalid_tool_declaration' })
  })

  test('uses the first same-tier namespace child declaration', () => {
    const body = adaptValid({
      model: MODEL,
      input: [
        {
          type: 'additional_tools',
          tools: [
            {
              type: 'namespace',
              name: 'workers',
              description: 'first namespace',
              tools: [
                {
                  type: 'function',
                  name: 'run',
                  description: 'first child',
                  parameters: { type: 'object', properties: { first: { type: 'string' } } }
                }
              ]
            },
            {
              type: 'namespace',
              name: 'workers',
              description: 'second namespace',
              tools: [
                {
                  type: 'function',
                  name: 'run',
                  description: 'second child',
                  parameters: { type: 'object', properties: { second: { type: 'string' } } }
                },
                { type: 'function', name: 'other', parameters: { type: 'object' } }
              ]
            }
          ]
        },
        { type: 'message', role: 'user', content: [] }
      ]
    })
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'kiro_ns_0',
          description: 'first namespace\n\nfirst child',
          parameters: { type: 'object', properties: { first: { type: 'string' } } }
        }
      },
      {
        type: 'function',
        function: { name: 'kiro_ns_1', description: 'second namespace', parameters: { type: 'object' } }
      }
    ])
  })

  test('uses a top-level namespace child over an additional declaration', () => {
    const body = adaptValid({
      model: MODEL,
      tools: [
        {
          type: 'namespace',
          name: 'workers',
          description: 'top namespace',
          tools: [
            {
              type: 'function',
              name: 'run',
              description: 'top child',
              parameters: { type: 'object', properties: { top: { type: 'boolean' } } }
            }
          ]
        }
      ],
      input: [
        {
          type: 'additional_tools',
          tools: [
            {
              type: 'namespace',
              name: 'workers',
              tools: [
                {
                  type: 'function',
                  name: 'run',
                  parameters: { type: 'object', properties: { additional: { type: 'boolean' } } }
                }
              ]
            }
          ]
        },
        { type: 'message', role: 'user', content: [] }
      ]
    })
    expect(body.tools?.[0]).toEqual({
      type: 'function',
      function: {
        name: 'kiro_ns_0',
        description: 'top namespace\n\ntop child',
        parameters: { type: 'object', properties: { top: { type: 'boolean' } } }
      }
    })
  })

  test('rejects a global function and custom declaration with the same public name', () => {
    const adapted = responsesToInternalChat(
      parseValid({
        model: MODEL,
        tools: [
          { type: 'function', name: 'exec', parameters: { type: 'object' } },
          { type: 'custom', name: 'exec' }
        ],
        input: [{ type: 'message', role: 'user', content: [] }]
      })
    )
    expect(adapted).toMatchObject({ ok: false, code: 'invalid_tool_declaration' })
  })
})

describe('redacted Codex request fixtures', () => {
  test('adapts the real first-turn shape with reversible custom and namespace aliases', async () => {
    const raw = await loadFixture('codex-first-turn.json')
    const adapted = adaptValidFull(raw)
    const body = adapted.body
    const systemText: string[] = []
    for (const message of body.messages) {
      if (message.role !== 'system') continue
      if (typeof message.content === 'string') {
        systemText.push(message.content)
        continue
      }
      systemText.push(
        ...message.content.filter((part) => part.type === 'text').map((part) => part.text)
      )
    }
    expect(systemText).toEqual([
      'DEVELOPER_SENTINEL_PERSONA',
      'DEVELOPER_SENTINEL_PERMISSIONS',
      '',
      'DEVELOPER_SENTINEL_SKILLS',
      'DEVELOPER_SENTINEL_COLLABORATION'
    ])
    expect(body.tools?.map((tool) => tool.function.name)).toEqual([
      'kiro_custom_0',
      'wait',
      'request_user_input',
      'kiro_ns_0',
      'kiro_ns_1',
      'kiro_ns_2',
      'kiro_ns_3',
      'kiro_ns_4',
      'kiro_ns_5'
    ])
    expect(body.messages.filter((message) => message.role === 'user')).toHaveLength(2)

    const customRestored = adapted.bridge.restoreCalls([
      {
        itemId: 'fc_custom',
        id: 'call_custom',
        name: 'kiro_custom_0',
        arguments: JSON.stringify({ input: 'PUBLIC_INPUT' })
      }
    ])
    expect(customRestored).toEqual({
      ok: true,
      items: [
        {
          id: 'fc_custom',
          type: 'custom_tool_call',
          call_id: 'call_custom',
          name: 'exec',
          input: 'PUBLIC_INPUT'
        }
      ]
    })

    const namespaceChildren = [
      'followup_task',
      'interrupt_agent',
      'list_agents',
      'send_message',
      'spawn_agent',
      'wait_agent'
    ]
    for (const [index, child] of namespaceChildren.entries()) {
      const restored = adapted.bridge.restoreCalls([
        {
          itemId: `fc_${index}`,
          id: `call_${index}`,
          name: `kiro_ns_${index}`,
          arguments: '{"task_name":"review"}'
        }
      ])
      expect(restored).toEqual({
        ok: true,
        items: [
          {
            id: `fc_${index}`,
            type: 'function_call',
            call_id: `call_${index}`,
            namespace: 'collaboration',
            name: child,
            arguments: '{"task_name":"review"}'
          }
        ]
      })
    }
  })

  test.each([
    ['codex-tool-turn.json', 'STRING_TOOL_OUTPUT'],
    ['codex-tool-turn-array.json', 'ARRAY_TOOL_OUTPUT_FIRST\nARRAY_TOOL_OUTPUT_SECOND']
  ])('adapts %s into a valid non-empty tool turn', async (fixture, expected) => {
    const raw = await loadFixture(fixture)
    const body = adaptValid(raw)
    expect(body.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'CALL_ID_REDACTED', content: expected }]
    })
  })

  test('reconstructs a custom alias and history spec without declarations', async () => {
    const body = adaptValid(await loadFixture('codex-custom-tool-turn.json'))
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'kiro_custom_0',
          parameters: expect.objectContaining({
            type: 'object',
            required: ['input'],
            additionalProperties: false
          })
        }
      }
    ])
    expect(body.messages).toEqual([
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'CUSTOM_CALL_ID_REDACTED',
            type: 'function',
            function: {
              name: 'kiro_custom_0',
              arguments: JSON.stringify({ input: "printf 'CUSTOM_RAW_INPUT_REDACTED\\n'" })
            }
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'CUSTOM_CALL_ID_REDACTED',
            content: 'CUSTOM_TOOL_OUTPUT_REDACTED'
          }
        ]
      }
    ])

    const transformed = buildCodeWhispererRequest(body, MODEL, AUTH)
    expect(
      transformed.request.conversationState.currentMessage.userInputMessage
        ?.userInputMessageContext?.tools
    ).toEqual([
      {
        toolSpecification: {
          name: 'kiro_custom_0',
          description: '',
          inputSchema: {
            json: expect.objectContaining({
              type: 'object',
              required: ['input'],
              additionalProperties: false
            })
          }
        }
      }
    ])
    expect(
      transformed.request.conversationState.history?.flatMap(
        (entry) => entry.assistantResponseMessage?.toolUses ?? []
      )
    ).toEqual([
      {
        input: { input: "printf 'CUSTOM_RAW_INPUT_REDACTED\\n'" },
        name: 'kiro_custom_0',
        toolUseId: 'CUSTOM_CALL_ID_REDACTED'
      }
    ])
    expect(
      transformed.request.conversationState.currentMessage.userInputMessage
        ?.userInputMessageContext?.toolResults
    ).toEqual([
      {
        toolUseId: 'CUSTOM_CALL_ID_REDACTED',
        content: [{ text: 'CUSTOM_TOOL_OUTPUT_REDACTED' }],
        status: 'success'
      }
    ])
  })

  test('reconstructs a namespace alias and history spec without declarations', async () => {
    const body = adaptValid(await loadFixture('codex-namespace-tool-turn.json'))
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'kiro_ns_0',
          parameters: { type: 'object' }
        }
      }
    ])
    expect(body.messages[0]).toMatchObject({
      role: 'assistant',
      tool_calls: [
        {
          id: 'NAMESPACE_CALL_ID_REDACTED',
          function: { name: 'kiro_ns_0' }
        }
      ]
    })
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'NAMESPACE_CALL_ID_REDACTED',
          content: 'NAMESPACE_TOOL_OUTPUT_REDACTED'
        }
      ]
    })

    const transformed = buildCodeWhispererRequest(body, MODEL, AUTH)
    expect(
      transformed.request.conversationState.currentMessage.userInputMessage
        ?.userInputMessageContext?.tools
    ).toEqual([
      {
        toolSpecification: {
          name: 'kiro_ns_0',
          description: '',
          inputSchema: { json: { type: 'object' } }
        }
      }
    ])
    expect(
      transformed.request.conversationState.history?.flatMap(
        (entry) => entry.assistantResponseMessage?.toolUses ?? []
      )
    ).toEqual([
      {
        input: { task_name: 'TASK_REDACTED', message: 'MESSAGE_REDACTED' },
        name: 'kiro_ns_0',
        toolUseId: 'NAMESPACE_CALL_ID_REDACTED'
      }
    ])
    expect(
      transformed.request.conversationState.currentMessage.userInputMessage
        ?.userInputMessageContext?.toolResults
    ).toEqual([
      {
        toolUseId: 'NAMESPACE_CALL_ID_REDACTED',
        content: [{ text: 'NAMESPACE_TOOL_OUTPUT_REDACTED' }],
        status: 'success'
      }
    ])
  })
})
