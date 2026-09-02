import { describe, expect, test } from "bun:test";
import type {
  CanonicalContentPart,
  CanonicalMessage,
  CanonicalToolCall,
  CanonicalToolDeclaration,
} from "../src/protocol/canonical.js";
import { findToolHistoryViolation } from "../src/protocol/tool-history.js";

function declaration(name: string): CanonicalToolDeclaration {
  return {
    publicType: "function",
    name,
    wireName: name,
    inputSchema: { type: "object" },
    path: `tools.${name}`,
  };
}

function call(id: string, name: string, path: string): CanonicalToolCall {
  return { id, name, input: {}, path };
}

function result(toolCallId: string, path: string): CanonicalContentPart {
  return { type: "tool_result", toolCallId, content: [], isError: false, path };
}

function toolUsePart(id: string, name: string, path: string): CanonicalContentPart {
  return { type: "tool_use", id, name, input: {}, path };
}

function assistant(
  toolCalls: readonly CanonicalToolCall[],
  path: string,
  content: readonly CanonicalContentPart[] = [],
): CanonicalMessage {
  return { role: "assistant", content, toolCalls, path };
}

function toolMessage(content: readonly CanonicalContentPart[], path: string): CanonicalMessage {
  return { role: "tool", content, toolCalls: [], path };
}

describe("findToolHistoryViolation", () => {
  test("accepts a declared call followed by exactly one later result", () => {
    const violation = findToolHistoryViolation(
      [
        assistant([call("c1", "read", "messages.0.tool_calls.0")], "messages.0"),
        toolMessage([result("c1", "messages.1")], "messages.1"),
      ],
      [declaration("read")],
    );

    expect(violation).toBeUndefined();
  });

  test("reports the first undeclared call with its id, name, and path", () => {
    const violation = findToolHistoryViolation(
      [assistant([call("c1", "shell", "messages.0.tool_calls.0")], "messages.0")],
      [declaration("read")],
    );

    expect(violation).toEqual({
      kind: "missing_tool_declaration",
      code: "missing_tool_declaration",
      callId: "c1",
      toolName: "shell",
      path: "messages.0.tool_calls.0",
    });
  });

  test("reports a duplicate call id at the second occurrence", () => {
    const violation = findToolHistoryViolation(
      [
        assistant([call("c1", "read", "messages.0.tool_calls.0")], "messages.0"),
        assistant([call("c1", "read", "messages.1.tool_calls.0")], "messages.1"),
      ],
      [declaration("read")],
    );

    expect(violation).toEqual({
      kind: "duplicate_tool_call",
      code: "invalid_tool_history",
      callId: "c1",
      toolName: "read",
      path: "messages.1.tool_calls.0",
    });
  });

  test("reports results without an earlier unique call", () => {
    const tools = [declaration("read")];
    const orphan = findToolHistoryViolation(
      [toolMessage([result("missing", "messages.0")], "messages.0")],
      tools,
    );
    expect(orphan).toEqual({
      kind: "orphan_tool_result",
      code: "invalid_tool_history",
      toolCallId: "missing",
      path: "messages.0",
    });

    const sameMessage = findToolHistoryViolation(
      [
        assistant([call("c1", "read", "messages.0.tool_calls.0")], "messages.0", [
          result("c1", "messages.0.content.0"),
        ]),
      ],
      tools,
    );
    expect(sameMessage).toMatchObject({ kind: "orphan_tool_result", path: "messages.0.content.0" });

    const repeated = findToolHistoryViolation(
      [
        assistant([call("c1", "read", "messages.0.tool_calls.0")], "messages.0"),
        toolMessage([result("c1", "messages.1")], "messages.1"),
        toolMessage([result("c1", "messages.2")], "messages.2"),
      ],
      tools,
    );
    expect(repeated).toMatchObject({ kind: "orphan_tool_result", path: "messages.2" });
  });

  test("scans tool_use content parts only when the projection asks for it", () => {
    const messages = [
      assistant([], "messages.0", [toolUsePart("c1", "shell", "messages.0.content.0")]),
    ];
    const tools = [declaration("read")];

    expect(findToolHistoryViolation(messages, tools)).toBeUndefined();
    expect(findToolHistoryViolation(messages, tools, { includeToolUseParts: true })).toEqual({
      kind: "missing_tool_declaration",
      code: "missing_tool_declaration",
      callId: "c1",
      toolName: "shell",
      path: "messages.0.content.0",
    });
  });

  test("lets a tool_use part satisfy a later result when parts are scanned", () => {
    const violation = findToolHistoryViolation(
      [
        assistant([], "messages.0", [toolUsePart("c1", "read", "messages.0.content.0")]),
        toolMessage([result("c1", "messages.1")], "messages.1"),
      ],
      [declaration("read")],
      { includeToolUseParts: true },
    );

    expect(violation).toBeUndefined();
  });
});
