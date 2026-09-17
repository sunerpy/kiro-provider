import { describe, expect, test } from "bun:test";
import { transformToSdkRequest } from "../src/kiro/transform/request-sdk.js";
import type { CanonicalRequest } from "../src/protocol/canonical.js";
import { canonicalRequest, functionTool, message, textPart } from "./canonical-test-helpers.js";

const model = "claude-opus-5";
const auth = {
  access: "fixture",
  refresh: "fixture",
  expires: 0,
  authMethod: "desktop" as const,
  region: "us-east-1" as const,
};
const protocols: CanonicalRequest["protocol"][] = [
  "anthropic-messages",
  "responses",
  "chat-completions",
];

function project(body: CanonicalRequest, nativeSystemPromptEnabled: boolean) {
  return transformToSdkRequest(body, model, auth, false, 20000, { nativeSystemPromptEnabled });
}

describe("instruction turn boundaries", () => {
  test("legacy replay compatibility cannot discard unsupported instruction content", () => {
    const fable = "claude-fable-5-1";
    const body = canonicalRequest(
      [
        message("system", [
          textPart("LEADING"),
          { type: "image", url: "data:image/png;base64,AQ==", path: "system.image" },
        ]),
        message("user", "TASK"),
        message("assistant", "OLD_ANSWER"),
        message("user", "FOLLOWUP"),
      ],
      { model: fable, protocol: "anthropic-messages", projectionMode: "v3-auto" },
    );
    expect(() =>
      transformToSdkRequest(body, fable, auth, false, 20000, {
        resolvedReasoningReplays: [
          {
            insertBeforeMessage: 2,
            content: { kind: "reasoning_text", text: "fixture", signature: "fixture" },
            instructionProjection: { version: 1, legacyPrefixMessages: 2 },
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "unsupported_instruction_projection" }));
  });

  test("keeps the submitted prefix identical when a steered turn becomes history", () => {
    const firstBody = canonicalRequest(
      [
        message("system", "LEADING"),
        message("user", "TASK"),
        message("assistant", "FIRST"),
        message("user", "RESULT"),
        message("system", "STEER"),
      ],
      { model, protocol: "anthropic-messages", projectionMode: "v3-auto" },
    );
    const first = project(firstBody, false);
    const next = project(
      {
        ...firstBody,
        messages: [
          ...firstBody.messages,
          message("assistant", "SECOND"),
          message("user", "FOLLOWUP"),
        ],
      },
      false,
    );
    const previousPrefix = [
      ...(first.conversationState.history ?? []),
      first.conversationState.currentMessage,
    ];
    expect(next.conversationState.history?.slice(0, previousPrefix.length)).toEqual(previousPrefix);
  });

  test("retains a native leading system prompt when a later turn adds an inline instruction", () => {
    const firstBody = canonicalRequest([message("system", "LEADING"), message("user", "TASK")], {
      model,
      protocol: "anthropic-messages",
      projectionMode: "v3-auto",
    });
    const first = project(firstBody, true);
    const next = project(
      {
        ...firstBody,
        messages: [
          ...firstBody.messages,
          message("assistant", "FIRST"),
          message("user", "FOLLOWUP"),
          message("system", "STEER"),
        ],
      },
      true,
    );
    expect(next.systemPrompt).toBe(first.systemPrompt);
    expect(next.conversationState.history?.[0]).toEqual(first.conversationState.currentMessage);
    expect(next.conversationState.currentMessage.userInputMessage?.content).toBe(
      "FOLLOWUP\n\nSTEER",
    );
  });

  for (const protocol of protocols) {
    test.each([false, true])(
      `${protocol}: keeps multiple intermediate and trailing instructions in place, native=%s`,
      (native) => {
        const body = canonicalRequest(
          [
            message("system", "FIXTURE_LEADING_RULE"),
            message("user", "FIRST_TASK"),
            message("assistant", "FIRST_ANSWER"),
            message("system", "FIXTURE_MIDDLE_RULE"),
            message("user", "SECOND_TASK"),
            message("assistant", "SECOND_ANSWER"),
            message("user", "CURRENT_TASK"),
            message("system", "FIXTURE_LATEST_STEER"),
          ],
          { model, protocol, projectionMode: "v3-auto" },
        );
        const result = project(body, native);
        const history = result.conversationState.history ?? [];
        expect(history[0]?.userInputMessage?.content).toBe(
          native ? "FIRST_TASK" : "FIXTURE_LEADING_RULE\n\nFIRST_TASK",
        );
        expect(
          history.some(
            (item) => item.userInputMessage?.content === "FIXTURE_MIDDLE_RULE\n\nSECOND_TASK",
          ),
        ).toBe(true);
        expect(result.conversationState.currentMessage.userInputMessage?.content).toBe(
          "CURRENT_TASK\n\nFIXTURE_LATEST_STEER",
        );
        expect(
          history
            .filter((item) => item.assistantResponseMessage)
            .map((item) => item.assistantResponseMessage?.content),
        ).toEqual(["FIRST_ANSWER", "SECOND_ANSWER"]);
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain("I will follow these instructions.");
        expect(serialized).not.toContain("Now follow the instruction.");
        expect(serialized.match(/FIXTURE_LATEST_STEER/g)).toHaveLength(1);
        expect(result.systemPrompt).toBe(native ? "FIXTURE_LEADING_RULE" : undefined);
      },
    );
  }

  test("never fabricates a current user turn after an assistant-ending history", () => {
    const body = canonicalRequest(
      [message("system", "FIXTURE_RULE"), message("user", "TASK"), message("assistant", "ANSWER")],
      { model, protocol: "anthropic-messages", projectionMode: "v3-auto" },
    );
    expect(() => project(body, false)).toThrow(
      expect.objectContaining({ code: "missing_current_input" }),
    );
  });

  test("retains the evidenced native field for a representable leading instruction", () => {
    const result = project(
      canonicalRequest([message("system", "FIXTURE_RULE"), message("user", "TASK")], {
        model,
        protocol: "anthropic-messages",
        projectionMode: "v3-auto",
      }),
      true,
    );
    expect(result.systemPrompt).toBe("FIXTURE_RULE");
    expect(result.conversationState.currentMessage.userInputMessage?.content).toBe("TASK");
    expect(result.diagnostics.projection.instructionChannel).toBe("kiro-runtime-system-prompt");
  });

  test("preserves the original image order when adding leading and trailing instructions", () => {
    const body = canonicalRequest(
      [
        message("system", "LEADING"),
        message("user", [
          { type: "image", url: "data:image/png;base64,AQ==", path: "images.0" },
          textPart("DESCRIBE", "text.0"),
          { type: "image", url: "data:image/png;base64,Ag==", path: "images.1" },
        ]),
        message("system", "TRAILING"),
      ],
      { model, protocol: "anthropic-messages", projectionMode: "v3-auto" },
    );
    const before = JSON.stringify(body);
    const result = project(body, false);
    const current = result.conversationState.currentMessage.userInputMessage;
    expect(current?.content).toBe("LEADING\n\nDESCRIBE\n\nTRAILING");
    expect(current?.images?.map((image) => [...image.source.bytes])).toEqual([[1], [2]]);
    expect(JSON.stringify(body)).toBe(before);
  });

  test("keeps replay on its original assistant and retains the current tool result", () => {
    const body = canonicalRequest(
      [
        message("system", "LEADING"),
        message("user", "TASK"),
        message("assistant", "FIRST"),
        message("system", "MIDDLE"),
        message("assistant", [
          {
            type: "tool_use",
            id: "fixture-call",
            name: "runner",
            input: { x: 1 },
            path: "call",
          },
        ]),
        message("tool", [
          {
            type: "tool_result",
            toolCallId: "fixture-call",
            isError: false,
            content: [textPart("RESULT", "result.text")],
            path: "result",
          },
        ]),
        message("system", "LATEST"),
      ],
      {
        model,
        protocol: "anthropic-messages",
        projectionMode: "v3-auto",
        tools: [functionTool("runner")],
      },
    );
    const result = transformToSdkRequest(body, model, auth, false, 20000, {
      nativeSystemPromptEnabled: false,
      resolvedReasoningReplays: [
        {
          insertBeforeMessage: 4,
          content: {
            kind: "reasoning_text",
            text: "fixture reasoning",
            signature: "fixture signature",
          },
        },
      ],
    });
    const assistants =
      result.conversationState.history?.flatMap((item) =>
        item.assistantResponseMessage ? [item.assistantResponseMessage] : [],
      ) ?? [];
    expect(assistants).toHaveLength(2);
    expect(assistants[0]?.reasoningContent).toBeUndefined();
    expect(assistants[1]?.reasoningContent).toEqual({
      reasoningText: { text: "fixture reasoning", signature: "fixture signature" },
    });
    const current = result.conversationState.currentMessage.userInputMessage;
    expect(current?.content).toBe("LATEST");
    expect(current?.userInputMessageContext?.toolResults).toEqual([
      {
        toolUseId: "fixture-call",
        status: "success",
        content: [{ text: "RESULT" }],
      },
    ]);
  });
});
