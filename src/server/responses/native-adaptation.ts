import type { Config } from "../../config/schema.js";
import { resolveModelVariant } from "../../kiro/models.js";
import type { ManagedAccount } from "../../kiro/types.js";
import { isRecord } from "../../protocol/adapter-utils.js";
import { openAiError } from "../errors.js";
import type {
  ResponsesCustomToolCallItem,
  ResponsesFunctionCallItem,
  ResponsesRequest,
} from "../request-schema.js";
import { type ResponsesNativeFeature, responsesCapability } from "./capabilities.js";
import type { ResponseContinuationContext } from "./continuation.js";
import { NativeStreamError } from "./native-stream.js";
import { hasCallableTools, hasProviderReasoning } from "./request-policy.js";
import type { ResponseStateObject } from "./state.js";
import {
  createResponsesToolBridge,
  type PublicToolIdentity,
  type ResponsesToolBridge,
} from "./tool-bridge.js";

export interface NativeResponsesAdaptation {
  readonly wireRequest: ResponsesRequest;
  readonly original: ResponsesRequest;
  readonly bridge?: ResponsesToolBridge;
  readonly instruction?: ResponseContinuationContext["instruction"];
  readonly eligibleAccounts?: ReadonlySet<string>;
  restoreResponse(response: ResponseStateObject): ResponseStateObject;
  event(event: Record<string, unknown>): readonly Record<string, unknown>[];
}

function instructionOf(request: ResponsesRequest): ResponseContinuationContext["instruction"] {
  if (request.instructions !== undefined || typeof request.input === "string") return undefined;
  const [first] = request.input;
  if (!first || (first.role !== "system" && first.role !== "developer")) return undefined;
  if (request.input.slice(1).some((item) => item.role === "system" || item.role === "developer"))
    return undefined;
  const content = first.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content) &&
          content.length === 1 &&
          isRecord(content[0]) &&
          content[0].type === "input_text" &&
          typeof content[0].text === "string" &&
          Object.keys(content[0]).every((key) => key === "type" || key === "text")
        ? content[0].text
        : undefined;
  return text?.length ? { role: first.role, text } : undefined;
}

function toolFeatures(tools: readonly unknown[]): ResponsesNativeFeature[] | undefined {
  const result = new Set<ResponsesNativeFeature>();
  for (const tool of tools) {
    if (!isRecord(tool)) return undefined;
    if (tool.type === "namespace") {
      result.add("namespace_functions");
      const nested = Array.isArray(tool.tools) ? toolFeatures(tool.tools) : undefined;
      if (!nested) return undefined;
      for (const feature of nested) result.add(feature);
    } else if (tool.type === "custom") {
      if (tool.format !== undefined && (!isRecord(tool.format) || tool.format.type !== "text"))
        return undefined;
      result.add("custom_freeform");
    } else if (tool.type !== "function") return undefined;
  }
  return [...result];
}

function publicIdentity(identity: PublicToolIdentity): Record<string, unknown> {
  return {
    name: identity.name,
    ...(identity.kind === "namespace" ? { namespace: identity.namespace } : {}),
  };
}

export function prepareNativeAdaptation(
  request: ResponsesRequest,
  config: Config,
  previous: ResponseContinuationContext | undefined,
  accounts: readonly ManagedAccount[],
): NativeResponsesAdaptation | Response | undefined {
  if (
    request.store === false ||
    request.reasoning?.effort === "max" ||
    hasProviderReasoning(request) ||
    (request.parallel_tool_calls === false && hasCallableTools(request)) ||
    request.include?.includes("reasoning.encrypted_content")
  )
    return undefined;
  if (
    Array.isArray(request.input) &&
    request.input.some((item) => item.type === "agent_message" || item.type === "additional_tools")
  )
    return undefined;
  const model = resolveModelVariant(request.model).wireId;
  const priorInstruction = previous?.instruction;
  const priorTools = previous?.tools;
  const candidateInstruction = model.startsWith("gpt-") ? undefined : instructionOf(request);
  if (
    priorInstruction &&
    (request.instructions?.length ||
      (Array.isArray(request.input) &&
        request.input.some((item) => item.role === "system" || item.role === "developer")))
  ) {
    return openAiError(
      400,
      "This native instruction lineage cannot combine persistent and new instruction scopes",
      "invalid_request_error",
      "native_instruction_scope_conflict",
      request.instructions?.length ? "instructions" : "input",
    );
  }
  const features = toolFeatures(request.tools ?? []);
  if (!features) return undefined;
  if (Array.isArray(request.input)) {
    for (const item of request.input) {
      if (
        item.type === "function_call" &&
        typeof item.namespace === "string" &&
        !features.includes("namespace_functions")
      )
        features.push("namespace_functions");
      if (item.type === "custom_tool_call" && !features.includes("custom_freeform"))
        features.push("custom_freeform");
    }
  }
  const needsBridge = features.length > 0 || (priorTools?.length ?? 0) > 0;
  const needsLift = priorInstruction !== undefined || candidateInstruction !== undefined;
  if (!needsBridge && !needsLift) return undefined;
  if (needsLift && !priorInstruction && config.responses_instruction_lift === "off")
    return undefined;
  if (needsBridge && !priorTools?.length && config.responses_native_tool_bridge === "off")
    return undefined;
  const requirements: ResponsesNativeFeature[] = [
    ...(needsLift && !priorInstruction && config.responses_instruction_lift === "auto"
      ? ["instruction_lift" as const]
      : []),
    ...(needsBridge && !priorTools?.length && config.responses_native_tool_bridge === "auto"
      ? features
      : []),
  ];
  const eligibleAccounts = requirements.length
    ? new Set(
        accounts
          .filter((account) =>
            requirements.every(
              (feature) => responsesCapability(feature, model, account.region) === "verified",
            ),
          )
          .map((account) => account.id),
      )
    : undefined;
  if (eligibleAccounts?.size === 0) return undefined;
  const instruction = priorInstruction ?? candidateInstruction;
  let input = request.input;
  if (candidateInstruction && !priorInstruction && Array.isArray(input)) input = input.slice(1);
  let bridge: ResponsesToolBridge | undefined;
  if (needsBridge) {
    const built = createResponsesToolBridge({ ...request, input }, previous?.output ?? [], {
      stable: true,
      bindings: priorTools,
      allowHistoricalWithoutDeclarations: true,
    });
    if (!built.ok)
      return openAiError(400, built.message, "invalid_request_error", built.code, "tools");
    bridge = built.bridge;
    if (Array.isArray(input))
      input = input.map((item) => {
        if (item.type === "function_call" || item.type === "custom_tool_call") {
          const lowered = bridge?.lowerCall(
            item as ResponsesFunctionCallItem | ResponsesCustomToolCallItem,
          );
          const { namespace: _namespace, input: _customInput, ...rest } = item;
          return {
            ...rest,
            type: "function_call",
            name: lowered?.function.name,
            arguments: lowered?.function.arguments,
          } as ResponsesFunctionCallItem;
        }
        return item.type === "custom_tool_call_output"
          ? { ...item, type: "function_call_output" as const }
          : item;
      });
  }
  const activeNames = new Set(bridge?.internalTools.map((tool) => tool.function.name));
  const restoreItem = (item: Record<string, unknown>): Record<string, unknown> => {
    if (item.type !== "function_call" || !bridge) return item;
    if (
      typeof item.id !== "string" ||
      typeof item.call_id !== "string" ||
      typeof item.arguments !== "string"
    ) {
      throw new NativeStreamError(
        "invalid_upstream_tool_call",
        "Upstream returned an invalid tool call",
      );
    }
    if (typeof item.name !== "string" || !activeNames.has(item.name)) {
      throw new NativeStreamError(
        "unknown_upstream_tool",
        "Upstream returned an undeclared tool call",
      );
    }
    const restored = bridge.restoreCalls([
      {
        itemId: String(item.id),
        id: String(item.call_id),
        name: item.name,
        arguments: String(item.arguments ?? ""),
      },
    ]);
    if (!restored.ok || !restored.items[0]) {
      throw new NativeStreamError(
        "invalid_custom_tool_input",
        "Upstream tool input could not be restored",
      );
    }
    const {
      type: _wireType,
      name: _wireName,
      namespace: _wireNamespace,
      arguments: _wireArguments,
      ...extra
    } = item;
    return { ...extra, ...restored.items[0], ...(item.status ? { status: item.status } : {}) };
  };
  const restoreResponse = (response: ResponseStateObject): ResponseStateObject =>
    ({
      ...response,
      instructions: request.instructions ?? null,
      ...(bridge ? { tools: request.tools ?? [] } : {}),
      output: response.output.map((item) =>
        restoreItem(item as unknown as Record<string, unknown>),
      ),
    }) as unknown as ResponseStateObject;
  const customCalls = new Map<string, { identity: PublicToolIdentity; outputIndex: unknown }>();
  return {
    original: request,
    wireRequest: {
      ...request,
      input,
      ...(instruction ? { instructions: instruction.text } : {}),
      ...(bridge
        ? {
            tools: bridge.internalTools.map((tool) => ({
              type: "function" as const,
              ...tool.function,
              strict: false,
            })),
          }
        : {}),
    },
    bridge,
    instruction,
    eligibleAccounts,
    restoreResponse,
    event(event) {
      if (isRecord(event.response))
        return [
          { ...event, response: restoreResponse(event.response as unknown as ResponseStateObject) },
        ];
      if (!bridge) return [event];
      if (
        event.type === "response.output_item.added" &&
        isRecord(event.item) &&
        event.item.type === "function_call"
      ) {
        const item = event.item;
        const identity = bridge.bindings.find(
          (binding) => binding.wireName === item.name,
        )?.identity;
        if (!identity || !activeNames.has(String(item.name))) {
          throw new NativeStreamError(
            "unknown_upstream_tool",
            "Upstream returned an undeclared tool call",
          );
        }
        const custom =
          identity.kind === "custom" ||
          (identity.kind === "namespace" && identity.toolType === "custom");
        if (custom) customCalls.set(String(item.id), { identity, outputIndex: event.output_index });
        const {
          type: _wireType,
          name: _wireName,
          arguments: _wireArguments,
          namespace: _wireNamespace,
          ...extra
        } = item;
        return [
          {
            ...event,
            item: {
              ...extra,
              type: custom ? "custom_tool_call" : "function_call",
              ...publicIdentity(identity),
              ...(custom ? { input: "" } : { arguments: item.arguments ?? "" }),
            },
          },
        ];
      }
      if (
        (event.type === "response.function_call_arguments.delta" ||
          event.type === "response.function_call_arguments.done") &&
        customCalls.has(String(event.item_id))
      )
        return [];
      if (event.type === "response.output_item.done" && isRecord(event.item)) {
        const item = restoreItem(event.item);
        const custom = customCalls.get(String(item.id));
        if (custom) {
          customCalls.delete(String(item.id));
          return [
            {
              type: "response.custom_tool_call_input.delta",
              item_id: item.id,
              output_index: custom.outputIndex,
              delta: item.input,
            },
            {
              type: "response.custom_tool_call_input.done",
              item_id: item.id,
              output_index: custom.outputIndex,
              input: item.input,
            },
            { ...event, item },
          ];
        }
        return [{ ...event, item }];
      }
      if (typeof event.name === "string") {
        const identity = bridge.bindings.find(
          (binding) => binding.wireName === event.name,
        )?.identity;
        if (identity) return [{ ...event, ...publicIdentity(identity) }];
      }
      return [event];
    },
  };
}
