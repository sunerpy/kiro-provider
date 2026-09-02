import { randomUUID } from "node:crypto";

/**
 * Shared OpenAI-style error envelope helper for HTTP responses.
 *
 * Shape: `{ error: { message, type, code? } }`
 */
export function openAiError(
  status: number,
  message: string,
  type: string,
  code?: string,
  param?: string,
): Response {
  const error: { message: string; type: string; code?: string; param?: string } = {
    message,
    type,
  };
  if (code !== undefined) {
    error.code = code;
  }
  if (param !== undefined) {
    error.param = param;
  }
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const INTERNAL_ERROR_MESSAGE = "Internal server error";

/** Correlation id shared by the client-facing envelope and the audit log entry. */
export function newRequestId(): string {
  return `req_${randomUUID()}`;
}

function internalErrorMessage(requestId: string): string {
  return `${INTERNAL_ERROR_MESSAGE} (request_id: ${requestId})`;
}

/**
 * Fixed-text OpenAI-style 500 envelope. Raw exception prose (SQLite paths,
 * account ids, upstream bodies) never reaches the client; operators correlate
 * through `request_id` in the audit log instead.
 */
export function openAiInternalError(requestId: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: internalErrorMessage(requestId),
        type: "internal_error",
        code: "internal_error",
        request_id: requestId,
      },
    }),
    { status: 500, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Fixed-text Anthropic-style 500 envelope carrying the same correlation id.
 * Built here rather than through `anthropicError` so the envelope's
 * `request_id` matches the audit log instead of a fresh random id.
 */
export function anthropicInternalError(requestId: string): Response {
  return Response.json(
    {
      type: "error",
      error: { type: "api_error", message: internalErrorMessage(requestId) },
      request_id: requestId,
    },
    { status: 500 },
  );
}
