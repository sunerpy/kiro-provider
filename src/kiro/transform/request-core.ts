import { randomUUID } from "node:crypto";
import { textPart } from "../../protocol/adapter-utils.js";
import {
  type CanonicalMessage,
  type CanonicalRequest,
  type CanonicalToolDeclaration,
  isCanonicalRequest,
  type ResolvedReasoningReplay,
  textFromParts,
} from "../../protocol/canonical.js";
import { findToolHistoryViolation } from "../../protocol/tool-history.js";
import { KIRO_CONSTANTS } from "../constants.js";
import { resolveModelVariant } from "../models.js";
import type {
  CodeWhispererMessage,
  CodeWhispererRequest,
  Effort,
  KiroAuthDetails,
  RequestProjectionDiagnostics,
  RequestTransformDiagnostics,
} from "../types.js";
import { RequestTransformError } from "./errors.js";
import { buildHistory, currentUserInput } from "./history-builder.js";

export interface RequestTransformResult {
  readonly request: CodeWhispererRequest;
  readonly resolved: string;
  readonly convId: string;
  readonly systemPrompt?: string;
  readonly variantEffort?: Effort;
  readonly diagnostics: RequestTransformDiagnostics;
}

export interface RequestTransformIdentity {
  readonly conversationId?: string;
  readonly nativeSystemPromptEnabled?: boolean;
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

function isInstruction(message: CanonicalMessage): boolean {
  return message.role === "system" || message.role === "developer";
}

function instructionText(messages: readonly CanonicalMessage[]): string {
  return messages
    .flatMap((message) => message.content.map((part) => (part.type === "text" ? part.text : "")))
    .join("\n\n");
}

function forcedInstructionText(messages: readonly CanonicalMessage[]): string {
  if (messages.length <= 1) return instructionText(messages);
  return messages.map((message) => `[${message.role}]\n${instructionText([message])}`).join("\n\n");
}

type NativeInstructionProjection =
  | {
      readonly ok: true;
      readonly instruction?: CanonicalMessage;
      readonly systemPrompt?: string;
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly code: string;
      readonly param?: string;
    };

function nativeInstructionProjection(
  request: CanonicalRequest,
  instructions: readonly CanonicalMessage[],
): NativeInstructionProjection {
  const firstExecutableIndex = request.messages.findIndex((message) => !isInstruction(message));
  const instructionAfterExecutable =
    firstExecutableIndex < 0
      ? undefined
      : request.messages.slice(firstExecutableIndex).find((message) => isInstruction(message));
  if (instructionAfterExecutable !== undefined) {
    return {
      ok: false,
      message:
        "Kiro Runtime systemPrompt can represent only a leading instruction; intermediate or trailing system/developer input cannot use the native field",
      code: "unsupported_instruction_position",
      param: instructionAfterExecutable.path,
    };
  }

  const nonEmptyInstructions = instructions.filter(
    (instruction) => instructionText([instruction]).length > 0,
  );
  if (nonEmptyInstructions.length > 1) {
    return {
      ok: false,
      message:
        "Kiro Runtime exposes one systemPrompt string and cannot preserve multiple system/developer message boundaries or role priority",
      code: "unsupported_instruction_sequence",
      param: nonEmptyInstructions[1]?.path,
    };
  }
  const instruction = nonEmptyInstructions[0];
  if (instruction !== undefined && instruction.content.length !== 1) {
    return {
      ok: false,
      message:
        "Kiro Runtime exposes one systemPrompt string and cannot preserve multiple instruction content-block boundaries",
      code: "unsupported_instruction_sequence",
      param: instruction.content[1]?.path ?? instruction.path,
    };
  }
  return {
    ok: true,
    ...(instruction !== undefined
      ? { instruction, systemPrompt: instructionText([instruction]) }
      : {}),
  };
}

function validateContentBlockProjection(messages: readonly CanonicalMessage[]): void {
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") continue;
    const textParts = message.content.filter((part) => part.type === "text");
    if (textParts.length <= 1 || message.content.every((part) => part.type === "text")) {
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

function projectMessages(
  request: CanonicalRequest,
  nativeSystemPromptEnabled: boolean,
): {
  readonly messages: CanonicalMessage[];
  readonly projectedIndexByOriginal: ReadonlyMap<number, number>;
  readonly systemPrompt?: string;
  readonly diagnostics: RequestProjectionDiagnostics;
} {
  const instructions = request.messages.filter(isInstruction);
  if (instructions.length > 0 && request.projectionMode === "safe") {
    throw new RequestTransformError(
      "Kiro accepted additionalContext structurally but did not preserve instruction content or priority; safe mode cannot project system/developer/instructions",
      "unsupported_instruction_projection",
    );
  }
  for (const instruction of instructions) {
    if (
      instruction.content.some((part) => part.type !== "text") ||
      instruction.toolCalls.length > 0
    ) {
      throw new RequestTransformError(
        `Instruction ${instruction.path} contains non-text content that legacy projection cannot represent`,
        "unsupported_instruction_projection",
      );
    }
  }

  const nativeProjection = nativeInstructionProjection(request, instructions);
  const useNativeProjection =
    request.projectionMode === "native-context-safe" ||
    (request.projectionMode === "v3-auto" && nativeSystemPromptEnabled && nativeProjection.ok);
  if (useNativeProjection) {
    if (!nativeProjection.ok) {
      throw new RequestTransformError(
        nativeProjection.message,
        nativeProjection.code,
        nativeProjection.param,
      );
    }
    if (nativeProjection.instruction !== undefined && !nativeSystemPromptEnabled) {
      throw new RequestTransformError(
        "Kiro Runtime did not advertise system_field_injection for this account; native-context-safe remains fail-closed",
        "native_context_capability_unavailable",
        nativeProjection.instruction.path,
      );
    }

    const messages: CanonicalMessage[] = [];
    const projectedIndexByOriginal = new Map<number, number>();
    for (const [index, message] of request.messages.entries()) {
      if (isInstruction(message)) continue;
      projectedIndexByOriginal.set(index, messages.length);
      messages.push(cloneMessage(message));
    }
    const systemPrompt = nativeProjection.systemPrompt;
    return {
      messages,
      projectedIndexByOriginal,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      diagnostics: {
        projectionMode: request.projectionMode,
        instructionChannel: systemPrompt === undefined ? "none" : "kiro-runtime-system-prompt",
        inputMessageCount: request.messages.length,
        outputMessageCount: messages.length,
        prefixInstructionCount: instructions.length,
        trailingInstructionCount: 0,
        prefixAction: systemPrompt === undefined ? "none" : "native_system_prompt",
        suffixAction: "none",
      },
    };
  }

  if (request.projectionMode === "v3-auto") {
    const messages: CanonicalMessage[] = [];
    const projectedIndexByOriginal = new Map<number, number>();
    for (const [index, message] of request.messages.entries()) {
      if (isInstruction(message)) continue;
      projectedIndexByOriginal.set(index, messages.length);
      messages.push(cloneMessage(message));
    }
    const executableMessageCount = messages.length;
    const nonEmptyInstructions = instructions.filter(
      (instruction) => instructionText([instruction]).length > 0,
    );
    let prefixAction: RequestProjectionDiagnostics["prefixAction"] = "none";
    let suffixAction: RequestProjectionDiagnostics["suffixAction"] = "none";
    if (executableMessageCount > 0 && nonEmptyInstructions.length > 0) {
      const sourcePath = nonEmptyInstructions[0]?.path ?? "kiro-cli-forced-role";
      messages.unshift(
        {
          role: "user",
          content: [textPart(forcedInstructionText(nonEmptyInstructions), "kiro-cli-forced-role")],
          toolCalls: [],
          path: sourcePath,
        },
        {
          role: "assistant",
          content: [
            textPart("I will follow these instructions.", "kiro-cli-forced-role-acknowledgement"),
          ],
          toolCalls: [],
          path: "kiro-cli-forced-role-acknowledgement",
        },
      );
      prefixAction = "kiro_cli_forced_role";
      for (const [key, value] of projectedIndexByOriginal) {
        projectedIndexByOriginal.set(key, value + 2);
      }
      if (messages.at(-1)?.role === "assistant") {
        messages.push({
          role: "user",
          content: [textPart("Now follow the instruction.", sourcePath)],
          toolCalls: [],
          path: sourcePath,
        });
        suffixAction = "synthetic_user";
      }
    }
    let trailingInstructionStart = request.messages.length;
    while (
      trailingInstructionStart > 0 &&
      isInstruction(request.messages[trailingInstructionStart - 1] as CanonicalMessage)
    ) {
      trailingInstructionStart -= 1;
    }
    const trailingInstructionCount =
      trailingInstructionStart < request.messages.length &&
      request.messages.slice(0, trailingInstructionStart).some((message) => !isInstruction(message))
        ? request.messages.length - trailingInstructionStart
        : 0;
    return {
      messages,
      projectedIndexByOriginal,
      diagnostics: {
        projectionMode: request.projectionMode,
        instructionChannel: nonEmptyInstructions.length === 0 ? "none" : "kiro-cli-forced-role",
        inputMessageCount: request.messages.length,
        outputMessageCount: messages.length,
        prefixInstructionCount: instructions.length - trailingInstructionCount,
        trailingInstructionCount,
        prefixAction,
        suffixAction,
      },
    };
  }

  let trailingInstructionStart = request.messages.length;
  while (
    trailingInstructionStart > 0 &&
    isInstruction(request.messages[trailingInstructionStart - 1] as CanonicalMessage)
  ) {
    trailingInstructionStart -= 1;
  }
  const hasEarlierExecutableMessage = request.messages
    .slice(0, trailingInstructionStart)
    .some((message) => !isInstruction(message));
  const trailingInstructions = hasEarlierExecutableMessage
    ? request.messages.slice(trailingInstructionStart)
    : [];
  const prefixInstructions =
    trailingInstructions.length > 0
      ? instructions.slice(0, instructions.length - trailingInstructions.length)
      : instructions;
  let prefixAction: RequestProjectionDiagnostics["prefixAction"] = "none";
  let suffixAction: RequestProjectionDiagnostics["suffixAction"] = "none";

  const messages: CanonicalMessage[] = [];
  const projectedIndexByOriginal = new Map<number, number>();
  for (const [index, message] of request.messages.entries()) {
    if (isInstruction(message)) continue;
    projectedIndexByOriginal.set(index, messages.length);
    messages.push(cloneMessage(message));
  }
  if (prefixInstructions.length > 0) {
    const prefix = instructionText(prefixInstructions);
    const firstUserIndex = messages.findIndex((message) => message.role === "user");
    if (firstUserIndex < 0) {
      // No user turn to glue into: the instruction block becomes its own leading
      // user turn. Live A/B on 2026-09-03 (claude-opus-5, effort high, n=120/arm,
      // docs/audits/kiro-ab-probes-2026-09-03.zh.md) found no turn-2 stop-rate
      // difference between this shape and gluing (31.7% vs 33.3%, Fisher p=0.89),
      // so the standalone turn is kept.
      messages.unshift({
        role: "user",
        content: [textPart(prefix, "legacy-user-prefix")],
        toolCalls: [],
        path: "legacy-user-prefix",
      });
      prefixAction = "synthetic_leading_user";
      for (const [key, value] of projectedIndexByOriginal) {
        projectedIndexByOriginal.set(key, value + 1);
      }
    } else {
      const firstUser = messages[firstUserIndex];
      if (firstUser) {
        messages[firstUserIndex] = {
          ...firstUser,
          content: [textPart(`${prefix}\n\n`, "legacy-user-prefix"), ...firstUser.content],
        };
        prefixAction = "prepend_first_user";
      }
    }
  }

  if (trailingInstructions.length > 0) {
    const suffix = instructionText(trailingInstructions);
    const suffixPath = trailingInstructions[0]?.path ?? "legacy-user-suffix";
    const currentIndex = messages.length - 1;
    const current = messages[currentIndex];
    if (current?.role === "user" || current?.role === "tool") {
      const separator = textFromParts(current.content).length > 0 ? "\n\n" : "";
      messages[currentIndex] = {
        ...current,
        content: [...current.content, textPart(`${separator}${suffix}`, suffixPath)],
      };
      suffixAction = current.role === "user" ? "append_user" : "append_tool";
    } else {
      messages.push({
        role: "user",
        content: [textPart(suffix, suffixPath)],
        toolCalls: [],
        path: suffixPath,
      });
      suffixAction = "synthetic_user";
    }
  }

  return {
    messages,
    projectedIndexByOriginal,
    diagnostics: {
      projectionMode: request.projectionMode,
      instructionChannel: instructions.length === 0 ? "none" : "legacy-user-prefix",
      inputMessageCount: request.messages.length,
      outputMessageCount: messages.length,
      prefixInstructionCount: prefixInstructions.length,
      trailingInstructionCount: trailingInstructions.length,
      prefixAction,
      suffixAction,
    },
  };
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
      throw new RequestTransformError(`Duplicate tool call id ${violation.callId}`, violation.code);
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
  for (const tool of tools) {
    if (tool.description === undefined || tool.description.trim().length === 0) {
      throw new RequestTransformError(
        `Tool ${tool.path} requires a non-empty description for Kiro`,
        "missing_tool_description",
        tool.descriptionPath ?? tool.path,
      );
    }
  }
  return tools.map((tool) => ({
    toolSpecification: {
      name: tool.wireName,
      description: tool.description as string,
      inputSchema: { json: { ...tool.inputSchema } },
    },
  }));
}

function hasExecutableInput(input: NonNullable<CodeWhispererMessage["userInputMessage"]>): boolean {
  return (
    input.content.length > 0 ||
    (input.images?.length ?? 0) > 0 ||
    (input.documents?.length ?? 0) > 0 ||
    (input.userInputMessageContext?.toolResults?.length ?? 0) > 0
  );
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
  const projection = projectMessages(canonical, identity.nativeSystemPromptEnabled === true);
  if (projection.messages.length === 0) {
    throw new RequestTransformError("No executable messages", "empty_input");
  }
  validateToolHistory(projection.messages, canonical.tools);

  const projectedReplays = (identity.resolvedReasoningReplays ?? []).map((replay) => {
    const insertBeforeMessage = projection.projectedIndexByOriginal.get(replay.insertBeforeMessage);
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
  if (current.role === "assistant") {
    throw new RequestTransformError(
      "Request ends with an assistant message and has no current user input",
      "missing_current_input",
      current.path,
    );
  }
  if (current.role !== "user" && current.role !== "tool") {
    throw new RequestTransformError(
      `Request ends with ${current.role} and has no current user input`,
      "missing_current_input",
      current.path,
    );
  }
  const historyMessages = projection.messages.slice(0, -1);
  const historyReplays = projectedReplays.filter(
    (replay) => replay.insertBeforeMessage < historyMessages.length,
  );
  const history = buildHistory(historyMessages, resolved, historyReplays);

  const currentInput = currentUserInput(current, resolved);
  if (!hasExecutableInput(currentInput)) {
    throw new RequestTransformError(
      "Current input contains no text bytes, image, document, or tool result",
      "missing_current_input",
      current.path,
    );
  }
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
  const diagnostics: RequestTransformDiagnostics = {
    projection: projection.diagnostics,
    history: {
      historyMessageCount: history.length,
      currentRole: current.role,
      currentTextChars: currentInput.content.length,
      currentImageCount: currentInput.images?.length ?? 0,
      currentDocumentCount: currentInput.documents?.length ?? 0,
      currentToolResultCount: currentInput.userInputMessageContext?.toolResults?.length ?? 0,
      reasoningReplayCount: historyReplays.length,
    },
  };
  const base = {
    request,
    resolved,
    convId,
    ...(projection.systemPrompt !== undefined ? { systemPrompt: projection.systemPrompt } : {}),
    diagnostics,
  };
  return variantEffort === undefined ? base : { ...base, variantEffort };
}
