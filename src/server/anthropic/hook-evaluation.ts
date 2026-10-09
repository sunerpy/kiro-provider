import { utf8ByteLength } from "../../core/utf8-byte-length.js";
import {
  hasExactlyKeys,
  isRecord,
  type LocalStructuredOutputResult,
  structuredOutputBufferFailure,
  structuredOutputValidationFailure,
  trimUnicodeWhitespace,
  unwrapMarkdownFence,
} from "../structured-output/local-profile.js";

/** Claude Code's prompt/Goal evaluator wire schema, including optional impossibility. */
const ROOT_KEYS = new Set(["type", "properties", "required", "additionalProperties"]);
const PROPERTY_KEYS = new Set(["ok", "reason", "impossible"]);
const TYPE_KEYS = new Set(["type"]);
const SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({
    ok: Object.freeze({ type: "boolean" }),
    reason: Object.freeze({ type: "string" }),
    impossible: Object.freeze({ type: "boolean" }),
  }),
  required: Object.freeze(["ok", "reason"]),
  additionalProperties: false,
});

export interface HookEvaluationProfile {
  readonly kind: "hook-evaluation-v1";
  readonly schema: Readonly<Record<string, unknown>>;
}

const PROFILE: HookEvaluationProfile = Object.freeze({
  kind: "hook-evaluation-v1",
  schema: SCHEMA,
});

export function parseHookEvaluationSchema(schema: unknown): HookEvaluationProfile | undefined {
  if (
    !isRecord(schema) ||
    !hasExactlyKeys(schema, ROOT_KEYS) ||
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    !isRecord(schema.properties) ||
    !hasExactlyKeys(schema.properties, PROPERTY_KEYS) ||
    !Array.isArray(schema.required) ||
    schema.required.length !== 2 ||
    !schema.required.includes("ok") ||
    !schema.required.includes("reason")
  ) {
    return undefined;
  }
  for (const [key, type] of [
    ["ok", "boolean"],
    ["reason", "string"],
    ["impossible", "boolean"],
  ] as const) {
    const property = schema.properties[key];
    if (!isRecord(property) || !hasExactlyKeys(property, TYPE_KEYS) || property.type !== type) {
      return undefined;
    }
  }
  return PROFILE;
}

/** Whole JSON string tokens distinguish object keys from text embedded in the reason. */
function uniqueJsonKeys(text: string): boolean {
  const keys = new Set<string>();
  for (const match of text.matchAll(/("(?:\\.|[^"\\])*")\s*(:?)/gu)) {
    if (match[2] !== ":") continue;
    const key = JSON.parse(match[1] as string) as string;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

/** Preserve the evaluator's decisions; never wrap prose, coerce, default, truncate or infer them. */
export function enforceHookEvaluationOutput(
  visibleText: string,
  param: string,
  maxBufferBytes: number,
): LocalStructuredOutputResult<Readonly<Record<string, string | boolean>>> {
  const inputBytes = utf8ByteLength(visibleText);
  if (inputBytes > maxBufferBytes) return structuredOutputBufferFailure(param);
  const text = unwrapMarkdownFence(trimUnicodeWhitespace(visibleText));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return structuredOutputValidationFailure(param);
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.ok !== "boolean" ||
    typeof parsed.reason !== "string" ||
    (Object.hasOwn(parsed, "impossible") && typeof parsed.impossible !== "boolean") ||
    !Object.keys(parsed).every((key) => PROPERTY_KEYS.has(key)) ||
    !uniqueJsonKeys(text)
  ) {
    return structuredOutputValidationFailure(param);
  }
  const value = Object.freeze({
    ok: parsed.ok,
    reason: parsed.reason,
    ...(Object.hasOwn(parsed, "impossible") ? { impossible: parsed.impossible as boolean } : {}),
  });
  const normalized = JSON.stringify(value);
  const outputBytes = utf8ByteLength(normalized);
  if (outputBytes > maxBufferBytes) return structuredOutputBufferFailure(param);
  return { ok: true, value, text: normalized, inputBytes, outputBytes, truncated: false };
}
