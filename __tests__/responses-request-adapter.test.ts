import { describe, expect, test } from 'bun:test'
import {
  type ChatCompletionRequest,
  parseChatCompletionRequest,
  parseResponsesRequest,
  type ResponsesRequest
} from '../src/server/request-schema.js'
import { responsesToInternalChat } from '../src/server/responses/request-adapter.js'

const MODEL = 'gpt-5.6-sol'
const EFFORT_CASES: Array<
  [
    'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
    ChatCompletionRequest['reasoning_effort']
  ]
> = [
  ['none', undefined],
  ['minimal', 'low'],
  ['low', 'low'],
  ['medium', 'medium'],
  ['high', 'high'],
  ['xhigh', 'xhigh']
]

function parsedResponses(raw: unknown): ResponsesRequest {
  const parsed = parseResponsesRequest(raw)
  if (!parsed.ok) throw new TypeError('Expected a valid Responses request')
  return parsed.value
}

function adaptedBody(raw: unknown): ChatCompletionRequest {
  const adapted = responsesToInternalChat(parsedResponses(raw))
  if (!adapted.ok) throw new TypeError(`Expected an adapted body, received ${adapted.code}`)

  const internal = parseChatCompletionRequest(adapted.body)
  expect(internal.ok).toBe(true)
  if (!internal.ok) throw new TypeError('Adapted body did not pass internal chat validation')
  return internal.value
}

async function expectInvalid(raw: unknown): Promise<void> {
  const parsed = parseResponsesRequest(raw)
  expect(parsed.ok).toBe(false)
  if (parsed.ok) throw new TypeError('Expected an invalid Responses request')
  expect(parsed.response.status).toBe(400)
  expect(await parsed.response.json()).toMatchObject({
    error: {
      type: 'invalid_request_error',
      code: 'invalid_request'
    }
  })
}

describe('Responses request parsing and adaptation', () => {
  test('maps string input, instructions, tools, tool choice, model, and stream', () => {
    const body = adaptedBody({
      model: MODEL,
      instructions: 'Follow the repository rules.',
      input: 'Inspect the project.',
      stream: true,
      tools: [
        {
          type: 'function',
          name: 'read_file',
          description: 'Read one file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path']
          },
          strict: true
        }
      ],
      tool_choice: 'auto'
    })

    expect(body).toEqual({
      model: MODEL,
      stream: true,
      messages: [
        { role: 'system', content: 'Follow the repository rules.' },
        { role: 'user', content: 'Inspect the project.' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read one file',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path']
            }
          }
        }
      ],
      tool_choice: 'auto'
    })
  })

  test('maps text and image parts while skipping genuinely unknown content parts', () => {
    const body = adaptedBody({
      model: MODEL,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'first' },
            { type: 'output_text', text: 'second' },
            { type: 'input_image', image_url: 'data:image/png;base64,AA==' },
            { type: 'input_image', image_url: 'https://example.test/image.png' },
            { type: 'future_content_part', payload: { accepted: true } }
          ]
        }
      ]
    })

    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
          { type: 'image_url', image_url: { url: 'https://example.test/image.png' } }
        ]
      }
    ])
  })

  test('maps function calls and function outputs to assistant and tool messages', () => {
    const body = adaptedBody({
      model: MODEL,
      input: [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"README.md"}'
        },
        { type: 'function_call_output', call_id: 'call_1', output: 'contents' }
      ]
    })

    expect(body.messages).toEqual([
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"README.md"}' }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'contents' }
    ])
  })

  test.each([
    [
      'summary-only',
      { summary: [{ type: 'summary_text', text: 'summary' }] },
      'summary'
    ],
    [
      'content-only',
      { content: [{ type: 'reasoning_text', reasoning_text: 'details' }] },
      'details'
    ],
    [
      'summary before content',
      {
        summary: [
          { type: 'summary_text', text: 'summary one' },
          { type: 'summary_text', text: '' }
        ],
        content: [
          { type: 'reasoning_text', reasoning_text: 'detail one' },
          { type: 'reasoning_text', reasoning_text: 'detail two' }
        ]
      },
      'summary one\ndetail one\ndetail two'
    ]
  ])('maps visible reasoning (%s) into the following assistant message', (_name, reasoning, expected) => {
    const body = adaptedBody({
      model: MODEL,
      input: [
        { type: 'reasoning', ...reasoning },
        {
          type: 'function_call',
          call_id: 'call_reasoned',
          name: 'search',
          arguments: '{}'
        }
      ]
    })

    expect(body.messages).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: expected }],
        tool_calls: [
          {
            id: 'call_reasoned',
            type: 'function',
            function: { name: 'search', arguments: '{}' }
          }
        ]
      }
    ])
  })

  test('emits standalone visible reasoning when no following assistant item exists', () => {
    const body = adaptedBody({
      model: MODEL,
      input: [
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'standalone thought' }]
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] }
      ]
    })

    expect(body.messages).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'standalone thought' }]
      },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] }
    ])
  })

  test.each(EFFORT_CASES)('normalizes reasoning effort %s', (effort, expected) => {
    const body = adaptedBody({
      model: MODEL,
      input: 'hello',
      reasoning: { effort }
    })

    expect(body.reasoning_effort).toBe(expected)
  })

  test('accepts the canonical Codex request surface and ignores non-adapted fields', () => {
    const parsed = parsedResponses({
      model: MODEL,
      input: 'hello',
      tools: [],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      reasoning: null,
      include: ['reasoning.encrypted_content'],
      store: false,
      text: { format: { type: 'text' } },
      service_tier: 'default',
      prompt_cache_key: 'cache-key',
      client_metadata: { source: 'codex' },
      previous_response_id: 'resp_previous'
    })
    const adapted = responsesToInternalChat(parsed)

    expect(adapted).toMatchObject({
      ok: true,
      body: {
        model: MODEL,
        messages: [{ role: 'user', content: 'hello' }]
      }
    })
  })

  test.each([
    ['all unknown items', [{ type: 'future_item', payload: true }]],
    [
      'encrypted-only reasoning',
      [{ type: 'reasoning', encrypted_content: 'opaque-ciphertext' }]
    ],
    [
      'system-only input',
      [{ type: 'message', role: 'system', content: [{ type: 'input_text', text: 'policy' }] }]
    ]
  ])('returns empty_input for instructions plus %s', (_name, input) => {
    const adapted = responsesToInternalChat(
      parsedResponses({ model: MODEL, instructions: 'instructions', input })
    )
    expect(adapted).toEqual({ ok: false, code: 'empty_input' })
  })

  test('keeps known non-system messages executable when all unknown parts are skipped', () => {
    const body = adaptedBody({
      model: MODEL,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'future_content_part', payload: true }]
        }
      ]
    })

    expect(body.messages).toEqual([{ role: 'user', content: [] }])
  })

  test.each([
    ['missing model', { input: 'hello' }],
    ['missing input', { model: MODEL }],
    ['invalid input', { model: MODEL, input: 42 }],
    ['invalid effort', { model: MODEL, input: 'hello', reasoning: { effort: 'extreme' } }],
    [
      'malformed message',
      { model: MODEL, input: [{ type: 'message', role: 'user' }] }
    ],
    [
      'invalid known message role',
      {
        model: MODEL,
        input: [{ type: 'message', role: 'tool', content: [] }]
      }
    ],
    [
      'malformed known text part',
      {
        model: MODEL,
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 42 }] }
        ]
      }
    ],
    [
      'malformed known image part',
      {
        model: MODEL,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_image' }] }]
      }
    ],
    [
      'malformed function call',
      {
        model: MODEL,
        input: [{ type: 'function_call', call_id: 'call_1', name: 'search' }]
      }
    ],
    [
      'malformed reasoning summary',
      {
        model: MODEL,
        input: [
          { type: 'reasoning', summary: [{ type: 'summary_text', text: 42 }] }
        ]
      }
    ]
  ])('rejects %s as a Responses-style 400', async (_name, raw) => {
    await expectInvalid(raw)
  })
})
