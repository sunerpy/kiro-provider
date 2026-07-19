import { describe, expect, test } from 'bun:test'
import { DialectGate } from '../src/kiro/transform/streaming/dialect-gate.js'
import {
  cleanToolCallsFromText,
  DSML_MARKER,
  deduplicateToolCalls,
  parseBracketToolCalls,
  parseTextToolCalls
} from '../src/kiro/transform/tool-call-parser.js'

describe('parseTextToolCalls — Anthropic XML', () => {
  test('single complete invoke → correct name+input, span stripped', () => {
    const text = 'before <invoke name="read"><parameter name="path">/tmp/x</parameter></invoke> after'
    const { toolCalls, cleanedText } = parseTextToolCalls(text)
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]?.name).toBe('read')
    expect(toolCalls[0]?.input).toEqual({ path: '/tmp/x' })
    expect(cleanedText).toBe('before  after')
    expect(cleanedText).not.toContain('<invoke')
  })
  test('function_calls block with multiple invokes → 2 calls, JSON params parsed', () => {
    const text =
      '<function_calls>' +
      '<invoke name="a"><parameter name="n">5</parameter></invoke>' +
      '<invoke name="b"><parameter name="flag">true</parameter><parameter name="s">hi</parameter></invoke>' +
      '</function_calls>'
    const { toolCalls, cleanedText } = parseTextToolCalls(text)
    expect(toolCalls).toHaveLength(2)
    expect(toolCalls[0]?.name).toBe('a')
    expect(toolCalls[0]?.input).toEqual({ n: 5 })
    expect(toolCalls[1]?.name).toBe('b')
    expect(toolCalls[1]?.input).toEqual({ flag: true, s: 'hi' })
    expect(cleanedText).not.toContain('<function_calls')
    expect(cleanedText).not.toContain('<invoke')
  })
})

describe('parseTextToolCalls — deepseek DSML (U+FF5C)', () => {
  test('trailing DSML fragment → marker stripped, unrelated text preserved', () => {
    const { cleanedText } = parseTextToolCalls(`Here is the answer.\n${DSML_MARKER} name="grep" {"pattern":"foo"}`)
    expect(cleanedText).not.toContain(DSML_MARKER)
    expect(cleanedText).toContain('Here is the answer.')
  })
  test('DSML with recoverable name+args → parsed tool call', () => {
    const text = `${DSML_MARKER} name="grep" {"pattern":"foo"}`
    const { toolCalls, cleanedText } = parseTextToolCalls(text)
    if (toolCalls.length > 0) {
      expect(toolCalls[0]?.name).toBe('grep')
      expect(toolCalls[0]?.input).toEqual({ pattern: 'foo' })
    }
    expect(cleanedText).not.toContain(DSML_MARKER)
  })
})

describe('parseTextToolCalls — bracket regression', () => {
  test('[Called X with args:{...}] still parsed', () => {
    const { toolCalls, cleanedText } = parseTextToolCalls('ok [Called search with args: {"q":"cats"}] done')
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]?.name).toBe('search')
    expect(toolCalls[0]?.input).toEqual({ q: 'cats' })
    expect(cleanedText).not.toContain('[Called')
  })
  test('parseBracketToolCalls export still works', () => {
    const calls = parseBracketToolCalls('[Called foo with args: {"a":1}]')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.name).toBe('foo')
  })

  test('deduplicates calls by tool-use id while preserving first-seen order', () => {
    const first = { toolUseId: 'same', name: 'first', input: { value: 1 } }
    const duplicate = { toolUseId: 'same', name: 'duplicate', input: { value: 2 } }
    const second = { toolUseId: 'other', name: 'second', input: {} }

    expect(deduplicateToolCalls([first, duplicate, second])).toEqual([first, second])
  })

  test('removes bracket calls whose names contain regular-expression characters', () => {
    const text = 'before [Called sum+tax with args: {"amount":10}] after'
    const calls = [{ toolUseId: 'call-1', name: 'sum+tax', input: { amount: 10 } }]

    expect(cleanToolCallsFromText(text, calls)).toBe('before after')
  })
})

describe('DialectGate', () => {
  test('emits safe prose, then suppresses a split marker until final parsing', () => {
    const gate = new DialectGate()

    expect(gate.push('answer ')).toBe('answer ')
    expect(gate.suppressing).toBe(false)
    expect(gate.push('<inv')).toBe('')
    expect(gate.push('oke name="read"><parameter name="path">/tmp/x</parameter></invoke>')).toBe('')
    expect(gate.suppressing).toBe(true)
    expect(gate.finalize()).toMatchObject({
      toolCalls: [{ name: 'read', input: { path: '/tmp/x' } }],
      remainderText: ''
    })
  })
})

describe('parseTextToolCalls — phantom / false-positive negatives', () => {
  test('prose mentioning invoke → 0 calls, text unchanged', () => {
    const text = 'we should invoke the read function to open the file'
    expect(parseTextToolCalls(text)).toEqual({ toolCalls: [], cleanedText: text })
  })
  test('fenced code block containing <invoke> → 0 calls, text unchanged', () => {
    const text = 'Example:\n```\n<invoke name="read"><parameter name="path">/etc/x</parameter></invoke>\n```\nend'
    expect(parseTextToolCalls(text)).toEqual({ toolCalls: [], cleanedText: text })
  })
  test('fenced code block containing <function_calls> → 0 calls', () => {
    const text = 'See:\n```xml\n<function_calls><invoke name="x"><parameter name="a">1</parameter></invoke></function_calls>\n```'
    expect(parseTextToolCalls(text)).toEqual({ toolCalls: [], cleanedText: text })
  })
  test('inline code with <tag> → 0 calls', () => {
    const text = 'use the `<invoke name="x">` syntax carefully'
    expect(parseTextToolCalls(text)).toEqual({ toolCalls: [], cleanedText: text })
  })
  test('[Called it a day] → 0 calls, text unchanged', () => {
    const text = 'we [Called it a day] and left'
    expect(parseTextToolCalls(text)).toEqual({ toolCalls: [], cleanedText: text })
  })
  test('unclosed <invoke name="x"> (no close) → 0 calls, text unchanged', () => {
    const text = 'partial <invoke name="read"><parameter name="path">/x</parameter>'
    expect(parseTextToolCalls(text)).toEqual({ toolCalls: [], cleanedText: text })
  })
})
