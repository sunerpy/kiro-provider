import { resolveModelVariant } from "./models.js";

export const KIRO_OUTPUT_TOKEN_LIMIT_MIN = 1_024;
export const KIRO_OUTPUT_TOKEN_LIMIT_MAX = 128_000;

const PROBE_CONFIRMED_MAX_TOKENS_MODELS = new Set(["claude-sonnet-5", "claude-opus-5"]);

export type OutputTokenLimitResult =
  | {
      readonly ok: true;
      readonly wireModel: string;
      readonly additionalModelRequestFields: Readonly<{ max_tokens: number }>;
    }
  | {
      readonly ok: false;
      readonly code: "unsupported_output_token_limit" | "invalid_output_token_limit";
      readonly message: string;
    };

/**
 * Return the exact Kiro-native projection proven by live probes.
 * Claude Sonnet 5 (2026-08-26) and Claude Opus 5 (2026-08-27) accept
 * max_tokens from 1,024 through 128,000. GPT 5.6 rejected every tested
 * standard spelling, so it remains fail-closed.
 */
export function resolveOutputTokenLimit(model: string, limit: number): OutputTokenLimitResult {
  let wireModel: string;
  try {
    wireModel = resolveModelVariant(model).wireId;
  } catch {
    return {
      ok: false,
      code: "unsupported_output_token_limit",
      message: `Output-token limiting is not available for unsupported model ${model}`,
    };
  }
  if (!PROBE_CONFIRMED_MAX_TOKENS_MODELS.has(wireModel)) {
    return {
      ok: false,
      code: "unsupported_output_token_limit",
      message: `Kiro has no probe-confirmed native output-token control for model ${model}`,
    };
  }
  if (
    !Number.isInteger(limit) ||
    limit < KIRO_OUTPUT_TOKEN_LIMIT_MIN ||
    limit > KIRO_OUTPUT_TOKEN_LIMIT_MAX
  ) {
    return {
      ok: false,
      code: "invalid_output_token_limit",
      message: `Kiro requires output-token limits for ${model} to be an integer from ${KIRO_OUTPUT_TOKEN_LIMIT_MIN} through ${KIRO_OUTPUT_TOKEN_LIMIT_MAX}`,
    };
  }
  return {
    ok: true,
    wireModel,
    additionalModelRequestFields: { max_tokens: limit },
  };
}
