import { createHash } from "node:crypto";

export type ProtocolProjectionMode = "safe" | "legacy-user-prefix";
export type CanonicalProtocol = "responses" | "chat-completions" | "anthropic-messages";
export type CanonicalRole = "system" | "developer" | "user" | "assistant" | "tool";

export interface CanonicalSource {
  readonly path: string;
  readonly sourceId?: string;
  readonly sourceStatus?: string;
  readonly sourceMetadata?: Readonly<Record<string, unknown>>;
}

export interface CanonicalTextPart extends CanonicalSource {
  readonly type: "text";
  readonly text: string;
}

export interface CanonicalImagePart extends CanonicalSource {
  readonly type: "image";
  readonly mediaType?: string;
  readonly data?: string;
  readonly url?: string;
}

export interface CanonicalDocumentPart extends CanonicalSource {
  readonly type: "document";
  readonly name: string;
  readonly format: "csv" | "doc" | "docx" | "html" | "md" | "pdf" | "txt" | "xls" | "xlsx";
  readonly data: string;
}

export interface CanonicalToolUsePart extends CanonicalSource {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface CanonicalToolResultPart extends CanonicalSource {
  readonly type: "tool_result";
  readonly toolCallId: string;
  readonly content: readonly CanonicalTextPart[];
  readonly isError: boolean;
}

export type CanonicalContentPart =
  | CanonicalTextPart
  | CanonicalImagePart
  | CanonicalDocumentPart
  | CanonicalToolUsePart
  | CanonicalToolResultPart;

export interface CanonicalToolCall extends CanonicalSource {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface CanonicalMessage extends CanonicalSource {
  readonly role: CanonicalRole;
  readonly content: readonly CanonicalContentPart[];
  readonly toolCalls: readonly CanonicalToolCall[];
}

export interface CanonicalToolDeclaration extends CanonicalSource {
  readonly publicType: "function" | "custom";
  readonly name: string;
  readonly wireName: string;
  readonly description?: string;
  readonly descriptionPath?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly origin?: "request" | "input";
  readonly strict?: false;
}

export interface CanonicalReasoningReplay extends CanonicalSource {
  readonly lookup:
    | { readonly kind: "responses-token"; readonly encryptedContent: string }
    | { readonly kind: "chat-hash"; readonly reasoningText: string }
    | { readonly kind: "anthropic-direct"; readonly content: KiroReasoningContent };
  readonly outputFingerprint: string;
  readonly insertBeforeMessage: number;
}

export type KiroReasoningContent =
  | {
      readonly kind: "reasoning_text";
      readonly text: string;
      readonly signature: string;
    }
  | { readonly kind: "redacted_content"; readonly bytes: Uint8Array };

export interface ResolvedReasoningReplay {
  readonly insertBeforeMessage: number;
  readonly content: KiroReasoningContent;
}

export interface CanonicalRequest {
  readonly canonicalVersion: 1;
  readonly protocol: CanonicalProtocol;
  readonly projectionMode: ProtocolProjectionMode;
  readonly model: string;
  readonly stream: boolean;
  readonly messages: readonly CanonicalMessage[];
  readonly tools: readonly CanonicalToolDeclaration[];
  readonly toolChoice: "auto" | "none";
  readonly reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  readonly requestedReasoningEffort?:
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";
  readonly thinking?: { readonly enabled: boolean; readonly budgetTokens?: number };
  readonly outputTokenLimit?: number;
  readonly instructions?: CanonicalTextPart;
  readonly reasoningReplays: readonly CanonicalReasoningReplay[];
  readonly includeEncryptedReasoning: boolean;
  readonly promptCacheKey?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface CanonicalAssistantOutput {
  readonly text: string;
  readonly toolCalls: readonly {
    readonly id: string;
    readonly name: string;
    readonly input: string;
  }[];
}

export function isCanonicalRequest(value: unknown): value is CanonicalRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "canonicalVersion" in value &&
    value.canonicalVersion === 1 &&
    "messages" in value &&
    Array.isArray(value.messages)
  );
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

export function canonicalFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

export function assistantOutputFingerprint(output: CanonicalAssistantOutput): string {
  return canonicalFingerprint({
    text: output.text,
    toolCalls: output.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      input: call.input,
    })),
  });
}

function lineageToolInput(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function lineageOutputForRequest(
  request: CanonicalRequest,
  output: CanonicalAssistantOutput,
): unknown {
  const toolsByWireName = new Map(request.tools.map((tool) => [tool.wireName, tool] as const));
  return {
    text: output.text,
    toolCalls: output.toolCalls.map((call) => {
      const declaration = toolsByWireName.get(call.name);
      let input: unknown = lineageToolInput(call.input);
      if (
        declaration?.publicType === "custom" &&
        typeof input === "object" &&
        input !== null &&
        !Array.isArray(input) &&
        Object.keys(input).length === 1 &&
        typeof (input as { readonly input?: unknown }).input === "string"
      ) {
        input = (input as { readonly input: string }).input;
      }
      return {
        id: call.id,
        name: declaration?.name ?? call.name,
        input,
      };
    }),
  };
}

export function assistantLineageFingerprint(
  request: CanonicalRequest,
  output: CanonicalAssistantOutput,
): string {
  return canonicalFingerprint(lineageOutputForRequest(request, output));
}

export function latestAssistantLineageFingerprint(request: CanonicalRequest): string | undefined {
  let latest: CanonicalMessage[] = [];
  let current: CanonicalMessage[] = [];
  for (const message of request.messages) {
    if (message.role === "assistant") {
      current.push(message);
      latest = current;
      continue;
    }
    current = [];
  }
  if (latest.length === 0) return undefined;
  return assistantLineageFingerprint(request, {
    text: latest.map((message) => textFromParts(message.content)).join(""),
    toolCalls: latest.flatMap((message) =>
      message.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        input: JSON.stringify(call.input),
      })),
    ),
  });
}

export function instructionMessages(request: CanonicalRequest): readonly CanonicalMessage[] {
  return request.messages.filter(
    (message) => message.role === "system" || message.role === "developer",
  );
}

export function textFromParts(parts: readonly CanonicalContentPart[]): string {
  return parts
    .filter((part): part is CanonicalTextPart => part.type === "text")
    .map((part) => part.text)
    .join("");
}
