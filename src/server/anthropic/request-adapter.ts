import { z } from "zod";
import { resolveOutputTokenLimit } from "../../kiro/output-token-limit.js";
import {
  assistantOutputFingerprint,
  type CanonicalContentPart,
  type CanonicalMessage,
  type CanonicalRequest,
  type CanonicalTextPart,
  type CanonicalToolCall,
  type CanonicalToolDeclaration,
  type KiroReasoningContent,
  type ProtocolProjectionMode,
  textFromParts,
} from "../../protocol/canonical.js";

const ContentBlockSchema = z.object({ type: z.string().min(1) }).passthrough();

const MessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.union([z.string(), z.array(ContentBlockSchema)]),
  })
  .passthrough();

const ToolSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    input_schema: z.record(z.unknown()).optional(),
  })
  .passthrough();

const ToolChoiceSchema = z
  .object({
    type: z.enum(["auto", "any", "tool", "none"]),
    name: z.string().min(1).optional(),
    disable_parallel_tool_use: z.boolean().optional(),
  })
  .passthrough()
  .refine((choice) => choice.type !== "tool" || choice.name !== undefined, {
    message: "tool_choice.name is required when tool_choice.type is tool",
  });

const ThinkingSchema = z
  .object({
    type: z.enum(["enabled", "adaptive", "disabled"]),
    budget_tokens: z.number().int().positive().optional(),
  })
  .passthrough();

const AnthropicMessagesRequestSchema = z
  .object({
    model: z.string().min(1),
    max_tokens: z.number().int().positive().optional(),
    messages: z.array(MessageSchema).min(1),
    system: z.union([z.string(), z.array(ContentBlockSchema)]).optional(),
    stream: z.boolean().default(false),
    tools: z.array(ToolSchema).optional(),
    tool_choice: ToolChoiceSchema.optional(),
    thinking: ThinkingSchema.optional(),
    output_config: z
      .object({
        effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      })
      .passthrough()
      .optional(),
    metadata: z
      .object({ user_id: z.string().min(1).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type AnthropicMessagesRequest = z.infer<typeof AnthropicMessagesRequestSchema>;

export type AdaptedAnthropicRequest = {
  readonly source: AnthropicMessagesRequest;
  readonly body: CanonicalRequest;
};

export type AdaptAnthropicRequestResult =
  | { readonly ok: true; readonly value: AdaptedAnthropicRequest }
  | {
      readonly ok: false;
      readonly message: string;
      readonly code?: string;
      readonly param?: string;
    };

type AnthropicFailure = Extract<AdaptAnthropicRequestResult, { ok: false }>;

const REQUEST_KEYS = new Set([
  "model",
  "max_tokens",
  "messages",
  "system",
  "stream",
  "tools",
  "tool_choice",
  "thinking",
  "output_config",
  "metadata",
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(message: string, code?: string, param?: string): AnthropicFailure {
  return {
    ok: false,
    message,
    ...(code !== undefined ? { code } : {}),
    ...(param !== undefined ? { param } : {}),
  };
}

function validateAllowedKeys(
  value: Readonly<Record<string, unknown>>,
  path: string,
  allowed: ReadonlySet<string>,
  code = "unsupported_parameter",
): AnthropicFailure | undefined {
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    return failure(
      `Invalid request: ${path}.${key} is not supported`,
      code,
      `${path}.${key}`,
    );
  }
  return undefined;
}

function isFailure(value: unknown): value is AnthropicFailure {
  return isRecord(value) && value.ok === false && typeof value.message === "string";
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "request";
      return `${path}: ${issue.message}`;
    })
    .join(", ");
}

function textPart(text: string, path: string): CanonicalTextPart {
  return { type: "text", text, path };
}

function systemParts(
  system: AnthropicMessagesRequest["system"],
): AnthropicFailure | readonly CanonicalTextPart[] {
  if (system === undefined) return [];
  if (typeof system === "string") return [textPart(system, "system")];
  const parts: CanonicalTextPart[] = [];
  for (const [index, block] of system.entries()) {
    const path = `system.${index}`;
    const keys = validateAllowedKeys(block, path, new Set(["type", "text"]));
    if (keys) return keys;
    if (block.type !== "text" || typeof block.text !== "string") {
      return failure(
        `Invalid request: system.${index} must be a text block`,
        "unsupported_instruction_projection",
        path,
      );
    }
    parts.push(textPart(block.text, `system.${index}.text`));
  }
  return parts;
}

function toolResultContent(
  value: unknown,
  path: string,
): AnthropicFailure | readonly CanonicalTextPart[] {
  // Anthropic's tool_result.content is optional; an omitted result is empty.
  if (value === undefined) return [];
  if (typeof value === "string") return [textPart(value, path)];
  if (!Array.isArray(value)) {
    return failure(
      `Invalid request: ${path} must be a string or text block array`,
      "unsupported_tool_result_content",
      path,
    );
  }
  const parts: CanonicalTextPart[] = [];
  for (const [index, block] of value.entries()) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      return failure(
        `Invalid request: ${path}.${index} must be a text block`,
        "unsupported_tool_result_content",
        `${path}.${index}`,
      );
    }
    const keys = validateAllowedKeys(block, `${path}.${index}`, new Set(["type", "text"]));
    if (keys) return keys;
    parts.push(textPart(block.text, `${path}.${index}.text`));
  }
  return parts;
}

function reasoningContent(
  block: Readonly<Record<string, unknown>>,
  path: string,
): AnthropicFailure | KiroReasoningContent {
  if (block.type === "thinking") {
    const keys = validateAllowedKeys(
      block,
      path,
      new Set(["type", "thinking", "signature"]),
      "invalid_reasoning_replay",
    );
    if (keys) return keys;
    if (typeof block.thinking !== "string" || typeof block.signature !== "string") {
      return failure(
        `Invalid request: ${path} requires thinking text and signature`,
        "invalid_reasoning_replay",
        path,
      );
    }
    // An empty signature only exists transiently at the start of a stream; a
    // replayed block must carry the signature Kiro emitted, or Kiro cannot
    // verify it. Reject explicitly instead of forwarding an unsigned block.
    if (block.signature.length === 0) {
      return failure(
        `Invalid request: ${path}.signature must be the non-empty signature returned with the thinking block`,
        "invalid_reasoning_replay",
        `${path}.signature`,
      );
    }
    return { kind: "reasoning_text", text: block.thinking, signature: block.signature };
  }
  if (block.type === "redacted_thinking") {
    const keys = validateAllowedKeys(
      block,
      path,
      new Set(["type", "data"]),
      "invalid_reasoning_replay",
    );
    if (keys) return keys;
    const data = block.data;
    if (typeof data !== "string") {
      return failure(
        `Invalid request: ${path} requires base64 redacted data`,
        "invalid_reasoning_replay",
        path,
      );
    }
    try {
      const bytes = Buffer.from(data, "base64");
      const normalized = data.replace(/=+$/u, "");
      if (bytes.toString("base64").replace(/=+$/u, "") !== normalized) {
        throw new TypeError("invalid base64");
      }
      return {
        kind: "redacted_content",
        bytes: Uint8Array.from(bytes),
      };
    } catch {
      return failure(
        `Invalid request: ${path} contains invalid base64 redacted data`,
        "invalid_reasoning_replay",
        path,
      );
    }
  }
  return failure(`Invalid request: ${path} is not a reasoning block`, undefined, path);
}

function mapMessage(
  message: AnthropicMessagesRequest["messages"][number],
  index: number,
):
  | AnthropicFailure
  | {
      readonly message: CanonicalMessage;
      readonly replay?: KiroReasoningContent;
    } {
  const path = `messages.${index}`;
  for (const key of Object.keys(message)) {
    if (key !== "role" && key !== "content") {
      return failure(
        `Invalid request: ${path}.${key} is not supported`,
        "unsupported_message_field",
        `${path}.${key}`,
      );
    }
  }
  if (typeof message.content === "string") {
    return {
      message: {
        role: message.role,
        content: [textPart(message.content, `${path}.content`)],
        toolCalls: [],
        path,
      },
    };
  }

  const content: CanonicalContentPart[] = [];
  const toolCalls: CanonicalToolCall[] = [];
  let replay: KiroReasoningContent | undefined;
  for (const [blockIndex, block] of message.content.entries()) {
    const blockPath = `${path}.content.${blockIndex}`;
    switch (block.type) {
      case "text": {
        const keys = validateAllowedKeys(block, blockPath, new Set(["type", "text"]));
        if (keys) return keys;
        if (typeof block.text !== "string") {
          return failure(
            `Invalid request: ${blockPath}.text must be a string`,
            undefined,
            `${blockPath}.text`,
          );
        }
        content.push(textPart(block.text, `${blockPath}.text`));
        break;
      }
      case "image": {
        const keys = validateAllowedKeys(block, blockPath, new Set(["type", "source"]));
        if (keys) return keys;
        if (
          !isRecord(block.source) ||
          block.source.type !== "base64" ||
          typeof block.source.data !== "string"
        ) {
          return failure(
            `Invalid request: ${blockPath} requires a base64 image source`,
            "unsupported_image_source",
            blockPath,
          );
        }
        const sourceKeys = validateAllowedKeys(
          block.source,
          `${blockPath}.source`,
          new Set(["type", "data", "media_type"]),
        );
        if (sourceKeys) return sourceKeys;
        content.push({
          type: "image",
          data: block.source.data,
          ...(typeof block.source.media_type === "string"
            ? { mediaType: block.source.media_type }
            : {}),
          path: blockPath,
        });
        break;
      }
      case "tool_use": {
        const keys = validateAllowedKeys(
          block,
          blockPath,
          new Set(["type", "id", "name", "input"]),
        );
        if (keys) return keys;
        if (typeof block.id !== "string" || typeof block.name !== "string") {
          return failure(
            `Invalid request: ${blockPath} requires id and name`,
            "invalid_tool_history",
            blockPath,
          );
        }
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input ?? {},
          path: blockPath,
        });
        break;
      }
      case "tool_result": {
        const keys = validateAllowedKeys(
          block,
          blockPath,
          new Set(["type", "tool_use_id", "content", "is_error"]),
        );
        if (keys) return keys;
        if (typeof block.tool_use_id !== "string") {
          return failure(
            `Invalid request: ${blockPath} requires tool_use_id`,
            "invalid_tool_history",
            blockPath,
          );
        }
        const resultContent = toolResultContent(block.content, `${blockPath}.content`);
        if (isFailure(resultContent)) return resultContent;
        content.push({
          type: "tool_result",
          toolCallId: block.tool_use_id,
          content: resultContent,
          isError: block.is_error === true,
          path: blockPath,
        });
        break;
      }
      case "thinking":
      case "redacted_thinking": {
        if (message.role !== "assistant" || replay !== undefined) {
          return failure(
            `Invalid request: ${blockPath} is not a valid single assistant reasoning block`,
            "invalid_reasoning_replay",
            blockPath,
          );
        }
        const mapped = reasoningContent(block, blockPath);
        if ("ok" in mapped) return mapped;
        replay = mapped;
        break;
      }
      default:
        return failure(
          `Invalid request: unsupported content block ${block.type} at ${blockPath}`,
          "unsupported_content_part",
          blockPath,
        );
    }
  }
  return {
    message: { role: message.role, content, toolCalls, path },
    ...(replay !== undefined ? { replay } : {}),
  };
}

function mapTools(
  tools: AnthropicMessagesRequest["tools"],
): AnthropicFailure | readonly CanonicalToolDeclaration[] {
  const declarations: CanonicalToolDeclaration[] = [];
  const names = new Set<string>();
  for (const [index, tool] of (tools ?? []).entries()) {
    for (const key of Object.keys(tool)) {
      if (key !== "name" && key !== "description" && key !== "input_schema") {
        return failure(
          `Invalid request: tools.${index}.${key} is not supported`,
          "unsupported_tool_field",
          `tools.${index}.${key}`,
        );
      }
    }
    if (names.has(tool.name)) {
      return failure(
        `Invalid request: duplicate tool name ${tool.name}`,
        "invalid_tool_declaration",
        `tools.${index}.name`,
      );
    }
    names.add(tool.name);
    declarations.push({
      publicType: "function",
      name: tool.name,
      wireName: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      inputSchema: tool.input_schema ?? {},
      path: `tools.${index}`,
    });
  }
  return declarations;
}

function validateToolHistory(
  messages: readonly CanonicalMessage[],
  tools: readonly CanonicalToolDeclaration[],
): AnthropicFailure | undefined {
  const declarations = new Set(tools.map((tool) => tool.wireName));
  const calls = new Map<string, number>();
  const outputs = new Set<string>();
  for (const [index, message] of messages.entries()) {
    for (const call of message.toolCalls) {
      if (!declarations.has(call.name)) {
        return failure(
          `Invalid request: tool call ${call.id} has no exact declaration for ${call.name}`,
          "missing_tool_declaration",
          call.path,
        );
      }
      if (calls.has(call.id)) {
        return failure(
          `Invalid request: duplicate tool call id ${call.id}`,
          "invalid_tool_history",
          call.path,
        );
      }
      calls.set(call.id, index);
    }
    for (const part of message.content) {
      if (part.type !== "tool_result") continue;
      const callIndex = calls.get(part.toolCallId);
      if (callIndex === undefined || callIndex >= index || outputs.has(part.toolCallId)) {
        return failure(
          `Invalid request: tool result ${part.toolCallId} has no earlier unique call`,
          "invalid_tool_history",
          part.path,
        );
      }
      outputs.add(part.toolCallId);
    }
  }
  return undefined;
}

export function adaptAnthropicMessagesRequest(
  raw: unknown,
  options: { readonly requireMaxTokens?: boolean } = {},
  projectionMode: ProtocolProjectionMode = "safe",
): AdaptAnthropicRequestResult {
  const parsed = AnthropicMessagesRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const firstPath = parsed.error.issues[0]?.path;
    return failure(
      `Invalid request: ${formatIssues(parsed.error)}`,
      undefined,
      firstPath && firstPath.length > 0 ? firstPath.join(".") : undefined,
    );
  }
  const request = parsed.data;
  for (const key of Object.keys(request)) {
    if (!REQUEST_KEYS.has(key)) {
      return failure(
        `Invalid request: parameter ${key} is not supported`,
        "unsupported_parameter",
        key,
      );
    }
  }
  if (options.requireMaxTokens === true && request.max_tokens === undefined) {
    return failure("Invalid request: max_tokens is required", undefined, "max_tokens");
  }
  if (request.max_tokens !== undefined) {
    const outputLimit = resolveOutputTokenLimit(
      request.model,
      request.max_tokens,
    );
    if (!outputLimit.ok) {
      return failure(
        `Invalid request: max_tokens: ${outputLimit.message}`,
        outputLimit.code,
        "max_tokens",
      );
    }
  }
  if (request.tool_choice?.type === "any" || request.tool_choice?.type === "tool") {
    return failure(
      `Invalid request: tool_choice.type ${request.tool_choice.type} is not supported because Kiro has no forced-tool control`,
      "unsupported_tool_choice",
      "tool_choice.type",
    );
  }
  if (request.tool_choice) {
    const keys = validateAllowedKeys(
      request.tool_choice,
      "tool_choice",
      new Set(["type", "name", "disable_parallel_tool_use"]),
    );
    if (keys) return keys;
    if (request.tool_choice.name !== undefined) {
      return failure(
        "Invalid request: tool_choice.name is only meaningful for unsupported forced-tool selection",
        "unsupported_tool_choice",
        "tool_choice.name",
      );
    }
  }
  if (request.tool_choice?.disable_parallel_tool_use === true) {
    return failure(
      "Invalid request: disable_parallel_tool_use cannot be guaranteed by Kiro",
      "unsupported_parallel_tool_calls",
      "tool_choice.disable_parallel_tool_use",
    );
  }
  if (request.output_config) {
    for (const key of Object.keys(request.output_config)) {
      if (key !== "effort") {
        return failure(
          `Invalid request: output_config.${key} is not supported`,
          "unsupported_parameter",
          `output_config.${key}`,
        );
      }
    }
  }
  if (request.thinking) {
    for (const key of Object.keys(request.thinking)) {
      if (key !== "type" && key !== "budget_tokens") {
        return failure(
          `Invalid request: thinking.${key} is not supported`,
          "unsupported_parameter",
          `thinking.${key}`,
        );
      }
    }
  }
  if (request.metadata) {
    const keys = validateAllowedKeys(request.metadata, "metadata", new Set(["user_id"]));
    if (keys) return keys;
  }
  const system = systemParts(request.system);
  if (isFailure(system)) return system;
  if (system.length > 0 && projectionMode === "safe") {
    return failure(
      "Invalid request: system cannot be projected losslessly to Kiro in safe mode; enable legacy-user-prefix explicitly to migrate",
      "unsupported_instruction_projection",
      "system",
    );
  }
  const tools = mapTools(request.tools);
  if (isFailure(tools)) return tools;

  const messages: CanonicalMessage[] = [];
  const reasoningReplays: CanonicalRequest["reasoningReplays"][number][] = [];
  if (system.length > 0) {
    messages.push({ role: "system", content: system, toolCalls: [], path: "system" });
  }
  for (const [index, source] of request.messages.entries()) {
    const mapped = mapMessage(source, index);
    if ("ok" in mapped) return mapped;
    if (mapped.replay !== undefined) {
      reasoningReplays.push({
        lookup: { kind: "anthropic-direct", content: mapped.replay },
        outputFingerprint: assistantOutputFingerprint({
          text: textFromParts(mapped.message.content),
          toolCalls: mapped.message.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            input: JSON.stringify(call.input),
          })),
        }),
        insertBeforeMessage: messages.length,
        path: mapped.message.path,
      });
    }
    messages.push(mapped.message);
  }
  const historyFailure = validateToolHistory(messages, tools);
  if (historyFailure) return historyFailure;

  const unresolved = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls) unresolved.add(call.id);
    for (const part of message.content) {
      if (part.type === "tool_result") unresolved.delete(part.toolCallId);
    }
  }
  if (request.tool_choice?.type === "none" && unresolved.size > 0) {
    return failure(
      "Invalid request: tool_choice none cannot be used while tool calls await results",
      "unsupported_tool_choice",
      "tool_choice",
    );
  }

  const thinkingEnabled =
    request.thinking?.type === "enabled" || request.thinking?.type === "adaptive";
  const body: CanonicalRequest = {
    canonicalVersion: 1,
    protocol: "anthropic-messages",
    projectionMode,
    model: request.model,
    stream: request.stream,
    messages,
    tools,
    toolChoice: request.tool_choice?.type === "none" ? "none" : "auto",
    ...(request.output_config?.effort !== undefined
      ? {
          reasoningEffort: request.output_config.effort,
          requestedReasoningEffort: request.output_config.effort,
        }
      : {}),
    ...(request.thinking !== undefined
      ? {
          thinking: {
            enabled: thinkingEnabled,
            ...(request.thinking.budget_tokens !== undefined
              ? { budgetTokens: request.thinking.budget_tokens }
              : {}),
          },
        }
      : {}),
    ...(request.max_tokens !== undefined
      ? { outputTokenLimit: request.max_tokens }
      : {}),
    reasoningReplays,
    includeEncryptedReasoning: false,
  };
  return { ok: true, value: { source: request, body } };
}
