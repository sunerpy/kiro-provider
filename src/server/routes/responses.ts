import { randomUUID } from "node:crypto";
import type { Config } from "../../config/schema.js";
import { auditHash, auditLog } from "../../core/audit-log.js";
import { runChatCompletion } from "../../core/pipeline.js";
import { boundedCleanup } from "../../core/stream-cleanup.js";
import { resolveModelVariant } from "../../kiro/models.js";
import type { CanonicalMessage } from "../../protocol/canonical.js";
import {
  CANONICAL_OUTPUT_JSON_MEDIA_TYPE,
  CANONICAL_OUTPUT_STREAM_MEDIA_TYPE,
  type CanonicalCompletion,
  type CanonicalOutputUsage,
  parseCanonicalCompletion,
} from "../../protocol/output.js";
import { openAiError } from "../errors.js";
import {
  buildPipelineOptions,
  createIngress,
  openAiIngressErrors,
  type RouteDependencies,
  readJsonBody,
  withRetryAfter,
} from "../ingress.js";
import type { ResponsesRequest } from "../request-schema.js";
import { parseResponsesRequest, type ResponsesInputItem } from "../request-schema.js";
import {
  publicResponseState,
  ResponseContextError,
  type ResponseContinuationContext,
} from "../responses/continuation.js";
import type {
  MessageOutputItem,
  OutputTextContent,
  ReasoningOutputItem,
  ResponseOutputItem,
  ResponseToolCallItem,
  ResponseUsage,
} from "../responses/events.js";
import { prepareNativeAdaptation } from "../responses/native-adaptation.js";
import { proxyNativeResponses } from "../responses/native-transport.js";
import { isGptSolReasoningPlaceholder } from "../responses/reasoning.js";
import {
  adaptResponsesRequest,
  type ResponsesPreviousContext,
} from "../responses/request-adapter.js";
import {
  fidelityRejection,
  hasCallableTools,
  hasNativeReasoning,
  hasProviderReasoning,
  normalizeResponsesRequest,
  type ResponsesExecutionPlan,
  responseDiagnostics,
  responsesCompatibility,
} from "../responses/request-policy.js";
import { responsesSseAdapter } from "../responses/sse-adapter.js";
import {
  type ResponseRequestConfiguration,
  type ResponseStateObject,
  responseConfigurationFromCanonical,
  responseState,
} from "../responses/state.js";
import {
  canonicalCompletionFromResponse,
  responseInputItems,
  responseStoreTenant,
  type StoredResponse,
} from "../responses/store.js";
import { type ResponsesToolBridge, reportToolRestoreFailure } from "../responses/tool-bridge.js";
import { canonicalSessionLineage, responsesSessionAffinity } from "../session-affinity.js";

export type ResponsesDependencies = RouteDependencies;
export type StoredResponseAction = "retrieve" | "delete" | "input_items" | "cancel";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type StatelessV3Reason =
  | "store_false"
  | "max_effort"
  | "parallel_tool_calls_false"
  | "custom_or_namespace_tool"
  | "encrypted_reasoning"
  | "collaboration_input"
  | "native_instruction_role_unsupported";

type StatelessV3Requirement = {
  readonly reason: StatelessV3Reason;
  readonly param: string;
};

type V3RouteDecision =
  | {
      readonly transport: "native";
      readonly reason: "native_default" | "previous_native";
    }
  | {
      readonly transport: "stateless";
      readonly reason: StatelessV3Reason | "previous_stateless";
    }
  | {
      readonly transport: "reject";
      readonly reason: "native_previous_transport_conflict";
      readonly requirement: StatelessV3Requirement;
    };

function nativeInstructionRolesSupported(model: unknown): boolean | undefined {
  if (typeof model !== "string") return undefined;
  try {
    return resolveModelVariant(model).wireId.startsWith("gpt-");
  } catch {
    return undefined;
  }
}

function unsupportedNativeInstructionRole(
  body: Readonly<Record<string, unknown>>,
): StatelessV3Requirement | undefined {
  if (!Array.isArray(body.input) || nativeInstructionRolesSupported(body.model) !== false) {
    return undefined;
  }
  for (const [index, item] of body.input.entries()) {
    if (
      isRecord(item) &&
      (item.role === "system" || item.role === "developer") &&
      (item.type === undefined || item.type === "message")
    ) {
      return {
        reason: "native_instruction_role_unsupported",
        param: `input.${index}.role`,
      };
    }
  }
  return undefined;
}

function requiresStatelessV3(
  body: Readonly<Record<string, unknown>>,
): StatelessV3Requirement | undefined {
  if (body.store === false) return { reason: "store_false", param: "store" };
  const reasoning = body.reasoning;
  if (isRecord(reasoning) && reasoning.effort === "max") {
    return { reason: "max_effort", param: "reasoning.effort" };
  }
  if (body.parallel_tool_calls === false && hasCallableTools(body as ResponsesRequest)) {
    return { reason: "parallel_tool_calls_false", param: "parallel_tool_calls" };
  }
  if (
    Array.isArray(body.tools) &&
    body.tools.some(
      (tool) => isRecord(tool) && (tool.type === "custom" || tool.type === "namespace"),
    )
  ) {
    return { reason: "custom_or_namespace_tool", param: "tools" };
  }
  if (hasProviderReasoning(body as ResponsesRequest))
    return { reason: "encrypted_reasoning", param: "input" };
  if (
    Array.isArray(body.include) &&
    body.include.some((value) => value === "reasoning.encrypted_content")
  ) {
    return { reason: "encrypted_reasoning", param: "include" };
  }
  if (Array.isArray(body.input)) {
    const collaborationIndex = body.input.findIndex(
      (item) =>
        isRecord(item) &&
        (item.type === "additional_tools" ||
          item.type === "agent_message" ||
          item.type === "custom_tool_call" ||
          item.type === "custom_tool_call_output" ||
          (item.type === "function_call" && typeof item.namespace === "string")),
    );
    if (collaborationIndex >= 0) {
      return {
        reason: "collaboration_input",
        param: `input.${collaborationIndex}`,
      };
    }
  }
  return unsupportedNativeInstructionRole(body);
}

function selectV3Route(body: unknown, dependencies: ResponsesDependencies): V3RouteDecision {
  if (!isRecord(body)) return { transport: "native", reason: "native_default" };
  const requirement = requiresStatelessV3(body);
  const previousResponseId = body.previous_response_id;
  if (typeof previousResponseId === "string") {
    const stored = dependencies.responseStore?.get(
      responseStoreTenant(dependencies.tenantId),
      previousResponseId,
    );
    if (
      stored?.transport === "stateless" ||
      (stored?.request !== undefined && stored.completion !== undefined)
    ) {
      return { transport: "stateless", reason: "previous_stateless" };
    }
    if (stored !== undefined && requirement !== undefined) {
      return {
        transport: "reject",
        reason: "native_previous_transport_conflict",
        requirement,
      };
    }
    return { transport: "native", reason: "previous_native" };
  }
  return requirement === undefined
    ? { transport: "native", reason: "native_default" }
    : { transport: "stateless", reason: requirement.reason };
}

function requestedEffort(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.reasoning)) return undefined;
  return typeof body.reasoning.effort === "string" ? body.reasoning.effort : undefined;
}

function requestedModel(body: unknown): string | undefined {
  return isRecord(body) && typeof body.model === "string" ? body.model : undefined;
}

function previousResponsePresent(body: unknown): boolean {
  return (
    isRecord(body) &&
    typeof body.previous_response_id === "string" &&
    body.previous_response_id.length > 0
  );
}

/**
 * Responses `usage` from a canonical completion. Kiro reports no cache or
 * reasoning token split, so the detail objects the Responses API always
 * carries are present with zero counts rather than omitted.
 */
export function responsesUsage(usage: CanonicalOutputUsage): ResponseUsage {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
}

/** A completed `output_text` part with the always-present empty `logprobs`. */
export function outputTextContent(
  text: string,
): OutputTextContent & { readonly logprobs: readonly [] } {
  return { type: "output_text", text, annotations: [], logprobs: [] };
}

/** Restored tool-call items are terminal in a non-stream response. */
export function completedToolCallItems(
  items: readonly ResponseToolCallItem[],
): readonly ResponseToolCallItem[] {
  return items.map((item) => ({ ...item, status: "completed" as const }));
}

type CompletedResponseProjection =
  | { readonly ok: true; readonly state: ResponseStateObject }
  | { readonly ok: false; readonly response: Response };

function completedResponse(
  payload: CanonicalCompletion,
  model: string,
  bridge: ResponsesToolBridge,
  configuration: ResponseRequestConfiguration,
  responseId: string,
  createdAt: number,
): CompletedResponseProjection {
  const restored = bridge.restoreCalls(
    payload.toolCalls.map((call) => ({
      itemId: `fc_${randomUUID()}`,
      id: call.id,
      name: call.name,
      arguments: call.input,
    })),
  );
  if (!restored.ok) {
    const failure = reportToolRestoreFailure(restored);
    return {
      ok: false,
      response: openAiError(502, failure.message, "upstream_error", failure.code),
    };
  }
  const output: ResponseOutputItem[] = [];
  const reasoningText = payload.reasoning?.text;
  const reasoningSummary =
    reasoningText !== undefined && !isGptSolReasoningPlaceholder(model, reasoningText)
      ? [{ type: "summary_text" as const, text: reasoningText }]
      : [];
  if (reasoningSummary.length > 0 || payload.reasoning?.encryptedContent) {
    const reasoning: ReasoningOutputItem = {
      id: `rs_${randomUUID()}`,
      type: "reasoning",
      summary: reasoningSummary,
      ...(payload.reasoning?.encryptedContent
        ? { encrypted_content: payload.reasoning.encryptedContent }
        : {}),
    };
    output.push(reasoning);
  }
  if (payload.text.length > 0) {
    const message: MessageOutputItem = {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [outputTextContent(payload.text)],
    };
    output.push(message);
  }
  output.push(...completedToolCallItems(restored.items));
  return {
    ok: true,
    state: responseState({
      id: responseId,
      status: "completed",
      model,
      output,
      usage: responsesUsage(payload.usage),
      configuration,
      createdAt,
    }),
  };
}

function previousContext(stored: StoredResponse): ResponsesPreviousContext {
  const legacyRequest = stored.continuation?.legacyRequest ?? stored.request;
  if (legacyRequest?.reasoningReplays.length) {
    throw new ResponseContextError(
      "Legacy reasoning history is missing the logical item sequence required for replay",
    );
  }
  const messages: CanonicalMessage[] = (legacyRequest?.messages ?? [])
    .filter((message) => message.path !== "instructions")
    .map((message) => ({
      ...message,
      content: message.content.map((part) =>
        part.type === "tool_result"
          ? { ...part, content: part.content.map((content) => ({ ...content })) }
          : { ...part },
      ),
      toolCalls: message.toolCalls.map((call) => ({ ...call })),
    }));
  if (stored.continuation?.transport === "stateless") {
    const priorInput = stored.continuation.request.input;
    return {
      messages,
      ...(legacyRequest ? { legacyRequest } : {}),
      input: [
        ...(typeof priorInput === "string"
          ? [{ role: "user" as const, content: priorInput }]
          : priorInput),
        ...((stored.continuation.output ?? stored.response.output) as ResponsesInputItem[]),
      ],
    };
  }
  if (!stored.request || !stored.completion) {
    throw new TypeError("Stored native response cannot be expanded through the legacy adapter");
  }
  return { messages, legacyRequest, input: stored.response.output as ResponsesInputItem[] };
}

function persistResponse(
  dependencies: ResponsesDependencies,
  tenantId: string,
  state: ResponseStateObject,
  inputItems: readonly unknown[],
  request: Parameters<NonNullable<ResponsesDependencies["responseStore"]>["put"]>[3],
  continuation?: ResponseContinuationContext,
): void {
  if (!state.store || !dependencies.responseStore) return;
  try {
    dependencies.responseStore.put(
      tenantId,
      state,
      inputItems,
      request,
      canonicalCompletionFromResponse(state),
      continuation,
    );
  } catch (error) {
    auditLog("error", "response_state_store_failed", {
      response_hash: auditHash(state.id),
      tenant_hash: auditHash(tenantId),
      error_type: error instanceof Error ? error.name : typeof error,
    });
    throw new ResponseContextError("Response continuation could not be stored");
  }
}

function storedResponseNotFound(responseId: string): Response {
  return openAiError(
    404,
    `Response ${responseId} was not found`,
    "invalid_request_error",
    "response_not_found",
    "response_id",
  );
}

function inputItemId(item: unknown): string | null {
  return typeof item === "object" && item !== null && "id" in item && typeof item.id === "string"
    ? item.id
    : null;
}

export function handleStoredResponse(
  request: Request,
  dependencies: ResponsesDependencies,
  responseId: string,
  action: StoredResponseAction,
): Response {
  const tenantId = responseStoreTenant(dependencies.tenantId);
  const store = dependencies.responseStore;
  if (!store) {
    return openAiError(
      503,
      "Responses state storage is unavailable",
      "service_unavailable",
      "response_store_unavailable",
    );
  }
  const stored = store.get(tenantId, responseId);
  if (!stored) return storedResponseNotFound(responseId);

  switch (action) {
    case "retrieve":
      return Response.json(stored.response);
    case "delete":
      store.delete(tenantId, responseId);
      return Response.json({
        id: responseId,
        object: "response.deleted",
        deleted: true,
      });
    case "cancel":
      return openAiError(
        400,
        `Response ${responseId} is already ${stored.response.status}`,
        "invalid_request_error",
        "response_not_cancellable",
        "response_id",
      );
    case "input_items": {
      const url = new URL(request.url);
      const requestedLimit = Number(url.searchParams.get("limit") ?? "20");
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
        return openAiError(
          400,
          "limit must be an integer between 1 and 100",
          "invalid_request_error",
          "invalid_parameter",
          "limit",
        );
      }
      const order = url.searchParams.get("order") ?? "desc";
      if (order !== "asc" && order !== "desc") {
        return openAiError(
          400,
          "order must be asc or desc",
          "invalid_request_error",
          "invalid_parameter",
          "order",
        );
      }
      const ordered = order === "asc" ? [...stored.inputItems] : [...stored.inputItems].reverse();
      const after = url.searchParams.get("after");
      const afterIndex =
        after === null ? undefined : ordered.findIndex((item) => inputItemId(item) === after);
      if (after !== null && afterIndex === -1) {
        return openAiError(
          400,
          `Input item cursor ${after} was not found`,
          "invalid_request_error",
          "invalid_cursor",
          "after",
        );
      }
      const start = afterIndex === undefined ? 0 : afterIndex + 1;
      const data = ordered.slice(start, start + requestedLimit);
      return Response.json({
        object: "list",
        data,
        first_id: data.length > 0 ? inputItemId(data[0]) : null,
        last_id: data.length > 0 ? inputItemId(data[data.length - 1]) : null,
        has_more: start + data.length < ordered.length,
      });
    }
  }
}

// allow: SIZE_OK — mirrors the established ingress boundary and owns one response conversion.
export async function handleResponses(
  request: Request,
  config: Config,
  dependencies: ResponsesDependencies,
): Promise<Response> {
  const ingress = createIngress(
    request,
    config,
    dependencies.createRequestIdleTimeoutLease,
    dependencies.diagnostics,
  );
  let plan: ResponsesExecutionPlan | undefined;
  try {
    const response = await handleResponsesCore(request, config, dependencies, ingress, (value) => {
      plan = value;
    });
    return plan ? responseDiagnostics(response, plan) : response;
  } catch (error) {
    ingress.finalize();
    if (error instanceof ResponseContextError) {
      return openAiError(
        409,
        error.message,
        "invalid_request_error",
        error.code,
        "previous_response_id",
      );
    }
    throw error;
  }
}

async function handleResponsesCore(
  request: Request,
  config: Config,
  dependencies: ResponsesDependencies,
  ingress: ReturnType<typeof createIngress>,
  setPlan: (plan: ResponsesExecutionPlan) => void,
): Promise<Response> {
  const bodyResult = await readJsonBody(request, config, ingress.signals, openAiIngressErrors);
  if (!bodyResult.ok) {
    ingress.finalize();
    return bodyResult.response;
  }
  const normalized = normalizeResponsesRequest(bodyResult.value, config);
  if (normalized instanceof Response) {
    ingress.finalize();
    return normalized;
  }
  const normalizedBody = normalized.request;
  const storedPrevious = normalizedBody.previous_response_id
    ? dependencies.responseStore?.get(
        responseStoreTenant(dependencies.tenantId),
        normalizedBody.previous_response_id,
      )
    : undefined;
  const adaptation =
    config.protocol_projection_mode === "v3-auto" && storedPrevious?.transport !== "stateless"
      ? prepareNativeAdaptation(
          normalizedBody,
          config,
          storedPrevious?.continuation
            ? {
                ...storedPrevious.continuation,
                output:
                  storedPrevious.continuation.output ??
                  (storedPrevious.response.output as ResponsesInputItem[]),
              }
            : undefined,
          dependencies.accountManager.reconcileFromDb(),
        )
      : undefined;
  if (adaptation instanceof Response) {
    ingress.finalize();
    return adaptation;
  }
  const routingBody = adaptation?.wireRequest ?? normalizedBody;
  const v3Route =
    config.protocol_projection_mode === "v3-auto"
      ? selectV3Route(routingBody, dependencies)
      : undefined;
  if (v3Route?.transport !== "reject") {
    const transport =
      adaptation && v3Route?.transport === "native"
        ? "native-adapted"
        : (v3Route?.transport ?? "stateless");
    const compatibility = responsesCompatibility(normalizedBody, transport);
    setPlan({ transport, reason: v3Route?.reason ?? "legacy_mode", compatibility });
    const rejected = fidelityRejection(
      compatibility.filter((loss) => loss.code !== "instruction_role_projection"),
      config,
    );
    if (rejected) {
      ingress.finalize();
      return rejected;
    }
  }
  if (v3Route !== undefined) {
    auditLog(v3Route.transport === "reject" ? "warn" : "info", "responses_route_selected", {
      request_id: ingress.requestId,
      transport:
        adaptation && v3Route.transport === "native" ? "native-adapted" : v3Route.transport,
      reason: v3Route.reason,
      model: requestedModel(bodyResult.value),
      requested_effort: requestedEffort(bodyResult.value),
      previous_response_present: previousResponsePresent(bodyResult.value),
      ...(v3Route.transport === "reject"
        ? {
            required_transport: "stateless",
            requirement: v3Route.requirement.reason,
            param: v3Route.requirement.param,
          }
        : {}),
    });
  }
  if (v3Route?.transport === "reject") {
    ingress.finalize();
    return openAiError(
      400,
      `Response continuation cannot switch from native to stateless transport for ${v3Route.requirement.param}`,
      "invalid_request_error",
      "native_response_transport_conflict",
      v3Route.requirement.param,
    );
  }
  if (v3Route?.transport === "native") {
    let nativeStreamOwnsResources = false;
    let nativeCompatibility: readonly import("../responses/request-policy.js").CompatibilityLoss[] =
      [];
    try {
      ingress.disableIdleTimeout();
      const proxied = await proxyNativeResponses({
        requestId: ingress.requestId,
        rawBody: normalizedBody,
        normalized: { ...normalized, request: routingBody },
        adaptation,
        onCompatibility: (losses) => {
          nativeCompatibility = losses;
          const transport = adaptation ? "native-adapted" : "native";
          setPlan({
            transport,
            reason: v3Route.reason,
            compatibility: [...responsesCompatibility(normalizedBody, transport), ...losses],
          });
        },
        request,
        config,
        dependencies,
        signals: ingress.signals,
        finalize: ingress.finalize,
      });
      nativeStreamOwnsResources = proxied.streamOwnsResources;
      if (proxied.transport)
        setPlan({
          transport: proxied.transport,
          reason: v3Route.reason,
          compatibility: [
            ...responsesCompatibility(normalizedBody, proxied.transport),
            ...nativeCompatibility,
          ],
        });
      return proxied.response;
    } finally {
      if (!nativeStreamOwnsResources) ingress.finalize();
    }
  }

  const parsed = parseResponsesRequest(normalizedBody);
  if (hasNativeReasoning(normalizedBody)) {
    ingress.finalize();
    return openAiError(
      400,
      "Native reasoning cannot be decoded by the stateless transport",
      "invalid_request_error",
      "native_response_transport_conflict",
      "input",
    );
  }
  if (!parsed.ok) {
    ingress.finalize();
    return parsed.response;
  }
  if (parsed.value.safety_identifier !== undefined || parsed.value.user !== undefined) {
    auditLog("debug", "responses_client_identity", {
      request_id: ingress.requestId,
      safety_identifier_hash:
        parsed.value.safety_identifier === undefined
          ? undefined
          : auditHash(parsed.value.safety_identifier),
      deprecated_user_hash:
        parsed.value.user === undefined ? undefined : auditHash(parsed.value.user),
    });
  }
  const tenantId = responseStoreTenant(dependencies.tenantId);
  let previous: ResponsesPreviousContext | undefined;
  if (parsed.value.previous_response_id !== undefined) {
    const stored = dependencies.responseStore?.get(tenantId, parsed.value.previous_response_id);
    if (!stored) {
      ingress.finalize();
      return openAiError(
        404,
        `Response ${parsed.value.previous_response_id} was not found`,
        "invalid_request_error",
        "response_not_found",
        "previous_response_id",
      );
    }
    previous = previousContext(stored);
  }
  const affinity = responsesSessionAffinity(
    parsed.value,
    dependencies.tenantId,
    config.session_affinity_mode,
  );
  const currentInput =
    typeof parsed.value.input === "string"
      ? [{ role: "user" as const, content: parsed.value.input }]
      : parsed.value.input;
  const logicalInput = [...(previous?.input ?? []), ...currentInput];
  let compatibility = [
    ...responsesCompatibility({ ...parsed.value, input: logicalInput }, "stateless"),
  ];
  for (const message of previous?.messages ?? []) {
    if (message.role === "system" || message.role === "developer")
      compatibility.push({ code: "instruction_role_projection", param: "previous_response_id" });
    if (message.sourceMetadata?.phase)
      compatibility.push({ code: "assistant_phase_unavailable", param: "previous_response_id" });
  }
  const strictInstructions =
    config.responses_fidelity_mode === "strict" &&
    compatibility.some((loss) => loss.code === "instruction_role_projection");
  const strictRejection = fidelityRejection(
    compatibility.filter((loss) => loss.code !== "instruction_role_projection"),
    config,
  );
  setPlan({ transport: "stateless", reason: v3Route?.reason ?? "legacy_mode", compatibility });
  if (strictRejection) {
    ingress.finalize();
    return strictRejection;
  }
  const projectionMode =
    strictInstructions && config.protocol_projection_mode !== "safe"
      ? "native-context-safe"
      : config.protocol_projection_mode === "v3-auto"
        ? "legacy-user-prefix"
        : config.protocol_projection_mode;
  const adapted = adaptResponsesRequest(parsed.value, projectionMode, previous);
  if (!adapted.ok) {
    auditLog("warn", "protocol_projection_rejected", {
      request_id: ingress.requestId,
      protocol: "responses",
      projection_mode: projectionMode,
      code: adapted.code,
      param: adapted.param,
    });
    ingress.finalize();
    return openAiError(
      400,
      adapted.message ?? "input produced no messages",
      "invalid_request_error",
      adapted.code,
      adapted.param,
    );
  }
  const responseConfiguration = responseConfigurationFromCanonical(adapted.body);
  const continuation = (state: ResponseStateObject): ResponseContinuationContext => ({
    transport: "stateless",
    request: { ...parsed.value, input: logicalInput },
    output: state.output as ResponsesInputItem[],
    ...(previous?.legacyRequest ? { legacyRequest: previous.legacyRequest } : {}),
  });
  const lineage = canonicalSessionLineage(adapted.body, dependencies.tenantId);
  const responseId = `resp_${randomUUID()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const inputItems = responseInputItems(parsed.value.input);

  const stream = parsed.value.stream;
  let streamOwnsRouteResources = false;
  try {
    ingress.disableIdleTimeout();

    const pipelineResponse = await (dependencies.runPipeline ?? runChatCompletion)({
      ...buildPipelineOptions({
        requestId: ingress.requestId,
        diagnostics: ingress.diagnostics,
        body: adapted.body,
        model: adapted.body.model,
        stream,
        config,
        dependencies,
        affinity,
        lineage,
        deadlineSignal: ingress.signals.combined,
      }),
      onProjection: ({ projection }) => {
        if (projection.instructionChannel === "kiro-runtime-system-prompt") {
          compatibility = compatibility.filter(
            (loss) => loss.code !== "instruction_role_projection",
          );
          setPlan({
            transport: "stateless",
            reason: v3Route?.reason ?? "legacy_mode",
            compatibility,
          });
        }
      },
    });
    // Re-read the live request signal: a client that left while the pipeline
    // ran must not receive a body that would keep the account lease busy.
    if (request.signal.aborted && !ingress.signals.deadline.aborted) {
      void boundedCleanup(() => pipelineResponse.body?.cancel());
      return openAiIngressErrors.clientClosed();
    }

    const contentType = pipelineResponse.headers.get("Content-Type") ?? "";
    if (!pipelineResponse.ok) return await withRetryAfter(pipelineResponse);
    if (stream) {
      if (!contentType.includes(CANONICAL_OUTPUT_STREAM_MEDIA_TYPE)) {
        void boundedCleanup(() => pipelineResponse.body?.cancel());
        return openAiError(
          500,
          "Pipeline returned an unsupported streaming response",
          "internal_error",
          "invalid_pipeline_response",
        );
      }
      const streaming = responsesSseAdapter(pipelineResponse, {
        responseId,
        createdAt,
        model: adapted.body.model,
        signals: ingress.signals,
        finalize: ingress.finalize,
        bridge: adapted.bridge,
        configuration: responseConfiguration,
        includeEncryptedReasoning: adapted.body.includeEncryptedReasoning,
        captureEncryptedReasoning: adapted.body.store !== false,
        onCompleted: (state) =>
          persistResponse(
            dependencies,
            tenantId,
            publicResponseState(state, adapted.body.includeEncryptedReasoning),
            inputItems,
            adapted.body,
            continuation(state),
          ),
      });
      streamOwnsRouteResources = true;
      return streaming;
    }
    if (contentType.includes(CANONICAL_OUTPUT_JSON_MEDIA_TYPE)) {
      const payload = parseCanonicalCompletion(await pipelineResponse.json());
      if (payload && payload.model === adapted.body.model) {
        const projected = completedResponse(
          payload,
          adapted.body.model,
          adapted.bridge,
          responseConfiguration,
          responseId,
          createdAt,
        );
        if (!projected.ok) return projected.response;
        const publicState = publicResponseState(
          projected.state,
          adapted.body.includeEncryptedReasoning,
        );
        try {
          persistResponse(
            dependencies,
            tenantId,
            publicState,
            inputItems,
            adapted.body,
            continuation(projected.state),
          );
        } catch {
          return openAiError(
            502,
            "Response continuation could not be stored",
            "upstream_error",
            "response_state_store_failed",
          );
        }
        return Response.json(publicState);
      }
      return openAiError(
        500,
        "Pipeline returned an invalid non-streaming response",
        "internal_error",
        "invalid_pipeline_response",
      );
    }
    void boundedCleanup(() => pipelineResponse.body?.cancel());
    return openAiError(
      500,
      "Pipeline returned an unsupported response",
      "internal_error",
      "invalid_pipeline_response",
    );
  } finally {
    if (!streamOwnsRouteResources) ingress.finalize();
  }
}
