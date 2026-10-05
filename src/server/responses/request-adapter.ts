import { resolveOutputTokenLimit } from "../../kiro/output-token-limit.js";
import { resolveInlineDocument } from "../../kiro/transform/document-handler.js";
import { RequestTransformError } from "../../kiro/transform/errors.js";
import { isRecord, textPart } from "../../protocol/adapter-utils.js";
import {
  assistantOutputFingerprint,
  type CanonicalContentPart,
  type CanonicalImagePart,
  type CanonicalMessage,
  type CanonicalRequest,
  type CanonicalTextPart,
  type CanonicalToolDeclaration,
  legacyAssistantOutputFingerprint,
  type ProtocolProjectionMode,
  textFromParts,
} from "../../protocol/canonical.js";
import { isLegacyReplayToken, isProviderReplayToken } from "../../reasoning/replay-token.js";
import {
  type HostedWebSearchDeclaration,
  parseResponsesWebSearchTool,
} from "../../web-search/declarations.js";
import { hostedSegmentFingerprint } from "../../web-search/fingerprint.js";
import {
  HOSTED_CALL_METADATA,
  type HostedHistory,
  type HostedHistoryCall,
} from "../../web-search/history.js";
import {
  allowedKeysValidator,
  type ProtocolResult,
  protocolFailure,
} from "../protocol/adaptation.js";
import type {
  ResponsesAdditionalToolsItem,
  ResponsesAgentMessageItem,
  ResponsesContentPart,
  ResponsesCustomToolCallItem,
  ResponsesCustomToolCallOutputItem,
  ResponsesFunctionCallItem,
  ResponsesFunctionCallOutputItem,
  ResponsesInputItem,
  ResponsesMessageItem,
  ResponsesReasoningItem,
  ResponsesRequest,
} from "../request-schema.js";
import { parseLocalStructuredOutputProfile } from "./structured-output.js";
import {
  createResponsesToolBridge,
  type ResponsesToolBridge,
  type ToolBridgeBinding,
} from "./tool-bridge.js";

export type ResponsesRequestAdaptationResult =
  | {
      readonly ok: true;
      readonly body: CanonicalRequest;
      readonly bridge: ResponsesToolBridge;
      /** Current hosted search declaration: the only authorization for new searches. */
      readonly hostedWebSearch?: HostedWebSearchDeclaration;
      /** Hosted search calls in history, restored from snapshots before dispatch. */
      readonly hostedHistory: HostedHistory;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly param?: string;
    };

export interface ResponsesPreviousContext {
  readonly input?: readonly ResponsesInputItem[];
  readonly messages: readonly CanonicalMessage[];
  readonly items?: readonly ResponsesInputItem[];
  readonly legacyRequest?: CanonicalRequest;
  readonly toolBindings?: readonly ToolBridgeBinding[];
}

export const RESPONSES_REQUEST_KEYS = new Set([
  "model",
  "input",
  "instructions",
  "stream",
  "stream_options",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "include",
  "store",
  "text",
  "service_tier",
  "prompt_cache_key",
  "metadata",
  "client_metadata",
  "previous_response_id",
  "conversation",
  "max_output_tokens",
  "temperature",
  "top_p",
  "truncation",
  "background",
  "max_tool_calls",
  "context_management",
  "moderation",
  "prompt",
  "prompt_cache_options",
  "prompt_cache_retention",
  "safety_identifier",
  "top_logprobs",
  "user",
]);

const UNSUPPORTED_RESPONSES_FIELDS = [
  "temperature",
  "top_p",
  "max_tool_calls",
  "context_management",
  "moderation",
  "prompt",
  "prompt_cache_options",
  "prompt_cache_retention",
] as const;

const MESSAGE_ITEM_KEYS = new Set(["type", "id", "status", "role", "content", "phase"]);
const AGENT_MESSAGE_ITEM_KEYS = new Set(["type", "id", "status", "author", "recipient", "content"]);
const FUNCTION_CALL_ITEM_KEYS = new Set([
  "type",
  "id",
  "status",
  "call_id",
  "namespace",
  "name",
  "arguments",
  // The official SDK's stream accumulator decorates otherwise replayable output.
  "parsed_arguments",
]);
const CUSTOM_CALL_ITEM_KEYS = new Set([
  "type",
  "id",
  "status",
  "call_id",
  "namespace",
  "name",
  "input",
]);
const TOOL_OUTPUT_ITEM_KEYS = new Set(["type", "id", "status", "call_id", "output"]);
const ADDITIONAL_TOOLS_ITEM_KEYS = new Set(["type", "id", "status", "role", "tools"]);
const REASONING_ITEM_KEYS = new Set([
  "type",
  "id",
  "status",
  "summary",
  "content",
  "encrypted_content",
]);

const validateAllowedKeys = allowedKeysValidator("Responses field");

function canonicalSource(
  value: Readonly<Record<string, unknown>>,
  path: string,
  metadataKeys: readonly string[] = [],
): {
  readonly path: string;
  readonly sourceId?: string;
  readonly sourceStatus?: string;
  readonly sourceMetadata?: Readonly<Record<string, unknown>>;
} {
  const sourceMetadata = Object.fromEntries(
    metadataKeys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]),
  );
  return {
    path,
    ...(typeof value.id === "string" ? { sourceId: value.id } : {}),
    ...(typeof value.status === "string" ? { sourceStatus: value.status } : {}),
    ...(Object.keys(sourceMetadata).length > 0 ? { sourceMetadata } : {}),
  };
}

function isMessageItem(item: ResponsesInputItem): item is ResponsesMessageItem {
  return item.type === "message" || (item.type === undefined && "role" in item);
}

function isAgentMessageItem(item: ResponsesInputItem): item is ResponsesAgentMessageItem {
  return item.type === "agent_message";
}

function isFunctionCallItem(item: ResponsesInputItem): item is ResponsesFunctionCallItem {
  return item.type === "function_call";
}

function isCustomToolCallItem(item: ResponsesInputItem): item is ResponsesCustomToolCallItem {
  return item.type === "custom_tool_call";
}

function isFunctionCallOutputItem(
  item: ResponsesInputItem,
): item is ResponsesFunctionCallOutputItem {
  return item.type === "function_call_output";
}

function isCustomToolCallOutputItem(
  item: ResponsesInputItem,
): item is ResponsesCustomToolCallOutputItem {
  return item.type === "custom_tool_call_output";
}

function isAdditionalToolsItem(item: ResponsesInputItem): item is ResponsesAdditionalToolsItem {
  return item.type === "additional_tools";
}

function isReasoningItem(item: ResponsesInputItem): item is ResponsesReasoningItem {
  return item.type === "reasoning";
}

/** A provider-executed search from an earlier response (unknown to the schema). */
function isWebSearchCallItem(item: ResponsesInputItem): boolean {
  return item.type === "web_search_call";
}

/** Hosted search declarations are typed `web_search*`; everything else is ordinary. */
export function isHostedWebSearchTool(tool: { readonly type: string }): boolean {
  return tool.type.startsWith("web_search");
}

export const WEB_SEARCH_SOURCES_INCLUDE = "web_search_call.action.sources";

/** The single declared hosted search tool, already validated by validateToolDeclarations. */
export function responsesHostedDeclaration(
  request: Pick<ResponsesRequest, "tools">,
): HostedWebSearchDeclaration | undefined {
  for (const [index, tool] of (request.tools ?? []).entries()) {
    if (!isHostedWebSearchTool(tool)) continue;
    const parsed = parseResponsesWebSearchTool(tool, `tools.${index}`);
    return parsed.ok ? parsed.declaration : undefined;
  }
  return undefined;
}

type WebSearchCallReplay = {
  readonly callId: string;
  readonly query: string;
  readonly publicState: HostedHistoryCall["publicState"];
};

function webSearchReplayKeys(
  value: Readonly<Record<string, unknown>>,
  path: string,
  allowed: ReadonlySet<string>,
): ProtocolResult<undefined> {
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    return protocolFailure(
      "web_search_replay_invalid",
      `Responses field ${path}.${key} is not supported on a replayed web_search_call`,
      `${path}.${key}`,
    );
  }
  return { ok: true, value: undefined };
}

function mapWebSearchCallItem(
  item: Readonly<Record<string, unknown>>,
  path: string,
): ProtocolResult<WebSearchCallReplay> {
  const invalid = (message: string, param = path) =>
    protocolFailure("web_search_replay_invalid", message, param);
  const keys = webSearchReplayKeys(item, path, new Set(["type", "id", "status", "action"]));
  if (!keys.ok) return keys;
  if (typeof item.id !== "string" || item.id.length === 0) {
    return invalid("web_search_call requires the id it was published with", `${path}.id`);
  }
  if (item.status !== "completed" && item.status !== "failed") {
    return invalid("Only a completed or failed web_search_call can be replayed", `${path}.status`);
  }
  const action = item.action;
  if (!isRecord(action) || action.type !== "search") {
    return invalid("web_search_call.action must be a search action", `${path}.action`);
  }
  const actionKeys = webSearchReplayKeys(
    action,
    `${path}.action`,
    new Set(["type", "query", "queries", "sources"]),
  );
  if (!actionKeys.ok) return actionKeys;
  const queries = action.queries;
  if (
    queries !== undefined &&
    (!Array.isArray(queries) || queries.length !== 1 || typeof queries[0] !== "string")
  ) {
    return invalid(
      "web_search_call.action.queries must hold its single query",
      `${path}.action.queries`,
    );
  }
  const query =
    typeof action.query === "string"
      ? action.query
      : Array.isArray(queries) && typeof queries[0] === "string"
        ? queries[0]
        : undefined;
  if (query === undefined || (Array.isArray(queries) && queries[0] !== query)) {
    return invalid("web_search_call.action requires its query", `${path}.action.query`);
  }
  let sources: { url: string; title: string }[] | undefined;
  if (action.sources !== undefined) {
    if (!Array.isArray(action.sources)) {
      return invalid("web_search_call.action.sources must be an array", `${path}.action.sources`);
    }
    sources = [];
    for (const [index, source] of action.sources.entries()) {
      const sourcePath = `${path}.action.sources.${index}`;
      if (!isRecord(source) || source.type !== "url" || typeof source.url !== "string") {
        return invalid("web_search_call source must be a url source", sourcePath);
      }
      const sourceKeys = webSearchReplayKeys(source, sourcePath, new Set(["type", "url"]));
      if (!sourceKeys.ok) return sourceKeys;
      sources.push({ url: source.url, title: "" });
    }
  }
  return {
    ok: true,
    value: {
      callId: item.id,
      query,
      publicState:
        item.status === "completed"
          ? { kind: "completed", ...(sources !== undefined ? { sources } : {}) }
          : { kind: "failed" },
    },
  };
}

function mapInputImagePart(
  part: Readonly<Record<string, unknown>>,
  path: string,
): ProtocolResult<CanonicalImagePart> {
  const keys = validateAllowedKeys(part, path, new Set(["type", "image_url", "detail"]));
  if (!keys.ok) return keys;
  if (typeof part.image_url !== "string") {
    return protocolFailure(
      "invalid_image_data",
      `Responses image ${path}.image_url must be a string`,
      `${path}.image_url`,
    );
  }
  if (
    part.detail !== undefined &&
    part.detail !== "auto" &&
    part.detail !== "low" &&
    part.detail !== "high"
  ) {
    return protocolFailure(
      "unsupported_image_detail",
      `Responses image ${path}.detail must be auto, low, or high`,
      `${path}.detail`,
    );
  }
  if (!part.image_url.startsWith("data:")) {
    return protocolFailure(
      "unsupported_image_source",
      "Responses images must use data URLs because Kiro cannot fetch remote image URLs",
      `${path}.image_url`,
    );
  }
  return {
    ok: true,
    value: {
      type: "image",
      url: part.image_url,
      ...canonicalSource(part, path, ["detail"]),
    },
  };
}

function mapContentParts(
  parts: readonly ResponsesContentPart[],
  path: string,
): ProtocolResult<readonly CanonicalContentPart[]> {
  const mapped: CanonicalContentPart[] = [];
  for (const [index, part] of parts.entries()) {
    const partPath = `${path}.${index}`;
    if (
      (part.type === "input_text" || part.type === "output_text") &&
      "text" in part &&
      typeof part.text === "string"
    ) {
      const allowed =
        part.type === "input_text"
          ? new Set(["type", "text"])
          : new Set(["type", "text", "annotations", "logprobs", "parsed"]);
      const keys = validateAllowedKeys(part, partPath, allowed);
      if (!keys.ok) return keys;
      mapped.push({
        ...textPart(part.text, `${partPath}.text`),
        ...canonicalSource(part, `${partPath}.text`, ["annotations", "logprobs", "parsed"]),
      });
      continue;
    }
    if (part.type === "input_image") {
      const image = mapInputImagePart(part, partPath);
      if (!image.ok) return image;
      mapped.push(image.value);
      continue;
    }
    if (part.type === "input_file") {
      const keys = validateAllowedKeys(
        part,
        partPath,
        new Set(["type", "file_data", "file_id", "filename"]),
      );
      if (!keys.ok) return keys;
      if ("file_id" in part && part.file_id !== undefined) {
        return protocolFailure(
          "unsupported_file_reference",
          "Responses file_id references cannot be resolved by this stateless provider; send file_data and filename",
          `${partPath}.file_id`,
        );
      }
      if (
        !("file_data" in part) ||
        typeof part.file_data !== "string" ||
        !("filename" in part) ||
        typeof part.filename !== "string"
      ) {
        return protocolFailure(
          "invalid_file_data",
          "Responses input_file requires inline file_data and filename",
          partPath,
        );
      }
      try {
        const document = resolveInlineDocument(
          part.filename,
          part.file_data,
          `${partPath}.file_data`,
          `${partPath}.filename`,
        );
        mapped.push({
          type: "document",
          name: document.name,
          format: document.format,
          data: document.data,
          path: partPath,
        });
      } catch (error) {
        if (!(error instanceof RequestTransformError)) throw error;
        return protocolFailure(error.code, error.message, error.param ?? `${partPath}.file_data`);
      }
      continue;
    }
    return protocolFailure(
      "unsupported_content_part",
      `Responses content part ${partPath} of type ${part.type} is not supported`,
      partPath,
    );
  }
  return { ok: true, value: mapped };
}

function mapMessageContent(
  content: ResponsesMessageItem["content"],
  path: string,
): ProtocolResult<readonly CanonicalContentPart[]> {
  return typeof content === "string"
    ? { ok: true, value: [textPart(content, path)] }
    : mapContentParts(content, path);
}

function mapAgentMessageContent(
  item: ResponsesAgentMessageItem,
  path: string,
): ProtocolResult<readonly CanonicalContentPart[]> {
  const visibleParts: ResponsesContentPart[] = [];
  for (const [index, part] of item.content.entries()) {
    const partPath = `${path}.content.${index}`;
    if (part.type === "encrypted_content") {
      const keys = validateAllowedKeys(part, partPath, new Set(["type", "encrypted_content"]));
      if (!keys.ok) return keys;
      continue;
    }
    visibleParts.push(part);
  }
  if (visibleParts.length === 0) {
    return protocolFailure(
      "unsupported_agent_message_content",
      "agent_message requires at least one visible content part; encrypted_content is transport metadata only",
      `${path}.content`,
    );
  }
  const mapped = mapContentParts(visibleParts, `${path}.content`);
  if (!mapped.ok) return mapped;
  return {
    ok: true,
    value: [
      textPart(
        `[agent_message author=${JSON.stringify(item.author)} recipient=${JSON.stringify(item.recipient)}]\n`,
        `${path}.author`,
      ),
      ...mapped.value,
    ],
  };
}

function outputContentParts(
  output: ResponsesFunctionCallOutputItem["output"] | ResponsesCustomToolCallOutputItem["output"],
  path: string,
): ProtocolResult<{
  readonly text: readonly CanonicalTextPart[];
  readonly images: readonly CanonicalImagePart[];
}> {
  if (typeof output === "string") {
    return { ok: true, value: { text: [textPart(output, path)], images: [] } };
  }
  const text: CanonicalTextPart[] = [];
  const images: CanonicalImagePart[] = [];
  for (const [index, part] of output.entries()) {
    const partPath = `${path}.${index}`;
    if (part.type === "input_image") {
      if (images.length > 0) {
        return protocolFailure(
          "unsupported_tool_result_content",
          `Tool output ${path} may contain at most one image block so its Kiro tool association remains unambiguous`,
          partPath,
        );
      }
      const image = mapInputImagePart(part, partPath);
      if (!image.ok) return image;
      images.push(image.value);
      continue;
    }
    if (part.type !== "input_text" && part.type !== "output_text" && part.type !== "text") {
      return protocolFailure(
        "unsupported_tool_result_content",
        `Tool output ${partPath} must be a text or inline image block`,
        partPath,
      );
    }
    if (typeof part.text !== "string") {
      return protocolFailure(
        "unsupported_tool_result_content",
        `Tool output ${partPath}.text must be a string`,
        `${partPath}.text`,
      );
    }
    const keys = validateAllowedKeys(
      part,
      partPath,
      part.type === "output_text"
        ? new Set(["type", "text", "annotations", "logprobs", "parsed"])
        : new Set(["type", "text"]),
    );
    if (!keys.ok) return keys;
    text.push({
      ...textPart(part.text, `${partPath}.text`),
      ...canonicalSource(part, `${partPath}.text`, ["annotations", "logprobs", "parsed"]),
    });
  }
  return { ok: true, value: { text, images } };
}

function validateInputItemShape(item: ResponsesInputItem, path: string): ProtocolResult<undefined> {
  if (isMessageItem(item)) return validateAllowedKeys(item, path, MESSAGE_ITEM_KEYS);
  if (isAgentMessageItem(item)) {
    return validateAllowedKeys(item, path, AGENT_MESSAGE_ITEM_KEYS);
  }
  if (isFunctionCallItem(item)) {
    return validateAllowedKeys(item, path, FUNCTION_CALL_ITEM_KEYS);
  }
  if (isCustomToolCallItem(item)) {
    return validateAllowedKeys(item, path, CUSTOM_CALL_ITEM_KEYS);
  }
  if (isFunctionCallOutputItem(item) || isCustomToolCallOutputItem(item)) {
    return validateAllowedKeys(item, path, TOOL_OUTPUT_ITEM_KEYS);
  }
  if (isAdditionalToolsItem(item)) {
    const keys = validateAllowedKeys(item, path, ADDITIONAL_TOOLS_ITEM_KEYS);
    if (!keys.ok) return keys;
    if (item.role !== undefined && item.role !== "developer") {
      return protocolFailure(
        "unsupported_additional_tools_role",
        "additional_tools.role must be developer when provided",
        `${path}.role`,
      );
    }
    return { ok: true, value: undefined };
  }
  if (isReasoningItem(item)) {
    const keys = validateAllowedKeys(item, path, REASONING_ITEM_KEYS);
    if (!keys.ok) return keys;
    for (const [index, part] of (item.summary ?? []).entries()) {
      const partPath = `${path}.summary.${index}`;
      const partKeys = validateAllowedKeys(part, partPath, new Set(["type", "text"]));
      if (!partKeys.ok) return partKeys;
    }
    for (const [index, part] of (item.content ?? []).entries()) {
      const partPath = `${path}.content.${index}`;
      const partKeys = validateAllowedKeys(part, partPath, new Set(["type", "text"]));
      if (!partKeys.ok) return partKeys;
    }
  }
  return { ok: true, value: undefined };
}

function normalizedEffort(
  effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined,
): CanonicalRequest["reasoningEffort"] | undefined {
  if (effort === "minimal") return "low";
  if (
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh" ||
    effort === "max"
  ) {
    return effort;
  }
  return undefined;
}

export function validateTextConfig(value: unknown): ProtocolResult<undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isRecord(value)) {
    return protocolFailure(
      "unsupported_parameter",
      "Responses text must request the default text format",
      "text",
    );
  }
  for (const key of Object.keys(value)) {
    if (key !== "format" && key !== "verbosity") {
      return protocolFailure(
        "unsupported_parameter",
        `Responses text.${key} is not supported`,
        `text.${key}`,
      );
    }
  }
  if (value.verbosity !== undefined) {
    if (value.verbosity !== "low" && value.verbosity !== "medium" && value.verbosity !== "high") {
      return protocolFailure(
        "invalid_request",
        "Responses text.verbosity must be low, medium, or high",
        "text.verbosity",
      );
    }
  }
  if (value.format === undefined) return { ok: true, value: undefined };
  const structuredOutput = parseLocalStructuredOutputProfile(value);
  if (structuredOutput.kind === "rejected") {
    return protocolFailure(structuredOutput.code, structuredOutput.message, structuredOutput.param);
  }
  return { ok: true, value: undefined };
}

export function validateReasoningConfig(request: ResponsesRequest): ProtocolResult<undefined> {
  const reasoning = request.reasoning;
  if (reasoning === undefined || reasoning === null) return { ok: true, value: undefined };
  for (const key of Object.keys(reasoning)) {
    if (key !== "effort" && key !== "summary" && key !== "context") {
      return protocolFailure(
        "unsupported_parameter",
        `Responses reasoning.${key} is not supported`,
        `reasoning.${key}`,
      );
    }
  }
  if (
    reasoning.summary !== undefined &&
    reasoning.summary !== null &&
    reasoning.summary !== "auto" &&
    reasoning.summary !== "concise" &&
    reasoning.summary !== "detailed" &&
    reasoning.summary !== "none"
  ) {
    return protocolFailure(
      "invalid_request",
      "reasoning.summary must be auto, concise, detailed, or none",
      "reasoning.summary",
    );
  }
  return { ok: true, value: undefined };
}

function isAssistantOutputItem(item: ResponsesInputItem): boolean {
  return (
    (isMessageItem(item) && item.role === "assistant") ||
    isFunctionCallItem(item) ||
    isCustomToolCallItem(item)
  );
}

function isTurnGroupItem(item: ResponsesInputItem): boolean {
  return isReasoningItem(item) || isAssistantOutputItem(item) || isWebSearchCallItem(item);
}

type MutableCanonicalMessage = Omit<CanonicalMessage, "content" | "toolCalls"> & {
  content: CanonicalContentPart[];
  toolCalls: CanonicalMessage["toolCalls"][number][];
};

/**
 * Splits the input into generations (maximal runs of adjacent turn-group
 * items) and returns, for every item of a run that made a hosted search, the
 * run's bounds.
 */
function hostedGenerationRuns(
  items: readonly ResponsesInputItem[],
): Map<number, { readonly start: number; readonly end: number }> {
  const runs = new Map<number, { readonly start: number; readonly end: number }>();
  let index = 0;
  while (index < items.length) {
    const start = index;
    if (!isTurnGroupItem(items[start] as ResponsesInputItem)) {
      index += 1;
      continue;
    }
    while (
      index + 1 < items.length &&
      isTurnGroupItem(items[index + 1] as ResponsesInputItem) &&
      !startsNextGeneration(items, index + 1)
    ) {
      index += 1;
    }
    const run = { start, end: index };
    if (items.slice(start, index + 1).some(isWebSearchCallItem)) {
      for (let position = start; position <= index; position += 1) runs.set(position, run);
    }
    index += 1;
  }
  return runs;
}

/** Items of one hosted search generation share the key embedded in their ids. */
const GENERATION_ITEM_ID = /^(?:ws|rs|msg|fc)_([0-9a-f]{16})[0-9a-f]{16}$/;

function generationKeyOf(item: ResponsesInputItem): string | undefined {
  const id = (item as { readonly id?: unknown }).id;
  return typeof id === "string" ? GENERATION_ITEM_ID.exec(id)?.[1] : undefined;
}

/**
 * A hosted search turn spans several generations, each one replay group with
 * its own reasoning envelope. Clients replay its items either in output order
 * or in the order the items completed, so the generation key in the item ids
 * decides the split. Without keys, reasoning or a message right after a
 * web_search_call starts the generation that read its result.
 */
function startsNextGeneration(items: readonly ResponsesInputItem[], index: number): boolean {
  const previous = items[index - 1];
  const item = items[index];
  if (previous === undefined || item === undefined) return false;
  const previousKey = generationKeyOf(previous);
  const key = generationKeyOf(item);
  if (previousKey !== undefined && key !== undefined) return previousKey !== key;
  return (
    isWebSearchCallItem(previous) &&
    (isReasoningItem(item) || (isMessageItem(item) && item.role === "assistant"))
  );
}

type ReplayGroup = {
  readonly start: number;
  readonly end: number;
  readonly firstOutputIndex: number | undefined;
};

// A reasoning item belongs to the maximal run of adjacent assistant-output items
// (reasoning, assistant messages, function/custom tool calls) around it. Every
// reasoning item in that run describes the same Kiro turn, so the run shares one
// output fingerprint and resolves to at most one replay envelope. An agent
// message is external input and ends the run, just like a user/tool input.
function replayGroupAt(items: readonly ResponsesInputItem[], reasoningIndex: number): ReplayGroup {
  let start = reasoningIndex;
  while (start > 0) {
    const previous = items[start - 1];
    if (!previous || !isTurnGroupItem(previous) || startsNextGeneration(items, start)) break;
    start -= 1;
  }
  let end = reasoningIndex;
  while (end + 1 < items.length) {
    const next = items[end + 1];
    if (!next || !isTurnGroupItem(next) || startsNextGeneration(items, end + 1)) break;
    end += 1;
  }
  let firstOutputIndex: number | undefined;
  for (let index = start; index <= end; index += 1) {
    const item = items[index];
    if (item && (isAssistantOutputItem(item) || isWebSearchCallItem(item))) {
      firstOutputIndex = index;
      break;
    }
  }
  return { start, end, firstOutputIndex };
}

function replayTokenOf(item: ResponsesReasoningItem): string | undefined {
  return typeof item.encrypted_content === "string" && isProviderReplayToken(item.encrypted_content)
    ? item.encrypted_content
    : undefined;
}

function groupHasReplayToken(items: readonly ResponsesInputItem[], group: ReplayGroup): boolean {
  for (let index = group.start; index <= group.end; index += 1) {
    const item = items[index];
    if (item && isReasoningItem(item) && replayTokenOf(item) !== undefined) return true;
  }
  return false;
}

function groupPrecedesAgentMessage(
  items: readonly ResponsesInputItem[],
  group: ReplayGroup,
): boolean {
  const next = items[group.end + 1];
  return next !== undefined && isAgentMessageItem(next);
}

function groupOutputFingerprint(
  items: readonly ResponsesInputItem[],
  group: ReplayGroup,
  reasoningIndex: number,
): ProtocolResult<{ readonly current: string; readonly legacy: string }> {
  let text = "";
  const toolCalls: Array<{ id: string; name: string; input: string }> = [];
  const hostedCalls: string[] = [];
  let outputSeen = false;
  for (let index = group.start; index <= group.end; index += 1) {
    const item = items[index];
    if (!item) continue;
    if (isWebSearchCallItem(item)) {
      const call = mapWebSearchCallItem(
        item as Readonly<Record<string, unknown>>,
        `input.${index}`,
      );
      if (!call.ok) return call;
      toolCalls.push({
        id: call.value.callId,
        name: "web_search",
        input: JSON.stringify({ query: call.value.query }),
      });
      hostedCalls.push(call.value.callId);
      outputSeen = true;
      continue;
    }
    if (isMessageItem(item)) {
      const content = mapMessageContent(item.content, `input.${index}.content`);
      if (!content.ok) return content;
      text += textFromParts(content.value);
      outputSeen = true;
      continue;
    }
    if (isFunctionCallItem(item)) {
      toolCalls.push({
        id: item.call_id,
        name: item.namespace === undefined ? item.name : `${item.namespace}.${item.name}`,
        input: item.arguments,
      });
      outputSeen = true;
      continue;
    }
    if (isCustomToolCallItem(item)) {
      toolCalls.push({
        id: item.call_id,
        name: item.namespace === undefined ? item.name : `${item.namespace}.${item.name}`,
        input: item.input,
      });
      outputSeen = true;
    }
  }
  if (!outputSeen) {
    return protocolFailure(
      "invalid_reasoning_replay",
      `Reasoning item input.${reasoningIndex} has no associated assistant output`,
      `input.${reasoningIndex}`,
    );
  }
  const output = { text, toolCalls };
  if (hostedCalls.length > 0) {
    // A generation that ran hosted searches binds its reasoning to the
    // versioned hosted-segment projection, never to an ordinary tool turn.
    const hosted = hostedSegmentFingerprint(output, hostedCalls);
    return { ok: true, value: { current: hosted, legacy: hosted } };
  }
  return {
    ok: true,
    value: {
      current: assistantOutputFingerprint(output),
      legacy: legacyAssistantOutputFingerprint(output),
    },
  };
}

export function validateToolDeclarations(request: ResponsesRequest): ProtocolResult<undefined> {
  const validateTool = (
    tool: Readonly<Record<string, unknown>> & { readonly type: string },
    path: string,
    allowInputSchema: boolean,
  ): ProtocolResult<undefined> => {
    if (tool.type === "namespace") {
      const keys = validateAllowedKeys(
        tool,
        path,
        new Set(["type", "name", "description", "tools"]),
      );
      if (!keys.ok) return keys;
      if (!Array.isArray(tool.tools)) {
        return protocolFailure(
          "invalid_tool_declaration",
          `Responses namespace ${path} requires a tools array`,
          `${path}.tools`,
        );
      }
      for (const [index, child] of tool.tools.entries()) {
        if (!isRecord(child) || typeof child.type !== "string") {
          return protocolFailure(
            "invalid_tool_declaration",
            `Responses namespace child ${path}.tools.${index} is invalid`,
            `${path}.tools.${index}`,
          );
        }
        const childResult = validateTool(
          child as Readonly<Record<string, unknown>> & { readonly type: string },
          `${path}.tools.${index}`,
          allowInputSchema,
        );
        if (!childResult.ok) return childResult;
      }
      return { ok: true, value: undefined };
    }
    if (tool.type !== "function" && tool.type !== "custom") {
      return protocolFailure(
        tool.type.startsWith("web_search") ? "unsupported_web_search" : "unsupported_tool_type",
        `Responses tool type ${tool.type} is not supported by the Kiro upstream`,
        path,
      );
    }
    if (tool.type === "function") {
      const allowed = new Set(["type", "name", "description", "parameters", "strict"]);
      if (allowInputSchema) allowed.add("inputSchema");
      const keys = validateAllowedKeys(tool, path, allowed);
      if (!keys.ok) return keys;
      if (allowInputSchema && tool.parameters !== undefined && tool.inputSchema !== undefined) {
        return protocolFailure(
          "invalid_tool_declaration",
          `Responses tool ${path} cannot specify both parameters and inputSchema`,
          path,
        );
      }
      if (tool.strict === true) {
        return protocolFailure(
          "unsupported_strict_tools",
          "strict=true cannot be guaranteed by the Kiro upstream",
          `${path}.strict`,
        );
      }
      return { ok: true, value: undefined };
    }
    const keys = validateAllowedKeys(
      tool,
      path,
      new Set(["type", "name", "description", "format"]),
    );
    if (!keys.ok) return keys;
    if (tool.format !== undefined) {
      const format = tool.format;
      if (!isRecord(format)) {
        return protocolFailure(
          "invalid_tool_declaration",
          "Custom tool format must be an object",
          `${path}.format`,
        );
      }
      const formatKeys = validateAllowedKeys(
        format,
        `${path}.format`,
        new Set(["type", "syntax", "definition"]),
      );
      if (!formatKeys.ok) return formatKeys;
      if (format.type === "text" && Object.keys(format).length === 1)
        return { ok: true, value: undefined };
      if (
        format.type !== "grammar" ||
        typeof format.syntax !== "string" ||
        format.syntax.length === 0 ||
        typeof format.definition !== "string"
      ) {
        return protocolFailure(
          "invalid_tool_declaration",
          "Custom tool format must contain a grammar syntax and definition",
          `${path}.format`,
        );
      }
    }
    return { ok: true, value: undefined };
  };

  let hostedPath: string | undefined;
  for (const [index, tool] of (request.tools ?? []).entries()) {
    if (isHostedWebSearchTool(tool)) {
      const parsed = parseResponsesWebSearchTool(tool, `tools.${index}`);
      if (!parsed.ok) return protocolFailure(parsed.code, parsed.message, parsed.param);
      if (hostedPath !== undefined) {
        return protocolFailure(
          "invalid_web_search_declaration",
          `Only one web_search tool may be declared; ${hostedPath} already declares it`,
          `tools.${index}`,
        );
      }
      hostedPath = `tools.${index}`;
      continue;
    }
    const result = validateTool(tool, `tools.${index}`, false);
    if (!result.ok) return result;
  }
  if (typeof request.input !== "string") {
    for (const [inputIndex, item] of request.input.entries()) {
      if (!isAdditionalToolsItem(item)) continue;
      for (const [toolIndex, tool] of item.tools.entries()) {
        const result = validateTool(tool, `input.${inputIndex}.tools.${toolIndex}`, true);
        if (!result.ok) return result;
      }
    }
  }
  return { ok: true, value: undefined };
}

export function adaptResponsesRequest(
  request: ResponsesRequest,
  projectionMode: ProtocolProjectionMode = "safe",
  previous?: ResponsesPreviousContext,
): ResponsesRequestAdaptationResult {
  if (previous?.input?.length) {
    request = {
      ...request,
      input: [
        ...previous.input,
        ...(typeof request.input === "string"
          ? [{ role: "user" as const, content: request.input }]
          : request.input),
      ],
    };
  }
  for (const key of Object.keys(request)) {
    if (!RESPONSES_REQUEST_KEYS.has(key)) {
      return protocolFailure(
        "unsupported_parameter",
        `Responses parameter ${key} is not supported`,
        key,
      );
    }
  }
  for (const field of UNSUPPORTED_RESPONSES_FIELDS) {
    if (request[field] !== undefined) {
      return protocolFailure(
        "unsupported_parameter",
        `Responses parameter ${field} cannot be represented by the Kiro upstream`,
        field,
      );
    }
  }
  if (request.stream_options !== undefined) {
    const unknownStreamOption = Object.keys(request.stream_options).find(
      (key) => key !== "include_obfuscation",
    );
    if (unknownStreamOption !== undefined) {
      return protocolFailure(
        "unsupported_parameter",
        `Responses parameter stream_options.${unknownStreamOption} is not supported`,
        `stream_options.${unknownStreamOption}`,
      );
    }
    if (request.stream_options.include_obfuscation === true) {
      return protocolFailure(
        "unsupported_parameter",
        "Responses stream obfuscation cannot be represented by the Kiro upstream",
        "stream_options.include_obfuscation",
      );
    }
    if (request.stream !== true) {
      return protocolFailure(
        "unsupported_parameter",
        "Responses stream_options is valid only when stream=true",
        "stream_options",
      );
    }
  }
  if (request.background === true) {
    return protocolFailure(
      "unsupported_parameter",
      "Responses background execution is not supported",
      "background",
    );
  }
  if (
    request.truncation !== undefined &&
    request.truncation !== null &&
    request.truncation !== "disabled"
  ) {
    return protocolFailure(
      "unsupported_parameter",
      "Responses truncation=auto cannot be represented without changing input history",
      "truncation",
    );
  }
  if (request.top_logprobs !== undefined && request.top_logprobs !== 0) {
    return protocolFailure(
      "unsupported_parameter",
      "Kiro does not expose token log probabilities",
      "top_logprobs",
    );
  }
  if (
    request.service_tier !== undefined &&
    request.service_tier !== null &&
    request.service_tier !== "auto" &&
    request.service_tier !== "default"
  ) {
    return protocolFailure(
      "unsupported_parameter",
      `Responses service_tier=${request.service_tier} is not available through Kiro`,
      "service_tier",
    );
  }
  if (request.conversation !== undefined) {
    return protocolFailure(
      "unsupported_stateful_responses",
      "Conversation objects are not supported; use previous_response_id or resend complete input",
      "conversation",
    );
  }
  if (
    request.tool_choice === "required" ||
    (typeof request.tool_choice === "object" && request.tool_choice !== null)
  ) {
    return protocolFailure(
      "unsupported_tool_choice",
      "Required, named, or constrained tool choice cannot be represented by the Kiro upstream",
      "tool_choice",
    );
  }
  const include = request.include ?? [];
  const unsupportedInclude = include.find(
    (value) => value !== "reasoning.encrypted_content" && value !== WEB_SEARCH_SOURCES_INCLUDE,
  );
  if (unsupportedInclude !== undefined) {
    return protocolFailure(
      "unsupported_parameter",
      `Responses include value ${unsupportedInclude} is not supported`,
      "include",
    );
  }
  const textConfig = validateTextConfig(request.text);
  if (!textConfig.ok) return textConfig;
  const reasoningConfig = validateReasoningConfig(request);
  if (!reasoningConfig.ok) return reasoningConfig;
  if (request.max_output_tokens !== undefined) {
    const outputLimit = resolveOutputTokenLimit(request.model, request.max_output_tokens);
    if (!outputLimit.ok) {
      return protocolFailure(outputLimit.code, outputLimit.message, "max_output_tokens");
    }
  }
  const toolValidation = validateToolDeclarations(request);
  if (!toolValidation.ok) return toolValidation;

  const hostedWebSearch = responsesHostedDeclaration(request);
  const hostedHistoryPresent =
    typeof request.input !== "string" && request.input.some(isWebSearchCallItem);
  const reprojectLogicalHistory = previous?.legacyRequest === undefined;
  const bridgeResult = createResponsesToolBridge(request, previous?.items, {
    // The hosted search keeps the backend's wire name; a client function that
    // shares it travels under a private alias.
    ...(hostedWebSearch !== undefined || hostedHistoryPresent
      ? { reservedWireNames: ["web_search"] }
      : {}),
    // Stateless execution reprojects the complete logical history. Private
    // aliases can therefore be rebuilt from public identities; old declarations
    // are not needed and must not become authorization for new calls.
    // Legacy canonical snapshots already contain wire names; retain their
    // existing binding requirement instead of re-aliasing a partial history.
    stableAliases: reprojectLogicalHistory,
    allowHistoricalWithoutDeclarations: true,
    requireHistoricalBindings: !reprojectLogicalHistory,
    bindings: previous?.toolBindings,
  });
  if (!bridgeResult.ok) return bridgeResult;
  const bridge = bridgeResult.bridge;
  const tools: CanonicalToolDeclaration[] = bridge.declarations.map((tool) => ({
    publicType: tool.publicType,
    name: tool.publicName,
    wireName: tool.wireName,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    descriptionPath: `${tool.path}.description`,
    inputSchema: tool.parameters,
    path: tool.path,
    origin: tool.origin,
    ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    ...(tool.sourceMetadata !== undefined ? { sourceMetadata: tool.sourceMetadata } : {}),
  }));

  const previousMessages: CanonicalMessage[] = (previous?.messages ?? []).map((message) => ({
    ...message,
    content: message.content.map((part) =>
      part.type === "tool_result"
        ? { ...part, content: part.content.map((content) => ({ ...content })) }
        : { ...part },
    ),
    toolCalls: message.toolCalls.map((call) => ({ ...call })),
  }));
  const messages: CanonicalMessage[] = [];
  const reasoningReplays: CanonicalRequest["reasoningReplays"][number][] = [];
  const instructions =
    request.instructions !== undefined ? textPart(request.instructions, "instructions") : undefined;
  if (request.instructions !== undefined && request.instructions.length > 0) {
    if (projectionMode === "safe") {
      return protocolFailure(
        "unsupported_instruction_projection",
        "Responses instructions cannot be projected losslessly to Kiro; use legacy-user-prefix explicitly to migrate",
        "instructions",
      );
    }
    messages.push({
      role: "developer",
      content: [textPart(request.instructions, "instructions")],
      toolCalls: [],
      path: "instructions",
    });
  }
  messages.push(...previousMessages);

  let executableInputSeen = false;
  const canonicalIndexByInput = new Map<number, number>();
  // A replayed hosted call is followed by a placeholder result once its tool
  // group ends; restoration fills it from the authenticated snapshot.
  const hostedCalls: HostedHistoryCall[] = [];
  let groupHosted: Array<
    WebSearchCallReplay & { readonly path: string; readonly assistantMessage: number }
  > = [];
  // One hosted search generation projects as the assistant turn and the result
  // turn the execution loop sent Kiro: its text, hosted and client calls in one
  // message, then every result of the group in one message. Restoration puts
  // both back in wire order.
  const hostedRuns =
    typeof request.input === "string" ? new Map() : hostedGenerationRuns(request.input);
  let hostedTurn:
    | {
        readonly end: number;
        message?: { readonly index: number; readonly value: MutableCanonicalMessage };
        readonly clients: string[];
      }
    | undefined;
  let awaitingOutputs:
    | { readonly value: MutableCanonicalMessage; readonly calls: Set<string>; images: number }
    | undefined;
  const flushHosted = (path: string): MutableCanonicalMessage | undefined => {
    if (groupHosted.length === 0) return undefined;
    const messageIndex = messages.length;
    const message: MutableCanonicalMessage = {
      role: "tool",
      content: groupHosted.map((call) => ({
        type: "tool_result" as const,
        toolCallId: call.callId,
        content: [],
        isError: false,
        path: call.path,
        sourceMetadata: { [HOSTED_CALL_METADATA]: true },
      })),
      toolCalls: [],
      path,
    };
    messages.push(message);
    for (const [part, call] of groupHosted.entries()) {
      hostedCalls.push({
        callId: call.callId,
        query: call.query,
        assistantMessage: call.assistantMessage,
        result: { message: messageIndex, part },
        publicState: call.publicState,
        path: call.path,
      });
    }
    groupHosted = [];
    return message;
  };
  const endHostedTurn = (path: string): void => {
    if (hostedTurn === undefined) return;
    const results = flushHosted(path);
    if (results !== undefined && hostedTurn.clients.length > 0) {
      awaitingOutputs = { value: results, calls: new Set(hostedTurn.clients), images: 0 };
    }
    hostedTurn = undefined;
  };
  const turnMessage = (
    path: string,
  ): { readonly index: number; readonly value: MutableCanonicalMessage } => {
    if (hostedTurn === undefined) throw new TypeError("Hosted generation turn is not open");
    if (hostedTurn.message === undefined) {
      const value: MutableCanonicalMessage = {
        role: "assistant",
        content: [],
        toolCalls: [],
        path,
      };
      hostedTurn.message = { index: messages.length, value };
      messages.push(value);
    }
    return hostedTurn.message;
  };
  const missingOutputs = (calls: ReadonlySet<string>, path: string) =>
    protocolFailure(
      "invalid_tool_history",
      `No tool output found for function call ${[...calls].join(", ")}`,
      path,
    );
  const replayByGroup = new Map<number, { readonly token: string; readonly path: string }>();
  if (typeof request.input === "string") {
    messages.push({
      role: "user",
      content: [textPart(request.input, "input")],
      toolCalls: [],
      path: "input",
    });
    executableInputSeen = true;
  } else {
    for (const [index, item] of request.input.entries()) {
      const path = `input.${index}`;
      if (hostedTurn !== undefined && index > hostedTurn.end) endHostedTurn(path);
      if (awaitingOutputs !== undefined) {
        // A group's client calls are answered before anything else continues it.
        if (
          !(isFunctionCallOutputItem(item) || isCustomToolCallOutputItem(item)) ||
          !awaitingOutputs.calls.has(item.call_id)
        ) {
          return missingOutputs(awaitingOutputs.calls, path);
        }
        const shape = validateInputItemShape(item, path);
        if (!shape.ok) return shape;
        const content = outputContentParts(item.output, `${path}.output`);
        if (!content.ok) return content;
        if (content.value.images.length > 0 && ++awaitingOutputs.images > 1) {
          return protocolFailure(
            "unsupported_tool_result_content",
            "A hosted search tool group may return at most one image-bearing tool output so the lifted image keeps its Kiro tool association",
            `${path}.output`,
          );
        }
        awaitingOutputs.value.content.push(
          {
            type: "tool_result",
            toolCallId: item.call_id,
            content: content.value.text,
            isError: false,
            ...canonicalSource(item, path),
          },
          ...content.value.images,
        );
        awaitingOutputs.calls.delete(item.call_id);
        if (awaitingOutputs.calls.size === 0) awaitingOutputs = undefined;
        executableInputSeen = true;
        continue;
      }
      const run = hostedRuns.get(index);
      if (run !== undefined && hostedTurn === undefined) {
        hostedTurn = { end: run.end, clients: [] };
      }
      if (isWebSearchCallItem(item)) {
        const call = mapWebSearchCallItem(item as Readonly<Record<string, unknown>>, path);
        if (!call.ok) return call;
        const turn = turnMessage(path);
        canonicalIndexByInput.set(index, turn.index);
        groupHosted.push({ ...call.value, path, assistantMessage: turn.index });
        turn.value.toolCalls.push({
          id: call.value.callId,
          name: "web_search",
          input: { query: call.value.query },
          path,
          sourceMetadata: { [HOSTED_CALL_METADATA]: true },
        });
        continue;
      }
      const shape = validateInputItemShape(item, path);
      if (!shape.ok) return shape;
      if (isReasoningItem(item)) {
        const hasSummary =
          item.summary !== undefined && item.summary !== null && item.summary.length > 0;
        const hasContent =
          item.content !== undefined && item.content !== null && item.content.length > 0;
        const group = replayGroupAt(request.input, index);
        // Codex collaboration transports a child response as agent_message and
        // may place that child's encrypted reasoning item immediately before it.
        // The child message becomes external input in the parent conversation,
        // so replaying the child's private reasoning as a parent assistant turn
        // would cross conversation/account boundaries. Keep it non-model-visible.
        if (
          group.firstOutputIndex === undefined &&
          groupPrecedesAgentMessage(request.input, group)
        ) {
          continue;
        }
        if (item.encrypted_content === undefined || item.encrypted_content === null) {
          // The provider attaches the replay token to one reasoning item per
          // turn; the turn's other reasoning items are output metadata only.
          if (groupHasReplayToken(request.input, group)) continue;
          if (hasSummary || hasContent) {
            return protocolFailure(
              "unsupported_reasoning_plaintext_replay",
              "Reasoning replay requires encrypted_content; summary/content are output metadata only",
              path,
            );
          }
          return protocolFailure(
            "invalid_reasoning_replay",
            "Reasoning replay requires a kiro-provider encrypted_content replay token",
            `${path}.encrypted_content`,
          );
        }
        if (
          typeof item.encrypted_content !== "string" ||
          !isProviderReplayToken(item.encrypted_content)
        ) {
          return protocolFailure(
            "invalid_reasoning_replay",
            "Reasoning replay requires a kiro-provider encrypted_content replay token",
            `${path}.encrypted_content`,
          );
        }
        const existingReplay = replayByGroup.get(group.start);
        if (existingReplay !== undefined) {
          if (existingReplay.token === item.encrypted_content) continue;
          return protocolFailure(
            "invalid_reasoning_replay",
            `Reasoning item ${path} carries a different replay token than ${existingReplay.path} for the same assistant turn`,
            `${path}.encrypted_content`,
          );
        }
        const fingerprint = groupOutputFingerprint(request.input, group, index);
        if (!fingerprint.ok) return fingerprint;
        const insertBeforeMessage =
          group.firstOutputIndex !== undefined && group.firstOutputIndex < index
            ? canonicalIndexByInput.get(group.firstOutputIndex)
            : messages.length;
        if (insertBeforeMessage === undefined) {
          throw new TypeError(`Assistant output for reasoning item ${path} was not projected`);
        }
        reasoningReplays.push({
          lookup: {
            kind: "responses-token",
            encryptedContent: item.encrypted_content,
          },
          outputFingerprint: fingerprint.value.current,
          ...(isLegacyReplayToken(item.encrypted_content) &&
          fingerprint.value.legacy !== fingerprint.value.current
            ? { compatibleOutputFingerprints: [fingerprint.value.legacy] }
            : {}),
          insertBeforeMessage,
          ...canonicalSource(item, path),
        });
        replayByGroup.set(group.start, { token: item.encrypted_content, path });
        continue;
      }
      if (isFunctionCallItem(item) || isCustomToolCallItem(item)) {
        const lowered = bridge.lowerCall(item);
        let input: unknown;
        try {
          input = JSON.parse(lowered.function.arguments);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          return protocolFailure(
            "invalid_tool_history",
            `Tool call ${item.call_id} contains invalid JSON arguments`,
            path,
          );
        }
        const toolCall = {
          id: item.call_id,
          name: lowered.function.name,
          input,
          ...canonicalSource(item, path),
        };
        executableInputSeen = true;
        if (run !== undefined) {
          const turn = turnMessage(path);
          canonicalIndexByInput.set(index, turn.index);
          turn.value.toolCalls.push(toolCall);
          hostedTurn?.clients.push(item.call_id);
          continue;
        }
        canonicalIndexByInput.set(index, messages.length);
        messages.push({
          role: "assistant",
          content: [],
          toolCalls: [toolCall],
          ...canonicalSource(item, path),
        });
        continue;
      }
      if (isMessageItem(item)) {
        if (projectionMode === "safe" && (item.role === "system" || item.role === "developer")) {
          return protocolFailure(
            "unsupported_instruction_projection",
            `${item.role} input cannot be projected losslessly to Kiro; use legacy-user-prefix explicitly to migrate`,
            path,
          );
        }
        const content = mapMessageContent(item.content, `${path}.content`);
        if (!content.ok) return content;
        executableInputSeen = true;
        if (run !== undefined) {
          const turn = turnMessage(path);
          canonicalIndexByInput.set(index, turn.index);
          turn.value.content.push(...content.value);
          continue;
        }
        canonicalIndexByInput.set(index, messages.length);
        messages.push({
          role: item.role,
          content: content.value,
          toolCalls: [],
          ...canonicalSource(item, path, ["phase"]),
        });
        executableInputSeen = true;
        continue;
      }
      if (isAgentMessageItem(item)) {
        const content = mapAgentMessageContent(item, path);
        if (!content.ok) return content;
        messages.push({
          role: "user",
          content: content.value,
          toolCalls: [],
          ...canonicalSource(item, path, ["author", "recipient"]),
        });
        executableInputSeen = true;
        continue;
      }
      if (isFunctionCallOutputItem(item) || isCustomToolCallOutputItem(item)) {
        const content = outputContentParts(item.output, `${path}.output`);
        if (!content.ok) return content;
        messages.push({
          role: "tool",
          content: [
            {
              type: "tool_result",
              toolCallId: item.call_id,
              content: content.value.text,
              isError: false,
              ...canonicalSource(item, path),
            },
            // Kiro tool results carry text only. Lift one image-bearing result
            // into the same user turn so the bytes remain model-visible while
            // the adjacent empty/text result preserves its tool association.
            ...content.value.images,
          ],
          toolCalls: [],
          ...canonicalSource(item, path),
        });
        executableInputSeen = true;
        continue;
      }
      if (isAdditionalToolsItem(item)) continue;
      return protocolFailure(
        "unsupported_input_item",
        `Responses input item ${path} of type ${item.type} is not supported`,
        path,
      );
    }
    endHostedTurn("input");
    if (awaitingOutputs !== undefined) return missingOutputs(awaitingOutputs.calls, "input");
  }
  if (!executableInputSeen) {
    return protocolFailure("empty_input", "input produced no executable messages", "input");
  }

  const unresolvedCalls = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls) unresolvedCalls.add(call.id);
    for (const part of message.content) {
      if (part.type === "tool_result") unresolvedCalls.delete(part.toolCallId);
    }
  }
  if (request.tool_choice === "none" && unresolvedCalls.size > 0) {
    return protocolFailure(
      "unsupported_tool_choice",
      "tool_choice=none cannot be used while tool calls are awaiting results",
      "tool_choice",
    );
  }

  const effort = normalizedEffort(request.reasoning?.effort);
  return {
    ok: true,
    body: {
      canonicalVersion: 1,
      protocol: "responses",
      projectionMode,
      model: request.model,
      stream: request.stream,
      messages,
      tools,
      toolChoice: request.tool_choice === "none" ? "none" : "auto",
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
      ...(request.reasoning?.effort === "none" ? { thinking: { enabled: false } } : {}),
      ...(request.reasoning?.effort !== undefined
        ? { requestedReasoningEffort: request.reasoning.effort }
        : {}),
      ...(request.max_output_tokens !== undefined
        ? { outputTokenLimit: request.max_output_tokens }
        : {}),
      ...(instructions !== undefined ? { instructions } : {}),
      reasoningReplays,
      includeEncryptedReasoning:
        include.includes("reasoning.encrypted_content") || request.store === false,
      parallelToolCalls:
        request.parallel_tool_calls !== false ||
        (request.tool_choice !== "none" && tools.length > 0),
      ...(request.prompt_cache_key !== undefined
        ? { promptCacheKey: request.prompt_cache_key }
        : {}),
      ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
      store: request.store !== false,
      ...(request.previous_response_id !== undefined
        ? { previousResponseId: request.previous_response_id }
        : {}),
      ...(request.service_tier === "auto" || request.service_tier === "default"
        ? { serviceTier: request.service_tier }
        : {}),
      ...(request.user !== undefined ? { user: request.user } : {}),
    },
    bridge,
    ...(hostedWebSearch !== undefined ? { hostedWebSearch } : {}),
    hostedHistory: { calls: hostedCalls, citations: [] },
  };
}
