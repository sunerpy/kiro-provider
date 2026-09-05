import { describe, expect, test } from "bun:test";
import { RequestTransformError } from "../src/kiro/transform/errors.js";
import { buildHistory } from "../src/kiro/transform/history-builder.js";
import { assistantOutputFingerprint } from "../src/protocol/canonical.js";
import { adaptResponsesRequest } from "../src/server/responses/request-adapter.js";
import { message, parsedResponses, TEST_MODEL } from "./canonical-test-helpers.js";

const TOOLS = [
  {
    type: "function",
    name: "lookup",
    description: "Look up one synthetic status value.",
    parameters: { type: "object", properties: { q: { type: "string" } } },
  },
] as const;

const FUNCTION_CALL = {
  type: "function_call",
  call_id: "call_1",
  name: "lookup",
  arguments: '{"q":"status"}',
} as const;

const FUNCTION_CALL_OUTPUT = {
  type: "function_call_output",
  call_id: "call_1",
  output: "healthy",
} as const;

const USER_NEXT = { role: "user", content: "next" } as const;

function reasoningItem(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return { type: "reasoning", summary: [{ type: "summary_text", text: "visible" }], ...overrides };
}

function adapt(input: readonly unknown[]) {
  return adaptResponsesRequest(
    parsedResponses({
      model: TEST_MODEL,
      include: ["reasoning.encrypted_content"],
      tools: TOOLS,
      input,
    }),
  );
}

const TURN_FINGERPRINT = assistantOutputFingerprint({
  text: "answer",
  toolCalls: [{ id: "call_1", name: "lookup", input: '{"q":"status"}' }],
});

describe("Responses reasoning replay turn groups (A8)", () => {
  test("replays [rs1, message, rs2, function_call] as one turn with one envelope", () => {
    const result = adapt([
      reasoningItem({ id: "rs_first", encrypted_content: "kr1_turn" }),
      { role: "assistant", content: "answer" },
      reasoningItem({ id: "rs_second", summary: [{ type: "summary_text", text: "later" }] }),
      FUNCTION_CALL,
      FUNCTION_CALL_OUTPUT,
      USER_NEXT,
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.reasoningReplays).toEqual([
      {
        lookup: { kind: "responses-token", encryptedContent: "kr1_turn" },
        outputFingerprint: TURN_FINGERPRINT,
        insertBeforeMessage: 0,
        sourceId: "rs_first",
        path: "input.0",
      },
    ]);
    expect(result.body.messages.map((entry) => entry.role)).toEqual([
      "assistant",
      "assistant",
      "tool",
      "user",
    ]);
  });

  test("collapses sibling reasoning items that echo the same token into one replay", () => {
    const result = adapt([
      reasoningItem({ encrypted_content: "kr1_turn" }),
      { role: "assistant", content: "answer" },
      reasoningItem({ encrypted_content: "kr1_turn" }),
      FUNCTION_CALL,
      FUNCTION_CALL_OUTPUT,
      USER_NEXT,
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.reasoningReplays).toHaveLength(1);
    expect(result.body.reasoningReplays[0]).toMatchObject({
      outputFingerprint: TURN_FINGERPRINT,
      insertBeforeMessage: 0,
    });
  });

  test("rejects two different tokens inside one assistant turn explicitly", () => {
    const result = adapt([
      reasoningItem({ encrypted_content: "kr1_first" }),
      { role: "assistant", content: "answer" },
      reasoningItem({ encrypted_content: "kr1_second" }),
      FUNCTION_CALL,
      FUNCTION_CALL_OUTPUT,
      USER_NEXT,
    ]);

    expect(result).toMatchObject({
      ok: false,
      code: "invalid_reasoning_replay",
      param: "input.2.encrypted_content",
    });
  });

  test("fingerprints assistant output that precedes the reasoning item in the same turn", () => {
    const result = adapt([
      { role: "assistant", content: "answer" },
      reasoningItem({ encrypted_content: "kr1_late" }),
      USER_NEXT,
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.reasoningReplays).toEqual([
      {
        lookup: { kind: "responses-token", encryptedContent: "kr1_late" },
        outputFingerprint: assistantOutputFingerprint({ text: "answer", toolCalls: [] }),
        insertBeforeMessage: 0,
        path: "input.1",
      },
    ]);
  });

  test("keeps separate turns separate across a tool output boundary", () => {
    const result = adapt([
      reasoningItem({ encrypted_content: "kr1_turn_one" }),
      { role: "assistant", content: "answer" },
      FUNCTION_CALL,
      FUNCTION_CALL_OUTPUT,
      reasoningItem({ encrypted_content: "kr1_turn_two" }),
      { role: "assistant", content: "done" },
      USER_NEXT,
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.reasoningReplays.map((replay) => replay.insertBeforeMessage)).toEqual([
      0, 3,
    ]);
    expect(result.body.reasoningReplays.map((replay) => replay.outputFingerprint)).toEqual([
      TURN_FINGERPRINT,
      assistantOutputFingerprint({ text: "done", toolCalls: [] }),
    ]);
  });

  test("still rejects plaintext reasoning when no sibling item carries a token", () => {
    expect(
      adapt([
        reasoningItem(),
        { role: "assistant", content: "answer" },
        reasoningItem({ summary: [{ type: "summary_text", text: "later" }] }),
        USER_NEXT,
      ]),
    ).toMatchObject({
      ok: false,
      code: "unsupported_reasoning_plaintext_replay",
      param: "input.0",
    });
  });

  test("single reasoning item regression: fingerprint and insertion index are unchanged", () => {
    const result = adapt([
      reasoningItem({ encrypted_content: "kr1_single" }),
      { role: "assistant", content: "answer" },
      USER_NEXT,
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.reasoningReplays).toEqual([
      {
        lookup: { kind: "responses-token", encryptedContent: "kr1_single" },
        outputFingerprint: assistantOutputFingerprint({ text: "answer", toolCalls: [] }),
        insertBeforeMessage: 0,
        path: "input.0",
      },
    ]);
  });
});

describe("history builder replay collisions", () => {
  const assistant = message("assistant", "answer", "messages.0");
  const signed = {
    kind: "reasoning_text",
    text: "private plan",
    signature: "sig",
  } as const;

  test("collapses identical replays that target the same assistant message", () => {
    const history = buildHistory([assistant], TEST_MODEL, [
      { insertBeforeMessage: 0, content: signed },
      { insertBeforeMessage: 0, content: { ...signed } },
    ]);

    expect(history).toHaveLength(1);
    expect(history[0]?.assistantResponseMessage?.reasoningContent).toEqual({
      reasoningText: { text: "private plan", signature: "sig" },
    });
  });

  test("rejects distinct replays that target the same assistant message instead of dropping one", () => {
    let caught: unknown;
    try {
      buildHistory([assistant], TEST_MODEL, [
        { insertBeforeMessage: 0, content: signed },
        { insertBeforeMessage: 0, content: { ...signed, signature: "other" } },
      ]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RequestTransformError);
    expect((caught as RequestTransformError).code).toBe("invalid_reasoning_replay");

    expect(() =>
      buildHistory([assistant], TEST_MODEL, [
        { insertBeforeMessage: 0, content: signed },
        {
          insertBeforeMessage: 0,
          content: { kind: "redacted_content", bytes: Uint8Array.from([1]) },
        },
      ]),
    ).toThrow(RequestTransformError);
  });
});
