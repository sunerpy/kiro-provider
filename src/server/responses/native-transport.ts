import { createHash } from "node:crypto";
import type { Config } from "../../config/schema.js";
import { auditHash, auditLog } from "../../core/audit-log.js";
import { abortable, abortableSleep, acquireAccountQueue } from "../../core/pipeline-runtime.js";
import { resolveProxyUrl } from "../../core/proxy.js";
import { retryAfterMs } from "../../core/retry-after.js";
import { boundedCleanup } from "../../core/stream-cleanup.js";
import {
  toolOutputValidator,
  type ValidateToolArguments,
} from "../../core/tool-output-validation.js";
import { readUpstreamErrorBody } from "../../core/upstream-error-body.js";
import { KIRO_CONSTANTS } from "../../kiro/constants.js";
import { isAccessTokenError } from "../../kiro/health.js";
import { resolveModelVariant } from "../../kiro/models.js";
import { RequestTransformError } from "../../kiro/transform/errors.js";
import { SdkStreamProtocolError } from "../../kiro/transform/streaming/sdk-stream-runtime.js";
import type { ManagedAccount } from "../../kiro/types.js";
import { canonicalFingerprint } from "../../protocol/canonical.js";
import { openAiError } from "../errors.js";
import type { RouteDependencies } from "../ingress.js";
import type { IngressSignals } from "../request-lifecycle.js";
import type { ResponsesInputItem } from "../request-schema.js";
import { type ResponsesRequest, ResponsesRequestSchema } from "../request-schema.js";
import { RESPONSES_CAPABILITY_EVIDENCE, responsesCapability } from "./capabilities.js";
import type { NativeResponseOwner, ResponseContinuationContext } from "./continuation.js";
import { ResponseContextError } from "./continuation.js";
import type { NativeResponsesAdaptation } from "./native-adaptation.js";
import { nativeInputItems, nativeReplayHistory } from "./native-replay.js";
import { createNativeStream, NativeStreamError } from "./native-stream.js";
import { NativeToolValidation } from "./native-tool-validation.js";
import { type NormalizedResponsesRequest, normalizeResponsesRequest } from "./request-policy.js";
import type { ResponseStateObject } from "./state.js";
import type { StoredResponse } from "./store.js";
import { responseInputItems, responseStoreTenant } from "./store.js";

const NATIVE_RESPONSE_AFFINITY_TTL_MS = 30 * 24 * 60 * 60_000;
const NATIVE_RESPONSE_AFFINITY_MAX_ENTRIES = 100_000;

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
  readonly normalized?: NormalizedResponsesRequest;
  readonly adaptation?: NativeResponsesAdaptation;
  readonly onCompatibility?: (
    losses: readonly import("./request-policy.js").CompatibilityLoss[],
  ) => void;
  readonly request: Request;
  readonly config: Config;
  readonly dependencies: RouteDependencies;
  readonly signals: IngressSignals;
  readonly finalize: () => void;
}

export interface NativeResponsesProxyResult {
  readonly response: Response;
  readonly streamOwnsResources: boolean;
  readonly transport?: "native" | "native-adapted";
}

interface PreparedNativeRequest {
  readonly request: ResponsesRequest;
  readonly requestedModel: string;
  readonly wireModel: string;
  readonly requestedEffort?: string;
  readonly effectiveEffort?: string;
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

function prepareNativeRequest(
  rawBody: unknown,
  config: Config,
  normalized?: NormalizedResponsesRequest,
): PreparedNativeRequest | Response {
  const parsed = normalized ?? normalizeResponsesRequest(rawBody, config);
  if (parsed instanceof Response) return parsed;
  const request = parsed.request;
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
  if (
    request.parallel_tool_calls === false &&
    request.tool_choice !== "none" &&
    (request.tools?.length ?? 0) > 0
  ) {
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
  if ((request.reasoning?.effort ?? variant.effort) === "max") {
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
  const requestedEffort = parsed.requestedEffort;
  const effectiveEffort = parsed.effectiveEffort;
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
    if (variant.effort !== undefined && request.reasoning?.effort === undefined) {
      reasoning.effort = variant.effort;
    }
    if (Object.keys(reasoning).length > 0) body.reasoning = reasoning;
    else delete body.reasoning;
  }
  return {
    request,
    requestedModel: request.model,
    wireModel: variant.wireId,
    ...(typeof requestedEffort === "string" ? { requestedEffort } : {}),
    ...(effectiveEffort !== undefined ? { effectiveEffort } : {}),
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

function validateNativeToolChoice(item: unknown, prepared: PreparedNativeRequest): void {
  if (
    prepared.request.tool_choice === "none" &&
    isRecord(item) &&
    (item.type === "function_call" || item.type === "custom_tool_call")
  )
    throw new NativeStreamError(
      "upstream_tool_choice_violation",
      "Upstream called a tool despite tool_choice=none",
    );
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
  for (const item of value.output) validateNativeToolChoice(item, prepared);
  const normalized: Record<string, unknown> = { ...value };
  delete normalized.billing;
  normalized.model = prepared.requestedModel;
  normalized.store = prepared.request.store !== false;
  if (
    prepared.request.parallel_tool_calls === false &&
    (prepared.request.tool_choice === "none" || !prepared.request.tools?.length)
  )
    normalized.parallel_tool_calls = false;
  normalized.previous_response_id =
    prepared.request.previous_response_id ?? normalized.previous_response_id ?? null;
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

function upstreamErrorRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return isRecord(value.error) ? value.error : isRecord(value.Output) ? value.Output : value;
}

function upstreamError(
  upstream: Response,
  value: unknown,
  adaptation?: NativeResponsesAdaptation,
  fallbackRetryMs?: number,
): Response {
  const record = upstreamErrorRecord(value);
  let message =
    typeof record.message === "string"
      ? record.message
      : `Kiro upstream returned HTTP ${upstream.status}`;
  for (const binding of adaptation?.bridge?.bindings ?? []) {
    const name =
      binding.identity.kind === "namespace"
        ? `${binding.identity.namespace}.${binding.identity.name}`
        : binding.identity.name;
    message = message.replaceAll(binding.wireName, name);
  }
  const reason =
    typeof record.code === "string"
      ? record.code
      : typeof record.reason === "string"
        ? record.reason
        : "kiro_runtime_error";
  const response = openAiError(
    upstream.status >= 400 ? upstream.status : 502,
    message,
    upstream.status >= 500 ? "upstream_error" : "invalid_request_error",
    reason,
    typeof record.param === "string" ? record.param : undefined,
  );
  for (const name of ["retry-after", "x-request-id", "x-amzn-requestid"]) {
    const value = upstream.headers.get(name);
    if (value !== null) response.headers.set(name, value);
  }
  if (
    upstream.status === 429 &&
    !response.headers.has("retry-after") &&
    fallbackRetryMs !== undefined
  )
    response.headers.set("Retry-After", String(Math.ceil(fallbackRetryMs / 1000)));
  return response;
}

function upstreamReasonHash(value: unknown): string | undefined {
  value = upstreamErrorRecord(value);
  if (!isRecord(value)) return undefined;
  const reason =
    typeof value.reason === "string"
      ? value.reason
      : typeof value.message === "string"
        ? value.message
        : undefined;
  return reason === undefined ? undefined : auditHash(reason);
}

function recordAffinity(
  dependencies: RouteDependencies,
  tenantId: string,
  account: ManagedAccount,
  responseId: string,
): void {
  try {
    dependencies.affinityStore?.claimSessionAffinity(
      nativeAffinityKey(tenantId, responseId),
      account.id,
      responseId,
      Date.now(),
      NATIVE_RESPONSE_AFFINITY_TTL_MS,
      NATIVE_RESPONSE_AFFINITY_MAX_ENTRIES,
    );
  } catch {
    auditLog("warn", "native_response_affinity_cache_failed", {
      response_hash: auditHash(responseId),
    });
  }
}

function nativeContinuation(
  prepared: PreparedNativeRequest,
  account: ManagedAccount,
  response: ResponseStateObject,
  adaptation?: NativeResponsesAdaptation,
  nativeReplay?: ResponseContinuationContext["nativeReplay"],
  wireSnapshot?: ResponseContinuationContext["wireSnapshot"],
): ResponseContinuationContext {
  return {
    transport:
      adaptation || (nativeReplay && prepared.request.previous_response_id)
        ? "native-adapted"
        : "native",
    request: adaptation?.original ?? prepared.request,
    ...(adaptation?.instruction ? { instruction: adaptation.instruction } : {}),
    ...(nativeReplay ? { nativeReplay } : {}),
    ...(wireSnapshot ? { wireSnapshot } : {}),
    ...(adaptation?.bridge ? { tools: [...adaptation.bridge.bindings] } : {}),
    owner: {
      accountId: account.id,
      region: account.region,
      ...(account.profileArn ? { profileArn: account.profileArn } : {}),
      responseId: response.id,
    },
  };
}

export function nativeRetryDelay(upstream: Response, fallbackMs: number, now = Date.now()): number {
  return retryAfterMs(upstream.headers.get("retry-after"), now) ?? fallbackMs;
}

export async function proxyNativeResponses(
  options: NativeResponsesProxyOptions,
): Promise<NativeResponsesProxyResult> {
  const prepared = prepareNativeRequest(options.rawBody, options.config, options.normalized);
  if (prepared instanceof Response) {
    return { response: prepared, streamOwnsResources: false };
  }
  let validateToolArguments: ValidateToolArguments;
  try {
    const declarations = options.adaptation?.bridge?.declarations;
    validateToolArguments = toolOutputValidator(
      declarations
        ? declarations.map((tool) => ({
            name: tool.wireName,
            schema: tool.parameters,
            path: tool.path,
            publicType: tool.publicType,
          }))
        : (prepared.request.tools ?? []).flatMap((tool, index) =>
            tool.type === "function" && typeof tool.name === "string"
              ? [
                  {
                    name: tool.name,
                    schema: isRecord(tool.parameters) ? tool.parameters : {},
                    path: `tools[${index}].parameters`,
                  },
                ]
              : [],
          ),
      prepared.request.tool_choice !== "none",
    );
  } catch (error) {
    if (error instanceof RequestTransformError) {
      return {
        response: validationError(error.message, error.code, error.param),
        streamOwnsResources: false,
      };
    }
    throw error;
  }
  const tenantId = responseStoreTenant(options.dependencies.tenantId);
  const inputItems = options.adaptation
    ? responseInputItems(options.adaptation.original.input)
    : prepared.inputItems;
  let owner: NativeResponseOwner | undefined;
  let previousStored: StoredResponse | undefined;
  const reasoningOrigins: StoredResponse[] = [];
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
    previousStored = previous;
    owner = previous.continuation?.owner;
    if (!owner)
      return {
        response: openAiError(
          409,
          "Response account binding is unavailable",
          "invalid_request_error",
          "response_context_unavailable",
          "previous_response_id",
        ),
        streamOwnsResources: false,
      };
  }
  if (Array.isArray(prepared.request.input)) {
    for (const item of prepared.request.input) {
      if (
        item.type !== "reasoning" ||
        typeof item.encrypted_content !== "string" ||
        !item.encrypted_content.length
      )
        continue;
      const origins =
        options.dependencies.responseStore?.findNativeReasoning?.(
          tenantId,
          item.encrypted_content,
        ) ?? [];
      if (!origins.length)
        return {
          response: validationError(
            "Native reasoning has no recoverable owner in this tenant",
            "response_context_unavailable",
            "input",
          ),
          streamOwnsResources: false,
        };
      for (const origin of origins) {
        const binding = origin.continuation?.owner;
        if (
          !binding ||
          resolveModelVariant(origin.response.model).wireId !== prepared.wireModel ||
          (owner &&
            (owner.accountId !== binding.accountId ||
              owner.region !== binding.region ||
              owner.profileArn !== binding.profileArn))
        )
          return {
            response: validationError(
              "Native reasoning does not match the response account or model",
              "response_context_unavailable",
              "input",
            ),
            streamOwnsResources: false,
          };
        owner ??= binding;
        reasoningOrigins.push(origin);
      }
    }
  }
  if (
    owner &&
    options.adaptation?.eligibleAccounts &&
    !options.adaptation.eligibleAccounts.has(owner.accountId)
  )
    return {
      response: validationError(
        "Native adaptation is not verified for the reasoning owner",
        "unsupported_response_semantics",
        "input",
      ),
      streamOwnsResources: false,
    };
  const account = options.dependencies.accountManager.selectHealthyAccount(
    owner?.accountId,
    owner ? new Set([owner.accountId]) : options.adaptation?.eligibleAccounts,
  );
  if (!account || (owner && account.id !== owner.accountId)) {
    const bound =
      owner &&
      options.dependencies.accountManager
        .reconcileFromDb()
        .find((candidate) => candidate.id === owner.accountId);
    const delay = bound ? bound.rateLimitResetTime - Date.now() : 0;
    const response = openAiError(
      delay > 0 ? 429 : 503,
      owner ? "The response's Kiro account is unavailable" : "No healthy Kiro account is available",
      "service_unavailable",
      owner ? "response_account_unavailable" : "no_healthy_accounts",
    );
    if (delay > 0) response.headers.set("Retry-After", String(Math.ceil(delay / 1000)));
    return { response, streamOwnsResources: false };
  }
  let release = (): void => {};
  let releaseOwned = true;
  let attempt = 0;
  let continuationMode = prepared.request.previous_response_id ? "upstream" : "none";
  let replayInput: ResponsesInputItem[] | undefined;
  let rawOutput: ResponsesInputItem[] = [];
  const logTerminal = (
    level: "info" | "warn",
    provenance: string,
    fields: {
      readonly httpStatus?: number;
      readonly responseStatus?: string;
      readonly completionWitnessed?: boolean;
      readonly reasonHash?: string;
    } = {},
  ): void => {
    auditLog(level, "native_responses_terminal", {
      request_id: options.requestId,
      attempt,
      account_hash: auditHash(account.id),
      model: prepared.requestedModel,
      wire_model: prepared.wireModel,
      requested_effort: prepared.requestedEffort,
      effective_effort: prepared.effectiveEffort,
      stream: prepared.stream,
      continuation_mode: continuationMode,
      http_status: fields.httpStatus,
      terminal_provenance: provenance,
      response_status: fields.responseStatus,
      completion_witnessed: fields.completionWitnessed ?? false,
      reason_hash: fields.reasonHash,
    });
  };
  try {
    options.signals.diagnostics?.phase("account_queue");
    release = await acquireAccountQueue(account.id, options.signals.combined);
    options.signals.diagnostics?.phase("token_refresh");
    const initialAuth = options.dependencies.accountManager.toAuthDetails(account);
    let refreshed = await options.dependencies.tokenRefresher.refreshIfNeeded(
      account,
      initialAuth,
      options.signals.combined,
    );
    let auth = options.dependencies.accountManager.toAuthDetails(refreshed);
    options.signals.diagnostics?.phase("request_validation");
    if (
      owner &&
      (refreshed.id !== owner.accountId ||
        auth.region !== owner.region ||
        auth.profileArn !== owner.profileArn)
    ) {
      return {
        response: openAiError(
          409,
          "Response account identity has changed",
          "invalid_request_error",
          "response_context_unavailable",
          "previous_response_id",
        ),
        streamOwnsResources: false,
      };
    }
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
    const dispatchBody: Record<string, unknown> = { ...prepared.body };
    if (reasoningOrigins.length && Array.isArray(prepared.request.input)) {
      const originals = reasoningOrigins.flatMap(
        (origin) => origin.continuation?.wireSnapshot?.output ?? [],
      );
      dispatchBody.input = prepared.request.input.map((item) => {
        if (item.type !== "function_call") return item;
        const raw = originals.find(
          (candidate) => candidate.type === "function_call" && candidate.call_id === item.call_id,
        );
        if (!raw) return item;
        if (
          raw.name !== item.name ||
          typeof raw.arguments !== "string" ||
          typeof item.arguments !== "string" ||
          canonicalFingerprint(JSON.parse(raw.arguments)) !==
            canonicalFingerprint(JSON.parse(item.arguments))
        )
          throw new ResponseContextError("Native reasoning tool output was changed before replay");
        return { ...item, arguments: raw.arguments };
      });
    }
    const priority = RESPONSES_CAPABILITY_EVIDENCE.find(
      (cell) =>
        cell.feature === "instruction_priority" &&
        cell.model === prepared.wireModel &&
        cell.region === auth.region,
    );
    if (prepared.request.instructions?.length && priority?.status === "unverified") {
      const loss = { code: "native_instruction_priority_unverified", param: "instructions" };
      options.onCompatibility?.([loss]);
      if (options.config.responses_fidelity_mode === "strict") {
        return {
          response: openAiError(
            400,
            "Instruction priority is not verified for this native model and region",
            "invalid_request_error",
            "unsupported_response_semantics",
            loss.param,
          ),
          streamOwnsResources: false,
        };
      }
    }
    const opaqueHistoryRequiresReplay =
      responsesCapability("native_previous_with_reasoning", prepared.wireModel, auth.region) ===
      "unsupported";
    const hasOpaqueReasoning = (items: readonly unknown[]): boolean =>
      items.some(
        (item) =>
          isRecord(item) &&
          item.type === "reasoning" &&
          typeof item.encrypted_content === "string" &&
          item.encrypted_content.length > 0,
      );
    if (
      responsesCapability("native_previous_response", prepared.wireModel, auth.region) ===
        "unsupported" ||
      previousStored?.continuation?.nativeReplay !== undefined ||
      (opaqueHistoryRequiresReplay &&
        previousStored !== undefined &&
        hasOpaqueReasoning(previousStored.response.output))
    ) {
      replayInput = nativeInputItems(prepared.request.input);
      if (previousStored) {
        replayInput = [
          ...nativeReplayHistory(previousStored, options.dependencies.responseStore, tenantId),
          ...replayInput,
        ];
        if (
          !ResponsesRequestSchema.safeParse({ ...prepared.request, input: replayInput }).success
        ) {
          throw new ResponseContextError("Stored native output is not a complete replayable input");
        }
        dispatchBody.input = replayInput;
        delete dispatchBody.previous_response_id;
        continuationMode = "local_replay";
      }
    }
    const storedContinuation = (state: ResponseStateObject): ResponseContinuationContext => {
      let snapshotInput = replayInput;
      if (
        !snapshotInput &&
        opaqueHistoryRequiresReplay &&
        (hasOpaqueReasoning(rawOutput) ||
          (Array.isArray(prepared.request.input) && hasOpaqueReasoning(prepared.request.input)))
      ) {
        snapshotInput = [
          ...(previousStored
            ? nativeReplayHistory(previousStored, options.dependencies.responseStore, tenantId)
            : []),
          ...nativeInputItems(dispatchBody.input as ResponsesRequest["input"]),
        ];
      }
      return nativeContinuation(
        prepared,
        refreshed,
        state,
        options.adaptation,
        snapshotInput ? { input: snapshotInput, output: rawOutput } : undefined,
        options.adaptation
          ? {
              input: nativeInputItems(dispatchBody.input as ResponsesRequest["input"]),
              output: rawOutput,
            }
          : undefined,
      );
    };
    const fetcher = options.dependencies.nativeResponsesFetch ?? fetch;
    const errorBodies = new WeakMap<Response, unknown>();
    let nativeAbort = new AbortController();
    const dispatch = (): Promise<Response> => {
      nativeAbort = new AbortController();
      const endpoint =
        options.config.test_upstream_endpoint ??
        KIRO_CONSTANTS.RUNTIME_ENDPOINT.replace("{{region}}", auth.region);
      attempt += 1;
      options.signals.diagnostics?.addSecrets([
        refreshed.id,
        refreshed.email,
        auth.access,
        auth.refresh,
        auth.clientSecret,
        auth.profileArn,
      ]);
      options.signals.diagnostics?.dispatch(attempt);
      auditLog("info", "native_responses_dispatch_started", {
        request_id: options.requestId,
        attempt,
        account_hash: auditHash(refreshed.id),
        model: prepared.requestedModel,
        wire_model: prepared.wireModel,
        requested_effort: prepared.requestedEffort,
        effective_effort: prepared.effectiveEffort,
        stream: prepared.stream,
        previous_response_present: prepared.request.previous_response_id !== undefined,
      });
      return fetcher(`${endpoint}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.access}`,
          "Content-Type": "application/json",
          "User-Agent": "KiroCLI/2.21.1 KAS/0.58.7 kiro-provider/3",
          "x-amzn-kiro-origin": KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
          ...(auth.profileArn ? { "x-amzn-kiro-profile": auth.profileArn } : {}),
        },
        body: JSON.stringify(dispatchBody),
        signal: AbortSignal.any([options.signals.combined, nativeAbort.signal]),
        ...(resolveProxyUrl(options.config) ? { proxy: resolveProxyUrl(options.config) } : {}),
      });
    };
    // HTTP and network failures share the existing retry budget across all
    // pre-publication stream attempts. Authentication refresh is allowed once.
    let transportRetries = 0;
    let authenticationRefreshed = false;
    const requestUpstream = async (): Promise<Response> => {
      while (true) {
        options.signals.combined.throwIfAborted();
        let result: Response;
        try {
          result = await abortable(dispatch(), options.signals.combined);
        } catch (error) {
          nativeAbort.abort();
          if (!options.signals.combined.aborted)
            options.signals.diagnostics?.failure(error, "upstream_headers");
          if (
            options.signals.combined.aborted ||
            transportRetries >= options.config.rate_limit_max_retries
          )
            throw error;
          transportRetries += 1;
          options.signals.diagnostics?.phase("retry_backoff");
          await abortableSleep(options.config.rate_limit_retry_delay_ms, options.signals.combined);
          continue;
        }
        options.signals.diagnostics?.headers(result.status, Object.fromEntries(result.headers));
        let errorRecord: Record<string, unknown> = {};
        if (!result.ok) {
          const metadata = {
            status: result.status,
            requestId:
              result.headers.get("x-amzn-requestid") ??
              result.headers.get("x-request-id") ??
              undefined,
          };
          options.signals.diagnostics?.failure(
            {
              ...metadata,
              message: `Kiro upstream returned HTTP ${result.status}`,
            },
            "upstream_headers",
          );
          const value = await readUpstreamErrorBody(result, options.signals.combined);
          errorBodies.set(result, value);
          errorRecord = upstreamErrorRecord(value);
          options.signals.diagnostics?.failure(
            {
              ...errorRecord,
              ...metadata,
              message:
                typeof errorRecord.message === "string"
                  ? errorRecord.message
                  : `Kiro upstream returned HTTP ${result.status}`,
            },
            "upstream_headers",
          );
        }
        if (
          (result.status === 401 ||
            (result.status === 403 &&
              typeof errorRecord.message === "string" &&
              isAccessTokenError(errorRecord.message))) &&
          !authenticationRefreshed
        ) {
          authenticationRefreshed = true;
          await boundedCleanup(() => result.body?.cancel());
          options.signals.diagnostics?.phase("token_refresh");
          refreshed = await options.dependencies.tokenRefresher.forceRefresh(
            refreshed,
            options.signals.combined,
          );
          auth = options.dependencies.accountManager.toAuthDetails(refreshed);
          if (
            owner &&
            (refreshed.id !== owner.accountId ||
              auth.region !== owner.region ||
              auth.profileArn !== owner.profileArn)
          )
            throw new ResponseContextError(
              "Response account identity changed during authentication refresh",
            );
          continue;
        }
        const delay = nativeRetryDelay(result, options.config.rate_limit_retry_delay_ms);
        if (result.status === 429)
          options.dependencies.accountManager.markRateLimited(refreshed, Date.now() + delay);
        if (
          (result.status === 429 || result.status >= 500) &&
          transportRetries < options.config.rate_limit_max_retries &&
          delay < (options.signals.deadlineAt ?? Number.POSITIVE_INFINITY) - Date.now()
        ) {
          transportRetries += 1;
          options.signals.diagnostics?.phase("retry_backoff");
          await boundedCleanup(() => result.body?.cancel());
          await abortableSleep(delay, options.signals.combined);
          continue;
        }
        return result;
      }
    };
    let upstream = await requestUpstream();
    let streamAttempt = 0;
    const openStream = async (): Promise<Response> => {
      streamAttempt += 1;
      if (
        !(upstream.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")
      ) {
        await boundedCleanup(() => upstream.body?.cancel());
        throw new NativeStreamError(
          "invalid_upstream_response",
          "Kiro did not return an SSE response",
        );
      }
      let terminalLogged = false;
      options.signals.diagnostics?.accepted();
      return createNativeStream({
        upstream,
        headers: responseHeaders(upstream, "text/event-stream; charset=utf-8"),
        model: prepared.requestedModel,
        signals: options.signals,
        idleTimeoutMs: options.config.stream_idle_timeout_ms,
        maxToolArgumentsBytes: options.config.max_request_body_bytes,
        validateToolArguments,
        normalize: (event) => {
          validateNativeToolChoice(event.item, prepared);
          let response = normalizeResponseObject(event.response, prepared);
          if (response?.error && options.signals.diagnostics) {
            options.signals.diagnostics.failure(response.error, "upstream_stream");
            response = {
              ...response,
              error: options.signals.diagnostics.streamError(
                response.error.code,
                response.error.message,
              ),
            };
          }
          if (
            response &&
            [
              "response.completed",
              "response.failed",
              "response.incomplete",
              "response.cancelled",
            ].includes(String(event.type))
          ) {
            rawOutput = response.output as ResponsesInputItem[];
          }
          const normalized = { ...event, ...(response ? { response } : {}) };
          return options.adaptation?.event(normalized) ?? [normalized];
        },
        renumber: options.adaptation !== undefined,
        commit: (state) => {
          options.dependencies.responseStore?.putNative(
            tenantId,
            state,
            inputItems,
            storedContinuation(state),
          );
          recordAffinity(options.dependencies, tenantId, refreshed, state.id);
        },
        terminal: (provenance, eventType, state) => {
          if (terminalLogged) return;
          terminalLogged = true;
          auditLog(state?.status === "completed" ? "info" : "warn", "native_responses_terminal", {
            request_id: options.requestId,
            attempt,
            model: prepared.requestedModel,
            wire_model: prepared.wireModel,
            account_hash: auditHash(refreshed.id),
            stream: true,
            requested_effort: prepared.requestedEffort,
            effective_effort: prepared.effectiveEffort,
            http_status: upstream.status,
            terminal_provenance: provenance,
            terminal_event: eventType,
            response_status: state?.status,
            completion_witnessed: state?.status === "completed",
          });
        },
        abortUpstream: () => nativeAbort.abort(),
        finish: () => {
          release();
          options.finalize();
        },
      });
    };
    while (true) {
      if (!upstream.ok) {
        const value = errorBodies.get(upstream);
        logTerminal("warn", "upstream_error", {
          httpStatus: upstream.status,
          reasonHash: upstreamReasonHash(value),
        });
        return {
          response: upstreamError(
            upstream,
            value,
            options.adaptation,
            options.config.rate_limit_retry_delay_ms,
          ),
          streamOwnsResources: false,
        };
      }
      if (!prepared.stream) break;
      try {
        const response = await openStream();
        releaseOwned = false;
        return {
          response,
          streamOwnsResources: true,
          transport:
            options.adaptation || continuationMode === "local_replay" ? "native-adapted" : "native",
        };
      } catch (error) {
        if (
          options.signals.combined.aborted ||
          streamAttempt >= options.config.stream_max_attempts ||
          !(error instanceof NativeStreamError) ||
          ![
            "upstream_stream_incomplete",
            "upstream_stream_idle_timeout",
            "upstream_stream_error",
          ].includes(error.code)
        )
          throw error;
        auditLog("warn", "native_responses_stream_retry", {
          request_id: options.requestId,
          attempt,
          stream_attempt: streamAttempt,
          reason: error.code,
        });
        await abortableSleep(options.config.rate_limit_retry_delay_ms, options.signals.combined);
        upstream = await requestUpstream();
      }
    }
    const value = await upstream.json().catch(() => undefined);
    const rawNormalized = normalizeResponseObject(value, prepared);
    if (rawNormalized?.status === "completed") {
      new NativeToolValidation(
        options.config.max_request_body_bytes,
        validateToolArguments,
      ).complete(rawNormalized.output);
    }
    if (rawNormalized) rawOutput = rawNormalized.output as ResponsesInputItem[];
    const normalized = rawNormalized
      ? (options.adaptation?.restoreResponse(rawNormalized) ?? rawNormalized)
      : undefined;
    if (!normalized) {
      logTerminal("warn", "invalid_upstream_response", {
        httpStatus: upstream.status,
      });
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
    try {
      options.dependencies.responseStore?.putNative(
        tenantId,
        normalized,
        inputItems,
        storedContinuation(normalized),
      );
    } catch {
      throw new NativeStreamError(
        "response_state_store_failed",
        "Response continuation could not be stored",
      );
    }
    const completed = normalized.status === "completed";
    logTerminal(completed ? "info" : "warn", "non_stream_response", {
      httpStatus: upstream.status,
      responseStatus: normalized.status,
      completionWitnessed: completed,
    });
    return {
      transport:
        options.adaptation || continuationMode === "local_replay" ? "native-adapted" : "native",
      response: Response.json(normalized, {
        headers: responseHeaders(upstream, "application/json; charset=utf-8"),
      }),
      streamOwnsResources: false,
    };
  } catch (error) {
    if (options.signals.deadline.aborted) {
      logTerminal("warn", "deadline", {
        reasonHash: auditHash(
          options.signals.deadline.reason instanceof Error
            ? options.signals.deadline.reason.message
            : "deadline",
        ),
      });
      return {
        response: openAiError(504, "Request deadline exceeded", "timeout_error", "request_timeout"),
        streamOwnsResources: false,
      };
    }
    if (options.signals.client.aborted) {
      logTerminal("info", "client_abort");
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
    if (error instanceof ResponseContextError) {
      return {
        response: openAiError(
          409,
          error.message,
          "invalid_request_error",
          error.code,
          prepared.request.previous_response_id ? "previous_response_id" : "input",
        ),
        streamOwnsResources: false,
      };
    }
    if (error instanceof NativeStreamError || error instanceof SdkStreamProtocolError) {
      options.signals.diagnostics?.failure(error, "upstream_stream");
      logTerminal("warn", error.code);
      return {
        response: openAiError(502, error.message, "upstream_error", error.code),
        streamOwnsResources: false,
      };
    }
    auditLog("error", "native_responses_dispatch_failed", {
      request_id: options.requestId,
      error_type: options.signals.diagnostics?.identifier(
        error instanceof Error ? error.name : typeof error,
      ),
      error_hash: auditHash(error instanceof Error ? error.message : String(error)),
    });
    logTerminal("warn", "transport_error", {
      reasonHash: auditHash(error instanceof Error ? error.message : String(error)),
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
