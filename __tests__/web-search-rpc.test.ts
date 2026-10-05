import { describe, expect, test } from "bun:test";
import packageMetadata from "../package.json" with { type: "json" };
import { decodeWebSearchResultSet, decodeWebSearchToolResult } from "../src/web-search/decoder.js";
import {
  callWebSearch,
  KIRO_MCP_TARGET,
  listWebSearchTool,
  MAX_WEB_SEARCH_QUERY_BYTES,
  type McpCallContext,
  runtimeEndpointFor,
  webSearchErrorCode,
  webSearchQueryFingerprint,
} from "../src/web-search/mcp-client.js";
import {
  FIXTURE_SOURCES,
  FIXTURE_TOOL_DESCRIPTION,
  FIXTURE_TOOL_SCHEMA,
} from "./web-search-test-helpers.js";

interface Captured {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: Record<string, unknown>;
}

function context(
  respond: (body: Record<string, unknown>) => Response | Promise<Response>,
  overrides: Partial<McpCallContext> = {},
): { readonly context: McpCallContext; readonly captured: Captured[] } {
  const captured: Captured[] = [];
  return {
    captured,
    context: {
      accessToken: "access-secret",
      profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/fixture",
      region: "us-east-1",
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      fetch: async (url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        captured.push({ url, init, body });
        return respond(body);
      },
      ...overrides,
    },
  };
}

function rpcResult(id: unknown, result: unknown): Response {
  return Response.json({ id, jsonrpc: "2.0", result });
}

function searchResult(
  sources: unknown[] = [...FIXTURE_SOURCES],
  extra: Record<string, unknown> = {},
) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          results: sources,
          totalResults: sources.length,
          query: "q",
          error: null,
          ...extra,
        }),
      },
    ],
    isError: false,
  };
}

describe("InvokeMCP web search client", () => {
  test("sends the evidenced JSON-RPC request with an honest user agent", async () => {
    const fixture = context((body) => rpcResult(body.id, searchResult()));
    const outcome = await callWebSearch(fixture.context, "fixture query", 65_536);
    expect(outcome.ok).toBe(true);
    const [call] = fixture.captured;
    expect(call?.url).toBe("https://runtime.us-east-1.kiro.dev/");
    const headers = new Headers(call?.init.headers);
    expect(headers.get("x-amz-target")).toBe(KIRO_MCP_TARGET);
    expect(headers.get("content-type")).toBe("application/x-amz-json-1.0");
    expect(headers.get("user-agent")).toBe(`kiro-provider/${packageMetadata.version}`);
    expect(headers.get("authorization")).toBe("Bearer access-secret");
    expect(call?.body).toMatchObject({
      profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/fixture",
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "web_search", arguments: { query: "fixture query" } },
    });
    expect(typeof call?.body.id).toBe("string");
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.result.sources.map((source) => source.url)).toEqual(
      FIXTURE_SOURCES.map((source) => source.url),
    );
    expect(outcome.result.sources[0]?.backendId).toBe("0");
    expect(outcome.resultText).toBe(String(searchResult().content[0]?.text));
  });

  test("lists the backend's own web_search declaration and fingerprints it", async () => {
    const fixture = context((body) =>
      rpcResult(body.id, {
        tools: [
          {
            name: "web_search",
            description: FIXTURE_TOOL_DESCRIPTION,
            inputSchema: FIXTURE_TOOL_SCHEMA,
          },
        ],
      }),
    );
    const tool = await listWebSearchTool(fixture.context);
    expect(tool).toMatchObject({
      name: "web_search",
      description: FIXTURE_TOOL_DESCRIPTION,
      inputSchema: FIXTURE_TOOL_SCHEMA,
    });
    expect(tool.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.captured[0]?.body).toMatchObject({ method: "tools/list", params: {} });
  });

  test("rejects a tool list without exactly one usable web_search declaration", async () => {
    for (const tools of [
      [],
      [{ name: "web_search", description: "", inputSchema: FIXTURE_TOOL_SCHEMA }],
      [{ name: "web_search", description: "d", inputSchema: { type: "object" } }],
      [
        { name: "web_search", description: "d", inputSchema: FIXTURE_TOOL_SCHEMA },
        { name: "web_search", description: "e", inputSchema: FIXTURE_TOOL_SCHEMA },
      ],
    ]) {
      const fixture = context((body) => rpcResult(body.id, { tools }));
      await expect(listWebSearchTool(fixture.context)).rejects.toMatchObject({
        failure: "tool_definition_invalid",
      });
    }
  });

  test("never reaches an unverified region or a client-chosen endpoint", async () => {
    const fixture = context((body) => rpcResult(body.id, searchResult()), { region: "eu-west-1" });
    const outcome = await callWebSearch(fixture.context, "q", 65_536);
    expect(outcome).toMatchObject({ ok: false, failure: "region_unverified", dispatched: false });
    expect(fixture.captured).toHaveLength(0);
    expect(runtimeEndpointFor("us-east-1")).toBe("https://runtime.us-east-1.kiro.dev/");
    expect(runtimeEndpointFor("us-east-1", "https://test.invalid")).toBe("https://test.invalid/");
  });

  test("validates the query locally and never truncates it", async () => {
    const fixture = context((body) => rpcResult(body.id, searchResult()));
    expect(await callWebSearch(fixture.context, "   ", 65_536)).toMatchObject({
      ok: false,
      failure: "query_empty",
      dispatched: false,
    });
    const oversized = "é".repeat(MAX_WEB_SEARCH_QUERY_BYTES / 2 + 1);
    expect(await callWebSearch(fixture.context, oversized, 65_536)).toMatchObject({
      ok: false,
      failure: "query_too_long",
      dispatched: false,
    });
    expect(fixture.captured).toHaveLength(0);
    expect(webSearchErrorCode("query_too_long")).toBe("query_too_long");
    expect(webSearchErrorCode("query_empty")).toBe("invalid_tool_input");
  });

  test("treats HTTP 200 JSON-RPC errors and tool-reported errors as failures", async () => {
    const cases: Array<[unknown, string]> = [
      [
        { error: { code: -32602, message: "Invalid tool parameters provided" } },
        "rpc_invalid_params",
      ],
      [{ error: { code: -32603, message: "internal" } }, "rpc_error"],
      [{ result: { ...searchResult(), isError: true } }, "result_reported_error"],
      [{ result: searchResult([], { error: "rate limited" }) }, "result_reported_error"],
      [
        { result: { content: [{ type: "text", text: "not json" }], isError: false } },
        "result_text_not_json",
      ],
      [{ result: searchResult([{ ...FIXTURE_SOURCES[0], novel: 1 }]) }, "result_schema_mismatch"],
      [{ result: { content: [], isError: false } }, "result_content_invalid"],
    ];
    for (const [payload, failure] of cases) {
      const fixture = context((body) =>
        Response.json({ id: body.id, jsonrpc: "2.0", ...(payload as Record<string, unknown>) }),
      );
      expect(await callWebSearch(fixture.context, "q", 65_536)).toMatchObject({
        ok: false,
        failure,
        dispatched: true,
      });
    }
    expect(webSearchErrorCode("rpc_invalid_params")).toBe("invalid_tool_input");
    expect(webSearchErrorCode("result_schema_mismatch")).toBe("unavailable");
  });

  test("maps transport outcomes to typed failures without echoing bodies", async () => {
    const statuses: Array<[number, string, ReturnType<typeof webSearchErrorCode>]> = [
      [429, "http_throttled", "too_many_requests"],
      [403, "http_access_denied", "unavailable"],
      [400, "http_client_error", "unavailable"],
      [503, "http_server_error", "unavailable"],
    ];
    for (const [status, failure, code] of statuses) {
      const fixture = context(() => new Response("secret upstream detail", { status }));
      const outcome = await callWebSearch(fixture.context, "q", 65_536);
      expect(outcome).toMatchObject({ ok: false, failure, status });
      if (!outcome.ok) expect(webSearchErrorCode(outcome.failure)).toBe(code);
      expect(JSON.stringify(outcome)).not.toContain("secret");
    }
    const mismatch = context(() => rpcResult("another-id", searchResult()));
    expect(await callWebSearch(mismatch.context, "q", 65_536)).toMatchObject({
      ok: false,
      failure: "rpc_id_mismatch",
    });
    const broken = context(() => {
      throw new TypeError("socket hang up");
    });
    expect(await callWebSearch(broken.context, "q", 65_536)).toMatchObject({
      ok: false,
      failure: "transport_error",
      dispatched: true,
    });
  });

  test("bounds the response size while reading", async () => {
    const big = context((body) => rpcResult(body.id, searchResult()));
    expect(await callWebSearch(big.context, "q", 256)).toMatchObject({
      ok: false,
      failure: "response_too_large",
    });
  });

  test("applies the timeout and the request cancellation signal", async () => {
    const slow = context((_body) => new Promise<Response>(() => undefined), { timeoutMs: 20 });
    const hanging: McpCallContext = {
      ...slow.context,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    };
    expect(await callWebSearch(hanging, "q", 65_536)).toMatchObject({
      ok: false,
      failure: "timeout",
    });
    const controller = new AbortController();
    const cancelled = callWebSearch(
      { ...hanging, timeoutMs: 5_000, signal: controller.signal },
      "q",
      65_536,
    );
    controller.abort(new DOMException("client gone", "AbortError"));
    expect(await cancelled).toMatchObject({ ok: false, failure: "aborted", dispatched: true });
  });

  test("decoder accepts the evidenced shape and rejects drift", () => {
    expect(
      decodeWebSearchResultSet({ results: [], totalResults: 0, query: "q", error: null }),
    ).toMatchObject({
      ok: true,
      value: { sources: [], totalResults: 0 },
    });
    const withoutDate = { ...FIXTURE_SOURCES[0] } as Record<string, unknown>;
    delete withoutDate.publishedDate;
    const decoded = decodeWebSearchResultSet({
      results: [withoutDate],
      totalResults: 1,
      query: "q",
      error: null,
    });
    expect(decoded.ok && decoded.value.sources[0]?.publishedDate).toBeUndefined();
    for (const drift of [
      { results: [], totalResults: 0, query: "q", error: null, extra: true },
      {
        results: [{ ...FIXTURE_SOURCES[0], url: "ftp://example.com" }],
        totalResults: 1,
        query: "q",
        error: null,
      },
      {
        results: [{ ...FIXTURE_SOURCES[0], publishedDate: "2026-01-01" }],
        totalResults: 1,
        query: "q",
        error: null,
      },
      {
        results: [{ ...FIXTURE_SOURCES[0], maxVerbatimWordLimit: -1 }],
        totalResults: 1,
        query: "q",
        error: null,
      },
      { results: "none", totalResults: 0, query: "q", error: null },
    ]) {
      expect(decodeWebSearchResultSet(drift).ok).toBe(false);
    }
    expect(
      decodeWebSearchToolResult({ content: [{ type: "image", text: "x" }], isError: false }).ok,
    ).toBe(false);
  });

  test("query fingerprints are stable digests, not the query", () => {
    expect(webSearchQueryFingerprint("abc")).toBe(webSearchQueryFingerprint("abc"));
    expect(webSearchQueryFingerprint("abc")).not.toBe(webSearchQueryFingerprint("abd"));
    expect(webSearchQueryFingerprint("abc")).not.toContain("abc");
  });
});
