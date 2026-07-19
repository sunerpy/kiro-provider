import { openAiError } from "./errors.js"

const BEARER_PREFIX = "Bearer "

export type AuthGateResult = { ok: true } | { ok: false; response: Response }

/**
 * Validates the `Authorization: Bearer <key>` header against the configured
 * api_keys. Missing header, malformed scheme, or a key not present in
 * `apiKeys` all fail closed with a 401 OpenAI-style error envelope.
 */
export function checkApiKey(req: Request, apiKeys: string[]): AuthGateResult {
  const header = req.headers.get("Authorization")

  if (header === null) {
    return {
      ok: false,
      response: openAiError(401, "Missing Authorization header.", "authentication_error", "missing_api_key"),
    }
  }

  if (!header.startsWith(BEARER_PREFIX)) {
    return {
      ok: false,
      response: openAiError(
        401,
        "Authorization header must use the Bearer scheme.",
        "authentication_error",
        "invalid_api_key",
      ),
    }
  }

  const key = header.slice(BEARER_PREFIX.length)

  if (!apiKeys.includes(key)) {
    return {
      ok: false,
      response: openAiError(401, "Incorrect API key provided.", "authentication_error", "invalid_api_key"),
    }
  }

  return { ok: true }
}
