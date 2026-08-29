import type {
  CanonicalContentPart,
  CanonicalMessage,
  ResolvedReasoningReplay,
} from "../../protocol/canonical.js";
import { textFromParts } from "../../protocol/canonical.js";
import { KIRO_CONSTANTS } from "../constants.js";
import type { CodeWhispererMessage } from "../types.js";
import { toKiroDocument } from "./document-handler.js";
import { RequestTransformError } from "./errors.js";
import { convertImagesToKiroFormat, type UnifiedImage } from "./image-handler.js";

interface ToolResult {
  toolUseId: string;
  content: { text: string }[];
  status: "success" | "error";
}

type AssistantResponse = NonNullable<CodeWhispererMessage["assistantResponseMessage"]>;
type UserInput = NonNullable<CodeWhispererMessage["userInputMessage"]>;

function dataUrlImage(url: string, path: string): UnifiedImage {
  if (!url.startsWith("data:")) {
    throw new RequestTransformError(
      `Image ${path} must use a data URL because Kiro cannot fetch remote image URLs`,
      "unsupported_image_source",
    );
  }
  const [header = "", data] = url.split(",", 2);
  if (!data) {
    throw new RequestTransformError(`Image ${path} contains an invalid data URL`, "invalid_image");
  }
  const mediaType = header.split(";")[0]?.replace("data:", "") || "image/jpeg";
  return { mediaType, data };
}

function canonicalImages(parts: readonly CanonicalContentPart[]): UnifiedImage[] {
  const images: UnifiedImage[] = [];
  for (const part of parts) {
    if (part.type !== "image") continue;
    if (part.data !== undefined) {
      images.push({ mediaType: part.mediaType ?? "image/jpeg", data: part.data });
      continue;
    }
    if (part.url !== undefined) images.push(dataUrlImage(part.url, part.path));
  }
  return images;
}

function canonicalDocuments(
  parts: readonly CanonicalContentPart[],
): NonNullable<UserInput["documents"]> {
  return parts.flatMap((part) =>
    part.type === "document"
      ? [
          toKiroDocument({
            name: part.name,
            format: part.format,
            data: part.data,
            path: part.path,
          }),
        ]
      : [],
  );
}

function toolResults(parts: readonly CanonicalContentPart[]): ToolResult[] {
  return parts.flatMap((part) =>
    part.type === "tool_result"
      ? [
          {
            toolUseId: part.toolCallId,
            content: part.content.map((content) => ({ text: content.text })),
            status: part.isError ? "error" : "success",
          },
        ]
      : [],
  );
}

function asUserInput(message: CanonicalMessage, resolved: string): UserInput {
  const userInput: UserInput = {
    content: textFromParts(message.content),
    modelId: resolved,
    origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
  };
  const results = toolResults(message.content);
  if (results.length > 0) {
    userInput.userInputMessageContext = {
      toolResults: results,
    };
  }
  const images = canonicalImages(message.content);
  if (images.length > 0) {
    const converted = convertImagesToKiroFormat(images);
    if (converted.omitted > 0) {
      throw new RequestTransformError(
        `Message ${message.path} exceeds Kiro's limit of 4 images and 3.75 MB of base64 image data`,
        "too_many_images",
      );
    }
    userInput.images = converted.images;
  }
  const documents = canonicalDocuments(message.content);
  if (documents.length > 0) userInput.documents = documents;
  return userInput;
}

function replayContent(
  replay: ResolvedReasoningReplay | undefined,
): AssistantResponse["reasoningContent"] | undefined {
  if (replay === undefined) return undefined;
  return replay.content.kind === "reasoning_text"
    ? {
        reasoningText: {
          text: replay.content.text,
          signature: replay.content.signature,
        },
      }
    : { redactedContent: replay.content.bytes };
}

function asAssistantResponse(
  message: CanonicalMessage,
  replay?: ResolvedReasoningReplay,
): AssistantResponse {
  const reasoningContent = replayContent(replay);
  const assistant: AssistantResponse = {
    content: textFromParts(message.content),
    ...(reasoningContent !== undefined ? { reasoningContent } : {}),
  };
  const toolUses = [
    ...message.content.flatMap((part) =>
      part.type === "tool_use"
        ? [{ toolUseId: part.id, name: part.name, input: part.input }]
        : [],
    ),
    ...message.toolCalls.map((call) => ({
      toolUseId: call.id,
      name: call.name,
      input: call.input,
    })),
  ];
  if (toolUses.length > 0) assistant.toolUses = toolUses;
  return assistant;
}

export function buildHistory(
  messages: readonly CanonicalMessage[],
  resolved: string,
  resolvedReplays: readonly ResolvedReasoningReplay[] = [],
): CodeWhispererMessage[] {
  const replayByMessage = new Map(
    resolvedReplays.map((replay) => [replay.insertBeforeMessage, replay] as const),
  );
  const history: CodeWhispererMessage[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") {
      history.push({
        assistantResponseMessage: asAssistantResponse(message, replayByMessage.get(index)),
      });
      continue;
    }
    if (message.role === "user" || message.role === "tool") {
      history.push({ userInputMessage: asUserInput(message, resolved) });
    }
  }
  return history;
}

export function historyHasToolCalling(history: readonly CodeWhispererMessage[]): boolean {
  return history.some(
    (entry) =>
      Boolean(entry.assistantResponseMessage?.toolUses) ||
      Boolean(entry.userInputMessage?.userInputMessageContext?.toolResults),
  );
}

export function extractToolNamesFromHistory(
  history: readonly CodeWhispererMessage[],
): Set<string> {
  const names = new Set<string>();
  for (const entry of history) {
    for (const toolUse of entry.assistantResponseMessage?.toolUses ?? []) {
      if (toolUse.name) names.add(toolUse.name);
    }
  }
  return names;
}

export function currentUserInput(message: CanonicalMessage, resolved: string): UserInput {
  return asUserInput(message, resolved);
}

export function currentAssistantResponse(
  message: CanonicalMessage,
  replay?: ResolvedReasoningReplay,
): AssistantResponse {
  return asAssistantResponse(message, replay);
}
