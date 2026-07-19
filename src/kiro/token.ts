import { fetchProxyOption } from '../core/proxy.js'
import { decodeRefreshToken, encodeRefreshToken } from './auth.js'
import { buildUrl, KIRO_CONSTANTS } from './constants.js'
import { KiroTokenRefreshError } from './errors.js'
import type { KiroAuthDetails, RefreshParts } from './types.js'

type JsonObject = Readonly<Record<string, unknown>>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(data: JsonObject, snakeCase: string, camelCase: string): string | undefined {
  const snakeValue = data[snakeCase]
  if (typeof snakeValue === 'string' && snakeValue) return snakeValue
  const camelValue = data[camelCase]
  return typeof camelValue === 'string' && camelValue ? camelValue : undefined
}

function numberValue(data: JsonObject, snakeCase: string, camelCase: string): number | undefined {
  const snakeValue = data[snakeCase]
  if (typeof snakeValue === 'number') return snakeValue
  const camelValue = data[camelCase]
  return typeof camelValue === 'number' ? camelValue : undefined
}

function errorDetails(text: string, status: number): { readonly message: string; readonly code: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { message: text, code: `HTTP_${status}` }
  }
  if (!isJsonObject(parsed)) return { message: text, code: `HTTP_${status}` }

  const message = stringValue(parsed, 'message', 'error_description') ?? text
  const code = stringValue(parsed, '__type', 'error') ?? `HTTP_${status}`
  return { message, code }
}

function responseEmail(data: JsonObject): string | undefined {
  const userInfo = data.userInfo
  if (!isJsonObject(userInfo)) return undefined
  const email = userInfo.email
  return typeof email === 'string' ? email : undefined
}

export async function refreshAccessToken(
  auth: KiroAuthDetails,
  signal?: AbortSignal,
  proxyUrl?: string
): Promise<KiroAuthDetails> {
  const refreshParts = decodeRefreshToken(auth.refresh)
  const isIdc = auth.authMethod === 'idc'
  const refreshRegion = isIdc ? (auth.oidcRegion ?? auth.region) : auth.region
  const url = buildUrl(
    isIdc ? KIRO_CONSTANTS.REFRESH_IDC_URL : KIRO_CONSTANTS.REFRESH_URL,
    refreshRegion
  )

  if (isIdc && (!refreshParts.clientId || !refreshParts.clientSecret)) {
    throw new KiroTokenRefreshError('Missing creds', 'MISSING_CREDENTIALS')
  }

  const requestBody = isIdc
    ? {
        refreshToken: refreshParts.refreshToken,
        clientId: refreshParts.clientId,
        clientSecret: refreshParts.clientSecret,
        grantType: 'refresh_token'
      }
    : { refreshToken: refreshParts.refreshToken }
  const userAgent = isIdc
    ? `aws-sdk-js/${KIRO_CONSTANTS.SDK_VERSION} ua/2.1 os/other lang/js md/browser#unknown_unknown api/sso-oidc#${KIRO_CONSTANTS.SDK_VERSION} m/E ${KIRO_CONSTANTS.USER_AGENT}`
    : `aws-sdk-js/3.0.0 ${KIRO_CONSTANTS.USER_AGENT}-0.1.0 os/macos lang/js md/nodejs/18.0.0`

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'amz-sdk-request': 'attempt=1; max=1',
        'x-amzn-kiro-agent-mode': 'vibe',
        'user-agent': userAgent,
        Connection: 'close'
      },
      body: JSON.stringify(requestBody),
      ...(signal ? { signal } : {}),
      ...fetchProxyOption(proxyUrl)
    })

    if (!response.ok) {
      const details = errorDetails(await response.text(), response.status)
      throw new KiroTokenRefreshError(`Refresh failed: ${details.message}`, details.code)
    }

    const parsed: unknown = await response.json()
    if (!isJsonObject(parsed)) {
      throw new KiroTokenRefreshError('No access token', 'INVALID_RESPONSE')
    }
    const access = stringValue(parsed, 'access_token', 'accessToken')
    if (!access) throw new KiroTokenRefreshError('No access token', 'INVALID_RESPONSE')

    const updatedRefreshParts: RefreshParts = {
      refreshToken:
        stringValue(parsed, 'refresh_token', 'refreshToken') ?? refreshParts.refreshToken,
      authMethod: auth.authMethod,
      ...(refreshParts.clientId ? { clientId: refreshParts.clientId } : {}),
      ...(refreshParts.clientSecret ? { clientSecret: refreshParts.clientSecret } : {})
    }

    return {
      refresh: encodeRefreshToken(updatedRefreshParts),
      access,
      expires:
        Date.now() + (numberValue(parsed, 'expires_in', 'expiresIn') ?? 3_600) * 1_000,
      authMethod: auth.authMethod,
      region: auth.region,
      ...(auth.oidcRegion ? { oidcRegion: auth.oidcRegion } : {}),
      ...(auth.profileArn ? { profileArn: auth.profileArn } : {}),
      ...(auth.clientId ? { clientId: auth.clientId } : {}),
      ...(auth.clientSecret ? { clientSecret: auth.clientSecret } : {}),
      ...(auth.email || responseEmail(parsed) ? { email: auth.email ?? responseEmail(parsed) } : {})
    }
  } catch (error) {
    if (error instanceof KiroTokenRefreshError) throw error
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new KiroTokenRefreshError(
      `Token refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'NETWORK_ERROR',
      error instanceof Error ? error : undefined
    )
  }
}
