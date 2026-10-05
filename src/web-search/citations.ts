import type { ProjectedSource } from "./projection.js";

/**
 * Citations come only from real markers in the model's own text.
 *
 * The backend tool declaration asks the model to attribute sources with inline
 * markdown links (`[description](url)`). A link becomes a citation only when its
 * URL is one of the sources actually retrieved and handed to the model in this
 * public response. The text is never rewritten: a cited span is exactly the
 * link the model wrote, and unknown or malformed links stay plain text. No
 * prompt is added to encourage citations.
 */

/** Longest candidate link held back while streaming before it is released as text. */
export const MAX_LINK_CHARS = 2048;

export interface CitationSource {
  readonly callId: string;
  readonly source: ProjectedSource;
}

export type CitationSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "cited"; readonly text: string; readonly citation: CitationSource };

function normalizedUrl(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  return parsed.href;
}

/** Retrieved sources by exact and normalized URL; the first retrieval wins. */
export class CitationSourceIndex {
  readonly #byUrl = new Map<string, CitationSource>();

  /** Later searches of this response may take precedence over history with `override`. */
  add(callId: string, sources: readonly ProjectedSource[], override = false): void {
    for (const source of sources) {
      const entry = { callId, source };
      for (const key of [source.url, normalizedUrl(source.url)]) {
        if (key !== undefined && (override || !this.#byUrl.has(key))) this.#byUrl.set(key, entry);
      }
    }
  }

  get size(): number {
    return this.#byUrl.size;
  }

  match(url: string): CitationSource | undefined {
    const exact = this.#byUrl.get(url);
    if (exact !== undefined) return exact;
    const normalized = normalizedUrl(url);
    return normalized === undefined ? undefined : this.#byUrl.get(normalized);
  }
}

type LinkScan =
  | { readonly kind: "link"; readonly end: number; readonly url: string }
  | { readonly kind: "not-link" }
  | { readonly kind: "incomplete" };

/** Scans an inline link starting at `start` (which holds `[`). */
function scanLink(text: string, start: number): LinkScan {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "]") break;
    if (char === "[" || char === "\n") return { kind: "not-link" };
    index += 1;
  }
  if (index >= text.length) return { kind: "incomplete" };
  if (index === start + 1) return { kind: "not-link" };
  index += 1;
  if (index >= text.length) return { kind: "incomplete" };
  if (text[index] !== "(") return { kind: "not-link" };
  const urlStart = index + 1;
  let depth = 0;
  index = urlStart;
  while (index < text.length) {
    const char = text[index] as string;
    if (/\s/u.test(char)) return { kind: "not-link" };
    if (char === "(") depth += 1;
    else if (char === ")") {
      if (depth === 0) {
        if (index === urlStart) return { kind: "not-link" };
        return { kind: "link", end: index + 1, url: text.slice(urlStart, index) };
      }
      depth -= 1;
    }
    index += 1;
  }
  return { kind: "incomplete" };
}

/**
 * Incremental splitter for streamed text. Text is released immediately except
 * a candidate link that has not closed yet, which is held back so a cited span
 * can open its own block. Held text never exceeds MAX_LINK_CHARS.
 */
export class CitationScanner {
  #pending = "";

  constructor(private readonly sources: CitationSourceIndex) {}

  push(delta: string): CitationSegment[] {
    return this.#scan(this.#pending + delta, false);
  }

  flush(): CitationSegment[] {
    return this.#scan(this.#pending, true);
  }

  #scan(text: string, final: boolean): CitationSegment[] {
    this.#pending = "";
    const segments: CitationSegment[] = [];
    let plainStart = 0;
    let cursor = 0;
    const pushText = (end: number): void => {
      if (end > plainStart) segments.push({ kind: "text", text: text.slice(plainStart, end) });
    };
    while (cursor < text.length) {
      const open = text.indexOf("[", cursor);
      if (open < 0) break;
      const scan = scanLink(text, open);
      if (scan.kind === "incomplete") {
        if (!final && text.length - open <= MAX_LINK_CHARS) {
          pushText(open);
          this.#pending = text.slice(open);
          return segments;
        }
        cursor = open + 1;
        continue;
      }
      if (scan.kind === "not-link") {
        cursor = open + 1;
        continue;
      }
      const citation = this.sources.match(scan.url);
      if (citation === undefined) {
        cursor = scan.end;
        continue;
      }
      pushText(open);
      segments.push({ kind: "cited", text: text.slice(open, scan.end), citation });
      plainStart = scan.end;
      cursor = scan.end;
    }
    pushText(text.length);
    return segments;
  }
}

export function citationSegments(text: string, sources: CitationSourceIndex): CitationSegment[] {
  const scanner = new CitationScanner(sources);
  return [...scanner.push(text), ...scanner.flush()];
}

/** Unicode code point length, used for public citation offsets. */
export function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/**
 * A verbatim leading excerpt of the source snippet: at most 150 code points and
 * at most the source's `maxVerbatimWordLimit` words, cut on a word boundary and
 * never padded with an ellipsis. Too-long first words yield an empty excerpt
 * rather than a fabricated fragment.
 */
export function citedTextExcerpt(
  source: Pick<ProjectedSource, "snippet" | "maxVerbatimWordLimit">,
): string {
  const snippet = source.snippet.trimStart();
  const limit = Math.min(source.maxVerbatimWordLimit, Number.MAX_SAFE_INTEGER);
  if (limit <= 0 || snippet.length === 0) return "";
  let end = 0;
  let words = 0;
  const pattern = /\S+/gu;
  for (let match = pattern.exec(snippet); match !== null; match = pattern.exec(snippet)) {
    const candidateEnd = match.index + match[0].length;
    if (words >= limit || codePointLength(snippet.slice(0, candidateEnd)) > 150) break;
    end = candidateEnd;
    words += 1;
  }
  return snippet.slice(0, end);
}
