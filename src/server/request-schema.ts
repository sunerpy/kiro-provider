import { z } from "zod";
import { EXPECTED_PUBLIC_MODEL_IDS } from "../kiro/model-catalog.js";
import { openAiError } from "./errors.js";

const JsonObjectSchema = z.record(z.unknown());
const PUBLIC_MODEL_IDS: ReadonlySet<string> = new Set(
	EXPECTED_PUBLIC_MODEL_IDS,
);

const TextPartSchema = z
	.object({ type: z.literal("text"), text: z.string() })
	.passthrough();

const ImageUrlPartSchema = z
	.object({
		type: z.literal("image_url"),
		image_url: z
			.object({ url: z.string(), detail: z.string().optional() })
			.passthrough(),
	})
	.passthrough();

const ImagePartSchema = z
	.object({
		type: z.literal("image"),
		source: z
			.object({
				type: z.string(),
				data: z.string(),
				media_type: z.string().optional(),
			})
			.passthrough(),
	})
	.passthrough();

const ToolResultPartSchema = z
	.object({
		type: z.literal("tool_result"),
		tool_use_id: z.string().min(1),
		content: z.unknown(),
	})
	.passthrough();

const ToolUsePartSchema = z
	.object({
		type: z.literal("tool_use"),
		id: z.string().min(1),
		name: z.string().min(1),
		input: z.unknown(),
	})
	.passthrough();

const ThinkingPartSchema = z
	.object({
		type: z.literal("thinking"),
		thinking: z.string().optional(),
		text: z.string().optional(),
	})
	.passthrough();

export const ContentPartSchema = z.discriminatedUnion("type", [
	TextPartSchema,
	ImageUrlPartSchema,
	ImagePartSchema,
	ToolResultPartSchema,
	ToolUsePartSchema,
	ThinkingPartSchema,
]);

const MessageContentSchema = z.union([
	z.string(),
	z.array(ContentPartSchema),
]);

function isParseableJson(value: string): boolean {
	try {
		JSON.parse(value);
		return true;
	} catch (error) {
		if (error instanceof SyntaxError) return false;
		throw error;
	}
}

const ToolCallSchema = z
	.object({
		id: z.string().min(1),
		type: z.literal("function"),
		function: z
			.object({
				name: z.string().min(1),
				arguments: z
					.string()
					.refine(isParseableJson, "function arguments must contain valid JSON"),
			})
			.passthrough(),
	})
	.passthrough();

const SystemMessageSchema = z
	.object({ role: z.literal("system"), content: MessageContentSchema })
	.passthrough();

const UserMessageSchema = z
	.object({ role: z.literal("user"), content: MessageContentSchema })
	.passthrough();

const AssistantMessageSchema = z
	.object({
		role: z.literal("assistant"),
		content: MessageContentSchema.nullable().optional(),
		tool_calls: z.array(ToolCallSchema).min(1).optional(),
	})
	.passthrough()
	.refine(
		(message) =>
			message.content !== null && message.content !== undefined
				? true
				: message.tool_calls !== undefined,
		{
			message: "assistant message requires content or tool_calls",
		},
	);

const ToolMessageSchema = z
	.object({
		role: z.literal("tool"),
		content: MessageContentSchema,
		tool_call_id: z.string().min(1),
	})
	.passthrough();

export const ChatMessageSchema = z.union([
	SystemMessageSchema,
	UserMessageSchema,
	AssistantMessageSchema,
	ToolMessageSchema,
]);

const OpenAiToolSchema = z
	.object({
		type: z.literal("function"),
		function: z
			.object({
				name: z.string().min(1),
				description: z.string().optional(),
				parameters: JsonObjectSchema.optional(),
			})
			.passthrough(),
	})
	.passthrough();

const AnthropicToolSchema = z
	.object({
		name: z.string().min(1),
		description: z.string().optional(),
		input_schema: JsonObjectSchema.optional(),
	})
	.passthrough();

export const ChatCompletionRequestSchema = z
	.object({
		model: z
			.string()
			.refine((model) => PUBLIC_MODEL_IDS.has(model), {
				message: "model is not supported",
			}),
		stream: z.boolean().default(false),
		messages: z.array(ChatMessageSchema).min(1),
		tools: z.array(z.union([OpenAiToolSchema, AnthropicToolSchema])).optional(),
		reasoning_effort: z
			.enum(["low", "medium", "high", "xhigh", "max"])
			.optional(),
	})
	.passthrough();

export type ChatCompletionRequest = z.infer<
	typeof ChatCompletionRequestSchema
>;

const ResponsesInputTextPartSchema = z
	.object({ type: z.literal("input_text"), text: z.string() })
	.passthrough();

const ResponsesOutputTextPartSchema = z
	.object({ type: z.literal("output_text"), text: z.string() })
	.passthrough();

const ResponsesInputImagePartSchema = z
	.object({ type: z.literal("input_image"), image_url: z.string() })
	.passthrough();

const KNOWN_RESPONSES_CONTENT_PART_TYPES: ReadonlySet<string> = new Set([
	"input_text",
	"output_text",
	"input_image",
]);

const UnknownResponsesContentPartSchema = z
	.object({ type: z.string() })
	.passthrough()
	.refine((part) => !KNOWN_RESPONSES_CONTENT_PART_TYPES.has(part.type), {
		message: "known content parts must have a valid payload",
	});

export const ResponsesContentPartSchema = z.union([
	ResponsesInputTextPartSchema,
	ResponsesOutputTextPartSchema,
	ResponsesInputImagePartSchema,
	UnknownResponsesContentPartSchema,
]);

const ResponsesMessageItemSchema = z
	.object({
		type: z.literal("message"),
		role: z.enum(["system", "user", "assistant"]),
		content: z.array(ResponsesContentPartSchema),
	})
	.passthrough();

const ResponsesFunctionCallItemSchema = z
	.object({
		type: z.literal("function_call"),
		call_id: z.string().min(1),
		name: z.string().min(1),
		arguments: z
			.string()
			.refine(isParseableJson, "function arguments must contain valid JSON"),
	})
	.passthrough();

const ResponsesFunctionCallOutputItemSchema = z
	.object({
		type: z.literal("function_call_output"),
		call_id: z.string().min(1),
		output: z.string(),
	})
	.passthrough();

const ResponsesReasoningSummaryPartSchema = z
	.object({ type: z.literal("summary_text"), text: z.string() })
	.passthrough();

const ResponsesReasoningContentPartSchema = z
	.object({
		type: z.literal("reasoning_text"),
		reasoning_text: z.string(),
	})
	.passthrough();

const ResponsesReasoningItemSchema = z
	.object({
		type: z.literal("reasoning"),
		summary: z.array(ResponsesReasoningSummaryPartSchema).optional(),
		content: z.array(ResponsesReasoningContentPartSchema).optional(),
		encrypted_content: z.string().optional(),
	})
	.passthrough();

const KNOWN_RESPONSES_INPUT_ITEM_TYPES: ReadonlySet<string> = new Set([
	"message",
	"function_call",
	"function_call_output",
	"reasoning",
]);

const UnknownResponsesInputItemSchema = z
	.object({ type: z.string() })
	.passthrough()
	.refine((item) => !KNOWN_RESPONSES_INPUT_ITEM_TYPES.has(item.type), {
		message: "known input items must have a valid payload",
	});

export const ResponsesInputItemSchema = z.union([
	ResponsesMessageItemSchema,
	ResponsesFunctionCallItemSchema,
	ResponsesFunctionCallOutputItemSchema,
	ResponsesReasoningItemSchema,
	UnknownResponsesInputItemSchema,
]);

const ResponsesToolSchema = z
	.object({
		type: z.literal("function"),
		name: z.string().min(1),
		description: z.string().optional(),
		parameters: JsonObjectSchema.optional(),
		strict: z.boolean().optional(),
	})
	.passthrough();

const ResponsesReasoningConfigSchema = z
	.object({
		effort: z
			.enum(["none", "minimal", "low", "medium", "high", "xhigh"])
			.optional(),
		summary: z.unknown().optional(),
	})
	.passthrough();

export const ResponsesRequestSchema = z
	.object({
		model: z.string(),
		input: z.union([z.string(), z.array(ResponsesInputItemSchema)]),
		instructions: z.string().optional(),
		stream: z.boolean().default(false),
		tools: z.array(ResponsesToolSchema).optional(),
		tool_choice: z.literal("auto").optional(),
		parallel_tool_calls: z.boolean().optional(),
		reasoning: ResponsesReasoningConfigSchema.nullable().optional(),
		include: z.array(z.string()).optional(),
		store: z.boolean().optional(),
		text: z.unknown().optional(),
		service_tier: z.unknown().optional(),
		prompt_cache_key: z.string().optional(),
		client_metadata: z.unknown().optional(),
		previous_response_id: z.string().optional(),
	})
	.passthrough();

export type ResponsesContentPart = z.infer<typeof ResponsesContentPartSchema>;
export type ResponsesMessageItem = z.infer<typeof ResponsesMessageItemSchema>;
export type ResponsesFunctionCallItem = z.infer<
	typeof ResponsesFunctionCallItemSchema
>;
export type ResponsesFunctionCallOutputItem = z.infer<
	typeof ResponsesFunctionCallOutputItemSchema
>;
export type ResponsesReasoningItem = z.infer<typeof ResponsesReasoningItemSchema>;
export type ResponsesInputItem = z.infer<typeof ResponsesInputItemSchema>;
export type ResponsesRequest = z.infer<typeof ResponsesRequestSchema>;

export type ParseChatCompletionRequestResult =
	| { readonly ok: true; readonly value: ChatCompletionRequest }
	| { readonly ok: false; readonly response: Response };

export function parseChatCompletionRequest(
	raw: unknown,
): ParseChatCompletionRequestResult {
	const parsed = ChatCompletionRequestSchema.safeParse(raw);
	if (parsed.success) return { ok: true, value: parsed.data };

	const message = parsed.error.issues
		.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join(".") : "request";
			return `${path}: ${issue.message}`;
		})
		.join(", ");
	return {
		ok: false,
		response: openAiError(
			400,
			`Invalid request: ${message}`,
			"invalid_request_error",
			"invalid_request",
		),
	};
}

export type ParseResponsesRequestResult =
	| { readonly ok: true; readonly value: ResponsesRequest }
	| { readonly ok: false; readonly response: Response };

export function parseResponsesRequest(raw: unknown): ParseResponsesRequestResult {
	const parsed = ResponsesRequestSchema.safeParse(raw);
	if (parsed.success) return { ok: true, value: parsed.data };

	const message = parsed.error.issues
		.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join(".") : "request";
			return `${path}: ${issue.message}`;
		})
		.join(", ");
	return {
		ok: false,
		response: openAiError(
			400,
			`Invalid request: ${message}`,
			"invalid_request_error",
			"invalid_request",
		),
	};
}
