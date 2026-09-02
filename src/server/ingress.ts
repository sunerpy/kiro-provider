import type { Config } from "../config/schema.js";
import { auditHash, auditLog } from "../core/audit-log.js";
import type {
  PipelineAccountManager,
  PipelineAffinityStore,
  PipelineClientFactory,
  PipelineModelCapabilities,
  PipelineQuotaRechecker,
  PipelineReasoningReplayStore,
  PipelineTokenRefresher,
  RunChatCompletionOptions,
} from "../core/pipeline.js";
import { boundedCleanup, runCleanupSteps } from "../core/stream-cleanup.js";
import type { CanonicalRequest } from "../protocol/canonical.js";
import { anthropicError } from "./anthropic/errors.js";
import {
  anthropicInternalError,
  newRequestId,
  openAiError,
  openAiInternalError,
} from "./errors.js";
import type { IngressSignals, RequestIdleTimeoutLease } from "./request-lifecycle.js";

/**
 * Dependencies shared by every request route. The HTTP entry point assembles
 * this once per request from `AppDependencies` plus the authenticated tenant.
 */
export type RouteDependencies = {
  readonly accountManager: PipelineAccountManager;
  readonly tokenRefresher: PipelineTokenRefresher;
  readonly quotaRechecker?: PipelineQuotaRechecker;
  readonly tenantId?: string;
  readonly affinityStore?: PipelineAffinityStore;
  readonly reasoningReplayStore?: PipelineReasoningReplayStore;
  readonly modelCapabilities?: PipelineModelCapabilities;
  readonly makeClient?: PipelineClientFactory;
  readonly createRequestIdleTimeoutLease?: () => RequestIdleTimeoutLease | undefined;
  readonly runPipeline?: (options: RunChatCompletionOptions) => Promise<Response>;
};

/**
 * Protocol-specific envelopes for failures that happen before a route can
 * interpret the request. Each route supplies the envelope of its public API so
 * the ingress logic is written once.
 */
export interface IngressErrorEnvelope {
  bodyTooLarge(limit: number): Response;
  deadlineExceeded(): Response;
  clientClosed(): Response;
  malformedBody(): Response;
  invalidJson(): Response;
  internal(requestId: string): Response;
}

function bodyTooLargeMessage(limit: number): string {
  return `Request body exceeds the ${limit} byte limit`;
}

const MALFORMED_BODY_MESSAGE = "Request body could not be decoded";

export const openAiIngressErrors: IngressErrorEnvelope = {
  bodyTooLarge: (limit) =>
    openAiError(413, bodyTooLargeMessage(limit), "invalid_request_error", "request_too_large"),
  deadlineExceeded: () =>
    openAiError(504, "Request deadline exceeded", "timeout_error", "request_timeout"),
  clientClosed: () =>
    openAiError(499, "Client closed request", "request_aborted", "client_disconnected"),
  malformedBody: () =>
    openAiError(400, MALFORMED_BODY_MESSAGE, "invalid_request_error", "malformed_request_body"),
  invalidJson: () =>
    openAiError(
      400,
      "Request body must contain valid JSON",
      "invalid_request_error",
      "invalid_json",
    ),
  internal: (requestId) => openAiInternalError(requestId),
};

export const anthropicIngressErrors: IngressErrorEnvelope = {
  bodyTooLarge: (limit) => anthropicError(413, bodyTooLargeMessage(limit), "request_too_large"),
  deadlineExceeded: () => anthropicError(504, "Request deadline exceeded", "api_error"),
  clientClosed: () => anthropicError(499, "Client closed request", "api_error"),
  malformedBody: () => anthropicError(400, MALFORMED_BODY_MESSAGE, "invalid_request_error"),
  invalidJson: () =>
    anthropicError(400, "Request body must contain valid JSON", "invalid_request_error"),
  internal: (requestId) => anthropicInternalError(requestId),
};

export interface Ingress {
  readonly signals: IngressSignals;
  /**
   * Creates the per-request idle-timeout lease (once) and disables Bun's idle
   * timeout for the upstream phase. Routes call this only after the body has
   * been read and validated so slow uploads stay bounded by Bun's timeout.
   */
  disableIdleTimeout(): void;
  /** Clears the deadline timer and restores the idle-timeout lease. */
  finalize(): void;
}

export function createIngress(
  request: Request,
  config: Pick<Config, "request_timeout_ms">,
  createLease?: () => RequestIdleTimeoutLease | undefined,
): Ingress {
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(new DOMException("Request deadline exceeded", "TimeoutError")),
    config.request_timeout_ms,
  );
  let lease: RequestIdleTimeoutLease | undefined;
  let leaseRequested = false;
  return {
    signals: {
      combined: AbortSignal.any([deadlineController.signal, request.signal]),
      deadline: deadlineController.signal,
      client: request.signal,
    },
    disableIdleTimeout(): void {
      if (leaseRequested) return;
      leaseRequested = true;
      lease = createLease?.();
      lease?.disable();
    },
    finalize(): void {
      runCleanupSteps(
        () => clearTimeout(deadlineTimer),
        () => lease?.restore(),
      );
    },
  };
}

export class RequestBodyTooLargeError extends Error {
  readonly name = "RequestBodyTooLargeError";

  constructor(readonly limit: number) {
    super(bodyTooLargeMessage(limit));
  }
}

export type BodyReadFailureClass = "client-closed" | "malformed" | "internal";

const CLIENT_CLOSED_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
]);

const MALFORMED_TRANSFER_PATTERN =
  /chunk|transfer|encod|decod|truncat|malformed|invalid|unexpected end/i;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * Classifies a request-body read failure that was not already explained by the
 * ingress signals.
 *
 * Probed on Bun 1.3: a client that disconnects mid-body (truncated
 * Content-Length, malformed or truncated chunked transfer) surfaces as a
 * `DOMException` named `AbortError` ("The connection was closed.") with
 * `request.signal` aborted, so it belongs to the 499 path. Decoder-level
 * errors that keep the connection alive are client faults (400). Anything
 * else is a provider-side failure and must not leak its prose.
 */
export function classifyBodyReadFailure(error: unknown): BodyReadFailureClass {
  if (error instanceof DOMException && error.name === "AbortError") return "client-closed";
  const code = errorCode(error);
  if (code !== undefined && CLIENT_CLOSED_ERROR_CODES.has(code)) return "client-closed";
  if (error instanceof SyntaxError) return "malformed";
  if (
    (error instanceof TypeError || error instanceof RangeError) &&
    MALFORMED_TRANSFER_PATTERN.test(error.message)
  ) {
    return "malformed";
  }
  return "internal";
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Request deadline exceeded", "TimeoutError");
}

type BodyReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly response: Response };

export type JsonBodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly response: Response };

async function readRequestBody(
  request: Request,
  limit: number,
  signals: IngressSignals,
  errors: IngressErrorEnvelope,
): Promise<BodyReadResult> {
  const reader = request.body?.getReader();
  if (!reader) return { ok: true, text: "" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectAbort: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    const reason = abortReason(signals.combined);
    rejectAbort?.(reason);
    void boundedCleanup(() => reader.cancel(reason));
  };
  signals.combined.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (signals.combined.aborted) throw abortReason(signals.combined);
      const next = await Promise.race([reader.read(), aborted]);
      if (signals.combined.aborted) throw abortReason(signals.combined);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new RequestBodyTooLargeError(limit);
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, text: new TextDecoder().decode(bytes) };
  } catch (error) {
    // A reader whose stream already errored rejects `cancel()`; bound it so the
    // rejection can never escape as an unhandled promise.
    void boundedCleanup(() => reader.cancel(error));
    if (error instanceof RequestBodyTooLargeError) {
      return { ok: false, response: errors.bodyTooLarge(error.limit) };
    }
    if (signals.deadline.aborted) {
      return { ok: false, response: errors.deadlineExceeded() };
    }
    const failure = classifyBodyReadFailure(error);
    if (signals.client.aborted || failure === "client-closed") {
      return { ok: false, response: errors.clientClosed() };
    }
    if (failure === "malformed") {
      return { ok: false, response: errors.malformedBody() };
    }
    const requestId = newRequestId();
    auditLog("error", "request_body_read_failed", {
      request_id: requestId,
      error_type: error instanceof Error ? error.name : typeof error,
      detail_hash: auditHash(error instanceof Error ? error.message : String(error)),
      bytes_read: size,
    });
    return { ok: false, response: errors.internal(requestId) };
  } finally {
    signals.combined.removeEventListener("abort", onAbort);
  }
}

/**
 * Reads and JSON-decodes the request body under the ingress signals and the
 * configured size limit. Every failure is already converted into the route's
 * protocol envelope; nothing about the body read escapes as an exception.
 */
export async function readJsonBody(
  request: Request,
  config: Pick<Config, "max_request_body_bytes">,
  signals: IngressSignals,
  errors: IngressErrorEnvelope,
): Promise<JsonBodyResult> {
  const body = await readRequestBody(request, config.max_request_body_bytes, signals, errors);
  if (!body.ok) return body;
  try {
    return { ok: true, value: JSON.parse(body.text) };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, response: errors.invalidJson() };
  }
}

export interface PipelineOptionsInput {
  readonly body: CanonicalRequest;
  readonly model: string;
  readonly stream: boolean;
  readonly config: Config;
  readonly dependencies: RouteDependencies;
  readonly affinity?: RunChatCompletionOptions["affinity"];
  readonly lineage?: RunChatCompletionOptions["lineage"];
  readonly deadlineSignal: AbortSignal;
}

/** Builds the `runChatCompletion` options every route hands to the pipeline. */
export function buildPipelineOptions(input: PipelineOptionsInput): RunChatCompletionOptions {
  const { dependencies } = input;
  return {
    body: input.body,
    model: input.model,
    stream: input.stream,
    config: input.config,
    accountManager: dependencies.accountManager,
    tokenRefresher: dependencies.tokenRefresher,
    ...(dependencies.quotaRechecker ? { quotaRechecker: dependencies.quotaRechecker } : {}),
    ...(input.affinity ? { affinity: input.affinity } : {}),
    ...(input.lineage ? { lineage: input.lineage } : {}),
    ...(dependencies.affinityStore ? { affinityStore: dependencies.affinityStore } : {}),
    tenantId: dependencies.tenantId,
    ...(dependencies.reasoningReplayStore
      ? { reasoningReplayStore: dependencies.reasoningReplayStore }
      : {}),
    ...(dependencies.modelCapabilities
      ? { modelCapabilities: dependencies.modelCapabilities }
      : {}),
    deadlineSignal: input.deadlineSignal,
    ...(dependencies.makeClient ? { makeClient: dependencies.makeClient } : {}),
  };
}

function retryAfterHintMs(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || !("error" in value)) return undefined;
  const error = value.error;
  if (typeof error !== "object" || error === null) return undefined;
  if ("retry_after_ms" in error && typeof error.retry_after_ms === "number") {
    return error.retry_after_ms >= 0 ? error.retry_after_ms : undefined;
  }
  if ("retry_after" in error && typeof error.retry_after === "number") {
    return error.retry_after >= 0 ? error.retry_after * 1_000 : undefined;
  }
  return undefined;
}

export function retryAfterHeaderValue(delayMs: number): string {
  return String(Math.max(1, Math.ceil(delayMs / 1_000)));
}

/**
 * Adds `Retry-After` to a 429 pipeline response when the delay is known: an
 * existing header passes through untouched, otherwise an `error.retry_after_ms`
 * (or `error.retry_after` seconds) hint in the JSON envelope is promoted to
 * the header. Other statuses and hint-less responses are returned unchanged.
 */
export async function withRetryAfter(response: Response): Promise<Response> {
  if (response.status !== 429 || response.headers.has("Retry-After")) return response;
  let delayMs: number | undefined;
  try {
    delayMs = retryAfterHintMs(await response.clone().json());
  } catch {
    return response;
  }
  if (delayMs === undefined) return response;
  const headers = new Headers(response.headers);
  headers.set("Retry-After", retryAfterHeaderValue(delayMs));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
