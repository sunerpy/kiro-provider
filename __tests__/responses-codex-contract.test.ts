import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adaptResponsesRequest } from "../src/server/responses/request-adapter.js";
import { parsedResponses } from "./canonical-test-helpers.js";

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

  test("keeps unsupported result blocks and unavailable custom bindings explicit", () => {
    expect(
      adaptResponsesRequest(parsedResponses(fixture("codex-tool-turn-array.json"))),
    ).toMatchObject({ ok: false, code: "unsupported_tool_result_content" });
    expect(
      adaptResponsesRequest(parsedResponses(fixture("codex-custom-tool-turn.json"))),
    ).toMatchObject({ ok: false, code: "missing_historical_tool_binding" });
  });

  test("rejects namespace history instead of changing public tool identity", () => {
    const result = adaptResponsesRequest(
      parsedResponses(fixture("codex-namespace-tool-turn.json")),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("missing_historical_tool_binding");
  });
});
