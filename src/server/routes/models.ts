/**
 * `GET /v1/models` handler.
 *
 * Returns the standard OpenAI models-list envelope, sourced from the
 * frozen T10 model catalog SSOT (`MODEL_CATALOG`).
 */
import { MODEL_CATALOG } from '../../kiro/model-catalog.js'

const CATALOG_CREATED_AT = 1_700_000_000

export function handleModels(): Response {
  const data = MODEL_CATALOG.map((entry) => ({
    id: entry.id,
    object: 'model' as const,
    created: CATALOG_CREATED_AT,
    owned_by: 'kiro',
    name: entry.name,
    context_limit: entry.contextLimit,
    output_limit: entry.outputLimit,
    modalities: entry.modalities
  }))

  return new Response(JSON.stringify({ object: 'list', data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}
