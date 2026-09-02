import { describe, expect, test } from 'bun:test'
import { KiroTokenRefreshError } from '../src/kiro/errors.js'

describe('KiroTokenRefreshError', () => {
  test('sets name, message, code and originalError', () => {
    const original = new Error('boom')
    const err = new KiroTokenRefreshError('refresh failed', 'HTTP_401', original)
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(KiroTokenRefreshError)
    expect(err.name).toBe('KiroTokenRefreshError')
    expect(err.message).toBe('refresh failed')
    expect(err.code).toBe('HTTP_401')
    expect(err.originalError).toBe(original)
  })

  test('code and originalError are undefined when omitted', () => {
    const err = new KiroTokenRefreshError('refresh failed')
    expect(err.name).toBe('KiroTokenRefreshError')
    expect(err.message).toBe('refresh failed')
    expect(err.code).toBeUndefined()
    expect(err.originalError).toBeUndefined()
  })
})

describe('error classes', () => {
  test('errors carry a stack trace', () => {
    const err = new KiroTokenRefreshError('x')
    expect(typeof err.stack).toBe('string')
  })
})
