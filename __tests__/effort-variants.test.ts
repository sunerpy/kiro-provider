import { describe, expect, test } from 'bun:test'
import {
  buildEffortRequestFields,
  resolveEffort,
  supportsEffort,
  supportsXHighEffort
} from '../src/kiro/effort.js'
import { resolveModelVariant } from '../src/kiro/models.js'

describe('resolveModelVariant', () => {
  describe('parse — variants (exact deep-equal)', () => {
    test('claude-opus-4-8-xhigh -> {wireId: claude-opus-4.8, effort: xhigh}', () => {
      expect(resolveModelVariant('claude-opus-4-8-xhigh')).toEqual({
        wireId: 'claude-opus-4.8',
        effort: 'xhigh'
      })
    })

    test('claude-sonnet-4-6-max -> {wireId: claude-sonnet-4.6, effort: max}', () => {
      expect(resolveModelVariant('claude-sonnet-4-6-max')).toEqual({
        wireId: 'claude-sonnet-4.6',
        effort: 'max'
      })
    })

    test('claude-sonnet-5-high -> {wireId: claude-sonnet-5, effort: high}', () => {
      expect(resolveModelVariant('claude-sonnet-5-high')).toEqual({
        wireId: 'claude-sonnet-5',
        effort: 'high'
      })
    })

    test('claude-opus-4-7-low and -medium parse to the 4.7 wire id', () => {
      expect(resolveModelVariant('claude-opus-4-7-low')).toEqual({
        wireId: 'claude-opus-4.7',
        effort: 'low'
      })
      expect(resolveModelVariant('claude-opus-4-7-medium')).toEqual({
        wireId: 'claude-opus-4.7',
        effort: 'medium'
      })
    })

    test('gpt-5.6-sol-high -> {wireId: gpt-5.6-sol, effort: high} (identity wire id)', () => {
      expect(resolveModelVariant('gpt-5.6-sol-high')).toEqual({
        wireId: 'gpt-5.6-sol',
        effort: 'high'
      })
    })

    test('all gpt-5.6 bases parse every effort suffix to their identity wire id', () => {
      for (const base of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
        for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
          expect(resolveModelVariant(`${base}-${effort}`)).toEqual({ wireId: base, effort })
        }
      }
    })
  })

  describe('parse — NON-variants (no misparse, effort stays undefined)', () => {
    test('plain base claude-opus-4-8 is NOT a variant', () => {
      const r = resolveModelVariant('claude-opus-4-8')
      expect(r.wireId).toBe('claude-opus-4.8')
      expect(r.effort).toBeUndefined()
    })

    test('claude-opus-4-8-thinking gets wire id from map, no effort', () => {
      const r = resolveModelVariant('claude-opus-4-8-thinking')
      expect(r.wireId).toBe('claude-opus-4.8')
      expect(r.effort).toBeUndefined()
    })

    test('claude-sonnet-4-5-1m is a mapped slug, not an effort variant', () => {
      const r = resolveModelVariant('claude-sonnet-4-5-1m')
      expect(r.wireId).toBe('claude-sonnet-4.5-1m')
      expect(r.effort).toBeUndefined()
    })

    test('claude-haiku-4-5-high: base not in allowlist -> NOT a variant (throws, no misparse)', () => {
      // haiku base is not allowlisted, so this falls through to resolveKiroModel
      // on the full unmapped slug and throws — a misparse would have returned an
      // effort instead of throwing.
      expect(() => resolveModelVariant('claude-haiku-4-5-high')).toThrow('Unsupported model')
    })

    test('non-effort suffix on an allowlisted base is not a variant', () => {
      // `-thinking` is not an effort suffix, so claude-sonnet-5-thinking stays a
      // plain mapped slug.
      const r = resolveModelVariant('claude-sonnet-5-thinking')
      expect(r.wireId).toBe('claude-sonnet-5')
      expect(r.effort).toBeUndefined()
    })
  })
})

describe('effort capability', () => {
  test('claude-sonnet-5 supports effort and xhigh', () => {
    expect(supportsEffort('claude-sonnet-5')).toBe(true)
    expect(supportsXHighEffort('claude-sonnet-5')).toBe(true)
    expect(resolveEffort('claude-sonnet-5', 'xhigh')).toBe('xhigh')
  })

  test('gpt-5.6 models support effort and xhigh (probe-confirmed, credits scale)', () => {
    for (const wire of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(supportsEffort(wire)).toBe(true)
      expect(supportsXHighEffort(wire)).toBe(true)
      expect(resolveEffort(wire, 'xhigh')).toBe('xhigh')
      expect(resolveEffort(wire, 'max')).toBe('max')
    }
  })

  test('claude-sonnet-4.6 supports effort but NOT xhigh (clamped to max)', () => {
    expect(supportsEffort('claude-sonnet-4.6')).toBe(true)
    expect(supportsXHighEffort('claude-sonnet-4.6')).toBe(false)
    expect(resolveEffort('claude-sonnet-4.6', 'xhigh')).toBe('max')
  })

  test('opus 4.7 and 4.8 keep xhigh (no clamp)', () => {
    expect(resolveEffort('claude-opus-4.7', 'xhigh')).toBe('xhigh')
    expect(resolveEffort('claude-opus-4.8', 'xhigh')).toBe('xhigh')
  })
})

describe('buildEffortRequestFields — per-model wire shape dispatch', () => {
  test('GPT models use reasoning.effort', () => {
    for (const wire of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(buildEffortRequestFields(wire, 'high')).toEqual({ reasoning: { effort: 'high' } })
    }
  })

  test('Claude models use output_config.effort', () => {
    for (const wire of ['claude-opus-4.8', 'claude-sonnet-5', 'claude-sonnet-4.6']) {
      expect(buildEffortRequestFields(wire, 'high')).toEqual({ output_config: { effort: 'high' } })
    }
  })

  test('unknown/non-GPT model defaults to Claude output_config shape', () => {
    expect(buildEffortRequestFields('some-future-model', 'low')).toEqual({
      output_config: { effort: 'low' }
    })
  })
})
