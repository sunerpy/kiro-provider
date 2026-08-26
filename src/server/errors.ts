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
  }
  if (code !== undefined) {
    error.code = code
  }
  if (param !== undefined) {
    error.param = param
  }
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}
