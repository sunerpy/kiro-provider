export type ChatWireUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
};

export type ChatWireToolCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
};

export type ChatWireCompletion = {
  readonly message: {
    readonly content: string;
    readonly reasoningContent: string | undefined;
    readonly toolCalls: readonly ChatWireToolCall[];
  };
  readonly usage: ChatWireUsage;
};

export type ChatWireToolCallFragment = {
  readonly index: number;
  readonly id: string | undefined;
  readonly name: string | undefined;
  readonly arguments: string;
};

export type ChatWireDelta =
  | { readonly kind: "empty" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string }
  | {
      readonly kind: "tool_calls";
      readonly calls: readonly ChatWireToolCallFragment[];
    };

export type ChatWireChunk = {
  readonly delta: ChatWireDelta;
  readonly finishReason: "stop" | "tool_calls" | null;
  readonly usage: ChatWireUsage | undefined;
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUsage(value: unknown): ChatWireUsage | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.prompt_tokens !== "number" ||
    typeof value.completion_tokens !== "number" ||
    typeof value.total_tokens !== "number"
  ) {
    return undefined;
  }
  return {
    inputTokens: value.prompt_tokens,
    outputTokens: value.completion_tokens,
    totalTokens: value.total_tokens,
  };
}

export function parseChatWireCompletion(value: unknown): ChatWireCompletion | undefined {
  if (!isRecord(value) || !Array.isArray(value.choices)) return undefined;
  const usage = parseUsage(value.usage);
  if (!usage) return undefined;
  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return undefined;
  const message = choice.message;
  if (typeof message.content !== "string") return undefined;
  const reasoningContent = message.reasoning_content;
  if (reasoningContent !== undefined && typeof reasoningContent !== "string") {
    return undefined;
  }
  const toolCalls: ChatWireToolCall[] = [];
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) return undefined;
    for (const toolCall of message.tool_calls) {
      if (
        !isRecord(toolCall) ||
        typeof toolCall.id !== "string" ||
        !isRecord(toolCall.function) ||
        typeof toolCall.function.name !== "string" ||
        typeof toolCall.function.arguments !== "string"
      ) {
        return undefined;
      }
      toolCalls.push({
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      });
    }
  }
  return {
    message: { content: message.content, reasoningContent, toolCalls },
    usage,
  };
}

function parseToolCall(value: unknown): ChatWireToolCallFragment | undefined {
  if (!isRecord(value) || typeof value.index !== "number" || !isRecord(value.function)) {
    return undefined;
  }
  const id = value.id;
  const name = value.function.name;
  const argumentsFragment = value.function.arguments;
  if (
    (id !== undefined && typeof id !== "string") ||
    (name !== undefined && typeof name !== "string") ||
    typeof argumentsFragment !== "string"
  ) {
    return undefined;
  }
  return { index: value.index, id, name, arguments: argumentsFragment };
}

function parseDelta(value: unknown): ChatWireDelta | undefined {
  if (!isRecord(value)) return undefined;
  const knownFields = ["content", "reasoning_content", "tool_calls"].filter(
    (field) => value[field] !== undefined,
  );
  if (knownFields.length === 0) return { kind: "empty" };
  if (knownFields.length !== 1) return undefined;
  if (typeof value.content === "string") return { kind: "text", text: value.content };
  if (typeof value.reasoning_content === "string") {
    return { kind: "reasoning", text: value.reasoning_content };
  }
  if (!Array.isArray(value.tool_calls)) return undefined;
  const calls: ChatWireToolCallFragment[] = [];
  for (const candidate of value.tool_calls) {
    const call = parseToolCall(candidate);
    if (!call) return undefined;
    calls.push(call);
  }
  return { kind: "tool_calls", calls };
}

export function parseChatWireChunk(line: string): ChatWireChunk | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (
    !isRecord(parsed) ||
    parsed.object !== "chat.completion.chunk" ||
    !Array.isArray(parsed.choices)
  ) {
    return undefined;
  }
  const choice = parsed.choices[0];
  if (!isRecord(choice)) return undefined;
  const delta = parseDelta(choice.delta);
  const finishReason = choice.finish_reason;
  if (
    !delta ||
    (finishReason !== null && finishReason !== "stop" && finishReason !== "tool_calls")
  ) {
    return undefined;
  }
  const usage = parsed.usage === undefined ? undefined : parseUsage(parsed.usage);
  if (parsed.usage !== undefined && !usage) return undefined;
  return { delta, finishReason, usage };
}
