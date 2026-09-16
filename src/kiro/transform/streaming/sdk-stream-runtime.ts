import { auditHash } from "../../../core/audit-log.js";
import type { CanonicalAssistantOutput } from "../../../protocol/canonical.js";
import type { CanonicalOutputUsage } from "../../../protocol/output.js";
import {
  InvalidTokenUsageError,
  normalizeReportedUsage,
  REPORTED_USAGE_KEYS,
  type ReportedTokenUsage,
} from "../../../protocol/usage.js";
import { estimateGeneratedTokens } from "../usage-estimator.js";

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
  readonly reasoningTokens?: number;
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

/**
 * A provider-local side effect of finishing a stream failed: encrypting and
 * storing reasoning for replay, or recording the output-lineage row. The
 * upstream had already delivered its output by then, so this failure says
 * nothing about upstream or account health and moving the next request to
 * another account cannot repair it.
 *
 * The client contract is unchanged — the code is deliberately outside the
 * stream-failure table, so it normalizes to the same retryable
 * `upstream_stream_error` the transport reports — but the class is what keeps
 * local faults out of health accounting.
 */
export class OutputPersistenceError extends Error {
  readonly name = "OutputPersistenceError";
  readonly code = "local_output_persistence_failed";

  constructor(options?: ErrorOptions) {
    super("Recording provider-local stream output failed", options);
  }
}

export class SdkStreamProtocolError extends Error {
  readonly name = "SdkStreamProtocolError";

  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type ToolCallViolationKind =
  | "missing_identity"
  | "name_changed"
  | "arguments_after_stop"
  | "missing_stop"
  | "arguments_too_large"
  | "malformed_arguments";

export type ToolCallViolationCode =
  | "invalid_upstream_tool_call"
  | "incomplete_upstream_tool_call"
  | "upstream_tool_arguments_too_large"
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
      { cause: event.error },
    );
  }
  if (event.invalidStateEvent !== undefined) {
    throw new SdkStreamProtocolError(
      "Kiro returned an invalid stream state",
      "upstream_invalid_state",
      { cause: event.invalidStateEvent },
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
    state.signature.length > 0 && !state.signatureConflict && redactedContent === undefined;
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
  uncachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  contextUsagePercentage?: number;
  metering?: { readonly value: number; readonly unit: string };
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

export function validateCompletedToolCalls(
  toolCalls: ReadonlyMap<string, ToolCallState>,
  validateArguments?: import("../../../core/tool-output-validation.js").ValidateToolArguments,
): void {
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
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(toolCall.input);
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
    validateArguments?.(toolCall.name, parsed);
  }
}

export function updateUsageState(usage: UsageState, event: SdkStreamEvent): void {
  const tokenUsage = event.metadataEvent?.tokenUsage;
  if (tokenUsage) {
    // Metadata contains snapshots, not deltas. Preserve missing versus explicit zero.
    for (const key of REPORTED_USAGE_KEYS) {
      if (tokenUsage[key] === undefined) delete usage[key];
      else usage[key] = tokenUsage[key];
    }
  }
  usage.contextUsagePercentage =
    event.contextUsageEvent?.contextUsagePercentage ??
    event.metadataEvent?.contextUsagePercentage ??
    tokenUsage?.contextUsagePercentage ??
    usage.contextUsagePercentage;
  if (isCompletionMeteringEvent(event)) {
    usage.metering = {
      value: event.meteringEvent?.usage as number,
      unit: event.meteringEvent?.unit as string,
    };
  }
}

export function resolveUsage(
  usage: UsageState,
  textOnlyContent: string,
  _model: string,
  options: {
    readonly inputTokenEstimate?: number | (() => number);
    readonly contextUsageWindow?: number;
    readonly toolCalls?: readonly { readonly name: string; readonly input: string }[];
    readonly reasoning?: unknown;
  } = {},
): CanonicalOutputUsage {
  let reported: ReportedTokenUsage;
  try {
    reported = normalizeReportedUsage(usage);
  } catch (error) {
    if (error instanceof InvalidTokenUsageError) {
      throw new SdkStreamProtocolError(error.message, error.code, { cause: error });
    }
    throw error;
  }
  const generated =
    reported.outputTokens === undefined
      ? estimateGeneratedTokens(
          textOnlyContent,
          options.toolCalls,
          reported.reasoningTokens === undefined ? options.reasoning : undefined,
        )
      : { outputTokens: reported.outputTokens };
  let outputTokens =
    reported.outputTokens ?? generated.outputTokens + (reported.reasoningTokens ?? 0);
  const minimumInput =
    (reported.uncachedInputTokens ?? 0) +
    (reported.cacheReadInputTokens ?? 0) +
    (reported.cacheWriteInputTokens ?? 0);
  let inputTokens =
    reported.inputTokens ??
    (typeof options.inputTokenEstimate === "function"
      ? options.inputTokenEstimate()
      : options.inputTokenEstimate) ??
    0;
  inputTokens = Math.max(inputTokens, minimumInput);
  const percentage = usage.contextUsagePercentage;
  const window = options.contextUsageWindow;
  const hasPercentage =
    percentage !== undefined &&
    Number.isFinite(percentage) &&
    percentage >= 0 &&
    percentage <= 100 &&
    window !== undefined &&
    Number.isSafeInteger(window) &&
    window > 0;
  const observed = hasPercentage ? Math.round((window * percentage) / 100) : undefined;
  const saturated = hasPercentage && percentage === 100;
  let context: "upstream" | "percentage" | "percentage_lower_bound" | "tokenizer" | "unavailable" =
    reported.totalTokens !== undefined
      ? "upstream"
      : options.inputTokenEstimate !== undefined
        ? "tokenizer"
        : "unavailable";
  if (reported.totalTokens === undefined && observed !== undefined) {
    // Kiro's GPT percentage still uses the old raw 272k basis and clips at 100.
    // It cannot be multiplied by the corrected 872k public prompt capacity.
    // Once clipped it is only a lower bound; count the actual projected request.
    const minimumOutput = reported.outputTokens ?? reported.reasoningTokens ?? 0;
    const measuredFloor = (reported.inputTokens ?? minimumInput) + minimumOutput;
    if (!saturated && observed > 0 && observed >= measuredFloor) {
      // An available, calibrated observation outranks local rendering heuristics.
      context = "percentage";
      if (reported.inputTokens !== undefined) outputTokens = observed - inputTokens;
      else {
        outputTokens = Math.min(outputTokens, observed - minimumInput);
        inputTokens = observed - outputTokens;
      }
    } else {
      const total = Math.max(inputTokens + outputTokens, observed);
      if (total === observed && saturated) context = "percentage_lower_bound";
      if (reported.inputTokens !== undefined) outputTokens = total - inputTokens;
      else inputTokens = total - outputTokens;
    }
  }
  if (reported.totalTokens !== undefined) {
    // A measured total must never be enlarged by an estimate of one side.
    if (reported.inputTokens === undefined) {
      outputTokens = Math.min(outputTokens, reported.totalTokens - minimumInput);
      inputTokens = reported.totalTokens - outputTokens;
    } else {
      outputTokens = reported.totalTokens - reported.inputTokens;
    }
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    reported,
    accounting: {
      input: reported.inputTokens !== undefined ? "upstream" : "estimated",
      output: reported.outputTokens !== undefined ? "upstream" : "estimated",
      context,
      ...(percentage !== undefined && Number.isFinite(percentage) && percentage >= 0
        ? { contextUsagePercentage: percentage }
        : {}),
      ...(hasPercentage ? { contextUsageWindow: window, percentageSaturated: saturated } : {}),
      ...(usage.metering ? { metering: usage.metering } : {}),
    },
  };
}
