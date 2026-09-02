import type { CanonicalMessage, CanonicalToolDeclaration } from "./canonical.js";

/**
 * A structural defect in a canonical tool-call history.
 *
 * `code` is the public error code that every protocol adapter and the Kiro
 * projection agree on; each caller formats its own protocol-specific message
 * and decides whether to surface `path` as the error `param`.
 */
export type ToolHistoryViolation =
  | {
      readonly kind: "missing_tool_declaration";
      readonly code: "missing_tool_declaration";
      readonly callId: string;
      readonly toolName: string;
      readonly path: string;
    }
  | {
      readonly kind: "duplicate_tool_call";
      readonly code: "invalid_tool_history";
      readonly callId: string;
      readonly toolName: string;
      readonly path: string;
    }
  | {
      readonly kind: "orphan_tool_result";
      readonly code: "invalid_tool_history";
      readonly toolCallId: string;
      readonly path: string;
    };

export interface ToolHistoryOptions {
  /**
   * Also treat `tool_use` content parts as tool calls. The Kiro projection
   * scans both sources because any protocol may hand it either shape; the
   * protocol adapters only scan `message.toolCalls`, the shape they produce.
   */
  readonly includeToolUseParts?: boolean;
}

interface HistoryToolCall {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

function toolCallsOf(
  message: CanonicalMessage,
  includeToolUseParts: boolean,
): readonly HistoryToolCall[] {
  if (!includeToolUseParts) return message.toolCalls;
  return [
    ...message.toolCalls,
    ...message.content.flatMap((part) =>
      part.type === "tool_use" ? [{ id: part.id, name: part.name, path: part.path }] : [],
    ),
  ];
}

/**
 * Find the first tool-history violation in message order: a call must name an
 * exactly declared tool, call ids must be unique, and a result must follow a
 * unique earlier call. Returns `undefined` when the history is consistent.
 */
export function findToolHistoryViolation(
  messages: readonly CanonicalMessage[],
  tools: readonly CanonicalToolDeclaration[],
  options: ToolHistoryOptions = {},
): ToolHistoryViolation | undefined {
  const declarations = new Set(tools.map((tool) => tool.wireName));
  const callIndexById = new Map<string, number>();
  const results = new Set<string>();
  for (const [index, message] of messages.entries()) {
    for (const call of toolCallsOf(message, options.includeToolUseParts === true)) {
      if (!declarations.has(call.name)) {
        return {
          kind: "missing_tool_declaration",
          code: "missing_tool_declaration",
          callId: call.id,
          toolName: call.name,
          path: call.path,
        };
      }
      if (callIndexById.has(call.id)) {
        return {
          kind: "duplicate_tool_call",
          code: "invalid_tool_history",
          callId: call.id,
          toolName: call.name,
          path: call.path,
        };
      }
      callIndexById.set(call.id, index);
    }
    for (const part of message.content) {
      if (part.type !== "tool_result") continue;
      const callIndex = callIndexById.get(part.toolCallId);
      if (callIndex === undefined || callIndex >= index || results.has(part.toolCallId)) {
        return {
          kind: "orphan_tool_result",
          code: "invalid_tool_history",
          toolCallId: part.toolCallId,
          path: part.path,
        };
      }
      results.add(part.toolCallId);
    }
  }
  return undefined;
}
