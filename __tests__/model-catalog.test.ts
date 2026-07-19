import { describe, expect, test } from 'bun:test'
import {
  EXPECTED_PUBLIC_MODEL_IDS,
  MODEL_CATALOG
} from '../src/kiro/model-catalog.js'
import { resolveModelVariant } from '../src/kiro/models.js'

const LEGACY_ONLY_MODEL_IDS = [
  'claude-3-7-sonnet',
  'nova-swe',
  'gpt-oss-120b',
  'minimax-m2',
  'kimi-k2-thinking'
] as const

describe('MODEL_CATALOG', () => {
  test('contains exactly the frozen public model id set in both directions', () => {
    const catalogIds = new Set(MODEL_CATALOG.map(({ id }) => id))
    const expectedIds = new Set<string>(EXPECTED_PUBLIC_MODEL_IDS)

    expect(MODEL_CATALOG).toHaveLength(EXPECTED_PUBLIC_MODEL_IDS.length)
    expect([...catalogIds].sort()).toEqual([...expectedIds].sort())
    expect([...catalogIds].filter((id) => !expectedIds.has(id))).toEqual([])
    expect([...expectedIds].filter((id) => !catalogIds.has(id))).toEqual([])
  })

  test('maps every public id to its declared wire id', () => {
    for (const entry of MODEL_CATALOG) {
      expect(resolveModelVariant(entry.id).wireId).toBe(entry.wireId)
    }
  })

  test('provides numeric context and output limits for every entry', () => {
    for (const entry of MODEL_CATALOG) {
      expect(Number.isFinite(entry.contextLimit)).toBe(true)
      expect(entry.contextLimit).toBeGreaterThan(0)
      expect(Number.isFinite(entry.outputLimit)).toBe(true)
      expect(entry.outputLimit).toBeGreaterThan(0)
    }
  })

  test('does not expose legacy or wire-only model ids', () => {
    const catalogIds = new Set(MODEL_CATALOG.map(({ id }) => id))

    for (const legacyId of LEGACY_ONLY_MODEL_IDS) {
      expect(catalogIds.has(legacyId)).toBe(false)
    }
  })
})
