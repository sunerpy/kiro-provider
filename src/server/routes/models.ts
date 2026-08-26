/**
 * `GET /v1/models` handler.
 *
 * Returns both the standard OpenAI models-list envelope and the provider-owned
 * Codex model catalog envelope. Both are sourced from the frozen T10 model
 * catalog SSOT (`MODEL_CATALOG`).
 */
import { supportsEffort, supportsXHighEffort } from '../../kiro/effort.js'
import { MODEL_CATALOG, type ModelCatalogEntry } from '../../kiro/model-catalog.js'

const CATALOG_CREATED_AT = 1_700_000_000
const REASONING_SUFFIX = /-(low|medium|high|xhigh|max)$/

type CodexReasoningLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

function codexReasoningLevels(wireId: string): Array<{
  readonly effort: CodexReasoningLevel
  readonly description: string
}> {
  if (!supportsEffort(wireId)) return []
  const efforts: readonly CodexReasoningLevel[] = supportsXHighEffort(wireId)
    ? ['low', 'medium', 'high', 'xhigh', 'max']
    : ['low', 'medium', 'high', 'max']
  return efforts.map((effort) => ({
    effort,
    description: `${effort} reasoning effort`
  }))
}

function codexDefaultReasoningLevel(entry: ModelCatalogEntry): CodexReasoningLevel | null {
  if (!supportsEffort(entry.wireId)) return null
  const suffix = REASONING_SUFFIX.exec(entry.id)?.[1]
  if (suffix === 'low' || suffix === 'medium' || suffix === 'high' || suffix === 'xhigh' || suffix === 'max') {
    return suffix
  }
  return 'medium'
}

function codexInputModalities(entry: ModelCatalogEntry): Array<'text' | 'image'> {
  return entry.modalities.input.includes('image') ? ['text', 'image'] : ['text']
}

function codexModel(entry: ModelCatalogEntry, index: number): Readonly<Record<string, unknown>> {
  return {
    slug: entry.id,
    display_name: entry.name,
    description: null,
    default_reasoning_level: codexDefaultReasoningLevel(entry),
    supported_reasoning_levels: codexReasoningLevels(entry.wireId),
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority: MODEL_CATALOG.length - index,
    upgrade: null,
    // The provider never injects or owns a hidden client prompt.
    base_instructions: '',
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    supports_reasoning_summary_parameter: false,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    web_search_tool_type: null,
    truncation_policy: { mode: 'tokens', limit: entry.contextLimit },
    supports_image_detail_original: false,
    context_window: entry.contextLimit,
    max_context_window: entry.contextLimit,
    auto_compact_token_limit: Math.floor(entry.contextLimit * 0.9),
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: codexInputModalities(entry),
    supports_search_tool: false,
    use_responses_lite: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: false
  }
}

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
  const models = MODEL_CATALOG.map(codexModel)

  return new Response(JSON.stringify({ object: 'list', data, models }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}
