/**
 * Strict, versioned decoder for the KiroRuntime InvokeMCP `web_search` result.
 *
 * Shape evidenced on 2026-10-05 (us-east-1): `result.content[]` holds one text
 * item whose text is JSON `{results, totalResults, query, error}`; each result
 * carries exactly `title, url, snippet, publishedDate, id, domain,
 * maxVerbatimWordLimit, publicDomain`. Anything else is a schema change the
 * provider has not verified, so it fails closed instead of being guessed at.
 */

export const WEB_SEARCH_RESULT_SCHEMA_VERSION = 1 as const;

export interface WebSearchSource {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  /** Milliseconds since the epoch, when the backend supplied a date. */
  readonly publishedDate?: number;
  /** Backend identifier; private to the encrypted snapshot, never public. */
  readonly backendId: string;
  readonly domain: string;
  readonly maxVerbatimWordLimit: number;
  readonly publicDomain: boolean;
}

export interface WebSearchResultSet {
  readonly schemaVersion: typeof WEB_SEARCH_RESULT_SCHEMA_VERSION;
  /** The query the backend reports it executed (private snapshot data). */
  readonly query: string;
  readonly totalResults: number;
  readonly sources: readonly WebSearchSource[];
}

export type WebSearchDecodeFailure =
  | "result_not_object"
  | "result_content_invalid"
  | "result_reported_error"
  | "result_text_not_json"
  | "result_schema_mismatch";

export type WebSearchDecodeResult =
  | { readonly ok: true; readonly value: WebSearchResultSet }
  | { readonly ok: false; readonly reason: WebSearchDecodeFailure };

export type WebSearchToolResultDecode =
  | {
      readonly ok: true;
      readonly value: WebSearchResultSet;
      /** The backend's exact text item, handed to the model when nothing is filtered. */
      readonly text: string;
    }
  | { readonly ok: false; readonly reason: WebSearchDecodeFailure };

const RESULT_SET_KEYS = new Set(["results", "totalResults", "query", "error"]);
const SOURCE_KEYS = new Set([
  "title",
  "url",
  "snippet",
  "publishedDate",
  "id",
  "domain",
  "maxVerbatimWordLimit",
  "publicDomain",
]);
const MAX_SOURCES = 100;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}

function decodeSource(value: unknown): WebSearchSource | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, SOURCE_KEYS)) return undefined;
  const { title, url, snippet, publishedDate, id, domain, maxVerbatimWordLimit, publicDomain } =
    value;
  if (
    typeof title !== "string" ||
    typeof url !== "string" ||
    !isHttpUrl(url) ||
    typeof snippet !== "string" ||
    typeof id !== "string" ||
    typeof domain !== "string" ||
    typeof publicDomain !== "boolean" ||
    typeof maxVerbatimWordLimit !== "number" ||
    !Number.isSafeInteger(maxVerbatimWordLimit) ||
    maxVerbatimWordLimit < 0
  ) {
    return undefined;
  }
  if (
    publishedDate !== undefined &&
    publishedDate !== null &&
    (typeof publishedDate !== "number" || !Number.isSafeInteger(publishedDate) || publishedDate < 0)
  ) {
    return undefined;
  }
  return {
    title,
    url,
    snippet,
    ...(typeof publishedDate === "number" ? { publishedDate } : {}),
    backendId: id,
    domain,
    maxVerbatimWordLimit,
    publicDomain,
  };
}

/** Decodes the parsed JSON object carried by the result's text content. */
export function decodeWebSearchResultSet(value: unknown): WebSearchDecodeResult {
  if (!isRecord(value) || !hasOnlyKeys(value, RESULT_SET_KEYS)) {
    return { ok: false, reason: "result_schema_mismatch" };
  }
  if (value.error !== null && value.error !== undefined) {
    return { ok: false, reason: "result_reported_error" };
  }
  if (
    !Array.isArray(value.results) ||
    value.results.length > MAX_SOURCES ||
    typeof value.totalResults !== "number" ||
    !Number.isSafeInteger(value.totalResults) ||
    value.totalResults < 0 ||
    typeof value.query !== "string"
  ) {
    return { ok: false, reason: "result_schema_mismatch" };
  }
  const sources: WebSearchSource[] = [];
  for (const candidate of value.results) {
    const source = decodeSource(candidate);
    if (source === undefined) return { ok: false, reason: "result_schema_mismatch" };
    sources.push(source);
  }
  return {
    ok: true,
    value: {
      schemaVersion: WEB_SEARCH_RESULT_SCHEMA_VERSION,
      query: value.query,
      totalResults: value.totalResults,
      sources,
    },
  };
}

/**
 * Decodes the JSON-RPC `result` member of a successful `tools/call`.
 * `isError: true` and a non-null internal `error` are failures even though the
 * transport and the JSON-RPC envelope succeeded.
 */
export function decodeWebSearchToolResult(result: unknown): WebSearchToolResultDecode {
  if (!isRecord(result) || !hasOnlyKeys(result, new Set(["content", "isError"]))) {
    return { ok: false, reason: "result_not_object" };
  }
  if (result.isError !== false) {
    return {
      ok: false,
      reason: result.isError === true ? "result_reported_error" : "result_content_invalid",
    };
  }
  if (!Array.isArray(result.content) || result.content.length !== 1) {
    return { ok: false, reason: "result_content_invalid" };
  }
  const [item] = result.content;
  if (
    !isRecord(item) ||
    !hasOnlyKeys(item, new Set(["type", "text"])) ||
    item.type !== "text" ||
    typeof item.text !== "string"
  ) {
    return { ok: false, reason: "result_content_invalid" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(item.text);
  } catch {
    return { ok: false, reason: "result_text_not_json" };
  }
  const decoded = decodeWebSearchResultSet(parsed);
  return decoded.ok ? { ...decoded, text: item.text } : decoded;
}
