import { describe, expect, test } from 'bun:test'
import { resolveBaseUrl } from '../scripts/smoke.js'

describe('resolveBaseUrl', () => {
  test('prefers the flag over every environment fallback', () => {
    expect(resolveBaseUrl({
      KIRO_PROVIDER_BASE_URL: 'http://127.0.0.1:8999',
      KIRO_PROVIDER_HOST: '0.0.0.0',
      KIRO_PROVIDER_PORT: '8888'
    }, { baseUrl: 'http://127.0.0.1:9000/' })).toBe('http://127.0.0.1:9000')
  })

  test('prefers KIRO_PROVIDER_BASE_URL over host and port', () => {
    expect(resolveBaseUrl({
      KIRO_PROVIDER_BASE_URL: 'http://localhost:8999/',
      KIRO_PROVIDER_HOST: '0.0.0.0',
      KIRO_PROVIDER_PORT: '8888'
    }, {})).toBe('http://localhost:8999')
  })

  test('uses the default host when only KIRO_PROVIDER_PORT is set', () => {
    expect(resolveBaseUrl({ KIRO_PROVIDER_PORT: '8888' }, {}))
      .toBe('http://127.0.0.1:8888')
  })

  test('uses KIRO_PROVIDER_HOST with KIRO_PROVIDER_PORT', () => {
    expect(resolveBaseUrl({
      KIRO_PROVIDER_HOST: 'localhost',
      KIRO_PROVIDER_PORT: '8888'
    }, {})).toBe('http://localhost:8888')
  })

  test('uses the default URL when no override is set', () => {
    expect(resolveBaseUrl({}, {})).toBe('http://127.0.0.1:8787')
  })
})
