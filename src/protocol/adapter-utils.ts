import type { CanonicalTextPart } from "./canonical.js";

/** Narrow an unknown value to a plain (non-array, non-null) object record. */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A canonical text part that records the source-request path it came from. */
export function textPart(text: string, path: string): CanonicalTextPart {
  return { type: "text", text, path };
}
