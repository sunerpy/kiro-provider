import { afterEach, describe, expect, test } from 'bun:test'
import { encodeRefreshToken } from '../src/kiro/auth.js'
import { KiroTokenRefreshError } from '../src/kiro/errors.js'
import { refreshAccessToken } from '../src/kiro/token.js'
import type { KiroAuthDetails } from '../src/kiro/types.js'

interface CapturedRequest {
  readonly url: string
  readonly method: string | undefined
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
  readonly signal: AbortSignal | null | undefined
  readonly proxy: unknown
  readonly hasProxy: boolean
}

const realFetch = globalThis.fetch

type FetchMock = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => Promise<Response>

function captureFetch(responder: (request: CapturedRequest) => Response | Promise<Response>): {
  readonly fn: FetchMock
  readonly calls: CapturedRequest[]
} {
  const calls: CapturedRequest[] = []
  const fn: FetchMock = async (input, init) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })
    const request: CapturedRequest = {
      url:
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input instanceof Request
              ? input.url
              : String(input),
      method: init?.method,
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      signal: init?.signal,
      proxy: init !== undefined && 'proxy' in init ? init.proxy : undefined,
      hasProxy: Object.hasOwn(init ?? {}, 'proxy')
    }
    calls.push(request)
    return responder(request)
  }
  return { fn, calls }
}

function idcAuth(overrides: Partial<KiroAuthDetails> = {}): KiroAuthDetails {
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
    region: 'us-east-1',
    oidcRegion: 'eu-west-1',
    ...overrides
  }
}

function desktopAuth(overrides: Partial<KiroAuthDetails> = {}): KiroAuthDetails {
  return {
    refresh: encodeRefreshToken({
      refreshToken: 'desktop-refresh-token',
      authMethod: 'desktop'
    }),
    access: 'old-access',
    expires: Date.now(),
    authMethod: 'desktop',
    region: 'us-west-2',
    ...overrides
  }
}

describe('refreshAccessToken', () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('refreshes IDC auth using oidcRegion and required headers without a proxy by default', async () => {
    const { fn, calls } = captureFetch(
      () =>
        new Response(
          JSON.stringify({
            access_token: 'new-idc-access',
            refresh_token: 'rotated-refresh',
            expires_in: 1_800
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    )
    globalThis.fetch = fn as unknown as typeof fetch

    const result = await refreshAccessToken(idcAuth())

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://oidc.eu-west-1.amazonaws.com/token')
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.body).toEqual({
      refreshToken: 'idc-refresh-token',
      clientId: 'client-abc',
      clientSecret: 'secret-xyz',
      grantType: 'refresh_token'
    })
    expect(calls[0]?.headers['user-agent']).toContain('KiroIDE')
    expect(calls[0]?.headers['x-amzn-kiro-agent-mode']).toBe('vibe')
    expect(calls[0]?.headers['content-type']).toBe('application/json')
    expect(calls[0]?.hasProxy).toBe(false)
    expect(result.access).toBe('new-idc-access')
    expect(result.expires).toBeGreaterThan(Date.now() + 1_700_000)
    expect(result.expires).toBeLessThanOrEqual(Date.now() + 1_800_000)
    expect(result.refresh).toBe('rotated-refresh|client-abc|secret-xyz|idc')
  })

  test('falls back to auth.region for IDC when oidcRegion is absent', async () => {
    const { fn, calls } = captureFetch(
      () =>
        new Response(JSON.stringify({ accessToken: 'access', refreshToken: 'refresh' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
    )
    globalThis.fetch = fn as unknown as typeof fetch
    const auth = idcAuth({ region: 'ap-southeast-1' })
    delete auth.oidcRegion

    await refreshAccessToken(auth)

    expect(calls[0]?.url).toBe('https://oidc.ap-southeast-1.amazonaws.com/token')
  })

  test('rejects IDC auth without credentials before fetch', async () => {
    const { fn, calls } = captureFetch(() => new Response('{}', { status: 200 }))
    globalThis.fetch = fn as unknown as typeof fetch

    await expect(refreshAccessToken(desktopAuth({ authMethod: 'idc' }))).rejects.toMatchObject({
      name: 'KiroTokenRefreshError',
      code: 'MISSING_CREDENTIALS'
    })
    expect(calls).toHaveLength(0)
  })

  test('refreshes desktop auth using auth.region rather than profile ARN through a proxy', async () => {
    const { fn, calls } = captureFetch(
      () =>
        new Response(JSON.stringify({ accessToken: 'new-desktop-access', expiresIn: 3_600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
    )
    globalThis.fetch = fn as unknown as typeof fetch

    const result = await refreshAccessToken(
      desktopAuth({ profileArn: 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/test' }),
      undefined,
      'http://p:1080'
    )

    expect(calls[0]?.url).toBe('https://prod.us-west-2.auth.desktop.kiro.dev/refreshToken')
    expect(calls[0]?.body).toEqual({ refreshToken: 'desktop-refresh-token' })
    expect(calls[0]?.headers['user-agent']).toContain('KiroIDE')
    expect(calls[0]?.headers['x-amzn-kiro-agent-mode']).toBe('vibe')
    expect(calls[0]?.proxy).toBe('http://p:1080')
    expect(result.access).toBe('new-desktop-access')
    expect(result.refresh).toBe('desktop-refresh-token|desktop')
  })

  test('throws the service error code for a non-success JSON response', async () => {
    const { fn } = captureFetch(
      () =>
        new Response(JSON.stringify({ message: 'Invalid grant', __type: 'InvalidGrantException' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        })
    )
    globalThis.fetch = fn as unknown as typeof fetch

    const error = await refreshAccessToken(idcAuth()).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(KiroTokenRefreshError)
    expect(error).toMatchObject({ code: 'InvalidGrantException' })
    expect(error).toHaveProperty('message', 'Refresh failed: Invalid grant')
  })

  test('throws an HTTP status code for a non-JSON error response', async () => {
    const { fn } = captureFetch(() => new Response('gateway boom', { status: 502 }))
    globalThis.fetch = fn as unknown as typeof fetch

    const error = await refreshAccessToken(desktopAuth()).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(KiroTokenRefreshError)
    expect(error).toMatchObject({ code: 'HTTP_502' })
    expect(error).toHaveProperty('message', 'Refresh failed: gateway boom')
  })

  test('rejects a successful response without an access token', async () => {
    const { fn } = captureFetch(
      () =>
        new Response(JSON.stringify({ refresh_token: 'refresh' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
    )
    globalThis.fetch = fn as unknown as typeof fetch

    await expect(refreshAccessToken(idcAuth())).rejects.toMatchObject({
      name: 'KiroTokenRefreshError',
      code: 'INVALID_RESPONSE'
    })
  })

  test('wraps a network failure and preserves the original error', async () => {
    const networkError = new Error('socket hang up')
    const fn: FetchMock = async () => {
      throw networkError
    }
    globalThis.fetch = fn as unknown as typeof fetch

    const error = await refreshAccessToken(desktopAuth()).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(KiroTokenRefreshError)
    expect(error).toMatchObject({ code: 'NETWORK_ERROR', originalError: networkError })
  })

  test('passes AbortSignal and proxy to fetch together and surfaces its AbortError', async () => {
    const controller = new AbortController()
    const abortError = new DOMException('The operation was aborted', 'AbortError')
    const { fn, calls } = captureFetch(async (request) => {
      expect(request.signal).toBe(controller.signal)
      controller.abort()
      throw abortError
    })
    globalThis.fetch = fn as unknown as typeof fetch

    await expect(
      refreshAccessToken(desktopAuth(), controller.signal, 'http://p:1080')
    ).rejects.toBe(abortError)
    expect(calls[0]?.signal).toBe(controller.signal)
    expect(calls[0]?.proxy).toBe('http://p:1080')
  })
})
