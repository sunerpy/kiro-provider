import { describe, expect, test } from "bun:test";
import { RequestTransformError } from "../src/kiro/transform/errors.js";
import { buildHistory } from "../src/kiro/transform/history-builder.js";
import { buildCodeWhispererRequest } from "../src/kiro/transform/request-core.js";
import type { CanonicalMessage } from "../src/protocol/canonical.js";
import {
  canonicalRequest,
  functionTool,
  message,
  TEST_AUTH,
  TEST_MODEL,
  textPart,
} from "./canonical-test-helpers.js";

function historyContent(history: ReturnType<typeof buildHistory>): readonly (string | undefined)[] {
  return history.map(
    (entry) => entry.userInputMessage?.content ?? entry.assistantResponseMessage?.content,
  );
}

describe("protocol-fidelity history projection", () => {
  test("keeps consecutive same-role messages as distinct ordered wire entries", () => {
    const history = buildHistory(
      [
        message("user", "first", "messages.0"),
        message("user", "second", "messages.1"),
        message("assistant", "repeat", "messages.2"),
        message("assistant", "repeat", "messages.3"),
      ],
      TEST_MODEL,
    );

    expect(history).toHaveLength(4);
    expect(historyContent(history)).toEqual(["first", "second", "repeat", "repeat"]);
  });

  test("preserves model-visible bytes including trailing braces and tag-like text", () => {
    const exact = "  alpha\r\n<thinking>literal</thinking>\n{";
    const history = buildHistory([message("assistant", exact, "messages.0")], TEST_MODEL);

    expect(history[0]?.assistantResponseMessage?.content).toBe(exact);
  });

  test("keeps tool-result messages separate and never inserts explanation prose", () => {
    const messages: CanonicalMessage[] = [
      {
        role: "assistant",
        content: [],
        toolCalls: [
          {
            id: "call_a",
            name: "read_file",
            input: { path: "a" },
            path: "messages.0.tool_calls.0",
          },
          {
            id: "call_b",
            name: "read_file",
            input: { path: "b" },
            path: "messages.0.tool_calls.1",
          },
        ],
        path: "messages.0",
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "call_a",
            content: [textPart("A", "messages.1.content")],
            isError: false,
            path: "messages.1",
          },
        ],
        toolCalls: [],
        path: "messages.1",
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "call_b",
            content: [textPart("B", "messages.2.content")],
            isError: true,
            path: "messages.2",
          },
        ],
        toolCalls: [],
        path: "messages.2",
      },
    ];

    const history = buildHistory(messages, TEST_MODEL);
    expect(history).toHaveLength(3);
    expect(history[1]?.userInputMessage?.content).toBe("");
    expect(history[1]?.userInputMessage?.userInputMessageContext?.toolResults).toEqual([
      {
        toolUseId: "call_a",
        content: [{ text: "A" }],
        status: "success",
      },
    ]);
    expect(history[2]?.userInputMessage?.userInputMessageContext?.toolResults).toEqual([
      {
        toolUseId: "call_b",
        content: [{ text: "B" }],
        status: "error",
      },
    ]);
  });

  test("replays only signed or redacted native reasoning structures", () => {
    const assistant = message("assistant", "answer", "messages.0");
    const signed = buildHistory([assistant], TEST_MODEL, [
      {
        insertBeforeMessage: 0,
        content: {
          kind: "reasoning_text",
          text: "private plan",
          signature: "sig",
        },
      },
    ]);
    const redacted = buildHistory([assistant], TEST_MODEL, [
      {
        insertBeforeMessage: 0,
        content: {
          kind: "redacted_content",
          bytes: Uint8Array.from([1, 2, 3]),
        },
      },
    ]);

    expect(signed[0]?.assistantResponseMessage?.reasoningContent).toEqual({
      reasoningText: { text: "private plan", signature: "sig" },
    });
    expect(redacted[0]?.assistantResponseMessage?.reasoningContent).toEqual({
      redactedContent: Uint8Array.from([1, 2, 3]),
    });
  });

  test("rejects image overflow instead of inserting omission text", () => {
    const images = Array.from({ length: 5 }, (_, index) => ({
      type: "image" as const,
      mediaType: "image/png",
      data: "AA==",
      path: `messages.0.content.${index}`,
    }));

    expect(() => buildHistory([message("user", images)], TEST_MODEL)).toThrow(/limit of 4 images/);
  });
});

describe("safe and legacy instruction projection", () => {
  test("safe mode rejects instructions without contacting Kiro", () => {
    const request = canonicalRequest([
      message("developer", "DO-NOT-PREFIX", "instructions"),
      message("user", "question", "input"),
    ]);

    try {
      buildCodeWhispererRequest(request, TEST_MODEL, TEST_AUTH);
      throw new Error("Expected unsupported instruction projection");
    } catch (error) {
      expect(error).toBeInstanceOf(RequestTransformError);
      expect((error as RequestTransformError).code).toBe("unsupported_instruction_projection");
    }
  });

  test("legacy mode applies only the documented exact double-newline prefix", () => {
    const request = canonicalRequest(
      [
        message("system", "SYS", "messages.0"),
        message("developer", "DEV", "messages.1"),
        message("user", "  user bytes {", "messages.2"),
        message("user", "second", "messages.3"),
      ],
      { projectionMode: "legacy-user-prefix" },
    );
    const transformed = buildCodeWhispererRequest(request, TEST_MODEL, TEST_AUTH, {
      conversationId: "conv-test",
    });

    expect(
      transformed.request.conversationState.history?.map(
        (entry) => entry.userInputMessage?.content,
      ),
    ).toEqual(["SYS\n\nDEV\n\n  user bytes {"]);
    expect(transformed.request.conversationState.currentMessage.userInputMessage?.content).toBe(
      "second",
    );
    expect(JSON.stringify(transformed.request)).not.toContain("system message");
  });

  test("legacy mode keeps trailing reconciliation instructions after the assistant result", () => {
    const request = canonicalRequest(
      [
        message("system", "SYS", "messages.0"),
        message("user", "question", "messages.1"),
        message("assistant", "final answer", "messages.2"),
        message("developer", "WORK STATE", "messages.3"),
        message("developer", "RECONCILE NOW", "messages.4"),
      ],
      { projectionMode: "legacy-user-prefix" },
    );
    const transformed = buildCodeWhispererRequest(request, TEST_MODEL, TEST_AUTH, {
      conversationId: "conv-test",
      resolvedReasoningReplays: [
        {
          insertBeforeMessage: 2,
          content: {
            kind: "reasoning_text",
            text: "private plan",
            signature: "sig",
          },
        },
      ],
    });

    expect(
      transformed.request.conversationState.history?.map(
        (entry) => entry.userInputMessage?.content ?? entry.assistantResponseMessage?.content,
      ),
    ).toEqual(["SYS\n\nquestion", "final answer"]);
    expect(transformed.request.conversationState.currentMessage.userInputMessage?.content).toBe(
      "WORK STATE\n\nRECONCILE NOW",
    );
    expect(
      transformed.request.conversationState.history?.[1]?.assistantResponseMessage
        ?.reasoningContent,
    ).toEqual({
      reasoningText: { text: "private plan", signature: "sig" },
    });

    const redacted = buildCodeWhispererRequest(request, TEST_MODEL, TEST_AUTH, {
      conversationId: "conv-redacted",
      resolvedReasoningReplays: [
        {
          insertBeforeMessage: 2,
          content: {
            kind: "redacted_content",
            bytes: Uint8Array.from([1, 2, 3]),
          },
        },
      ],
    });
    expect(
      redacted.request.conversationState.history?.[1]?.assistantResponseMessage?.reasoningContent,
    ).toEqual({
      redactedContent: Uint8Array.from([1, 2, 3]),
    });
  });
});

describe("exact tool history declarations", () => {
  test("rejects historical calls when the original declaration is absent", () => {
    const request = canonicalRequest([
      {
        role: "assistant",
        content: [],
        toolCalls: [
          {
            id: "call_1",
            name: "read_file",
            input: { path: "x" },
            path: "messages.0.tool_calls.0",
          },
        ],
        path: "messages.0",
      },
      message("user", "continue", "messages.1"),
    ]);

    expect(() => buildCodeWhispererRequest(request, TEST_MODEL, TEST_AUTH)).toThrow(
      /without an exact declaration/,
    );
  });

  test("preserves declared tool call and result structure without schema inference", () => {
    const request = canonicalRequest(
      [
        message("user", "read it", "messages.0"),
        {
          role: "assistant",
          content: [],
          toolCalls: [
            {
              id: "call_1",
              name: "read_file",
              input: { path: "x" },
              path: "messages.1.tool_calls.0",
            },
          ],
          path: "messages.1",
        },
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              toolCallId: "call_1",
              content: [textPart("contents", "messages.2.content")],
              isError: false,
              path: "messages.2",
            },
          ],
          toolCalls: [],
          path: "messages.2",
        },
      ],
      {
        tools: [
          functionTool("read_file", "tools.0", {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          }),
        ],
      },
    );
    const transformed = buildCodeWhispererRequest(request, TEST_MODEL, TEST_AUTH);

    expect(
      transformed.request.conversationState.history?.[1]?.assistantResponseMessage?.toolUses,
    ).toEqual([
      {
        toolUseId: "call_1",
        name: "read_file",
        input: { path: "x" },
      },
    ]);
    expect(
      transformed.request.conversationState.currentMessage.userInputMessage?.userInputMessageContext
        ?.toolResults,
    ).toEqual([
      {
        toolUseId: "call_1",
        content: [{ text: "contents" }],
        status: "success",
      },
    ]);
  });
});
