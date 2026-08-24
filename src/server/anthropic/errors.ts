import { randomUUID } from "node:crypto";

export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "request_too_large"
  | "rate_limit_error"
  | "api_error"
  | "overloaded_error";

export function anthropicError(
  status: number,
  message: string,
  type: AnthropicErrorType,
): Response {
  return Response.json(
    {
      type: "error",
      error: { type, message },
      request_id: `req_${randomUUID()}`,
    },
    { status },
  );
}

export function anthropicStreamError(message: string, type: AnthropicErrorType): string {
  return `event: error\ndata: ${JSON.stringify({
    type: "error",
    error: { type, message },
  })}\n\n`;
}
