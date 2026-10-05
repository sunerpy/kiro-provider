import { describe, expect, test } from "bun:test";
import { parseCanonicalOutputEvent } from "../src/protocol/output.js";
import {
  parseAnyCanonicalOutputEventLine,
  parseCanonicalCompletionV2,
  parseCanonicalOutputEventV2,
  parseCanonicalOutputEventV2Line,
} from "../src/protocol/output-v2.js";
import { adaptAnthropicMessagesRequest } from "../src/server/anthropic/request-adapter.js";
import { parseResponsesRequest } from "../src/server/request-schema.js";
import {
  adaptResponsesRequest,
  validateToolDeclarations,
} from "../src/server/responses/request-adapter.js";

// Wire-level contracts for hosted search: the canonical v2 schema and the
// request adapters' validation of hosted declarations and replayed history.

const v2 = (body: Record<string, unknown>) => ({ canonicalOutputVersion: 2, ...body });
const SOURCE = { ordinal: 0, url: "https://a.example/", title: "A", pageAge: null };
const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

describe("canonical output v2", () => {
  test.each([
    [{ type: "started", conversationId: "c", model: "m", createdAt: 1 }],
    [{ type: "text_delta", text: "x" }],
    [{ type: "tool_call_delta", index: 0, id: "t", name: "f", arguments: "{}" }],
    [{ type: "search_call_started", callId: "s", query: "q", deferred: false }],
    [{ type: "search_result", callId: "s", sources: [SOURCE] }],
    [{ type: "search_result", callId: "s", sources: [{ ...SOURCE, encryptedContent: "kws1_x" }] }],
    [{ type: "search_call_completed", callId: "s" }],
    [{ type: "search_call_failed", callId: "s", errorCode: "unavailable" }],
    [
      {
        type: "citation",
        text: "[a](https://a.example/)",
        callId: "s",
        ordinal: 0,
        url: "https://a.example/",
        title: "A",
        citedText: "excerpt",
        encryptedIndex: "kws1_y",
      },
    ],
    [{ type: "generation_boundary" }],
    [{ type: "generation_started", key: "0123456789abcdef" }],
    [{ type: "completed", finishReason: "pause", usage: USAGE, webSearchRequests: 0 }],
  ])("accepts %j", (body) => {
    expect(parseCanonicalOutputEventV2(v2(body))).toEqual(v2(body) as never);
  });

  test.each([
    [{ type: "completed", finishReason: "stop", usage: USAGE, webSearchRequests: 0 }, 1],
    [{ type: "text_delta", text: "x" }, 1],
    [{ type: "unknown" }, 2],
    [{ type: 7 }, 2],
    [{ type: "search_call_started", callId: "", query: "q", deferred: false }, 2],
    [{ type: "search_call_started", callId: "s", query: "q", deferred: "no" }, 2],
    [{ type: "search_result", callId: "s", sources: [{ ...SOURCE, extra: 1 }] }, 2],
    [{ type: "search_result", callId: "s", sources: [{ ...SOURCE, pageAge: 5 }] }, 2],
    [{ type: "search_result", callId: "s", sources: "none" }, 2],
    [{ type: "search_call_completed", callId: "s", extra: true }, 2],
    [{ type: "search_call_failed", callId: "s", errorCode: "" }, 2],
    [
      { type: "citation", text: "", callId: "s", ordinal: 0, url: "u", title: "t", citedText: "" },
      2,
    ],
    [
      {
        type: "citation",
        text: "x",
        callId: "s",
        ordinal: 0,
        url: "u",
        title: "t",
        citedText: "",
        encryptedIndex: "",
      },
      2,
    ],
    [{ type: "generation_boundary", extra: 1 }, 2],
    [{ type: "generation_started", key: "XYZ" }, 2],
    [{ type: "completed", finishReason: "length", usage: USAGE, webSearchRequests: 0 }, 2],
    [
      { type: "completed", finishReason: "stop", usage: { inputTokens: -1 }, webSearchRequests: 0 },
      2,
    ],
    [{ type: "completed", finishReason: "stop", usage: USAGE, webSearchRequests: 1.5 }, 2],
    [
      {
        type: "completed",
        finishReason: "stop",
        usage: USAGE,
        webSearchRequests: 0,
        codeReferences: 3,
      },
      2,
    ],
  ])("rejects %j at version %d", (body, version) => {
    const value = { canonicalOutputVersion: version, ...body };
    expect(parseCanonicalOutputEventV2(value)).toBeUndefined();
  });

  test("lines and documents", () => {
    expect(parseCanonicalOutputEventV2Line("not json")).toBeUndefined();
    const started = v2({ type: "started", conversationId: "c", model: "m", createdAt: 1 });
    const done = v2({
      type: "completed",
      finishReason: "stop",
      usage: USAGE,
      webSearchRequests: 0,
    });
    expect(
      parseCanonicalCompletionV2({ canonicalOutputVersion: 2, events: [started, done] }),
    ).toEqual({ canonicalOutputVersion: 2, events: [started, done] } as never);
    for (const events of [
      [started],
      [done, started],
      [started, started, done],
      [started, { x: 1 }, done],
    ]) {
      expect(parseCanonicalCompletionV2({ canonicalOutputVersion: 2, events })).toBeUndefined();
    }
    expect(
      parseCanonicalCompletionV2({ canonicalOutputVersion: 1, events: [started, done] }),
    ).toBeUndefined();
    expect(
      parseCanonicalCompletionV2({ canonicalOutputVersion: 2, events: [started, done], x: 1 }),
    ).toBeUndefined();
    const v1 = { canonicalOutputVersion: 1, type: "text_delta", text: "x" };
    expect(parseAnyCanonicalOutputEventLine(JSON.stringify(v1))).toEqual(
      parseCanonicalOutputEvent(v1),
    );
    expect(parseAnyCanonicalOutputEventLine(JSON.stringify(done))).toEqual(done as never);
    expect(parseAnyCanonicalOutputEventLine("{")).toBeUndefined();
  });
});

const SEARCH = { type: "web_search_20250305", name: "web_search" };
const RESULT_ID = `srvtoolu_${"a".repeat(32)}`;

function messages(assistant: unknown[], extra: Record<string, unknown> = {}, tail?: unknown) {
  return {
    model: "claude-opus-5-5",
    max_tokens: 2048,
    tools: [SEARCH],
    messages: [
      { role: "user", content: "Q" },
      { role: "assistant", content: assistant },
      ...(tail === undefined ? [{ role: "user", content: "next" }] : tail === null ? [] : [tail]),
    ],
    ...extra,
  };
}

const call = { type: "server_tool_use", id: RESULT_ID, name: "web_search", input: { query: "q" } };
const result = {
  type: "web_search_tool_result",
  tool_use_id: RESULT_ID,
  content: [
    { type: "web_search_result", url: "https://a.example/", title: "A", encrypted_content: "x" },
  ],
};

describe("Messages hosted history mapping", () => {
  test("maps calls, results and citations onto hosted history", () => {
    const adapted = adaptAnthropicMessagesRequest(
      messages([
        call,
        result,
        {
          type: "text",
          text: "cited",
          citations: [
            {
              type: "web_search_result_location",
              url: "https://a.example/",
              title: "A",
              encrypted_index: "y",
              cited_text: "c",
            },
          ],
        },
        { type: "text", text: " plain", citations: null },
      ]),
    );
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    expect(adapted.value.hostedHistory.calls).toMatchObject([
      { callId: RESULT_ID, query: "q", publicState: { kind: "completed" } },
    ]);
    expect(adapted.value.hostedHistory.citations).toHaveLength(1);
    expect(adapted.value.body.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ]);
  });

  test("an unresolved final call is pending and needs the current declaration", () => {
    const pending = adaptAnthropicMessagesRequest(messages([call], {}, null));
    expect(pending.ok && pending.value.hostedHistory.calls[0]?.publicState).toEqual({
      kind: "pending",
    });
    expect(adaptAnthropicMessagesRequest(messages([call], { tools: [] }, null))).toMatchObject({
      ok: false,
      code: "web_search_pending_unauthorized",
    });
    expect(
      adaptAnthropicMessagesRequest(messages([call], { tool_choice: { type: "none" } }, null)),
    ).toMatchObject({ ok: false, code: "web_search_pending_unauthorized" });
  });

  test.each([
    ["extra result keys", [call, { ...result, extra: 1 }], "web_search_replay_invalid"],
    [
      "a result without tool_use_id",
      [call, { ...result, tool_use_id: undefined }],
      "invalid_tool_history",
    ],
    ["malformed result content", [call, { ...result, content: "x" }], "web_search_replay_invalid"],
    [
      "a foreign result entry",
      [call, { ...result, content: [{ type: "document" }] }],
      "web_search_replay_invalid",
    ],
    [
      "extra result entry keys",
      [call, { ...result, content: [{ ...result.content[0], extra: 1 }] }],
      "web_search_replay_invalid",
    ],
    [
      "a result entry without a title",
      [call, { ...result, content: [{ ...result.content[0], title: undefined }] }],
      "web_search_replay_invalid",
    ],
    [
      "a numeric page age",
      [call, { ...result, content: [{ ...result.content[0], page_age: 5 }] }],
      "web_search_replay_invalid",
    ],
    [
      "an error with extra keys",
      [
        call,
        {
          ...result,
          content: { type: "web_search_tool_result_error", error_code: "unavailable", x: 1 },
        },
      ],
      "web_search_replay_invalid",
    ],
    ["a result answering nothing", [result], "invalid_tool_history"],
    ["a duplicated result", [call, result, result], "invalid_tool_history"],
    [
      "a server call with another name",
      [{ ...call, name: "web_fetch" }, result],
      "web_search_replay_invalid",
    ],
    [
      "a server call with extra input",
      [{ ...call, input: { query: "q", x: 1 } }, result],
      "web_search_replay_invalid",
    ],
    ["a server call without an id", [{ ...call, id: "" }], "web_search_replay_invalid"],
    [
      "citations that are not a list",
      [call, result, { type: "text", text: "t", citations: {} }],
      "web_search_replay_invalid",
    ],
    [
      "a foreign citation type",
      [call, result, { type: "text", text: "t", citations: [{ type: "char_location" }] }],
      "unsupported_content_part",
    ],
    [
      "a citation with extra keys",
      [
        call,
        result,
        {
          type: "text",
          text: "t",
          citations: [
            {
              type: "web_search_result_location",
              url: "u",
              title: "t",
              encrypted_index: "e",
              cited_text: "c",
              x: 1,
            },
          ],
        },
      ],
      "web_search_replay_invalid",
    ],
    [
      "a citation without cited text",
      [
        call,
        result,
        {
          type: "text",
          text: "t",
          citations: [{ type: "web_search_result_location", url: "u", title: "t" }],
        },
      ],
      "web_search_replay_invalid",
    ],
    [
      "a client tool before results",
      [call, { type: "tool_use", id: "toolu_1", name: "f", input: {} }, result],
      "invalid_tool_history",
    ],
    [
      "a client call in a finished segment",
      [
        call,
        { type: "tool_use", id: "toolu_1", name: "f", input: {} },
        result,
        { type: "text", text: "x" },
      ],
      "invalid_tool_history",
    ],
    [
      "an assistant image",
      [call, result, { type: "image", source: {} }],
      "unsupported_content_part",
    ],
    [
      "a tool use without an id",
      [call, result, { type: "tool_use", name: "f" }],
      "invalid_tool_history",
    ],
  ])("rejects %s", (_name, assistant, code) => {
    expect(adaptAnthropicMessagesRequest(messages(assistant as unknown[]))).toMatchObject({
      ok: false,
      code,
    });
  });

  test("rejects extra message fields and non-string text", () => {
    const extra = messages([call, result]);
    (extra.messages[1] as Record<string, unknown>).extra = true;
    expect(adaptAnthropicMessagesRequest(extra)).toMatchObject({
      ok: false,
      code: "unsupported_message_field",
    });
    expect(
      adaptAnthropicMessagesRequest(messages([call, result, { type: "text", text: 5 }])).ok,
    ).toBe(false);
  });

  test("text between a call and its result stays in the same generation", () => {
    const adapted = adaptAnthropicMessagesRequest(
      messages([call, { type: "text", text: "x" }, result]),
    );
    expect(adapted.ok).toBe(true);
  });

  test("a mixed group needs every client result in the next message", () => {
    const tools = [
      SEARCH,
      { name: "f", description: "client tool", input_schema: { type: "object" } },
    ];
    const group = [
      call,
      { type: "tool_use", id: "toolu_1", name: "f", input: {} },
      { type: "tool_use", id: "toolu_2", name: "f", input: {} },
    ];
    const answer = (...ids: string[]) => ({
      role: "user",
      content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "r" })),
    });
    expect(
      adaptAnthropicMessagesRequest(messages(group, { tools }, answer("toolu_2"))),
    ).toMatchObject({ ok: false, code: "invalid_tool_history", param: "messages.2" });
    expect(adaptAnthropicMessagesRequest(messages(group, { tools }, null))).toMatchObject({
      ok: false,
      code: "invalid_tool_history",
      param: "messages.1",
    });
    expect(
      adaptAnthropicMessagesRequest(
        messages(group, { tools }, { role: "assistant", content: [{ type: "text", text: "x" }] }),
      ),
    ).toMatchObject({ ok: false, code: "invalid_tool_history" });
    expect(
      adaptAnthropicMessagesRequest(messages(group, { tools }, answer("toolu_2", "toolu_1"))).ok,
    ).toBe(true);
  });

  test("an unresolved call cannot be followed by user text or an unrelated assistant", () => {
    expect(
      adaptAnthropicMessagesRequest(messages([call], {}, { role: "user", content: "new" })),
    ).toMatchObject({ ok: false, code: "invalid_tool_history" });
    const body = messages(
      [call],
      {},
      { role: "assistant", content: [{ type: "text", text: "x" }] },
    );
    expect(adaptAnthropicMessagesRequest(body)).toMatchObject({
      ok: false,
      code: "invalid_tool_history",
    });
    const unanswered = messages(
      [call],
      {},
      { role: "assistant", content: [{ type: "text", text: "x", citations: null }] },
    );
    expect(adaptAnthropicMessagesRequest(unanswered)).toMatchObject({
      ok: false,
      code: "invalid_tool_history",
    });
  });

  test("declarations: duplicates, cache control, other server tools, structured output", () => {
    const base = {
      model: "claude-opus-5-5",
      max_tokens: 2048,
      messages: [{ role: "user", content: "Q" }],
    };
    expect(
      adaptAnthropicMessagesRequest({
        ...base,
        tools: [SEARCH, { name: "web_search", description: "mine", input_schema: {} }],
      }),
    ).toMatchObject({ ok: false, code: "invalid_tool_declaration" });
    expect(
      adaptAnthropicMessagesRequest({
        ...base,
        tools: [{ ...SEARCH, cache_control: { type: "ephemeral" } }],
      }).ok,
    ).toBe(true);
    expect(
      adaptAnthropicMessagesRequest({
        ...base,
        tools: [{ ...SEARCH, cache_control: { type: "persistent" } }],
      }).ok,
    ).toBe(false);
    expect(
      adaptAnthropicMessagesRequest({
        ...base,
        tools: [{ type: "web_fetch_20250910", name: "web_fetch" }],
      }),
    ).toMatchObject({ ok: false, code: "unsupported_tool_field" });
    expect(
      adaptAnthropicMessagesRequest({
        ...base,
        tools: [SEARCH],
        output_config: {
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
              additionalProperties: false,
            },
          },
        },
      }),
    ).toMatchObject({ ok: false });
  });
});

function responses(input: unknown[], extra: Record<string, unknown> = {}) {
  const parsed = parseResponsesRequest({
    model: "gpt-5.6-sol",
    input,
    tools: [{ type: "web_search" }],
    ...extra,
  });
  if (!parsed.ok) throw new Error("schema");
  return adaptResponsesRequest(parsed.value, "v3-auto");
}

const wsCall = {
  type: "web_search_call",
  id: "ws_1",
  status: "completed",
  action: { type: "search", query: "q" },
};

describe("Responses hosted history mapping", () => {
  test("maps web_search_call items with optional queries and sources", () => {
    const adapted = responses([
      { role: "user", content: "Q" },
      {
        ...wsCall,
        action: { ...wsCall.action, queries: ["q"], sources: [{ type: "url", url: "https://a/" }] },
      },
      {
        type: "web_search_call",
        id: "ws_2",
        status: "failed",
        action: { type: "search", queries: ["r"] },
      },
      { role: "assistant", content: [{ type: "output_text", text: "A" }] },
      { role: "user", content: "next" },
    ]);
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    expect(
      adapted.hostedHistory.calls.map((entry) => [
        entry.callId,
        entry.query,
        entry.publicState.kind,
      ]),
    ).toEqual([
      ["ws_1", "q", "completed"],
      ["ws_2", "r", "failed"],
    ]);
  });

  test.each([
    ["extra item keys", { ...wsCall, extra: 1 }],
    ["a missing id", { ...wsCall, id: undefined }],
    ["a searching status", { ...wsCall, status: "searching" }],
    ["an open_page action", { ...wsCall, action: { type: "open_page", url: "u" } }],
    ["extra action keys", { ...wsCall, action: { ...wsCall.action, x: 1 } }],
    ["several queries", { ...wsCall, action: { type: "search", queries: ["a", "b"] } }],
    ["mismatched queries", { ...wsCall, action: { type: "search", query: "q", queries: ["r"] } }],
    ["a missing query", { ...wsCall, action: { type: "search" } }],
    ["non-list sources", { ...wsCall, action: { ...wsCall.action, sources: "x" } }],
    ["a foreign source", { ...wsCall, action: { ...wsCall.action, sources: [{ type: "api" }] } }],
    [
      "extra source keys",
      { ...wsCall, action: { ...wsCall.action, sources: [{ type: "url", url: "u", x: 1 }] } },
    ],
  ])("rejects %s", (_name, item) => {
    const adapted = responses([
      { role: "user", content: "Q" },
      item,
      { role: "user", content: "n" },
    ]);
    expect(adapted).toMatchObject({ ok: false, code: "web_search_replay_invalid" });
  });

  test("declaration validation", () => {
    const parse = (tools: unknown[]) => {
      const parsed = parseResponsesRequest({ model: "gpt-5.6-sol", input: "Q", tools });
      if (!parsed.ok) throw new Error("schema");
      return validateToolDeclarations(parsed.value);
    };
    expect(parse([{ type: "web_search" }, { type: "web_search_2025_08_26" }])).toMatchObject({
      ok: false,
      code: "invalid_web_search_declaration",
    });
    expect(
      validateToolDeclarations({
        model: "gpt-5.6-sol",
        input: "Q",
        stream: false,
        tools: [{ type: "namespace", name: "ns", tools: [{ type: "web_search" }] }],
      } as never),
    ).toMatchObject({ ok: false, code: "unsupported_web_search" });
    expect(parse([{ type: "web_search", filters: { allowed_domains: ["a.example"] } }]).ok).toBe(
      true,
    );
    const adapted = responses([{ role: "user", content: "Q" }], {
      include: ["web_search_call.action.sources"],
    });
    expect(adapted.ok && adapted.hostedWebSearch?.publicType).toBe("web_search");
  });
});
