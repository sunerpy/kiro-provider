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
  type CanonicalToolResultPart,
  legacyAssistantOutputFingerprint,
  type ProtocolProjectionMode,
  textFromParts,
} from "../../protocol/canonical.js";
import { findToolHistoryViolation } from "../../protocol/tool-history.js";
import { isLegacyReplayToken, isProviderReplayToken } from "../../reasoning/replay-token.js";
import {
  type HostedWebSearchDeclaration,
  parseMessagesWebSearchTool,
} from "../../web-search/declarations.js";
import { hostedSegmentFingerprint } from "../../web-search/fingerprint.js";
import {
  HOSTED_CALL_METADATA,
  type HostedHistory,
  type HostedHistoryCall,
  type HostedHistoryCitation,
  type HostedHistorySourceView,
} from "../../web-search/history.js";
import { isGpt56Model } from "../responses/reasoning.js";
import {
  ANTHROPIC_STRUCTURED_OUTPUT_PARAM,
  ANTHROPIC_STRUCTURED_OUTPUT_REJECTION_CODE,
  ANTHROPIC_STRUCTURED_OUTPUT_REJECTION_MESSAGE,
  type AnthropicLocalStructuredOutputProfile,
  parseAnthropicLocalStructuredOutputFormat,
} from "./structured-output.js";

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
    type: z.string().min(1).optional(),
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
        format: z.unknown().optional(),
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
  readonly thinkingDisplay?: "omitted" | "summarized";
  readonly outputTokenLimitMode?: "advisory";
  readonly reasoningReplayMode?: "conflict-omitted";
  readonly reasoningReplayConflictMessages?: number;
  readonly reasoningReplayConflictBlocks?: number;
  readonly toolResultImageMode?: "multiple-lifted";
  readonly toolResultImageMessages?: number;
  readonly toolResultImageResults?: number;
  readonly toolResultImageBlocks?: number;
  /** Recognized `output_config.format`; the schema itself is never projected upstream. */
  readonly localStructuredOutputProfile?: AnthropicLocalStructuredOutputProfile;
  /** Current hosted search declaration: the only authorization for new searches. */
  readonly hostedWebSearch?: HostedWebSearchDeclaration;
  /** Hosted search calls and citations in history, restored from snapshots later. */
  readonly hostedHistory: HostedHistory;
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

function sameReasoningLookup(
  left: CanonicalReasoningReplay["lookup"],
  right: CanonicalReasoningReplay["lookup"],
  leftSourceSignature?: string,
  rightSourceSignature?: string,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "anthropic-token" && right.kind === "anthropic-token") {
    return left.signature === right.signature;
  }
  if (left.kind === "chat-hash" && right.kind === "chat-hash") {
    // GPT signature-only reasoning maps to the same opaque placeholder text.
    // Preserve the source signature in this equality check so two distinct
    // envelopes cannot be mistaken for an exact duplicate and accepted.
    return (
      left.reasoningText === right.reasoningText && leftSourceSignature === rightSourceSignature
    );
  }
  if (left.kind === "responses-token" && right.kind === "responses-token") {
    return left.encryptedContent === right.encryptedContent;
  }
  if (left.kind !== "anthropic-direct" || right.kind !== "anthropic-direct") return false;
  const leftContent = left.content;
  const rightContent = right.content;
  if (leftContent.kind !== rightContent.kind) return false;
  if (leftContent.kind === "reasoning_text" && rightContent.kind === "reasoning_text") {
    return (
      leftContent.text === rightContent.text && leftContent.signature === rightContent.signature
    );
  }
  if (leftContent.kind === "redacted_content" && rightContent.kind === "redacted_content") {
    return (
      leftContent.bytes.byteLength === rightContent.bytes.byteLength &&
      leftContent.bytes.every((byte, index) => byte === rightContent.bytes[index])
    );
  }
  return false;
}

function isEmptyDirectReasoning(replay: CanonicalReasoningReplay["lookup"]): boolean {
  return (
    replay.kind === "anthropic-direct" &&
    replay.content.kind === "reasoning_text" &&
    replay.content.text.length === 0
  );
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
      readonly reasoningReplayConflictBlocks?: number;
      readonly imageToolResultCount?: number;
      readonly imageToolResultBlockCount?: number;
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
  let replaySourceSignature: string | undefined;
  let reasoningBlockCount = 0;
  let reasoningReplayConflictBlocks = 0;
  let cachePoint = false;
  let directImagePath: string | undefined;
  let imageToolResultPath: string | undefined;
  let imageToolResultCount = 0;
  let imageToolResultBlockCount = 0;
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
          imageToolResultPath ??= blockPath;
          imageToolResultCount += 1;
          imageToolResultBlockCount += resultContent.images.length;
        }
        content.push({
          type: "tool_result",
          toolCallId: block.tool_use_id,
          content: resultContent.text,
          isError: block.is_error === true,
          path: blockPath,
        });
        // Kiro's ToolResult content supports only text/JSON, while its user
        // message supports native images. Lift image blocks into that same user
        // turn in stable result/block order. Kiro still receives every tool ID,
        // result status and image byte, but its wire schema cannot bind an image
        // to a particular tool result; multiple image-bearing results therefore
        // carry an explicit compatibility marker at the HTTP boundary.
        content.push(...resultContent.images);
        break;
      }
      case "thinking":
      case "redacted_thinking": {
        if (message.role !== "assistant") {
          return failure(
            `Invalid request: ${blockPath} is not a valid assistant reasoning block`,
            "invalid_reasoning_replay",
            blockPath,
          );
        }
        const mapped = reasoningContent(block, blockPath, model);
        if ("ok" in mapped) return mapped;
        reasoningBlockCount += 1;
        if (reasoningReplayConflictBlocks > 0) {
          if (!isEmptyDirectReasoning(mapped)) {
            return failure(
              `Invalid request: ${blockPath} cannot be combined with conflicting assistant reasoning blocks`,
              "invalid_reasoning_replay",
              blockPath,
            );
          }
          reasoningReplayConflictBlocks = reasoningBlockCount;
          break;
        }
        const sourceSignature =
          block.type === "thinking" && typeof block.signature === "string"
            ? block.signature
            : undefined;
        if (replay === undefined) {
          replay = mapped;
          replaySourceSignature = sourceSignature;
          break;
        }
        if (sameReasoningLookup(replay, mapped, replaySourceSignature, sourceSignature)) break;
        if (isEmptyDirectReasoning(replay) && isEmptyDirectReasoning(mapped)) {
          // Older gateway builds could emit two distinct signature-only thinking
          // blocks for one assistant tool turn. Kiro history has one reasoning
          // slot, so guessing either signature would be unsafe. Preserve the
          // visible assistant/tool output and omit both replay envelopes under
          // an explicit compatibility marker.
          replay = undefined;
          reasoningReplayConflictBlocks = reasoningBlockCount;
          break;
        }
        return failure(
          `Invalid request: ${blockPath} is not a valid single assistant reasoning block`,
          "invalid_reasoning_replay",
          blockPath,
        );
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
    ...(reasoningReplayConflictBlocks > 0 ? { reasoningReplayConflictBlocks } : {}),
    ...(imageToolResultCount > 0 ? { imageToolResultCount, imageToolResultBlockCount } : {}),
  };
}

const HOSTED_BLOCK_TYPES = new Set(["server_tool_use", "web_search_tool_result"]);

/** True when an assistant message carries hosted search blocks or cited text. */
function hasHostedContent(message: AnthropicMessagesRequest["messages"][number]): boolean {
  return (
    message.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some(
      (block) =>
        HOSTED_BLOCK_TYPES.has(block.type) ||
        (block.type === "text" && Object.hasOwn(block, "citations")),
    )
  );
}

type HostedCallDraft = {
  readonly callId: string;
  readonly query: string;
  readonly path: string;
  publicState?: HostedHistoryCall["publicState"];
  /** Canonical assistant message holding the call and its placeholder result. */
  assistantMessage?: number;
  result?: { readonly message: number; readonly part: number };
};

function hostedPlaceholder(call: HostedCallDraft): CanonicalToolResultPart {
  // Restored from the authenticated snapshot later; never trusted from the client.
  return {
    type: "tool_result",
    toolCallId: call.callId,
    content: [],
    isError: false,
    path: call.path,
    sourceMetadata: { [HOSTED_CALL_METADATA]: true },
  };
}

function segmentOutputFingerprint(segment: HostedSegment): {
  readonly current: string;
  readonly legacy: string;
} {
  const output = {
    text: textFromParts(segment.content),
    toolCalls: segment.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      input: JSON.stringify(call.input),
    })),
  };
  if (segment.hosted.length === 0) {
    return {
      current: assistantOutputFingerprint(output),
      legacy: legacyAssistantOutputFingerprint(output),
    };
  }
  const fingerprint = hostedSegmentFingerprint(
    output,
    segment.hosted.map((call) => call.callId),
  );
  return { current: fingerprint, legacy: fingerprint };
}

type HostedSegment = {
  readonly content: CanonicalContentPart[];
  readonly toolCalls: CanonicalToolCall[];
  readonly hosted: HostedCallDraft[];
  replay?: CanonicalReasoningReplay["lookup"];
  replaySourceSignature?: string;
  reasoningBlocks: number;
  conflictBlocks: number;
  cachePoint: boolean;
  readonly path: string;
};

function parseCitations(
  value: unknown,
  path: string,
): AnthropicFailure | readonly HostedHistoryCitation[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    return failure(`Invalid request: ${path} must be an array`, "web_search_replay_invalid", path);
  }
  const citations: HostedHistoryCitation[] = [];
  for (const [index, citation] of value.entries()) {
    const citationPath = `${path}.${index}`;
    if (!isRecord(citation) || citation.type !== "web_search_result_location") {
      return failure(
        `Invalid request: ${citationPath} must be a web_search_result_location citation`,
        "unsupported_content_part",
        citationPath,
      );
    }
    const keys = validateAllowedKeys(
      citation,
      citationPath,
      new Set(["type", "url", "title", "encrypted_index", "cited_text"]),
      "web_search_replay_invalid",
    );
    if (keys) return keys;
    if (
      typeof citation.url !== "string" ||
      typeof citation.title !== "string" ||
      typeof citation.cited_text !== "string"
    ) {
      return failure(
        `Invalid request: ${citationPath} requires url, title and cited_text`,
        "web_search_replay_invalid",
        citationPath,
      );
    }
    citations.push({
      encryptedIndex: citation.encrypted_index,
      url: citation.url,
      title: citation.title,
      citedText: citation.cited_text,
      path: citationPath,
    });
  }
  return citations;
}

function parseSearchResultState(
  block: Readonly<Record<string, unknown>>,
  path: string,
): AnthropicFailure | HostedHistoryCall["publicState"] {
  const content = block.content;
  if (Array.isArray(content)) {
    const sources: HostedHistorySourceView[] = [];
    for (const [index, entry] of content.entries()) {
      const entryPath = `${path}.content.${index}`;
      if (!isRecord(entry) || entry.type !== "web_search_result") {
        return failure(
          `Invalid request: ${entryPath} must be a web_search_result`,
          "web_search_replay_invalid",
          entryPath,
        );
      }
      const keys = validateAllowedKeys(
        entry,
        entryPath,
        new Set(["type", "url", "title", "encrypted_content", "page_age"]),
        "web_search_replay_invalid",
      );
      if (keys) return keys;
      if (
        typeof entry.url !== "string" ||
        typeof entry.title !== "string" ||
        (entry.page_age !== undefined &&
          entry.page_age !== null &&
          typeof entry.page_age !== "string")
      ) {
        return failure(
          `Invalid request: ${entryPath} has an invalid web_search_result shape`,
          "web_search_replay_invalid",
          entryPath,
        );
      }
      sources.push({
        url: entry.url,
        title: entry.title,
        pageAge: typeof entry.page_age === "string" ? entry.page_age : null,
        encryptedContent: entry.encrypted_content,
      });
    }
    return { kind: "completed", sources };
  }
  if (
    isRecord(content) &&
    content.type === "web_search_tool_result_error" &&
    typeof content.error_code === "string"
  ) {
    const keys = validateAllowedKeys(
      content,
      `${path}.content`,
      new Set(["type", "error_code"]),
      "web_search_replay_invalid",
    );
    if (keys) return keys;
    return { kind: "failed", errorCode: content.error_code };
  }
  return failure(
    `Invalid request: ${path}.content must be search results or a search error`,
    "web_search_replay_invalid",
    `${path}.content`,
  );
}

/**
 * Splits one assistant message that contains hosted search into the generation
 * segments that actually ran. A segment ends where results start for its
 * hosted calls; reasoning conflict rules apply within each segment and never
 * across a hosted boundary. Leading result blocks answer calls left pending by
 * the previous assistant message.
 */
function mapHostedAssistant(
  message: AnthropicMessagesRequest["messages"][number],
  index: number,
  model: string,
  outstanding: Map<string, HostedCallDraft>,
):
  | AnthropicFailure
  | {
      readonly segments: readonly HostedSegment[];
      readonly citations: readonly HostedHistoryCitation[];
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
  const blocks = message.content as readonly Readonly<Record<string, unknown> & { type: string }>[];
  const segments: HostedSegment[] = [];
  const citations: HostedHistoryCitation[] = [];
  const newSegment = (blockIndex: number): HostedSegment => ({
    content: [],
    toolCalls: [],
    hosted: [],
    reasoningBlocks: 0,
    conflictBlocks: 0,
    cachePoint: false,
    path: blockIndex === 0 ? path : `${path}.content.${blockIndex}`,
  });
  let current = newSegment(0);
  let resultsPhase = false;
  let leading = true;
  for (const [blockIndex, block] of blocks.entries()) {
    const blockPath = `${path}.content.${blockIndex}`;
    if (block.type === "web_search_tool_result") {
      const keys = validateAllowedKeys(
        block,
        blockPath,
        new Set(["type", "tool_use_id", "content", "cache_control"]),
        "web_search_replay_invalid",
      );
      if (keys) return keys;
      const cacheControl = validateCacheControl(block.cache_control, `${blockPath}.cache_control`);
      if (cacheControl) return cacheControl;
      if (typeof block.tool_use_id !== "string") {
        return failure(
          `Invalid request: ${blockPath} requires tool_use_id`,
          "invalid_tool_history",
          blockPath,
        );
      }
      const state = parseSearchResultState(block, blockPath);
      if ("ok" in state) return state;
      const own = current.hosted.find((call) => call.callId === block.tool_use_id);
      const earlier = leading ? outstanding.get(block.tool_use_id) : undefined;
      const call = own ?? earlier;
      if (call === undefined || call.publicState !== undefined) {
        return failure(
          `Invalid request: ${blockPath} does not answer an unresolved server_tool_use`,
          "invalid_tool_history",
          blockPath,
        );
      }
      call.publicState = state;
      if (earlier !== undefined) {
        outstanding.delete(block.tool_use_id);
        continue;
      }
      resultsPhase = true;
      continue;
    }
    leading = false;
    if (resultsPhase) {
      if (current.hosted.some((call) => call.publicState === undefined)) {
        return failure(
          `Invalid request: ${blockPath} follows unresolved server_tool_use blocks`,
          "invalid_tool_history",
          blockPath,
        );
      }
      if (current.toolCalls.some((call) => call.sourceMetadata?.[HOSTED_CALL_METADATA] !== true)) {
        return failure(
          `Invalid request: a client tool_use must end its assistant message (${blockPath})`,
          "invalid_tool_history",
          blockPath,
        );
      }
      segments.push(current);
      current = newSegment(blockIndex);
      resultsPhase = false;
    }
    switch (block.type) {
      case "text": {
        const keys = validateAllowedKeys(
          block,
          blockPath,
          new Set(["type", "text", "cache_control", "citations"]),
        );
        if (keys) return keys;
        const cacheControl = validateCacheControl(
          block.cache_control,
          `${blockPath}.cache_control`,
        );
        if (cacheControl) return cacheControl;
        current.cachePoint ||= block.cache_control !== undefined;
        if (typeof block.text !== "string") {
          return failure(
            `Invalid request: ${blockPath}.text must be a string`,
            undefined,
            `${blockPath}.text`,
          );
        }
        const parsedCitations = parseCitations(block.citations, `${blockPath}.citations`);
        if (!Array.isArray(parsedCitations)) return parsedCitations as AnthropicFailure;
        citations.push(...parsedCitations);
        current.content.push(textPart(block.text, `${blockPath}.text`));
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
        current.cachePoint ||= block.cache_control !== undefined;
        if (typeof block.id !== "string" || typeof block.name !== "string") {
          return failure(
            `Invalid request: ${blockPath} requires id and name`,
            "invalid_tool_history",
            blockPath,
          );
        }
        current.toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input ?? {},
          path: blockPath,
        });
        break;
      }
      case "server_tool_use": {
        const keys = validateAllowedKeys(
          block,
          blockPath,
          new Set(["type", "id", "name", "input", "cache_control"]),
          "web_search_replay_invalid",
        );
        if (keys) return keys;
        const cacheControl = validateCacheControl(
          block.cache_control,
          `${blockPath}.cache_control`,
        );
        if (cacheControl) return cacheControl;
        current.cachePoint ||= block.cache_control !== undefined;
        const input = block.input;
        if (
          typeof block.id !== "string" ||
          block.id.length === 0 ||
          block.name !== "web_search" ||
          !isRecord(input) ||
          Object.keys(input).some((key) => key !== "query") ||
          typeof input.query !== "string"
        ) {
          return failure(
            `Invalid request: ${blockPath} must be a web_search server_tool_use with a query`,
            "web_search_replay_invalid",
            blockPath,
          );
        }
        const draft: HostedCallDraft = { callId: block.id, query: input.query, path: blockPath };
        current.hosted.push(draft);
        current.toolCalls.push({
          id: block.id,
          name: "web_search",
          input: { query: input.query },
          path: blockPath,
          sourceMetadata: { [HOSTED_CALL_METADATA]: true },
        });
        break;
      }
      case "thinking":
      case "redacted_thinking": {
        const mapped = reasoningContent(block, blockPath, model);
        if ("ok" in mapped) return mapped;
        current.reasoningBlocks += 1;
        if (current.conflictBlocks > 0) {
          if (!isEmptyDirectReasoning(mapped)) {
            return failure(
              `Invalid request: ${blockPath} cannot be combined with conflicting assistant reasoning blocks`,
              "invalid_reasoning_replay",
              blockPath,
            );
          }
          current.conflictBlocks = current.reasoningBlocks;
          break;
        }
        const sourceSignature =
          block.type === "thinking" && typeof block.signature === "string"
            ? block.signature
            : undefined;
        if (current.replay === undefined) {
          current.replay = mapped;
          current.replaySourceSignature = sourceSignature;
          break;
        }
        if (
          sameReasoningLookup(
            current.replay,
            mapped,
            current.replaySourceSignature,
            sourceSignature,
          )
        )
          break;
        if (isEmptyDirectReasoning(current.replay) && isEmptyDirectReasoning(mapped)) {
          current.replay = undefined;
          current.conflictBlocks = current.reasoningBlocks;
          break;
        }
        return failure(
          `Invalid request: ${blockPath} is not a valid single assistant reasoning block`,
          "invalid_reasoning_replay",
          blockPath,
        );
      }
      default:
        return failure(
          `Invalid request: unsupported content block ${block.type} at ${blockPath}`,
          "unsupported_content_part",
          blockPath,
        );
    }
  }
  if (
    !leading ||
    segments.length > 0 ||
    current.toolCalls.length > 0 ||
    current.content.length > 0
  ) {
    if (
      resultsPhase &&
      current.toolCalls.some((call) => call.sourceMetadata?.[HOSTED_CALL_METADATA] !== true)
    ) {
      return failure(
        `Invalid request: a client tool_use must end its assistant message (${path})`,
        "invalid_tool_history",
        path,
      );
    }
    segments.push(current);
  }
  return { segments, citations };
}

function mapTools(tools: AnthropicMessagesRequest["tools"]):
  | AnthropicFailure
  | {
      readonly declarations: readonly CanonicalToolDeclaration[];
      readonly hosted?: HostedWebSearchDeclaration;
    } {
  const declarations: CanonicalToolDeclaration[] = [];
  const names = new Set<string>();
  let hosted: HostedWebSearchDeclaration | undefined;
  for (const [index, tool] of (tools ?? []).entries()) {
    if (tool.type !== undefined) {
      // Server tools are identified by type. Only the basic hosted web search is
      // executed by the provider; every other server tool stays unsupported.
      if (!tool.type.startsWith("web_search_")) {
        return failure(
          `Invalid request: tools.${index}.type is not supported`,
          "unsupported_tool_field",
          `tools.${index}.type`,
        );
      }
      const parsed = parseMessagesWebSearchTool(tool, `tools.${index}`);
      if (!parsed.ok)
        return failure(`Invalid request: ${parsed.message}`, parsed.code, parsed.param);
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
      hosted = parsed.declaration;
      continue;
    }
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
  return { declarations, ...(hosted !== undefined ? { hosted } : {}) };
}

function validateToolHistory(
  messages: readonly CanonicalMessage[],
  tools: readonly CanonicalToolDeclaration[],
): AnthropicFailure | undefined {
  // Client upgrades may withdraw tools that remain in complete call/result
  // history. Only the current declarations authorize this turn's output.
  const violation = findToolHistoryViolation(messages, tools, {
    allowHistoricalWithoutDeclarations: true,
  });
  if (!violation) return undefined;
  switch (violation.kind) {
    case "missing_tool_declaration":
      return failure(
        "Invalid request: historical tool call has no exact declaration",
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

/**
 * `output_config.format` is accepted only as the bounded local
 * `single-string-object-v1` profile. Effort keeps working alongside it; every
 * other key stays on the ordinary unsupported_parameter path.
 */
function validateOutputConfig(
  value: AnthropicMessagesRequest["output_config"],
):
  | AnthropicFailure
  | { readonly localStructuredOutputProfile?: AnthropicLocalStructuredOutputProfile } {
  if (value === undefined) return {};
  for (const key of Object.keys(value)) {
    if (key !== "effort" && key !== "format") {
      return failure(
        `Invalid request: output_config.${key} is not supported`,
        "unsupported_parameter",
        `output_config.${key}`,
      );
    }
  }
  if (!Object.hasOwn(value, "format")) return {};
  const localStructuredOutputProfile = parseAnthropicLocalStructuredOutputFormat(value.format);
  if (localStructuredOutputProfile === undefined) {
    return failure(
      ANTHROPIC_STRUCTURED_OUTPUT_REJECTION_MESSAGE,
      ANTHROPIC_STRUCTURED_OUTPUT_REJECTION_CODE,
      ANTHROPIC_STRUCTURED_OUTPUT_PARAM,
    );
  }
  return { localStructuredOutputProfile };
}

/**
 * The profile buffers one plain-text inference and publishes a single text
 * block, so it cannot carry thinking blocks or a forced tool selection. Tools
 * may still be declared (Claude Code sends an empty list); any upstream tool
 * call is rejected before publication.
 */
function validateStructuredOutputBoundary(
  request: AnthropicMessagesRequest,
): AnthropicFailure | undefined {
  if (
    request.thinking !== undefined &&
    (request.thinking.type !== "disabled" ||
      Object.keys(request.thinking).some((key) => key !== "type"))
  ) {
    return failure(
      "Invalid request: thinking must be absent or disabled when output_config.format is used",
      ANTHROPIC_STRUCTURED_OUTPUT_REJECTION_CODE,
      "thinking",
    );
  }
  if (
    request.tool_choice !== undefined &&
    request.tool_choice.type !== "auto" &&
    request.tool_choice.type !== "none"
  ) {
    return failure(
      "Invalid request: tool_choice must be auto or none when output_config.format is used",
      ANTHROPIC_STRUCTURED_OUTPUT_REJECTION_CODE,
      "tool_choice",
    );
  }
  return undefined;
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
  const outputConfig = validateOutputConfig(request.output_config);
  if (isFailure(outputConfig)) return outputConfig;
  const localStructuredOutputProfile = outputConfig.localStructuredOutputProfile;
  if (localStructuredOutputProfile !== undefined) {
    const boundary = validateStructuredOutputBoundary(request);
    if (boundary) return boundary;
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
  const mappedTools = mapTools(request.tools);
  if (isFailure(mappedTools)) return mappedTools;
  const tools = mappedTools.declarations;

  const messages: CanonicalMessage[] = [];
  const reasoningReplays: CanonicalRequest["reasoningReplays"][number][] = [];
  let reasoningReplayConflictMessages = 0;
  let reasoningReplayConflictBlocks = 0;
  let toolResultImageMessages = 0;
  let toolResultImageResults = 0;
  let toolResultImageBlocks = 0;
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
  const hostedCalls: HostedCallDraft[] = [];
  const hostedCitations: HostedHistoryCitation[] = [];
  // Calls of an earlier assistant message still waiting for their result block.
  const outstanding = new Map<string, HostedCallDraft>();
  // Calls whose placeholder results belong to the next canonical message.
  let carry: HostedCallDraft[] = [];
  // Client calls of a group that also holds hosted calls. The next message must
  // answer every one of them before the group's searches may run.
  let groupClients: string[] = [];
  const missingClientResults = (ids: readonly string[], path: string): AnthropicFailure =>
    failure(
      `Invalid request: tool_use ids were found without tool_result blocks immediately after: ${ids.join(", ")}. Each tool_use block must have a corresponding tool_result block in the next message.`,
      "invalid_tool_history",
      path,
    );
  const pushHostedResults = (calls: readonly HostedCallDraft[], path: string): void => {
    const messageIndex = messages.length;
    for (const [part, call] of calls.entries()) call.result = { message: messageIndex, part };
    messages.push({ role: "tool", content: calls.map(hostedPlaceholder), toolCalls: [], path });
  };
  for (const [index, source] of request.messages.entries()) {
    if (groupClients.length > 0) {
      const answered = new Set(
        source.role === "user" && Array.isArray(source.content)
          ? source.content.flatMap((block) =>
              block.type === "tool_result" && typeof block.tool_use_id === "string"
                ? [block.tool_use_id]
                : [],
            )
          : [],
      );
      const missing = groupClients.filter((id) => !answered.has(id));
      if (missing.length > 0) return missingClientResults(missing, `messages.${index}`);
      groupClients = [];
    }
    if (carry.length > 0 && source.role !== "user") {
      pushHostedResults(carry, `messages.${index}`);
      carry = [];
    }
    const unresolved = carry.find((call) => call.publicState === undefined);
    if (
      unresolved !== undefined &&
      (!Array.isArray(source.content) ||
        source.content.length === 0 ||
        source.content.some((block) => block.type !== "tool_result"))
    ) {
      // Only client tool results may continue a turn that waits on a hosted
      // call; any other content ends the turn with that call unresolved.
      return failure(
        `Invalid request: web_search tool use with id ${unresolved.callId} was found without a corresponding web_search_tool_result block`,
        "invalid_tool_history",
        `messages.${index}`,
      );
    }
    if (hasHostedContent(source)) {
      const awaiting = [...outstanding.keys()];
      const hosted = mapHostedAssistant(source, index, request.model, outstanding);
      if ("ok" in hosted) return hosted;
      if (awaiting.some((callId) => outstanding.has(callId))) {
        return failure(
          `Invalid request: messages.${index} must begin with the web_search_tool_result of every earlier pending server_tool_use`,
          "invalid_tool_history",
          `messages.${index}`,
        );
      }
      hostedCitations.push(...hosted.citations);
      for (const [position, segment] of hosted.segments.entries()) {
        const assistantIndex = messages.length;
        if (segment.conflictBlocks > 0) {
          reasoningReplayConflictMessages += 1;
          reasoningReplayConflictBlocks += segment.conflictBlocks;
        }
        if (segment.replay !== undefined) {
          const fingerprint = segmentOutputFingerprint(segment);
          reasoningReplays.push({
            lookup: segment.replay,
            outputFingerprint: fingerprint.current,
            ...(segment.replay.kind === "anthropic-token" &&
            isLegacyReplayToken(segment.replay.signature) &&
            fingerprint.legacy !== fingerprint.current
              ? { compatibleOutputFingerprints: [fingerprint.legacy] }
              : {}),
            insertBeforeMessage: assistantIndex,
            path: segment.path,
          });
        }
        messages.push({
          role: "assistant",
          content: segment.content,
          toolCalls: segment.toolCalls,
          path: segment.path,
          ...(segment.cachePoint ? { cachePoint: true } : {}),
        });
        for (const call of segment.hosted) {
          call.assistantMessage = assistantIndex;
          hostedCalls.push(call);
        }
        if (segment.hosted.length === 0) continue;
        if (position < hosted.segments.length - 1) {
          pushHostedResults(segment.hosted, `${segment.path}.results`);
          continue;
        }
        carry = [...segment.hosted];
        groupClients = segment.toolCalls.flatMap((call) =>
          call.sourceMetadata?.[HOSTED_CALL_METADATA] === true ? [] : [call.id],
        );
        for (const call of segment.hosted) {
          if (call.publicState === undefined) outstanding.set(call.callId, call);
        }
      }
      continue;
    }
    if (source.role === "assistant" && outstanding.size > 0) {
      return failure(
        `Invalid request: messages.${index} must begin with the web_search_tool_result of every earlier pending server_tool_use`,
        "invalid_tool_history",
        `messages.${index}`,
      );
    }
    const mapped = mapMessage(source, index, request.model);
    if ("ok" in mapped) return mapped;
    if (mapped.reasoningReplayConflictBlocks !== undefined) {
      reasoningReplayConflictMessages += 1;
      reasoningReplayConflictBlocks += mapped.reasoningReplayConflictBlocks;
    }
    if ((mapped.imageToolResultCount ?? 0) > 1) {
      toolResultImageMessages += 1;
      toolResultImageResults += mapped.imageToolResultCount ?? 0;
      toolResultImageBlocks += mapped.imageToolResultBlockCount ?? 0;
    }
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
    if (carry.length > 0) {
      // Hosted results lead the next user turn, ahead of the client results of
      // their group; restoration puts the whole group back in wire order.
      const messageIndex = messages.length;
      for (const [part, call] of carry.entries()) call.result = { message: messageIndex, part };
      messages.push({
        ...mapped.message,
        content: [...carry.map(hostedPlaceholder), ...mapped.message.content],
      });
      carry = [];
      continue;
    }
    messages.push(mapped.message);
  }
  if (groupClients.length > 0) {
    return missingClientResults(groupClients, `messages.${request.messages.length - 1}`);
  }
  if (carry.length > 0) {
    pushHostedResults(carry, `messages.${request.messages.length - 1}`);
    carry = [];
  }
  const hostedHistoryCalls: HostedHistoryCall[] = hostedCalls.map((call) => {
    if (call.assistantMessage === undefined || call.result === undefined) {
      throw new TypeError("Hosted search call was not projected");
    }
    return {
      callId: call.callId,
      query: call.query,
      assistantMessage: call.assistantMessage,
      result: call.result,
      publicState: call.publicState ?? { kind: "pending" },
      path: call.path,
    };
  });
  const pendingHosted = hostedHistoryCalls.find((call) => call.publicState.kind === "pending");
  if (pendingHosted !== undefined) {
    if (mappedTools.hosted === undefined) {
      return failure(
        "Invalid request: a pending web search requires the web_search tool in the current request",
        "web_search_pending_unauthorized",
        pendingHosted.path,
      );
    }
    if (request.tool_choice?.type === "none") {
      return failure(
        "Invalid request: tool_choice none cannot run a pending web search",
        "web_search_pending_unauthorized",
        "tool_choice",
      );
    }
  }
  if (mappedTools.hosted !== undefined && localStructuredOutputProfile !== undefined) {
    return failure(
      "Invalid request: web search cannot be combined with output_config.format",
      "unsupported_web_search",
      mappedTools.hosted.path,
    );
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
  const thinkingDisplay =
    request.thinking?.display === "summarized"
      ? ("summarized" as const)
      : request.thinking?.display === "omitted"
        ? ("omitted" as const)
        : undefined;
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
            ...(thinkingDisplay !== undefined ? { display: thinkingDisplay } : {}),
          },
        }
      : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.max_tokens !== undefined && outputTokenLimitMode === undefined
      ? { outputTokenLimit: request.max_tokens }
      : {}),
    reasoningReplays,
    includeEncryptedReasoning: thinkingDisplay === "omitted",
  };
  const count = cacheMarkers;
  return {
    ok: true,
    value: {
      source: request,
      body,
      cacheControlCount: count,
      contextManagementRequested: request.context_management !== undefined,
      ...(thinkingDisplay !== undefined ? { thinkingDisplay } : {}),
      ...(outputTokenLimitMode !== undefined ? { outputTokenLimitMode } : {}),
      ...(reasoningReplayConflictMessages > 0
        ? {
            reasoningReplayMode: "conflict-omitted" as const,
            reasoningReplayConflictMessages,
            reasoningReplayConflictBlocks,
          }
        : {}),
      ...(toolResultImageMessages > 0
        ? {
            toolResultImageMode: "multiple-lifted" as const,
            toolResultImageMessages,
            toolResultImageResults,
            toolResultImageBlocks,
          }
        : {}),
      ...(localStructuredOutputProfile !== undefined ? { localStructuredOutputProfile } : {}),
      ...(mappedTools.hosted !== undefined ? { hostedWebSearch: mappedTools.hosted } : {}),
      hostedHistory: { calls: hostedHistoryCalls, citations: hostedCitations },
    },
  };
}
