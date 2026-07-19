import { describe, expect, test } from 'bun:test'
import {
  buildEffortRequestFields,
  resolveEffectiveEffort
} from '../src/kiro/effort.js'
import { resolveModelVariant } from '../src/kiro/models.js'
import type { Effort } from '../src/kiro/types.js'

function requireEffort(effort: Effort | undefined): Effort {
  expect(effort).toBeDefined()
  if (effort === undefined) {
    throw new Error('Expected an effective effort')
  }
  return effort
}

describe('resolveEffectiveEffort', () => {
  test('variant effort overrides request, global config, and budget mapping', () => {
    const effort = resolveEffectiveEffort({
      model: 'claude-opus-4-8-max',
      reasoningEffort: 'low',
      configEffort: 'high',
      think: true,
      budget: 16384,
      autoEffortMapping: true
    })

    expect(effort).toBe('max')
  })

  test('request effort overrides global config and budget mapping', () => {
    const effort = resolveEffectiveEffort({
      model: 'claude-opus-4-8',
      reasoningEffort: 'low',
      configEffort: 'high',
      think: true,
      budget: 16384,
      autoEffortMapping: true
    })

    expect(effort).toBe('low')
  })

  test('global config effort overrides budget mapping', () => {
    const effort = resolveEffectiveEffort({
      model: 'claude-opus-4-8',
      configEffort: 'high',
      think: true,
      budget: 5000,
      autoEffortMapping: true
    })

    expect(effort).toBe('high')
  })

  test('invalid internal effort values fall through to the next precedence level', () => {
    expect(
      resolveEffectiveEffort({
        model: 'claude-opus-4-8',
        reasoningEffort: 'invalid-request-effort',
        configEffort: 'high',
        think: true,
        budget: 5000,
        autoEffortMapping: true
      })
    ).toBe('high')
    expect(
      resolveEffectiveEffort({
        model: 'claude-opus-4-8',
        reasoningEffort: 'invalid-request-effort',
        configEffort: 'invalid-config-effort',
        think: true,
        budget: 5000,
        autoEffortMapping: true
      })
    ).toBe('low')
  })

  test('budget mapping applies only to thinking requests with auto mapping enabled', () => {
    expect(
      resolveEffectiveEffort({
        model: 'claude-opus-4-8',
        think: true,
        budget: 24576,
        autoEffortMapping: true
      })
    ).toBe('high')
    expect(
      resolveEffectiveEffort({
        model: 'claude-opus-4-8',
        think: false,
        budget: 24576,
        autoEffortMapping: true
      })
    ).toBeUndefined()
  })

  test('thinking without auto mapping or explicit effort falls back to medium', () => {
    expect(
      resolveEffectiveEffort({
        model: 'claude-opus-4-8',
        think: true,
        budget: 128000,
        autoEffortMapping: false
      })
    ).toBe('medium')
  })

  test('non-thinking without explicit effort returns undefined', () => {
    expect(
      resolveEffectiveEffort({
        model: 'claude-opus-4-8',
        think: false,
        budget: 128000,
        autoEffortMapping: false
      })
    ).toBeUndefined()
  })

  test('dispatches Claude effort through output_config using the resolved wire id', () => {
    const resolved = resolveModelVariant('claude-opus-4-8-high')
    const effort = requireEffort(
      resolveEffectiveEffort({
        model: 'claude-opus-4-8-high',
        think: false,
        budget: 20000,
        autoEffortMapping: true
      })
    )

    expect(buildEffortRequestFields(resolved.wireId, effort)).toEqual({
      output_config: { effort: 'high' }
    })
  })

  test('dispatches GPT effort through reasoning using the resolved wire id', () => {
    const resolved = resolveModelVariant('gpt-5.6-sol-high')
    const effort = requireEffort(
      resolveEffectiveEffort({
        model: 'gpt-5.6-sol-high',
        think: false,
        budget: 20000,
        autoEffortMapping: true
      })
    )

    expect(buildEffortRequestFields(resolved.wireId, effort)).toEqual({
      reasoning: { effort: 'high' }
    })
  })

  test('clamps xhigh variants to max when the resolved model lacks xhigh support', () => {
    expect(
      resolveEffectiveEffort({
        model: 'claude-sonnet-4-6-xhigh',
        think: false,
        budget: 20000,
        autoEffortMapping: true
      })
    ).toBe('max')
  })

  test('returns undefined for models that do not support effort', () => {
    expect(
      resolveEffectiveEffort({
        model: 'claude-haiku-4-5-thinking',
        reasoningEffort: 'max',
        configEffort: 'high',
        think: true,
        budget: 128000,
        autoEffortMapping: true
      })
    ).toBeUndefined()
  })
})
