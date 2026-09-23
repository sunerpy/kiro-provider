import { isRecord } from "../../protocol/adapter-utils.js";
import type { CanonicalRequest, CanonicalToolDeclaration } from "../../protocol/canonical.js";
import {
  type CodeReference,
  type CodeReferenceMetadata,
  codeReferenceMetadata,
} from "../../protocol/code-references.js";
import type { CanonicalOutputUsage } from "../../protocol/output.js";
import {
  hasCompleteReportedUsage,
  InvalidTokenUsageError,
  normalizeReportedUsage,
  parseReportedUsage,
  parseUsageAccounting,
} from "../../protocol/usage.js";
import type { LocalStructuredOutputFormat } from "./structured-output.js";

export type OutputTextContent = {
  readonly type: "output_text";
  readonly text: string;
  readonly annotations: readonly [];
  readonly logprobs?: readonly [];
};

export type SummaryText = {
  readonly type: "summary_text";
  readonly text: string;
};

export type MessageOutputItem = {
  readonly id: string;
  readonly type: "message";
  readonly role: "assistant";
  readonly phase?: "commentary" | "final_answer" | null;
  readonly status: "in_progress" | "completed";
  readonly content: readonly OutputTextContent[];
};

export type ReasoningOutputItem = {
  readonly id: string;
  readonly type: "reasoning";
  readonly summary: readonly SummaryText[];
  readonly encrypted_content?: string;
};

export type FunctionCallOutputItem = {
  readonly id: string;
  readonly type: "function_call";
  readonly call_id: string;
  readonly namespace?: string;
  readonly name: string;
  readonly arguments: string;
  readonly status?: "in_progress" | "completed";
};

export type CustomToolCallOutputItem = {
  readonly id: string;
  readonly type: "custom_tool_call";
  readonly call_id: string;
  readonly namespace?: string;
  readonly name: string;
  readonly input: string;
  readonly status?: "in_progress" | "completed";
};

export type ResponseToolCallItem = FunctionCallOutputItem | CustomToolCallOutputItem;

export type ResponseOutputItem = MessageOutputItem | ReasoningOutputItem | ResponseToolCallItem;

export type ResponseUsage = {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly input_tokens_details?: Readonly<Record<string, unknown>>;
  readonly output_tokens_details?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export function outputTextContent(text: string): OutputTextContent {
  return { type: "output_text", text, annotations: [], logprobs: [] };
}

export function responseUsage(
  usage: CanonicalOutputUsage,
  mode: "compatible" | "strict" = "compatible",
): ResponseUsage | undefined {
  const reported = normalizeReportedUsage(usage.reported ?? {});
  const complete = hasCompleteReportedUsage(reported);
  if (mode === "strict" && !complete) return undefined;
  const unknown = [
    ...(reported.cacheReadInputTokens === undefined ? ["input_tokens_details.cached_tokens"] : []),
    ...(reported.cacheWriteInputTokens === undefined
      ? ["input_tokens_details.cache_write_tokens"]
      : []),
    ...(reported.reasoningTokens === undefined ? ["output_tokens_details.reasoning_tokens"] : []),
  ];
  return {
    input_tokens: reported.inputTokens ?? usage.inputTokens,
    output_tokens: reported.outputTokens ?? usage.outputTokens,
    total_tokens: reported.totalTokens ?? usage.totalTokens,
    // Codex requires these primary fields whenever the details object is present.
    ...(reported.cacheReadInputTokens !== undefined
      ? {
          input_tokens_details: {
            cached_tokens: reported.cacheReadInputTokens,
            ...(reported.cacheWriteInputTokens !== undefined
              ? { cache_write_tokens: reported.cacheWriteInputTokens }
              : {}),
          },
        }
      : {}),
    ...(reported.reasoningTokens !== undefined
      ? {
          output_tokens_details: { reasoning_tokens: reported.reasoningTokens },
        }
      : {}),
    ...(!complete || usage.accounting?.metering
      ? {
          metadata: {
            kiro: {
              source: complete
                ? "upstream"
                : reported.inputTokens !== undefined && reported.outputTokens !== undefined
                  ? "upstream_partial"
                  : "estimated",
              estimated_fields: [
                ...(reported.inputTokens === undefined ? ["input_tokens"] : []),
                ...(reported.outputTokens === undefined ? ["output_tokens"] : []),
                ...(reported.totalTokens === undefined ? ["total_tokens"] : []),
              ],
              unknown_fields: unknown,
              ...(reported.cacheReadInputTokens === undefined &&
              reported.cacheWriteInputTokens !== undefined
                ? { relocated_fields: ["input_tokens_details.cache_write_tokens"] }
                : {}),
              ...(Object.keys(reported).length ? { reported } : {}),
              context: {
                tokens: usage.totalTokens,
                source: usage.accounting?.context ?? "legacy_estimate",
                ...(usage.accounting?.contextUsagePercentage !== undefined
                  ? {
                      percentage: usage.accounting.contextUsagePercentage,
                      percentage_window: usage.accounting.contextUsageWindow,
                      percentage_saturated: usage.accounting.percentageSaturated,
                    }
                  : {}),
              },
              ...(usage.accounting?.metering ? { metering: usage.accounting.metering } : {}),
            },
          },
        }
      : {}),
  };
}

/** Validate native counts without dropping cache fields or inventing missing splits. */
export function normalizeNativeUsage(
  value: unknown,
  mode: "compatible" | "strict" = "compatible",
): ResponseUsage | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new InvalidTokenUsageError("Upstream usage must be an object");
  for (const key of ["input_tokens_details", "output_tokens_details"]) {
    if (value[key] !== undefined && value[key] !== null && !isRecord(value[key])) {
      throw new InvalidTokenUsageError(`Upstream ${key} must be an object`);
    }
  }
  const input = isRecord(value.input_tokens_details) ? value.input_tokens_details : {};
  const output = isRecord(value.output_tokens_details) ? value.output_tokens_details : {};
  const reported = normalizeReportedUsage({
    inputTokens: (value.input_tokens ?? undefined) as number | undefined,
    outputTokens: (value.output_tokens ?? undefined) as number | undefined,
    totalTokens: (value.total_tokens ?? undefined) as number | undefined,
    cacheReadInputTokens: (input.cached_tokens ?? undefined) as number | undefined,
    cacheWriteInputTokens: (input.cache_write_tokens ?? undefined) as number | undefined,
    reasoningTokens: (output.reasoning_tokens ?? undefined) as number | undefined,
  });
  if (
    reported.inputTokens === undefined ||
    reported.outputTokens === undefined ||
    reported.totalTokens === undefined
  ) {
    return undefined;
  }
  const normalized = responseUsage(
    {
      inputTokens: reported.inputTokens,
      outputTokens: reported.outputTokens,
      totalTokens: reported.totalTokens,
      reported,
      accounting: { input: "upstream", output: "upstream", context: "upstream" },
    },
    mode,
  );
  if (!normalized) return undefined;
  const {
    input_tokens_details: _inputDetails,
    output_tokens_details: _outputDetails,
    ...rest
  } = value;
  const metadata = { ...(isRecord(value.metadata) ? value.metadata : {}), ...normalized.metadata };
  if (
    (!normalized.input_tokens_details && Object.keys(input).length) ||
    (!normalized.output_tokens_details && Object.keys(output).length)
  ) {
    metadata.kiro = {
      ...(isRecord(metadata.kiro) ? metadata.kiro : {}),
      ...(!normalized.input_tokens_details && Object.keys(input).length
        ? { upstream_input_tokens_details: input }
        : {}),
      ...(!normalized.output_tokens_details && Object.keys(output).length
        ? { upstream_output_tokens_details: output }
        : {}),
    };
  }
  return {
    ...rest,
    ...normalized,
    ...(normalized.input_tokens_details
      ? {
          input_tokens_details: { ...input, ...normalized.input_tokens_details },
        }
      : {}),
    ...(normalized.output_tokens_details
      ? {
          output_tokens_details: { ...output, ...normalized.output_tokens_details },
        }
      : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };
}

/** Preserve measurement provenance when a stored response becomes an internal completion. */
export function canonicalUsageFromResponse(usage: ResponseUsage | undefined): CanonicalOutputUsage {
  if (!usage)
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      reported: {},
      accounting: { input: "estimated", output: "estimated", context: "unavailable" },
    };
  const metadata = isRecord(usage.metadata?.kiro) ? usage.metadata.kiro : undefined;
  const extracted = parseReportedUsage({
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    ...(usage.input_tokens_details?.cached_tokens !== undefined
      ? { cacheReadInputTokens: usage.input_tokens_details.cached_tokens }
      : {}),
    ...(usage.input_tokens_details?.cache_write_tokens !== undefined
      ? { cacheWriteInputTokens: usage.input_tokens_details.cache_write_tokens }
      : {}),
    ...(usage.output_tokens_details?.reasoning_tokens !== undefined
      ? { reasoningTokens: usage.output_tokens_details.reasoning_tokens }
      : {}),
  });
  const reported = metadata
    ? (parseReportedUsage(metadata.reported) ?? {})
    : hasCompleteReportedUsage(extracted)
      ? (extracted ?? {})
      : {};
  const context = isRecord(metadata?.context) ? metadata.context : {};
  const accounting = parseUsageAccounting({
    input: reported.inputTokens === undefined ? "estimated" : "upstream",
    output: reported.outputTokens === undefined ? "estimated" : "upstream",
    context: context.source ?? (hasCompleteReportedUsage(reported) ? "upstream" : "unavailable"),
    ...(context.percentage !== undefined ? { contextUsagePercentage: context.percentage } : {}),
    ...(context.percentage_window !== undefined
      ? { contextUsageWindow: context.percentage_window }
      : {}),
    ...(context.percentage_saturated !== undefined
      ? { percentageSaturated: context.percentage_saturated }
      : {}),
    ...(metadata?.metering !== undefined ? { metering: metadata.metering } : {}),
  });
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    reported,
    ...(accounting ? { accounting } : {}),
  };
}

// Non-stream responses build items directly; normalize the additive OpenAI
// fields here so the JSON body and the SSE item events describe the same shape.
function normalizedOutputItem(item: ResponseOutputItem): ResponseOutputItem {
  if (item.type === "message") {
    return {
      ...item,
      content: item.content.map((part) =>
        part.logprobs === undefined ? { ...part, logprobs: [] } : part,
      ),
    };
  }
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    return item.status === undefined ? { ...item, status: "completed" } : item;
  }
  return item;
}

export type ResponseError = {
  readonly type?: "upstream_error";
  readonly code: string;
  readonly message: string;
  readonly param?: string;
  readonly request_id?: string;
  readonly details?: import("../../core/request-diagnostics.js").FailureDiagnostics;
};

export type ResponseStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled";

export type ResponseFunctionTool = {
  readonly type: "function";
  readonly name: string;
  readonly description?: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly strict: false;
};

export type ResponseCustomTool = {
  readonly type: "custom";
  readonly name: string;
  readonly description?: string;
};

export type ResponseTool = ResponseFunctionTool | ResponseCustomTool;

export type ResponseTextFormat = { readonly type: "text" } | LocalStructuredOutputFormat;

export interface ResponseRequestConfiguration {
  readonly instructions: string | null;
  readonly maxOutputTokens: number | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly reasoningEffort: CanonicalRequest["requestedReasoningEffort"] | null;
  readonly toolChoice: "auto" | "none";
  readonly parallelToolCalls?: boolean;
  readonly tools: readonly ResponseTool[];
  readonly store?: boolean;
  readonly previousResponseId?: string | null;
  readonly serviceTier?: "auto" | "default";
  readonly user?: string;
  readonly textFormat?: ResponseTextFormat;
}

function responseTool(tool: CanonicalToolDeclaration): ResponseTool {
  if (tool.publicType === "custom") {
    return {
      type: "custom",
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
    };
  }
  return {
    type: "function",
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    parameters: tool.inputSchema,
    strict: false,
  };
}

export function responseConfigurationFromCanonical(
  request: CanonicalRequest,
): ResponseRequestConfiguration {
  return {
    instructions: request.instructions?.text ?? null,
    maxOutputTokens: request.outputTokenLimit ?? null,
    metadata: request.metadata ?? {},
    reasoningEffort: request.requestedReasoningEffort ?? null,
    toolChoice: request.toolChoice,
    parallelToolCalls: request.parallelToolCalls,
    tools: request.tools.filter((tool) => tool.origin === "request").map(responseTool),
    store: request.store ?? false,
    previousResponseId: request.previousResponseId ?? null,
    serviceTier: request.serviceTier,
    user: request.user,
  };
}

const DEFAULT_CONFIGURATION: ResponseRequestConfiguration = {
  instructions: null,
  maxOutputTokens: null,
  metadata: {},
  reasoningEffort: null,
  toolChoice: "auto",
  tools: [],
  store: false,
  previousResponseId: null,
  serviceTier: undefined,
  user: undefined,
};

export interface ResponseStateObject extends CodeReferenceMetadata {
  readonly id: string;
  readonly object: "response";
  readonly created_at: number;
  readonly completed_at: number | null;
  readonly status: ResponseStatus;
  readonly background: false;
  readonly error: ResponseError | null;
  readonly incomplete_details: { readonly reason: string } | null;
  readonly instructions: string | null;
  readonly max_output_tokens: number | null;
  readonly max_tool_calls: null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly model: string;
  readonly output: readonly ResponseOutputItem[];
  readonly parallel_tool_calls: boolean;
  readonly previous_response_id: string | null;
  readonly reasoning: {
    readonly effort: CanonicalRequest["requestedReasoningEffort"] | null;
    readonly summary: null;
  };
  readonly service_tier: "auto" | "default" | null;
  readonly store: boolean;
  readonly temperature: null;
  readonly text: { readonly format: ResponseTextFormat };
  readonly tool_choice: "auto" | "none";
  readonly tools: readonly ResponseTool[];
  readonly top_logprobs: null;
  readonly top_p: null;
  readonly truncation: "disabled";
  readonly user: string | null;
  readonly usage?: ResponseUsage;
  readonly usage_metadata?: { readonly metadata: Readonly<Record<string, unknown>> };
}

export function responseState(input: {
  readonly id: string;
  readonly model: string;
  readonly status: ResponseStatus;
  readonly output?: readonly ResponseOutputItem[];
  readonly usage?: ResponseUsage;
  readonly error?: ResponseError;
  readonly createdAt?: number;
  readonly completedAt?: number;
  readonly configuration?: ResponseRequestConfiguration;
  readonly codeReferences?: readonly CodeReference[];
}): ResponseStateObject {
  const configuration = input.configuration ?? DEFAULT_CONFIGURATION;
  return {
    id: input.id,
    object: "response",
    created_at: input.createdAt ?? Math.floor(Date.now() / 1000),
    completed_at:
      input.status === "completed" ? (input.completedAt ?? Math.floor(Date.now() / 1000)) : null,
    status: input.status,
    background: false,
    error: input.error ?? null,
    incomplete_details: null,
    instructions: configuration.instructions,
    max_output_tokens: configuration.maxOutputTokens,
    max_tool_calls: null,
    metadata: configuration.metadata,
    model: input.model,
    output: (input.output ?? []).map(normalizedOutputItem),
    parallel_tool_calls: configuration.parallelToolCalls ?? true,
    previous_response_id: configuration.previousResponseId ?? null,
    reasoning: { effort: configuration.reasoningEffort, summary: null },
    service_tier: configuration.serviceTier ?? null,
    store: configuration.store ?? false,
    temperature: null,
    text: { format: configuration.textFormat ?? { type: "text" } },
    tool_choice: configuration.toolChoice,
    tools: configuration.tools,
    top_logprobs: null,
    top_p: null,
    truncation: "disabled",
    user: configuration.user ?? null,
    ...(input.usage === undefined
      ? {}
      : {
          usage: input.usage,
          ...(input.usage.metadata ? { usage_metadata: { metadata: input.usage.metadata } } : {}),
        }),
    ...codeReferenceMetadata(input.codeReferences),
  };
}
