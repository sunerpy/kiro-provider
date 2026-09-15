import { describe, expect, test } from "bun:test";
import { buildCodeWhispererRequest } from "../src/kiro/transform/request-core.js";
import {
  canonicalRequest,
  functionTool,
  message,
  TEST_AUTH,
  TEST_MODEL,
} from "./canonical-test-helpers.js";

function projected(mode: "server-auto" | "explicit-checkpoints" | "off", minimumTokens = 1) {
  const historyUser = { ...message("user", "stable ".repeat(500), "input.0"), cachePoint: true };
  const tool = { ...functionTool("lookup"), cachePoint: true };
  return buildCodeWhispererRequest(
    canonicalRequest(
      [
        historyUser,
        message("assistant", "prior", "input.1"),
        message("user", "current", "input.2"),
      ],
      { tools: [tool] },
    ),
    TEST_MODEL,
    TEST_AUTH,
    {
      promptCaching: {
        mode,
        supported: true,
        maximumCheckpoints: 4,
        minimumTokens,
      },
    },
  ).request.conversationState;
}

describe("Kiro prompt cache projection", () => {
  test("projects stable message/tool checkpoints but never the current message", () => {
    const state = projected("explicit-checkpoints");
    expect(state.history?.[0]?.userInputMessage?.cachePoint).toEqual({ type: "default" });
    expect(state.history?.at(-1)?.assistantResponseMessage?.cachePoint).toEqual({
      type: "default",
    });
    expect(state.currentMessage.userInputMessage?.cachePoint).toBeUndefined();
    const tools = state.currentMessage.userInputMessage?.userInputMessageContext?.tools ?? [];
    expect(tools.filter((tool) => "cachePoint" in tool)).toHaveLength(1);
  });

  test("server-auto and below-minimum requests send no explicit checkpoints", () => {
    for (const state of [projected("server-auto"), projected("explicit-checkpoints", 1_000_000)]) {
      expect(JSON.stringify(state)).not.toContain("cachePoint");
    }
  });

  test("fails closed when the client markers exceed the catalog maximum", () => {
    const messages = [
      ...Array.from({ length: 5 }, (_, index) => ({
        ...message(index % 2 === 0 ? "user" : "assistant", `m${index}`, `input.${index}`),
        cachePoint: true,
      })),
      message("user", "current", "input.5"),
    ];
    expect(() =>
      buildCodeWhispererRequest(canonicalRequest(messages), TEST_MODEL, TEST_AUTH, {
        promptCaching: {
          mode: "explicit-checkpoints",
          supported: true,
          maximumCheckpoints: 4,
        },
      }),
    ).toThrow("allows at most 4");
  });
});
