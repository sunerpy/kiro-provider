import { describe, expect, test } from "bun:test";
import { assistantOutputFingerprint } from "../src/protocol/canonical.js";
import { adaptResponsesRequest } from "../src/server/responses/request-adapter.js";
import { canonicalRequest, parsedResponses, TEST_MODEL } from "./canonical-test-helpers.js";

const originalTool = {
  type: "namespace",
  name: "functions",
  tools: [{ type: "custom", name: "exec", description: "Execute a code-mode program." }],
} as const;
const replacementTool = {
  type: "function",
  name: "exec_command",
  description: "Execute the current command interface.",
  parameters: { type: "object", properties: { command: { type: "string" } } },
} as const;
const originalCall = {
  type: "custom_tool_call",
  namespace: "functions",
  name: "exec",
  call_id: "historical-call",
  input: 'console.log("Ω\\nresult")',
} as const;
const history = [
  { type: "reasoning", summary: [], encrypted_content: "kr1_original" },
  originalCall,
  { type: "custom_tool_call_output", call_id: originalCall.call_id, output: "old result" },
  { role: "user", content: "Continue with the current command tool." },
] as const;

function adapt(tools: readonly unknown[], input: readonly unknown[] = history) {
  return adaptResponsesRequest(
    parsedResponses({ model: TEST_MODEL, store: false, tools, input }),
    "legacy-user-prefix",
  );
}

function originalAlias(result: ReturnType<typeof adapt>): string {
  if (!result.ok) throw new Error(result.code);
  const binding = result.bridge.bindings.find(
    ({ identity }) =>
      identity.kind === "namespace" &&
      identity.namespace === "functions" &&
      identity.name === "exec",
  );
  if (!binding) throw new Error("Missing historical identity");
  return binding.wireName;
}

describe("stateless historical tool identities", () => {
  test("replays a removed namespace/custom tool without reauthorizing it", () => {
    const result = adapt([replacementTool]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const alias = originalAlias(result);
    expect(result.body.tools.map((tool) => tool.name)).toEqual(["exec_command"]);
    expect(result.body.messages[0]?.toolCalls[0]).toMatchObject({
      id: originalCall.call_id,
      name: alias,
      input: { input: originalCall.input },
    });
    expect(result.body.reasoningReplays[0]?.outputFingerprint).toBe(
      assistantOutputFingerprint({
        text: "",
        toolCalls: [
          { id: originalCall.call_id, name: "functions.exec", input: originalCall.input },
        ],
      }),
    );
    expect(result.bridge.identityFor(alias)).toBeUndefined();
    expect(
      result.bridge.restoreCalls([
        { itemId: "bad", id: "new-call", name: alias, arguments: '{"input":"must not run"}' },
      ]),
    ).toMatchObject({ ok: false, code: "unknown_tool_alias" });
    expect(
      result.bridge.restoreCalls([
        { itemId: "new", id: "new-call", name: "exec_command", arguments: '{"command":"ok"}' },
      ]),
    ).toMatchObject({ ok: true, items: [{ name: "exec_command", type: "function_call" }] });
  });

  test("keeps aliases stable when declarations are reordered or removed", () => {
    const unrelated = {
      type: "namespace",
      name: "other",
      tools: [{ type: "custom", name: "work", description: "Another current tool." }],
    };
    const first = adapt([originalTool, unrelated]);
    const reordered = adapt([unrelated, originalTool]);
    const removed = adapt([unrelated]);
    expect(first.ok && reordered.ok && removed.ok).toBe(true);
    if (!first.ok || !reordered.ok || !removed.ok) return;
    expect(originalAlias(reordered)).toBe(originalAlias(first));
    expect(originalAlias(removed)).toBe(originalAlias(first));
    expect(first.body.tools[0]?.description).toContain("functions.exec");
  });

  test("preserves an explicitly stored legacy binding", () => {
    const result = adaptResponsesRequest(
      parsedResponses({
        model: TEST_MODEL,
        store: false,
        tools: [replacementTool],
        input: history,
      }),
      "legacy-user-prefix",
      {
        messages: [],
        toolBindings: [
          {
            wireName: "kiro_namespace_7",
            identity: {
              kind: "namespace",
              namespace: "functions",
              name: "exec",
              toolType: "custom",
            },
          },
        ],
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(originalAlias(result)).toBe("kiro_namespace_7");
    expect(result.bridge.identityFor("kiro_namespace_7")).toBeUndefined();
  });

  test("rejects collisions with an ordinary current tool instead of reusing its authority", () => {
    const baseline = adapt([originalTool]);
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    const alias = originalAlias(baseline);
    expect(adapt([{ ...replacementTool, name: alias }])).toMatchObject({
      ok: false,
      code: "invalid_tool_declaration",
    });
  });

  test("still rejects mismatched and duplicate historical outputs", () => {
    expect(
      adapt(
        [replacementTool],
        [
          originalCall,
          { type: "function_call_output", call_id: originalCall.call_id, output: "wrong type" },
        ],
      ),
    ).toMatchObject({ ok: false, code: "invalid_tool_history" });
    expect(adapt([replacementTool], [originalCall, originalCall])).toMatchObject({
      ok: false,
      code: "invalid_tool_history",
    });
  });

  test("a new function declaration cannot authorize a historical custom tool of the same name", () => {
    const result = adapt([
      {
        type: "namespace",
        name: "functions",
        tools: [
          {
            type: "function",
            name: "exec",
            description: "The replacement function interface.",
            parameters: { type: "object" },
          },
        ],
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const historicalAlias = result.bridge.lowerCall(originalCall).function.name;
    const currentAlias = result.body.tools[0]?.wireName;
    if (!currentAlias) throw new Error("Expected a current function declaration");
    expect(historicalAlias).not.toBe(currentAlias);
    expect(result.bridge.identityFor(historicalAlias)).toBeUndefined();
    expect(result.bridge.identityFor(currentAlias)).toMatchObject({
      kind: "namespace",
      toolType: "function",
    });
  });

  test("legacy canonical history still requires its saved wire bindings", () => {
    const result = adaptResponsesRequest(
      parsedResponses({ model: TEST_MODEL, tools: [], input: history }),
      "legacy-user-prefix",
      { messages: [], legacyRequest: canonicalRequest([]) },
    );
    expect(result).toMatchObject({
      ok: false,
      code: "missing_historical_tool_binding",
    });
  });
});
