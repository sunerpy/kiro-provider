import { describe, expect, test } from "bun:test";
import { RequestTransformError } from "../src/kiro/transform/errors.js";
import { transformToSdkRequest } from "../src/kiro/transform/request-sdk.js";
import type {
  CodeWhispererMessage,
  KiroAuthDetails,
  SdkPreparedRequest,
} from "../src/kiro/types.js";
import type {
  CanonicalMessage,
  CanonicalRequest,
  CanonicalToolDeclaration,
} from "../src/protocol/canonical.js";
import { canonicalRequest, functionTool, message, textPart } from "./canonical-test-helpers.js";

const MODEL = "claude-sonnet-4-5";

const auth: KiroAuthDetails = {
  refresh: "r",
  access: "access-token",
  expires: Date.now() + 3_600_000,
  authMethod: "idc",
  region: "us-east-1",
};

const authWithProfile: KiroAuthDetails = {
  ...auth,
  profileArn: "arn:aws:codewhisperer:eu-west-1:123456789012:profile/ABC",
};

function request(
  messages: readonly CanonicalMessage[],
  overrides: Partial<CanonicalRequest> = {},
): CanonicalRequest {
  return canonicalRequest(messages, { model: MODEL, ...overrides });
}

function currentUserInput(
  prepared: SdkPreparedRequest,
): NonNullable<CodeWhispererMessage["userInputMessage"]> {
  const input = prepared.conversationState.currentMessage.userInputMessage;
  if (!input) throw new Error("Expected current user input");
  return input;
}

function runnerTool(): CanonicalToolDeclaration {
  return {
    ...functionTool("runner", "tools.0", {
      type: "object",
      properties: { x: { type: "number" } },
    }),
    description: "Run one task",
  };
}

describe("transformToSdkRequest canonical boundary", () => {
  test("produces the required wire shape without modifying text", () => {
    const prepared = transformToSdkRequest(request([message("user", " hello\r\n{")]), MODEL, auth);

    expect(currentUserInput(prepared)).toMatchObject({
      content: " hello\r\n{",
      modelId: "claude-sonnet-4.5",
      origin: "AI_EDITOR",
    });
    expect(prepared.conversationState.chatTriggerType).toBe("MANUAL");
    expect(typeof prepared.conversationState.conversationId).toBe("string");
    expect(typeof prepared.conversationState.agentContinuationId).toBe("string");
    expect(prepared.conversationState.agentTaskType).toBe("vibe");
    expect(prepared.streaming).toBe(true);
    expect(prepared.effectiveModel).toBe("claude-sonnet-4.5");
  });

  test("rejects raw bodies, empty canonical requests, and model mismatches", () => {
    expect(() =>
      transformToSdkRequest(
        { messages: [{ role: "user", content: "raw" }] } as unknown as CanonicalRequest,
        MODEL,
        auth,
      ),
    ).toThrow("CanonicalRequest is required");
    expect(() => transformToSdkRequest(request([]), MODEL, auth)).toThrow("No messages");
    expect(() =>
      transformToSdkRequest(request([message("user", "q")]), "gpt-5.6-sol", auth),
    ).toThrow("does not match pipeline model");
  });

  test("reports an unknown static model as a field-level transform error", () => {
    try {
      transformToSdkRequest(
        canonicalRequest([message("user", "q")], {
          model: "not-a-real-model",
        }),
        "not-a-real-model",
        auth,
      );
      throw new TypeError("Expected unsupported model rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(RequestTransformError);
      expect(error).toMatchObject({
        code: "unsupported_model",
        param: "model",
      });
    }
  });

  test("keeps consecutive user messages separate", () => {
    const prepared = transformToSdkRequest(
      request([message("user", "first", "messages.0"), message("user", "second", "messages.1")]),
      MODEL,
      auth,
    );

    expect(prepared.conversationState.history).toHaveLength(1);
    expect(prepared.conversationState.history?.[0]?.userInputMessage?.content).toBe("first");
    expect(currentUserInput(prepared).content).toBe("second");
  });
});

describe("transformToSdkRequest instruction and text fidelity", () => {
  test("safe mode rejects system/developer projection", () => {
    expect(() =>
      transformToSdkRequest(
        request([message("system", "SYS", "messages.0"), message("user", "q", "messages.1")]),
        MODEL,
        auth,
      ),
    ).toThrow(/safe mode cannot project/);
  });

  test("legacy mode performs only exact double-newline prefixing", () => {
    const prepared = transformToSdkRequest(
      request(
        [
          message("system", "TOP", "messages.0"),
          message("developer", "ROLE-B", "messages.1"),
          message("user", "hi{", "messages.2"),
        ],
        { projectionMode: "legacy-user-prefix" },
      ),
      MODEL,
      auth,
      true,
      15_000,
    );

    expect(currentUserInput(prepared).content).toBe("TOP\n\nROLE-B\n\nhi{");
    expect(JSON.stringify(prepared)).not.toContain("<thinking_mode>");
  });

  test("projects plain-text-only blocks by exact concatenation without separators", () => {
    const prepared = transformToSdkRequest(
      request([
        message(
          "user",
          [
            textPart("first\r\n", "messages.0.content.0"),
            textPart("{second", "messages.0.content.1"),
          ],
          "messages.0",
        ),
      ]),
      MODEL,
      auth,
    );

    expect(currentUserInput(prepared).content).toBe("first\r\n{second");
  });

  test("rejects multiple text blocks interleaved with non-text content", () => {
    let caught: unknown;
    try {
      transformToSdkRequest(
        request([
          message(
            "user",
            [
              textPart("first", "messages.0.content.0"),
              {
                type: "image",
                url: "data:image/png;base64,AQID",
                path: "messages.0.content.1",
              },
              textPart("second", "messages.0.content.2"),
            ],
            "messages.0",
          ),
        ]),
        MODEL,
        auth,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RequestTransformError);
    expect((caught as RequestTransformError).code).toBe("unsupported_content_block_projection");
    expect((caught as RequestTransformError).param).toBe("messages.0.content.2");
  });

  test("projects inline files through Kiro native documents without prompt text", () => {
    const prepared = transformToSdkRequest(
      request([
        message(
          "user",
          [
            {
              type: "document",
              name: "notes.txt",
              format: "txt",
              data: "SGVsbG8=",
              path: "messages.0.content.0",
            },
            textPart("Summarize.", "messages.0.content.1"),
          ],
          "messages.0",
        ),
      ]),
      MODEL,
      auth,
    );

    expect(currentUserInput(prepared).content).toBe("Summarize.");
    expect(currentUserInput(prepared).documents).toEqual([
      {
        name: "notes",
        format: "txt",
        source: { bytes: new Uint8Array([72, 101, 108, 108, 111]) },
      },
    ]);
  });

  test("accepts image-only and document-only current input", () => {
    const image = transformToSdkRequest(
      request([
        message(
          "user",
          [
            {
              type: "image",
              url: "data:image/png;base64,AQID",
              path: "messages.0.content.0",
            },
          ],
          "messages.0",
        ),
      ]),
      MODEL,
      auth,
    );
    expect(currentUserInput(image).content).toBe("");
    expect(currentUserInput(image).images).toHaveLength(1);

    const document = transformToSdkRequest(
      request([
        message(
          "user",
          [
            {
              type: "document",
              name: "notes.txt",
              format: "txt",
              data: "SGVsbG8=",
              path: "messages.0.content.0",
            },
          ],
          "messages.0",
        ),
      ]),
      MODEL,
      auth,
    );
    expect(currentUserInput(document).content).toBe("");
    expect(currentUserInput(document).documents).toHaveLength(1);
  });

  test("keeps current attachments current when trailing instructions are projected", () => {
    const prepared = transformToSdkRequest(
      request(
        [
          message(
            "user",
            [
              {
                type: "image",
                url: "data:image/png;base64,AQID",
                path: "messages.0.content.0",
              },
              {
                type: "document",
                name: "notes.txt",
                format: "txt",
                data: "SGVsbG8=",
                path: "messages.0.content.1",
              },
            ],
            "messages.0",
          ),
          message("developer", "RECONCILE", "messages.1"),
        ],
        { projectionMode: "legacy-user-prefix" },
      ),
      MODEL,
      auth,
    );

    expect(prepared.conversationState.history).toBeUndefined();
    expect(currentUserInput(prepared).content).toBe("RECONCILE");
    expect(currentUserInput(prepared).images).toHaveLength(1);
    expect(currentUserInput(prepared).documents).toHaveLength(1);
  });

  test("does not add a separator for an empty text part beside structured current input", () => {
    const prepared = transformToSdkRequest(
      request(
        [
          message(
            "user",
            [
              textPart("", "messages.0.content.0"),
              {
                type: "image",
                url: "data:image/png;base64,AQID",
                path: "messages.0.content.1",
              },
            ],
            "messages.0",
          ),
          message("developer", "RECONCILE", "messages.1"),
        ],
        { projectionMode: "legacy-user-prefix" },
      ),
      MODEL,
      auth,
    );

    expect(currentUserInput(prepared).content).toBe("RECONCILE");
    expect(prepared.diagnostics.projection).toMatchObject({
      prefixInstructionCount: 0,
      trailingInstructionCount: 1,
      suffixAction: "append_user",
    });
    expect(prepared.diagnostics.history).toMatchObject({
      currentRole: "user",
      currentTextChars: "RECONCILE".length,
      currentImageCount: 1,
      historyMessageCount: 0,
    });
  });

  test("legacy mode separates every original instruction block with exact double newlines", () => {
    const prepared = transformToSdkRequest(
      request(
        [
          message(
            "system",
            [textPart("A", "messages.0.content.0"), textPart("B", "messages.0.content.1")],
            "messages.0",
          ),
          message("user", "C", "messages.1"),
        ],
        { projectionMode: "legacy-user-prefix" },
      ),
      MODEL,
      auth,
    );

    expect(currentUserInput(prepared).content).toBe("A\n\nB\n\nC");
  });

  test("does not interpret thinking-like text", () => {
    const literal = "<thinking>client text</thinking>{";
    const prepared = transformToSdkRequest(request([message("user", literal)]), MODEL, auth, true);
    expect(currentUserInput(prepared).content).toBe(literal);
  });
});

describe("transformToSdkRequest exact tools and history", () => {
  test("keeps missing tool descriptions fail-closed at the projection boundary", () => {
    expect(() =>
      transformToSdkRequest(
        request([message("user", "hello")], {
          tools: [
            {
              publicType: "function",
              name: "runner",
              wireName: "runner",
              inputSchema: { type: "object" },
              path: "tools.0",
            },
          ],
        }),
        MODEL,
        auth,
      ),
    ).toThrow(/requires a non-empty description/);
  });

  test("converts supplied declarations without inference", () => {
    const prepared = transformToSdkRequest(
      request([message("user", "use a tool")], { tools: [runnerTool()] }),
      MODEL,
      auth,
    );

    expect(currentUserInput(prepared).userInputMessageContext?.tools).toEqual([
      {
        toolSpecification: {
          name: "runner",
          description: "Run one task",
          inputSchema: {
            json: {
              type: "object",
              properties: { x: { type: "number" } },
            },
          },
        },
      },
    ]);
  });

  test("preserves a declared native tool call/result loop", () => {
    const prepared = transformToSdkRequest(
      request(
        [
          message("user", "run it", "messages.0"),
          message(
            "assistant",
            [
              {
                type: "tool_use",
                id: "tu1",
                name: "runner",
                input: { x: 1 },
                path: "messages.1.content.0",
              },
            ],
            "messages.1",
          ),
          message(
            "tool",
            [
              {
                type: "tool_result",
                toolCallId: "tu1",
                content: [textPart("done", "messages.2.content.0.content")],
                isError: false,
                path: "messages.2.content.0",
              },
            ],
            "messages.2",
          ),
        ],
        { tools: [runnerTool()] },
      ),
      MODEL,
      auth,
    );

    expect(prepared.conversationState.history?.[1]?.assistantResponseMessage?.toolUses).toEqual([
      { input: { x: 1 }, name: "runner", toolUseId: "tu1" },
    ]);
    expect(currentUserInput(prepared).userInputMessageContext?.toolResults).toEqual([
      { content: [{ text: "done" }], status: "success", toolUseId: "tu1" },
    ]);
  });

  test("accepts an empty current tool result as executable input", () => {
    const prepared = transformToSdkRequest(
      request(
        [
          message(
            "assistant",
            [
              {
                type: "tool_use",
                id: "tu1",
                name: "runner",
                input: { x: 1 },
                path: "messages.0.content.0",
              },
            ],
            "messages.0",
          ),
          message(
            "tool",
            [
              {
                type: "tool_result",
                toolCallId: "tu1",
                content: [],
                isError: false,
                path: "messages.1.content.0",
              },
            ],
            "messages.1",
          ),
        ],
        { tools: [runnerTool()] },
      ),
      MODEL,
      auth,
    );

    expect(currentUserInput(prepared).content).toBe("");
    expect(currentUserInput(prepared).userInputMessageContext?.toolResults).toEqual([
      { content: [], status: "success", toolUseId: "tu1" },
    ]);
  });

  test("keeps the current tool result current when trailing instructions are projected", () => {
    const prepared = transformToSdkRequest(
      request(
        [
          message(
            "assistant",
            [
              {
                type: "tool_use",
                id: "tu1",
                name: "runner",
                input: { x: 1 },
                path: "messages.0.content.0",
              },
            ],
            "messages.0",
          ),
          message(
            "tool",
            [
              {
                type: "tool_result",
                toolCallId: "tu1",
                content: [textPart("done", "messages.1.content.0.content")],
                isError: false,
                path: "messages.1.content.0",
              },
            ],
            "messages.1",
          ),
          message("developer", "RECONCILE", "messages.2"),
        ],
        {
          projectionMode: "legacy-user-prefix",
          tools: [runnerTool()],
        },
      ),
      MODEL,
      auth,
    );

    expect(prepared.conversationState.history).toHaveLength(1);
    expect(currentUserInput(prepared).content).toBe("RECONCILE");
    expect(currentUserInput(prepared).userInputMessageContext?.toolResults).toEqual([
      { content: [{ text: "done" }], status: "success", toolUseId: "tu1" },
    ]);
  });

  test("rejects duplicate/orphan results and absent exact declarations", () => {
    const call = message(
      "assistant",
      [
        {
          type: "tool_use",
          id: "tu1",
          name: "runner",
          input: {},
          path: "messages.0.content.0",
        },
      ],
      "messages.0",
    );
    const duplicateResults = message(
      "tool",
      [
        {
          type: "tool_result",
          toolCallId: "tu1",
          content: [textPart("first")],
          isError: false,
          path: "messages.1.content.0",
        },
        {
          type: "tool_result",
          toolCallId: "tu1",
          content: [textPart("duplicate")],
          isError: false,
          path: "messages.1.content.1",
        },
      ],
      "messages.1",
    );
    expect(() =>
      transformToSdkRequest(
        request([call, duplicateResults], { tools: [runnerTool()] }),
        MODEL,
        auth,
      ),
    ).toThrow(/no earlier unique matching call/);

    const result = message(
      "tool",
      [
        {
          type: "tool_result",
          toolCallId: "tu1",
          content: [textPart("done")],
          isError: false,
          path: "messages.1.content.0",
        },
      ],
      "messages.1",
    );
    expect(() => transformToSdkRequest(request([call, result]), MODEL, auth)).toThrow(
      /without an exact declaration/,
    );
  });

  test("rejects an assistant-ending request locally without rewriting its content", () => {
    const assistant = message("assistant", "final{", "messages.1");
    try {
      transformToSdkRequest(
        request(
          [
            message("user", "q", "messages.0"),
            {
              ...assistant,
              toolCalls: [
                {
                  id: "x1",
                  name: "runner",
                  input: { x: 2 },
                  path: "messages.1.tool_calls.0",
                },
              ],
            },
          ],
          { tools: [runnerTool()] },
        ),
        MODEL,
        auth,
      );
      throw new TypeError("Expected missing current input rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(RequestTransformError);
      expect(error).toMatchObject({
        code: "missing_current_input",
        param: "messages.1",
      });
      expect(assistant.content[0]).toEqual(textPart("final{", "messages.1.content"));
    }
  });

  test("reports the original trailing instruction path when its synthetic input is empty", () => {
    try {
      transformToSdkRequest(
        request(
          [
            message("user", "q", "messages.0"),
            message("assistant", "final", "messages.1"),
            message("developer", "", "messages.2"),
          ],
          { projectionMode: "legacy-user-prefix" },
        ),
        MODEL,
        auth,
      );
      throw new TypeError("Expected missing current input rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(RequestTransformError);
      expect(error).toMatchObject({
        code: "missing_current_input",
        param: "messages.2",
      });
    }
  });

  test("rejects tool declarations without any current text or tool results", () => {
    try {
      transformToSdkRequest(
        request([message("user", "", "messages.0")], { tools: [runnerTool()] }),
        MODEL,
        auth,
      );
      throw new TypeError("Expected missing current input rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(RequestTransformError);
      expect(error).toMatchObject({
        code: "missing_current_input",
        param: "messages.0",
      });
    }
  });

  test("preserves whitespace-only current text exactly", () => {
    const prepared = transformToSdkRequest(
      request([message("user", " \n\t", "messages.0")], { tools: [runnerTool()] }),
      MODEL,
      auth,
    );
    expect(currentUserInput(prepared).content).toBe(" \n\t");
  });
});

describe("transformToSdkRequest images", () => {
  test("extracts current-turn data URL images", () => {
    const prepared = transformToSdkRequest(
      request([
        message("user", [
          textPart("inspect", "messages.0.content.0"),
          {
            type: "image",
            url: "data:image/png;base64,AQID",
            path: "messages.0.content.1",
          },
        ]),
      ]),
      MODEL,
      auth,
    );

    expect(currentUserInput(prepared).images?.[0]?.format).toBe("png");
    expect(Array.from(currentUserInput(prepared).images?.[0]?.source.bytes ?? [])).toEqual([
      1, 2, 3,
    ]);
  });
});

describe("transformToSdkRequest profile, region, effort, and output limits", () => {
  test("copies profileArn and derives its region", () => {
    const prepared = transformToSdkRequest(request([message("user", "q")]), MODEL, authWithProfile);
    expect(prepared.profileArn).toBe(authWithProfile.profileArn);
    expect(prepared.region).toBe("eu-west-1");
  });

  test("falls back to auth region", () => {
    const prepared = transformToSdkRequest(request([message("user", "q")]), MODEL, auth);
    expect(prepared.profileArn).toBeUndefined();
    expect(prepared.region).toBe("us-east-1");
  });

  test("resolves effort in variant, request, config, and budget order", () => {
    const body = (reasoningEffort?: CanonicalRequest["reasoningEffort"]): CanonicalRequest =>
      request([message("user", "reason")], {
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        model: "gpt-5.6-sol",
      });
    expect(
      transformToSdkRequest(
        { ...body("low"), model: "gpt-5.6-sol-high" },
        "gpt-5.6-sol-high",
        auth,
        true,
        8_000,
        { effort: "medium" },
      ).effort,
    ).toBe("high");
    expect(
      transformToSdkRequest(body("high"), "gpt-5.6-sol", auth, true, 8_000, {
        effort: "medium",
      }).effort,
    ).toBe("high");
    expect(
      transformToSdkRequest(body(), "gpt-5.6-sol", auth, true, 8_000, {
        effort: "high",
      }).effort,
    ).toBe("high");
    expect(transformToSdkRequest(body(), "gpt-5.6-sol", auth, true, 8_000).effort).toBe("low");
    expect(
      transformToSdkRequest(body(), "gpt-5.6-sol", auth, true, 8_000, {
        autoEffortMapping: false,
      }).effort,
    ).toBe("medium");
    expect(transformToSdkRequest(body(), "gpt-5.6-sol", auth).effort).toBeUndefined();
  });

  test("projects only the probe-confirmed Claude max_tokens field", () => {
    const supported = transformToSdkRequest(
      canonicalRequest([message("user", "q")], {
        model: "claude-opus-5",
        outputTokenLimit: 4_096,
      }),
      "claude-opus-5",
      auth,
    );
    expect(supported.additionalModelRequestFields).toEqual({ max_tokens: 4_096 });

    expect(() =>
      transformToSdkRequest(
        canonicalRequest([message("user", "q")], {
          model: "gpt-5.6-sol",
          outputTokenLimit: 4_096,
        }),
        "gpt-5.6-sol",
        auth,
      ),
    ).toThrow(/no probe-confirmed native output-token control/);
  });
});
