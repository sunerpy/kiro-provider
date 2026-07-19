/**
 * Shared OpenAI-style error envelope helper for HTTP responses.
 *
 * Shape: `{ error: { message, type, code? } }`
 */
export function openAiError(status: number, message: string, type: string, code?: string): Response {
  const error: { message: string; type: string; code?: string } = { message, type }
  if (code !== undefined) {
    error.code = code
  }
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}
