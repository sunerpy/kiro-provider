import { z } from "zod";
import { openAiError } from "./errors.js";

const JsonObjectSchema = z.record(z.unknown());
const OpenAiMetadataSchema = z.record(z.string()).superRefine((metadata, context) => {
  const entries = Object.entries(metadata);
  if (entries.length > 16) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "metadata must contain at most 16 entries",
    });
  }
  for (const [key, value] of entries) {
    if (key.length > 64) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "metadata keys must contain at most 64 characters",
        path: [key],
      });
    }
    if (value.length > 512) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "metadata values must contain at most 512 characters",
        path: [key],
      });
    }
  }
});

const TextPartSchema = z.object({ type: z.literal("text"), text: z.string() }).passthrough();

const ImageUrlPartSchema = z
  .object({
    type: z.literal("image_url"),
    image_url: z.object({ url: z.string(), detail: z.string().optional() }).passthrough(),
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

const MessageContentSchema = z.union([z.string(), z.array(ContentPartSchema)]);

function isParseableJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

// Client-supplied history only: some OpenAI SDKs send `arguments: ""` for a
// zero-argument call. Upstream zero-input tool calls are projected as `{}` by
// the stream transformer (validateCompletedToolCalls), not here.
function normalizeFunctionArguments(value: string): string {
  return value.trim().length === 0 ? "{}" : value;
}

const ToolCallSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("function"),
    function: z
      .object({
        name: z.string().min(1),
        arguments: z.string().refine(isParseableJson, "function arguments must contain valid JSON"),
      })
      .passthrough(),
  })
  .passthrough();

const SystemMessageSchema = z
  .object({ role: z.literal("system"), content: MessageContentSchema })
  .passthrough();

const DeveloperMessageSchema = z
  .object({ role: z.literal("developer"), content: MessageContentSchema })
  .passthrough();

const UserMessageSchema = z
  .object({ role: z.literal("user"), content: MessageContentSchema })
  .passthrough();

const AssistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: MessageContentSchema.nullable().optional(),
    tool_calls: z.array(ToolCallSchema).min(1).optional(),
    reasoning_content: z.string().optional(),
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
  DeveloperMessageSchema,
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
    model: z.string().trim().min(1),
    stream: z.boolean().default(false),
    stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().optional(),
    messages: z.array(ChatMessageSchema).min(1),
    tools: z.array(z.union([OpenAiToolSchema, AnthropicToolSchema])).optional(),
    user: z.string().optional(),
    prompt_cache_key: z.string().optional(),
    reasoning_effort: z
      .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
      .optional(),
    tool_choice: z
      .union([
        z.enum(["auto", "none", "required"]),
        z
          .object({
            type: z.literal("function"),
            function: z.object({ name: z.string().min(1) }).passthrough(),
          })
          .passthrough(),
      ])
      .optional(),
    parallel_tool_calls: z.boolean().optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    response_format: z.unknown().optional(),
    n: z.number().int().positive().optional(),
    stop: z.unknown().optional(),
    seed: z.number().int().optional(),
    presence_penalty: z.number().optional(),
    frequency_penalty: z.number().optional(),
    logit_bias: z.unknown().optional(),
    logprobs: z.boolean().optional(),
    top_logprobs: z.number().int().optional(),
    modalities: z.unknown().optional(),
    audio: z.unknown().optional(),
    prediction: z.unknown().optional(),
    store: z.boolean().optional(),
    metadata: z.unknown().optional(),
    service_tier: z.unknown().optional(),
  })
  .passthrough();

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

const ResponsesInputTextPartSchema = z
  .object({ type: z.literal("input_text"), text: z.string() })
  .passthrough();

const ResponsesOutputTextPartSchema = z
  .object({ type: z.literal("output_text"), text: z.string() })
  .passthrough();

const ResponsesInputImagePartSchema = z
  .object({ type: z.literal("input_image"), image_url: z.string() })
  .passthrough();

const ResponsesInputFilePartSchema = z
  .object({
    type: z.literal("input_file"),
    file_data: z.string().optional(),
    file_id: z.string().optional(),
    filename: z.string().min(1).optional(),
  })
  .passthrough();

const ResponsesEncryptedContentPartSchema = z
  .object({
    type: z.literal("encrypted_content"),
    encrypted_content: z.string(),
  })
  .passthrough();

const KNOWN_RESPONSES_CONTENT_PART_TYPES: ReadonlySet<string> = new Set([
  "input_text",
  "output_text",
  "input_image",
  "input_file",
  "encrypted_content",
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
  ResponsesInputFilePartSchema,
  ResponsesEncryptedContentPartSchema,
  UnknownResponsesContentPartSchema,
]);

const ResponsesMessageItemSchema = z
  .object({
    type: z.literal("message").optional(),
    id: z.string().optional(),
    status: z.string().optional(),
    role: z.enum(["system", "developer", "user", "assistant"]),
    content: z.union([z.string(), z.array(ResponsesContentPartSchema)]),
  })
  .passthrough();

const ResponsesAgentMessageItemSchema = z
  .object({
    type: z.literal("agent_message"),
    author: z.string().min(1),
    recipient: z.string().min(1),
    content: z.array(ResponsesContentPartSchema),
  })
  .passthrough();

const ResponsesFunctionCallItemSchema = z
  .object({
    type: z.literal("function_call"),
    id: z.string().optional(),
    status: z.string().optional(),
    call_id: z.string().min(1),
    namespace: z.string().min(1).optional(),
    name: z.string().min(1),
    arguments: z
      .string()
      .transform(normalizeFunctionArguments)
      .refine(isParseableJson, "function arguments must contain valid JSON"),
  })
  .passthrough();

const ResponsesCustomToolCallItemSchema = z
  .object({
    type: z.literal("custom_tool_call"),
    id: z.string().optional(),
    status: z.string().optional(),
    call_id: z.string().min(1),
    namespace: z.string().min(1).optional(),
    name: z.string().min(1),
    input: z.string(),
  })
  .passthrough();

const ResponsesOutputPayloadSchema = z.union([
  z.string(),
  z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
]);

const ResponsesFunctionCallOutputItemSchema = z
  .object({
    type: z.literal("function_call_output"),
    id: z.string().optional(),
    status: z.string().optional(),
    call_id: z.string().min(1),
    output: ResponsesOutputPayloadSchema,
  })
  .passthrough();

const ResponsesCustomToolCallOutputItemSchema = z
  .object({
    type: z.literal("custom_tool_call_output"),
    id: z.string().optional(),
    status: z.string().optional(),
    call_id: z.string().min(1),
    output: ResponsesOutputPayloadSchema,
  })
  .passthrough();

const ResponsesFunctionToolSchema = z
  .object({
    type: z.literal("function"),
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: JsonObjectSchema.optional(),
    strict: z.boolean().optional(),
  })
  .passthrough();

const ResponsesCustomToolSchema = z
  .object({
    type: z.literal("custom"),
    name: z.string().min(1),
    description: z.string().optional(),
    format: z
      .object({
        type: z.literal("grammar"),
        syntax: z.string().min(1),
        definition: z.string(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ResponsesNamespaceChildToolSchema = z.union([
  ResponsesFunctionToolSchema,
  ResponsesCustomToolSchema,
]);

const ResponsesNamespaceToolSchema = z
  .object({
    type: z.literal("namespace"),
    name: z.string().min(1),
    description: z.string().optional(),
    tools: z.array(ResponsesNamespaceChildToolSchema),
  })
  .passthrough();

const ResponsesAdditionalFunctionToolSchema = z
  .object({
    type: z.literal("function"),
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: JsonObjectSchema.optional(),
    inputSchema: JsonObjectSchema.optional(),
    strict: z.boolean().optional(),
  })
  .passthrough()
  .transform((tool) => ({
    ...tool,
    type: "function" as const,
    ...(tool.parameters !== undefined
      ? { parameters: tool.parameters }
      : tool.inputSchema !== undefined
        ? { parameters: tool.inputSchema }
        : {}),
  }));

const ResponsesAdditionalNamespaceFunctionToolSchema = z
  .object({
    type: z.literal("function").optional(),
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: JsonObjectSchema.optional(),
    inputSchema: JsonObjectSchema.optional(),
    strict: z.boolean().optional(),
  })
  .passthrough()
  .transform((tool) => ({
    ...tool,
    type: "function" as const,
    ...(tool.parameters !== undefined
      ? { parameters: tool.parameters }
      : tool.inputSchema !== undefined
        ? { parameters: tool.inputSchema }
        : {}),
  }));

const ResponsesAdditionalNamespaceChildToolSchema = z.union([
  ResponsesAdditionalNamespaceFunctionToolSchema,
  ResponsesCustomToolSchema,
]);

const ResponsesAdditionalNamespaceToolSchema = z
  .object({
    type: z.literal("namespace"),
    name: z.string().min(1),
    description: z.string().optional(),
    tools: z.array(ResponsesAdditionalNamespaceChildToolSchema),
  })
  .passthrough()
  .transform((tool) => ({
    ...tool,
    type: "namespace" as const,
  }));

const KNOWN_RESPONSES_TOOL_TYPES: ReadonlySet<string> = new Set([
  "function",
  "custom",
  "namespace",
]);

const UnknownResponsesToolSchema = z
  .object({ type: z.string() })
  .passthrough()
  .refine((tool) => !KNOWN_RESPONSES_TOOL_TYPES.has(tool.type), {
    message: "known tools must have a valid payload",
  });

const ResponsesKnownToolSchema = z.union([
  ResponsesFunctionToolSchema,
  ResponsesCustomToolSchema,
  ResponsesNamespaceToolSchema,
]);

const ResponsesToolSchema = z.union([ResponsesKnownToolSchema, UnknownResponsesToolSchema]);

const ResponsesAdditionalToolSchema = z.union([
  ResponsesAdditionalFunctionToolSchema,
  ResponsesCustomToolSchema,
  ResponsesAdditionalNamespaceToolSchema,
  UnknownResponsesToolSchema,
]);

const ResponsesAdditionalToolsItemSchema = z
  .object({
    type: z.literal("additional_tools"),
    role: z.string().optional(),
    tools: z.array(ResponsesAdditionalToolSchema),
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
    id: z.string().optional(),
    status: z.string().optional(),
    summary: z.array(ResponsesReasoningSummaryPartSchema).nullable().optional(),
    content: z.array(ResponsesReasoningContentPartSchema).nullable().optional(),
    encrypted_content: z.string().nullable().optional(),
  })
  .passthrough();

const KNOWN_RESPONSES_INPUT_ITEM_TYPES: ReadonlySet<string> = new Set([
  "message",
  "agent_message",
  "function_call",
  "custom_tool_call",
  "function_call_output",
  "custom_tool_call_output",
  "additional_tools",
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
  ResponsesAgentMessageItemSchema,
  ResponsesFunctionCallItemSchema,
  ResponsesCustomToolCallItemSchema,
  ResponsesFunctionCallOutputItemSchema,
  ResponsesCustomToolCallOutputItemSchema,
  ResponsesAdditionalToolsItemSchema,
  ResponsesReasoningItemSchema,
  UnknownResponsesInputItemSchema,
]);

const ResponsesReasoningConfigSchema = z
  .object({
    effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    summary: z.unknown().optional(),
  })
  .passthrough();

export const ResponsesRequestSchema = z
  .object({
    model: z.string().trim().min(1),
    input: z.union([z.string(), z.array(ResponsesInputItemSchema)]),
    instructions: z.string().optional(),
    stream: z.boolean().default(false),
    tools: z.array(ResponsesToolSchema).optional(),
    tool_choice: z.union([z.enum(["auto", "none", "required"]), z.record(z.unknown())]).optional(),
    parallel_tool_calls: z.boolean().optional(),
    reasoning: ResponsesReasoningConfigSchema.nullable().optional(),
    include: z.array(z.string()).optional(),
    store: z.boolean().optional(),
    text: z.unknown().optional(),
    service_tier: z.unknown().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    truncation: z.unknown().optional(),
    background: z.boolean().optional(),
    max_tool_calls: z.number().int().positive().optional(),
    prompt_cache_key: z.string().optional(),
    metadata: OpenAiMetadataSchema.optional(),
    client_metadata: z.unknown().optional(),
    previous_response_id: z.string().optional(),
    conversation: z.unknown().optional(),
  })
  .passthrough();

export type ResponsesContentPart = z.infer<typeof ResponsesContentPartSchema>;
export type ResponsesMessageItem = z.infer<typeof ResponsesMessageItemSchema>;
export type ResponsesAgentMessageItem = z.infer<typeof ResponsesAgentMessageItemSchema>;
export type ResponsesFunctionCallItem = z.infer<typeof ResponsesFunctionCallItemSchema>;
export type ResponsesCustomToolCallItem = z.infer<typeof ResponsesCustomToolCallItemSchema>;
export type ResponsesFunctionCallOutputItem = z.infer<typeof ResponsesFunctionCallOutputItemSchema>;
export type ResponsesCustomToolCallOutputItem = z.infer<
  typeof ResponsesCustomToolCallOutputItemSchema
>;
export type ResponsesFunctionTool = z.infer<typeof ResponsesFunctionToolSchema>;
export type ResponsesCustomTool = z.infer<typeof ResponsesCustomToolSchema>;
export type ResponsesNamespaceTool = z.infer<typeof ResponsesNamespaceToolSchema>;
export type ResponsesKnownTool = z.infer<typeof ResponsesKnownToolSchema>;
export type ResponsesTool = z.infer<typeof ResponsesToolSchema>;
export type ResponsesAdditionalToolsItem = z.infer<typeof ResponsesAdditionalToolsItemSchema>;
export type ResponsesReasoningItem = z.infer<typeof ResponsesReasoningItemSchema>;
export type ResponsesInputItem = z.infer<typeof ResponsesInputItemSchema>;
export type ResponsesRequest = z.infer<typeof ResponsesRequestSchema>;

export type ParseChatCompletionRequestResult =
  | { readonly ok: true; readonly value: ChatCompletionRequest }
  | { readonly ok: false; readonly response: Response };

export function parseChatCompletionRequest(raw: unknown): ParseChatCompletionRequestResult {
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
