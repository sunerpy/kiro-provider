import { resolveOutputTokenLimit } from "../../kiro/output-token-limit.js";
import { isRecord, textPart } from "../../protocol/adapter-utils.js";
import {
  assistantOutputFingerprint,
  type CanonicalContentPart,
  type CanonicalMessage,
  type CanonicalRequest,
  type CanonicalTextPart,
  type CanonicalToolCall,
  type CanonicalToolDeclaration,
  type ProtocolProjectionMode,
  textFromParts,
} from "../../protocol/canonical.js";
import { findToolHistoryViolation } from "../../protocol/tool-history.js";
import type { ChatCompletionRequest } from "../request-schema.js";
import { allowedKeysValidator, type ProtocolResult, protocolFailure } from "./adaptation.js";

const CHAT_REQUEST_KEYS = new Set([
  "model",
  "stream",
  "stream_options",
  "messages",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "user",
  "prompt_cache_key",
  "reasoning_effort",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "response_format",
  "n",
  "stop",
  "seed",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "top_logprobs",
  "modalities",
  "audio",
  "prediction",
  "store",
  "metadata",
  "service_tier",
]);

const UNSUPPORTED_CHAT_FIELDS = [
  "temperature",
  "top_p",
  "response_format",
  "stop",
  "seed",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "top_logprobs",
  "modalities",
  "audio",
  "prediction",
  "metadata",
  "service_tier",
] as const;

type ChatMessage = ChatCompletionRequest["messages"][number];

const validateAllowedKeys = allowedKeysValidator("Chat field");

function mapContent(
  content: ChatMessage["content"],
  path: string,
): ProtocolResult<readonly CanonicalContentPart[]> {
  if (typeof content === "string") {
    return { ok: true, value: [textPart(content, path)] };
  }
  if (!Array.isArray(content)) return { ok: true, value: [] };

  const mapped: CanonicalContentPart[] = [];
  for (const [index, part] of content.entries()) {
    const partPath = `${path}.${index}`;
    switch (part.type) {
      case "text": {
        const keys = validateAllowedKeys(part, partPath, new Set(["type", "text"]));
        if (!keys.ok) return keys;
        mapped.push(textPart(part.text, `${partPath}.text`));
        break;
      }
      case "image_url": {
        const keys = validateAllowedKeys(part, partPath, new Set(["type", "image_url"]));
        if (!keys.ok) return keys;
        const imageKeys = validateAllowedKeys(
          part.image_url,
          `${partPath}.image_url`,
          new Set(["url", "detail"]),
        );
        if (!imageKeys.ok) return imageKeys;
        if (part.image_url.detail !== undefined) {
          return protocolFailure(
            "unsupported_parameter",
            "Chat image detail cannot be represented by the Kiro upstream",
            `${partPath}.image_url.detail`,
          );
        }
        if (!part.image_url.url.startsWith("data:")) {
          return protocolFailure(
            "unsupported_image_source",
            "Chat images must use data URLs because Kiro cannot fetch remote image URLs",
            `${partPath}.image_url.url`,
          );
        }
        mapped.push({
          type: "image",
          url: part.image_url.url,
          path: `${partPath}.image_url.url`,
        });
        break;
      }
      case "image": {
        const keys = validateAllowedKeys(part, partPath, new Set(["type", "source"]));
        if (!keys.ok) return keys;
        const sourceKeys = validateAllowedKeys(
          part.source,
          `${partPath}.source`,
          new Set(["type", "data", "media_type"]),
        );
        if (!sourceKeys.ok) return sourceKeys;
        if (part.source.type !== "base64") {
          return protocolFailure(
            "unsupported_image_source",
            "Chat image sources must use type=base64",
            `${partPath}.source.type`,
          );
        }
        mapped.push({
          type: "image",
          data: part.source.data,
          ...(part.source.media_type !== undefined ? { mediaType: part.source.media_type } : {}),
          path: `${partPath}.source`,
        });
        break;
      }
      case "tool_use": {
        const keys = validateAllowedKeys(part, partPath, new Set(["type", "id", "name", "input"]));
        if (!keys.ok) return keys;
        mapped.push({
          type: "tool_use",
          id: part.id,
          name: part.name,
          input: part.input,
          path: partPath,
        });
        break;
      }
      case "tool_result": {
        const keys = validateAllowedKeys(
          part,
          partPath,
          new Set(["type", "tool_use_id", "content", "is_error"]),
        );
        if (!keys.ok) return keys;
        const resultContent = mapToolResultContent(part.content, `${partPath}.content`);
        if (!resultContent.ok) return resultContent;
        mapped.push({
          type: "tool_result",
          toolCallId: part.tool_use_id,
          content: resultContent.value,
          isError: part.is_error === true,
          path: partPath,
        });
        break;
      }
      case "thinking":
        return protocolFailure(
          "unsupported_content_part",
          `Chat content part ${partPath} uses unsupported type thinking`,
          partPath,
        );
    }
  }
  return { ok: true, value: mapped };
}

function mapToolResultContent(
  content: unknown,
  path: string,
): ProtocolResult<readonly CanonicalTextPart[]> {
  if (typeof content === "string") return { ok: true, value: [textPart(content, path)] };
  if (!Array.isArray(content)) {
    return protocolFailure(
      "unsupported_tool_result_content",
      `Tool result ${path} must be a string or an array of text blocks`,
      path,
    );
  }
  const parts: CanonicalTextPart[] = [];
  for (const [index, part] of content.entries()) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
      return protocolFailure(
        "unsupported_tool_result_content",
        `Tool result ${path}.${index} must be a text block`,
        `${path}.${index}`,
      );
    }
    const keys = validateAllowedKeys(part, `${path}.${index}`, new Set(["type", "text"]));
    if (!keys.ok) return keys;
    parts.push(textPart(part.text, `${path}.${index}.text`));
  }
  return { ok: true, value: parts };
}

function parseToolCall(
  call: NonNullable<Extract<ChatMessage, { role: "assistant" }>["tool_calls"]>[number],
  path: string,
): ProtocolResult<CanonicalToolCall> {
  const callKeys = validateAllowedKeys(call, path, new Set(["id", "type", "function"]));
  if (!callKeys.ok) return callKeys;
  const functionKeys = validateAllowedKeys(
    call.function,
    `${path}.function`,
    new Set(["name", "arguments"]),
  );
  if (!functionKeys.ok) return functionKeys;
  try {
    return {
      ok: true,
      value: {
        id: call.id,
        name: call.function.name,
        input: JSON.parse(call.function.arguments),
        path,
      },
    };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return protocolFailure(
      "invalid_tool_history",
      `Tool call ${path} contains invalid JSON arguments`,
      `${path}.function.arguments`,
    );
  }
}

function mapTools(
  tools: ChatCompletionRequest["tools"],
): ProtocolResult<readonly CanonicalToolDeclaration[]> {
  const mapped: CanonicalToolDeclaration[] = [];
  const names = new Set<string>();
  for (const [index, tool] of (tools ?? []).entries()) {
    const path = `tools.${index}`;
    const openAiFunction = isRecord(tool.function) ? tool.function : undefined;
    if (openAiFunction !== undefined) {
      const toolKeys = validateAllowedKeys(tool, path, new Set(["type", "function"]));
      if (!toolKeys.ok) return toolKeys;
      const functionKeys = validateAllowedKeys(
        openAiFunction,
        `${path}.function`,
        new Set(["name", "description", "parameters", "strict"]),
      );
      if (!functionKeys.ok) return functionKeys;
      if (openAiFunction.strict === true) {
        return protocolFailure(
          "unsupported_strict_tools",
          "Chat function strict=true cannot be guaranteed by the Kiro upstream",
          `${path}.function.strict`,
        );
      }
    } else {
      const toolKeys = validateAllowedKeys(
        tool,
        path,
        new Set(["name", "description", "input_schema"]),
      );
      if (!toolKeys.ok) return toolKeys;
    }
    const nameCandidate =
      typeof openAiFunction?.name === "string" ? openAiFunction.name : tool.name;
    if (typeof nameCandidate !== "string" || nameCandidate.length === 0) {
      return protocolFailure(
        "invalid_tool_declaration",
        `Tool declaration ${path} requires a name`,
        path,
      );
    }
    const name = nameCandidate;
    if (names.has(name)) {
      return protocolFailure(
        "invalid_tool_declaration",
        `Duplicate tool declaration ${name}`,
        path,
      );
    }
    names.add(name);
    const description =
      typeof openAiFunction?.description === "string"
        ? openAiFunction.description
        : typeof tool.description === "string"
          ? tool.description
          : undefined;
    const inputSchema =
      openAiFunction !== undefined
        ? isRecord(openAiFunction.parameters)
          ? openAiFunction.parameters
          : {}
        : isRecord(tool.input_schema)
          ? tool.input_schema
          : {};
    mapped.push({
      publicType: "function",
      name,
      wireName: name,
      ...(description !== undefined ? { description } : {}),
      descriptionPath:
        openAiFunction !== undefined ? `${path}.function.description` : `${path}.description`,
      inputSchema,
      ...(openAiFunction !== undefined ? { strict: false as const } : {}),
      path,
    });
  }
  return { ok: true, value: mapped };
}

/** Mirrors the Responses adapter: `minimal` lowers to `low`, `none` requests no effort. */
function normalizedChatEffort(
  effort: ChatCompletionRequest["reasoning_effort"],
): CanonicalRequest["reasoningEffort"] | undefined {
  if (effort === undefined || effort === "none") return undefined;
  if (effort === "minimal") return "low";
  return effort;
}

function validateHistory(
  messages: readonly CanonicalMessage[],
  tools: readonly CanonicalToolDeclaration[],
): ProtocolResult<undefined> {
  const violation = findToolHistoryViolation(messages, tools);
  if (!violation) return { ok: true, value: undefined };
  switch (violation.kind) {
    case "missing_tool_declaration":
      return protocolFailure(
        violation.code,
        `Tool call ${violation.callId} references ${violation.toolName} without an exact tool declaration`,
        violation.path,
      );
    case "duplicate_tool_call":
      return protocolFailure(
        violation.code,
        `Duplicate tool call id ${violation.callId}`,
        violation.path,
      );
    case "orphan_tool_result":
      return protocolFailure(
        violation.code,
        `Tool result ${violation.toolCallId} has no earlier unique matching call`,
        violation.path,
      );
  }
}

export function chatToCanonical(
  request: ChatCompletionRequest,
  projectionMode: ProtocolProjectionMode,
): ProtocolResult<CanonicalRequest> {
  for (const key of Object.keys(request)) {
    if (!CHAT_REQUEST_KEYS.has(key)) {
      return protocolFailure(
        "unsupported_parameter",
        `Chat parameter ${key} is not supported`,
        key,
      );
    }
  }
  if (request.stream_options !== undefined) {
    const streamOptions = validateAllowedKeys(
      request.stream_options,
      "stream_options",
      new Set(["include_usage"]),
    );
    if (!streamOptions.ok) return streamOptions;
    if (!request.stream) {
      return protocolFailure(
        "unsupported_parameter",
        "Chat stream_options requires stream=true",
        "stream_options",
      );
    }
  }
  for (const field of UNSUPPORTED_CHAT_FIELDS) {
    if (request[field] !== undefined) {
      return protocolFailure(
        "unsupported_parameter",
        `Chat parameter ${field} cannot be represented by the Kiro upstream`,
        field,
      );
    }
  }
  if (request.n !== undefined && request.n !== 1) {
    return protocolFailure(
      "unsupported_parameter",
      "Chat parameter n must be 1 because the Kiro upstream returns a single choice",
      "n",
    );
  }
  if (request.store === true) {
    return protocolFailure(
      "unsupported_parameter",
      "Chat parameter store=true is not supported",
      "store",
    );
  }
  if (request.max_tokens !== undefined && request.max_completion_tokens !== undefined) {
    return protocolFailure(
      "conflicting_output_token_limits",
      "Chat max_tokens and max_completion_tokens cannot both be supplied",
      "max_completion_tokens",
    );
  }
  const outputTokenLimit = request.max_completion_tokens ?? request.max_tokens;
  const outputTokenLimitParam =
    request.max_completion_tokens !== undefined ? "max_completion_tokens" : "max_tokens";
  if (outputTokenLimit !== undefined) {
    const outputLimit = resolveOutputTokenLimit(request.model, outputTokenLimit);
    if (!outputLimit.ok) {
      return protocolFailure(outputLimit.code, outputLimit.message, outputTokenLimitParam);
    }
  }
  if (
    request.tool_choice === "required" ||
    (typeof request.tool_choice === "object" && request.tool_choice !== null)
  ) {
    return protocolFailure(
      "unsupported_tool_choice",
      "Required or named tool choice cannot be represented by the Kiro upstream",
      "tool_choice",
    );
  }

  const toolsResult = mapTools(request.tools);
  if (!toolsResult.ok) return toolsResult;
  const messages: CanonicalMessage[] = [];
  if (
    request.parallel_tool_calls === false &&
    request.tool_choice !== "none" &&
    toolsResult.value.length > 0
  ) {
    return protocolFailure(
      "unsupported_parallel_tool_calls",
      "parallel_tool_calls=false cannot be guaranteed by the Kiro upstream",
      "parallel_tool_calls",
    );
  }
  const reasoningReplays: CanonicalRequest["reasoningReplays"][number][] = [];
  for (const [index, message] of request.messages.entries()) {
    const path = `messages.${index}`;
    const allowedMessageKeys =
      message.role === "assistant"
        ? new Set(["role", "content", "tool_calls", "reasoning_content"])
        : message.role === "tool"
          ? new Set(["role", "content", "tool_call_id"])
          : new Set(["role", "content"]);
    for (const key of Object.keys(message)) {
      if (!allowedMessageKeys.has(key)) {
        return protocolFailure(
          "unsupported_message_field",
          `Chat message field ${path}.${key} is not supported`,
          `${path}.${key}`,
        );
      }
    }
    if (projectionMode === "safe" && (message.role === "system" || message.role === "developer")) {
      return protocolFailure(
        "unsupported_instruction_projection",
        `${message.role} messages cannot be projected losslessly to Kiro; use legacy-user-prefix explicitly to migrate`,
        path,
      );
    }
    const contentResult = mapContent(message.content, `${path}.content`);
    if (!contentResult.ok) return contentResult;
    const toolCalls: CanonicalToolCall[] = [];
    if (message.role === "assistant") {
      for (const [callIndex, call] of (message.tool_calls ?? []).entries()) {
        const callResult = parseToolCall(call, `${path}.tool_calls.${callIndex}`);
        if (!callResult.ok) return callResult;
        toolCalls.push(callResult.value);
      }
    }
    let content = contentResult.value;
    if (message.role === "tool") {
      const resultContent = content.filter(
        (part): part is CanonicalTextPart => part.type === "text",
      );
      if (resultContent.length !== content.length) {
        return protocolFailure(
          "unsupported_tool_result_content",
          `Chat tool message ${path} may contain text only`,
          `${path}.content`,
        );
      }
      content = [
        {
          type: "tool_result",
          toolCallId: message.tool_call_id,
          content: resultContent,
          isError: false,
          path,
        },
      ];
    }
    const canonicalMessage: CanonicalMessage = {
      role: message.role,
      content,
      toolCalls,
      path,
    };
    if (message.role === "assistant" && message.reasoning_content !== undefined) {
      reasoningReplays.push({
        lookup: { kind: "chat-hash", reasoningText: message.reasoning_content },
        outputFingerprint: assistantOutputFingerprint({
          text: textFromParts(content),
          toolCalls: (message.tool_calls ?? []).map((call) => ({
            id: call.id,
            name: call.function.name,
            input: call.function.arguments,
          })),
        }),
        insertBeforeMessage: messages.length,
        path: `${path}.reasoning_content`,
      });
    }
    messages.push(canonicalMessage);
  }

  const history = validateHistory(messages, toolsResult.value);
  if (!history.ok) return history;
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

  const reasoningEffort = normalizedChatEffort(request.reasoning_effort);
  return {
    ok: true,
    value: {
      canonicalVersion: 1,
      protocol: "chat-completions",
      projectionMode,
      model: request.model,
      stream: request.stream,
      messages,
      tools: toolsResult.value,
      toolChoice: request.tool_choice === "none" ? "none" : "auto",
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(request.reasoning_effort !== undefined
        ? { requestedReasoningEffort: request.reasoning_effort }
        : {}),
      ...(outputTokenLimit !== undefined ? { outputTokenLimit } : {}),
      reasoningReplays,
      includeEncryptedReasoning: false,
      ...(request.prompt_cache_key !== undefined
        ? { promptCacheKey: request.prompt_cache_key }
        : {}),
    },
  };
}
