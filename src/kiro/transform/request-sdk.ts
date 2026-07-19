import { extractRegionFromArn } from '../constants.js'
import { resolveEffectiveEffort } from '../effort.js'
import type { Effort, KiroAuthDetails, SdkPreparedRequest } from '../types.js'
import { buildCodeWhispererRequest } from './request-core.js'

export interface EffortConfig {
  readonly effort?: Effort
  readonly autoEffortMapping?: boolean
}

interface RequestEffortBody {
  readonly reasoning_effort?: unknown
}

function requestReasoningEffort(body: unknown): string | null | undefined {
  const parsed: unknown = typeof body === 'string' ? JSON.parse(body) : body
  if (typeof parsed !== 'object' || parsed === null || !('reasoning_effort' in parsed)) return undefined
  const value = (parsed as RequestEffortBody).reasoning_effort
  return typeof value === 'string' || value === null ? value : undefined
}

export function transformToSdkRequest(
  body: unknown,
  model: string,
  auth: KiroAuthDetails,
  think = false,
  budget = 20_000,
  effortConfig?: EffortConfig
): SdkPreparedRequest {
  const { request, resolved, convId } = buildCodeWhispererRequest(body, model, auth, think, budget)
  const effort = resolveEffectiveEffort({
    model,
    think,
    budget,
    reasoningEffort: requestReasoningEffort(body),
    configEffort: effortConfig?.effort,
    autoEffortMapping: effortConfig?.autoEffortMapping
  })

  return {
    conversationState: request.conversationState,
    ...(request.profileArn ? { profileArn: request.profileArn } : {}),
    streaming: true,
    effectiveModel: resolved,
    conversationId: convId,
    region: extractRegionFromArn(auth.profileArn) ?? auth.region,
    ...(effort ? { effort } : {})
  }
}
