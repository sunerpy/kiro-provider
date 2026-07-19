import { describe, expect, test } from 'bun:test'
import { estimateTokens } from '../src/kiro/transform/response.js'

describe('estimateTokens', () => {
  test('returns the ceiling of text length divided by four', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('a'.repeat(40))).toBe(10)
  })
})
