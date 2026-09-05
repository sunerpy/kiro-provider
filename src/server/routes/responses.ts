import { randomUUID } from "node:crypto";
import type { Config } from "../../config/schema.js";
import { auditHash, auditLog } from "../../core/audit-log.js";
import { runChatCompletion } from "../../core/pipeline.js";
import { boundedCleanup } from "../../core/stream-cleanup.js";
import { textPart } from "../../protocol/adapter-utils.js";
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
import { parseResponsesRequest, type ResponsesInputItem } from "../request-schema.js";
import type {
  MessageOutputItem,
  OutputTextContent,
  ReasoningOutputItem,
  ResponseOutputItem,
  ResponseToolCallItem,
  ResponseUsage,
} from "../responses/events.js";
import { proxyNativeResponses } from "../responses/native-transport.js";
import { isGptSolReasoningPlaceholder } from "../responses/reasoning.js";
import {
  adaptResponsesRequest,
  type ResponsesPreviousContext,
} from "../responses/request-adapter.js";
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

function requiresStatelessV3(body: Readonly<Record<string, unknown>>): boolean {
  if (body.store === false) return true;
  if (typeof body.model === "string" && body.model.endsWith("-max")) return true;
  const reasoning = body.reasoning;
  if (isRecord(reasoning) && reasoning.effort === "max") return true;
  if (body.parallel_tool_calls === false) return true;
  if (
    Array.isArray(body.tools) &&
    body.tools.some(
      (tool) => isRecord(tool) && (tool.type === "custom" || tool.type === "namespace"),
    )
  ) {
    return true;
  }
  if (
    Array.isArray(body.include) &&
    body.include.some((value) => value === "reasoning.encrypted_content")
  ) {
    return true;
  }
  if (!Array.isArray(body.input)) return false;
  return body.input.some(
    (item) =>
      isRecord(item) &&
      (item.type === "additional_tools" ||
        item.type === "agent_message" ||
        item.type === "custom_tool_call" ||
        item.type === "custom_tool_call_output" ||
        (item.type === "function_call" && typeof item.namespace === "string")),
  );
}

function shouldUseNativeV3(body: unknown, dependencies: ResponsesDependencies): boolean {
  if (!isRecord(body)) return true;
  const previousResponseId = body.previous_response_id;
  if (typeof previousResponseId === "string") {
    const stored = dependencies.responseStore?.get(
      responseStoreTenant(dependencies.tenantId),
      previousResponseId,
    );
    if (stored?.request !== undefined && stored.completion !== undefined) return false;
    return true;
  }
  return !requiresStatelessV3(body);
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

function parsedToolInput(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch (error) {
    if (error instanceof SyntaxError) return input;
    throw error;
  }
}

function previousContext(stored: StoredResponse): ResponsesPreviousContext {
  if (!stored.request || !stored.completion) {
    throw new TypeError("Stored native response cannot be expanded through the legacy adapter");
  }
  const messages: CanonicalMessage[] = stored.request.messages
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
  if (stored.completion.text.length > 0 || stored.completion.toolCalls.length > 0) {
    messages.push({
      role: "assistant",
      content:
        stored.completion.text.length > 0
          ? [textPart(stored.completion.text, `stored_response.${stored.response.id}.text`)]
          : [],
      toolCalls: stored.completion.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        input: parsedToolInput(call.input),
        path: `stored_response.${stored.response.id}.tool_calls.${call.id}`,
      })),
      path: `stored_response.${stored.response.id}`,
    });
  }
  const items: ResponsesInputItem[] = [];
  for (const item of stored.response.output) {
    if (item.type === "function_call") {
      items.push({
        type: "function_call",
        id: item.id,
        status: item.status,
        call_id: item.call_id,
        ...(item.namespace !== undefined ? { namespace: item.namespace } : {}),
        name: item.name,
        arguments: item.arguments,
      });
      continue;
    }
    if (item.type === "custom_tool_call") {
      items.push({
        type: "custom_tool_call",
        id: item.id,
        status: item.status,
        call_id: item.call_id,
        ...(item.namespace !== undefined ? { namespace: item.namespace } : {}),
        name: item.name,
        input: item.input,
      });
    }
  }
  return { messages, items };
}

function persistResponse(
  dependencies: ResponsesDependencies,
  tenantId: string,
  state: ResponseStateObject,
  inputItems: readonly unknown[],
  request: Parameters<NonNullable<ResponsesDependencies["responseStore"]>["put"]>[3],
): void {
  if (!state.store || !dependencies.responseStore) return;
  try {
    dependencies.responseStore.put(
      tenantId,
      state,
      inputItems,
      request,
      canonicalCompletionFromResponse(state),
    );
  } catch (error) {
    auditLog("error", "response_state_store_failed", {
      response_hash: auditHash(state.id),
      tenant_hash: auditHash(tenantId),
      error_type: error instanceof Error ? error.name : typeof error,
    });
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
  const ingress = createIngress(request, config, dependencies.createRequestIdleTimeoutLease);
  const bodyResult = await readJsonBody(request, config, ingress.signals, openAiIngressErrors);
  if (!bodyResult.ok) {
    ingress.finalize();
    return bodyResult.response;
  }
  if (
    config.protocol_projection_mode === "v3-auto" &&
    shouldUseNativeV3(bodyResult.value, dependencies)
  ) {
    let nativeStreamOwnsResources = false;
    try {
      ingress.disableIdleTimeout();
      const proxied = await proxyNativeResponses({
        requestId: ingress.requestId,
        rawBody: bodyResult.value,
        request,
        config,
        dependencies,
        signals: ingress.signals,
        finalize: ingress.finalize,
      });
      nativeStreamOwnsResources = proxied.streamOwnsResources;
      return proxied.response;
    } finally {
      if (!nativeStreamOwnsResources) ingress.finalize();
    }
  }

  const parsed = parseResponsesRequest(bodyResult.value);
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
  const projectionMode =
    config.protocol_projection_mode === "v3-auto"
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
  const lineage = canonicalSessionLineage(adapted.body, dependencies.tenantId);
  const responseId = `resp_${randomUUID()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const inputItems = responseInputItems(parsed.value.input);

  const stream = parsed.value.stream;
  let streamOwnsRouteResources = false;
  try {
    ingress.disableIdleTimeout();

    const pipelineResponse = await (dependencies.runPipeline ?? runChatCompletion)(
      buildPipelineOptions({
        requestId: ingress.requestId,
        body: adapted.body,
        model: adapted.body.model,
        stream,
        config,
        dependencies,
        affinity,
        lineage,
        deadlineSignal: ingress.signals.combined,
      }),
    );
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
        onCompleted: (state) =>
          persistResponse(dependencies, tenantId, state, inputItems, adapted.body),
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
        persistResponse(dependencies, tenantId, projected.state, inputItems, adapted.body);
        return Response.json(projected.state);
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
