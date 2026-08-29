import { getModelContextLimit } from './constants.js'
import type { KiroAvailableModel } from './management-client.js'

export type InputModality = 'text' | 'image' | 'pdf'
type OutputModality = 'text'

export type ModelCatalogEntry = {
  readonly id: string
  readonly wireId: string
  readonly name: string
  readonly description?: string
  readonly contextLimit: number
  readonly outputLimit: number
  readonly rateMultiplier?: number
  readonly additionalModelRequestFieldsSchema?: Readonly<Record<string, unknown>>
  readonly modalities: {
    readonly input: readonly InputModality[]
    readonly output: readonly OutputModality[]
  }
}

const TEXT_MODALITIES = Object.freeze({
  input: Object.freeze(['text'] as const),
  output: Object.freeze(['text'] as const)
})
const IMAGE_MODALITIES = Object.freeze({
  input: Object.freeze(['text', 'image'] as const),
  output: Object.freeze(['text'] as const)
})
const PDF_MODALITIES = Object.freeze({
  input: Object.freeze(['text', 'image', 'pdf'] as const),
  output: Object.freeze(['text'] as const)
})

export const EXPECTED_PUBLIC_MODEL_IDS = Object.freeze([
  'auto',
  'claude-sonnet-4',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-6-low',
  'claude-sonnet-4-6-medium',
  'claude-sonnet-4-6-high',
  'claude-sonnet-4-6-max',
  'claude-sonnet-5',
  'claude-sonnet-5-low',
  'claude-sonnet-5-medium',
  'claude-sonnet-5-high',
  'claude-sonnet-5-xhigh',
  'claude-sonnet-5-max',
  'claude-haiku-4-5',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-7-low',
  'claude-opus-4-7-medium',
  'claude-opus-4-7-high',
  'claude-opus-4-7-xhigh',
  'claude-opus-4-7-max',
  'claude-opus-4-8',
  'claude-opus-4-8-low',
  'claude-opus-4-8-medium',
  'claude-opus-4-8-high',
  'claude-opus-4-8-xhigh',
  'claude-opus-4-8-max',
  'claude-opus-4-8-thinking',
  'claude-opus-5',
  'claude-opus-5-low',
  'claude-opus-5-medium',
  'claude-opus-5-high',
  'claude-opus-5-xhigh',
  'claude-opus-5-max',
  'deepseek-3.2',
  'glm-5',
  'minimax-m2.5',
  'minimax-m2.1',
  'qwen3-coder-next',
  'gpt-5.6-sol',
  'gpt-5.6-sol-low',
  'gpt-5.6-sol-medium',
  'gpt-5.6-sol-high',
  'gpt-5.6-sol-xhigh',
  'gpt-5.6-sol-max',
  'gpt-5.6-terra',
  'gpt-5.6-terra-low',
  'gpt-5.6-terra-medium',
  'gpt-5.6-terra-high',
  'gpt-5.6-terra-xhigh',
  'gpt-5.6-terra-max',
  'gpt-5.6-luna',
  'gpt-5.6-luna-low',
  'gpt-5.6-luna-medium',
  'gpt-5.6-luna-high',
  'gpt-5.6-luna-xhigh',
  'gpt-5.6-luna-max'
] as const)

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = Object.freeze([
  { id: 'auto', wireId: 'auto', name: 'Auto (1.0x)', contextLimit: getModelContextLimit('auto'), outputLimit: 64000, modalities: PDF_MODALITIES },
  { id: 'claude-sonnet-4', wireId: 'claude-sonnet-4', name: 'Claude Sonnet 4.0 (1.3x)', contextLimit: getModelContextLimit('claude-sonnet-4'), outputLimit: 64000, modalities: PDF_MODALITIES },
  { id: 'claude-sonnet-4-5', wireId: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5 (1.3x)', contextLimit: getModelContextLimit('claude-sonnet-4-5'), outputLimit: 64000, modalities: PDF_MODALITIES },
  { id: 'claude-sonnet-4-6', wireId: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6 (1.3x)', contextLimit: getModelContextLimit('claude-sonnet-4-6'), outputLimit: 64000, modalities: PDF_MODALITIES },
  { id: 'claude-sonnet-4-6-low', wireId: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6 (low) (1.3x)', contextLimit: getModelContextLimit('claude-sonnet-4-6'), outputLimit: 64000, modalities: PDF_MODALITIES },
  { id: 'claude-sonnet-4-6-medium', wireId: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6 (medium) (1.3x)', contextLimit: getModelContextLimit('claude-sonnet-4-6'), outputLimit: 64000, modalities: PDF_MODALITIES },
  { id: 'claude-sonnet-4-6-high', wireId: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6 (high) (1.3x)', contextLimit: getModelContextLimit('claude-sonnet-4-6'), outputLimit: 64000, modalities: PDF_MODALITIES },
  { id: 'claude-sonnet-4-6-max', wireId: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6 (max) (1.3x)', contextLimit: getModelContextLimit('claude-sonnet-4-6'), outputLimit: 64000, modalities: PDF_MODALITIES },
  { id: 'claude-sonnet-5', wireId: 'claude-sonnet-5', name: 'Claude Sonnet 5 (1.3x)', contextLimit: getModelContextLimit('claude-sonnet-5'), outputLimit: 64000, modalities: PDF_MODALITIES },
  { id: 'claude-sonnet-5-low', wireId: 'claude-sonnet-5', name: 'Claude Sonnet 5 (low) (1.3x)', contextLimit: getModelContextLimit('claude-sonnet-5'), outputLimit: 64000, modalities: PDF_MODALITIES },
  { id: 'claude-sonnet-5-medium', wireId: 'claude-sonnet-5', name: 'Claude Sonnet 5 (medium) (1.3x)', contextLimit: getModelContextLimit('claude-sonnet-5'), outputLimit: 64000, modalities: PDF_MODALITIES },
  { id: 'claude-sonnet-5-high', wireId: 'claude-sonnet-5', name: 'Claude Sonnet 5 (high) (1.3x)', contextLimit: getModelContextLimit('claude-sonnet-5'), outputLimit: 64000, modalities: PDF_MODALITIES },
  { id: 'claude-sonnet-5-xhigh', wireId: 'claude-sonnet-5', name: 'Claude Sonnet 5 (xhigh) (1.3x)', contextLimit: getModelContextLimit('claude-sonnet-5'), outputLimit: 64000, modalities: PDF_MODALITIES },
  { id: 'claude-sonnet-5-max', wireId: 'claude-sonnet-5', name: 'Claude Sonnet 5 (max) (1.3x)', contextLimit: getModelContextLimit('claude-sonnet-5'), outputLimit: 64000, modalities: PDF_MODALITIES },
  { id: 'claude-haiku-4-5', wireId: 'claude-haiku-4.5', name: 'Claude Haiku 4.5 (0.4x)', contextLimit: getModelContextLimit('claude-haiku-4-5'), outputLimit: 64000, modalities: IMAGE_MODALITIES },
  { id: 'claude-opus-4-5', wireId: 'claude-opus-4.5', name: 'Claude Opus 4.5 (2.2x)', contextLimit: getModelContextLimit('claude-opus-4-5'), outputLimit: 64000, modalities: PDF_MODALITIES },
  { id: 'claude-opus-4-6', wireId: 'claude-opus-4.6', name: 'Claude Opus 4.6 (2.2x)', contextLimit: getModelContextLimit('claude-opus-4-6'), outputLimit: 64000, modalities: PDF_MODALITIES },
  { id: 'claude-opus-4-7', wireId: 'claude-opus-4.7', name: 'Claude Opus 4.7 (2.2x)', contextLimit: getModelContextLimit('claude-opus-4-7'), outputLimit: 128000, modalities: PDF_MODALITIES },
  { id: 'claude-opus-4-7-low', wireId: 'claude-opus-4.7', name: 'Claude Opus 4.7 (low) (2.2x)', contextLimit: getModelContextLimit('claude-opus-4-7'), outputLimit: 128000, modalities: PDF_MODALITIES },
  { id: 'claude-opus-4-7-medium', wireId: 'claude-opus-4.7', name: 'Claude Opus 4.7 (medium) (2.2x)', contextLimit: getModelContextLimit('claude-opus-4-7'), outputLimit: 128000, modalities: PDF_MODALITIES },
  { id: 'claude-opus-4-7-high', wireId: 'claude-opus-4.7', name: 'Claude Opus 4.7 (high) (2.2x)', contextLimit: getModelContextLimit('claude-opus-4-7'), outputLimit: 128000, modalities: PDF_MODALITIES },
  { id: 'claude-opus-4-7-xhigh', wireId: 'claude-opus-4.7', name: 'Claude Opus 4.7 (xhigh) (2.2x)', contextLimit: getModelContextLimit('claude-opus-4-7'), outputLimit: 128000, modalities: PDF_MODALITIES },
  { id: 'claude-opus-4-7-max', wireId: 'claude-opus-4.7', name: 'Claude Opus 4.7 (max) (2.2x)', contextLimit: getModelContextLimit('claude-opus-4-7'), outputLimit: 128000, modalities: PDF_MODALITIES },
  { id: 'claude-opus-4-8', wireId: 'claude-opus-4.8', name: 'Claude Opus 4.8 (2.2x)', contextLimit: getModelContextLimit('claude-opus-4-8'), outputLimit: 128000, modalities: PDF_MODALITIES },
  { id: 'claude-opus-4-8-low', wireId: 'claude-opus-4.8', name: 'Claude Opus 4.8 (low) (2.2x)', contextLimit: getModelContextLimit('claude-opus-4-8'), outputLimit: 128000, modalities: PDF_MODALITIES },
  { id: 'claude-opus-4-8-medium', wireId: 'claude-opus-4.8', name: 'Claude Opus 4.8 (medium) (2.2x)', contextLimit: getModelContextLimit('claude-opus-4-8'), outputLimit: 128000, modalities: PDF_MODALITIES },
  { id: 'claude-opus-4-8-high', wireId: 'claude-opus-4.8', name: 'Claude Opus 4.8 (high) (2.2x)', contextLimit: getModelContextLimit('claude-opus-4-8'), outputLimit: 128000, modalities: PDF_MODALITIES },
  { id: 'claude-opus-4-8-xhigh', wireId: 'claude-opus-4.8', name: 'Claude Opus 4.8 (xhigh) (2.2x)', contextLimit: getModelContextLimit('claude-opus-4-8'), outputLimit: 128000, modalities: PDF_MODALITIES },
  { id: 'claude-opus-4-8-max', wireId: 'claude-opus-4.8', name: 'Claude Opus 4.8 (max) (2.2x)', contextLimit: getModelContextLimit('claude-opus-4-8'), outputLimit: 128000, modalities: PDF_MODALITIES },
  { id: 'claude-opus-4-8-thinking', wireId: 'claude-opus-4.8', name: 'Claude Opus 4.8 Thinking (2.2x)', contextLimit: getModelContextLimit('claude-opus-4-8'), outputLimit: 128000, modalities: PDF_MODALITIES },
  { id: 'claude-opus-5', wireId: 'claude-opus-5', name: 'Claude Opus 5 (2.2x)', contextLimit: getModelContextLimit('claude-opus-5'), outputLimit: 128000, modalities: PDF_MODALITIES },
  { id: 'claude-opus-5-low', wireId: 'claude-opus-5', name: 'Claude Opus 5 (low) (2.2x)', contextLimit: getModelContextLimit('claude-opus-5'), outputLimit: 128000, modalities: PDF_MODALITIES },
  { id: 'claude-opus-5-medium', wireId: 'claude-opus-5', name: 'Claude Opus 5 (medium) (2.2x)', contextLimit: getModelContextLimit('claude-opus-5'), outputLimit: 128000, modalities: PDF_MODALITIES },
  { id: 'claude-opus-5-high', wireId: 'claude-opus-5', name: 'Claude Opus 5 (high) (2.2x)', contextLimit: getModelContextLimit('claude-opus-5'), outputLimit: 128000, modalities: PDF_MODALITIES },
  { id: 'claude-opus-5-xhigh', wireId: 'claude-opus-5', name: 'Claude Opus 5 (xhigh) (2.2x)', contextLimit: getModelContextLimit('claude-opus-5'), outputLimit: 128000, modalities: PDF_MODALITIES },
  { id: 'claude-opus-5-max', wireId: 'claude-opus-5', name: 'Claude Opus 5 (max) (2.2x)', contextLimit: getModelContextLimit('claude-opus-5'), outputLimit: 128000, modalities: PDF_MODALITIES },
  { id: 'deepseek-3.2', wireId: 'deepseek-3.2', name: 'DeepSeek 3.2 (0.25x)', contextLimit: getModelContextLimit('deepseek-3.2'), outputLimit: 64000, modalities: IMAGE_MODALITIES },
  { id: 'glm-5', wireId: 'glm-5', name: 'GLM-5 (0.5x)', contextLimit: getModelContextLimit('glm-5'), outputLimit: 64000, modalities: TEXT_MODALITIES },
  { id: 'minimax-m2.5', wireId: 'minimax-m2.5', name: 'MiniMax M2.5 (0.25x)', contextLimit: getModelContextLimit('minimax-m2.5'), outputLimit: 64000, modalities: TEXT_MODALITIES },
  { id: 'minimax-m2.1', wireId: 'minimax-m2.1', name: 'MiniMax M2.1 (0.15x)', contextLimit: getModelContextLimit('minimax-m2.1'), outputLimit: 64000, modalities: IMAGE_MODALITIES },
  { id: 'qwen3-coder-next', wireId: 'qwen3-coder-next', name: 'Qwen3 Coder Next (0.05x)', contextLimit: getModelContextLimit('qwen3-coder-next'), outputLimit: 64000, modalities: IMAGE_MODALITIES },
  { id: 'gpt-5.6-sol', wireId: 'gpt-5.6-sol', name: 'GPT 5.6 Sol (2.4x)', contextLimit: getModelContextLimit('gpt-5.6-sol'), outputLimit: 128000, modalities: IMAGE_MODALITIES },
  { id: 'gpt-5.6-sol-low', wireId: 'gpt-5.6-sol', name: 'GPT 5.6 Sol (low) (2.4x)', contextLimit: getModelContextLimit('gpt-5.6-sol'), outputLimit: 128000, modalities: IMAGE_MODALITIES },
  { id: 'gpt-5.6-sol-medium', wireId: 'gpt-5.6-sol', name: 'GPT 5.6 Sol (medium) (2.4x)', contextLimit: getModelContextLimit('gpt-5.6-sol'), outputLimit: 128000, modalities: IMAGE_MODALITIES },
  { id: 'gpt-5.6-sol-high', wireId: 'gpt-5.6-sol', name: 'GPT 5.6 Sol (high) (2.4x)', contextLimit: getModelContextLimit('gpt-5.6-sol'), outputLimit: 128000, modalities: IMAGE_MODALITIES },
  { id: 'gpt-5.6-sol-xhigh', wireId: 'gpt-5.6-sol', name: 'GPT 5.6 Sol (xhigh) (2.4x)', contextLimit: getModelContextLimit('gpt-5.6-sol'), outputLimit: 128000, modalities: IMAGE_MODALITIES },
  { id: 'gpt-5.6-sol-max', wireId: 'gpt-5.6-sol', name: 'GPT 5.6 Sol (max) (2.4x)', contextLimit: getModelContextLimit('gpt-5.6-sol'), outputLimit: 128000, modalities: IMAGE_MODALITIES },
  { id: 'gpt-5.6-terra', wireId: 'gpt-5.6-terra', name: 'GPT 5.6 Terra (1.0x)', contextLimit: getModelContextLimit('gpt-5.6-terra'), outputLimit: 128000, modalities: IMAGE_MODALITIES },
  { id: 'gpt-5.6-terra-low', wireId: 'gpt-5.6-terra', name: 'GPT 5.6 Terra (low) (1.0x)', contextLimit: getModelContextLimit('gpt-5.6-terra'), outputLimit: 128000, modalities: IMAGE_MODALITIES },
  { id: 'gpt-5.6-terra-medium', wireId: 'gpt-5.6-terra', name: 'GPT 5.6 Terra (medium) (1.0x)', contextLimit: getModelContextLimit('gpt-5.6-terra'), outputLimit: 128000, modalities: IMAGE_MODALITIES },
  { id: 'gpt-5.6-terra-high', wireId: 'gpt-5.6-terra', name: 'GPT 5.6 Terra (high) (1.0x)', contextLimit: getModelContextLimit('gpt-5.6-terra'), outputLimit: 128000, modalities: IMAGE_MODALITIES },
  { id: 'gpt-5.6-terra-xhigh', wireId: 'gpt-5.6-terra', name: 'GPT 5.6 Terra (xhigh) (1.0x)', contextLimit: getModelContextLimit('gpt-5.6-terra'), outputLimit: 128000, modalities: IMAGE_MODALITIES },
  { id: 'gpt-5.6-terra-max', wireId: 'gpt-5.6-terra', name: 'GPT 5.6 Terra (max) (1.0x)', contextLimit: getModelContextLimit('gpt-5.6-terra'), outputLimit: 128000, modalities: IMAGE_MODALITIES },
  { id: 'gpt-5.6-luna', wireId: 'gpt-5.6-luna', name: 'GPT 5.6 Luna (0.1x)', contextLimit: getModelContextLimit('gpt-5.6-luna'), outputLimit: 128000, modalities: IMAGE_MODALITIES },
  { id: 'gpt-5.6-luna-low', wireId: 'gpt-5.6-luna', name: 'GPT 5.6 Luna (low) (0.1x)', contextLimit: getModelContextLimit('gpt-5.6-luna'), outputLimit: 128000, modalities: IMAGE_MODALITIES },
  { id: 'gpt-5.6-luna-medium', wireId: 'gpt-5.6-luna', name: 'GPT 5.6 Luna (medium) (0.1x)', contextLimit: getModelContextLimit('gpt-5.6-luna'), outputLimit: 128000, modalities: IMAGE_MODALITIES },
  { id: 'gpt-5.6-luna-high', wireId: 'gpt-5.6-luna', name: 'GPT 5.6 Luna (high) (0.1x)', contextLimit: getModelContextLimit('gpt-5.6-luna'), outputLimit: 128000, modalities: IMAGE_MODALITIES },
  { id: 'gpt-5.6-luna-xhigh', wireId: 'gpt-5.6-luna', name: 'GPT 5.6 Luna (xhigh) (0.1x)', contextLimit: getModelContextLimit('gpt-5.6-luna'), outputLimit: 128000, modalities: IMAGE_MODALITIES },
  { id: 'gpt-5.6-luna-max', wireId: 'gpt-5.6-luna', name: 'GPT 5.6 Luna (max) (0.1x)', contextLimit: getModelContextLimit('gpt-5.6-luna'), outputLimit: 128000, modalities: IMAGE_MODALITIES }
])

function dynamicModalities(model: KiroAvailableModel): ModelCatalogEntry['modalities'] {
  return {
    input: model.supportedInputTypes.includes('IMAGE')
      ? (['text', 'image'] as const)
      : (['text'] as const),
    output: ['text'] as const
  }
}

export function modelCatalogFromAvailableModels(
  availableModels: readonly KiroAvailableModel[]
): readonly ModelCatalogEntry[] {
  const staticByWire = new Map<string, ModelCatalogEntry[]>()
  for (const entry of MODEL_CATALOG) {
    const entries = staticByWire.get(entry.wireId) ?? []
    entries.push(entry)
    staticByWire.set(entry.wireId, entries)
  }
  return availableModels.flatMap((model) => {
    const metadata = {
      contextLimit: model.tokenLimits.maxInputTokens,
      outputLimit: model.tokenLimits.maxOutputTokens,
      modalities: dynamicModalities(model),
      ...(model.description !== undefined ? { description: model.description } : {}),
      ...(model.rateMultiplier !== undefined
        ? { rateMultiplier: model.rateMultiplier }
        : {}),
      ...(model.additionalModelRequestFieldsSchema !== undefined
        ? {
            additionalModelRequestFieldsSchema:
              model.additionalModelRequestFieldsSchema
          }
        : {})
    }
    const knownEntries = staticByWire.get(model.modelId)
    if (knownEntries && knownEntries.length > 0) {
      return knownEntries.map((entry) => ({ ...entry, ...metadata }))
    }
    return [
      {
        id: model.modelId,
        wireId: model.modelId,
        name: model.modelName,
        ...metadata
      }
    ]
  })
}
