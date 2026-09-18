import { isRecord } from "./adapter-utils.js";

/** Public attribution fields declared by the Kiro SDK's CodeReferenceEvent. */
export interface CodeReference {
  readonly licenseName?: string;
  readonly repository?: string;
  readonly url?: string;
  readonly recommendationContentSpan?: {
    readonly start?: number;
    readonly end?: number;
  };
}

export interface CodeReferenceMetadata {
  readonly x_kiro?: {
    readonly code_references: readonly CodeReference[];
  };
}

const MAX_REFERENCES = 128;
const MAX_REFERENCE_BYTES = 256 * 1024;
const REFERENCE_KEYS = new Set(["licenseName", "repository", "url", "recommendationContentSpan"]);

/** Validate and copy public metadata without guessing URL, license, or span units. */
export function parseCodeReferences(value: unknown): readonly CodeReference[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_REFERENCES) return undefined;
  const result: CodeReference[] = [];
  let bytes = 1;
  for (const reference of value) {
    if (!isRecord(reference) || Object.keys(reference).some((key) => !REFERENCE_KEYS.has(key)))
      return undefined;
    const strings: { licenseName?: string; repository?: string; url?: string } = {};
    for (const key of ["licenseName", "repository", "url"] as const) {
      const field = reference[key];
      if (field === undefined) continue;
      if (typeof field !== "string" || field.length > MAX_REFERENCE_BYTES) return undefined;
      strings[key] = field;
    }
    let span: CodeReference["recommendationContentSpan"];
    if (reference.recommendationContentSpan !== undefined) {
      const candidate = reference.recommendationContentSpan;
      if (
        !isRecord(candidate) ||
        Object.keys(candidate).some((key) => key !== "start" && key !== "end")
      )
        return undefined;
      const parsed: { start?: number; end?: number } = {};
      for (const key of ["start", "end"] as const) {
        const number = candidate[key];
        if (number === undefined) continue;
        if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)
          return undefined;
        parsed[key] = number;
      }
      if (parsed.start !== undefined && parsed.end !== undefined && parsed.end < parsed.start)
        return undefined;
      span = parsed;
    }
    const parsed = {
      ...strings,
      ...(span !== undefined ? { recommendationContentSpan: span } : {}),
    };
    bytes += Buffer.byteLength(JSON.stringify(parsed), "utf8") + 1;
    if (bytes > MAX_REFERENCE_BYTES) return undefined;
    result.push(parsed);
  }
  return result;
}

/** Explicit provider extension; never insert attribution into signed model text. */
export function codeReferenceMetadata(
  references: readonly CodeReference[] | undefined,
): CodeReferenceMetadata {
  return references?.length ? { x_kiro: { code_references: references } } : {};
}
