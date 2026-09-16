import { z } from "zod";
import { isFable51Model } from "../../kiro/models.js";
import {
  resolveOutputTokenLimit,
  supportsAdvisoryOutputTokenLimit,
} from "../../kiro/output-token-limit.js";
import { isRecord, textPart } from "../../protocol/adapter-utils.js";
import {
  assistantOutputFingerprint,
  type CanonicalContentPart,
  type CanonicalImagePart,
  type CanonicalMessage,
  type CanonicalReasoningReplay,
  type CanonicalRequest,
  type CanonicalTextPart,
  type CanonicalToolCall,
  type CanonicalToolDeclaration,
  legacyAssistantOutputFingerprint,
  type ProtocolProjectionMode,
  textFromParts,
} from "../../protocol/canonical.js";
import { findToolHistoryViolation } from "../../protocol/tool-history.js";
import { isLegacyReplayToken, isProviderReplayToken } from "../../reasoning/replay-token.js";
import { isGpt56Model } from "../responses/reasoning.js";

const ContentBlockSchema = z.object({ type: z.string().min(1) }).passthrough();

const MessageSchema = z
  .object({
    role: z.enum(["user", "assistant", "system"]),
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
    display: z.enum(["summarized", "omitted", "updates"]).optional(),
  })
  .passthrough();

const AnthropicMessagesRequestSchema = z
  .object({
    model: z.string().min(1),
    max_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(1).optional(),
    messages: z.array(MessageSchema).min(1),
    system: z.union([z.string(), z.array(ContentBlockSchema)]).optional(),
    stream: z.boolean().default(false),
    tools: z.array(ToolSchema).optional(),
    tool_choice: ToolChoiceSchema.optional(),
    thinking: ThinkingSchema.optional(),
    cache_control: z.unknown().optional(),
    context_management: z
      .object({
        edits: z.array(z.record(z.unknown())),
      })
      .passthrough()
      .optional(),
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
  readonly cacheControlCount: number;
  readonly contextManagementRequested: boolean;
  readonly thinkingDisplay?: "omitted";
  readonly outputTokenLimitMode?: "advisory";
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
  "temperature",
  "messages",
  "system",
  "stream",
  "tools",
  "tool_choice",
  "thinking",
  "cache_control",
  "context_management",
  "output_config",
  "metadata",
]);

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
    return failure(`Invalid request: ${path}.${key} is not supported`, code, `${path}.${key}`);
  }
  return undefined;
}

function isFailure(value: unknown): value is AnthropicFailure {
  return isRecord(value) && value.ok === false && typeof value.message === "string";
}

/**
 * Prompt-cache controls do not change model-visible input. Kiro caches stable
 * prefixes automatically; explicit-checkpoints may additionally project this
 * marker to the native cachePoint field, never to synthetic prompt text. Keep
 * validation narrow so unrelated beta payloads cannot disappear silently.
 */
function validateCacheControl(value: unknown, path: string): AnthropicFailure | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    return failure(
      `Invalid request: ${path} must be an ephemeral cache control`,
      "unsupported_cache_control",
      path,
    );
  }
  const keys = validateAllowedKeys(value, path, new Set(["type", "ttl"]));
  if (keys) return keys;
  if (value.type !== "ephemeral") {
    return failure(
      `Invalid request: ${path}.type must be ephemeral`,
      "unsupported_cache_control",
      `${path}.type`,
    );
  }
  if (value.ttl !== undefined && value.ttl !== "5m" && value.ttl !== "1h") {
    return failure(
      `Invalid request: ${path}.ttl must be 5m or 1h`,
      "unsupported_cache_control",
      `${path}.ttl`,
    );
  }
  return undefined;
}

/**
 * Claude Code requests the clear-thinking strategy with `keep: "all"`.
 * Anthropic documents this exact variant as preserving every thinking block,
 * so it is a semantic no-op and is safe to accept. Any edit that would really
 * remove context remains fail-closed because Kiro has no equivalent control.
 */
function validateContextManagement(
  value: AnthropicMessagesRequest["context_management"],
): AnthropicFailure | undefined {
  if (value === undefined) return undefined;
  const keys = validateAllowedKeys(
    value,
    "context_management",
    new Set(["edits"]),
    "unsupported_context_edit",
  );
  if (keys) {
    return {
      ...keys,
      message: `capability_rejected:context_management: ${keys.message}`,
    };
  }
  for (const [index, edit] of value.edits.entries()) {
    const path = `context_management.edits.${index}`;
    const editKeys = validateAllowedKeys(
      edit,
      path,
      new Set(["type", "keep"]),
      "unsupported_context_edit",
    );
    if (editKeys) {
      return {
        ...editKeys,
        message: `capability_rejected:context_management: ${editKeys.message}`,
      };
    }
    if (edit.type !== "clear_thinking_20251015" || edit.keep !== "all") {
      return failure(
        `capability_rejected:context_management: ${path} would edit model-visible context and cannot be projected to Kiro`,
        "unsupported_context_edit",
        path,
      );
    }
  }
  return undefined;
}

function cacheControlCount(request: AnthropicMessagesRequest): number {
  let count = request.cache_control === undefined ? 0 : 1;
  if (Array.isArray(request.system)) {
    count += request.system.filter((block) => block.cache_control !== undefined).length;
  }
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.cache_control !== undefined) count += 1;
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        count += block.content.filter(
          (part) => isRecord(part) && part.cache_control !== undefined,
        ).length;
      }
    }
  }
  count += (request.tools ?? []).filter((tool) => tool.cache_control !== undefined).length;
  return count;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "request";
      return `${path}: ${issue.message}`;
    })
    .join(", ");
}

function systemParts(
  system: AnthropicMessagesRequest["system"],
): AnthropicFailure | readonly CanonicalTextPart[] {
  if (system === undefined) return [];
  if (typeof system === "string") return [textPart(system, "system")];
  const parts: CanonicalTextPart[] = [];
  for (const [index, block] of system.entries()) {
    const path = `system.${index}`;
    const keys = validateAllowedKeys(block, path, new Set(["type", "text", "cache_control"]));
    if (keys) return keys;
    const cacheControl = validateCacheControl(block.cache_control, `${path}.cache_control`);
    if (cacheControl) return cacheControl;
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
):
  | AnthropicFailure
  | {
      readonly text: readonly CanonicalTextPart[];
      readonly images: readonly CanonicalImagePart[];
    } {
  // Anthropic's tool_result.content is optional; an omitted result is empty.
  if (value === undefined) return { text: [], images: [] };
  if (typeof value === "string") return { text: [textPart(value, path)], images: [] };
  if (!Array.isArray(value)) {
    return failure(
      `Invalid request: ${path} must be a string or text/image block array`,
      "unsupported_tool_result_content",
      path,
    );
  }
  const text: CanonicalTextPart[] = [];
  const images: CanonicalImagePart[] = [];
  for (const [index, block] of value.entries()) {
    const blockPath = `${path}.${index}`;
    if (!isRecord(block)) {
      return failure(
        `Invalid request: ${blockPath} must be a text or base64 image block`,
        "unsupported_tool_result_content",
        blockPath,
      );
    }
    if (block.type === "text" && typeof block.text === "string") {
      const keys = validateAllowedKeys(
        block,
        blockPath,
        new Set(["type", "text", "cache_control"]),
      );
      if (keys) return keys;
      const cacheControl = validateCacheControl(block.cache_control, `${blockPath}.cache_control`);
      if (cacheControl) return cacheControl;
      text.push(textPart(block.text, `${blockPath}.text`));
      continue;
    }
    if (block.type === "image") {
      const image = base64ImagePart(block, blockPath);
      if (isFailure(image)) return image;
      images.push(image);
      continue;
    }
    return failure(
      `Invalid request: ${blockPath} must be a text or base64 image block`,
      "unsupported_tool_result_content",
      blockPath,
    );
  }
  return { text, images };
}

function base64ImagePart(
  block: Readonly<Record<string, unknown>>,
  path: string,
): AnthropicFailure | CanonicalImagePart {
  const keys = validateAllowedKeys(block, path, new Set(["type", "source", "cache_control"]));
  if (keys) return keys;
  const cacheControl = validateCacheControl(block.cache_control, `${path}.cache_control`);
  if (cacheControl) return cacheControl;
  if (
    !isRecord(block.source) ||
    block.source.type !== "base64" ||
    typeof block.source.data !== "string"
  ) {
    return failure(
      `Invalid request: ${path} requires a base64 image source`,
      "unsupported_image_source",
      path,
    );
  }
  const sourceKeys = validateAllowedKeys(
    block.source,
    `${path}.source`,
    new Set(["type", "data", "media_type"]),
  );
  if (sourceKeys) return sourceKeys;
  return {
    type: "image",
    data: block.source.data,
    ...(typeof block.source.media_type === "string" ? { mediaType: block.source.media_type } : {}),
    path,
  };
}

function reasoningContent(
  block: Readonly<Record<string, unknown>>,
  path: string,
  model: string,
): AnthropicFailure | CanonicalReasoningReplay["lookup"] {
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
    if (isProviderReplayToken(block.signature)) {
      if (block.thinking.length > 0) {
        return failure(
          `Invalid request: ${path}.thinking must be empty when signature is a provider replay token`,
          "invalid_reasoning_replay",
          `${path}.thinking`,
        );
      }
      return { kind: "anthropic-token", signature: block.signature };
    }
    if (block.thinking.length === 0) {
      if (isGpt56Model(model)) {
        return { kind: "chat-hash", reasoningText: "..." };
      }
      return {
        kind: "anthropic-direct",
        content: { kind: "reasoning_text", text: "", signature: block.signature },
      };
    }
    return {
      kind: "anthropic-direct",
      content: { kind: "reasoning_text", text: block.thinking, signature: block.signature },
    };
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
        kind: "anthropic-direct",
        content: { kind: "redacted_content", bytes: Uint8Array.from(bytes) },
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
  model: string,
):
  | AnthropicFailure
  | {
      readonly message: CanonicalMessage;
      readonly replay?: CanonicalReasoningReplay["lookup"];
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
  let replay: CanonicalReasoningReplay["lookup"] | undefined;
  let cachePoint = false;
  let directImagePath: string | undefined;
  let imageToolResultPath: string | undefined;
  for (const [blockIndex, block] of message.content.entries()) {
    const blockPath = `${path}.content.${blockIndex}`;
    if (message.role === "system" && block.type !== "text") {
      return failure(
        `Invalid request: ${blockPath} must be text in a system message`,
        "unsupported_instruction_projection",
        blockPath,
      );
    }
    switch (block.type) {
      case "text": {
        const keys = validateAllowedKeys(
          block,
          blockPath,
          new Set(["type", "text", "cache_control"]),
        );
        if (keys) return keys;
        const cacheControl = validateCacheControl(
          block.cache_control,
          `${blockPath}.cache_control`,
        );
        if (cacheControl) return cacheControl;
        cachePoint ||= block.cache_control !== undefined;
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
        if (imageToolResultPath !== undefined) {
          return failure(
            `Invalid request: ${blockPath} cannot be combined with an image-valued tool result because Kiro cannot retain both image origins`,
            "unsupported_tool_result_content",
            blockPath,
          );
        }
        const image = base64ImagePart(block, blockPath);
        if (isFailure(image)) return image;
        directImagePath = blockPath;
        content.push(image);
        break;
      }
      case "tool_use": {
        const keys = validateAllowedKeys(
          block,
          blockPath,
          new Set(["type", "id", "name", "input", "cache_control"]),
        );
        if (keys) return keys;
        const cacheControl = validateCacheControl(
          block.cache_control,
          `${blockPath}.cache_control`,
        );
        if (cacheControl) return cacheControl;
        cachePoint ||= block.cache_control !== undefined;
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
          new Set(["type", "tool_use_id", "content", "is_error", "cache_control"]),
        );
        if (keys) return keys;
        const cacheControl = validateCacheControl(
          block.cache_control,
          `${blockPath}.cache_control`,
        );
        if (cacheControl) return cacheControl;
        cachePoint ||= block.cache_control !== undefined;
        if (typeof block.tool_use_id !== "string") {
          return failure(
            `Invalid request: ${blockPath} requires tool_use_id`,
            "invalid_tool_history",
            blockPath,
          );
        }
        const resultContent = toolResultContent(block.content, `${blockPath}.content`);
        if (isFailure(resultContent)) return resultContent;
        if (resultContent.images.length > 0) {
          if (directImagePath !== undefined) {
            return failure(
              `Invalid request: ${resultContent.images[0]?.path} cannot be combined with a direct message image because Kiro cannot retain both image origins`,
              "unsupported_tool_result_content",
              resultContent.images[0]?.path,
            );
          }
          if (imageToolResultPath !== undefined) {
            return failure(
              `Invalid request: ${resultContent.images[0]?.path} belongs to a second image-valued tool result, but Kiro cannot retain both tool associations`,
              "unsupported_tool_result_content",
              resultContent.images[0]?.path,
            );
          }
          imageToolResultPath = blockPath;
        }
        content.push({
          type: "tool_result",
          toolCallId: block.tool_use_id,
          content: resultContent.text,
          isError: block.is_error === true,
          path: blockPath,
        });
        // Kiro's ToolResult content supports only text/JSON, while its user
        // message supports native images. Lift one image-bearing result into
        // that same user turn; with only one such result, the tool association
        // remains unambiguous and the image bytes stay model-visible.
        content.push(...resultContent.images);
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
        const mapped = reasoningContent(block, blockPath, model);
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
    message: {
      role: message.role,
      content,
      toolCalls,
      path,
      ...(cachePoint ? { cachePoint: true } : {}),
    },
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
      if (
        key !== "name" &&
        key !== "description" &&
        key !== "input_schema" &&
        key !== "cache_control"
      ) {
        return failure(
          `Invalid request: tools.${index}.${key} is not supported`,
          "unsupported_tool_field",
          `tools.${index}.${key}`,
        );
      }
    }
    const cacheControl = validateCacheControl(tool.cache_control, `tools.${index}.cache_control`);
    if (cacheControl) return cacheControl;
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
      descriptionPath: `tools.${index}.description`,
      inputSchema: tool.input_schema ?? {},
      path: `tools.${index}`,
      ...(tool.cache_control !== undefined ? { cachePoint: true } : {}),
    });
  }
  return declarations;
}

function validateToolHistory(
  messages: readonly CanonicalMessage[],
  tools: readonly CanonicalToolDeclaration[],
): AnthropicFailure | undefined {
  const violation = findToolHistoryViolation(messages, tools);
  if (!violation) return undefined;
  switch (violation.kind) {
    case "missing_tool_declaration":
      return failure(
        `Invalid request: tool call ${violation.callId} has no exact declaration for ${violation.toolName}`,
        violation.code,
        violation.path,
      );
    case "duplicate_tool_call":
      return failure(
        `Invalid request: duplicate tool call id ${violation.callId}`,
        violation.code,
        violation.path,
      );
    case "orphan_tool_result":
      return failure(
        `Invalid request: tool result ${violation.toolCallId} has no earlier unique call`,
        violation.code,
        violation.path,
      );
  }
}

export function adaptAnthropicMessagesRequest(
  raw: unknown,
  options: {
    readonly requireMaxTokens?: boolean;
    readonly unsupportedOutputTokenLimitMode?: "advisory";
  } = {},
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
  let outputTokenLimitMode: "advisory" | undefined;
  if (request.max_tokens !== undefined) {
    const outputLimit = resolveOutputTokenLimit(request.model, request.max_tokens);
    if (!outputLimit.ok) {
      if (
        outputLimit.code === "unsupported_output_token_limit" &&
        options.unsupportedOutputTokenLimitMode === "advisory" &&
        supportsAdvisoryOutputTokenLimit(request.model)
      ) {
        outputTokenLimitMode = "advisory";
      } else {
        return failure(
          `Invalid request: max_tokens: ${outputLimit.message}`,
          outputLimit.code,
          "max_tokens",
        );
      }
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
  const cacheControl = validateCacheControl(request.cache_control, "cache_control");
  if (cacheControl) return cacheControl;
  const cacheMarkers = cacheControlCount(request);
  if (cacheMarkers > 4) {
    return failure(
      `Invalid request: at most 4 cache_control markers are supported, received ${cacheMarkers}`,
      "too_many_cache_checkpoints",
      "cache_control",
    );
  }
  const contextManagement = validateContextManagement(request.context_management);
  if (contextManagement) return contextManagement;
  if (request.thinking) {
    for (const key of Object.keys(request.thinking)) {
      if (key !== "type" && key !== "budget_tokens" && key !== "display") {
        return failure(
          `Invalid request: thinking.${key} is not supported`,
          "unsupported_parameter",
          `thinking.${key}`,
        );
      }
    }
    if (request.thinking.type === "disabled" && request.thinking.display !== undefined) {
      return failure(
        "Invalid request: thinking.display is only valid when thinking is enabled or adaptive",
        "unsupported_parameter",
        "thinking.display",
      );
    }
    const fableSummarized =
      request.thinking.display === "summarized" && isFable51Model(request.model);
    if (
      request.thinking.display !== undefined &&
      request.thinking.display !== "omitted" &&
      !fableSummarized
    ) {
      return failure(
        `capability_rejected:thinking.display: ${request.thinking.display} cannot be represented by Kiro`,
        "unsupported_reasoning_display",
        "thinking.display",
      );
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
    messages.push({
      role: "system",
      content: system,
      toolCalls: [],
      path: "system",
      ...(Array.isArray(request.system) &&
      request.system.some((block) => block.cache_control !== undefined)
        ? { cachePoint: true }
        : {}),
    });
  }
  for (const [index, source] of request.messages.entries()) {
    const mapped = mapMessage(source, index, request.model);
    if ("ok" in mapped) return mapped;
    if (mapped.replay !== undefined) {
      const output = {
        text: textFromParts(mapped.message.content),
        toolCalls: mapped.message.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          input: JSON.stringify(call.input),
        })),
      };
      const outputFingerprint = assistantOutputFingerprint(output);
      const legacyOutputFingerprint = legacyAssistantOutputFingerprint(output);
      reasoningReplays.push({
        lookup: mapped.replay,
        outputFingerprint,
        ...(mapped.replay.kind === "anthropic-token" &&
        isLegacyReplayToken(mapped.replay.signature) &&
        legacyOutputFingerprint !== outputFingerprint
          ? { compatibleOutputFingerprints: [legacyOutputFingerprint] }
          : {}),
        insertBeforeMessage: messages.length,
        path: mapped.message.path,
      });
    }
    messages.push(mapped.message);
  }
  if (projectionMode === "safe" && messages.some((message) => message.role === "system")) {
    return failure(
      "Invalid request: system messages cannot be projected losslessly to Kiro in safe mode",
      "unsupported_instruction_projection",
      "messages",
    );
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
            ...(request.thinking.display === "omitted" ? { display: "omitted" as const } : {}),
          },
        }
      : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.max_tokens !== undefined && outputTokenLimitMode === undefined
      ? { outputTokenLimit: request.max_tokens }
      : {}),
    reasoningReplays,
    includeEncryptedReasoning: request.thinking?.display === "omitted",
  };
  const count = cacheMarkers;
  return {
    ok: true,
    value: {
      source: request,
      body,
      cacheControlCount: count,
      contextManagementRequested: request.context_management !== undefined,
      ...(request.thinking?.display === "omitted" ? { thinkingDisplay: "omitted" as const } : {}),
      ...(outputTokenLimitMode !== undefined ? { outputTokenLimitMode } : {}),
    },
  };
}
