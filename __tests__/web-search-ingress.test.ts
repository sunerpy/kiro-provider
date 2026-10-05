import { describe, expect, test } from "bun:test";
import {
  ACCOUNT_PROFILE_ARN,
  FIXTURE_SOURCES,
  FIXTURE_TOOL_DESCRIPTION,
  FIXTURE_TOOL_SCHEMA,
  searchCallGeneration,
  sseData,
  textGeneration,
  webSearchFixture,
} from "./web-search-test-helpers.js";

// Full public-ingress reproducers for provider-executed hosted search. They
// enter through createApp with the payload shapes captured from Codex 0.159.3
// (`web_search` live) and Claude Code 2.1.285 (WebSearch side request), and
// assert the observable contract end to end: one real InvokeMCP call with the
// model's query, the authentic result handed back to the same Kiro
// conversation, and protocol-native search items and citations.

const QUERY = "fixture runtime latest release";
const LINK = `[official release notes](${FIXTURE_SOURCES[0]?.url})`;
const FINAL_TEXT = `Fixture Runtime 9.9 is the latest release, per the ${LINK}.`;

function responsesBody(stream: boolean): Record<string, unknown> {
  return {
    model: "gpt-5.6-sol",
    store: false,
    stream,
    input: [{ role: "user", content: [{ type: "input_text", text: "What is new in Fixture?" }] }],
    tools: [{ type: "web_search", external_web_access: true }],
    tool_choice: "auto",
    include: ["reasoning.encrypted_content", "web_search_call.action.sources"],
  };
}

function claudeSideQuery(stream: boolean): Record<string, unknown> {
  return {
    model: "claude-opus-5-5",
    max_tokens: 128_000,
    stream,
    system: [{ type: "text", text: "You are an assistant for performing a web search tool use" }],
    messages: [{ role: "user", content: `Perform a web search for the query: ${QUERY}` }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
    tool_choice: { type: "auto" },
    output_config: { effort: "max" },
    metadata: { user_id: "fixture-user" },
  };
}

function expectSearchRoundTrip(fixture: ReturnType<typeof webSearchFixture>): void {
  const calls = fixture.mcpCalls.filter((call) => call.method === "tools/call");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.params).toEqual({ name: "web_search", arguments: { query: QUERY } });
  expect(calls[0]?.target).toBe("KiroRuntimeService.InvokeMCP");
  expect(calls[0]?.userAgent?.startsWith("kiro-provider/")).toBe(true);
  expect(calls[0]?.profileArn).toBe(ACCOUNT_PROFILE_ARN);
  expect(fixture.inputs).toHaveLength(2);
  const first = fixture.inputs[0]?.conversationState;
  const second = fixture.inputs[1]?.conversationState;
  const declared = first?.currentMessage?.userInputMessage?.userInputMessageContext?.tools ?? [];
  expect(declared).toContainEqual({
    toolSpecification: {
      name: "web_search",
      description: FIXTURE_TOOL_DESCRIPTION,
      inputSchema: { json: FIXTURE_TOOL_SCHEMA },
    },
  } as unknown as (typeof declared)[number]);
  expect(second?.conversationId).toBe(first?.conversationId);
  const assistant = second?.history?.at(-1)?.assistantResponseMessage;
  expect(assistant?.toolUses).toEqual([
    { toolUseId: "call_fixture_search_0001", name: "web_search", input: { query: QUERY } },
  ]);
  const results = second?.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults;
  expect(results).toHaveLength(1);
  expect(results?.[0]?.toolUseId).toBe("call_fixture_search_0001");
  expect(results?.[0]?.status).toBe("success");
  const projected = JSON.parse(String(results?.[0]?.content?.[0]?.text)) as {
    readonly results: ReadonlyArray<{ readonly url: string }>;
  };
  expect(projected.results.map((source) => source.url)).toEqual(
    FIXTURE_SOURCES.map((source) => source.url),
  );
}

describe("hosted web search through public ingress", () => {
  test("Responses non-stream executes the search and cites the retrieved source", async () => {
    const fixture = webSearchFixture([searchCallGeneration(QUERY), textGeneration(FINAL_TEXT)]);
    const response = await fixture.post("/v1/responses", responsesBody(false));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-kiro-transport")).toBe("stateless");
    const body = (await response.json()) as {
      readonly output: ReadonlyArray<Record<string, unknown>>;
      readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
    };
    expect(body.output.map((item) => item.type)).toEqual(["web_search_call", "message"]);
    const call = body.output[0] as Record<string, unknown>;
    expect(String(call.id)).toMatch(/^ws_[0-9a-f]{32}$/);
    expect(call.status).toBe("completed");
    expect(call.action).toEqual({
      type: "search",
      query: QUERY,
      queries: [QUERY],
      sources: FIXTURE_SOURCES.map((source) => ({ type: "url", url: source.url })),
    });
    const part = (body.output[1]?.content as ReadonlyArray<Record<string, unknown>>)[0];
    expect(part?.text).toBe(FINAL_TEXT);
    const start = FINAL_TEXT.indexOf(LINK);
    expect(part?.annotations).toEqual([
      {
        type: "url_citation",
        start_index: start,
        end_index: start + LINK.length,
        url: FIXTURE_SOURCES[0]?.url,
        title: FIXTURE_SOURCES[0]?.title,
      },
    ]);
    expect(body.usage.input_tokens).toBe(40);
    expect(body.usage.output_tokens).toBe(10);
    expectSearchRoundTrip(fixture);
  });

  test("Responses stream publishes one lifecycle with ordered search and citation events", async () => {
    const fixture = webSearchFixture([searchCallGeneration(QUERY), textGeneration(FINAL_TEXT)]);
    const response = await fixture.post("/v1/responses", responsesBody(true));
    expect(response.status).toBe(200);
    const events = sseData(await response.text());
    const types = events.map((event) => event.type);
    expect(types.filter((type) => type === "response.created")).toHaveLength(1);
    expect(types.filter((type) => type === "response.in_progress")).toHaveLength(1);
    expect(
      types.filter((type) => type === "response.completed" || type === "response.failed"),
    ).toEqual(["response.completed"]);
    expect(types.at(-1)).toBe("response.completed");
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
    const searchIndex = types.indexOf("response.web_search_call.in_progress");
    expect(searchIndex).toBeGreaterThan(0);
    expect(types.slice(searchIndex, searchIndex + 3)).toEqual([
      "response.web_search_call.in_progress",
      "response.web_search_call.searching",
      "response.web_search_call.completed",
    ]);
    const annotation = events.find(
      (event) => event.type === "response.output_text.annotation.added",
    );
    expect(annotation?.output_index).toBe(1);
    expect((annotation?.annotation as Record<string, unknown>)?.url).toBe(FIXTURE_SOURCES[0]?.url);
    const completed = events.at(-1)?.response as {
      readonly output: ReadonlyArray<Record<string, unknown>>;
    };
    expect(completed.output.map((item) => item.type)).toEqual(["web_search_call", "message"]);
    expectSearchRoundTrip(fixture);
  });

  test("Messages non-stream answers the Claude Code side request with search blocks and citations", async () => {
    const fixture = webSearchFixture([searchCallGeneration(QUERY), textGeneration(FINAL_TEXT)]);
    const response = await fixture.post("/v1/messages", claudeSideQuery(false));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly content: ReadonlyArray<Record<string, unknown>>;
      readonly stop_reason: string;
      readonly usage: Record<string, unknown>;
    };
    expect(body.stop_reason).toBe("end_turn");
    expect(body.content.map((block) => block.type)).toEqual([
      "server_tool_use",
      "web_search_tool_result",
      "text",
      "text",
      "text",
    ]);
    const use = body.content[0] as Record<string, unknown>;
    expect(String(use.id)).toMatch(/^srvtoolu_[0-9a-f]{32}$/);
    expect(use).toMatchObject({ name: "web_search", input: { query: QUERY } });
    const result = body.content[1] as Record<string, unknown>;
    expect(result.tool_use_id).toBe(use.id);
    const results = result.content as ReadonlyArray<Record<string, unknown>>;
    expect(results.map((entry) => [entry.type, entry.url, entry.title])).toEqual(
      FIXTURE_SOURCES.map((source) => ["web_search_result", source.url, source.title]),
    );
    for (const entry of results) {
      expect(typeof entry.encrypted_content).toBe("string");
      expect(String(entry.encrypted_content).length).toBeGreaterThan(0);
      expect(entry.page_age === null || /^\d{4}-\d{2}-\d{2}$/.test(String(entry.page_age))).toBe(
        true,
      );
    }
    expect(body.content.slice(2).map((block) => block.text)).toEqual([
      "Fixture Runtime 9.9 is the latest release, per the ",
      LINK,
      ".",
    ]);
    const citations = (body.content[3] as Record<string, unknown>).citations as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      type: "web_search_result_location",
      url: FIXTURE_SOURCES[0]?.url,
      title: FIXTURE_SOURCES[0]?.title,
    });
    expect(String(citations[0]?.cited_text).length).toBeLessThanOrEqual(150);
    expect(FIXTURE_SOURCES[0]?.snippet.startsWith(String(citations[0]?.cited_text))).toBe(true);
    expect(String(citations[0]?.encrypted_index).length).toBeGreaterThan(0);
    expect(body.usage.server_tool_use).toEqual({ web_search_requests: 1 });
    expect(body.usage.input_tokens).toBe(40);
    expect(body.usage.output_tokens).toBe(10);
    expectSearchRoundTrip(fixture);
  });

  test("Messages stream orders server tool, result and cited text blocks", async () => {
    const fixture = webSearchFixture([searchCallGeneration(QUERY), textGeneration(FINAL_TEXT)]);
    const response = await fixture.post("/v1/messages", claudeSideQuery(true));
    expect(response.status).toBe(200);
    const events = sseData(await response.text());
    const starts = events.filter((event) => event.type === "content_block_start");
    expect(starts.map((event) => (event.content_block as Record<string, unknown>).type)).toEqual([
      "server_tool_use",
      "web_search_tool_result",
      "text",
      "text",
      "text",
    ]);
    expect(starts.map((event) => event.index)).toEqual([0, 1, 2, 3, 4]);
    expect(
      events.some(
        (event) =>
          event.type === "content_block_delta" &&
          (event.delta as Record<string, unknown>).type === "citations_delta",
      ),
    ).toBe(true);
    const delta = events.find((event) => event.type === "message_delta");
    expect((delta?.delta as Record<string, unknown>).stop_reason).toBe("end_turn");
    expect((delta?.usage as Record<string, unknown>).server_tool_use).toEqual({
      web_search_requests: 1,
    });
    expect(events.at(-1)?.type).toBe("message_stop");
    expect(events.filter((event) => event.type === "error")).toHaveLength(0);
    expectSearchRoundTrip(fixture);
  });
});
