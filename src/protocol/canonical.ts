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
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
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
