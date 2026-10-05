import { describe, expect, test } from "bun:test";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import { SqliteResponseStore } from "../src/server/responses/store.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";
import { snapshotLookupHash } from "../src/web-search/crypto.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import {
  defaultMcpResponder,
  FIXTURE_SOURCES,
  searchCallGeneration,
  sseData,
  textGeneration,
  waitFor,
  webSearchFixture,
} from "./web-search-test-helpers.js";

// Hosted search through the OpenAI Responses ingress: Codex-shaped history
// replay, mixed hosted/function groups, stored continuation, the private
// alias for a client function named web_search, and pre-dispatch rejections.

const QUERY = "fixture runtime latest release";
const LINK = `[official release notes](${FIXTURE_SOURCES[0]?.url})`;
const FINAL_TEXT = `Fixture Runtime 9.9 is the latest release, per the ${LINK}.`;
const SEARCH_TOOL = { type: "web_search", external_web_access: true };
const FUNCTION_TOOL = {
  type: "function",
  name: "lookup_ticket",
  description: "Look up a support ticket",
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
};

type Item = Record<string, unknown> & { readonly type: string };
type ResponseBody = {
  readonly id: string;
  readonly output: Item[];
  readonly usage: Record<string, unknown>;
  readonly status: string;
  readonly tools: ReadonlyArray<Record<string, unknown>>;
};

function body(input: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "gpt-5.6-sol",
    store: false,
    stream: false,
    input,
    tools: [SEARCH_TOOL],
    tool_choice: "auto",
    include: ["reasoning.encrypted_content"],
    ...overrides,
  };
}

/** One GPT generation with signature-only reasoning before its output. */
function reasoned(signature: string, events: readonly SdkStreamEvent[]): SdkStreamEvent[] {
  return [{ reasoningContentEvent: { text: "...", signature } } as SdkStreamEvent, ...events];
}

async function json(response: Response): Promise<ResponseBody> {
  expect(response.status).toBe(200);
  return (await response.json()) as ResponseBody;
}

function searchCalls(fixture: ReturnType<typeof webSearchFixture>) {
  return fixture.mcpCalls.filter((call) => call.method === "tools/call");
}

/**
 * What Codex 0.159.3 replays (captured): item ids, web_search_call status and
 * action.query, reasoning envelopes; no sources or annotations.
 */
function codexReplay(output: readonly Item[]): Item[] {
  return output.map((item) => {
    if (item.type === "web_search_call") {
      const action = item.action as { readonly query: string };
      return {
        type: "web_search_call",
        id: item.id,
        status: item.status,
        action: { type: "search", query: action.query },
      } as Item;
    }
    if (item.type === "message") {
      const content = item.content as Array<{ readonly text: string }>;
      return {
        type: "message",
        id: item.id,
        role: "assistant",
        content: content.map((part) => ({ type: "output_text", text: part.text })),
      } as Item;
    }
    if (item.type === "reasoning") {
      return {
        type: "reasoning",
        id: item.id,
        summary: [],
        content: null,
        encrypted_content: item.encrypted_content,
      } as Item;
    }
    return item;
  });
}

describe("Responses hosted search history", () => {
  test("a Codex-shaped replay restores both generations and their reasoning", async () => {
    const fixture = webSearchFixture([
      reasoned("sig-search", searchCallGeneration(QUERY)),
      reasoned("sig-answer", textGeneration(FINAL_TEXT)),
      textGeneration("Follow-up answer."),
    ]);
    const user = { role: "user", content: [{ type: "input_text", text: "What is new?" }] };
    const first = await json(await fixture.post("/v1/responses", body([user])));
    expect(first.output.map((item) => item.type)).toEqual([
      "reasoning",
      "web_search_call",
      "message",
      "reasoning",
    ]);
    expect(first.output[0]?.encrypted_content).toBeString();
    expect(first.output[3]?.encrypted_content).toBeString();
    const second = await json(
      await fixture.post(
        "/v1/responses",
        body([
          user,
          ...codexReplay(first.output),
          { role: "user", content: [{ type: "input_text", text: "Anything else?" }] },
        ]),
      ),
    );
    expect(second.output.some((item) => item.type === "message")).toBe(true);
    expect(searchCalls(fixture)).toHaveLength(1);
    const turns = fixture.inputs[2]?.conversationState?.history ?? [];
    const searchTurn = turns.find((turn) => turn.assistantResponseMessage?.toolUses?.length);
    expect(searchTurn?.assistantResponseMessage?.toolUses).toEqual([
      { toolUseId: "call_fixture_search_0001", name: "web_search", input: { query: QUERY } },
    ]);
    // Each generation keeps its own authenticated reasoning envelope.
    expect(searchTurn?.assistantResponseMessage?.reasoningContent).toEqual({
      reasoningText: { text: "...", signature: "sig-search" },
    });
    const answerTurn = turns.at(-1)?.assistantResponseMessage;
    expect(answerTurn?.content).toBe(FINAL_TEXT);
    expect(answerTurn?.reasoningContent).toEqual({
      reasoningText: { text: "...", signature: "sig-answer" },
    });
    const results = turns.flatMap(
      (turn) => turn.userInputMessage?.userInputMessageContext?.toolResults ?? [],
    );
    expect(results.map((result) => result.toolUseId)).toEqual(["call_fixture_search_0001"]);
    expect(String(results[0]?.content?.[0]?.text)).toContain(FIXTURE_SOURCES[0]?.url ?? "");
  });

  test.each([
    ["one search per generation", false],
    ["a later generation with neither reasoning nor text", true],
  ])("a streamed turn replays in output_item.done order with %s", async (_name, bare) => {
    // Codex records items as their output_item.done events arrive, not in
    // output_index order; every generation must still own its reasoning.
    const fixture = webSearchFixture([
      reasoned("sig-one", searchCallGeneration(QUERY)),
      bare
        ? searchCallGeneration("second query", "call_fixture_search_0002")
        : reasoned("sig-two", searchCallGeneration("second query", "call_fixture_search_0002")),
      reasoned("sig-three", textGeneration(FINAL_TEXT)),
      textGeneration("Follow-up answer."),
    ]);
    const user = { role: "user", content: [{ type: "input_text", text: "What is new?" }] };
    const streamed = await fixture.post("/v1/responses", body([user], { stream: true }));
    expect(streamed.status).toBe(200);
    const done = sseData(await streamed.text())
      .filter((event) => event.type === "response.output_item.done")
      .map((event) => event.item as Item);
    const second = await fixture.post(
      "/v1/responses",
      body([
        user,
        ...codexReplay(done),
        { role: "user", content: [{ type: "input_text", text: "Anything else?" }] },
      ]),
    );
    expect(second.status).toBe(200);
    const turns = fixture.inputs[3]?.conversationState?.history ?? [];
    const signatures = turns
      .map((turn) => turn.assistantResponseMessage?.reasoningContent?.reasoningText?.signature)
      .filter((signature) => signature !== undefined);
    expect(signatures).toEqual(
      bare ? ["sig-one", "sig-three"] : ["sig-one", "sig-two", "sig-three"],
    );
    const searchTurns = turns.filter((turn) => turn.assistantResponseMessage?.toolUses?.length);
    expect(
      searchTurns.map((turn) => turn.assistantResponseMessage?.toolUses?.[0]?.toolUseId),
    ).toEqual(["call_fixture_search_0001", "call_fixture_search_0002"]);
    expect(
      searchTurns[0]?.assistantResponseMessage?.reasoningContent?.reasoningText?.signature,
    ).toBe("sig-one");
  });

  test.each([
    [
      "a changed query",
      (items: Item[]) => {
        const call = items.find((item) => item.type === "web_search_call");
        if (call) (call as Record<string, unknown>).action = { type: "search", query: "other" };
      },
    ],
    [
      "an unknown call id",
      (items: Item[]) => {
        const call = items.find((item) => item.type === "web_search_call");
        if (call) (call as Record<string, unknown>).id = `ws_${"0".repeat(32)}`;
      },
    ],
    [
      "a non-terminal status",
      (items: Item[]) => {
        const call = items.find((item) => item.type === "web_search_call");
        if (call) (call as Record<string, unknown>).status = "in_progress";
      },
    ],
    [
      "mismatched sources",
      (items: Item[]) => {
        const call = items.find((item) => item.type === "web_search_call");
        if (call) {
          (call as Record<string, unknown>).action = {
            type: "search",
            query: QUERY,
            sources: [{ type: "url", url: "https://forged.example/" }],
          };
        }
      },
    ],
    [
      "a forged failure",
      (items: Item[]) => {
        const call = items.find((item) => item.type === "web_search_call");
        if (call) (call as Record<string, unknown>).status = "failed";
      },
    ],
  ])("rejects a replay with %s before any dispatch", async (_name, mutate) => {
    const fixture = webSearchFixture([searchCallGeneration(QUERY), textGeneration(FINAL_TEXT)]);
    const user = { role: "user", content: "What is new?" };
    const first = await json(await fixture.post("/v1/responses", body([user], { include: [] })));
    const replay = codexReplay(first.output);
    mutate(replay);
    const response = await fixture.post(
      "/v1/responses",
      body([user, ...replay, { role: "user", content: "More?" }], { include: [] }),
    );
    expect(response.status).toBe(400);
    expect(fixture.inputs).toHaveLength(2);
  });

  test("sources are published only when included", async () => {
    const fixture = webSearchFixture([
      searchCallGeneration(QUERY),
      textGeneration(FINAL_TEXT),
      searchCallGeneration(QUERY, "call_fixture_search_0002"),
      textGeneration(FINAL_TEXT),
    ]);
    const plain = await json(
      await fixture.post("/v1/responses", body([{ role: "user", content: "Search." }])),
    );
    const call = plain.output.find((item) => item.type === "web_search_call");
    expect(call?.action).toEqual({ type: "search", query: QUERY, queries: [QUERY] });
    const included = await json(
      await fixture.post(
        "/v1/responses",
        body([{ role: "user", content: "Search." }], {
          include: ["reasoning.encrypted_content", "web_search_call.action.sources"],
        }),
      ),
    );
    const withSources = included.output.find((item) => item.type === "web_search_call");
    expect((withSources?.action as { sources?: unknown[] }).sources).toHaveLength(2);
  });
});

describe("Responses mixed hosted and function groups", () => {
  test("completes the search first, then hands the function call to the client", async () => {
    const fixture = webSearchFixture([
      [
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
            toolUseId: "call_client_0001",
            name: "lookup_ticket",
            input: JSON.stringify({ id: "T-1" }),
            stop: true,
          },
        },
      ] as SdkStreamEvent[],
      textGeneration(FINAL_TEXT),
    ]);
    const tools = [SEARCH_TOOL, FUNCTION_TOOL];
    const user = { role: "user", content: "Search and check T-1." };
    const first = await json(await fixture.post("/v1/responses", body([user], { tools })));
    expect(first.output.map((item) => item.type)).toEqual(["web_search_call", "function_call"]);
    expect(first.output[0]?.status).toBe("completed");
    expect(first.output[1]).toMatchObject({ call_id: "call_client_0001", name: "lookup_ticket" });
    expect(searchCalls(fixture)).toHaveLength(1);
    expect(fixture.inputs).toHaveLength(1);

    const second = await json(
      await fixture.post(
        "/v1/responses",
        body(
          [
            user,
            ...codexReplay(first.output),
            { type: "function_call_output", call_id: "call_client_0001", output: "T-1 is open" },
          ],
          { tools },
        ),
      ),
    );
    expect(second.output.map((item) => item.type)).toEqual(["message"]);
    expect(searchCalls(fixture)).toHaveLength(1);
    const conversation = fixture.inputs[1]?.conversationState;
    const toolUses = (conversation?.history ?? []).flatMap(
      (turn) => turn.assistantResponseMessage?.toolUses ?? [],
    );
    expect(toolUses.map((use) => use.toolUseId)).toEqual([
      "call_fixture_search_0001",
      "call_client_0001",
    ]);
    const results = [
      ...(conversation?.history ?? []).flatMap(
        (turn) => turn.userInputMessage?.userInputMessageContext?.toolResults ?? [],
      ),
      ...(conversation?.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults ??
        []),
    ];
    expect(results.map((result) => result.toolUseId)).toEqual([
      "call_fixture_search_0001",
      "call_client_0001",
    ]);
  });

  test.each([
    ["output order", false],
    ["output_item.done order", true],
  ])("a mixed generation replays in %s as the one turn Kiro produced", async (_name, streamed) => {
    // Kiro emitted the client call first; the response publishes the completed
    // search first. Replay restores the generation itself: one assistant turn
    // with its text, reasoning and both calls in wire order, then one turn
    // with every result in the same order.
    const fixture = webSearchFixture([
      reasoned("sig-mixed", [
        { assistantResponseEvent: { content: "Checking both." } },
        {
          toolUseEvent: {
            toolUseId: "call_client_0001",
            name: "lookup_ticket",
            input: JSON.stringify({ id: "T-1" }),
            stop: true,
          },
        },
        {
          toolUseEvent: {
            toolUseId: "call_fixture_search_0001",
            name: "web_search",
            input: JSON.stringify({ query: QUERY }),
            stop: true,
          },
        },
      ] as SdkStreamEvent[]),
      textGeneration(FINAL_TEXT),
    ]);
    const tools = [SEARCH_TOOL, FUNCTION_TOOL];
    const user = { role: "user", content: "Search and check T-1." };
    const first = await fixture.post("/v1/responses", body([user], { tools, stream: streamed }));
    expect(first.status).toBe(200);
    const items = streamed
      ? sseData(await first.text())
          .filter((event) => event.type === "response.output_item.done")
          .map((event) => event.item as Item)
      : ((await first.json()) as ResponseBody).output;
    expect(new Set(items.map((item) => item.type))).toEqual(
      new Set(["reasoning", "message", "web_search_call", "function_call"]),
    );
    const second = await json(
      await fixture.post(
        "/v1/responses",
        body(
          [
            user,
            ...codexReplay(items),
            { type: "function_call_output", call_id: "call_client_0001", output: "T-1 is open" },
          ],
          { tools },
        ),
      ),
    );
    expect(second.output.some((item) => item.type === "message")).toBe(true);
    expect(searchCalls(fixture)).toHaveLength(1);
    const conversation = fixture.inputs[1]?.conversationState;
    const history = conversation?.history ?? [];
    expect(history).toHaveLength(2);
    const turn = history[1]?.assistantResponseMessage;
    expect(turn?.content).toBe("Checking both.");
    expect(turn?.reasoningContent).toEqual({
      reasoningText: { text: "...", signature: "sig-mixed" },
    });
    expect(turn?.toolUses?.map((use) => use.toolUseId)).toEqual([
      "call_client_0001",
      "call_fixture_search_0001",
    ]);
    const results =
      conversation?.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults ?? [];
    expect(results.map((result) => result.toolUseId)).toEqual([
      "call_client_0001",
      "call_fixture_search_0001",
    ]);
    expect(String(results[1]?.content?.[0]?.text)).toContain(FIXTURE_SOURCES[0]?.url ?? "");
  });

  test("a mixed continuation needs every function output before it may continue", async () => {
    const call = (id: string, ticket: string) => ({
      toolUseEvent: {
        toolUseId: id,
        name: "lookup_ticket",
        input: JSON.stringify({ id: ticket }),
        stop: true,
      },
    });
    const fixture = webSearchFixture([
      [
        ...searchCallGeneration(QUERY),
        call("call_client_0001", "T-1"),
        call("call_client_0002", "T-2"),
      ] as SdkStreamEvent[],
      textGeneration(FINAL_TEXT),
    ]);
    const tools = [SEARCH_TOOL, FUNCTION_TOOL];
    const user = { role: "user", content: "Search and check T-1 and T-2." };
    const first = await json(await fixture.post("/v1/responses", body([user], { tools })));
    const replay = [user, ...codexReplay(first.output)];
    const output = (callId: string) => ({
      type: "function_call_output",
      call_id: callId,
      output: "open",
    });
    for (const input of [
      [...replay, output("call_client_0002")],
      replay,
      [...replay, { role: "user", content: "Never mind." }],
      [...replay, output("call_client_0001"), { role: "user", content: "Also." }],
    ]) {
      const response = await fixture.post("/v1/responses", body(input, { tools }));
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: Record<string, unknown> }).error).toMatchObject({
        code: "invalid_tool_history",
      });
    }
    expect(fixture.inputs).toHaveLength(1);
    const complete = await fixture.post(
      "/v1/responses",
      body([...replay, output("call_client_0002"), output("call_client_0001")], { tools }),
    );
    expect(complete.status).toBe(200);
    expect(searchCalls(fixture)).toHaveLength(1);
  });

  test("a client function named web_search keeps its identity under a private alias", async () => {
    const fixture = webSearchFixture([
      [
        {
          toolUseEvent: {
            toolUseId: "call_fixture_search_0001",
            name: "web_search",
            input: JSON.stringify({ query: QUERY }),
            stop: true,
          },
        },
      ] as SdkStreamEvent[],
      textGeneration("Searched."),
    ]);
    const clientSearch = {
      type: "function",
      name: "web_search",
      description: "The client's own search",
      parameters: { type: "object", properties: { q: { type: "string" } } },
    };
    const response = await json(
      await fixture.post(
        "/v1/responses",
        body([{ role: "user", content: "Search." }], { tools: [SEARCH_TOOL, clientSearch] }),
      ),
    );
    const declared =
      fixture.inputs[0]?.conversationState?.currentMessage?.userInputMessage
        ?.userInputMessageContext?.tools ?? [];
    const names = declared.map((tool) => tool.toolSpecification?.name);
    expect(names).toContain("web_search");
    const alias = names.find((name) => name?.startsWith("kiro_fn_"));
    expect(alias).toBeDefined();
    expect(response.output[0]?.type).toBe("web_search_call");
    expect(searchCalls(fixture)).toHaveLength(1);
  });
});

describe("Responses stored continuation", () => {
  test("previous_response_id replays the search and keeps its snapshot alive", async () => {
    const database = new AccountsDatabase(":memory:");
    const responseStore = new SqliteResponseStore(database);
    const fixture = webSearchFixture(
      [searchCallGeneration(QUERY), textGeneration(FINAL_TEXT), textGeneration("Again.")],
      { database, dependencies: { responseStore } },
    );
    const first = await json(
      await fixture.post(
        "/v1/responses",
        body([{ role: "user", content: "What is new?" }], { store: true, include: [] }),
      ),
    );
    const callId = String(first.output.find((item) => item.type === "web_search_call")?.id);
    const record = database.getWebSearchSnapshot(snapshotLookupHash(fixture.tenantId, callId));
    expect(record?.expiresAt).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60_000);
    expect(first.tools).toContainEqual(SEARCH_TOOL);
    const second = await json(
      await fixture.post(
        "/v1/responses",
        body([{ role: "user", content: "And then?" }], {
          store: true,
          include: [],
          previous_response_id: first.id,
        }),
      ),
    );
    expect(second.status).toBe("completed");
    expect(searchCalls(fixture)).toHaveLength(1);
    const results = (fixture.inputs[2]?.conversationState?.history ?? []).flatMap(
      (turn) => turn.userInputMessage?.userInputMessageContext?.toolResults ?? [],
    );
    expect(results.map((result) => result.toolUseId)).toEqual(["call_fixture_search_0001"]);
  });

  test("a stored response is refused when its search history cannot be kept alive", async () => {
    const database = new AccountsDatabase(":memory:");
    const responseStore = new SqliteResponseStore(database);
    const fixture = webSearchFixture([searchCallGeneration(QUERY), textGeneration(FINAL_TEXT)], {
      database,
      dependencies: { responseStore },
    });
    const first = await json(
      await fixture.post(
        "/v1/responses",
        body([{ role: "user", content: "What is new?" }], { store: true, include: [] }),
      ),
    );
    // The snapshot row cannot be extended (storage failure or a concurrent prune).
    fixture.store.extend = () => false;
    const second = await fixture.post(
      "/v1/responses",
      body([{ role: "user", content: "And then?" }], {
        store: true,
        include: [],
        previous_response_id: first.id,
      }),
    );
    expect(second.status).toBe(503);
    expect(((await second.json()) as { error: Record<string, unknown> }).error).toMatchObject({
      code: "web_search_store_unavailable",
    });
    expect(fixture.inputs).toHaveLength(2);
  });

  test("completed search history stays on its owner account", async () => {
    const database = new AccountsDatabase(":memory:");
    const owner = webSearchFixture([searchCallGeneration(QUERY), textGeneration(FINAL_TEXT)], {
      database,
    });
    const user = { role: "user", content: "What is new?" };
    const first = await json(await owner.post("/v1/responses", body([user])));
    const elsewhere = webSearchFixture([textGeneration("UNEXPECTED")], {
      database,
      accountId: "another-fixture-account",
    });
    const moved = await elsewhere.post(
      "/v1/responses",
      body([user, ...codexReplay(first.output), { role: "user", content: "Continue." }]),
    );
    expect(moved.status).toBe(503);
    expect(((await moved.json()) as { error: Record<string, unknown> }).error).toMatchObject({
      code: "web_search_replay_owner_unavailable",
    });
    expect(elsewhere.inputs).toHaveLength(0);
  });
});

describe("Responses hosted search cancellation", () => {
  test("a consumer that cancels the stream during the search settles it before release", async () => {
    let fixture: ReturnType<typeof webSearchFixture> | undefined;
    let statusAtRelease: string | undefined;
    const status = () => {
      const id = fixture?.publishedSearchIds()[0];
      return id === undefined || fixture === undefined
        ? undefined
        : fixture.database.getWebSearchSnapshot(snapshotLookupHash(fixture.tenantId, id))?.status;
    };
    const audit = captureAuditEvents((record) => {
      if (record.event === "request_admission_released" && record.active_requests === 0) {
        statusAtRelease = status();
      }
    });
    let started: (() => void) | undefined;
    const searching = new Promise<void>((resolve) => {
      started = resolve;
    });
    try {
      fixture = webSearchFixture([searchCallGeneration(QUERY), textGeneration(FINAL_TEXT)], {
        mcp: async (call) => {
          if (call.method !== "tools/call") return defaultMcpResponder()(call);
          started?.();
          return await new Promise<Response>(() => {});
        },
      });
      const response = await fixture.post(
        "/v1/responses",
        body([{ role: "user", content: "Search." }], { stream: true }),
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
      expect(
        await waitFor(
          () => audit.events("request_admission_released").at(-1)?.active_requests === 0,
        ),
      ).toBe(true);
      expect(statusAtRelease).toBe("uncertain");
      expect(fixture.inputs).toHaveLength(1);
    } finally {
      audit.restore();
    }
  });
});

describe("Responses hosted search limits and rejections", () => {
  test("the generation limit ends the response with a typed failure", async () => {
    const fixture = webSearchFixture(
      [
        searchCallGeneration(QUERY),
        searchCallGeneration("again", "call_fixture_search_0002"),
        textGeneration("unused"),
      ],
      { config: { web_search_max_calls: 1 } },
    );
    const response = await fixture.post("/v1/responses", body([{ role: "user", content: "Go." }]));
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("web_search_iteration_limit");
    expect(searchCalls(fixture)).toHaveLength(1);

    const streamed = webSearchFixture(
      [searchCallGeneration(QUERY), searchCallGeneration("again", "call_fixture_search_0002")],
      { config: { web_search_max_calls: 1 } },
    );
    const stream = await streamed.post(
      "/v1/responses",
      body([{ role: "user", content: "Go." }], { stream: true }),
    );
    const events = sseData(await stream.text());
    expect(events.at(-1)?.type).toBe("response.failed");
    expect(
      ((events.at(-1)?.response as Record<string, unknown>).error as Record<string, unknown>).code,
    ).toBe("web_search_iteration_limit");
    expect(events.filter((event) => event.type === "response.completed")).toHaveLength(0);
  });

  test.each([
    ["cached search", { type: "web_search", external_web_access: false }],
    ["the preview tool", { type: "web_search_preview" }],
    ["localized search", { type: "web_search", user_location: { type: "approximate" } }],
    ["return_token_budget", { type: "web_search", return_token_budget: "unlimited" }],
    ["image search", { type: "web_search", search_content_types: ["image"] }],
  ])("rejects %s before dispatch", async (_name, tool) => {
    const fixture = webSearchFixture([textGeneration("unused")]);
    const response = await fixture.post(
      "/v1/responses",
      body([{ role: "user", content: "Search." }], { tools: [tool] }),
    );
    expect(response.status).toBe(400);
    expect(fixture.inputs).toHaveLength(0);
    expect(fixture.mcpCalls).toHaveLength(0);
  });

  test.each([
    ["service_tier priority (Fast)", { service_tier: "priority" }],
    ["image results", { include: ["web_search_call.results"] }],
    ["an unverified model", { model: "claude-fable-5-1" }],
  ])("rejects %s with hosted search before dispatch", async (_name, overrides) => {
    const fixture = webSearchFixture([textGeneration("unused")]);
    const response = await fixture.post(
      "/v1/responses",
      body([{ role: "user", content: "Search." }], overrides),
    );
    expect(response.status).toBe(400);
    expect(fixture.inputs).toHaveLength(0);
    expect(fixture.mcpCalls).toHaveLength(0);
  });

  test("disabled search rejects the declaration but still replays history", async () => {
    const database = new AccountsDatabase(":memory:");
    const enabled = webSearchFixture([searchCallGeneration(QUERY), textGeneration(FINAL_TEXT)], {
      database,
    });
    const user = { role: "user", content: "What is new?" };
    const first = await json(await enabled.post("/v1/responses", body([user], { include: [] })));
    const disabled = webSearchFixture([textGeneration("From history.")], {
      database,
      config: { web_search_enabled: false },
    });
    const declared = await disabled.post("/v1/responses", body([user], { include: [] }));
    expect(declared.status).toBe(400);
    expect(await declared.text()).toContain("web_search_disabled");
    const replayed = await json(
      await disabled.post(
        "/v1/responses",
        body([user, ...codexReplay(first.output), { role: "user", content: "Again?" }], {
          include: [],
          tools: [],
        }),
      ),
    );
    expect(replayed.output.map((item) => item.type)).toEqual(["message"]);
    expect(disabled.mcpCalls).toHaveLength(0);
  });
});
