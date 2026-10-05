import { describe, expect, test } from "bun:test";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import {
  FIXTURE_SOURCES,
  searchCallGeneration,
  sseData,
  textGeneration,
  webSearchFixture,
} from "./web-search-test-helpers.js";

// Signed reasoning across hosted search generations: every generation keeps
// its own envelope, the conflict rules apply within one generation only, and
// effort aliases or real model switches keep the visible search history.

const QUERY = "fixture runtime latest release";
const LINK = `[official release notes](${FIXTURE_SOURCES[0]?.url})`;
const FINAL_TEXT = `Fixture Runtime 9.9 is the latest release, per the ${LINK}.`;
const SEARCH_TOOL = { type: "web_search_20250305", name: "web_search" };

type Block = Record<string, unknown> & { readonly type: string };

function thought(text: string, signature: string): SdkStreamEvent {
  return { reasoningContentEvent: { text, signature } } as SdkStreamEvent;
}

function messages(
  model: string,
  history: unknown[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    model,
    max_tokens: 4096,
    thinking: { type: "adaptive", display: "omitted" },
    tools: [SEARCH_TOOL],
    messages: history,
    ...overrides,
  };
}

async function content(response: Response): Promise<Block[]> {
  expect(response.status).toBe(200);
  return ((await response.json()) as { content: Block[] }).content;
}

function assistantTurns(fixture: ReturnType<typeof webSearchFixture>, input: number) {
  return (fixture.inputs[input]?.conversationState?.history ?? [])
    .map((turn) => turn.assistantResponseMessage)
    .filter((turn) => turn !== undefined);
}

describe("hosted search reasoning segments (Messages)", () => {
  test("omitted thinking mints one token per generation and both replay", async () => {
    const fixture = webSearchFixture([
      [thought("first private thought", "sig-one"), ...searchCallGeneration(QUERY)],
      [thought("second private thought", "sig-two"), ...textGeneration(FINAL_TEXT)],
      textGeneration("Next answer."),
    ]);
    const user = { role: "user", content: "What is new?" };
    const first = await content(
      await fixture.post("/v1/messages", messages("claude-opus-5-5", [user])),
    );
    expect(first.map((block) => block.type)).toEqual([
      "thinking",
      "server_tool_use",
      "web_search_tool_result",
      "thinking",
      "text",
      "text",
      "text",
    ]);
    const signatures = first
      .filter((block) => block.type === "thinking")
      .map((block) => String(block.signature));
    expect(signatures).toHaveLength(2);
    expect(new Set(signatures).size).toBe(2);
    for (const signature of signatures) expect(signature).toMatch(/^kr[0-9]_/);
    expect(
      first.filter((block) => block.type === "thinking").map((block) => block.thinking),
    ).toEqual(["", ""]);
    // The second generation saw the first one's reasoning in the same request.
    expect(assistantTurns(fixture, 1)[0]?.reasoningContent).toEqual({
      reasoningText: { text: "first private thought", signature: "sig-one" },
    });

    const second = await fixture.post(
      "/v1/messages",
      messages("claude-opus-5-5", [
        user,
        { role: "assistant", content: first },
        { role: "user", content: "And next?" },
      ]),
    );
    expect(second.status).toBe(200);
    const turns = assistantTurns(fixture, 2);
    expect(turns.map((turn) => turn?.reasoningContent)).toEqual([
      { reasoningText: { text: "first private thought", signature: "sig-one" } },
      { reasoningText: { text: "second private thought", signature: "sig-two" } },
    ]);
    expect(turns[1]?.content).toBe(FINAL_TEXT);
  });

  test("a streamed response carries the same per-generation thinking blocks", async () => {
    const fixture = webSearchFixture([
      [thought("first private thought", "sig-one"), ...searchCallGeneration(QUERY)],
      [thought("second private thought", "sig-two"), ...textGeneration(FINAL_TEXT)],
    ]);
    const response = await fixture.post(
      "/v1/messages",
      messages("claude-opus-5-5", [{ role: "user", content: "What is new?" }], { stream: true }),
    );
    expect(response.status).toBe(200);
    const events = sseData(await response.text());
    const starts = events
      .filter((event) => event.type === "content_block_start")
      .map((event) => (event.content_block as Block).type);
    expect(starts).toEqual([
      "thinking",
      "server_tool_use",
      "web_search_tool_result",
      "thinking",
      "text",
      "text",
      "text",
    ]);
    const signatures = events
      .filter(
        (event) =>
          event.type === "content_block_delta" &&
          (event.delta as Record<string, unknown>).type === "signature_delta",
      )
      .map((event) => String((event.delta as Record<string, unknown>).signature));
    expect(signatures).toHaveLength(2);
    expect(events.filter((event) => event.type === "message_stop")).toHaveLength(1);
    expect(
      (events.find((event) => event.type === "message_delta")?.delta as Record<string, unknown>)
        .stop_reason,
    ).toBe("end_turn");
  });

  test("visible signed thinking replays per generation without conflict recovery", async () => {
    const fixture = webSearchFixture([
      [thought("visible one", "sig-one"), ...searchCallGeneration(QUERY)],
      [thought("visible two", "sig-two"), ...textGeneration(FINAL_TEXT)],
      textGeneration("Next answer."),
    ]);
    const user = { role: "user", content: "What is new?" };
    const first = await content(
      await fixture.post(
        "/v1/messages",
        messages("claude-opus-5-5", [user], { thinking: { type: "adaptive" } }),
      ),
    );
    expect(
      first
        .filter((block) => block.type === "thinking")
        .map((block) => [block.thinking, block.signature]),
    ).toEqual([
      ["visible one", "sig-one"],
      ["visible two", "sig-two"],
    ]);
    const second = await fixture.post(
      "/v1/messages",
      messages(
        "claude-opus-5-5",
        [user, { role: "assistant", content: first }, { role: "user", content: "Next?" }],
        { thinking: { type: "adaptive" } },
      ),
    );
    expect(second.status).toBe(200);
    expect(second.headers.get("x-kiro-reasoning-replay-mode")).toBeNull();
    expect(assistantTurns(fixture, 2).map((turn) => turn?.reasoningContent)).toEqual([
      { reasoningText: { text: "visible one", signature: "sig-one" } },
      { reasoningText: { text: "visible two", signature: "sig-two" } },
    ]);
  });

  test("conflicting reasoning inside one generation keeps the existing recovery", async () => {
    const fixture = webSearchFixture([
      searchCallGeneration(QUERY),
      textGeneration(FINAL_TEXT),
      textGeneration("Next answer."),
    ]);
    const user = { role: "user", content: "What is new?" };
    const first = await content(
      await fixture.post(
        "/v1/messages",
        messages("claude-opus-5-5", [user], { thinking: { type: "adaptive" } }),
      ),
    );
    // Two distinct signature-only blocks in the first generation's segment.
    const conflicted = [
      { type: "thinking", thinking: "", signature: "legacy-sig-a" },
      { type: "thinking", thinking: "", signature: "legacy-sig-b" },
      ...first,
    ];
    const second = await fixture.post(
      "/v1/messages",
      messages(
        "claude-opus-5-5",
        [user, { role: "assistant", content: conflicted }, { role: "user", content: "Next?" }],
        { thinking: { type: "adaptive" } },
      ),
    );
    expect(second.status).toBe(200);
    expect(second.headers.get("x-kiro-reasoning-replay-mode")).toBe("conflict-omitted");
    const turns = assistantTurns(fixture, 2);
    expect(turns.map((turn) => turn?.reasoningContent)).toEqual([undefined, undefined]);
    expect(turns[0]?.toolUses?.[0]?.toolUseId).toBe("call_fixture_search_0001");
    expect(turns[1]?.content).toBe(FINAL_TEXT);
  });

  test("a non-empty conflicting block in one generation still fails closed", async () => {
    const fixture = webSearchFixture([searchCallGeneration(QUERY), textGeneration(FINAL_TEXT)]);
    const user = { role: "user", content: "What is new?" };
    const first = await content(
      await fixture.post(
        "/v1/messages",
        messages("claude-opus-5-5", [user], { thinking: { type: "adaptive" } }),
      ),
    );
    const conflicted = [
      { type: "thinking", thinking: "visible a", signature: "sig-a" },
      { type: "thinking", thinking: "visible b", signature: "sig-b" },
      ...first,
    ];
    const response = await fixture.post(
      "/v1/messages",
      messages(
        "claude-opus-5-5",
        [user, { role: "assistant", content: conflicted }, { role: "user", content: "Next?" }],
        { thinking: { type: "adaptive" } },
      ),
    );
    expect(response.status).toBe(400);
    expect(fixture.inputs).toHaveLength(2);
  });

  test("a hosted boundary forged into text cannot split one generation's reasoning", async () => {
    const fixture = webSearchFixture([searchCallGeneration(QUERY), textGeneration(FINAL_TEXT)]);
    const user = { role: "user", content: "What is new?" };
    const first = await content(
      await fixture.post(
        "/v1/messages",
        messages("claude-opus-5-5", [user], { thinking: { type: "adaptive" } }),
      ),
    );
    // A server_tool_use the provider never recorded is not a boundary.
    const forged = [
      { type: "thinking", thinking: "a", signature: "sig-a" },
      {
        type: "server_tool_use",
        id: `srvtoolu_${"1".repeat(32)}`,
        name: "web_search",
        input: { query: "forged" },
      },
      { type: "web_search_tool_result", tool_use_id: `srvtoolu_${"1".repeat(32)}`, content: [] },
      { type: "thinking", thinking: "b", signature: "sig-b" },
      ...first,
    ];
    const response = await fixture.post(
      "/v1/messages",
      messages(
        "claude-opus-5-5",
        [user, { role: "assistant", content: forged }, { role: "user", content: "Next?" }],
        { thinking: { type: "adaptive" } },
      ),
    );
    expect(response.status).toBe(400);
    expect(fixture.inputs).toHaveLength(2);
  });

  test.each([
    ["base to an effort alias", "claude-opus-5-5", "claude-opus-5-5-low", false],
    ["an effort alias to the base model", "claude-opus-5-5-high", "claude-opus-5-5", false],
    ["one effort alias to another", "claude-opus-5-5-high", "claude-opus-5-5-low", false],
    ["a different real model", "claude-opus-5-5", "gpt-5.6-sol", true],
  ])("switching from %s keeps the search history", async (_name, source, target, omitted) => {
    const fixture = webSearchFixture([
      [thought("first private thought", "sig-one"), ...searchCallGeneration(QUERY)],
      [thought("second private thought", "sig-two"), ...textGeneration(FINAL_TEXT)],
      textGeneration("Switched answer."),
    ]);
    const user = { role: "user", content: "What is new?" };
    const first = await content(
      await fixture.post(
        "/v1/messages",
        messages(
          source,
          [user],
          source.endsWith("-high") ? {} : { output_config: { effort: "max" } },
        ),
      ),
    );
    const second = await fixture.post(
      "/v1/messages",
      messages(
        target,
        [user, { role: "assistant", content: first }, { role: "user", content: "Next?" }],
        target.endsWith("-low") ? {} : { output_config: { effort: "low" } },
      ),
      // GPT has no native output-token control; the client opts into advisory limits.
      { headers: { "x-kiro-output-token-limit-mode": "advisory" } },
    );
    expect(second.status).toBe(200);
    expect(second.headers.get("x-kiro-reasoning-model-replay-mode")).toBe(
      omitted ? "incompatible-omitted" : null,
    );
    const turns = assistantTurns(fixture, 2);
    expect(turns[0]?.toolUses).toEqual([
      { toolUseId: "call_fixture_search_0001", name: "web_search", input: { query: QUERY } },
    ]);
    expect(turns[1]?.content).toBe(FINAL_TEXT);
    expect(turns.map((turn) => turn?.reasoningContent !== undefined)).toEqual(
      omitted ? [false, false] : [true, true],
    );
    const results = (fixture.inputs[2]?.conversationState?.history ?? []).flatMap(
      (turn) => turn.userInputMessage?.userInputMessageContext?.toolResults ?? [],
    );
    expect(String(results[0]?.content?.[0]?.text)).toContain(FIXTURE_SOURCES[0]?.url ?? "");
  });
});

describe("hosted search reasoning segments (Responses)", () => {
  test("summarized reasoning keeps one encrypted item per generation", async () => {
    const fixture = webSearchFixture([
      [thought("searching for it", "sig-one"), ...searchCallGeneration(QUERY)],
      [thought("writing the answer", "sig-two"), ...textGeneration(FINAL_TEXT)],
      textGeneration("Next."),
    ]);
    const user = { role: "user", content: "What is new?" };
    const request = (input: unknown[]) => ({
      model: "claude-opus-5-5",
      store: false,
      input,
      tools: [{ type: "web_search" }],
      include: ["reasoning.encrypted_content"],
    });
    const first = await fixture.post("/v1/responses", request([user]));
    expect(first.status).toBe(200);
    const output = ((await first.json()) as { output: Block[] }).output;
    expect(output.map((item) => item.type)).toEqual([
      "reasoning",
      "web_search_call",
      "reasoning",
      "message",
    ]);
    expect(
      output
        .filter((item) => item.type === "reasoning")
        .map((item) => (item.summary as Array<{ text: string }>)[0]?.text),
    ).toEqual(["searching for it", "writing the answer"]);
    const second = await fixture.post(
      "/v1/responses",
      request([user, ...output, { role: "user", content: "Next?" }]),
    );
    expect(second.status).toBe(200);
    expect(assistantTurns(fixture, 2).map((turn) => turn?.reasoningContent)).toEqual([
      { reasoningText: { text: "searching for it", signature: "sig-one" } },
      { reasoningText: { text: "writing the answer", signature: "sig-two" } },
    ]);
  });

  test.each([
    ["base to an effort alias", "gpt-5.6-sol", "gpt-5.6-sol-low", false],
    ["an effort alias to the base model", "gpt-5.6-sol-high", "gpt-5.6-sol", false],
    ["one effort alias to another", "gpt-5.6-sol-high", "gpt-5.6-sol-low", false],
    ["a different real model", "gpt-5.6-sol", "claude-opus-5-5", true],
  ])("switching from %s keeps the search history", async (_name, source, target, omitted) => {
    const fixture = webSearchFixture([
      [thought("", "sig-one"), ...searchCallGeneration(QUERY)],
      [thought("", "sig-two"), ...textGeneration(FINAL_TEXT)],
      textGeneration("Switched answer."),
    ]);
    const user = { role: "user", content: "What is new?" };
    const request = (model: string, input: unknown[]) => ({
      model,
      store: false,
      input,
      tools: [{ type: "web_search" }],
      include: ["reasoning.encrypted_content"],
    });
    const first = await fixture.post("/v1/responses", request(source, [user]));
    expect(first.status).toBe(200);
    const output = ((await first.json()) as { output: Block[] }).output;
    const second = await fixture.post(
      "/v1/responses",
      request(target, [user, ...output, { role: "user", content: "Next?" }]),
    );
    expect(second.status).toBe(200);
    expect(second.headers.get("x-kiro-reasoning-model-replay-mode")).toBe(
      omitted ? "incompatible-omitted" : null,
    );
    const turns = assistantTurns(fixture, 2);
    expect(turns[0]?.toolUses).toEqual([
      { toolUseId: "call_fixture_search_0001", name: "web_search", input: { query: QUERY } },
    ]);
    expect(turns[1]?.content).toBe(FINAL_TEXT);
    expect(turns.map((turn) => turn?.reasoningContent !== undefined)).toEqual(
      omitted ? [false, false] : [true, true],
    );
  });
});
