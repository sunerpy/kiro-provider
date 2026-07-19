import { describe, expect, test } from 'bun:test'
import { accessTokenExpired, decodeRefreshToken, encodeRefreshToken } from '../src/kiro/auth.js'
import type { KiroAuthDetails } from '../src/kiro/types.js'

function baseAuth(): KiroAuthDetails {
  return {
    refresh: 'r',
    access: 'a',
    expires: 0,
    authMethod: 'desktop',
    region: 'us-east-1'
  }
}

describe('decodeRefreshToken', () => {
  test('decodes a single-part token as desktop auth', () => {
    expect(decodeRefreshToken('plain-refresh-token')).toEqual({
      refreshToken: 'plain-refresh-token',
      authMethod: 'desktop'
    })
  })

  test('decodes IDC credentials in order', () => {
    expect(decodeRefreshToken('rtoken|my-client-id|my-client-secret|idc')).toEqual({
      refreshToken: 'rtoken',
      clientId: 'my-client-id',
      clientSecret: 'my-client-secret',
      authMethod: 'idc'
    })
  })

  test('drops credentials for an explicit desktop suffix', () => {
    expect(decodeRefreshToken('rtoken|desktop')).toEqual({
      refreshToken: 'rtoken',
      authMethod: 'desktop'
    })
  })

  test('falls back to desktop for an unrecognized method', () => {
    expect(decodeRefreshToken('rtoken|extra|social')).toEqual({
      refreshToken: 'rtoken',
      authMethod: 'desktop'
    })
  })

  test('decodes an empty token as desktop auth', () => {
    expect(decodeRefreshToken('')).toEqual({ refreshToken: '', authMethod: 'desktop' })
  })
})

describe('accessTokenExpired', () => {
  test('returns true when the access token is missing', () => {
    expect(
      accessTokenExpired({ ...baseAuth(), access: '', expires: Date.now() + 999_999 })
    ).toBe(true)
  })

  test('returns true when expiry is missing', () => {
    expect(accessTokenExpired({ ...baseAuth(), expires: 0 })).toBe(true)
  })

  test('returns false beyond the expiry buffer', () => {
    expect(accessTokenExpired({ ...baseAuth(), expires: Date.now() + 3_600_000 }, 120_000)).toBe(
      false
    )
  })

  test('returns true after expiry', () => {
    expect(accessTokenExpired({ ...baseAuth(), expires: Date.now() - 1_000 }, 120_000)).toBe(
      true
    )
  })

  test('returns true inside the expiry buffer', () => {
    expect(accessTokenExpired({ ...baseAuth(), expires: Date.now() + 60_000 }, 120_000)).toBe(
      true
    )
  })

  test('treats the exact buffer boundary as expired', () => {
    const now = Date.now()
    expect(accessTokenExpired({ ...baseAuth(), expires: now + 120_000 }, 120_000)).toBe(true)
  })

  test('returns false just beyond the buffer boundary', () => {
    expect(accessTokenExpired({ ...baseAuth(), expires: Date.now() + 130_000 }, 120_000)).toBe(
      false
    )
  })

  test('supports a zero buffer', () => {
    expect(accessTokenExpired({ ...baseAuth(), expires: Date.now() + 5_000 }, 0)).toBe(false)
  })
})

describe('encodeRefreshToken', () => {
  test('encodes desktop auth with the desktop suffix', () => {
    expect(encodeRefreshToken({ refreshToken: 'rt', authMethod: 'desktop' })).toBe('rt|desktop')
  })

  test('encodes IDC credentials and method', () => {
    expect(
      encodeRefreshToken({
        refreshToken: 'rt',
        clientId: 'cid',
        clientSecret: 'csec',
        authMethod: 'idc'
      })
    ).toBe('rt|cid|csec|idc')
  })

  test('rejects IDC auth without clientId', () => {
    expect(() =>
      encodeRefreshToken({ refreshToken: 'rt', clientSecret: 'csec', authMethod: 'idc' })
    ).toThrow('Missing credentials')
  })

  test('rejects IDC auth without clientSecret', () => {
    expect(() =>
      encodeRefreshToken({ refreshToken: 'rt', clientId: 'cid', authMethod: 'idc' })
    ).toThrow('Missing credentials')
  })

  test('round-trips IDC auth parts', () => {
    const encoded = encodeRefreshToken({
      refreshToken: 'rt',
      clientId: 'cid',
      clientSecret: 'csec',
      authMethod: 'idc'
    })
    expect(decodeRefreshToken(encoded)).toEqual({
      refreshToken: 'rt',
      clientId: 'cid',
      clientSecret: 'csec',
      authMethod: 'idc'
    })
  })

  test('round-trips desktop auth parts', () => {
    const encoded = encodeRefreshToken({ refreshToken: 'rt', authMethod: 'desktop' })
    expect(decodeRefreshToken(encoded)).toEqual({ refreshToken: 'rt', authMethod: 'desktop' })
  })
})
