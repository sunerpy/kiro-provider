import type { CanonicalRequest, CanonicalToolDeclaration } from "../../protocol/canonical.js";

export type OutputTextContent = {
	readonly type: "output_text";
	readonly text: string;
	readonly annotations: readonly [];
};

export type SummaryText = {
	readonly type: "summary_text";
	readonly text: string;
};

export type MessageOutputItem = {
	readonly id: string;
	readonly type: "message";
	readonly role: "assistant";
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
	readonly status?: "completed";
};

export type CustomToolCallOutputItem = {
	readonly id: string;
	readonly type: "custom_tool_call";
	readonly call_id: string;
	readonly namespace?: string;
	readonly name: string;
	readonly input: string;
	readonly status?: "completed";
};

export type ResponseToolCallItem =
	| FunctionCallOutputItem
	| CustomToolCallOutputItem;

export type ResponseOutputItem =
	| MessageOutputItem
	| ReasoningOutputItem
	| ResponseToolCallItem;

export type ResponseUsage = {
	readonly input_tokens: number;
	readonly output_tokens: number;
	readonly total_tokens: number;
	readonly input_tokens_details?: Readonly<Record<string, number>>;
	readonly output_tokens_details?: Readonly<Record<string, number>>;
};

export type ResponseError = {
	readonly code: string;
	readonly message: string;
};

export type ResponseStatus = "in_progress" | "completed" | "failed";

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

export interface ResponseRequestConfiguration {
  readonly instructions: string | null;
  readonly maxOutputTokens: number | null;
  readonly reasoningEffort: CanonicalRequest["requestedReasoningEffort"] | null;
  readonly toolChoice: "auto" | "none";
  readonly tools: readonly ResponseTool[];
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
    reasoningEffort: request.requestedReasoningEffort ?? null,
    toolChoice: request.toolChoice,
    tools: request.tools.filter((tool) => tool.origin === "request").map(responseTool),
  };
}

const DEFAULT_CONFIGURATION: ResponseRequestConfiguration = {
  instructions: null,
  maxOutputTokens: null,
  reasoningEffort: null,
  toolChoice: "auto",
  tools: [],
};

export interface ResponseStateObject {
  readonly id: string;
  readonly object: "response";
  readonly created_at: number;
  readonly completed_at: number | null;
  readonly status: ResponseStatus;
  readonly background: false;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly incomplete_details: null;
  readonly instructions: string | null;
  readonly max_output_tokens: number | null;
  readonly max_tool_calls: null;
  readonly metadata: Readonly<Record<string, never>>;
  readonly model: string;
  readonly output: readonly ResponseOutputItem[];
  readonly parallel_tool_calls: true;
  readonly previous_response_id: null;
  readonly reasoning: {
    readonly effort: CanonicalRequest["requestedReasoningEffort"] | null;
    readonly summary: null;
  };
  readonly service_tier: null;
  readonly store: false;
  readonly temperature: null;
  readonly text: { readonly format: { readonly type: "text" } };
  readonly tool_choice: "auto" | "none";
  readonly tools: readonly ResponseTool[];
  readonly top_logprobs: null;
  readonly top_p: null;
  readonly truncation: "disabled";
  readonly user: null;
  readonly usage: ResponseUsage | null;
}

export function responseState(input: {
  readonly id: string;
  readonly model: string;
  readonly status: ResponseStatus;
  readonly output?: readonly ResponseOutputItem[];
  readonly usage?: ResponseUsage;
  readonly error?: { readonly code: string; readonly message: string };
  readonly createdAt?: number;
  readonly completedAt?: number;
  readonly configuration?: ResponseRequestConfiguration;
}): ResponseStateObject {
  const configuration = input.configuration ?? DEFAULT_CONFIGURATION;
  return {
    id: input.id,
    object: "response",
    created_at: input.createdAt ?? Math.floor(Date.now() / 1000),
    completed_at:
      input.status === "completed"
        ? (input.completedAt ?? Math.floor(Date.now() / 1000))
        : null,
    status: input.status,
    background: false,
    error: input.error ?? null,
    incomplete_details: null,
    instructions: configuration.instructions,
    max_output_tokens: configuration.maxOutputTokens,
    max_tool_calls: null,
    metadata: {},
    model: input.model,
    output: input.output ?? [],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: configuration.reasoningEffort, summary: null },
    service_tier: null,
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: configuration.toolChoice,
    tools: configuration.tools,
    top_logprobs: null,
    top_p: null,
    truncation: "disabled",
    user: null,
    usage: input.usage ?? null,
  };
}
