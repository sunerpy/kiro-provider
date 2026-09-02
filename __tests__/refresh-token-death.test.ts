import { afterEach, describe, expect, test } from 'bun:test'
import { encodeRefreshToken } from '../src/kiro/auth.js'
import { KiroTokenRefreshError } from '../src/kiro/errors.js'
import { isPermanentError, isRefreshTokenDead, toDeadReason } from '../src/kiro/health.js'
import { refreshAccessToken } from '../src/kiro/token.js'
import type { KiroAuthDetails } from '../src/kiro/types.js'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function idcAuth(): KiroAuthDetails {
  return {
    refresh: encodeRefreshToken({
      refreshToken: 'idc-refresh-token',
      clientId: 'client-abc',
      clientSecret: 'secret-xyz',
      authMethod: 'idc'
    }),
    access: 'old-access',
    expires: Date.now(),
    authMethod: 'idc',
    region: 'us-east-1'
  }
}

function respondWith(body: string, status: number, contentType?: string): void {
  globalThis.fetch = (async () =>
    new Response(body, {
      status,
      ...(contentType ? { headers: { 'Content-Type': contentType } } : {})
    })) as unknown as typeof fetch
}

/** Mirrors how account-maintenance / quota-rechecker build the stored reason. */
function reasonFor(error: unknown): string {
  if (!(error instanceof KiroTokenRefreshError)) throw error
  return error.code ? `${error.code}: ${error.message}` : error.message
}

describe('isRefreshTokenDead', () => {
  test('ignores bare HTTP status markers produced from non-JSON bodies', () => {
    expect(isRefreshTokenDead('HTTP_403: <html><body>Forbidden by proxy</body></html>')).toBe(false)
    expect(isRefreshTokenDead('HTTP_401: Refresh failed: ')).toBe(false)
    expect(isRefreshTokenDead('HTTP_502: Refresh failed: gateway boom')).toBe(false)
    expect(isPermanentError('HTTP_403: access denied')).toBe(false)
  })

  test('recognizes structured OIDC and Kiro permanent codes', () => {
    for (const reason of [
      'invalid_grant: Refresh failed: Invalid refresh token provided',
      'invalid_client: Refresh failed: client registration expired',
      'unauthorized_client: Refresh failed',
      'InvalidGrantException: Refresh failed: Invalid grant',
      'InvalidClientException: Refresh failed',
      'UnauthorizedClientException: Refresh failed',
      'ExpiredTokenException: Refresh failed',
      'InvalidTokenException: Refresh failed',
      'ExpiredClientException: Refresh failed',
      'HTTP_400: Refresh failed: Invalid refresh token',
      'HTTP_400: Refresh failed: Invalid grant provided',
      'HTTP_400: Refresh failed: Client is expired'
    ]) {
      expect(isRefreshTokenDead(reason)).toBe(true)
      expect(isPermanentError(reason)).toBe(true)
    }
  })

  test('treats unknown structured codes and transport failures as transient', () => {
    expect(isRefreshTokenDead('AccessDeniedException: Refresh failed: denied')).toBe(false)
    expect(isRefreshTokenDead('NETWORK_ERROR: Token refresh failed: socket hang up')).toBe(false)
    expect(isRefreshTokenDead('SlowDownException: Refresh failed')).toBe(false)
    expect(isRefreshTokenDead(undefined)).toBe(false)
    expect(isRefreshTokenDead('')).toBe(false)
  })

  test('toDeadReason still converts an explicit transient reason into a stored permanent one', () => {
    const stored = toDeadReason('HTTP_403: <html>Forbidden</html>')
    expect(stored).toBe('InvalidTokenException: HTTP_403: <html>Forbidden</html>')
    expect(isRefreshTokenDead(stored)).toBe(true)
  })
})

describe('refreshAccessToken failure classification end to end', () => {
  test('an HTML 403 from a proxy yields a transient HTTP_403 reason', async () => {
    respondWith('<html><body><h1>403 Forbidden</h1></body></html>', 403, 'text/html')

    const error = await refreshAccessToken(idcAuth()).catch((cause: unknown) => cause)

    expect(error).toMatchObject({ name: 'KiroTokenRefreshError', code: 'HTTP_403' })
    expect(isRefreshTokenDead(reasonFor(error))).toBe(false)
  })

  test('a JSON 403 without a service code is also transient', async () => {
    respondWith(JSON.stringify({ message: 'Forbidden' }), 403, 'application/json')

    const error = await refreshAccessToken(idcAuth()).catch((cause: unknown) => cause)

    expect(error).toMatchObject({ code: 'HTTP_403', message: 'Refresh failed: Forbidden' })
    expect(isRefreshTokenDead(reasonFor(error))).toBe(false)
  })

  test('an OIDC invalid_grant body marks the refresh token dead', async () => {
    respondWith(
      JSON.stringify({
        error: 'invalid_grant',
        error_description: 'Invalid refresh token provided'
      }),
      400,
      'application/json'
    )

    const error = await refreshAccessToken(idcAuth()).catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      code: 'invalid_grant',
      message: 'Refresh failed: Invalid refresh token provided'
    })
    expect(isRefreshTokenDead(reasonFor(error))).toBe(true)
  })

  test('an AWS JSON __type exception marks the refresh token dead', async () => {
    respondWith(
      JSON.stringify({ __type: 'ExpiredTokenException', message: 'Token expired' }),
      401,
      'application/x-amz-json-1.1'
    )

    const error = await refreshAccessToken(idcAuth()).catch((cause: unknown) => cause)

    expect(error).toMatchObject({ code: 'ExpiredTokenException' })
    expect(isRefreshTokenDead(reasonFor(error))).toBe(true)
  })
})
