import { describe, expect, test } from 'bun:test'
import { EXPECTED_PUBLIC_MODEL_IDS } from '../src/kiro/model-catalog.js'
import { handleHealth } from '../src/server/routes/health.js'
import { handleModels } from '../src/server/routes/models.js'

describe('GET /v1/models', () => {
  test('returns OpenAI and Codex catalogs from the same source without provider instructions', async () => {
    const response = handleModels()
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/json')

    const body = (await response.json()) as {
      object: string
      data: unknown[]
      models: Array<{
        slug: string
        display_name: string
        base_instructions: string
        context_window: number
        shell_type: string
        supported_reasoning_levels: unknown[]
      }>
    }
    expect(body.object).toBe('list')
    expect(Array.isArray(body.data)).toBe(true)
    expect(Array.isArray(body.models)).toBe(true)

    const entries = body.data as Array<{ id: string; object: string; created: number; owned_by: string }>
    const catalogIds = new Set<string>(EXPECTED_PUBLIC_MODEL_IDS)
    const responseIds = new Set(entries.map((entry) => entry.id))
    const codexIds = new Set(body.models.map((entry) => entry.slug))

    expect(responseIds.size).toBe(catalogIds.size)
    expect(codexIds.size).toBe(catalogIds.size)
    for (const id of catalogIds) {
      expect(responseIds.has(id)).toBe(true)
      expect(codexIds.has(id)).toBe(true)
    }
    for (const entry of entries) {
      expect(catalogIds.has(entry.id)).toBe(true)
      expect(entry.object).toBe('model')
      expect(typeof entry.created).toBe('number')
      expect(typeof entry.owned_by).toBe('string')
    }
    for (const entry of body.models) {
      expect(entry.display_name.length).toBeGreaterThan(0)
      expect(entry.base_instructions).toBe('')
      expect(entry.context_window).toBeGreaterThan(0)
      expect(entry.shell_type).toBe('unified_exec')
      expect(Array.isArray(entry.supported_reasoning_levels)).toBe(true)
    }

    const opus5 = entries.find((entry) => entry.id === 'claude-opus-5') as
      | ({ context_limit?: number; output_limit?: number } & (typeof entries)[number])
      | undefined
    const opus5Codex = body.models.find((entry) => entry.slug === 'claude-opus-5')
    expect(opus5).toMatchObject({ context_limit: 1_000_000, output_limit: 128_000 })
    expect(opus5Codex).toMatchObject({
      context_window: 1_000_000,
      supported_reasoning_levels: [
        { effort: 'low' },
        { effort: 'medium' },
        { effort: 'high' },
        { effort: 'xhigh' },
        { effort: 'max' }
      ]
    })
  })
})

describe('GET /health', () => {
  test('returns status ok', async () => {
    const response = handleHealth()
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/json')

    const body = (await response.json()) as { status: string }
    expect(body.status).toBe('ok')
  })
})
