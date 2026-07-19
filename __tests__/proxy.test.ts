import { describe, expect, test } from 'bun:test'
import {
  createProxyAgent,
  fetchProxyOption,
  resolveProxyUrl
} from '../src/core/proxy.js'

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

describe('createProxyAgent', () => {
  test('returns the same agent for repeated calls with one URL', () => {
    const proxyUrl = 'http://cache-proxy:8080'

    const first = createProxyAgent(proxyUrl)
    const second = createProxyAgent(proxyUrl)

    expect(second).toBe(first)
  })

  test('returns different agents for different URLs', () => {
    const first = createProxyAgent('http://proxy-a:8080')
    const second = createProxyAgent('http://proxy-b:8080')

    expect(second).not.toBe(first)
  })

  test('configures connection reuse and the socket limit', () => {
    const agent = createProxyAgent('http://agent-options:8080')

    expect(agent.keepAlive).toBe(true)
    expect(agent.maxSockets).toBe(50)
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
