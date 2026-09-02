import { isRecord } from "./adapter-utils.js";

export const CANONICAL_OUTPUT_VERSION = 1 as const;
export const CANONICAL_OUTPUT_JSON_MEDIA_TYPE = "application/x-kiro-provider-output+json";
export const CANONICAL_OUTPUT_STREAM_MEDIA_TYPE = "application/x-kiro-provider-output+ndjson";
export const CANONICAL_OUTPUT_JSON_CONTENT_TYPE = `${CANONICAL_OUTPUT_JSON_MEDIA_TYPE}; charset=utf-8`;
export const CANONICAL_OUTPUT_STREAM_CONTENT_TYPE = `${CANONICAL_OUTPUT_STREAM_MEDIA_TYPE}; charset=utf-8`;

export interface CanonicalOutputUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface CanonicalOutputToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: string;
}

export interface CanonicalOutputReasoning {
  readonly text?: string;
  readonly signature?: string;
  readonly redactedContent?: string;
  readonly encryptedContent?: string;
}

export interface CanonicalCompletion {
  readonly canonicalOutputVersion: typeof CANONICAL_OUTPUT_VERSION;
  readonly conversationId: string;
  readonly model: string;
  readonly createdAt: number;
  readonly text: string;
  readonly reasoning?: CanonicalOutputReasoning;
  readonly toolCalls: readonly CanonicalOutputToolCall[];
  readonly finishReason: "stop" | "tool_calls";
  readonly usage: CanonicalOutputUsage;
}

interface CanonicalOutputEventBase {
  readonly canonicalOutputVersion: typeof CANONICAL_OUTPUT_VERSION;
}

export type CanonicalOutputEvent =
  | (CanonicalOutputEventBase & {
      readonly type: "started";
      readonly conversationId: string;
      readonly model: string;
      readonly createdAt: number;
    })
  | (CanonicalOutputEventBase & {
      readonly type: "reasoning_delta";
      readonly text: string;
    })
  | (CanonicalOutputEventBase & {
      readonly type: "reasoning_signature";
      readonly signature: string;
    })
  | (CanonicalOutputEventBase & {
      readonly type: "reasoning_redacted";
      readonly data: string;
    })
  | (CanonicalOutputEventBase & {
      readonly type: "reasoning_encrypted";
      readonly encryptedContent: string;
    })
  | (CanonicalOutputEventBase & {
      readonly type: "text_delta";
      readonly text: string;
    })
  | (CanonicalOutputEventBase & {
      readonly type: "tool_call_delta";
      readonly index: number;
      readonly id?: string;
      readonly name?: string;
      readonly arguments: string;
    })
  | (CanonicalOutputEventBase & {
      readonly type: "completed";
      readonly finishReason: "stop" | "tool_calls";
      readonly usage: CanonicalOutputUsage;
    });

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseUsage(value: unknown): CanonicalOutputUsage | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["inputTokens", "outputTokens", "totalTokens"])) ||
    !isNonNegativeInteger(value.inputTokens) ||
    !isNonNegativeInteger(value.outputTokens) ||
    !isNonNegativeInteger(value.totalTokens) ||
    value.totalTokens !== value.inputTokens + value.outputTokens
  ) {
    return undefined;
  }
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
  };
}

function parseReasoning(value: unknown): CanonicalOutputReasoning | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["text", "signature", "redactedContent", "encryptedContent"]))
  ) {
    return undefined;
  }
  for (const key of ["text", "signature", "redactedContent", "encryptedContent"] as const) {
    if (value[key] !== undefined && !isNonEmptyString(value[key])) {
      return undefined;
    }
  }
  return {
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(typeof value.signature === "string" ? { signature: value.signature } : {}),
    ...(typeof value.redactedContent === "string"
      ? { redactedContent: value.redactedContent }
      : {}),
    ...(typeof value.encryptedContent === "string"
      ? { encryptedContent: value.encryptedContent }
      : {}),
  };
}

function parseToolCall(value: unknown): CanonicalOutputToolCall | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["id", "name", "input"])) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.name) ||
    typeof value.input !== "string"
  ) {
    return undefined;
  }
  return { id: value.id, name: value.name, input: value.input };
}

export function parseCanonicalCompletion(value: unknown): CanonicalCompletion | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      new Set([
        "canonicalOutputVersion",
        "conversationId",
        "model",
        "createdAt",
        "text",
        "reasoning",
        "toolCalls",
        "finishReason",
        "usage",
      ]),
    ) ||
    value.canonicalOutputVersion !== CANONICAL_OUTPUT_VERSION ||
    !isNonEmptyString(value.conversationId) ||
    !isNonEmptyString(value.model) ||
    !isNonNegativeInteger(value.createdAt) ||
    typeof value.text !== "string" ||
    !Array.isArray(value.toolCalls) ||
    (value.finishReason !== "stop" && value.finishReason !== "tool_calls")
  ) {
    return undefined;
  }
  const reasoning = parseReasoning(value.reasoning);
  if (value.reasoning !== undefined && reasoning === undefined) return undefined;
  const toolCalls: CanonicalOutputToolCall[] = [];
  for (const candidate of value.toolCalls) {
    const toolCall = parseToolCall(candidate);
    if (!toolCall) return undefined;
    toolCalls.push(toolCall);
  }
  const expectedFinishReason = toolCalls.length > 0 ? "tool_calls" : "stop";
  if (value.finishReason !== expectedFinishReason) {
    return undefined;
  }
  const usage = parseUsage(value.usage);
  if (!usage) return undefined;
  return {
    canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
    conversationId: value.conversationId,
    model: value.model,
    createdAt: value.createdAt,
    text: value.text,
    ...(reasoning !== undefined ? { reasoning } : {}),
    toolCalls,
    finishReason: value.finishReason,
    usage,
  };
}

export function parseCanonicalOutputEvent(value: unknown): CanonicalOutputEvent | undefined {
  if (
    !isRecord(value) ||
    value.canonicalOutputVersion !== CANONICAL_OUTPUT_VERSION ||
    typeof value.type !== "string"
  ) {
    return undefined;
  }
  const base = { canonicalOutputVersion: CANONICAL_OUTPUT_VERSION };
  switch (value.type) {
    case "started":
      if (
        !hasOnlyKeys(
          value,
          new Set(["canonicalOutputVersion", "type", "conversationId", "model", "createdAt"]),
        ) ||
        !isNonEmptyString(value.conversationId) ||
        !isNonEmptyString(value.model) ||
        !isNonNegativeInteger(value.createdAt)
      ) {
        return undefined;
      }
      return {
        ...base,
        type: "started",
        conversationId: value.conversationId,
        model: value.model,
        createdAt: value.createdAt,
      };
    case "reasoning_delta":
    case "text_delta":
      if (
        !hasOnlyKeys(value, new Set(["canonicalOutputVersion", "type", "text"])) ||
        !isNonEmptyString(value.text)
      ) {
        return undefined;
      }
      return { ...base, type: value.type, text: value.text };
    case "reasoning_signature":
      if (
        !hasOnlyKeys(value, new Set(["canonicalOutputVersion", "type", "signature"])) ||
        !isNonEmptyString(value.signature)
      ) {
        return undefined;
      }
      return { ...base, type: "reasoning_signature", signature: value.signature };
    case "reasoning_redacted":
      if (
        !hasOnlyKeys(value, new Set(["canonicalOutputVersion", "type", "data"])) ||
        !isNonEmptyString(value.data)
      ) {
        return undefined;
      }
      return { ...base, type: "reasoning_redacted", data: value.data };
    case "reasoning_encrypted":
      if (
        !hasOnlyKeys(value, new Set(["canonicalOutputVersion", "type", "encryptedContent"])) ||
        !isNonEmptyString(value.encryptedContent)
      ) {
        return undefined;
      }
      return {
        ...base,
        type: "reasoning_encrypted",
        encryptedContent: value.encryptedContent,
      };
    case "tool_call_delta": {
      if (
        !hasOnlyKeys(
          value,
          new Set(["canonicalOutputVersion", "type", "index", "id", "name", "arguments"]),
        ) ||
        !Number.isSafeInteger(value.index) ||
        (value.index as number) < 0 ||
        (value.id !== undefined && !isNonEmptyString(value.id)) ||
        (value.name !== undefined && !isNonEmptyString(value.name)) ||
        typeof value.arguments !== "string"
      ) {
        return undefined;
      }
      return {
        ...base,
        type: "tool_call_delta",
        index: value.index as number,
        ...(typeof value.id === "string" ? { id: value.id } : {}),
        ...(typeof value.name === "string" ? { name: value.name } : {}),
        arguments: value.arguments,
      };
    }
    case "completed": {
      if (
        !hasOnlyKeys(value, new Set(["canonicalOutputVersion", "type", "finishReason", "usage"])) ||
        (value.finishReason !== "stop" && value.finishReason !== "tool_calls")
      ) {
        return undefined;
      }
      const usage = parseUsage(value.usage);
      if (!usage) return undefined;
      return {
        ...base,
        type: "completed",
        finishReason: value.finishReason,
        usage,
      };
    }
    default:
      return undefined;
  }
}

export function parseCanonicalOutputEventLine(line: string): CanonicalOutputEvent | undefined {
  try {
    return parseCanonicalOutputEvent(JSON.parse(line));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}
