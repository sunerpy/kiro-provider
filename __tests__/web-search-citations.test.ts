import { describe, expect, test } from "bun:test";
import {
  CitationScanner,
  CitationSourceIndex,
  citationSegments,
  citedTextExcerpt,
  codePointLength,
  MAX_LINK_CHARS,
} from "../src/web-search/citations.js";
import type { ProjectedSource } from "../src/web-search/projection.js";

function source(url: string, ordinal = 0, snippet = "Snippet text."): ProjectedSource {
  return {
    ordinal,
    title: `Title ${ordinal}`,
    url,
    snippet,
    backendId: String(ordinal),
    domain: new URL(url).hostname,
    maxVerbatimWordLimit: 30,
    publicDomain: true,
  };
}

function index(...urls: string[]): CitationSourceIndex {
  const sources = new CitationSourceIndex();
  sources.add(
    "ws_call",
    urls.map((url, ordinal) => source(url, ordinal)),
  );
  return sources;
}

const A = "https://docs.example.com/a";
const B = "https://en.wikipedia.org/wiki/Claude_(disambiguation)";

describe("citation markers", () => {
  test("cites only inline links that point at retrieved sources, keeping text verbatim", () => {
    const text = `See [the docs](${A}), [elsewhere](https://unknown.example/x) and [wiki](${B}).`;
    const segments = citationSegments(text, index(A, B));
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
    expect(
      segments.filter((segment) => segment.kind === "cited").map((segment) => segment.text),
    ).toEqual([`[the docs](${A})`, `[wiki](${B})`]);
    const cited = segments.filter((segment) => segment.kind === "cited");
    expect(
      cited.map((segment) => segment.kind === "cited" && segment.citation.source.ordinal),
    ).toEqual([0, 1]);
  });

  test("ignores bare URLs, empty labels and malformed links", () => {
    const sources = index(A);
    for (const text of [
      `bare ${A} url`,
      `[](${A})`,
      `[label] (${A})`,
      `[label](${A} "title")`,
      `[a\nb](${A})`,
    ]) {
      expect(citationSegments(text, sources).every((segment) => segment.kind === "text")).toBe(
        true,
      );
    }
  });

  test("matches normalized URLs but not different paths", () => {
    const sources = index("https://Docs.Example.com:443/a");
    expect(citationSegments(`[x](${A})`, sources)[0]?.kind).toBe("cited");
    expect(citationSegments("[x](https://docs.example.com/a/b)", sources)[0]?.kind).toBe("text");
  });

  test("streams across chunk boundaries and holds back only an open candidate", () => {
    const text = `Before [the docs](${A}) after.`;
    for (let split = 1; split < text.length; split += 1) {
      const scanner = new CitationScanner(index(A));
      const segments = [
        ...scanner.push(text.slice(0, split)),
        ...scanner.push(text.slice(split)),
        ...scanner.flush(),
      ];
      expect(segments.map((segment) => segment.text).join("")).toBe(text);
      expect(segments.filter((segment) => segment.kind === "cited")).toHaveLength(1);
    }
    const scanner = new CitationScanner(index(A));
    expect(scanner.push("plain [open")).toEqual([{ kind: "text", text: "plain " }]);
    expect(scanner.flush()).toEqual([{ kind: "text", text: "[open" }]);
  });

  test("releases an overlong candidate instead of buffering without bound", () => {
    const scanner = new CitationScanner(index(A));
    const long = `[${"x".repeat(MAX_LINK_CHARS + 10)}`;
    const released = scanner.push(long);
    expect(released.map((segment) => segment.text).join("")).toBe(long);
  });

  test("offsets count Unicode code points", () => {
    const text = `中文 😀 [源](${A})`;
    const segments = citationSegments(text, index(A));
    const before = segments[0]?.text ?? "";
    expect(codePointLength(before)).toBe(5);
    expect(codePointLength(`[源](${A})`)).toBe(`[源](${A})`.length);
  });

  test("cited_text is a bounded verbatim prefix of the real snippet", () => {
    const long = "word ".repeat(80).trim();
    const excerpt = citedTextExcerpt({ snippet: long, maxVerbatimWordLimit: 30 });
    expect(long.startsWith(excerpt)).toBe(true);
    expect(excerpt.split(" ")).toHaveLength(30);
    const chars = "abcdefghij ".repeat(40);
    const bounded = citedTextExcerpt({ snippet: chars, maxVerbatimWordLimit: 1000 });
    expect(codePointLength(bounded)).toBeLessThanOrEqual(150);
    expect(chars.startsWith(bounded)).toBe(true);
    expect(bounded.endsWith(" ")).toBe(false);
    expect(citedTextExcerpt({ snippet: "x".repeat(200), maxVerbatimWordLimit: 30 })).toBe("");
    expect(citedTextExcerpt({ snippet: "  leading space", maxVerbatimWordLimit: 1 })).toBe(
      "leading",
    );
    expect(citedTextExcerpt({ snippet: "anything", maxVerbatimWordLimit: 0 })).toBe("");
  });
});
