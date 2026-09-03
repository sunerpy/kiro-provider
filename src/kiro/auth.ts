import { KiroTokenRefreshError } from "./errors.js";
import type { KiroAuthDetails, RefreshParts } from "./types.js";

export function decodeRefreshToken(refresh: string): RefreshParts {
  const parts = refresh.split("|");
  const refreshToken = parts[0] ?? "";
  if (parts.length < 2) return { refreshToken, authMethod: "desktop" };

  const authMethod = parts.at(-1);
  if (authMethod === "idc") {
    return {
      refreshToken,
      clientId: parts[1],
      clientSecret: parts[2],
      authMethod: "idc",
    };
  }
  return { refreshToken, authMethod: "desktop" };
}

export function accessTokenExpired(auth: KiroAuthDetails, bufferMs = 120_000): boolean {
  if (!auth.access || !auth.expires) return true;
  return Date.now() >= auth.expires - bufferMs;
}

/**
 * Serializes the refresh parts. An IdC login without its client id or secret
 * can never refresh, so the failure is a typed `MISSING_CREDENTIALS`
 * KiroTokenRefreshError: health.ts classifies it as refresh-token-dead and the
 * refresher / pipeline mark the account needs-relogin instead of surfacing an
 * opaque 500.
 */
export function encodeRefreshToken(parts: RefreshParts): string {
  if (parts.authMethod === "idc") {
    if (!parts.clientId || !parts.clientSecret) {
      throw new KiroTokenRefreshError("Missing credentials", "MISSING_CREDENTIALS");
    }
    return `${parts.refreshToken}|${parts.clientId}|${parts.clientSecret}|idc`;
  }
  return `${parts.refreshToken}|desktop`;
}
