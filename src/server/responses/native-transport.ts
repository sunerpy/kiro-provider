import { createHash } from "node:crypto";
import type { Config } from "../../config/schema.js";
import { auditHash, auditLog } from "../../core/audit-log.js";
import { acquireAccountQueue } from "../../core/pipeline-runtime.js";
import { resolveProxyUrl } from "../../core/proxy.js";
import { KIRO_CONSTANTS } from "../../kiro/constants.js";
import { resolveModelVariant } from "../../kiro/models.js";
import type { ManagedAccount } from "../../kiro/types.js";
import { openAiError } from "../errors.js";
import type { RouteDependencies } from "../ingress.js";
import type { IngressSignals } from "../request-lifecycle.js";
import { type ResponsesRequest, ResponsesRequestSchema } from "../request-schema.js";
import type { ResponseStateObject } from "./state.js";
import { responseInputItems, responseStoreTenant } from "./store.js";

const NATIVE_RESPONSE_AFFINITY_TTL_MS = 30 * 24 * 60 * 60_000;
const NATIVE_RESPONSE_AFFINITY_MAX_ENTRIES = 100_000;

const NATIVE_REQUEST_KEYS = new Set([
  "model",
  "input",
  "instructions",
  "stream",
  "stream_options",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "include",
  "store",
  "text",
  "service_tier",
  "prompt_cache_key",
  "metadata",
  "client_metadata",
  "previous_response_id",
  "conversation",
  "max_output_tokens",
  "temperature",
  "top_p",
  "truncation",
  "background",
  "max_tool_calls",
  "context_management",
  "moderation",
  "prompt",
  "prompt_cache_options",
  "prompt_cache_retention",
  "safety_identifier",
  "top_logprobs",
  "user",
]);

const FORWARDED_REQUEST_KEYS = new Set([
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "stream",
  "max_output_tokens",
  "temperature",
  "top_p",
  "truncation",
  "reasoning",
  "previous_response_id",
]);

export type NativeResponsesFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface NativeResponsesProxyOptions {
  readonly requestId: string;
  readonly rawBody: unknown;
  readonly request: Request;
  readonly config: Config;
  readonly dependencies: RouteDependencies;
  readonly signals: IngressSignals;
  readonly finalize: () => void;
}

export interface NativeResponsesProxyResult {
  readonly response: Response;
  readonly streamOwnsResources: boolean;
}

interface PreparedNativeRequest {
  readonly request: ResponsesRequest;
  readonly requestedModel: string;
  readonly wireModel: string;
  readonly stream: boolean;
  readonly body: Readonly<Record<string, unknown>>;
  readonly inputItems: readonly unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nativeAffinityKey(tenantId: string, responseId: string): string {
  return createHash("sha256")
    .update("kiro-provider-native-response-affinity-v1\0")
    .update(tenantId)
    .update("\0")
    .update(responseId)
    .digest("hex");
}

function validationError(message: string, code: string, param?: string): Response {
  return openAiError(400, message, "invalid_request_error", code, param);
}

function prepareNativeRequest(rawBody: unknown): PreparedNativeRequest | Response {
  if (!isRecord(rawBody)) {
    return validationError("Request body must be a JSON object", "invalid_request");
  }
  for (const key of Object.keys(rawBody)) {
    if (!NATIVE_REQUEST_KEYS.has(key)) {
      return validationError(
        `Responses parameter ${key} is not supported`,
        "unsupported_parameter",
        key,
      );
    }
  }
  const parsed = ResponsesRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const param = issue?.path.length ? issue.path.join(".") : undefined;
    return validationError(
      `Invalid request: ${issue?.message ?? "schema validation failed"}`,
      "invalid_request",
      param,
    );
  }
  const request = parsed.data;
  if (request.store === false) {
    return validationError(
      "store=false must use the stateless Responses transport and cannot continue a native stored response",
      "native_store_false_requires_stateless_transport",
      "store",
    );
  }
  if (request.stream_options?.include_obfuscation === true) {
    return validationError(
      "Kiro native Responses does not support stream obfuscation",
      "unsupported_parameter",
      "stream_options.include_obfuscation",
    );
  }
  const unsupportedInclude = request.include?.find(
    (value) => value !== "reasoning.encrypted_content",
  );
  if (unsupportedInclude !== undefined) {
    return validationError(
      `Responses include value ${unsupportedInclude} is not supported`,
      "unsupported_parameter",
      "include",
    );
  }
  if (request.include?.includes("reasoning.encrypted_content")) {
    return validationError(
      "Encrypted reasoning replay requires the stateless Responses transport",
      "native_encrypted_reasoning_requires_stateless_transport",
      "include",
    );
  }
  if (request.parallel_tool_calls === false) {
    return validationError(
      "parallel_tool_calls=false requires the stateless Responses transport",
      "native_parallel_tool_control_requires_stateless_transport",
      "parallel_tool_calls",
    );
  }
  if (request.background === true) {
    return validationError(
      "Kiro native Responses does not support background execution",
      "unsupported_parameter",
      "background",
    );
  }
  if (request.conversation !== undefined) {
    return validationError(
      "Kiro native Responses supports previous_response_id but not conversation objects",
      "unsupported_parameter",
      "conversation",
    );
  }
  for (const field of [
    "max_tool_calls",
    "context_management",
    "moderation",
    "prompt",
    "prompt_cache_options",
    "prompt_cache_retention",
  ] as const) {
    if (request[field] !== undefined) {
      return validationError(
        `Responses parameter ${field} is not implemented by Kiro native Responses`,
        "unsupported_parameter",
        field,
      );
    }
  }
  if (request.top_logprobs !== undefined && request.top_logprobs !== 0) {
    return validationError(
      "Kiro native Responses does not expose token log probabilities",
      "unsupported_parameter",
      "top_logprobs",
    );
  }
  if (
    request.service_tier !== undefined &&
    request.service_tier !== null &&
    request.service_tier !== "auto" &&
    request.service_tier !== "default"
  ) {
    return validationError(
      `service_tier=${request.service_tier} is not available through Kiro`,
      "unsupported_parameter",
      "service_tier",
    );
  }
  if (request.text !== undefined) {
    if (!isRecord(request.text)) {
      return validationError("text must be an object", "invalid_request", "text");
    }
    const format = request.text.format;
    if (
      format !== undefined &&
      (!isRecord(format) || (format.type !== undefined && format.type !== "text"))
    ) {
      return validationError(
        "Structured Outputs are not implemented by Kiro native Responses",
        "unsupported_structured_output",
        "text.format",
      );
    }
    if (
      request.text.verbosity !== undefined &&
      request.text.verbosity !== "low" &&
      request.text.verbosity !== "medium" &&
      request.text.verbosity !== "high"
    ) {
      return validationError(
        "text.verbosity must be low, medium, or high",
        "invalid_request",
        "text.verbosity",
      );
    }
    const unsupportedTextKey = Object.keys(request.text).find(
      (key) => key !== "format" && key !== "verbosity",
    );
    if (unsupportedTextKey !== undefined) {
      return validationError(
        `Responses parameter text.${unsupportedTextKey} is not supported`,
        "unsupported_parameter",
        `text.${unsupportedTextKey}`,
      );
    }
  }
  const unsupportedTool = request.tools?.find((tool) => tool.type !== "function");
  if (unsupportedTool !== undefined) {
    return validationError(
      `Kiro native Responses supports function tools, not ${unsupportedTool.type}`,
      "unsupported_tool_type",
      "tools",
    );
  }
  if (typeof request.input !== "string") {
    const unsupportedInput = request.input.find(
      (item) =>
        item.type === "additional_tools" ||
        item.type === "agent_message" ||
        item.type === "custom_tool_call" ||
        item.type === "custom_tool_call_output" ||
        (item.type === "function_call" && item.namespace !== undefined),
    );
    if (unsupportedInput !== undefined) {
      return validationError(
        `Input item type ${unsupportedInput.type} requires the stateless Responses transport`,
        "native_input_requires_stateless_transport",
        "input",
      );
    }
  }

  let variant: ReturnType<typeof resolveModelVariant>;
  try {
    variant = resolveModelVariant(request.model);
  } catch (error) {
    return validationError(
      error instanceof Error ? error.message : "Unsupported model",
      "unsupported_model",
      "model",
    );
  }
  const isGpt = variant.wireId.startsWith("gpt-");
  const isClaude = variant.wireId.startsWith("claude-");
  if (variant.effort === "max" || request.reasoning?.effort === "max") {
    return validationError(
      "reasoning effort max requires the stateless Responses transport",
      "native_max_effort_requires_stateless_transport",
      request.reasoning?.effort === "max" ? "reasoning.effort" : "model",
    );
  }
  if (request.temperature !== undefined && request.temperature !== null && !isClaude) {
    return validationError(
      `temperature is not supported for ${request.model}`,
      "unsupported_parameter",
      "temperature",
    );
  }
  if (request.top_p !== undefined && request.top_p !== null) {
    return validationError(
      `top_p is not supported for ${request.model}`,
      "unsupported_parameter",
      "top_p",
    );
  }
  if (request.truncation === "auto" && !isGpt) {
    return validationError(
      `truncation=auto is not supported for ${request.model}`,
      "unsupported_parameter",
      "truncation",
    );
  }

  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (FORWARDED_REQUEST_KEYS.has(key) && value !== undefined && value !== null) {
      body[key] = value;
    }
  }
  body.model = variant.wireId;
  const requestedEffort = isRecord(request.reasoning) ? request.reasoning.effort : undefined;
  if (isRecord(request.reasoning) || variant.effort !== undefined) {
    const reasoning: Record<string, unknown> = {};
    if (isRecord(request.reasoning)) {
      if (typeof request.reasoning.effort === "string") {
        reasoning.effort = request.reasoning.effort;
      }
      if (typeof request.reasoning.summary === "string" && request.reasoning.summary !== "none") {
        reasoning.summary = request.reasoning.summary;
      }
    }
    if (variant.effort !== undefined && requestedEffort === undefined) {
      reasoning.effort = variant.effort;
    }
    if (Object.keys(reasoning).length > 0) body.reasoning = reasoning;
    else delete body.reasoning;
  }
  return {
    request,
    requestedModel: request.model,
    wireModel: variant.wireId,
    stream: request.stream,
    body,
    inputItems: responseInputItems(request.input),
  };
}

function responseHeaders(upstream: Response, contentType: string): Headers {
  const headers = new Headers({ "Content-Type": contentType });
  for (const name of ["cache-control", "retry-after", "x-amzn-requestid", "x-request-id"]) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

function normalizeResponseObject(
  value: unknown,
  prepared: PreparedNativeRequest,
): ResponseStateObject | undefined {
  if (
    !isRecord(value) ||
    value.object !== "response" ||
    typeof value.id !== "string" ||
    !Array.isArray(value.output)
  ) {
    return undefined;
  }
  const normalized: Record<string, unknown> = { ...value };
  delete normalized.billing;
  normalized.model = prepared.requestedModel;
  normalized.store = prepared.request.store !== false;
  normalized.metadata = prepared.request.metadata ?? {};
  normalized.service_tier =
    prepared.request.service_tier === "auto" || prepared.request.service_tier === "default"
      ? prepared.request.service_tier
      : (normalized.service_tier ?? null);
  normalized.user = prepared.request.user ?? null;
  normalized.safety_identifier = prepared.request.safety_identifier ?? null;
  normalized.prompt_cache_key = prepared.request.prompt_cache_key ?? null;
  return normalized as unknown as ResponseStateObject;
}

function upstreamError(upstream: Response, value: unknown): Response {
  const record = isRecord(value) ? value : {};
  const message =
    typeof record.message === "string"
      ? record.message
      : `Kiro upstream returned HTTP ${upstream.status}`;
  const reason = typeof record.reason === "string" ? record.reason : "kiro_runtime_error";
  return openAiError(
    upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502,
    message,
    upstream.status >= 500 ? "upstream_error" : "invalid_request_error",
    reason,
  );
}

function recordAffinity(
  dependencies: RouteDependencies,
  tenantId: string,
  account: ManagedAccount,
  responseId: string,
): void {
  dependencies.affinityStore?.claimSessionAffinity(
    nativeAffinityKey(tenantId, responseId),
    account.id,
    responseId,
    Date.now(),
    NATIVE_RESPONSE_AFFINITY_TTL_MS,
    NATIVE_RESPONSE_AFFINITY_MAX_ENTRIES,
  );
}

function preferredAccountId(
  dependencies: RouteDependencies,
  tenantId: string,
  previousResponseId: string | undefined,
): string | undefined {
  if (!previousResponseId) return undefined;
  return dependencies.affinityStore?.getSessionAffinity(
    nativeAffinityKey(tenantId, previousResponseId),
  )?.accountId;
}

function normalizedEventFrame(
  frame: string,
  prepared: PreparedNativeRequest,
): {
  readonly frame: string;
  readonly terminal?: ResponseStateObject;
  readonly responseId?: string;
} {
  const originalFrame = `${frame}\n\n`;
  const lines = frame.split(/\r?\n/);
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data.length === 0 || data === "[DONE]") return { frame: originalFrame };
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    return { frame: originalFrame };
  }
  if (!isRecord(event)) return { frame: originalFrame };
  const response = normalizeResponseObject(event.response, prepared);
  if (response === undefined) return { frame: originalFrame };
  const normalized = { ...event, response };
  const eventName = typeof event.type === "string" ? event.type : undefined;
  return {
    frame: `${eventName === undefined ? "" : `event: ${eventName}\n`}data: ${JSON.stringify(normalized)}\n\n`,
    ...(eventName === "response.completed" ||
    eventName === "response.failed" ||
    eventName === "response.incomplete" ||
    eventName === "response.cancelled"
      ? { terminal: response }
      : {}),
    responseId: response.id,
  };
}

function nativeStreamResponse(input: {
  readonly upstream: Response;
  readonly prepared: PreparedNativeRequest;
  readonly account: ManagedAccount;
  readonly dependencies: RouteDependencies;
  readonly tenantId: string;
  readonly release: () => void;
  readonly finalize: () => void;
}): Response {
  const upstreamBody =
    input.upstream.body ??
    new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let released = false;
  const observe = (normalized: ReturnType<typeof normalizedEventFrame>): void => {
    if (normalized.responseId !== undefined) {
      recordAffinity(input.dependencies, input.tenantId, input.account, normalized.responseId);
    }
    if (normalized.terminal !== undefined) {
      input.dependencies.responseStore?.putNative(
        input.tenantId,
        normalized.terminal,
        input.prepared.inputItems,
      );
    }
  };
  const finish = (): void => {
    if (released) return;
    released = true;
    input.release();
    input.finalize();
  };
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          while (true) {
            const separator = buffer.search(/\r?\n\r?\n/);
            if (separator >= 0) {
              const match = buffer.slice(separator).match(/^\r?\n\r?\n/);
              const separatorLength = match?.[0].length ?? 2;
              const frame = buffer.slice(0, separator);
              buffer = buffer.slice(separator + separatorLength);
              const normalized = normalizedEventFrame(frame, input.prepared);
              observe(normalized);
              controller.enqueue(encoder.encode(normalized.frame));
              return;
            }
            const next = await reader.read();
            if (next.done) {
              buffer += decoder.decode();
              if (buffer.trim().length > 0) {
                const normalized = normalizedEventFrame(buffer, input.prepared);
                observe(normalized);
                controller.enqueue(encoder.encode(normalized.frame));
              }
              controller.close();
              finish();
              return;
            }
            buffer += decoder.decode(next.value, { stream: true });
          }
        } catch (error) {
          controller.error(error);
          finish();
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          finish();
        }
      },
    }),
    {
      status: input.upstream.status,
      headers: responseHeaders(input.upstream, "text/event-stream; charset=utf-8"),
    },
  );
}

export async function proxyNativeResponses(
  options: NativeResponsesProxyOptions,
): Promise<NativeResponsesProxyResult> {
  const prepared = prepareNativeRequest(options.rawBody);
  if (prepared instanceof Response) {
    return { response: prepared, streamOwnsResources: false };
  }
  const tenantId = responseStoreTenant(options.dependencies.tenantId);
  if (prepared.request.previous_response_id !== undefined) {
    const previous = options.dependencies.responseStore?.get(
      tenantId,
      prepared.request.previous_response_id,
    );
    if (!previous) {
      return {
        response: openAiError(
          404,
          `Response ${prepared.request.previous_response_id} was not found`,
          "invalid_request_error",
          "response_not_found",
          "previous_response_id",
        ),
        streamOwnsResources: false,
      };
    }
  }
  const preferred = preferredAccountId(
    options.dependencies,
    tenantId,
    prepared.request.previous_response_id,
  );
  const account = options.dependencies.accountManager.selectHealthyAccount(preferred);
  if (!account) {
    return {
      response: openAiError(
        503,
        "No healthy Kiro account is available",
        "service_unavailable",
        "no_healthy_accounts",
      ),
      streamOwnsResources: false,
    };
  }
  const release = await acquireAccountQueue(account.id, options.signals.combined);
  let releaseOwned = true;
  try {
    const initialAuth = options.dependencies.accountManager.toAuthDetails(account);
    let refreshed = await options.dependencies.tokenRefresher.refreshIfNeeded(
      account,
      initialAuth,
      options.signals.combined,
    );
    let auth = options.dependencies.accountManager.toAuthDetails(refreshed);
    if (options.dependencies.modelCapabilities) {
      const availability = await options.dependencies.modelCapabilities.ensureAccountModel(
        refreshed,
        auth,
        prepared.requestedModel,
        options.signals.combined,
      );
      if (!availability.supported) {
        return {
          response: validationError(
            `Model ${prepared.requestedModel} is not available for the selected Kiro account`,
            "unsupported_model",
            "model",
          ),
          streamOwnsResources: false,
        };
      }
    }
    const endpoint =
      options.config.test_upstream_endpoint ??
      KIRO_CONSTANTS.RUNTIME_ENDPOINT.replace("{{region}}", auth.region);
    const fetcher = options.dependencies.nativeResponsesFetch ?? fetch;
    auditLog("info", "native_responses_dispatch_started", {
      request_id: options.requestId,
      account_hash: auditHash(refreshed.id),
      model: prepared.requestedModel,
      wire_model: prepared.wireModel,
      stream: prepared.stream,
      previous_response_present: prepared.request.previous_response_id !== undefined,
    });
    const dispatch = (): Promise<Response> =>
      fetcher(`${endpoint}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.access}`,
          "Content-Type": "application/json",
          "User-Agent": "KiroCLI/2.21.1 KAS/0.58.7 kiro-provider/3",
          "x-amzn-kiro-origin": KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
          ...(auth.profileArn ? { "x-amzn-kiro-profile": auth.profileArn } : {}),
        },
        body: JSON.stringify(prepared.body),
        signal: options.signals.combined,
        ...(resolveProxyUrl(options.config) ? { proxy: resolveProxyUrl(options.config) } : {}),
      });
    let upstream = await dispatch();
    if (upstream.status === 401 || upstream.status === 403) {
      await upstream.body?.cancel();
      refreshed = await options.dependencies.tokenRefresher.forceRefresh(
        refreshed,
        options.signals.combined,
      );
      auth = options.dependencies.accountManager.toAuthDetails(refreshed);
      upstream = await dispatch();
    }
    if (upstream.status === 429) {
      const retryAfterSeconds = Number(upstream.headers.get("retry-after"));
      const resetTime =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
          ? Date.now() + retryAfterSeconds * 1_000
          : Date.now() + options.config.rate_limit_retry_delay_ms;
      options.dependencies.accountManager.markRateLimited(refreshed, resetTime);
    }
    if (!upstream.ok) {
      const value = await upstream.json().catch(() => undefined);
      return { response: upstreamError(upstream, value), streamOwnsResources: false };
    }
    if (prepared.stream) {
      releaseOwned = false;
      return {
        response: nativeStreamResponse({
          upstream,
          prepared,
          account: refreshed,
          dependencies: options.dependencies,
          tenantId,
          release,
          finalize: options.finalize,
        }),
        streamOwnsResources: true,
      };
    }
    const value = await upstream.json().catch(() => undefined);
    const normalized = normalizeResponseObject(value, prepared);
    if (!normalized) {
      return {
        response: openAiError(
          502,
          "Kiro native Responses returned an invalid response",
          "upstream_error",
          "invalid_upstream_response",
        ),
        streamOwnsResources: false,
      };
    }
    recordAffinity(options.dependencies, tenantId, refreshed, normalized.id);
    options.dependencies.responseStore?.putNative(tenantId, normalized, prepared.inputItems);
    return {
      response: Response.json(normalized, {
        headers: responseHeaders(upstream, "application/json; charset=utf-8"),
      }),
      streamOwnsResources: false,
    };
  } catch (error) {
    if (options.signals.deadline.aborted) {
      return {
        response: openAiError(504, "Request deadline exceeded", "timeout_error", "request_timeout"),
        streamOwnsResources: false,
      };
    }
    if (options.signals.client.aborted) {
      return {
        response: openAiError(
          499,
          "Client closed request",
          "request_aborted",
          "client_disconnected",
        ),
        streamOwnsResources: false,
      };
    }
    auditLog("error", "native_responses_dispatch_failed", {
      request_id: options.requestId,
      error_type: error instanceof Error ? error.name : typeof error,
      error_hash: auditHash(error instanceof Error ? error.message : String(error)),
    });
    return {
      response: openAiError(
        502,
        "Kiro native Responses request failed",
        "upstream_error",
        "native_responses_transport_error",
      ),
      streamOwnsResources: false,
    };
  } finally {
    if (releaseOwned) release();
  }
}
