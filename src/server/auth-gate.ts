import { createHash, timingSafeEqual } from "node:crypto"
import { openAiError } from "./errors.js"

const BEARER_PREFIX = "Bearer "

export type AuthGateResult =
  | { ok: true; tenantId: string }
  | { ok: false; response: Response }
export type AuthErrorFactory = (
  status: number,
  message: string,
  type: string,
  code?: string,
) => Response

function matchingApiKey(candidate: string, apiKeys: readonly string[]): string | undefined {
  const candidateBuffer = Buffer.from(candidate)
  for (const apiKey of apiKeys) {
    const configuredBuffer = Buffer.from(apiKey)
    if (
      candidateBuffer.byteLength === configuredBuffer.byteLength &&
      timingSafeEqual(candidateBuffer, configuredBuffer)
    ) {
      return apiKey
    }
  }
  return undefined
}

function tenantId(apiKey: string): string {
  return createHash("sha256")
    .update("kiro-provider-tenant-v1\0")
    .update(apiKey)
    .digest("hex")
}

/**
 * Validates either `Authorization: Bearer <key>` or `x-api-key: <key>` against
 * the configured api_keys. Authorization takes precedence when both headers
 * are present so a malformed explicit Bearer header cannot be bypassed.
 */
export function checkApiKey(
  req: Request,
  apiKeys: string[],
  makeError: AuthErrorFactory = openAiError,
): AuthGateResult {
  const header = req.headers.get("Authorization")

  if (header === null) {
    const apiKey = req.headers.get("x-api-key")
    const matched = apiKey === null ? undefined : matchingApiKey(apiKey, apiKeys)
    if (matched !== undefined) {
      return { ok: true, tenantId: tenantId(matched) }
    }
    return {
      ok: false,
      response: makeError(
        401,
        "Missing Authorization or x-api-key header.",
        "authentication_error",
        "missing_api_key",
      ),
    }
  }

  if (!header.startsWith(BEARER_PREFIX)) {
    return {
      ok: false,
      response: makeError(
        401,
        "Authorization header must use the Bearer scheme.",
        "authentication_error",
        "invalid_api_key",
      ),
    }
  }

  const key = header.slice(BEARER_PREFIX.length)

  const matched = matchingApiKey(key, apiKeys)
  if (matched === undefined) {
    return {
      ok: false,
      response: makeError(
        401,
        "Incorrect API key provided.",
        "authentication_error",
        "invalid_api_key",
      ),
    }
  }

  return { ok: true, tenantId: tenantId(matched) }
}
