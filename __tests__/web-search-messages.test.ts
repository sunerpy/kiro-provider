import { describe, expect, test } from "bun:test";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";
import { snapshotLookupHash } from "../src/web-search/crypto.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import {
  defaultMcpResponder,
  FIXTURE_SOURCES,
  type McpResponder,
  searchCallGeneration,
  sseData,
  textGeneration,
  WEB_SEARCH_FIXTURE_KEY,
  waitFor,
  webSearchFixture,
} from "./web-search-test-helpers.js";

// Hosted search through the Messages ingress beyond the single-turn
// reproducer: history replay from authenticated snapshots, mixed and paused
// continuations, budgets, failures, filters, isolation and cancellation.

const QUERY = "fixture runtime latest release";
const LINK = `[official release notes](${FIXTURE_SOURCES[0]?.url})`;
const FINAL_TEXT = `Fixture Runtime 9.9 is the latest release, per the ${LINK}.`;
const SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 5 };
const CLIENT_TOOL = {
  name: "lookup_ticket",
  description: "Look up a support ticket",
  input_schema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
};

type Block = Record<string, unknown> & { readonly type: string };
type MessageBody = {
  readonly content: Block[];
  readonly stop_reason: string;
  readonly usage: Record<string, unknown>;
};

function request(
  messages: unknown[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    model: "claude-opus-5-5",
    max_tokens: 4096,
    messages,
    tools: [SEARCH_TOOL],
    ...overrides,
  };
}

function mixedGeneration(): SdkStreamEvent[] {
  return [
    { assistantResponseEvent: { content: "Checking both." } },
    {
      toolUseEvent: {
        toolUseId: "call_fixture_search_0001",
        name: "web_search",
        input: JSON.stringify({ query: QUERY }),
        stop: true,
      },
    },
    {
      toolUseEvent: {
        toolUseId: "toolu_client_0001",
        name: "lookup_ticket",
        input: JSON.stringify({ id: "T-1" }),
        stop: true,
      },
    },
  ] as SdkStreamEvent[];
}

async function json(response: Response): Promise<MessageBody> {
  expect(response.status).toBe(200);
  return (await response.json()) as MessageBody;
}

function searchCalls(fixture: ReturnType<typeof webSearchFixture>) {
  return fixture.mcpCalls.filter((call) => call.method === "tools/call");
}

describe("Messages hosted search history", () => {
  test("a completed search replays from its snapshot on the next user turn", async () => {
    const fixture = webSearchFixture([
      searchCallGeneration(QUERY),
      textGeneration(FINAL_TEXT),
      textGeneration("Follow-up answer."),
    ]);
    const first = await json(
      await fixture.post("/v1/messages", request([{ role: "user", content: "What is new?" }])),
    );
    const history = [
      { role: "user", content: "What is new?" },
      { role: "assistant", content: first.content },
      { role: "user", content: "Thanks, anything else?" },
    ];
    const second = await json(await fixture.post("/v1/messages", request(history)));
    expect(second.content.map((block) => block.type)).toEqual(["text"]);
    expect(searchCalls(fixture)).toHaveLength(1);
    const conversation = fixture.inputs[2]?.conversationState;
    const turns = conversation?.history ?? [];
    // The wire tool use and the exact model-visible result come back from the
    // snapshot; the public srvtoolu id never reaches Kiro.
    const toolTurn = turns.find((turn) => turn.assistantResponseMessage?.toolUses?.length);
    expect(toolTurn?.assistantResponseMessage?.toolUses).toEqual([
      { toolUseId: "call_fixture_search_0001", name: "web_search", input: { query: QUERY } },
    ]);
    const results = turns.flatMap(
      (turn) => turn.userInputMessage?.userInputMessageContext?.toolResults ?? [],
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.toolUseId).toBe("call_fixture_search_0001");
    const restored = JSON.parse(String(results[0]?.content?.[0]?.text)) as {
      readonly results: ReadonlyArray<{ readonly url: string }>;
    };
    expect(restored.results.map((source) => source.url)).toEqual(
      FIXTURE_SOURCES.map((source) => source.url),
    );
    const finalAssistant = turns.at(-1)?.assistantResponseMessage;
    expect(finalAssistant?.content).toBe(FINAL_TEXT);
    expect(JSON.stringify(conversation)).not.toContain("srvtoolu_");
  });

  test("count_tokens includes restored search results and rejects tampered history", async () => {
    const fixture = webSearchFixture([searchCallGeneration(QUERY), textGeneration(FINAL_TEXT)]);
    const first = await json(
      await fixture.post("/v1/messages", request([{ role: "user", content: "What is new?" }])),
    );
    const history = [
      { role: "user", content: "What is new?" },
      { role: "assistant", content: first.content },
      { role: "user", content: "Next." },
    ];
    const counted = await fixture.post("/v1/messages/count_tokens", request(history));
    expect(counted.status).toBe(200);
    const withResults = ((await counted.json()) as { input_tokens: number }).input_tokens;
    const bare = await fixture.post(
      "/v1/messages/count_tokens",
      request([
        { role: "user", content: "What is new?" },
        { role: "assistant", content: [{ type: "text", text: FINAL_TEXT }] },
        { role: "user", content: "Next." },
      ]),
    );
    const withoutResults = ((await bare.json()) as { input_tokens: number }).input_tokens;
    expect(withResults).toBeGreaterThan(withoutResults);
    const tampered = structuredClone(first.content);
    const result = tampered.find((block) => block.type === "web_search_tool_result");
    (result?.content as Block[])[0] = {
      ...(result?.content as Block[])[0],
      encrypted_content: "kws1_forged",
    } as Block;
    const rejected = await fixture.post(
      "/v1/messages/count_tokens",
      request([history[0], { role: "assistant", content: tampered }, history[2]]),
    );
    expect(rejected.status).toBe(400);
    expect(fixture.inputs).toHaveLength(2);
  });

  test("count_tokens charges restored history to the shared request byte budget", async () => {
    const database = new AccountsDatabase(":memory:");
    const owner = webSearchFixture([searchCallGeneration(QUERY), textGeneration(FINAL_TEXT)], {
      database,
    });
    const first = await json(
      await owner.post("/v1/messages", request([{ role: "user", content: "What is new?" }])),
    );
    const body = request([
      { role: "user", content: "What is new?" },
      { role: "assistant", content: first.content },
      { role: "user", content: "Next." },
    ]);
    const bodyBytes = Buffer.byteLength(JSON.stringify(body));
    const id = String(owner.publishedSearchIds()[0]);
    const snapshotBytes =
      database.getWebSearchSnapshot(snapshotLookupHash(owner.tenantId, id))?.ciphertext
        .byteLength ?? 0;
    expect(snapshotBytes).toBeGreaterThan(0);
    // The upload fits; the upload plus the decrypted history does not.
    const limit = bodyBytes + Math.floor(snapshotBytes / 2);
    const tight = webSearchFixture([], {
      database,
      config: { max_request_body_bytes: limit, max_inflight_request_body_bytes: limit },
    });
    const audit = captureAuditEvents();
    try {
      const counted = await tight.post("/v1/messages/count_tokens", body);
      expect(counted.status).toBe(503);
      expect(audit.events("request_admission_reservation_rejected")).toHaveLength(1);
    } finally {
      audit.restore();
    }
    const roomy = webSearchFixture([], { database });
    expect((await roomy.post("/v1/messages/count_tokens", body)).status).toBe(200);
  });

  test("history replay works while new searches are disabled", async () => {
    const database = new AccountsDatabase(":memory:");
    const enabled = webSearchFixture([searchCallGeneration(QUERY), textGeneration(FINAL_TEXT)], {
      database,
    });
    const first = await json(
      await enabled.post("/v1/messages", request([{ role: "user", content: "What is new?" }])),
    );
    const disabled = webSearchFixture([textGeneration("Answer from history.")], {
      database,
      config: { web_search_enabled: false },
    });
    const history = [
      { role: "user", content: "What is new?" },
      { role: "assistant", content: first.content },
      { role: "user", content: "Summarize again." },
    ];
    const declared = await disabled.post("/v1/messages", request(history));
    expect(declared.status).toBe(400);
    expect(await declared.text()).toContain("not enabled");
    const replayed = await json(
      await disabled.post("/v1/messages", request(history, { tools: [] })),
    );
    expect(replayed.content).toEqual([{ type: "text", text: "Answer from history." }]);
    expect(searchCalls(disabled)).toHaveLength(0);
    expect(disabled.inputs).toHaveLength(1);
  });

  test.each([
    [
      "tampered result content",
      (content: Block[]) => {
        const result = content.find((block) => block.type === "web_search_tool_result");
        const entries = result?.content as Array<Record<string, unknown>>;
        entries[0] = { ...entries[0], encrypted_content: `${entries[0]?.encrypted_content}x` };
      },
    ],
    [
      "missing result content",
      (content: Block[]) => {
        const result = content.find((block) => block.type === "web_search_tool_result");
        const entries = result?.content as Array<Record<string, unknown>>;
        delete entries[0]?.encrypted_content;
      },
    ],
    [
      "swapped source title",
      (content: Block[]) => {
        const result = content.find((block) => block.type === "web_search_tool_result");
        const entries = result?.content as Array<Record<string, unknown>>;
        entries[0] = { ...entries[0], title: "Forged title" };
      },
    ],
    [
      "dropped source",
      (content: Block[]) => {
        const result = content.find((block) => block.type === "web_search_tool_result");
        (result?.content as unknown[]).pop();
      },
    ],
    [
      "changed query",
      (content: Block[]) => {
        const call = content.find((block) => block.type === "server_tool_use");
        if (call) call.input = { query: "something else" };
      },
    ],
    [
      "unknown call id",
      (content: Block[]) => {
        const call = content.find((block) => block.type === "server_tool_use");
        const result = content.find((block) => block.type === "web_search_tool_result");
        if (call && result) {
          call.id = `srvtoolu_${"0".repeat(32)}`;
          result.tool_use_id = call.id;
        }
      },
    ],
    [
      "tampered citation",
      (content: Block[]) => {
        const cited = content.find((block) => Array.isArray(block.citations));
        const citation = (cited?.citations as Array<Record<string, unknown>>)[0];
        if (citation) citation.encrypted_index = `${citation.encrypted_index}x`;
      },
    ],
    [
      "forged cited text",
      (content: Block[]) => {
        const cited = content.find((block) => Array.isArray(block.citations));
        const citation = (cited?.citations as Array<Record<string, unknown>>)[0];
        if (citation) citation.cited_text = "Words the source never said.";
      },
    ],
  ])("rejects %s before any dispatch", async (_name, mutate) => {
    const fixture = webSearchFixture([searchCallGeneration(QUERY), textGeneration(FINAL_TEXT)]);
    const first = await json(
      await fixture.post("/v1/messages", request([{ role: "user", content: "What is new?" }])),
    );
    const content = structuredClone(first.content);
    mutate(content);
    const response = await fixture.post(
      "/v1/messages",
      request([
        { role: "user", content: "What is new?" },
        { role: "assistant", content },
        { role: "user", content: "Continue." },
      ]),
    );
    expect(response.status).toBe(400);
    expect(fixture.inputs).toHaveLength(2);
    expect(searchCalls(fixture)).toHaveLength(1);
  });

  test("completed search history stays on its owner account and conversation", async () => {
    // No reasoning token pins this history; the search snapshot alone must.
    const database = new AccountsDatabase(":memory:");
    const owner = webSearchFixture(
      [searchCallGeneration(QUERY), textGeneration(FINAL_TEXT), textGeneration("Owner answer.")],
      { database },
    );
    const first = await json(
      await owner.post("/v1/messages", request([{ role: "user", content: "What is new?" }])),
    );
    const history = [
      { role: "user", content: "What is new?" },
      { role: "assistant", content: first.content },
      { role: "user", content: "Continue." },
    ];
    const elsewhere = webSearchFixture(
      [searchCallGeneration("other query", "call_fixture_search_0002"), textGeneration("Other.")],
      { database, accountId: "another-fixture-account" },
    );
    const moved = await elsewhere.post("/v1/messages", request(history));
    expect(moved.status).toBe(503);
    expect(elsewhere.inputs).toHaveLength(0);

    await json(await owner.post("/v1/messages", request(history)));
    expect(owner.inputs[2]?.conversationState?.conversationId).toBe(
      owner.inputs[0]?.conversationState?.conversationId,
    );

    // Searches recorded by two different owners cannot share one history.
    const second = await json(
      await elsewhere.post("/v1/messages", request([{ role: "user", content: "Other?" }])),
    );
    const merged = await owner.post(
      "/v1/messages",
      request([
        ...history.slice(0, 2),
        { role: "user", content: "Other?" },
        { role: "assistant", content: second.content },
        { role: "user", content: "Compare." },
      ]),
    );
    expect(merged.status).toBe(400);
    expect(owner.inputs).toHaveLength(3);
  });

  test("another tenant cannot replay the search history", async () => {
    const database = new AccountsDatabase(":memory:");
    const owner = webSearchFixture([searchCallGeneration(QUERY), textGeneration(FINAL_TEXT)], {
      database,
      config: { api_keys: [WEB_SEARCH_FIXTURE_KEY, "sk-other-tenant"] },
    });
    const first = await json(
      await owner.post("/v1/messages", request([{ role: "user", content: "What is new?" }])),
    );
    const response = await owner.app(
      new Request("http://fixture/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer sk-other-tenant" },
        body: JSON.stringify(
          request([
            { role: "user", content: "What is new?" },
            { role: "assistant", content: first.content },
            { role: "user", content: "Continue." },
          ]),
        ),
      }),
    );
    expect(response.status).toBe(400);
    expect(owner.inputs).toHaveLength(2);
  });
});

describe("Messages mixed hosted and client tool groups", () => {
  test("defers the search, then runs it first on the continuation", async () => {
    const fixture = webSearchFixture([mixedGeneration(), textGeneration(FINAL_TEXT)]);
    const body = request([{ role: "user", content: "Search and check T-1." }], {
      tools: [SEARCH_TOOL, CLIENT_TOOL],
    });
    const first = await json(await fixture.post("/v1/messages", body));
    expect(first.stop_reason).toBe("tool_use");
    expect(first.content.map((block) => block.type)).toEqual([
      "text",
      "server_tool_use",
      "tool_use",
    ]);
    expect(searchCalls(fixture)).toHaveLength(0);
    const serverCall = first.content[1] as Block;
    const clientCall = first.content[2] as Block;
    expect(clientCall.id).toBe("toolu_client_0001");

    const continuation = {
      ...body,
      messages: [
        ...(body.messages as unknown[]),
        { role: "assistant", content: first.content },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: clientCall.id, content: "T-1 is open" }],
        },
      ],
    };
    const second = await json(await fixture.post("/v1/messages", continuation));
    expect(searchCalls(fixture)).toHaveLength(1);
    expect(second.content[0]).toMatchObject({
      type: "web_search_tool_result",
      tool_use_id: serverCall.id,
    });
    expect(second.stop_reason).toBe("end_turn");
    expect(second.usage.server_tool_use).toEqual({ web_search_requests: 1 });
    const conversation = fixture.inputs[1]?.conversationState;
    expect(conversation?.conversationId).toBe(fixture.inputs[0]?.conversationState?.conversationId);
    const results =
      conversation?.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults ?? [];
    expect(results.map((result) => result.toolUseId)).toEqual([
      "call_fixture_search_0001",
      "toolu_client_0001",
    ]);
    expect(String(results[0]?.content?.[0]?.text)).toContain(FIXTURE_SOURCES[0]?.url ?? "");

    // The complete exchange replays later with the deferred result in the
    // next assistant message, exactly as the client accumulated it.
    const later = await fixture.post("/v1/messages", {
      ...continuation,
      messages: [
        ...continuation.messages,
        { role: "assistant", content: second.content },
        { role: "user", content: "Thanks." },
      ],
    });
    expect(later.status).toBe(200);
    expect(searchCalls(fixture)).toHaveLength(1);
  });

  test.each([
    [
      "extra text after the tool results",
      (messages: unknown[], clientId: string) => [
        ...messages,
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: clientId, content: "done" },
            { type: "text", text: "and something else" },
          ],
        },
      ],
      {},
    ],
    [
      "a request without the web_search tool",
      (messages: unknown[], clientId: string) => [
        ...messages,
        { role: "user", content: [{ type: "tool_result", tool_use_id: clientId, content: "x" }] },
      ],
      { tools: [CLIENT_TOOL] },
    ],
    [
      "a changed web_search declaration",
      (messages: unknown[], clientId: string) => [
        ...messages,
        { role: "user", content: [{ type: "tool_result", tool_use_id: clientId, content: "x" }] },
      ],
      { tools: [{ ...SEARCH_TOOL, max_uses: 2 }, CLIENT_TOOL] },
    ],
    [
      "tool_choice none",
      (messages: unknown[], clientId: string) => [
        ...messages,
        { role: "user", content: [{ type: "tool_result", tool_use_id: clientId, content: "x" }] },
      ],
      { tool_choice: { type: "none" } },
    ],
  ])("rejects a continuation with %s and runs no search", async (_name, extend, overrides) => {
    const fixture = webSearchFixture([mixedGeneration(), textGeneration(FINAL_TEXT)]);
    const body = request([{ role: "user", content: "Search and check T-1." }], {
      tools: [SEARCH_TOOL, CLIENT_TOOL],
    });
    const first = await json(await fixture.post("/v1/messages", body));
    const response = await fixture.post("/v1/messages", {
      ...body,
      ...overrides,
      messages: extend(
        [...(body.messages as unknown[]), { role: "assistant", content: first.content }],
        String((first.content[2] as Block).id),
      ),
    });
    expect(response.status).toBe(400);
    expect(searchCalls(fixture)).toHaveLength(0);
    expect(fixture.inputs).toHaveLength(1);
  });

  test("a continuation missing one of two client results is rejected before the search runs", async () => {
    const twoClients = [
      ...mixedGeneration(),
      {
        toolUseEvent: {
          toolUseId: "toolu_client_0002",
          name: "lookup_ticket",
          input: JSON.stringify({ id: "T-2" }),
          stop: true,
        },
      },
    ] as SdkStreamEvent[];
    const fixture = webSearchFixture([twoClients, textGeneration(FINAL_TEXT)]);
    const body = request([{ role: "user", content: "Search and check T-1 and T-2." }], {
      tools: [SEARCH_TOOL, CLIENT_TOOL],
    });
    const first = await json(await fixture.post("/v1/messages", body));
    expect(first.content.map((block) => block.type)).toEqual([
      "text",
      "server_tool_use",
      "tool_use",
      "tool_use",
    ]);
    const history = [
      ...(body.messages as unknown[]),
      { role: "assistant", content: first.content },
    ];
    const result = (id: unknown) => ({ type: "tool_result", tool_use_id: id, content: "open" });

    const partial = await fixture.post("/v1/messages", {
      ...body,
      messages: [...history, { role: "user", content: [result(first.content[2]?.id)] }],
    });
    expect(partial.status).toBe(400);
    const error = ((await partial.json()) as { error: Record<string, unknown> }).error;
    expect(error.type).toBe("invalid_request_error");
    expect(String(error.message)).toContain("tool_use ids were found without tool_result blocks");
    // The group ended at the assistant message: no client results at all.
    const none = await fixture.post("/v1/messages", { ...body, messages: history });
    expect(none.status).toBe(400);
    expect(searchCalls(fixture)).toHaveLength(0);
    expect(fixture.inputs).toHaveLength(1);

    // The deferred call was never claimed, so the complete continuation runs it.
    const complete = await json(
      await fixture.post("/v1/messages", {
        ...body,
        messages: [
          ...history,
          { role: "user", content: [result(first.content[2]?.id), result(first.content[3]?.id)] },
        ],
      }),
    );
    expect(complete.content[0]).toMatchObject({ type: "web_search_tool_result" });
    expect(searchCalls(fixture)).toHaveLength(1);
  });

  test("a repeated continuation reuses the recorded search instead of searching again", async () => {
    const fixture = webSearchFixture([
      mixedGeneration(),
      textGeneration(FINAL_TEXT),
      textGeneration(FINAL_TEXT),
    ]);
    const body = request([{ role: "user", content: "Search and check T-1." }], {
      tools: [SEARCH_TOOL, CLIENT_TOOL],
    });
    const first = await json(await fixture.post("/v1/messages", body));
    const continuation = {
      ...body,
      messages: [
        ...(body.messages as unknown[]),
        { role: "assistant", content: first.content },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: (first.content[2] as Block).id, content: "x" },
          ],
        },
      ],
    };
    const second = await json(await fixture.post("/v1/messages", continuation));
    const retried = await json(await fixture.post("/v1/messages", continuation));
    expect(searchCalls(fixture)).toHaveLength(1);
    // Envelopes are sealed afresh; the visible result is the recorded one.
    const visible = (block: Block | undefined) => ({
      ...block,
      content: (block?.content as Block[]).map(({ encrypted_content: _sealed, ...entry }) => entry),
    });
    expect(visible(retried.content[0])).toEqual(visible(second.content[0]));
    expect(retried.usage.server_tool_use).toEqual({ web_search_requests: 0 });
  });

  test("a continuation racing an executing claim is rejected as pending", async () => {
    const fixture = webSearchFixture([mixedGeneration(), textGeneration(FINAL_TEXT)]);
    const body = request([{ role: "user", content: "Search and check T-1." }], {
      tools: [SEARCH_TOOL, CLIENT_TOOL],
    });
    const first = await json(await fixture.post("/v1/messages", body));
    const serverId = String((first.content[1] as Block).id);
    fixture.store.claim(fixture.tenantId, serverId, ["deferred"]);
    const response = await fixture.post("/v1/messages", {
      ...body,
      messages: [
        ...(body.messages as unknown[]),
        { role: "assistant", content: first.content },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: (first.content[2] as Block).id, content: "x" },
          ],
        },
      ],
    });
    expect(response.status).toBe(409);
    expect(searchCalls(fixture)).toHaveLength(0);
  });

  test.each([
    ["a writer that already holds its second call", "before"],
    ["a writer that reaches its second call while the first search runs", "during"],
  ])("a two-search continuation is claimed as one group against %s", async (_name, when) => {
    // Two deferred searches of one group: a concurrent continuation (for example
    // an effort alias in another session queue) must never split the group.
    const twoSearches = [
      { assistantResponseEvent: { content: "Checking both." } },
      ...[
        ["call_fixture_search_0001", QUERY],
        ["call_fixture_search_0002", "second query"],
      ].map(([toolUseId, query]) => ({
        toolUseEvent: {
          toolUseId,
          name: "web_search",
          input: JSON.stringify({ query }),
          stop: true,
        },
      })),
      {
        toolUseEvent: {
          toolUseId: "toolu_client_0001",
          name: "lookup_ticket",
          input: JSON.stringify({ id: "T-1" }),
          stop: true,
        },
      },
    ] as SdkStreamEvent[];
    let rival: (() => void) | undefined;
    const fixture = webSearchFixture([twoSearches, textGeneration(FINAL_TEXT)], {
      mcp: async (call) => {
        if (call.method === "tools/call" && rival !== undefined) {
          const take = rival;
          rival = undefined;
          take();
        }
        return defaultMcpResponder()(call);
      },
    });
    const body = request([{ role: "user", content: "Search twice and check T-1." }], {
      tools: [SEARCH_TOOL, CLIENT_TOOL],
    });
    const first = await json(await fixture.post("/v1/messages", body));
    expect(first.content.map((block) => block.type)).toEqual([
      "text",
      "server_tool_use",
      "server_tool_use",
      "tool_use",
    ]);
    const status = (block: Block | undefined) =>
      fixture.database.getWebSearchSnapshot(snapshotLookupHash(fixture.tenantId, String(block?.id)))
        ?.status;
    let rivalOutcome: string | undefined;
    const take = () => {
      try {
        fixture.store.claim(fixture.tenantId, String(first.content[2]?.id), ["deferred"]);
        rivalOutcome = "claimed";
      } catch (error) {
        rivalOutcome = (error as { code?: string }).code;
      }
    };
    if (when === "before") take();
    else rival = take;
    const response = await fixture.post("/v1/messages", {
      ...body,
      messages: [
        ...(body.messages as unknown[]),
        { role: "assistant", content: first.content },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: first.content[3]?.id, content: "x" }],
        },
      ],
    });
    if (when === "before") {
      // The group cannot be claimed whole, so none of it runs.
      expect(response.status).toBe(409);
      expect(searchCalls(fixture)).toHaveLength(0);
      expect(status(first.content[1])).toBe("deferred");
      return;
    }
    // The whole group was claimed before the first search: the rival is refused.
    expect(rivalOutcome).toBe("web_search_replay_pending");
    expect(response.status).toBe(200);
    expect(searchCalls(fixture)).toHaveLength(2);
    expect([status(first.content[1]), status(first.content[2])]).toEqual([
      "completed",
      "completed",
    ]);
  });
});

describe("Messages pause_turn", () => {
  test("pauses at a stable checkpoint and resumes after a restart", async () => {
    const database = new AccountsDatabase(":memory:");
    // The remaining request time is below one search timeout, so the
    // generation's search is recorded as paused and nothing is dispatched.
    const paused = webSearchFixture([searchCallGeneration(QUERY, undefined, "Let me look.")], {
      database,
      config: { request_timeout_ms: 3_000, web_search_timeout_ms: 10_000 },
    });
    const body = request([{ role: "user", content: "What is new?" }]);
    const first = await json(await paused.post("/v1/messages", body));
    expect(first.stop_reason).toBe("pause_turn");
    expect(first.content.map((block) => block.type)).toEqual(["text", "server_tool_use"]);
    expect(searchCalls(paused)).toHaveLength(0);

    // A new process over the same database continues the paused turn.
    const resumed = webSearchFixture([textGeneration(FINAL_TEXT)], { database });
    expect(resumed.store.recoverInterruptedExecutions()).toBe(0);
    const second = await json(
      await resumed.post("/v1/messages", {
        ...body,
        messages: [...(body.messages as unknown[]), { role: "assistant", content: first.content }],
      }),
    );
    expect(searchCalls(resumed)).toHaveLength(1);
    expect(second.content[0]).toMatchObject({
      type: "web_search_tool_result",
      tool_use_id: (first.content[1] as Block).id,
    });
    expect(second.stop_reason).toBe("end_turn");
  });

  test("a paused two-search turn is claimed as one group when it resumes", async () => {
    const database = new AccountsDatabase(":memory:");
    const paused = webSearchFixture(
      [
        [
          ...searchCallGeneration(QUERY, "call_fixture_search_0001", "Let me look."),
          ...searchCallGeneration("second query", "call_fixture_search_0002"),
        ] as SdkStreamEvent[],
      ],
      { database, config: { request_timeout_ms: 3_000, web_search_timeout_ms: 10_000 } },
    );
    const body = request([{ role: "user", content: "What is new?" }]);
    const first = await json(await paused.post("/v1/messages", body));
    expect(first.stop_reason).toBe("pause_turn");
    expect(first.content.map((block) => block.type)).toEqual([
      "text",
      "server_tool_use",
      "server_tool_use",
    ]);
    let rivalOutcome: string | undefined;
    let rival: (() => void) | undefined = () => {
      try {
        resumed.store.claim(resumed.tenantId, String(first.content[2]?.id), ["paused"]);
        rivalOutcome = "claimed";
      } catch (error) {
        rivalOutcome = (error as { code?: string }).code;
      }
    };
    const resumed = webSearchFixture([textGeneration(FINAL_TEXT)], {
      database,
      mcp: async (call) => {
        if (call.method === "tools/call" && rival !== undefined) {
          const take = rival;
          rival = undefined;
          take();
        }
        return defaultMcpResponder()(call);
      },
    });
    const second = await json(
      await resumed.post("/v1/messages", {
        ...body,
        messages: [...(body.messages as unknown[]), { role: "assistant", content: first.content }],
      }),
    );
    // Both paused calls were claimed before the first search ran.
    expect(rivalOutcome).toBe("web_search_replay_pending");
    expect(searchCalls(resumed)).toHaveLength(2);
    expect(second.content.slice(0, 2).map((block) => block.type)).toEqual([
      "web_search_tool_result",
      "web_search_tool_result",
    ]);
  });

  test("an execution interrupted by a restart is uncertain and never runs again", async () => {
    const database = new AccountsDatabase(":memory:");
    const paused = webSearchFixture([searchCallGeneration(QUERY)], {
      database,
      config: { request_timeout_ms: 3_000, web_search_timeout_ms: 10_000 },
    });
    const body = request([{ role: "user", content: "What is new?" }]);
    const first = await json(await paused.post("/v1/messages", body));
    const serverId = String((first.content[0] as Block).id);
    paused.store.claim(paused.tenantId, serverId, ["paused"]);
    const restarted = webSearchFixture([textGeneration(FINAL_TEXT)], { database });
    expect(restarted.store.recoverInterruptedExecutions()).toBe(1);
    const response = await restarted.post("/v1/messages", {
      ...body,
      messages: [...(body.messages as unknown[]), { role: "assistant", content: first.content }],
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("no recorded outcome");
    expect(searchCalls(restarted)).toHaveLength(0);
    expect(restarted.inputs).toHaveLength(0);
  });
});

describe("Messages search groups are recorded all or none", () => {
  // The cache holds exactly one reservation, so the group's second call
  // cannot be recorded.
  const oneReservation = {
    web_search_max_result_bytes: 491_520,
    web_search_max_cache_bytes: 1_048_576,
  };
  const twoSearches = [
    ...searchCallGeneration(QUERY, "call_fixture_search_0001"),
    ...searchCallGeneration("second query", "call_fixture_search_0002"),
  ] as SdkStreamEvent[];
  const rows = (fixture: ReturnType<typeof webSearchFixture>) =>
    fixture
      .publishedSearchIds()
      .map((id) => fixture.database.getWebSearchSnapshot(snapshotLookupHash(fixture.tenantId, id)))
      .filter((row) => row !== undefined);

  test.each([
    ["an executed group", twoSearches, [SEARCH_TOOL]],
    [
      "a deferred mixed group",
      [
        ...twoSearches,
        {
          toolUseEvent: {
            toolUseId: "toolu_client_0001",
            name: "lookup_ticket",
            input: JSON.stringify({ id: "T-1" }),
            stop: true,
          },
        },
      ] as SdkStreamEvent[],
      [SEARCH_TOOL, CLIENT_TOOL],
    ],
  ])("%s that cannot be recorded leaves no call behind", async (_name, generation, tools) => {
    const fixture = webSearchFixture([generation], { config: oneReservation });
    const response = await fixture.post(
      "/v1/messages",
      request([{ role: "user", content: "Search twice." }], { tools }),
    );
    expect(response.status).toBe(503);
    expect(fixture.publishedSearchIds()).toHaveLength(2);
    expect(rows(fixture)).toEqual([]);
    expect(searchCalls(fixture)).toHaveLength(0);
    // The capacity it held is free again for the next request.
    const next = webSearchFixture([searchCallGeneration(QUERY), textGeneration(FINAL_TEXT)], {
      config: oneReservation,
      database: fixture.database,
    });
    expect(
      (await next.post("/v1/messages", request([{ role: "user", content: "Once." }]))).status,
    ).toBe(200);
  });

  test("a deferred call that cannot be removed again is retired as uncertain", async () => {
    const fixture = webSearchFixture(
      [
        [
          ...twoSearches,
          {
            toolUseEvent: {
              toolUseId: "toolu_client_0001",
              name: "lookup_ticket",
              input: JSON.stringify({ id: "T-1" }),
              stop: true,
            },
          },
        ] as SdkStreamEvent[],
      ],
      { config: oneReservation },
    );
    // Storage refuses the rollback delete; the unpublished call must still
    // never become runnable.
    fixture.store.discard = () => false;
    const response = await fixture.post(
      "/v1/messages",
      request([{ role: "user", content: "Search twice." }], { tools: [SEARCH_TOOL, CLIENT_TOOL] }),
    );
    expect(response.status).toBe(503);
    expect(rows(fixture).map((row) => row.status)).toEqual(["uncertain"]);
  });
});

describe("Messages search budgets, failures and filters", () => {
  test("max_uses bounds dispatched searches and reports the rest as errors", async () => {
    const fixture = webSearchFixture([
      searchCallGeneration(QUERY),
      searchCallGeneration("second query", "call_fixture_search_0002"),
      textGeneration(FINAL_TEXT),
    ]);
    const body = await json(
      await fixture.post(
        "/v1/messages",
        request([{ role: "user", content: "Search twice." }], {
          tools: [{ ...SEARCH_TOOL, max_uses: 1 }],
        }),
      ),
    );
    expect(searchCalls(fixture)).toHaveLength(1);
    const results = body.content.filter((block) => block.type === "web_search_tool_result");
    expect(results).toHaveLength(2);
    expect(results[1]?.content).toEqual({
      type: "web_search_tool_result_error",
      error_code: "max_uses_exceeded",
    });
    expect(body.usage.server_tool_use).toEqual({ web_search_requests: 1 });
    const fed = fixture.inputs[2]?.conversationState?.currentMessage?.userInputMessage;
    expect(fed?.userInputMessageContext?.toolResults?.[0]).toMatchObject({
      toolUseId: "call_fixture_search_0002",
      status: "error",
    });
  });

  test.each([
    ["JSON-RPC invalid params", jsonRpcError(-32602), "invalid_tool_input"],
    ["HTTP throttling", () => new Response("{}", { status: 429 }), "too_many_requests"],
    ["HTTP server error", () => new Response("{}", { status: 500 }), "unavailable"],
    ["unknown result schema", unknownSchema(), "unavailable"],
  ])("maps %s to a search error block", async (_name, responder, code) => {
    const fixture = webSearchFixture([searchCallGeneration(QUERY), textGeneration("No luck.")], {
      mcp: failingCalls(responder),
    });
    const body = await json(
      await fixture.post("/v1/messages", request([{ role: "user", content: "Search." }])),
    );
    expect(body.content[1]).toMatchObject({
      type: "web_search_tool_result",
      content: { type: "web_search_tool_result_error", error_code: code },
    });
    expect(body.usage.server_tool_use).toEqual({ web_search_requests: 0 });
    const fed = fixture.inputs[1]?.conversationState?.currentMessage?.userInputMessage;
    expect(fed?.userInputMessageContext?.toolResults?.[0]?.status).toBe("error");
    expect(JSON.stringify(body)).not.toContain("upstream detail");
  });

  test("zero sources is a valid empty result", async () => {
    const fixture = webSearchFixture([searchCallGeneration(QUERY), textGeneration("Nothing.")], {
      mcp: defaultMcpResponder([]),
    });
    const body = await json(
      await fixture.post("/v1/messages", request([{ role: "user", content: "Search." }])),
    );
    expect(body.content[1]).toMatchObject({ type: "web_search_tool_result", content: [] });
    expect(body.usage.server_tool_use).toEqual({ web_search_requests: 1 });
  });

  test("blocked domains remove sources and their citations", async () => {
    const githubLink = `[releases](${FIXTURE_SOURCES[1]?.url})`;
    const fixture = webSearchFixture([
      searchCallGeneration(QUERY),
      textGeneration(`See ${LINK} and ${githubLink}.`),
    ]);
    const body = await json(
      await fixture.post(
        "/v1/messages",
        request([{ role: "user", content: "Search." }], {
          tools: [{ ...SEARCH_TOOL, blocked_domains: ["github.com"] }],
        }),
      ),
    );
    const result = body.content[1] as Block;
    expect((result.content as Block[]).map((entry) => entry.url)).toEqual([
      FIXTURE_SOURCES[0]?.url,
    ]);
    const cited = body.content.filter((block) => Array.isArray(block.citations));
    expect(cited.map((block) => block.text)).toEqual([LINK]);
    expect(body.content.map((block) => block.text ?? "").join("")).toBe(
      `See ${LINK} and ${githubLink}.`,
    );
    const fed = fixture.inputs[1]?.conversationState?.currentMessage?.userInputMessage;
    expect(
      String(fed?.userInputMessageContext?.toolResults?.[0]?.content?.[0]?.text),
    ).not.toContain("github.com");
  });
});

describe("Messages declarations rejected before dispatch", () => {
  test.each([
    ["user_location", { ...SEARCH_TOOL, user_location: { type: "approximate", city: "X" } }],
    ["dynamic filtering", { type: "web_search_20260209", name: "web_search" }],
    ["response inclusion", { type: "web_search_20260318", name: "web_search" }],
    ["code execution callers", { ...SEARCH_TOOL, allowed_callers: ["code_execution_20260120"] }],
    [
      "both domain lists",
      { ...SEARCH_TOOL, allowed_domains: ["a.example"], blocked_domains: ["b.example"] },
    ],
    ["a wildcard domain", { ...SEARCH_TOOL, allowed_domains: ["*.example.com"] }],
    ["zero max_uses", { ...SEARCH_TOOL, max_uses: 0 }],
  ])("%s", async (_name, tool) => {
    const fixture = webSearchFixture([textGeneration("unused")]);
    const response = await fixture.post(
      "/v1/messages",
      request([{ role: "user", content: "Search." }], { tools: [tool] }),
    );
    expect(response.status).toBe(400);
    expect(fixture.inputs).toHaveLength(0);
    expect(fixture.mcpCalls).toHaveLength(0);
  });

  test("an unverified model is rejected", async () => {
    const fixture = webSearchFixture([textGeneration("unused")]);
    const response = await fixture.post(
      "/v1/messages",
      request([{ role: "user", content: "Search." }], { model: "claude-opus-5" }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("not available for model");
    expect(fixture.inputs).toHaveLength(0);
  });

  test("an account outside a verified region cannot serve the search", async () => {
    const fixture = webSearchFixture([textGeneration("unused")], {
      accountProfileArn: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/fixture",
    });
    const response = await fixture.post(
      "/v1/messages",
      request([{ role: "user", content: "Search." }]),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("region");
    expect(fixture.inputs).toHaveLength(0);
    expect(fixture.mcpCalls).toHaveLength(0);
  });
});

describe("Messages search cancellation and audit", () => {
  test("a client that leaves during the search aborts it and records an uncertain outcome", async () => {
    const audit = captureAuditEvents();
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const searching = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fixture = webSearchFixture([searchCallGeneration(QUERY), textGeneration(FINAL_TEXT)], {
      mcp: async (call) => {
        if (call.method !== "tools/call") return defaultMcpResponder()(call);
        started?.();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return defaultMcpResponder()(call);
      },
    });
    const controller = new AbortController();
    const pending = fixture.post(
      "/v1/messages",
      request([{ role: "user", content: "Search." }], { stream: true }),
      { signal: controller.signal },
    );
    const response = await pending;
    const reader = response.body?.getReader();
    const reading = (async () => {
      try {
        while (true) {
          const next = await reader?.read();
          if (!next || next.done) return;
        }
      } catch {
        // The aborted body may error; the assertions below are on side effects.
      }
    })();
    await searching;
    controller.abort();
    await reading;
    const id = String(fixture.publishedSearchIds()[0]);
    const status = () =>
      fixture.database.getWebSearchSnapshot(snapshotLookupHash(fixture.tenantId, id))?.status;
    try {
      expect(await waitFor(() => status() === "uncertain")).toBe(true);
      // The admission reservation is released only after the loop's cleanup.
      expect(
        await waitFor(
          () => audit.events("request_admission_released").at(-1)?.active_requests === 0,
        ),
      ).toBe(true);
      release?.();
      expect(fixture.inputs).toHaveLength(1);
      expect(fixture.state.iteratorsClosed).toBeGreaterThan(0);
      // The interrupted call can never run again.
      const replay = await fixture.post("/v1/messages", request([{ role: "user", content: "x" }]));
      expect(replay.status).toBe(200);
      expect(searchCalls(fixture)).toHaveLength(1);
    } finally {
      audit.restore();
    }
  });

  test("a consumer that cancels the body during the search aborts it before anything is released", async () => {
    // Unlike a disconnect, a body cancel leaves the request signal untouched:
    // the cancel itself must abort the search and settle its state first.
    const audit = captureAuditEvents();
    let started: (() => void) | undefined;
    const searching = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fixture = webSearchFixture([searchCallGeneration(QUERY), textGeneration(FINAL_TEXT)], {
      mcp: async (call) => {
        if (call.method !== "tools/call") return defaultMcpResponder()(call);
        started?.();
        // The backend never answers; only an abort ends this call.
        return await new Promise<Response>(() => {});
      },
    });
    try {
      const response = await fixture.post(
        "/v1/messages",
        request([{ role: "user", content: "Search." }], { stream: true }),
      );
      const reader = response.body?.getReader();
      const reading = (async () => {
        while (true) {
          const next = await reader?.read();
          if (!next || next.done) return;
        }
      })();
      await searching;
      await reader?.cancel();
      await reading;
      const id = String(fixture.publishedSearchIds()[0]);
      const status = () =>
        fixture.database.getWebSearchSnapshot(snapshotLookupHash(fixture.tenantId, id))?.status;
      expect(
        await waitFor(
          () => audit.events("request_admission_released").at(-1)?.active_requests === 0,
        ),
      ).toBe(true);
      // By the time the request let go of its admission and account, the
      // interrupted call was already recorded as uncertain.
      expect(status()).toBe("uncertain");
      expect(fixture.inputs).toHaveLength(1);
      expect(fixture.state.upstreamAborts + fixture.state.iteratorsClosed).toBeGreaterThan(0);
    } finally {
      audit.restore();
    }
  });

  /**
   * Samples the fixture when the last admission is released: whatever the
   * cancel tore down must already be settled at that moment.
   */
  function releaseProbe(fixture: () => ReturnType<typeof webSearchFixture> | undefined) {
    let atRelease:
      | {
          readonly upstreamAborts: number;
          readonly iteratorsClosed: number;
          readonly statuses: readonly (string | undefined)[];
        }
      | undefined;
    const audit = captureAuditEvents((record) => {
      const current = fixture();
      if (record.event !== "request_admission_released" || record.active_requests !== 0) return;
      if (current === undefined) return;
      atRelease = {
        upstreamAborts: current.state.upstreamAborts,
        iteratorsClosed: current.state.iteratorsClosed,
        statuses: current
          .publishedSearchIds()
          .map(
            (id) =>
              current.database.getWebSearchSnapshot(snapshotLookupHash(current.tenantId, id))
                ?.status,
          ),
      };
    });
    return {
      audit,
      released: () => waitFor(() => atRelease !== undefined),
      atRelease: () => atRelease,
    };
  }

  async function readUntil(response: Response, done: Promise<unknown>) {
    const reader = response.body?.getReader();
    const reading = (async () => {
      while (true) {
        const next = await reader?.read();
        if (!next || next.done) return;
      }
    })();
    await done;
    return { reader, reading };
  }

  test("queue wait stage: a request whose deadline ends in the session queue runs nothing", async () => {
    // The holder keeps the shared session queue busy; the waiting request (its
    // own app, same tenant and session) is cancelled by its deadline while it
    // still waits, so the queue audit proves where the cancellation landed.
    const audit = captureAuditEvents();
    let releaseHolder: (() => void) | undefined;
    const holderRelease = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    try {
      const session = { "x-claude-code-session-id": "fixture-queue-session" };
      const holder = webSearchFixture([
        { stalled: textGeneration("Holding the session."), release: holderRelease },
      ]);
      const holding = holder.post("/v1/messages", request([{ role: "user", content: "Hold." }]), {
        headers: session,
      });
      expect(await waitFor(() => holder.inputs.length === 1)).toBe(true);
      const waiter = webSearchFixture([searchCallGeneration(QUERY), textGeneration(FINAL_TEXT)], {
        config: { request_timeout_ms: 300 },
      });
      const cancelled = await waiter.post(
        "/v1/messages",
        request([{ role: "user", content: "Search." }], { stream: true }),
        { headers: session },
      );
      expect(cancelled.status).toBe(504);
      await cancelled.text();
      expect(
        audit
          .events("request_queue_wait")
          .some((event) => event.queue === "session" && event.outcome === "aborted"),
      ).toBe(true);
      // It never generated, searched or recorded a call, and let go of its admission.
      expect(waiter.inputs).toHaveLength(0);
      expect(searchCalls(waiter)).toHaveLength(0);
      expect(waiter.publishedSearchIds()).toEqual([]);
      expect(
        audit.events("request_admission_released").some((event) => event.active_requests === 0),
      ).toBe(true);
      releaseHolder?.();
      const held = await holding;
      expect(held.status).toBe(200);
      await held.text();
    } finally {
      releaseHolder?.();
      audit.restore();
    }
  });

  test("generation stage: a cancel while the first generation streams tears it down first", async () => {
    let fixture: ReturnType<typeof webSearchFixture> | undefined;
    const probe = releaseProbe(() => fixture);
    try {
      fixture = webSearchFixture([{ stalled: textGeneration("Let me think about") }]);
      const response = await fixture.post(
        "/v1/messages",
        request([{ role: "user", content: "Search." }], { stream: true }),
      );
      const { reader, reading } = await readUntil(
        response,
        waitFor(() => fixture?.inputs.length === 1),
      );
      await reader?.cancel();
      await reading;
      expect(await probe.released()).toBe(true);
      // The upstream request was destroyed before the lease was released.
      expect(probe.atRelease()?.upstreamAborts).toBeGreaterThan(0);
      expect(searchCalls(fixture)).toHaveLength(0);
      expect(fixture.publishedSearchIds()).toEqual([]);
    } finally {
      probe.audit.restore();
    }
  });

  test("generation stage: a body cancelled before its first read still tears the generation down", async () => {
    let fixture: ReturnType<typeof webSearchFixture> | undefined;
    const probe = releaseProbe(() => fixture);
    try {
      fixture = webSearchFixture([{ stalled: textGeneration("Let me think about") }]);
      const response = await fixture.post(
        "/v1/messages",
        request([{ role: "user", content: "Search." }], { stream: true }),
      );
      expect(fixture.inputs).toHaveLength(1);
      // The client leaves the body unread: the loop never starts consuming it.
      await response.body?.cancel();
      expect(await probe.released()).toBe(true);
      expect(probe.atRelease()?.upstreamAborts).toBeGreaterThan(0);
      expect(searchCalls(fixture)).toHaveLength(0);
    } finally {
      probe.audit.restore();
    }
  });

  test("persistence stage: a cancel while the result is recorded keeps the recorded outcome", async () => {
    let fixture: ReturnType<typeof webSearchFixture> | undefined;
    const probe = releaseProbe(() => fixture);
    try {
      fixture = webSearchFixture([
        searchCallGeneration(QUERY),
        { stalled: textGeneration("Writing") },
        textGeneration(FINAL_TEXT),
      ]);
      const target = fixture;
      let cancel: (() => void) | undefined;
      const complete = target.store.complete.bind(target.store);
      target.store.complete = (...args) => {
        const written = complete(...args);
        cancel?.();
        return written;
      };
      const response = await target.post(
        "/v1/messages",
        request([{ role: "user", content: "Search." }], { stream: true }),
      );
      const reader = response.body?.getReader();
      cancel = () => void reader?.cancel();
      while (true) {
        const next = await reader?.read();
        if (!next || next.done) break;
      }
      expect(await probe.released()).toBe(true);
      // The search finished before the cancel took effect: it stays completed.
      expect(probe.atRelease()?.statuses).toEqual(["completed"]);
      expect(searchCalls(target)).toHaveLength(1);
      expect(target.inputs.length).toBeLessThanOrEqual(2);
    } finally {
      probe.audit.restore();
    }
  });

  test("backpressure stage: a consumer that stops reading and then cancels leaves nothing running", async () => {
    let fixture: ReturnType<typeof webSearchFixture> | undefined;
    const probe = releaseProbe(() => fixture);
    try {
      fixture = webSearchFixture([searchCallGeneration(QUERY), textGeneration(FINAL_TEXT)]);
      const response = await fixture.post(
        "/v1/messages",
        request([{ role: "user", content: "Search." }], { stream: true }),
      );
      const reader = response.body?.getReader();
      // Read the first frame only; the provider must not run ahead of the client.
      expect((await reader?.read())?.done).toBe(false);
      expect(await waitFor(() => fixture?.inputs.length === 1)).toBe(true);
      await reader?.cancel();
      expect(await probe.released()).toBe(true);
      expect(probe.atRelease()?.upstreamAborts).toBeGreaterThan(0);
      expect(searchCalls(fixture)).toHaveLength(0);
      expect(fixture.inputs).toHaveLength(1);
      expect(probe.atRelease()?.statuses.every((status) => status !== "executing")).toBe(true);
    } finally {
      probe.audit.restore();
    }
  });

  test("streamed mixed and paused turns end with tool_use and pause_turn", async () => {
    const mixed = webSearchFixture([mixedGeneration()]);
    const mixedStream = await mixed.post(
      "/v1/messages",
      request([{ role: "user", content: "Search and check T-1." }], {
        tools: [SEARCH_TOOL, CLIENT_TOOL],
        stream: true,
      }),
    );
    const mixedEvents = sseData(await mixedStream.text());
    expect(
      mixedEvents
        .filter((event) => event.type === "content_block_start")
        .map((event) => (event.content_block as Block).type),
    ).toEqual(["text", "server_tool_use", "tool_use"]);
    expect(
      (mixedEvents.find((event) => event.type === "message_delta")?.delta as Block).stop_reason,
    ).toBe("tool_use");
    const paused = webSearchFixture([searchCallGeneration(QUERY)], {
      config: { request_timeout_ms: 3_000, web_search_timeout_ms: 10_000 },
    });
    const pausedStream = await paused.post(
      "/v1/messages",
      request([{ role: "user", content: "Search." }], { stream: true }),
    );
    const pausedEvents = sseData(await pausedStream.text());
    expect(
      (pausedEvents.find((event) => event.type === "message_delta")?.delta as Block).stop_reason,
    ).toBe("pause_turn");
    expect(pausedEvents.filter((event) => event.type === "message_stop")).toHaveLength(1);
    expect(searchCalls(paused)).toHaveLength(0);
  });

  test("audit records carry no query, URL, snippet or identifiers", async () => {
    const audit = captureAuditEvents();
    try {
      const fixture = webSearchFixture([searchCallGeneration(QUERY), textGeneration(FINAL_TEXT)]);
      await json(
        await fixture.post("/v1/messages", request([{ role: "user", content: "Search." }])),
      );
      const serialized = JSON.stringify(audit.events());
      expect(serialized).not.toContain(QUERY);
      for (const source of FIXTURE_SOURCES) {
        expect(serialized).not.toContain(source.url);
        expect(serialized).not.toContain(source.snippet);
        expect(serialized).not.toContain(source.title);
      }
      expect(serialized).not.toContain("call_fixture_search_0001");
      expect(serialized).not.toContain("srvtoolu_");
      expect(serialized).not.toContain("kws1_");
    } finally {
      audit.restore();
    }
  });
});

function jsonRpcError(code: number): McpResponder {
  return (call) =>
    Response.json({
      id: call.id,
      jsonrpc: "2.0",
      error: { code, message: "upstream detail that must not leak" },
    });
}

function unknownSchema(): McpResponder {
  return (call) =>
    Response.json({
      id: call.id,
      jsonrpc: "2.0",
      result: {
        content: [{ type: "text", text: JSON.stringify({ hits: [], detail: "upstream detail" }) }],
        isError: false,
      },
    });
}

function failingCalls(responder: McpResponder): McpResponder {
  return (call) => (call.method === "tools/call" ? responder(call) : defaultMcpResponder()(call));
}
