import { resolveModelVariant } from './models.js'
import type { Effort } from './types.js'

/**
 * Effort levels ordered from lowest to highest reasoning depth.
 */
export const EFFORT_LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'] as const

function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && EFFORT_LEVELS.some((effort) => effort === value)
}

/**
 * OpenAI GPT models (Kiro proxies these via Mantle). They accept the effort enum
 * through a DIFFERENT wire field than Claude — see buildEffortRequestFields.
 * All five levels (incl. xhigh/max) are probe-confirmed: credit usage scales
 * monotonically low<medium<high<xhigh<max (.omo/evidence/task-gpt56-effort-probe.txt).
 */
const GPT_REASONING_MODELS = new Set(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])

/**
 * Models that support the 5-value effort enum (including xhigh).
 * These models support up to 128k thinking tokens with max effort.
 */
const XHIGH_CAPABLE_MODELS = new Set([
  'claude-opus-4.7',
  'claude-opus-4.8',
  'claude-sonnet-5',
  ...GPT_REASONING_MODELS
])

/**
 * Models that support the 4-value effort enum (no xhigh).
 * xhigh requests on these models are clamped to max.
 */
const EFFORT_CAPABLE_MODELS = new Set([
  'claude-opus-4.5',
  'claude-opus-4.6',
  'claude-opus-4.6-1m',
  'claude-sonnet-4.5',
  'claude-sonnet-4.5-1m',
  'claude-sonnet-4.6',
  'claude-sonnet-4.6-1m',
  ...XHIGH_CAPABLE_MODELS
])

/**
 * Check if a model supports the effort parameter.
 */
export function supportsEffort(kiroModel: string): boolean {
  return EFFORT_CAPABLE_MODELS.has(kiroModel)
}

/**
 * Check if a model supports xhigh effort level.
 */
export function supportsXHighEffort(kiroModel: string): boolean {
  return XHIGH_CAPABLE_MODELS.has(kiroModel)
}

/**
 * Build the additionalModelRequestFields payload carrying the effort level.
 *
 * GPT and Claude take effort through different, mutually-exclusive wire fields
 * (each rejects the other's with HTTP 400, probe-confirmed):
 * - GPT (Mantle):  `reasoning.effort`
 * - Claude:        `output_config.effort`
 */
export function buildEffortRequestFields(
  kiroModel: string,
  effort: Effort
): Record<string, unknown> {
  if (GPT_REASONING_MODELS.has(kiroModel)) {
    return { reasoning: { effort } }
  }
  return { output_config: { effort } }
}

/**
 * Resolve effort level for a given model.
 * - Returns undefined if model doesn't support effort
 * - Clamps xhigh to max for models that don't support it
 */
export function resolveEffort(kiroModel: string, requested: Effort): Effort | undefined {
  if (!supportsEffort(kiroModel)) {
    return undefined
  }

  // xhigh is only supported on opus-4.7 and opus-4.8
  if (requested === 'xhigh' && !supportsXHighEffort(kiroModel)) {
    return 'max'
  }

  return requested
}

/**
 * Map OpenCode thinking budget to Kiro effort level.
 *
 * OpenCode sends thinkingBudget from its variant config. Standard values:
 * - low:    8192
 * - medium: 16384
 * - high:   24576
 * - max:    32768
 *
 * We map these ranges to Kiro effort levels:
 * - ≤10000  → low
 * - ≤20000  → medium
 * - ≤28000  → high
 * - ≤32768  → max (or xhigh on opus-4.7/4.8, max otherwise)
 * - >32768  → max
 */
export function budgetToEffort(budget: number, kiroModel: string): Effort | undefined {
  if (!supportsEffort(kiroModel)) {
    return undefined
  }

  let effort: Effort
  if (budget <= 10000) {
    effort = 'low'
  } else if (budget <= 20000) {
    effort = 'medium'
  } else if (budget <= 28000) {
    effort = 'high'
  } else {
    effort = 'max'
  }

  return effort
}

export interface EffectiveEffortOptions {
  readonly model: string
  readonly think: boolean
  readonly budget: number
  readonly reasoningEffort?: string | null | undefined
  readonly configEffort?: string | null | undefined
  readonly autoEffortMapping?: boolean | undefined
}

/**
 * Resolve the single effective effort for a public model id or resolved wire id.
 *
 * Precedence: model variant, request reasoning_effort, global config effort,
 * automatic budget mapping, then the thinking-only medium fallback.
 *
 * Invalid explicit values are skipped here so internal/programmatic callers can
 * fall through to the next level. HTTP input is a separate trust boundary: T18
 * rejects an invalid reasoning_effort with 400 before this resolver is called.
 */
export function resolveEffectiveEffort(options: EffectiveEffortOptions): Effort | undefined {
  let resolved: ReturnType<typeof resolveModelVariant>
  if (supportsEffort(options.model)) {
    resolved = { wireId: options.model, effort: undefined }
  } else {
    try {
      resolved = resolveModelVariant(options.model)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Unsupported model:')) {
        return undefined
      }
      throw error
    }
  }

  if (!supportsEffort(resolved.wireId)) {
    return undefined
  }

  const explicitEfforts = [
    resolved.effort,
    options.reasoningEffort,
    options.configEffort
  ] as const
  for (const effort of explicitEfforts) {
    if (isEffort(effort)) {
      return resolveEffort(resolved.wireId, effort)
    }
  }

  if (!options.think) {
    return undefined
  }

  if (options.autoEffortMapping ?? true) {
    return budgetToEffort(options.budget, resolved.wireId)
  }

  return 'medium'
}

/**
 * Backward-compatible T4 API. New request paths use resolveEffectiveEffort so
 * variant and request-level precedence cannot be bypassed.
 */
export function getEffectiveEffort(
  kiroModel: string,
  thinking: boolean,
  budget: number,
  configEffort?: Effort,
  autoEffortMapping = true
): Effort | undefined {
  return resolveEffectiveEffort({
    model: kiroModel,
    think: thinking,
    budget,
    configEffort,
    autoEffortMapping
  })
}
