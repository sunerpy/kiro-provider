import type { KiroAuthDetails, RefreshParts } from './types.js'

export function decodeRefreshToken(refresh: string): RefreshParts {
  const parts = refresh.split('|')
  const refreshToken = parts[0] ?? ''
  if (parts.length < 2) return { refreshToken, authMethod: 'desktop' }

  const authMethod = parts.at(-1)
  if (authMethod === 'idc') {
    return {
      refreshToken,
      clientId: parts[1],
      clientSecret: parts[2],
      authMethod: 'idc'
    }
  }
  return { refreshToken, authMethod: 'desktop' }
}

export function accessTokenExpired(auth: KiroAuthDetails, bufferMs = 120_000): boolean {
  if (!auth.access || !auth.expires) return true
  return Date.now() >= auth.expires - bufferMs
}

export function encodeRefreshToken(parts: RefreshParts): string {
  if (parts.authMethod === 'idc') {
    if (!parts.clientId || !parts.clientSecret) throw new Error('Missing credentials')
    return `${parts.refreshToken}|${parts.clientId}|${parts.clientSecret}|idc`
  }
  return `${parts.refreshToken}|desktop`
}
