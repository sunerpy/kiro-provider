/**
 * `GET /health` handler.
 *
 * Simple liveness probe returning `{ status: "ok" }`.
 */
export function handleHealth(): Response {
  return new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}
