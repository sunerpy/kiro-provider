import type { z } from "zod";
import type { EffortSchema, RegionSchema } from "./regions.js";

export type KiroAuthMethod = "idc" | "desktop";
export type KiroRegion = z.infer<typeof RegionSchema>;
export type Effort = z.infer<typeof EffortSchema>;

export interface KiroAuthDetails {
  refresh: string;
  access: string;
  expires: number;
  authMethod: KiroAuthMethod;
  region: KiroRegion;
  oidcRegion?: KiroRegion;
  clientId?: string;
  clientSecret?: string;
  email?: string;
  profileArn?: string;
}

export interface KiroUsageSnapshot {
  usedCount: number;
  limitCount: number;
  overageCount: number;
  email?: string;
  /** Upstream quota reset time in epoch milliseconds, when the usage service reports one. */
  resetAt?: number;
}

export interface RefreshParts {
  refreshToken: string;
  clientId?: string;
  clientSecret?: string;
  profileArn?: string;
  authMethod?: KiroAuthMethod;
}

export interface ManagedAccount {
  id: string;
  email: string;
  authMethod: KiroAuthMethod;
  region: KiroRegion;
  oidcRegion?: KiroRegion;
  clientId?: string;
  clientSecret?: string;
  profileArn?: string;
  startUrl?: string;
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  rateLimitResetTime: number;
  isHealthy: boolean;
  unhealthyReason?: string;
  recoveryTime?: number;
  failCount: number;
  usedCount?: number;
  limitCount?: number;
  overageCount?: number;
  lastSync?: number;
  lastUsed?: number;
}

export interface CodeWhispererMessage {
  userInputMessage?: {
    content: string;
    modelId: string;
    origin: string;
    images?: Array<{ format: "gif" | "jpeg" | "png" | "webp"; source: { bytes: Uint8Array } }>;
    documents?: Array<{
      name: string;
      format: "csv" | "doc" | "docx" | "html" | "md" | "pdf" | "txt" | "xls" | "xlsx";
      source: { bytes: Uint8Array };
    }>;
    userInputMessageContext?: {
      toolResults?: Array<{
        toolUseId: string;
        content: Array<{ text?: string }>;
        status?: string;
      }>;
      tools?: Array<{
        toolSpecification: {
          name: string;
          description: string;
          inputSchema: { json: Record<string, unknown> };
        };
      }>;
    };
  };
  assistantResponseMessage?: {
    content: string;
    reasoningContent?:
      | { reasoningText: { text: string; signature: string } }
      | { redactedContent: Uint8Array };
    toolUses?: Array<{
      input: unknown;
      name: string;
      toolUseId: string;
    }>;
  };
}

export interface CodeWhispererRequest {
  conversationState: {
    chatTriggerType: string;
    conversationId: string;
    agentContinuationId?: string;
    agentTaskType?: "vibe" | "spectask";
    history?: CodeWhispererMessage[];
    currentMessage: CodeWhispererMessage;
  };
  profileArn?: string;
}

export interface ToolCall {
  toolUseId: string;
  name: string;
  input: string | Record<string, unknown>;
}

export interface ParsedResponse {
  content: string;
  toolCalls: ToolCall[];
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface PreparedRequest {
  url: string;
  init: RequestInit;
  streaming: boolean;
  effectiveModel: string;
  conversationId: string;
}

export type InstructionPrefixAction = "none" | "prepend_first_user" | "synthetic_leading_user";

export type InstructionSuffixAction = "none" | "append_user" | "append_tool" | "synthetic_user";

export interface RequestProjectionDiagnostics {
  readonly projectionMode: "safe" | "legacy-user-prefix";
  readonly inputMessageCount: number;
  readonly outputMessageCount: number;
  readonly prefixInstructionCount: number;
  readonly trailingInstructionCount: number;
  readonly prefixAction: InstructionPrefixAction;
  readonly suffixAction: InstructionSuffixAction;
}

export interface RequestHistoryDiagnostics {
  readonly historyMessageCount: number;
  readonly currentRole: "user" | "tool";
  readonly currentTextChars: number;
  readonly currentImageCount: number;
  readonly currentDocumentCount: number;
  readonly currentToolResultCount: number;
  readonly reasoningReplayCount: number;
}

export interface RequestTransformDiagnostics {
  readonly projection: RequestProjectionDiagnostics;
  readonly history: RequestHistoryDiagnostics;
}

export interface SdkPreparedRequest {
  conversationState: CodeWhispererRequest["conversationState"];
  profileArn?: string;
  additionalModelRequestFields?: Readonly<Record<string, unknown>>;
  streaming: boolean;
  effectiveModel: string;
  conversationId: string;
  region: string;
  /** Resolved effort level for thinking models */
  effort?: Effort;
  diagnostics: RequestTransformDiagnostics;
}

export type AccountSelectionStrategy = "sticky" | "round-robin" | "lowest-usage";
