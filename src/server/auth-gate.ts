import { createHash, timingSafeEqual } from "node:crypto";
import { openAiError } from "./errors.js";

const BEARER_SCHEME = "bearer ";

export type AuthGateResult = { ok: true; tenantId: string } | { ok: false; response: Response };
export type AuthErrorFactory = (
  status: number,
  message: string,
  type: string,
  code?: string,
) => Response;

function matchingApiKey(candidate: string, apiKeys: readonly string[]): string | undefined {
  const candidateBuffer = Buffer.from(candidate);
  for (const apiKey of apiKeys) {
    const configuredBuffer = Buffer.from(apiKey);
    if (
      candidateBuffer.byteLength === configuredBuffer.byteLength &&
      timingSafeEqual(candidateBuffer, configuredBuffer)
    ) {
      return apiKey;
    }
  }
  return undefined;
}

function tenantId(apiKey: string): string {
  return createHash("sha256").update("kiro-provider-tenant-v1\0").update(apiKey).digest("hex");
}

/** RFC 7235 auth-scheme tokens are case-insensitive. */
function hasBearerScheme(header: string): boolean {
  return header.slice(0, BEARER_SCHEME.length).toLowerCase() === BEARER_SCHEME;
}

function unauthorized(makeError: AuthErrorFactory, message: string, code: string): Response {
  const response = makeError(401, message, "authentication_error", code);
  try {
    response.headers.set("WWW-Authenticate", "Bearer");
  } catch {
    // A factory returning immutable headers still yields the correct envelope.
  }
  return response;
}

/**
 * Validates either `Authorization: Bearer <key>` or `x-api-key: <key>` against
 * the configured api_keys. Authorization takes precedence when both headers
 * are present so a malformed explicit Bearer header cannot be bypassed.
 * `x-api-key` is accepted on every route so Anthropic-style clients can reach
 * the OpenAI-compatible surfaces with the same credential.
 */
export function checkApiKey(
  req: Request,
  apiKeys: string[],
  makeError: AuthErrorFactory = openAiError,
): AuthGateResult {
  const header = req.headers.get("Authorization");

  if (header === null) {
    const apiKey = req.headers.get("x-api-key");
    const matched = apiKey === null ? undefined : matchingApiKey(apiKey, apiKeys);
    if (matched !== undefined) {
      return { ok: true, tenantId: tenantId(matched) };
    }
    return {
      ok: false,
      response: unauthorized(
        makeError,
        "Missing Authorization or x-api-key header.",
        "missing_api_key",
      ),
    };
  }

  if (!hasBearerScheme(header)) {
    return {
      ok: false,
      response: unauthorized(
        makeError,
        "Authorization header must use the Bearer scheme.",
        "invalid_api_key",
      ),
    };
  }

  const key = header.slice(BEARER_SCHEME.length);

  const matched = matchingApiKey(key, apiKeys);
  if (matched === undefined) {
    return {
      ok: false,
      response: unauthorized(makeError, "Incorrect API key provided.", "invalid_api_key"),
    };
  }

  return { ok: true, tenantId: tenantId(matched) };
}
