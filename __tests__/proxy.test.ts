import { describe, expect, test } from 'bun:test'
import { fetchProxyOption, resolveProxyUrl } from '../src/core/proxy.js'

describe('resolveProxyUrl', () => {
  test('returns a configured proxy URL', () => {
    expect(resolveProxyUrl({ proxy_url: 'http://p:1' })).toBe('http://p:1')
  })

  test('returns undefined for null', () => {
    expect(resolveProxyUrl({ proxy_url: null })).toBeUndefined()
  })

  test('returns undefined for an empty string', () => {
    expect(resolveProxyUrl({ proxy_url: '' })).toBeUndefined()
  })

  test('returns undefined when proxy_url is absent', () => {
    expect(resolveProxyUrl({})).toBeUndefined()
  })
})

describe('fetchProxyOption', () => {
  test('returns a proxy option when a URL is provided', () => {
    expect(fetchProxyOption('http://p:1')).toEqual({ proxy: 'http://p:1' })
  })

  test('returns an object without a proxy key when a URL is absent', () => {
    const option = fetchProxyOption()

    expect(option).toEqual({})
    expect('proxy' in option).toBe(false)
  })
})
