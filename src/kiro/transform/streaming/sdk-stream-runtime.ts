import { auditHash } from "../../../core/audit-log.js";
import type { CanonicalAssistantOutput } from "../../../protocol/canonical.js";
import { getContextWindowSize } from "../../models.js";
import { estimateTokens } from "../response.js";

/** Mutable accumulator for fragments belonging to one SDK tool call. */
export interface ToolCallState {
  readonly toolUseId: string;
  readonly name: string;
  input: string;
  /** True once any fragment carried an `input` key, even an empty string. */
  inputReceived: boolean;
  stopped: boolean;
  fragmentCount: number;
}

export interface SdkTokenUsage {
  readonly inputTokens?: number;
  readonly uncachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly contextUsagePercentage?: number;
}

export interface SdkStreamEvent {
  readonly messageMetadataEvent?: {
    readonly conversationId?: string;
    readonly utteranceId?: string;
  };
  readonly reasoningContentEvent?: {
    readonly text?: string;
    readonly signature?: string;
    readonly redactedContent?: Uint8Array;
  };
  readonly assistantResponseEvent?: { readonly content?: string };
  readonly toolUseEvent?: {
    readonly name?: string;
    readonly toolUseId?: string;
    readonly input?: string;
    readonly stop?: boolean;
  };
  readonly metadataEvent?: {
    readonly tokenUsage?: SdkTokenUsage;
    readonly contextUsagePercentage?: number;
  };
  readonly contextUsageEvent?: { readonly contextUsagePercentage?: number };
  readonly meteringEvent?: {
    readonly usage?: number;
    readonly unit?: string;
    readonly unitPlural?: string;
  };
  readonly invalidStateEvent?: {
    readonly reason?: string;
    readonly message?: string;
  };
  readonly error?: unknown;
  readonly $unknown?: readonly [string, unknown];
}

const SAFE_STREAM_EVENT_TYPES = new Set([
  "assistantResponseEvent",
  "contextUsageEvent",
  "messageMetadataEvent",
  "metadataEvent",
  "meteringEvent",
  "reasoningContentEvent",
  "toolUseEvent",
]);

export class SemanticStreamTruncationError extends Error {
  readonly name = "SemanticStreamTruncationError";
  readonly code = "upstream_stream_incomplete";

  constructor() {
    super("Kiro event stream ended before an authoritative completion witness");
  }
}

export class SdkStreamProtocolError extends Error {
  readonly name = "SdkStreamProtocolError";

  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export type ToolCallViolationKind =
  | "missing_identity"
  | "name_changed"
  | "arguments_after_stop"
  | "missing_stop"
  | "malformed_arguments";

export type ToolCallViolationCode =
  | "invalid_upstream_tool_call"
  | "incomplete_upstream_tool_call"
  | "malformed_upstream_tool_arguments";

export interface ToolCallViolationDetails {
  readonly toolUseId?: string;
  readonly toolName?: string;
  readonly argumentsText: string;
  readonly fragmentCount: number;
}

export class ToolCallViolation extends Error {
  readonly name = "ToolCallViolation";
  readonly toolIdHash?: string;
  readonly toolNameHash?: string;
  readonly argumentLength: number;
  readonly argumentHash: string;
  readonly fragmentCount: number;

  constructor(
    message: string,
    readonly code: ToolCallViolationCode,
    readonly violationKind: ToolCallViolationKind,
    details: ToolCallViolationDetails,
  ) {
    super(message);
    if (details.toolUseId !== undefined) {
      this.toolIdHash = auditHash(details.toolUseId);
    }
    if (details.toolName !== undefined) {
      this.toolNameHash = auditHash(details.toolName);
    }
    this.argumentLength = Buffer.byteLength(details.argumentsText, "utf8");
    this.argumentHash = auditHash(details.argumentsText);
    this.fragmentCount = details.fragmentCount;
  }
}

export function sdkEventTypes(event: SdkStreamEvent): readonly string[] {
  const record = event as Readonly<Record<string, unknown>>;
  const eventTypes = Object.keys(record)
    .filter(
      (key) =>
        (key.endsWith("Event") || key === "error" || key === "$unknown") &&
        record[key] !== undefined,
    )
    .sort();
  return eventTypes.length > 0 ? eventTypes : ["unknown"];
}

export function isCompletionMetadataEvent(event: SdkStreamEvent): boolean {
  const tokenUsage = event.metadataEvent?.tokenUsage;
  return typeof tokenUsage === "object" && tokenUsage !== null;
}

export function isCompletionMeteringEvent(event: SdkStreamEvent): boolean {
  const metering = event.meteringEvent;
  return (
    typeof metering?.usage === "number" &&
    Number.isFinite(metering.usage) &&
    metering.usage >= 0 &&
    typeof metering.unit === "string" &&
    metering.unit.length > 0
  );
}

export function assertSupportedSdkEvent(event: SdkStreamEvent): void {
  const eventTypes = sdkEventTypes(event);
  if (event.error !== undefined) {
    throw new SdkStreamProtocolError(
      "Kiro returned an embedded stream error",
      "upstream_stream_error",
    );
  }
  if (event.invalidStateEvent !== undefined) {
    throw new SdkStreamProtocolError(
      "Kiro returned an invalid stream state",
      "upstream_invalid_state",
    );
  }
  if (event.$unknown !== undefined || eventTypes.includes("unknown")) {
    throw new SdkStreamProtocolError(
      "Kiro returned an unknown stream event",
      "unsupported_upstream_event",
    );
  }
  const unsupported = eventTypes.find((eventType) => !SAFE_STREAM_EVENT_TYPES.has(eventType));
  if (unsupported !== undefined) {
    throw new SdkStreamProtocolError(
      `Kiro returned unsupported stream event type ${unsupported}`,
      "unsupported_upstream_event",
    );
  }
}

export interface SdkReasoningCapture {
  readonly text: string;
  readonly signature?: string;
  readonly redactedContent?: Uint8Array;
}

export interface SdkReasoningCaptureState {
  text: string;
  signature: string;
  signatureConflict: boolean;
  redactedChunks: Uint8Array[];
}

export type SdkReasoningCaptureHandler = (
  capture: SdkReasoningCapture,
  outputFingerprint: string,
) => string | undefined;

export type SdkOutputFingerprint = (output: CanonicalAssistantOutput) => string;
export type SdkOutputCaptureHandler = (
  output: CanonicalAssistantOutput,
  outputFingerprint: string,
) => void;

export function createReasoningCaptureState(): SdkReasoningCaptureState {
  return { text: "", signature: "", signatureConflict: false, redactedChunks: [] };
}

export function appendReasoningCapture(
  state: SdkReasoningCaptureState,
  event: SdkStreamEvent["reasoningContentEvent"],
): void {
  if (!event) return;
  state.text += event.text ?? "";
  if (event.signature !== undefined && event.signature.length > 0) {
    if (state.signature.length > 0 && state.signature !== event.signature) {
      state.signatureConflict = true;
    }
    state.signature = event.signature;
  }
  if (event.redactedContent && event.redactedContent.byteLength > 0) {
    state.redactedChunks.push(event.redactedContent);
  }
}

export function resolveReasoningCapture(state: SdkReasoningCaptureState): SdkReasoningCapture {
  const redactedLength = state.redactedChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  let redactedContent: Uint8Array | undefined;
  if (redactedLength > 0) {
    redactedContent = new Uint8Array(redactedLength);
    let offset = 0;
    for (const chunk of state.redactedChunks) {
      redactedContent.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  const mixedTextAndRedacted = state.text.length > 0 && redactedContent !== undefined;
  const completeSignedText =
    state.text.length > 0 &&
    state.signature.length > 0 &&
    !state.signatureConflict &&
    redactedContent === undefined;
  const completeRedacted = state.text.length === 0 && redactedContent !== undefined;
  return {
    text: state.text,
    ...(completeSignedText ? { signature: state.signature } : {}),
    ...(!mixedTextAndRedacted && completeRedacted ? { redactedContent } : {}),
  };
}

export interface SdkStreamResponse {
  readonly generateAssistantResponseResponse?: AsyncIterable<SdkStreamEvent>;
}

export type NextSdkEvent =
  | { readonly kind: "event"; readonly result: IteratorResult<SdkStreamEvent> }
  | { readonly kind: "aborted" };

export interface UsageState {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextUsagePercentage?: number;
}

export async function nextSdkEvent(
  iterator: AsyncIterator<SdkStreamEvent>,
  signal?: AbortSignal,
): Promise<NextSdkEvent> {
  if (signal?.aborted) return { kind: "aborted" };

  const nextPromise = iterator.next();
  if (!signal) return { kind: "event", result: await nextPromise };

  return new Promise<NextSdkEvent>((resolve, reject) => {
    const onAbort = (): void => resolve({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
    void nextPromise.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ kind: "event", result });
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function appendToolFragment(
  toolCalls: Map<string, ToolCallState>,
  event: SdkStreamEvent["toolUseEvent"],
): void {
  if (!event) return;
  if (!event.name || !event.toolUseId) {
    throw new ToolCallViolation(
      "Kiro emitted a tool call without both name and toolUseId",
      "invalid_upstream_tool_call",
      "missing_identity",
      {
        ...(event.toolUseId !== undefined ? { toolUseId: event.toolUseId } : {}),
        ...(event.name !== undefined ? { toolName: event.name } : {}),
        argumentsText: event.input ?? "",
        fragmentCount: 1,
      },
    );
  }

  const existing = toolCalls.get(event.toolUseId);
  if (existing) {
    if (existing.name !== event.name) {
      throw new ToolCallViolation(
        "Kiro changed a tool name while streaming one tool call",
        "invalid_upstream_tool_call",
        "name_changed",
        {
          toolUseId: existing.toolUseId,
          toolName: existing.name,
          argumentsText: existing.input + (event.input ?? ""),
          fragmentCount: existing.fragmentCount + 1,
        },
      );
    }
    if (existing.stopped && (event.input ?? "").length > 0) {
      throw new ToolCallViolation(
        "Kiro emitted tool arguments after the tool call stopped",
        "invalid_upstream_tool_call",
        "arguments_after_stop",
        {
          toolUseId: existing.toolUseId,
          toolName: existing.name,
          argumentsText: existing.input + (event.input ?? ""),
          fragmentCount: existing.fragmentCount + 1,
        },
      );
    }
    existing.input += event.input ?? "";
    existing.inputReceived ||= event.input !== undefined;
    existing.stopped ||= event.stop === true;
    existing.fragmentCount += 1;
    return;
  }

  toolCalls.set(event.toolUseId, {
    toolUseId: event.toolUseId,
    name: event.name,
    input: event.input ?? "",
    inputReceived: event.input !== undefined,
    stopped: event.stop === true,
    fragmentCount: 1,
  });
}

export function validateCompletedToolCalls(toolCalls: ReadonlyMap<string, ToolCallState>): void {
  for (const toolCall of toolCalls.values()) {
    if (!toolCall.stopped) {
      throw new ToolCallViolation(
        "Kiro ended before a streamed tool call emitted its stop marker",
        "incomplete_upstream_tool_call",
        "missing_stop",
        {
          toolUseId: toolCall.toolUseId,
          toolName: toolCall.name,
          argumentsText: toolCall.input,
          fragmentCount: toolCall.fragmentCount,
        },
      );
    }
    // Probe evidence (2026-09-02): a zero-parameter Kiro tool call arrives as
    // `{toolUseId, name}` then `{toolUseId, name, stop: true}` with no `input`
    // key at all. Only that shape is projected as `{}`; any received fragment,
    // including an empty or whitespace-only string, must still parse as JSON.
    if (!toolCall.inputReceived) {
      toolCall.input = "{}";
      continue;
    }
    try {
      JSON.parse(toolCall.input);
    } catch {
      throw new ToolCallViolation(
        "Kiro returned malformed JSON arguments for a completed tool call",
        "malformed_upstream_tool_arguments",
        "malformed_arguments",
        {
          toolUseId: toolCall.toolUseId,
          toolName: toolCall.name,
          argumentsText: toolCall.input,
          fragmentCount: toolCall.fragmentCount,
        },
      );
    }
  }
}

export function updateUsageState(usage: UsageState, event: SdkStreamEvent): void {
  const tokenUsage = event.metadataEvent?.tokenUsage;
  if (tokenUsage) {
    usage.outputTokens = tokenUsage.outputTokens ?? usage.outputTokens;
    usage.totalTokens = tokenUsage.totalTokens ?? usage.totalTokens;
    usage.inputTokens =
      tokenUsage.inputTokens ??
      (tokenUsage.uncachedInputTokens === undefined
        ? usage.inputTokens
        : tokenUsage.uncachedInputTokens +
          (tokenUsage.cacheReadInputTokens ?? 0) +
          (tokenUsage.cacheWriteInputTokens ?? 0));
  }

  usage.contextUsagePercentage =
    event.contextUsageEvent?.contextUsagePercentage ??
    event.metadataEvent?.contextUsagePercentage ??
    tokenUsage?.contextUsagePercentage ??
    usage.contextUsagePercentage;
}

export function resolveUsage(
  usage: UsageState,
  textOnlyContent: string,
  model: string,
): { readonly inputTokens: number; readonly outputTokens: number } {
  const outputTokens = usage.outputTokens ?? estimateTokens(textOnlyContent);
  let inputTokens = usage.inputTokens;

  if (inputTokens === undefined && usage.totalTokens !== undefined) {
    inputTokens = Math.max(0, usage.totalTokens - outputTokens);
  }
  if (
    inputTokens === undefined &&
    usage.contextUsagePercentage !== undefined &&
    usage.contextUsagePercentage > 0
  ) {
    const totalTokens = Math.round(
      (getContextWindowSize(model) * usage.contextUsagePercentage) / 100,
    );
    inputTokens = Math.max(0, totalTokens - outputTokens);
  }

  return { inputTokens: inputTokens ?? 0, outputTokens };
}
