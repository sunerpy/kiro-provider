import { randomUUID } from "node:crypto";
import { textPart } from "../../protocol/adapter-utils.js";
import {
  type CanonicalMessage,
  type CanonicalRequest,
  type CanonicalToolDeclaration,
  isCanonicalRequest,
  type ResolvedReasoningReplay,
} from "../../protocol/canonical.js";
import { findToolHistoryViolation } from "../../protocol/tool-history.js";
import { KIRO_CONSTANTS } from "../constants.js";
import { resolveModelVariant } from "../models.js";
import type {
  CodeWhispererMessage,
  CodeWhispererRequest,
  Effort,
  KiroAuthDetails,
} from "../types.js";
import { RequestTransformError } from "./errors.js";
import { buildHistory, currentUserInput } from "./history-builder.js";

export interface RequestTransformResult {
  readonly request: CodeWhispererRequest;
  readonly resolved: string;
  readonly convId: string;
  readonly variantEffort?: Effort;
}

export interface RequestTransformIdentity {
  readonly conversationId?: string;
  readonly resolvedReasoningReplays?: readonly ResolvedReasoningReplay[];
}

function cloneMessage(message: CanonicalMessage): CanonicalMessage {
  return {
    ...message,
    content: message.content.map((part) =>
      part.type === "tool_result"
        ? { ...part, content: part.content.map((content) => ({ ...content })) }
        : { ...part },
    ),
    toolCalls: message.toolCalls.map((call) => ({ ...call })),
  };
}

function validateContentBlockProjection(messages: readonly CanonicalMessage[]): void {
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") continue;
    const textParts = message.content.filter((part) => part.type === "text");
    if (
      textParts.length <= 1 ||
      message.content.every((part) => part.type === "text")
    ) {
      continue;
    }
    const firstUnprojectable = textParts[1];
    throw new RequestTransformError(
      `Message ${message.path} interleaves multiple text content blocks with non-text content, but Kiro exposes only one text field and cannot preserve their ordering`,
      "unsupported_content_block_projection",
      firstUnprojectable?.path ?? message.path,
    );
  }
}

function projectMessages(request: CanonicalRequest): {
  readonly messages: CanonicalMessage[];
  readonly projectedIndexByOriginal: ReadonlyMap<number, number>;
} {
  const instructions = request.messages.filter(
    (message) => message.role === "system" || message.role === "developer",
  );
  if (instructions.length > 0 && request.projectionMode === "safe") {
    throw new RequestTransformError(
      "Kiro accepted additionalContext structurally but did not preserve instruction content or priority; safe mode cannot project system/developer/instructions",
      "unsupported_instruction_projection",
    );
  }
  for (const instruction of instructions) {
    if (instruction.content.some((part) => part.type !== "text") || instruction.toolCalls.length > 0) {
      throw new RequestTransformError(
        `Instruction ${instruction.path} contains non-text content that legacy projection cannot represent`,
        "unsupported_instruction_projection",
      );
    }
  }

  const messages: CanonicalMessage[] = [];
  const projectedIndexByOriginal = new Map<number, number>();
  for (const [index, message] of request.messages.entries()) {
    if (message.role === "system" || message.role === "developer") continue;
    projectedIndexByOriginal.set(index, messages.length);
    messages.push(cloneMessage(message));
  }
  if (instructions.length === 0) return { messages, projectedIndexByOriginal };

  const prefix = instructions
    .flatMap((message) =>
      message.content.map((part) => (part.type === "text" ? part.text : "")),
    )
    .join("\n\n");
  const firstUserIndex = messages.findIndex((message) => message.role === "user");
  if (firstUserIndex < 0) {
    messages.unshift({
      role: "user",
      content: [textPart(prefix, "legacy-user-prefix")],
      toolCalls: [],
      path: "legacy-user-prefix",
    });
    for (const [key, value] of projectedIndexByOriginal) {
      projectedIndexByOriginal.set(key, value + 1);
    }
    return { messages, projectedIndexByOriginal };
  }
  const firstUser = messages[firstUserIndex];
  if (!firstUser) return { messages, projectedIndexByOriginal };
  messages[firstUserIndex] = {
    ...firstUser,
    content: [
      textPart(`${prefix}\n\n`, "legacy-user-prefix"),
      ...firstUser.content,
    ],
  };
  return { messages, projectedIndexByOriginal };
}

function validateToolHistory(
  messages: readonly CanonicalMessage[],
  tools: readonly CanonicalToolDeclaration[],
): void {
  // The projection is the last line of defence, so it also scans `tool_use`
  // content parts; adapters validate only the `toolCalls` they produce.
  const violation = findToolHistoryViolation(messages, tools, { includeToolUseParts: true });
  if (!violation) return;
  switch (violation.kind) {
    case "missing_tool_declaration":
      throw new RequestTransformError(
        `Tool call ${violation.callId} references ${violation.toolName} without an exact declaration`,
        violation.code,
      );
    case "duplicate_tool_call":
      throw new RequestTransformError(
        `Duplicate tool call id ${violation.callId}`,
        violation.code,
      );
    case "orphan_tool_result":
      throw new RequestTransformError(
        `Tool result ${violation.toolCallId} has no earlier unique matching call`,
        violation.code,
      );
  }
}

function toolsForKiro(
  tools: readonly CanonicalToolDeclaration[],
): NonNullable<
  NonNullable<
    NonNullable<CodeWhispererMessage["userInputMessage"]>["userInputMessageContext"]
  >["tools"]
> {
  return tools.map((tool) => ({
    toolSpecification: {
      name: tool.wireName,
      description: tool.description ?? "",
      inputSchema: { json: { ...tool.inputSchema } },
    },
  }));
}

export function buildCodeWhispererRequest(
  body: CanonicalRequest,
  model: string,
  auth: KiroAuthDetails,
  identity: RequestTransformIdentity = {},
): RequestTransformResult {
  if (!isCanonicalRequest(body)) {
    throw new RequestTransformError(
      "CanonicalRequest is required before Kiro projection",
      "canonical_request_required",
    );
  }
  const canonical = body;
  if (canonical.model !== model) {
    throw new RequestTransformError(
      `CanonicalRequest model ${canonical.model} does not match pipeline model ${model}`,
      "canonical_model_mismatch",
    );
  }
  if (canonical.messages.length === 0) {
    throw new RequestTransformError("No messages", "empty_input");
  }
  validateContentBlockProjection(canonical.messages);
  let resolved: string;
  let variantEffort: ReturnType<typeof resolveModelVariant>["effort"];
  try {
    const modelVariant = resolveModelVariant(model);
    resolved = modelVariant.wireId;
    variantEffort = modelVariant.effort;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unsupported model:")) {
      throw new RequestTransformError(error.message, "unsupported_model", "model");
    }
    throw error;
  }
  const projection = projectMessages(canonical);
  if (projection.messages.length === 0) {
    throw new RequestTransformError("No executable messages", "empty_input");
  }
  validateToolHistory(projection.messages, canonical.tools);

  const projectedReplays = (identity.resolvedReasoningReplays ?? []).map((replay) => {
    const insertBeforeMessage = projection.projectedIndexByOriginal.get(
      replay.insertBeforeMessage,
    );
    if (insertBeforeMessage === undefined) {
      throw new RequestTransformError(
        "Reasoning replay does not reference an assistant output message",
        "invalid_reasoning_replay",
      );
    }
    return { ...replay, insertBeforeMessage };
  });

  const current = projection.messages.at(-1);
  if (!current) throw new RequestTransformError("No executable messages", "empty_input");
  const currentIsAssistant = current.role === "assistant";
  const historyMessages = currentIsAssistant
    ? projection.messages
    : projection.messages.slice(0, -1);
  const historyReplays = projectedReplays.filter(
    (replay) => replay.insertBeforeMessage < historyMessages.length,
  );
  const history = buildHistory(historyMessages, resolved, historyReplays);

  const currentInput = currentIsAssistant
    ? {
        content: "",
        modelId: resolved,
        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
      }
    : currentUserInput(current, resolved);
  const suppliedTools = canonical.toolChoice === "auto" ? toolsForKiro(canonical.tools) : [];
  if (suppliedTools.length > 0) {
    currentInput.userInputMessageContext ??= {};
    currentInput.userInputMessageContext.tools = suppliedTools;
  }

  const convId = identity.conversationId ?? randomUUID();
  const request: CodeWhispererRequest = {
    conversationState: {
      chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
      conversationId: convId,
      agentContinuationId: randomUUID(),
      agentTaskType: "vibe",
      currentMessage: { userInputMessage: currentInput },
      ...(history.length > 0 ? { history } : {}),
    },
    ...(auth.profileArn ? { profileArn: auth.profileArn } : {}),
  };
  return variantEffort === undefined
    ? { request, resolved, convId }
    : { request, resolved, convId, variantEffort };
}
