import type { Config } from "../../config/schema.js";
import { resolveModelVariant } from "../../kiro/models.js";
import { isRecord } from "../../protocol/adapter-utils.js";
import { openAiError } from "../errors.js";
import { type ResponsesRequest, ResponsesRequestSchema } from "../request-schema.js";
import {
  RESPONSES_REQUEST_KEYS,
  validateReasoningConfig,
  validateTextConfig,
  validateToolDeclarations,
} from "./request-adapter.js";

export type ResponsesTransport = "native" | "native-adapted" | "stateless";

export interface NormalizedResponsesRequest {
  readonly request: ResponsesRequest;
  readonly requestedEffort?: string;
  readonly effectiveEffort?: string;
  readonly wireModel: string;
}

export interface ResponsesExecutionPlan {
  readonly transport: ResponsesTransport;
  readonly reason: string;
  readonly compatibility: readonly CompatibilityLoss[];
}

export interface CompatibilityLoss {
  readonly code: string;
  readonly param: string;
}

export function hasCallableTools(
  request: Pick<ResponsesRequest, "tools" | "tool_choice" | "input">,
): boolean {
  const callable = (tools: readonly unknown[]): boolean =>
    tools.some(
      (tool) =>
        isRecord(tool) &&
        (tool.type === "function" ||
          tool.type === "custom" ||
          (tool.type === "namespace" && Array.isArray(tool.tools) && callable(tool.tools))),
    );
  return (
    request.tool_choice !== "none" &&
    (callable(request.tools ?? []) ||
      (Array.isArray(request.input) &&
        request.input.some(
          (item) =>
            item.type === "additional_tools" && Array.isArray(item.tools) && callable(item.tools),
        )))
  );
}

export function hasProviderReasoning(request: ResponsesRequest): boolean {
  return (
    Array.isArray(request.input) &&
    request.input.some(
      (item) =>
        item.type === "reasoning" &&
        typeof item.encrypted_content === "string" &&
        item.encrypted_content.startsWith("kr1_"),
    )
  );
}

export function hasNativeReasoning(request: ResponsesRequest): boolean {
  return (
    Array.isArray(request.input) &&
    request.input.some(
      (item) =>
        item.type === "reasoning" &&
        typeof item.encrypted_content === "string" &&
        item.encrypted_content.length > 0 &&
        !item.encrypted_content.startsWith("kr1_"),
    )
  );
}

export function normalizeResponsesRequest(
  raw: unknown,
  config: Config,
): NormalizedResponsesRequest | Response {
  const parsed = ResponsesRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return openAiError(
      400,
      `Invalid request: ${issue?.message ?? "invalid payload"}`,
      "invalid_request_error",
      "invalid_request",
      issue?.path.join("."),
    );
  }
  const request = parsed.data;
  for (const key of Object.keys(request)) {
    if (!RESPONSES_REQUEST_KEYS.has(key)) {
      return openAiError(
        400,
        `Responses parameter ${key} is not supported`,
        "invalid_request_error",
        "unsupported_parameter",
        key,
      );
    }
  }
  for (const validation of [
    validateTextConfig(request.text),
    validateReasoningConfig(request),
    validateToolDeclarations(request),
  ]) {
    if (!validation.ok) {
      return openAiError(
        400,
        validation.message,
        "invalid_request_error",
        validation.code,
        validation.param,
      );
    }
  }
  if (request.stream_options !== undefined) {
    const key = Object.keys(request.stream_options).find(
      (value) => value !== "include_obfuscation",
    );
    if (key || !request.stream || request.stream_options.include_obfuscation === true) {
      return openAiError(
        400,
        "Unsupported Responses stream option",
        "invalid_request_error",
        "unsupported_parameter",
        key
          ? `stream_options.${key}`
          : request.stream_options.include_obfuscation === true
            ? "stream_options.include_obfuscation"
            : "stream_options",
      );
    }
  }
  if (request.tool_choice === "required" || isRecord(request.tool_choice)) {
    return openAiError(
      400,
      "Required, named, or constrained tool choice is not verified for Kiro",
      "invalid_request_error",
      "unsupported_tool_choice",
      "tool_choice",
    );
  }
  if (
    request.reasoning?.context !== undefined &&
    request.reasoning.context !== null &&
    !["auto", "current_turn", "all_turns"].includes(String(request.reasoning.context))
  ) {
    return openAiError(
      400,
      "reasoning.context must be auto, current_turn, or all_turns",
      "invalid_request_error",
      "invalid_request",
      "reasoning.context",
    );
  }
  if (Array.isArray(request.input)) {
    for (const [index, item] of request.input.entries()) {
      if (item.phase !== undefined && item.phase !== null && item.role !== "assistant") {
        return openAiError(
          400,
          "phase is only valid on assistant messages",
          "invalid_request_error",
          "invalid_request",
          `input.${index}.phase`,
        );
      }
    }
  }
  let variant: ReturnType<typeof resolveModelVariant>;
  try {
    variant = resolveModelVariant(request.model);
  } catch (error) {
    return openAiError(
      400,
      error instanceof Error ? error.message : "Unsupported model",
      "invalid_request_error",
      "unsupported_model",
      "model",
    );
  }
  const requestedEffort = request.reasoning?.effort;
  const effectiveEffort = requestedEffort ?? variant.effort ?? config.effort ?? undefined;
  return {
    request: {
      ...request,
      ...(effectiveEffort !== undefined
        ? { reasoning: { ...request.reasoning, effort: effectiveEffort } }
        : {}),
    },
    wireModel: variant.wireId,
    ...(requestedEffort !== undefined ? { requestedEffort } : {}),
    ...(effectiveEffort !== undefined ? { effectiveEffort } : {}),
  };
}

/** Only enumerated legacy behavior may be accepted without a verified wire equivalent. */
export function responsesCompatibility(
  request: ResponsesRequest,
  transport: ResponsesTransport,
): readonly CompatibilityLoss[] {
  const losses: CompatibilityLoss[] = [];
  if (isRecord(request.text) && request.text.verbosity !== undefined) {
    losses.push({ code: "text_verbosity_ignored", param: "text.verbosity" });
  }
  if (request.reasoning?.context != null && request.reasoning.context !== "auto") {
    losses.push({ code: "reasoning_context_ignored", param: "reasoning.context" });
  }
  if (transport !== "stateless") return losses;
  if (request.parallel_tool_calls === false && hasCallableTools(request)) {
    losses.push({ code: "parallel_tool_calls_unenforced", param: "parallel_tool_calls" });
  }
  if (request.instructions) {
    losses.push({ code: "instruction_role_projection", param: "instructions" });
  }
  if (request.reasoning?.summary != null && request.reasoning.summary !== "none") {
    losses.push({ code: "reasoning_summary_ignored", param: "reasoning.summary" });
  }
  if (request.reasoning?.effort === "none" || request.reasoning?.effort === "minimal") {
    losses.push({ code: "reasoning_effort_approximated", param: "reasoning.effort" });
  }
  if (Array.isArray(request.input)) {
    for (const [index, item] of request.input.entries()) {
      if (
        (item.type === undefined || item.type === "message") &&
        (item.role === "developer" || item.role === "system")
      ) {
        losses.push({ code: "instruction_role_projection", param: `input.${index}.role` });
      }
      if (item.phase != null) {
        losses.push({ code: "assistant_phase_unavailable", param: `input.${index}.phase` });
      }
    }
  }
  const visit = (tools: readonly unknown[], path: string): void => {
    for (const [index, tool] of tools.entries()) {
      if (!isRecord(tool)) continue;
      if (tool.type === "custom" && isRecord(tool.format) && tool.format.type === "grammar") {
        losses.push({ code: "custom_grammar_unenforced", param: `${path}.${index}.format` });
      }
      if (tool.type === "namespace" && Array.isArray(tool.tools))
        visit(tool.tools, `${path}.${index}.tools`);
    }
  };
  visit(request.tools ?? [], "tools");
  if (Array.isArray(request.input)) {
    for (const [index, item] of request.input.entries()) {
      if (item.type === "additional_tools" && Array.isArray(item.tools)) {
        visit(item.tools, `input.${index}.tools`);
      }
    }
  }
  return losses;
}

export function fidelityRejection(
  losses: readonly CompatibilityLoss[],
  config: Config,
): Response | undefined {
  if (config.responses_fidelity_mode !== "strict" || losses.length === 0) return undefined;
  const loss = losses[0] as CompatibilityLoss;
  return openAiError(
    400,
    `Kiro cannot preserve ${loss.param} on this transport (${loss.code})`,
    "invalid_request_error",
    "unsupported_response_semantics",
    loss.param,
  );
}

export function responseDiagnostics(response: Response, plan: ResponsesExecutionPlan): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Kiro-Transport", plan.transport);
  const losses = [...new Set(plan.compatibility.map((loss) => loss.code))];
  if (losses.length) headers.set("X-Kiro-Compatibility", losses.join(","));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
