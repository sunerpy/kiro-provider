import { z } from "zod";

const ContentBlockSchema = z
  .object({
    type: z.string().min(1),
  })
  .passthrough();

const MessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.union([z.string(), z.array(ContentBlockSchema)]),
  })
  .passthrough();

const ToolSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    input_schema: z.record(z.unknown()).optional(),
  })
  .passthrough();

const ToolChoiceSchema = z
  .object({
    type: z.enum(["auto", "any", "tool", "none"]),
    name: z.string().min(1).optional(),
    disable_parallel_tool_use: z.boolean().optional(),
  })
  .passthrough()
  .refine((choice) => choice.type !== "tool" || choice.name !== undefined, {
    message: "tool_choice.name is required when tool_choice.type is tool",
  });

const ThinkingSchema = z
  .object({
    type: z.enum(["enabled", "adaptive", "disabled"]),
    budget_tokens: z.number().int().positive().optional(),
  })
  .passthrough();

const AnthropicMessagesRequestSchema = z
  .object({
    model: z.string().min(1),
    max_tokens: z.number().int().positive().optional(),
    messages: z.array(MessageSchema).min(1),
    system: z.union([z.string(), z.array(ContentBlockSchema)]).optional(),
    stream: z.boolean().default(false),
    tools: z.array(ToolSchema).optional(),
    tool_choice: ToolChoiceSchema.optional(),
    thinking: ThinkingSchema.optional(),
    output_config: z
      .object({
        effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      })
      .passthrough()
      .optional(),
    metadata: z
      .object({
        user_id: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type AnthropicMessagesRequest = z.infer<typeof AnthropicMessagesRequestSchema>;

export type AdaptedAnthropicRequest = {
  readonly source: AnthropicMessagesRequest;
  readonly body: Readonly<Record<string, unknown>>;
};

export type AdaptAnthropicRequestResult =
  | { readonly ok: true; readonly value: AdaptedAnthropicRequest }
  | { readonly ok: false; readonly message: string };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "request";
      return `${path}: ${issue.message}`;
    })
    .join(", ");
}

function systemText(system: AnthropicMessagesRequest["system"]): string {
  if (typeof system === "string") return system;
  if (!system) return "";
  return system
    .flatMap((block) =>
      block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n\n");
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value
      .flatMap((part) =>
        isRecord(part) && part.type === "text" && typeof part.text === "string"
          ? [part.text]
          : [],
      )
      .join("");
    if (text.length > 0) return text;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeBlock(
  block: z.infer<typeof ContentBlockSchema>,
): Readonly<Record<string, unknown>> | undefined {
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? { ...block, text: block.text } : undefined;
    case "image": {
      if (!isRecord(block.source)) return undefined;
      if (typeof block.source.type !== "string" || typeof block.source.data !== "string") {
        return undefined;
      }
      return { ...block };
    }
    case "tool_use":
      return typeof block.id === "string" && typeof block.name === "string"
        ? { ...block, input: block.input ?? {} }
        : undefined;
    case "tool_result": {
      if (typeof block.tool_use_id !== "string") return undefined;
      const content = stringifyContent(block.content);
      return {
        ...block,
        content,
      };
    }
    case "thinking":
    case "redacted_thinking":
      return undefined;
    default:
      return undefined;
  }
}

function normalizeMessages(
  messages: AnthropicMessagesRequest["messages"],
): Readonly<Record<string, unknown>>[] | undefined {
  const normalized: Readonly<Record<string, unknown>>[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      normalized.push({ role: message.role, content: message.content });
      continue;
    }
    const content = message.content.flatMap((block) => {
      const normalizedBlock = normalizeBlock(block);
      return normalizedBlock ? [normalizedBlock] : [];
    });
    if (content.length === 0) return undefined;
    normalized.push({
      role: message.role,
      content,
    });
  }
  return normalized;
}

export function adaptAnthropicMessagesRequest(
  raw: unknown,
  options: { readonly requireMaxTokens?: boolean } = {},
): AdaptAnthropicRequestResult {
  const parsed = AnthropicMessagesRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: `Invalid request: ${formatIssues(parsed.error)}` };
  }
  if (options.requireMaxTokens === true && parsed.data.max_tokens === undefined) {
    return {
      ok: false,
      message: "Invalid request: max_tokens is required",
    };
  }
  if (
    parsed.data.tool_choice?.type === "any" ||
    parsed.data.tool_choice?.type === "tool"
  ) {
    return {
      ok: false,
      message:
        `Invalid request: tool_choice.type ${parsed.data.tool_choice.type} is not supported ` +
        "because the Kiro upstream has no structured forced-tool control",
    };
  }
  if (parsed.data.tool_choice?.disable_parallel_tool_use === true) {
    return {
      ok: false,
      message:
        "Invalid request: disable_parallel_tool_use is not supported by the Kiro upstream",
    };
  }
  const messages = normalizeMessages(parsed.data.messages);
  if (!messages) {
    return {
      ok: false,
      message: "Invalid request: every message must contain a supported content block",
    };
  }

  const system = systemText(parsed.data.system);
  const toolNames = new Set<string>();
  for (const tool of parsed.data.tools ?? []) {
    if (toolNames.has(tool.name)) {
      return {
        ok: false,
        message: `Invalid request: duplicate tool name ${tool.name}`,
      };
    }
    toolNames.add(tool.name);
  }
  const selectedTools =
    parsed.data.tool_choice?.type === "none"
      ? []
      : parsed.data.tools;

  const thinking =
    parsed.data.thinking?.type === "enabled" ||
    parsed.data.thinking?.type === "adaptive"
      ? {
          budget_tokens: parsed.data.thinking.budget_tokens ?? 20_000,
        }
      : undefined;
  const body: Record<string, unknown> = {
    model: parsed.data.model,
    stream: parsed.data.stream,
    ...(parsed.data.max_tokens !== undefined
      ? { max_tokens: parsed.data.max_tokens }
      : {}),
    messages,
    ...(system ? { system } : {}),
    ...(selectedTools !== undefined ? { tools: selectedTools } : {}),
    ...(thinking ? { thinkingConfig: thinking } : {}),
    ...(parsed.data.output_config?.effort
      ? { reasoning_effort: parsed.data.output_config.effort }
      : {}),
  };
  return { ok: true, value: { source: parsed.data, body } };
}
