import type { CanonicalRequest, CanonicalToolDeclaration } from "../../protocol/canonical.js";

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

export function outputTextContent(text: string): OutputTextContent {
	return { type: "output_text", text, annotations: [], logprobs: [] };
}

// Kiro exposes no cached-token or reasoning-token breakdown, so the OpenAI
// detail objects are present for client compatibility and always report zero.
export function responseUsage(usage: {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly totalTokens: number;
}): ResponseUsage {
	return {
		input_tokens: usage.inputTokens,
		output_tokens: usage.outputTokens,
		total_tokens: usage.totalTokens,
		input_tokens_details: { cached_tokens: 0 },
		output_tokens_details: { reasoning_tokens: 0 },
	};
}

function normalizedUsage(usage: ResponseUsage): ResponseUsage {
	return {
		...usage,
		input_tokens_details: usage.input_tokens_details ?? { cached_tokens: 0 },
		output_tokens_details: usage.output_tokens_details ?? { reasoning_tokens: 0 },
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
  readonly metadata: Readonly<Record<string, string>>;
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
    metadata: request.metadata ?? {},
    reasoningEffort: request.requestedReasoningEffort ?? null,
    toolChoice: request.toolChoice,
    tools: request.tools.filter((tool) => tool.origin === "request").map(responseTool),
  };
}

const DEFAULT_CONFIGURATION: ResponseRequestConfiguration = {
  instructions: null,
  maxOutputTokens: null,
  metadata: {},
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
  readonly metadata: Readonly<Record<string, string>>;
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
    metadata: configuration.metadata,
    model: input.model,
    output: (input.output ?? []).map(normalizedOutputItem),
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
    usage: input.usage === undefined ? null : normalizedUsage(input.usage),
  };
}
