import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCodeWhispererRequest } from "../src/kiro/transform/request-core.js";
import { adaptResponsesRequest } from "../src/server/responses/request-adapter.js";
import { parsedResponses, TEST_AUTH, TEST_MODEL } from "./canonical-test-helpers.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8"));
}

describe("redacted Codex Responses fixtures", () => {
  test("accepts the current Codex first-turn shape including namespace and custom grammar", () => {
    const raw = fixture("codex-first-turn.json") as {
      input: Array<{
        type?: string;
      }>;
    };
    raw.input.push({
      type: "message",
      role: "user",
      content: "HELLO_REDACTED",
    } as never);

    const result = adaptResponsesRequest(parsedResponses(raw), "legacy-user-prefix");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.tools.some((tool) => tool.publicType === "custom")).toBe(true);
    expect(result.body.tools.some((tool) => tool.wireName.startsWith("kiro_ns_"))).toBe(true);
    expect(JSON.stringify(result.body.tools)).not.toContain('"encrypted"');
    expect(result.body.messages.at(-1)?.role).toBe("user");
  });

  test("accepts current Codex compatibility metadata without making it model-visible", () => {
    const result = adaptResponsesRequest(
      parsedResponses(fixture("codex-first-turn.json")),
      "legacy-user-prefix",
    );
    expect(result).toMatchObject({ ok: true });
  });

  test("projects a custom grammar into the private wrapper description", () => {
    const result = adaptResponsesRequest(
      parsedResponses({
        model: "gpt-5.6-sol",
        input: "q",
        tools: [
          {
            type: "custom",
            name: "exec",
            format: {
              type: "grammar",
              syntax: "lark",
              definition: "CUSTOM_TOOL_GRAMMAR_REDACTED",
            },
          },
        ],
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      body: {
        tools: [{ description: expect.stringContaining("CUSTOM_TOOL_GRAMMAR_REDACTED") }],
      },
    });
  });

  test("accepts ordinary history without granting the historical tool", () => {
    const result = adaptResponsesRequest(parsedResponses(fixture("codex-tool-turn.json")));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.tools).toHaveLength(0);
      expect(result.bridge.identityFor("wait")).toBeUndefined();
    }
  });

  test("preserves the current Codex view_image tool result through Kiro projection", () => {
    const result = adaptResponsesRequest(
      parsedResponses(fixture("codex-tool-turn-array.json")),
      "legacy-user-prefix",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.messages[1]?.content).toEqual([
      {
        type: "tool_result",
        toolCallId: "CALL_ID_REDACTED",
        content: [
          expect.objectContaining({ type: "text", text: "ARRAY_TOOL_OUTPUT_FIRST" }),
          expect.objectContaining({ type: "text", text: "ARRAY_TOOL_OUTPUT_SECOND" }),
        ],
        isError: false,
        path: "input.1",
      },
      {
        type: "image",
        url: "data:image/png;base64,AQID",
        path: "input.1.output.1",
        sourceMetadata: { detail: "high" },
      },
    ]);

    const projected = buildCodeWhispererRequest(result.body, TEST_MODEL, TEST_AUTH);
    const current = projected.request.conversationState.currentMessage.userInputMessage;
    expect(current?.content).toBe("");
    expect(current?.userInputMessageContext?.toolResults).toEqual([
      {
        toolUseId: "CALL_ID_REDACTED",
        content: [{ text: "ARRAY_TOOL_OUTPUT_FIRST" }, { text: "ARRAY_TOOL_OUTPUT_SECOND" }],
        status: "success",
      },
    ]);
    expect(current?.images?.[0]).toMatchObject({ format: "png" });
    expect(Array.from(current?.images?.[0]?.source.bytes ?? [])).toEqual([1, 2, 3]);
  });

  test("replays removed custom tools without granting them", () => {
    const result = adaptResponsesRequest(parsedResponses(fixture("codex-custom-tool-turn.json")));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.tools).toHaveLength(0);
    for (const binding of result.bridge.bindings) {
      expect(result.bridge.identityFor(binding.wireName)).toBeUndefined();
    }
  });

  test("reprojects namespace history without granting old tools", () => {
    const result = adaptResponsesRequest(
      parsedResponses(fixture("codex-namespace-tool-turn.json")),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.tools).toHaveLength(0);
    expect(result.bridge.bindings.some((binding) => binding.identity.kind === "namespace")).toBe(
      true,
    );
    for (const binding of result.bridge.bindings) {
      expect(result.bridge.identityFor(binding.wireName)).toBeUndefined();
    }
  });
});
