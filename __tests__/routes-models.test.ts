import { describe, expect, test } from 'bun:test'
import { EXPECTED_PUBLIC_MODEL_IDS } from '../src/kiro/model-catalog.js'
import { handleHealth } from '../src/server/routes/health.js'
import { handleModels } from '../src/server/routes/models.js'

describe('GET /v1/models', () => {
  test('returns an OpenAI-shaped list sourced from the model catalog', async () => {
    const response = handleModels()
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/json')

    const body = (await response.json()) as { object: string; data: unknown[] }
    expect(body.object).toBe('list')
    expect(Array.isArray(body.data)).toBe(true)

    const entries = body.data as Array<{ id: string; object: string; created: number; owned_by: string }>
    const catalogIds = new Set<string>(EXPECTED_PUBLIC_MODEL_IDS)
    const responseIds = new Set(entries.map((entry) => entry.id))

    expect(responseIds.size).toBe(catalogIds.size)
    for (const id of catalogIds) {
      expect(responseIds.has(id)).toBe(true)
    }
    for (const entry of entries) {
      expect(catalogIds.has(entry.id)).toBe(true)
      expect(entry.object).toBe('model')
      expect(typeof entry.created).toBe('number')
      expect(typeof entry.owned_by).toBe('string')
    }
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
