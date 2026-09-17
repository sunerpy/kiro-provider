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
import { estimateSdkInputTokens } from "./usage-estimator.js";

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
  readonly promptCaching?: {
    readonly mode: "server-auto" | "explicit-checkpoints" | "off";
    readonly supported: boolean;
    readonly maximumCheckpoints?: number;
    readonly minimumTokens?: number;
  };
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
    let textRunStarted = false;
    let nonTextAfterText = false;
    for (const part of message.content) {
      if (part.type === "text") {
        if (nonTextAfterText) {
          throw new RequestTransformError(
            `Message ${message.path} interleaves multiple text content blocks with non-text content, but Kiro exposes only one text field and cannot preserve their ordering`,
            "unsupported_content_block_projection",
            part.path,
          );
        }
        textRunStarted = true;
      } else if (textRunStarted) {
        nonTextAfterText = true;
      }
    }
  }
}

function validateInstructionContent(instructions: readonly CanonicalMessage[]): void {
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
}

function projectLegacyReplayPrefix(
  request: CanonicalRequest,
  nativeSystemPromptEnabled: boolean,
  boundary: number,
  unversioned: boolean,
): ReturnType<typeof projectMessages> | undefined {
  if (
    !Number.isSafeInteger(boundary) ||
    boundary <= 0 ||
    boundary >= request.messages.length ||
    request.messages[boundary]?.role !== "assistant"
  ) {
    throw new RequestTransformError(
      "Historical reasoning projection does not match the current message prefix",
      "reasoning_replay_context_mismatch",
    );
  }
  const prefix = request.messages.slice(0, boundary);
  const instructions = prefix.filter(isInstruction);
  validateInstructionContent(instructions);
  const nonEmpty = instructions.filter((item) => instructionText([item]).length > 0);
  if (
    nonEmpty.length === 0 ||
    (unversioned &&
      nativeSystemPromptEnabled &&
      nativeInstructionProjection({ ...request, messages: prefix }, instructions).ok)
  )
    return undefined;

  // This is an authenticated pre-fix replay, not a new conversation. The old
  // provider actually sent this prefix/acknowledgement before minting its
  // signature. Freeze only that historical prefix; never move later steering
  // into it. The boundary is carried in every subsequent encrypted replay.
  const sourcePath = nonEmpty[0]?.path ?? "legacy-replay-prefix";
  const prefixText =
    nonEmpty.length === 1
      ? instructionText(nonEmpty)
      : nonEmpty.map((item) => `[${item.role}]\n${instructionText([item])}`).join("\n\n");
  const messages: CanonicalMessage[] = [
    {
      role: "user",
      content: [textPart(prefixText, sourcePath)],
      toolCalls: [],
      path: sourcePath,
    },
    {
      role: "assistant",
      content: [textPart("I will follow these instructions.", "legacy-replay-acknowledgement")],
      toolCalls: [],
      path: "legacy-replay-acknowledgement",
    },
  ];
  const projectedIndexByOriginal = new Map<number, number>();
  for (const [index, message] of prefix.entries()) {
    if (isInstruction(message)) continue;
    projectedIndexByOriginal.set(index, messages.length);
    messages.push(cloneMessage(message));
  }
  const suffix = projectMessages({ ...request, messages: request.messages.slice(boundary) }, false);
  for (const [index, projected] of suffix.projectedIndexByOriginal)
    projectedIndexByOriginal.set(index + boundary, projected + messages.length);
  messages.push(...suffix.messages);
  return {
    messages,
    projectedIndexByOriginal,
    diagnostics: {
      ...suffix.diagnostics,
      inputMessageCount: request.messages.length,
      outputMessageCount: messages.length,
      instructionChannel: "legacy-replay-prefix+inline-user",
      prefixInstructionCount: instructions.length,
      prefixAction: "kiro_cli_forced_role",
      legacyPrefixMessages: boundary,
    },
  };
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
  validateInstructionContent(instructions);

  const nativeProjection = nativeInstructionProjection(request, instructions);
  const useNativeProjection =
    request.projectionMode === "native-context-safe" ||
    ((request.projectionMode === "v3-auto" || request.protocol === "responses") &&
      nativeSystemPromptEnabled &&
      nativeProjection.ok);
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
        intermediateInstructionCount: 0,
        trailingInstructionCount: 0,
        prefixAction: systemPrompt === undefined ? "none" : "native_system_prompt",
        suffixAction: "none",
      },
    };
  }

  const firstExecutableIndex = request.messages.findIndex((message) => !isInstruction(message));
  const leadingEnd = firstExecutableIndex < 0 ? request.messages.length : firstExecutableIndex;
  const leadingInstructions = request.messages.slice(0, leadingEnd);
  let retainedSystemPrompt: string | undefined;
  if (
    nativeSystemPromptEnabled &&
    (request.projectionMode === "v3-auto" || request.protocol === "responses") &&
    leadingInstructions.length > 0
  ) {
    const leading = nativeInstructionProjection(
      { ...request, messages: leadingInstructions },
      leadingInstructions,
    );
    if (leading.ok) retainedSystemPrompt = leading.systemPrompt;
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
  let prefixAction: RequestProjectionDiagnostics["prefixAction"] =
    retainedSystemPrompt === undefined ? "none" : "native_system_prompt";
  let suffixAction: RequestProjectionDiagnostics["suffixAction"] = "none";

  const messages: CanonicalMessage[] = [];
  const projectedIndexByOriginal = new Map<number, number>();
  // A text-only fallback cannot retain native instruction priority, but it
  // must retain the turn where each instruction becomes effective. Never move
  // an intermediate instruction ahead of earlier work or invent an assistant
  // acknowledgement. The original-index map keeps signed replay on its actual
  // assistant message despite removed instruction messages.
  let pending: CanonicalMessage[] = [];
  const appendInstructionTurn = (trailing = false): void => {
    if (pending.length === 0) return;
    messages.push({
      role: "user",
      content: [textPart(instructionText(pending), pending[0]?.path ?? "instructions")],
      toolCalls: [],
      path: pending[0]?.path ?? "instructions",
    });
    pending = [];
    if (trailing) suffixAction = "synthetic_user";
    else if (prefixAction === "none") prefixAction = "synthetic_leading_user";
  };
  for (const [index, message] of request.messages.entries()) {
    if (isInstruction(message)) {
      if (retainedSystemPrompt !== undefined && index < leadingEnd) continue;
      const text = instructionText([message]);
      if (text.length === 0) {
        if (
          index === request.messages.length - 1 &&
          pending.length === 0 &&
          messages.at(-1)?.role === "assistant"
        ) {
          throw new RequestTransformError(
            "Current input contains no text bytes, image, document, or tool result",
            "missing_current_input",
            trailingInstructions[0]?.path ?? message.path,
          );
        }
        continue;
      }
      const previousIndex = messages.length - 1;
      const previous = messages[previousIndex];
      if (previous?.role === "user" || previous?.role === "tool") {
        // Always make this decision from the preceding turn, including after
        // a once-current instruction becomes historical. Changing its grouping
        // on the next request would invalidate prefix-bound thinking signatures.
        const separator = textFromParts(previous.content).length > 0 ? "\n\n" : "";
        messages[previousIndex] = {
          ...previous,
          content: [...previous.content, textPart(`${separator}${text}`, message.path)],
        };
        if (trailingInstructions.length > 0 && index >= trailingInstructionStart) {
          suffixAction = previous.role === "user" ? "append_user" : "append_tool";
        }
      } else {
        pending.push(message);
      }
      continue;
    }
    let projected = cloneMessage(message);
    if (pending.length > 0) {
      if (message.role === "user" || message.role === "tool") {
        projected = {
          ...projected,
          content: [
            textPart(`${instructionText(pending)}\n\n`, pending[0]?.path ?? "instructions"),
            ...projected.content,
          ],
        };
        pending = [];
        if (retainedSystemPrompt === undefined) prefixAction = "prepend_first_user";
      } else appendInstructionTurn();
    }
    projectedIndexByOriginal.set(index, messages.length);
    messages.push(projected);
  }
  appendInstructionTurn(trailingInstructions.length > 0);

  return {
    messages,
    projectedIndexByOriginal,
    ...(retainedSystemPrompt === undefined ? {} : { systemPrompt: retainedSystemPrompt }),
    diagnostics: {
      projectionMode: request.projectionMode,
      instructionChannel:
        instructions.length === 0
          ? "none"
          : retainedSystemPrompt === undefined
            ? "legacy-user-prefix"
            : "kiro-runtime-system-prompt+inline-user",
      inputMessageCount: request.messages.length,
      outputMessageCount: messages.length,
      prefixInstructionCount: leadingInstructions.length,
      intermediateInstructionCount:
        instructions.length - leadingInstructions.length - trailingInstructions.length,
      trailingInstructionCount: trailingInstructions.length,
      prefixAction,
      suffixAction,
    },
  };
}

function validateToolHistory(
  messages: readonly CanonicalMessage[],
  tools: readonly CanonicalToolDeclaration[],
  independentHistory: boolean,
): void {
  // The projection is the last line of defence, so it also scans `tool_use`
  // content parts; adapters validate only the `toolCalls` they produce.
  const violation = findToolHistoryViolation(messages, tools, {
    includeToolUseParts: true,
    allowHistoricalWithoutDeclarations: independentHistory,
  });
  if (!violation) return;
  switch (violation.kind) {
    case "missing_tool_declaration":
      throw new RequestTransformError(
        `Tool call ${violation.callId} references ${violation.toolName} without an exact declaration`,
        violation.code,
        violation.path,
      );
    case "duplicate_tool_call":
      throw new RequestTransformError(
        `Duplicate tool call id ${violation.callId}`,
        violation.code,
        violation.path,
      );
    case "orphan_tool_result":
      throw new RequestTransformError(
        `Tool result ${violation.toolCallId} has no earlier unique matching call`,
        violation.code,
        violation.path,
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
  return tools.flatMap((tool) => [
    {
      toolSpecification: {
        name: tool.wireName,
        description: tool.description as string,
        inputSchema: { json: { ...tool.inputSchema } },
      },
    },
    ...(tool.cachePoint ? [{ cachePoint: { type: "default" as const } }] : []),
  ]);
}

function clearCachePoints(
  history: CodeWhispererMessage[],
  tools: NonNullable<
    NonNullable<
      NonNullable<CodeWhispererMessage["userInputMessage"]>["userInputMessageContext"]
    >["tools"]
  >,
): void {
  for (const message of history) {
    if (message.userInputMessage) delete message.userInputMessage.cachePoint;
    if (message.assistantResponseMessage) delete message.assistantResponseMessage.cachePoint;
  }
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    if ("cachePoint" in (tools[index] ?? {})) tools.splice(index, 1);
  }
}

function countCachePoints(
  history: readonly CodeWhispererMessage[],
  tools: readonly (
    | { readonly toolSpecification: unknown }
    | { readonly cachePoint: { readonly type: "default" } }
  )[],
): number {
  return (
    history.filter(
      (message) =>
        message.userInputMessage?.cachePoint !== undefined ||
        message.assistantResponseMessage?.cachePoint !== undefined,
    ).length + tools.filter((tool) => "cachePoint" in tool).length
  );
}

function applyPromptCacheProjection(
  identity: RequestTransformIdentity,
  history: CodeWhispererMessage[],
  currentMessage: CodeWhispererMessage,
  tools: NonNullable<
    NonNullable<
      NonNullable<CodeWhispererMessage["userInputMessage"]>["userInputMessageContext"]
    >["tools"]
  >,
  systemPrompt: string | undefined,
): void {
  const capability = identity.promptCaching;
  if (capability?.mode !== "explicit-checkpoints" || capability.supported !== true) {
    clearCachePoints(history, tools);
    return;
  }
  const maximum = capability.maximumCheckpoints ?? 4;
  let count = countCachePoints(history, tools);
  if (count > maximum) {
    throw new RequestTransformError(
      `Request has ${count} cache checkpoints but Kiro allows at most ${maximum}`,
      "too_many_cache_checkpoints",
    );
  }
  const estimate = estimateSdkInputTokens({
    conversationState: {
      chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
      conversationId: "cache-estimate",
      currentMessage,
      ...(history.length > 0 ? { history } : {}),
    },
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
  });
  if (estimate < (capability.minimumTokens ?? 1)) {
    clearCachePoints(history, tools);
    return;
  }
  if (
    count < maximum &&
    tools.some((tool) => "toolSpecification" in tool) &&
    !tools.some((tool) => "cachePoint" in tool)
  ) {
    tools.push({ cachePoint: { type: "default" } });
    count += 1;
  }
  if (count < maximum) {
    const last = history.at(-1);
    if (last?.userInputMessage) last.userInputMessage.cachePoint = { type: "default" };
    else if (last?.assistantResponseMessage)
      last.assistantResponseMessage.cachePoint = { type: "default" };
  }
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
  const legacyBoundaries =
    canonical.protocol === "anthropic-messages" &&
    canonical.model === "claude-fable-5-1" &&
    canonical.projectionMode === "v3-auto"
      ? (identity.resolvedReasoningReplays ?? []).flatMap((replay) =>
          replay.instructionProjection?.legacyPrefixMessages === undefined
            ? []
            : [replay.instructionProjection.legacyPrefixMessages],
        )
      : [];
  const legacyBoundary = legacyBoundaries.reduce(
    (minimum, boundary) => Math.min(minimum, boundary),
    Infinity,
  );
  const projection =
    (legacyBoundaries.length > 0
      ? projectLegacyReplayPrefix(
          canonical,
          identity.nativeSystemPromptEnabled === true,
          legacyBoundary,
          (identity.resolvedReasoningReplays ?? [])
            .filter(
              (replay) => replay.instructionProjection?.legacyPrefixMessages === legacyBoundary,
            )
            .every((replay) => replay.legacyProjectionUnversioned === true),
        )
      : undefined) ?? projectMessages(canonical, identity.nativeSystemPromptEnabled === true);
  if (projection.messages.length === 0) {
    throw new RequestTransformError("No executable messages", "empty_input");
  }
  validateToolHistory(projection.messages, canonical.tools, canonical.protocol === "responses");

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

  const currentMessage: CodeWhispererMessage = { userInputMessage: currentInput };
  applyPromptCacheProjection(
    identity,
    history,
    currentMessage,
    suppliedTools,
    projection.systemPrompt,
  );

  const convId = identity.conversationId ?? randomUUID();
  const request: CodeWhispererRequest = {
    conversationState: {
      chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
      conversationId: convId,
      agentContinuationId: randomUUID(),
      agentTaskType: "vibe",
      currentMessage,
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
