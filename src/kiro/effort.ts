import { isKimiK3Model, resolveModelVariant } from "./models.js";
import { RequestTransformError } from "./transform/errors.js";
import type { Effort } from "./types.js";

/**
 * Effort levels ordered from lowest to highest reasoning depth.
 */
export const EFFORT_LEVELS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"] as const;

function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && EFFORT_LEVELS.some((effort) => effort === value);
}

/**
 * OpenAI GPT models (Kiro proxies these via Mantle). They accept the effort enum
 * through a DIFFERENT wire field than Claude — see buildEffortRequestFields.
 * All five levels (incl. xhigh/max) are probe-confirmed: credit usage scales
 * monotonically low<medium<high<xhigh<max (.omo/evidence/task-gpt56-effort-probe.txt).
 */
const GPT_REASONING_MODELS = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
const KIMI_K3_EFFORT_LEVELS: readonly Effort[] = ["low", "high", "max"];
const FOUR_EFFORT_LEVELS: readonly Effort[] = ["low", "medium", "high", "max"];

/**
 * Models that support the 5-value effort enum (including xhigh).
 * These models support up to 128k thinking tokens with max effort.
 */
const XHIGH_CAPABLE_MODELS = new Set([
  "claude-fable-5.1",
  // 2026-09-26: this model's own additionalModelRequestFieldsSchema declares
  // output_config.effort as the full low|medium|high|xhigh|max enum with
  // default medium, and a live xhigh request returns 200
  // (docs/audits/opus-5-5-catalog-probe-2026-09-26.zh.md).
  "claude-opus-5.5",
  // 2026-11-26: each model's own schema declares the same five-value enum
  // (default high for Fable 5.2 and Sonnet 5.5, medium for Haiku 5.5), and
  // live low, xhigh and max requests return 200
  // (docs/audits/claude-5-5-models-catalog-probe-2026-11-26.zh.md).
  "claude-fable-5.2",
  "claude-sonnet-5.5",
  "claude-haiku-5.5",
  "claude-opus-5",
  "claude-opus-4.7",
  "claude-opus-4.8",
  "claude-sonnet-5",
  ...GPT_REASONING_MODELS,
]);

/** Catalog-schema effort defaults that differ from the provider's medium default. */
const UPSTREAM_DEFAULT_EFFORTS: ReadonlyMap<string, Effort> = new Map([
  ["claude-fable-5.2", "high"],
  ["claude-sonnet-5.5", "high"],
]);

/**
 * Models whose own schema declares adaptive thinking with summarized|omitted
 * display, and whose live requests with each display returned 200.
 */
const ADAPTIVE_THINKING_DISPLAY_MODELS = new Set([
  "claude-fable-5.1",
  "claude-opus-5.5",
  "claude-fable-5.2",
  "claude-sonnet-5.5",
  "claude-haiku-5.5",
]);

/**
 * Operator display-recovery policies stay limited to the models they were
 * validated on; supporting the display fields alone does not opt a model in.
 */
const FORCED_OMITTED_DISPLAY_MODELS = new Set(["claude-fable-5.1", "claude-opus-5.5"]);

/**
 * Only these schemas declare `thinking.type: "disabled"`. A live Haiku 5.5
 * request with effort but no thinking field still reasoned; with the explicit
 * disabled type it returned no reasoning.
 */
const THINKING_DISABLE_MODELS = new Set(["claude-haiku-5.5"]);

/**
 * Models with categorical effort. The exact enum is model-specific: K3 has
 * three levels; older Claude models have four and clamp xhigh to max.
 */
const EFFORT_CAPABLE_MODELS = new Set([
  "claude-opus-4.5",
  "claude-opus-4.6",
  "claude-opus-4.6-1m",
  // GenerateAssistantResponse rejects additionalModelRequestFields for Sonnet 4.5.
  // Keep adaptive-thinking requests usable by omitting effort for this model family.
  "claude-sonnet-4.6",
  "claude-sonnet-4.6-1m",
  "kimi-k3",
  ...XHIGH_CAPABLE_MODELS,
]);

/**
 * Check if a model supports the effort parameter.
 */
export function supportsEffort(kiroModel: string): boolean {
  return EFFORT_CAPABLE_MODELS.has(kiroModel);
}

/**
 * Check if a model supports xhigh effort level.
 */
export function supportsXHighEffort(kiroModel: string): boolean {
  return XHIGH_CAPABLE_MODELS.has(kiroModel);
}

/** Wire-field selection does not imply a model supports every effort enum. */
export function getSupportedEffortLevels(kiroModel: string): readonly Effort[] {
  if (kiroModel === "kimi-k3") return KIMI_K3_EFFORT_LEVELS;
  if (!supportsEffort(kiroModel)) return [];
  return supportsXHighEffort(kiroModel) ? EFFORT_LEVELS : FOUR_EFFORT_LEVELS;
}

export function getDefaultEffort(kiroModel: string): Effort | undefined {
  if (kiroModel === "kimi-k3") return "max";
  if (!supportsEffort(kiroModel)) return undefined;
  return UPSTREAM_DEFAULT_EFFORTS.get(kiroModel) ?? "medium";
}

export function supportsAdaptiveThinkingDisplay(kiroModel: string): boolean {
  return ADAPTIVE_THINKING_DISPLAY_MODELS.has(kiroModel);
}

export function supportsForcedOmittedThinkingDisplay(kiroModel: string): boolean {
  return FORCED_OMITTED_DISPLAY_MODELS.has(kiroModel);
}

/** Reject unrepresentable K3 controls rather than silently changing depth. */
export function assertKimiReasoningEffort(
  model: string,
  effort: string | null | undefined,
  param = "reasoning.effort",
): void {
  if (!isKimiK3Model(model) || effort == null || KIMI_K3_EFFORT_LEVELS.includes(effort as Effort))
    return;
  throw new RequestTransformError(
    "Kimi K3 supports reasoning effort low, high, or max; thinking cannot be disabled",
    "unsupported_reasoning_effort",
    param,
  );
}

/**
 * Build the additionalModelRequestFields payload carrying the effort level.
 *
 * GPT and Claude take effort through different, mutually-exclusive wire fields
 * (each rejects the other's with HTTP 400, probe-confirmed):
 * - GPT (Mantle) and Kimi K3: `reasoning.effort`
 * - Claude:        `output_config.effort`
 */
export function buildEffortRequestFields(
  kiroModel: string,
  effort: Effort,
): Record<string, unknown> {
  assertKimiReasoningEffort(kiroModel, effort);
  if (GPT_REASONING_MODELS.has(kiroModel) || kiroModel === "kimi-k3") {
    return { reasoning: { effort } };
  }
  return { output_config: { effort } };
}

/** Adaptive-thinking controls supported by the evidenced model schemas. */
export function buildThinkingRequestFields(
  kiroModel: string,
  enabled: boolean,
  display?: "omitted" | "summarized",
): Record<string, unknown> | undefined {
  if (!enabled || !supportsAdaptiveThinkingDisplay(kiroModel)) {
    return undefined;
  }
  return {
    thinking: {
      type: "adaptive",
      // Preserve signed reasoning without requesting streamed summary blocks.
      // Every model in the set declares the same display controls.
      display: display ?? "omitted",
    },
  };
}

/**
 * Project an explicit client thinking disable where the schema can express
 * it. Other schemas have no disabled type, so their requests keep omitting the
 * thinking field.
 */
export function buildThinkingDisabledRequestFields(
  kiroModel: string,
): Record<string, unknown> | undefined {
  return THINKING_DISABLE_MODELS.has(kiroModel) ? { thinking: { type: "disabled" } } : undefined;
}

/**
 * Resolve effort level for a given model.
 * - Returns undefined if model doesn't support effort
 * - Clamps xhigh to max for models that don't support it
 */
export function resolveEffort(kiroModel: string, requested: Effort): Effort | undefined {
  if (!supportsEffort(kiroModel)) {
    return undefined;
  }

  if (kiroModel === "kimi-k3") {
    return KIMI_K3_EFFORT_LEVELS.includes(requested) ? requested : undefined;
  }

  // xhigh is only preserved for models in the probe-backed xhigh allowlist.
  if (requested === "xhigh" && !supportsXHighEffort(kiroModel)) {
    return "max";
  }

  return requested;
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
 * - ≤32768  → max
 * - >32768  → max
 */
export function budgetToEffort(budget: number, kiroModel: string): Effort | undefined {
  if (!supportsEffort(kiroModel)) {
    return undefined;
  }
  // K3 declares categorical effort only, not a numeric thinking budget.
  if (kiroModel === "kimi-k3") return undefined;

  let effort: Effort;
  if (budget <= 10000) {
    effort = "low";
  } else if (budget <= 20000) {
    effort = "medium";
  } else if (budget <= 28000) {
    effort = "high";
  } else {
    effort = "max";
  }

  return effort;
}

export interface EffectiveEffortOptions {
  readonly model: string;
  readonly think: boolean;
  readonly budget: number;
  readonly reasoningEffort?: string | null | undefined;
  readonly configEffort?: string | null | undefined;
  readonly autoEffortMapping?: boolean | undefined;
  /** Responses resolves its standard request parameter before a model alias. */
  readonly requestFirst?: boolean;
}

/**
 * Resolve the single effective effort for a public model id or resolved wire id.
 *
 * Precedence: model variant, request reasoning_effort, global config effort,
 * automatic budget mapping, then the thinking-only medium fallback.
 * K3 instead validates its three-value schema and defaults to max, without
 * inventing a categorical effort from an unsupported numeric token budget.
 *
 * Invalid explicit values are skipped here so internal/programmatic callers can
 * fall through to the next level. HTTP input is a separate trust boundary: T18
 * rejects an invalid reasoning_effort with 400 before this resolver is called.
 */
export function resolveEffectiveEffort(options: EffectiveEffortOptions): Effort | undefined {
  let resolved: ReturnType<typeof resolveModelVariant>;
  if (supportsEffort(options.model)) {
    resolved = { wireId: options.model, effort: undefined };
  } else {
    try {
      resolved = resolveModelVariant(options.model);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Unsupported model:")) {
        return undefined;
      }
      throw error;
    }
  }

  if (!supportsEffort(resolved.wireId)) {
    return undefined;
  }

  if (resolved.wireId === "kimi-k3") {
    const requested = options.reasoningEffort ?? resolved.effort ?? options.configEffort;
    assertKimiReasoningEffort(resolved.wireId, requested);
    return (requested as Effort | undefined) ?? "max";
  }

  if (options.requestFirst && options.reasoningEffort === "none") return undefined;
  const explicitEfforts = options.requestFirst
    ? [options.reasoningEffort, resolved.effort, options.configEffort]
    : [resolved.effort, options.reasoningEffort, options.configEffort];
  for (const effort of explicitEfforts) {
    if (isEffort(effort)) {
      return resolveEffort(resolved.wireId, effort);
    }
  }

  if (!options.think) {
    return undefined;
  }

  if (options.autoEffortMapping ?? true) {
    return budgetToEffort(options.budget, resolved.wireId);
  }

  return "medium";
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
  autoEffortMapping = true,
): Effort | undefined {
  return resolveEffectiveEffort({
    model: kiroModel,
    think: thinking,
    budget,
    configEffort,
    autoEffortMapping,
  });
}
