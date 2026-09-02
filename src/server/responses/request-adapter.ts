import { resolveOutputTokenLimit } from "../../kiro/output-token-limit.js";
import { resolveInlineDocument } from "../../kiro/transform/document-handler.js";
import { RequestTransformError } from "../../kiro/transform/errors.js";
import { isRecord, textPart } from "../../protocol/adapter-utils.js";
import {
  assistantOutputFingerprint,
  type CanonicalContentPart,
  type CanonicalMessage,
  type CanonicalRequest,
  type CanonicalTextPart,
  type CanonicalToolDeclaration,
  type ProtocolProjectionMode,
  textFromParts,
} from "../../protocol/canonical.js";
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
import {
  createResponsesToolBridge,
  type ResponsesToolBridge,
} from "./tool-bridge.js";

export type ResponsesRequestAdaptationResult =
  | {
      readonly ok: true;
      readonly body: CanonicalRequest;
      readonly bridge: ResponsesToolBridge;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly param?: string;
    };

const RESPONSES_REQUEST_KEYS = new Set([
  "model",
  "input",
  "instructions",
  "stream",
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
]);

const UNSUPPORTED_RESPONSES_FIELDS = [
  "temperature",
  "top_p",
  "truncation",
  "background",
  "max_tool_calls",
  "service_tier",
] as const;

const MESSAGE_ITEM_KEYS = new Set(["type", "id", "status", "role", "content"]);
const FUNCTION_CALL_ITEM_KEYS = new Set([
  "type",
  "id",
  "status",
  "call_id",
  "namespace",
  "name",
  "arguments",
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
const ADDITIONAL_TOOLS_ITEM_KEYS = new Set(["type", "role", "tools"]);
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
    metadataKeys
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
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

function isAdditionalToolsItem(
  item: ResponsesInputItem,
): item is ResponsesAdditionalToolsItem {
  return item.type === "additional_tools";
}

function isReasoningItem(item: ResponsesInputItem): item is ResponsesReasoningItem {
  return item.type === "reasoning";
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
          : new Set(["type", "text", "annotations", "logprobs"]);
      const keys = validateAllowedKeys(part, partPath, allowed);
      if (!keys.ok) return keys;
      mapped.push({
        ...textPart(part.text, `${partPath}.text`),
        ...canonicalSource(part, `${partPath}.text`, ["annotations", "logprobs"]),
      });
      continue;
    }
    if (
      part.type === "input_image" &&
      "image_url" in part &&
      typeof part.image_url === "string"
    ) {
      const keys = validateAllowedKeys(part, partPath, new Set(["type", "image_url"]));
      if (!keys.ok) return keys;
      if (!part.image_url.startsWith("data:")) {
        return protocolFailure(
          "unsupported_image_source",
          "Responses images must use data URLs because Kiro cannot fetch remote image URLs",
          `${partPath}.image_url`,
        );
      }
      mapped.push({ type: "image", url: part.image_url, path: partPath });
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
        return protocolFailure(
          error.code,
          error.message,
          error.param ?? `${partPath}.file_data`,
        );
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

function outputTextParts(
  output: ResponsesFunctionCallOutputItem["output"] | ResponsesCustomToolCallOutputItem["output"],
  path: string,
): ProtocolResult<readonly CanonicalTextPart[]> {
  if (typeof output === "string") return { ok: true, value: [textPart(output, path)] };
  const parts: CanonicalTextPart[] = [];
  for (const [index, part] of output.entries()) {
    const partPath = `${path}.${index}`;
    if (
      (part.type !== "input_text" && part.type !== "output_text" && part.type !== "text") ||
      typeof part.text !== "string"
    ) {
      return protocolFailure(
        "unsupported_tool_result_content",
        `Tool output ${partPath} must be a text block`,
        partPath,
      );
    }
    const keys = validateAllowedKeys(
      part,
      partPath,
      part.type === "output_text"
        ? new Set(["type", "text", "annotations", "logprobs"])
        : new Set(["type", "text"]),
    );
    if (!keys.ok) return keys;
    parts.push({
      ...textPart(part.text, `${partPath}.text`),
      ...canonicalSource(part, `${partPath}.text`, ["annotations", "logprobs"]),
    });
  }
  return { ok: true, value: parts };
}

function validateInputItemShape(
  item: ResponsesInputItem,
  path: string,
): ProtocolResult<undefined> {
  if (isMessageItem(item)) return validateAllowedKeys(item, path, MESSAGE_ITEM_KEYS);
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
      const partKeys = validateAllowedKeys(
        part,
        partPath,
        new Set(["type", "reasoning_text"]),
      );
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

function validateTextConfig(value: unknown): ProtocolResult<undefined> {
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
    return protocolFailure(
      "unsupported_parameter",
      "Responses text.verbosity cannot be represented by the Kiro upstream",
      "text.verbosity",
    );
  }
  if (value.format === undefined) return { ok: true, value: undefined };
  const format = value.format;
  if (isRecord(format) && format.type === "text" && Object.keys(format).length === 1) {
    return { ok: true, value: undefined };
  }
  return protocolFailure(
    "unsupported_structured_output",
    "Structured Responses text output cannot be represented by the Kiro upstream",
    "text.format",
  );
}

function validateReasoningConfig(request: ResponsesRequest): ProtocolResult<undefined> {
  const reasoning = request.reasoning;
  if (reasoning === undefined || reasoning === null) return { ok: true, value: undefined };
  for (const key of Object.keys(reasoning)) {
    if (key !== "effort" && key !== "summary") {
      return protocolFailure(
        "unsupported_parameter",
        `Responses reasoning.${key} is not supported`,
        `reasoning.${key}`,
      );
    }
  }
  if (reasoning.summary !== undefined) {
    return protocolFailure(
      "unsupported_reasoning_summary",
      "reasoning.summary cannot be guaranteed by the Kiro upstream",
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
  return isReasoningItem(item) || isAssistantOutputItem(item);
}

type ReplayGroup = {
  readonly start: number;
  readonly end: number;
  readonly firstOutputIndex: number | undefined;
};

// A reasoning item belongs to the maximal run of adjacent assistant-output items
// (reasoning, assistant messages, function/custom tool calls) around it. Every
// reasoning item in that run describes the same Kiro turn, so the run shares one
// output fingerprint and resolves to at most one replay envelope.
function replayGroupAt(
  items: readonly ResponsesInputItem[],
  reasoningIndex: number,
): ReplayGroup {
  let start = reasoningIndex;
  while (start > 0) {
    const previous = items[start - 1];
    if (!previous || !isTurnGroupItem(previous)) break;
    start -= 1;
  }
  let end = reasoningIndex;
  while (end + 1 < items.length) {
    const next = items[end + 1];
    if (!next || !isTurnGroupItem(next)) break;
    end += 1;
  }
  let firstOutputIndex: number | undefined;
  for (let index = start; index <= end; index += 1) {
    const item = items[index];
    if (item && isAssistantOutputItem(item)) {
      firstOutputIndex = index;
      break;
    }
  }
  return { start, end, firstOutputIndex };
}

function replayTokenOf(item: ResponsesReasoningItem): string | undefined {
  return typeof item.encrypted_content === "string" && item.encrypted_content.startsWith("kr1_")
    ? item.encrypted_content
    : undefined;
}

function groupHasReplayToken(
  items: readonly ResponsesInputItem[],
  group: ReplayGroup,
): boolean {
  for (let index = group.start; index <= group.end; index += 1) {
    const item = items[index];
    if (item && isReasoningItem(item) && replayTokenOf(item) !== undefined) return true;
  }
  return false;
}

function groupOutputFingerprint(
  items: readonly ResponsesInputItem[],
  group: ReplayGroup,
  reasoningIndex: number,
): ProtocolResult<string> {
  let text = "";
  const toolCalls: Array<{ id: string; name: string; input: string }> = [];
  let outputSeen = false;
  for (let index = group.start; index <= group.end; index += 1) {
    const item = items[index];
    if (!item) continue;
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
  return { ok: true, value: assistantOutputFingerprint({ text, toolCalls }) };
}

function validateToolDeclarations(request: ResponsesRequest): ProtocolResult<undefined> {
  const validateTool = (
    tool: Readonly<Record<string, unknown>> & { readonly type: string },
    path: string,
    allowInputSchema: boolean,
  ): ProtocolResult<undefined> => {
    if (tool.type === "namespace") {
      return protocolFailure(
        "unsupported_tool_type",
        "Responses namespace tools cannot be represented without changing tool identity",
        path,
      );
    }
    if (tool.type !== "function" && tool.type !== "custom") {
      return protocolFailure(
        tool.type.startsWith("web_search")
          ? "unsupported_web_search"
          : "unsupported_tool_type",
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
      return protocolFailure(
        "unsupported_custom_tool_format",
        "Custom tool grammar cannot be enforced by the Kiro upstream",
        `${path}.format`,
      );
    }
    return { ok: true, value: undefined };
  };

  for (const [index, tool] of (request.tools ?? []).entries()) {
    const result = validateTool(tool, `tools.${index}`, false);
    if (!result.ok) return result;
  }
  if (typeof request.input !== "string") {
    for (const [inputIndex, item] of request.input.entries()) {
      if (!isAdditionalToolsItem(item)) continue;
      for (const [toolIndex, tool] of item.tools.entries()) {
        const result = validateTool(
          tool,
          `input.${inputIndex}.tools.${toolIndex}`,
          true,
        );
        if (!result.ok) return result;
      }
    }
  }
  return { ok: true, value: undefined };
}

export function adaptResponsesRequest(
  request: ResponsesRequest,
  projectionMode: ProtocolProjectionMode = "safe",
): ResponsesRequestAdaptationResult {
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
  if (request.previous_response_id !== undefined || request.conversation !== undefined) {
    return protocolFailure(
      "unsupported_stateful_responses",
      "Stateful Responses continuation is not supported; resend the complete input",
      request.previous_response_id !== undefined ? "previous_response_id" : "conversation",
    );
  }
  if (request.store === true) {
    return protocolFailure(
      "unsupported_parameter",
      "Responses store=true is not supported",
      "store",
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
  const unsupportedInclude = include.find((value) => value !== "reasoning.encrypted_content");
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
    const outputLimit = resolveOutputTokenLimit(
      request.model,
      request.max_output_tokens,
    );
    if (!outputLimit.ok) {
      return protocolFailure(
        outputLimit.code,
        outputLimit.message,
        "max_output_tokens",
      );
    }
  }
  const toolValidation = validateToolDeclarations(request);
  if (!toolValidation.ok) return toolValidation;

  const bridgeResult = createResponsesToolBridge(request);
  if (!bridgeResult.ok) return bridgeResult;
  const bridge = bridgeResult.bridge;
  const tools: CanonicalToolDeclaration[] = bridge.declarations.map((tool) => ({
    publicType: tool.publicType,
    name: tool.publicName,
    wireName: tool.wireName,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    inputSchema: tool.parameters,
    path: tool.path,
    origin: tool.origin,
    ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    ...(tool.sourceMetadata !== undefined ? { sourceMetadata: tool.sourceMetadata } : {}),
  }));

  const messages: CanonicalMessage[] = [];
  const reasoningReplays: CanonicalRequest["reasoningReplays"][number][] = [];
  if (
    request.parallel_tool_calls === false &&
    request.tool_choice !== "none" &&
    tools.length > 0
  ) {
    return protocolFailure(
      "unsupported_parallel_tool_calls",
      "parallel_tool_calls=false cannot be guaranteed by the Kiro upstream",
      "parallel_tool_calls",
    );
  }
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

  let executableInputSeen = false;
  const canonicalIndexByInput = new Map<number, number>();
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
      const shape = validateInputItemShape(item, path);
      if (!shape.ok) return shape;
      if (isReasoningItem(item)) {
        const hasSummary = item.summary !== undefined && item.summary !== null && item.summary.length > 0;
        const hasContent = item.content !== undefined && item.content !== null && item.content.length > 0;
        const group = replayGroupAt(request.input, index);
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
            "Reasoning replay requires a kiro-provider kr1_ encrypted_content token",
            `${path}.encrypted_content`,
          );
        }
        if (
          typeof item.encrypted_content !== "string" ||
          !item.encrypted_content.startsWith("kr1_")
        ) {
          return protocolFailure(
            "invalid_reasoning_replay",
            "Reasoning replay requires a kiro-provider kr1_ encrypted_content token",
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
          outputFingerprint: fingerprint.value,
          insertBeforeMessage,
          ...canonicalSource(item, path),
        });
        replayByGroup.set(group.start, { token: item.encrypted_content, path });
        continue;
      }
      if (isFunctionCallItem(item) || isCustomToolCallItem(item)) {
        if (item.namespace !== undefined) {
          return protocolFailure(
            "unsupported_tool_namespace",
            "Namespaced tool calls cannot be represented without changing tool identity",
            `${path}.namespace`,
          );
        }
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
        canonicalIndexByInput.set(index, messages.length);
        messages.push({
          role: "assistant",
          content: [],
          toolCalls: [
            {
              id: item.call_id,
              name: lowered.function.name,
              input,
              ...canonicalSource(item, path),
            },
          ],
          ...canonicalSource(item, path),
        });
        executableInputSeen = true;
        continue;
      }
      if (isMessageItem(item)) {
        if (
          projectionMode === "safe" &&
          (item.role === "system" || item.role === "developer")
        ) {
          return protocolFailure(
            "unsupported_instruction_projection",
            `${item.role} input cannot be projected losslessly to Kiro; use legacy-user-prefix explicitly to migrate`,
            path,
          );
        }
        const content = mapMessageContent(item.content, `${path}.content`);
        if (!content.ok) return content;
        canonicalIndexByInput.set(index, messages.length);
        messages.push({
          role: item.role,
          content: content.value,
          toolCalls: [],
          ...canonicalSource(item, path),
        });
        executableInputSeen = true;
        continue;
      }
      if (isAgentMessageItem(item)) {
        return protocolFailure(
          "unsupported_input_item",
          "agent_message author/recipient semantics cannot be represented by the Kiro upstream",
          path,
        );
      }
      if (isFunctionCallOutputItem(item) || isCustomToolCallOutputItem(item)) {
        const content = outputTextParts(item.output, `${path}.output`);
        if (!content.ok) return content;
        messages.push({
          role: "tool",
          content: [
            {
              type: "tool_result",
              toolCallId: item.call_id,
              content: content.value,
              isError: false,
              ...canonicalSource(item, path),
            },
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
      ...(request.reasoning?.effort !== undefined
        ? { requestedReasoningEffort: request.reasoning.effort }
        : {}),
      ...(request.max_output_tokens !== undefined
        ? { outputTokenLimit: request.max_output_tokens }
        : {}),
      ...(instructions !== undefined ? { instructions } : {}),
      reasoningReplays,
      includeEncryptedReasoning: include.includes("reasoning.encrypted_content"),
      ...(request.prompt_cache_key !== undefined
        ? { promptCacheKey: request.prompt_cache_key }
        : {}),
      ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
    },
    bridge,
  };
}
