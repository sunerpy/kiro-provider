import { describe, expect, test } from 'bun:test'
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

function adaptValid(raw: unknown): InternalChatBody {
  const adapted = responsesToInternalChat(parseValid(raw))
  expect(adapted.ok).toBe(true)
  if (!adapted.ok) throw new TypeError(`Expected an adapted body, received ${adapted.code}`)

  const internal = parseChatCompletionRequest(adapted.body)
  expect(internal.ok).toBe(true)
  if (!internal.ok) throw new TypeError('Adapted body did not pass internal chat validation')
  return adapted.body
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
      { role: 'tool', tool_call_id: 'call_1', content: expected }
    ])
  })

  test('merges function tools stably while top-level definitions win name conflicts', () => {
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
    expect(body.messages).toEqual([{ role: 'tool', tool_call_id: 'call_1', content: '' }])
  })
})

describe('redacted Codex request fixtures', () => {
  test('adapts the real first-turn shape without losing developer instructions or function tools', async () => {
    const raw = await loadFixture('codex-first-turn.json')
    const body = adaptValid(raw)
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
      'wait',
      'request_user_input'
    ])
    expect(body.messages.filter((message) => message.role === 'user')).toHaveLength(2)
  })

  test.each([
    ['codex-tool-turn.json', 'STRING_TOOL_OUTPUT'],
    ['codex-tool-turn-array.json', 'ARRAY_TOOL_OUTPUT_FIRST\nARRAY_TOOL_OUTPUT_SECOND']
  ])('adapts %s into a valid non-empty tool turn', async (fixture, expected) => {
    const raw = await loadFixture(fixture)
    const body = adaptValid(raw)
    expect(body.messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'CALL_ID_REDACTED',
      content: expected
    })
  })
})
