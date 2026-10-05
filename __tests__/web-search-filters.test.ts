import { describe, expect, test } from "bun:test";
import {
  isVerifiedWebSearchCell,
  isVerifiedWebSearchModel,
  parseMessagesWebSearchTool,
  parseResponsesWebSearchTool,
} from "../src/web-search/declarations.js";
import type { WebSearchResultSet } from "../src/web-search/decoder.js";
import {
  domainFilterAccepts,
  parseDomainRule,
  ruleMatches,
} from "../src/web-search/domain-filter.js";
import { pageAge, projectSearchResult } from "../src/web-search/projection.js";
import { FIXTURE_SOURCES } from "./web-search-test-helpers.js";

function rule(entry: string, allowPath = true) {
  const parsed = parseDomainRule(entry, allowPath);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.rule;
}

describe("domain filtering", () => {
  test("host entries include subdomains; specific subdomains stay specific", () => {
    expect(ruleMatches(rule("example.com"), "https://example.com/a")).toBe(true);
    expect(ruleMatches(rule("example.com"), "https://docs.example.com/a")).toBe(true);
    expect(ruleMatches(rule("example.com"), "https://notexample.com/a")).toBe(false);
    expect(ruleMatches(rule("docs.example.com"), "https://docs.example.com/x")).toBe(true);
    expect(ruleMatches(rule("docs.example.com"), "https://api.example.com/x")).toBe(false);
    expect(ruleMatches(rule("docs.example.com"), "https://example.com/x")).toBe(false);
    expect(ruleMatches(rule("EXAMPLE.com."), "https://Example.COM/")).toBe(true);
  });

  test("paths match on segment boundaries and support path wildcards only", () => {
    const blog = rule("example.com/blog");
    expect(ruleMatches(blog, "https://example.com/blog")).toBe(true);
    expect(ruleMatches(blog, "https://example.com/blog/post-1")).toBe(true);
    expect(ruleMatches(blog, "https://example.com/blogger")).toBe(false);
    expect(ruleMatches(blog, "https://example.com/other/blog")).toBe(false);
    const nested = rule("example.com/*/articles");
    expect(ruleMatches(nested, "https://example.com/en/articles/x")).toBe(true);
    expect(ruleMatches(nested, "https://example.com/en/news")).toBe(false);
    expect(ruleMatches(rule("example.com/*"), "https://example.com/anything")).toBe(true);
  });

  test("rejects malformed entries instead of guessing", () => {
    for (const entry of [
      "https://example.com",
      "*.example.com",
      "ex*.com",
      "example.com:8080",
      "аmazon.com",
      "localhost",
      " example.com",
      "example.com/a?b",
      "",
      7,
    ]) {
      expect(parseDomainRule(entry, true).ok).toBe(false);
    }
    expect(parseDomainRule("example.com/blog", false).ok).toBe(false);
  });

  test("filters use the source URL host, never the backend domain field", () => {
    const allow = { mode: "allow" as const, rules: [rule("github.com")] };
    const block = { mode: "block" as const, rules: [rule("github.com")] };
    expect(domainFilterAccepts(allow, "https://github.com/x")).toBe(true);
    expect(domainFilterAccepts(allow, "https://docs.example.com/x")).toBe(false);
    expect(domainFilterAccepts(block, "https://github.com/x")).toBe(false);
    expect(domainFilterAccepts(block, "https://docs.example.com/x")).toBe(true);
    expect(domainFilterAccepts(undefined, "not a url")).toBe(false);
  });
});

function resultSet(): WebSearchResultSet {
  return {
    schemaVersion: 1,
    query: "fixture",
    totalResults: FIXTURE_SOURCES.length,
    sources: FIXTURE_SOURCES.map(({ id, ...source }) => ({ ...source, backendId: id })),
  };
}

describe("search projection", () => {
  test("passes the backend text through unchanged when nothing is removed", () => {
    const backendText = JSON.stringify({
      results: FIXTURE_SOURCES,
      totalResults: 2,
      query: "fixture",
      error: null,
    });
    const projected = projectSearchResult(resultSet(), backendText);
    expect(projected.modelText).toBe(backendText);
    expect(projected.sources.map((source) => source.ordinal)).toEqual([0, 1]);
    expect(projected.filteredCount).toBe(0);
  });

  test("drops whole sources for filters and the low context budget, never rewriting fields", () => {
    const filtered = projectSearchResult(resultSet(), "unused", {
      filter: { mode: "block", rules: [rule("example.com")] },
    });
    expect(filtered.sources.map((source) => source.url)).toEqual([String(FIXTURE_SOURCES[1]?.url)]);
    expect(filtered.sources[0]?.ordinal).toBe(1);
    const parsed = JSON.parse(filtered.modelText) as { results: unknown[]; totalResults: number };
    expect(parsed.totalResults).toBe(1);
    expect(parsed.results).toEqual([FIXTURE_SOURCES[1]]);
    expect(filtered.filteredCount).toBe(1);

    const many: WebSearchResultSet = {
      ...resultSet(),
      sources: Array.from({ length: 5 }, (_, index) => ({
        ...resultSet().sources[0],
        url: `https://docs.example.com/${index}`,
      })) as WebSearchResultSet["sources"],
    };
    const low = projectSearchResult(many, "unused", { contextSize: "low" });
    expect(low.sources).toHaveLength(3);
    expect(low.budgetDroppedCount).toBe(2);
    expect(projectSearchResult(many, "unused", { contextSize: "high" }).sources).toHaveLength(5);
    const empty = projectSearchResult(many, "unused", {
      filter: { mode: "allow", rules: [rule("nowhere.example")] },
    });
    expect(empty.sources).toEqual([]);
    expect(JSON.parse(empty.modelText)).toEqual({
      results: [],
      totalResults: 0,
      query: "fixture",
      error: null,
    });
  });

  test("page_age is the UTC date of the backend publishedDate", () => {
    expect(pageAge({ publishedDate: 1788586772000 })).toBe("2026-09-05");
    expect(pageAge({})).toBeNull();
  });
});

describe("hosted declarations", () => {
  test("Responses accepts only live search with verified controls", () => {
    const ok = parseResponsesWebSearchTool(
      {
        type: "web_search",
        external_web_access: true,
        search_context_size: "low",
        filters: { allowed_domains: ["example.com"] },
      },
      "tools.0",
    );
    expect(ok.ok && ok.declaration).toMatchObject({
      protocol: "responses",
      publicType: "web_search",
      contextSize: "low",
      filter: { mode: "allow", rules: [{ host: "example.com" }] },
    });
    const rejections: Array<[Record<string, unknown>, string, string]> = [
      [
        { type: "web_search", external_web_access: false },
        "unsupported_web_search_parameter",
        "tools.0.external_web_access",
      ],
      [
        { type: "web_search", indexed_web_access: true },
        "unsupported_web_search_parameter",
        "tools.0.indexed_web_access",
      ],
      [
        { type: "web_search", user_location: { type: "approximate" } },
        "unsupported_web_search_parameter",
        "tools.0.user_location",
      ],
      [
        { type: "web_search", search_content_types: ["image"] },
        "unsupported_web_search_parameter",
        "tools.0.search_content_types",
      ],
      [
        {
          type: "web_search",
          filters: { allowed_domains: ["x.com"], blocked_domains: ["y.com"] },
        },
        "invalid_web_search_declaration",
        "tools.0.filters",
      ],
      [
        { type: "web_search", filters: { excluded_domains: ["x.com"] } },
        "unsupported_web_search_parameter",
        "tools.0.filters.excluded_domains",
      ],
      [
        { type: "web_search", filters: { allowed_domains: ["x.com/path"] } },
        "invalid_web_search_declaration",
        "tools.0.filters.allowed_domains.0",
      ],
      [
        { type: "web_search", search_context_size: "max" },
        "invalid_web_search_declaration",
        "tools.0.search_context_size",
      ],
      [{ type: "web_search_preview" }, "unsupported_web_search", "tools.0"],
    ];
    for (const [tool, code, param] of rejections) {
      expect(parseResponsesWebSearchTool(tool, "tools.0")).toMatchObject({
        ok: false,
        code,
        param,
      });
    }
  });

  test("Responses blocked_domains removes matching hosts", () => {
    const parsed = parseResponsesWebSearchTool(
      { type: "web_search", filters: { blocked_domains: ["github.com"] } },
      "tools.0",
    );
    expect(parsed.ok && parsed.declaration.filter).toEqual({
      mode: "block",
      rules: [{ host: "github.com" }],
    });
  });

  test("Messages accepts the basic tool and rejects every unimplemented control", () => {
    const ok = parseMessagesWebSearchTool(
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 8,
        blocked_domains: ["example.com/blog"],
      },
      "tools.0",
    );
    expect(ok.ok && ok.declaration).toMatchObject({
      protocol: "anthropic-messages",
      maxUses: 8,
      filter: { mode: "block", rules: [{ host: "example.com", path: "/blog" }] },
    });
    const rejections: Array<[Record<string, unknown>, string]> = [
      [{ type: "web_search_20260209", name: "web_search" }, "unsupported_web_search"],
      [{ type: "web_search_20260318", name: "web_search" }, "unsupported_web_search"],
      [{ type: "web_search_20250305", name: "search" }, "invalid_web_search_declaration"],
      [
        { type: "web_search_20250305", name: "web_search", max_uses: 0 },
        "invalid_web_search_declaration",
      ],
      [
        {
          type: "web_search_20250305",
          name: "web_search",
          allowed_domains: ["a.com"],
          blocked_domains: ["b.com"],
        },
        "invalid_web_search_declaration",
      ],
      [
        { type: "web_search_20250305", name: "web_search", user_location: { type: "approximate" } },
        "unsupported_web_search_parameter",
      ],
      [
        {
          type: "web_search_20250305",
          name: "web_search",
          allowed_callers: ["code_execution_20260120"],
        },
        "unsupported_web_search_parameter",
      ],
      [
        { type: "web_search_20250305", name: "web_search", response_inclusion: "excluded" },
        "unsupported_web_search_parameter",
      ],
      // Claude Code sends search_profile only in fast mode; Fast stays rejected.
      [
        { type: "web_search_20250305", name: "web_search", search_profile: "fast" },
        "unsupported_web_search_parameter",
      ],
    ];
    for (const [tool, code] of rejections) {
      expect(parseMessagesWebSearchTool(tool, "tools.0")).toMatchObject({ ok: false, code });
    }
  });

  test("fingerprints change with the declaration and not with its position", () => {
    const first = parseMessagesWebSearchTool(
      { type: "web_search_20250305", name: "web_search", max_uses: 3 },
      "tools.0",
    );
    const moved = parseMessagesWebSearchTool(
      { type: "web_search_20250305", name: "web_search", max_uses: 3 },
      "tools.4",
    );
    const changed = parseMessagesWebSearchTool(
      { type: "web_search_20250305", name: "web_search", max_uses: 4 },
      "tools.0",
    );
    if (!first.ok || !moved.ok || !changed.ok) throw new Error("expected declarations");
    expect(first.declaration.fingerprint).toBe(moved.declaration.fingerprint);
    expect(first.declaration.fingerprint).not.toBe(changed.declaration.fingerprint);
  });

  test("capability cells cover only the verified protocol, model and region", () => {
    expect(isVerifiedWebSearchCell("responses", "gpt-5.6-sol", "us-east-1")).toBe(true);
    expect(isVerifiedWebSearchCell("anthropic-messages", "claude-opus-5.5", "us-east-1")).toBe(
      true,
    );
    expect(isVerifiedWebSearchCell("anthropic-messages", "claude-opus-5", "us-east-1")).toBe(false);
    expect(isVerifiedWebSearchCell("responses", "gpt-5.6-sol", "eu-central-1")).toBe(false);
    expect(isVerifiedWebSearchCell("chat-completions", "gpt-5.6-sol", "us-east-1")).toBe(false);
    expect(isVerifiedWebSearchModel("responses", "gpt-5.6-terra")).toBe(false);
  });
});
