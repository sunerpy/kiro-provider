import type { WebSearchResultSet, WebSearchSource } from "./decoder.js";
import { type DomainFilter, domainFilterAccepts } from "./domain-filter.js";

/**
 * What the model actually receives for one executed search, and the sources
 * that projection is made of.
 *
 * The model-visible text keeps the backend's own JSON shape and field names.
 * When neither a domain filter nor the context budget removes a source, the
 * backend text is passed through byte for byte. Otherwise the kept sources are
 * re-serialized in their original order and field order, and `totalResults`
 * states how many are present. Sources are only ever dropped whole: titles,
 * URLs, snippets and dates are never rewritten or truncated.
 */

export type SearchContextSize = "low" | "medium" | "high";

/**
 * Explicit budget policy for `search_context_size`. Kiro returns at most ten
 * results per query, so `medium` (the default) and `high` both keep every
 * source; `low` keeps the first three that survive filtering.
 */
export const SEARCH_CONTEXT_SOURCE_LIMIT: Readonly<Record<SearchContextSize, number>> = {
  low: 3,
  medium: Number.POSITIVE_INFINITY,
  high: Number.POSITIVE_INFINITY,
};

export interface ProjectedSource extends WebSearchSource {
  /** Position in the backend result list; stable identity inside a snapshot. */
  readonly ordinal: number;
}

export interface SearchProjection {
  readonly modelText: string;
  readonly sources: readonly ProjectedSource[];
  readonly retrievedCount: number;
  readonly filteredCount: number;
  readonly budgetDroppedCount: number;
}

function serializeSource(source: WebSearchSource): Record<string, unknown> {
  return {
    title: source.title,
    url: source.url,
    snippet: source.snippet,
    ...(source.publishedDate !== undefined ? { publishedDate: source.publishedDate } : {}),
    id: source.backendId,
    domain: source.domain,
    maxVerbatimWordLimit: source.maxVerbatimWordLimit,
    publicDomain: source.publicDomain,
  };
}

export function projectSearchResult(
  result: WebSearchResultSet,
  backendText: string,
  options: {
    readonly filter?: DomainFilter;
    readonly contextSize?: SearchContextSize;
  } = {},
): SearchProjection {
  const indexed = result.sources.map((source, ordinal) => ({ ...source, ordinal }));
  const accepted = indexed.filter((source) => domainFilterAccepts(options.filter, source.url));
  const limit = SEARCH_CONTEXT_SOURCE_LIMIT[options.contextSize ?? "medium"];
  const kept = accepted.slice(0, limit);
  const unchanged = kept.length === indexed.length;
  return {
    modelText: unchanged
      ? backendText
      : JSON.stringify({
          results: kept.map(serializeSource),
          totalResults: kept.length,
          query: result.query,
          error: null,
        }),
    sources: kept,
    retrievedCount: indexed.length,
    filteredCount: indexed.length - accepted.length,
    budgetDroppedCount: accepted.length - kept.length,
  };
}

/** UTC calendar date for Messages `page_age`; null when the backend gave none. */
export function pageAge(source: Pick<WebSearchSource, "publishedDate">): string | null {
  if (source.publishedDate === undefined) return null;
  const date = new Date(source.publishedDate);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}
