import { describe, expect, test } from 'bun:test'
import { findRealTag } from '../src/kiro/transform/streaming/stream-helpers.js'

describe('findRealTag', () => {
  test('finds a tag outside code blocks', () => {
    expect(findRealTag('abc <thinking> def', '<thinking>')).toBe(4)
  })

  test('ignores a tag inside a fenced code block and finds the real tag after it', () => {
    const buffer = '```\n<thinking>\n```\nreal <thinking> here'
    const position = findRealTag(buffer, '<thinking>')

    expect(position).toBeGreaterThan(buffer.indexOf('```\n<thinking>\n```'))
    expect(buffer.slice(position, position + '<thinking>'.length)).toBe('<thinking>')
  })

  test('returns -1 when the tag only appears inside a fenced code block', () => {
    expect(findRealTag('```\n<thinking>\n```', '<thinking>')).toBe(-1)
  })

  test('returns -1 when the tag is absent', () => {
    expect(findRealTag('no tag at all', '<thinking>')).toBe(-1)
  })
})
