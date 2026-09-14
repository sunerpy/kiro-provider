import { isRecord } from "./adapter-utils.js";

export const REPORTED_USAGE_KEYS = [
  "inputTokens",
  "uncachedInputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "reasoningTokens",
] as const;

export type ReportedTokenUsage = {
  readonly [Key in (typeof REPORTED_USAGE_KEYS)[number]]?: number;
};

export interface UsageAccounting {
  readonly input: "upstream" | "estimated";
  readonly output: "upstream" | "estimated";
  readonly context:
    | "upstream"
    | "percentage"
    | "percentage_lower_bound"
    | "tokenizer"
    | "unavailable";
  readonly contextUsagePercentage?: number;
  readonly contextUsageWindow?: number;
  readonly percentageSaturated?: boolean;
  readonly metering?: {
    readonly value: number;
    readonly unit: string;
  };
}

export class InvalidTokenUsageError extends Error {
  readonly name = "InvalidTokenUsageError";
  readonly code = "invalid_upstream_usage";
}

function count(value: number, key: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidTokenUsageError(`Upstream ${key} must be a nonnegative safe integer`);
  }
  return value;
}

/** Cache read/write are included in input; reasoning is included in output. */
export function normalizeReportedUsage(value: ReportedTokenUsage): ReportedTokenUsage {
  const result: { -readonly [Key in keyof ReportedTokenUsage]: ReportedTokenUsage[Key] } = {};
  for (const key of REPORTED_USAGE_KEYS) {
    if (value[key] !== undefined) result[key] = count(value[key], key);
  }
  if (result.totalTokens === 0) {
    result.inputTokens ??= 0;
    result.outputTokens ??= 0;
  }
  if (
    result.uncachedInputTokens !== undefined &&
    result.cacheReadInputTokens !== undefined &&
    result.cacheWriteInputTokens !== undefined
  ) {
    const inclusive = count(
      result.uncachedInputTokens + result.cacheReadInputTokens + result.cacheWriteInputTokens,
      "inclusive input tokens",
    );
    if (result.inputTokens !== undefined && result.inputTokens !== inclusive) {
      throw new InvalidTokenUsageError("Upstream input token buckets are inconsistent");
    }
    result.inputTokens = inclusive;
  }
  if (result.totalTokens !== undefined) {
    if (result.inputTokens === undefined && result.outputTokens !== undefined) {
      result.inputTokens = count(result.totalTokens - result.outputTokens, "input tokens");
    }
    if (result.outputTokens === undefined && result.inputTokens !== undefined) {
      result.outputTokens = count(result.totalTokens - result.inputTokens, "output tokens");
    }
  }
  if (result.inputTokens !== undefined && result.outputTokens !== undefined) {
    const total = count(result.inputTokens + result.outputTokens, "total tokens");
    if (result.totalTokens !== undefined && result.totalTokens !== total) {
      throw new InvalidTokenUsageError("Upstream total_tokens differs from input + output");
    }
    result.totalTokens = total;
  }
  if (result.inputTokens === 0) {
    result.uncachedInputTokens ??= 0;
    result.cacheReadInputTokens ??= 0;
    result.cacheWriteInputTokens ??= 0;
  }
  if (result.outputTokens === 0) result.reasoningTokens ??= 0;
  if (result.inputTokens !== undefined) {
    const buckets = [
      "uncachedInputTokens",
      "cacheReadInputTokens",
      "cacheWriteInputTokens",
    ] as const;
    const absent = buckets.filter((key) => result[key] === undefined);
    const missing = absent[0];
    if (absent.length === 1 && missing) {
      result[missing] = count(
        result.inputTokens - buckets.reduce((sum, key) => sum + (result[key] ?? 0), 0),
        missing,
      );
    }
  }
  const cache = (result.cacheReadInputTokens ?? 0) + (result.cacheWriteInputTokens ?? 0);
  const minimumInput = count(cache + (result.uncachedInputTokens ?? 0), "input token buckets");
  if (result.inputTokens !== undefined && minimumInput > result.inputTokens) {
    throw new InvalidTokenUsageError("Upstream cache token counts exceed input tokens");
  }
  if (
    result.totalTokens !== undefined &&
    minimumInput + (result.reasoningTokens ?? 0) > result.totalTokens
  ) {
    throw new InvalidTokenUsageError("Upstream token sub-buckets exceed total tokens");
  }
  if (
    result.outputTokens !== undefined &&
    result.reasoningTokens !== undefined &&
    result.reasoningTokens > result.outputTokens
  ) {
    throw new InvalidTokenUsageError("Upstream reasoning token count exceeds output tokens");
  }
  return result;
}

export function parseReportedUsage(value: unknown): ReportedTokenUsage | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !REPORTED_USAGE_KEYS.some((k) => k === key))
  ) {
    return undefined;
  }
  try {
    return normalizeReportedUsage(value as ReportedTokenUsage);
  } catch {
    return undefined;
  }
}

export function parseUsageAccounting(value: unknown): UsageAccounting | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set([
    "input",
    "output",
    "context",
    "contextUsagePercentage",
    "contextUsageWindow",
    "percentageSaturated",
    "metering",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (
    !["upstream", "estimated"].includes(String(value.input)) ||
    !["upstream", "estimated"].includes(String(value.output)) ||
    !["upstream", "percentage", "percentage_lower_bound", "tokenizer", "unavailable"].includes(
      String(value.context),
    )
  )
    return undefined;
  for (const key of ["contextUsagePercentage", "contextUsageWindow"]) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0)
    )
      return undefined;
  }
  if (value.percentageSaturated !== undefined && typeof value.percentageSaturated !== "boolean")
    return undefined;
  if (
    value.metering !== undefined &&
    (!isRecord(value.metering) ||
      typeof value.metering.value !== "number" ||
      !Number.isFinite(value.metering.value) ||
      value.metering.value < 0 ||
      typeof value.metering.unit !== "string" ||
      !value.metering.unit.length ||
      Object.keys(value.metering).some((key) => key !== "value" && key !== "unit"))
  )
    return undefined;
  return value as unknown as UsageAccounting;
}

export function hasCompleteReportedUsage(value: ReportedTokenUsage | undefined): boolean {
  return (
    value !== undefined &&
    value.inputTokens !== undefined &&
    value.outputTokens !== undefined &&
    value.totalTokens !== undefined &&
    value.cacheReadInputTokens !== undefined &&
    value.cacheWriteInputTokens !== undefined &&
    value.reasoningTokens !== undefined
  );
}
