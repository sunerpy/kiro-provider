import { auditHash, auditLog } from "./audit-log.js";
import { normalizeSdkError } from "./error-classifier.js";
import { retryAfterMs } from "./retry-after.js";
import { boundedCleanup } from "./stream-cleanup.js";

export type RequestPhase =
  | "request_validation"
  | "account_queue"
  | "session_queue"
  | "token_refresh"
  | "upstream_headers"
  | "upstream_stream"
  | "retry_backoff"
  | "projection"
  | "unknown";

export type CancelSource =
  | "client_disconnect"
  | "consumer_cancel"
  | "request_deadline"
  | "external_abort";

export interface FailureEvidence {
  readonly phase: RequestPhase;
  readonly failure_code: string | null;
  readonly upstream_status: number | null;
  readonly upstream_code: string | null;
  readonly upstream_request_id: string | null;
  readonly upstream_retry_after_ms: number | null;
  readonly message: string;
  readonly attempt: number;
  readonly attempt_id: string | null;
  readonly elapsed_ms: number;
}

export interface FailureDiagnostics {
  readonly phase: RequestPhase;
  readonly response_committed: boolean;
  readonly completion_witnessed: boolean;
  readonly attempt: number;
  readonly attempt_id: string | null;
  readonly elapsed_ms: number;
  readonly cancel_source: CancelSource | null;
  readonly first_failure: FailureEvidence | null;
  readonly last_failure: FailureEvidence | null;
}

const MAX_DIAGNOSTIC_TEXT = 1_024;

/** Per-request evidence only. It neither selects accounts nor authorizes retries. */
export class RequestDiagnostics {
  readonly started = performance.now();
  readonly #secrets = new Set<string>();
  readonly #payloadText = new Set<string>();
  #phase: RequestPhase = "request_validation";
  #attempt = 0;
  #published = false;
  #witnessed = false;
  #cancel: CancelSource | undefined;
  #firstFailure: FailureEvidence | undefined;
  #lastFailure: FailureEvidence | undefined;
  #upstreamRequestId: string | undefined;
  #upstreamRetryAfterMs: number | undefined;
  #cleanupRecorded = false;
  #bodyClosed = false;
  #rawFrames = 0;
  #projectedFrames = 0;
  #outputBytes = 0;
  #firstRawAt: number | undefined;
  #lastRawAt: number | undefined;
  #firstProjectedAt: number | undefined;

  constructor(
    readonly requestId: string,
    secrets: readonly string[] = [],
  ) {
    this.addSecrets(secrets);
    auditLog("info", "request_received", { request_id: requestId });
  }

  addSecrets(values: readonly (string | undefined)[]): void {
    for (const value of values) if (value) this.#secrets.add(value);
  }

  hidePayload(value: unknown): void {
    const visit = (current: unknown, sensitive: boolean): void => {
      if (typeof current === "string") {
        if (sensitive && current.length >= 4) this.#payloadText.add(current);
      } else if (Array.isArray(current)) {
        for (const item of current) visit(item, sensitive);
      } else if (current && typeof current === "object") {
        for (const [key, item] of Object.entries(current)) {
          visit(
            item,
            [
              "content",
              "text",
              "input",
              "arguments",
              "signature",
              "encrypted_content",
              "encryptedContent",
              "redactedContent",
              "prompt",
              "image_url",
              "file_data",
            ].includes(key) ||
              (sensitive && !["role", "type", "model", "name"].includes(key)),
          );
        }
      }
    };
    visit(value, false);
  }

  sanitize(value: string): string {
    let text = value;
    for (const secret of this.#secrets) text = text.replaceAll(secret, "[redacted]");
    for (const payload of this.#payloadText) text = text.replaceAll(payload, "[redacted payload]");
    // Scan once rather than backtracking across every opening brace. Partial
    // JSON is also payload: mask the remainder when no closing brace exists.
    const firstBrace = text.indexOf("{");
    if (firstBrace >= 0) {
      const lastBrace = text.lastIndexOf("}");
      text = `${text.slice(0, firstBrace)}[redacted payload]${lastBrace >= firstBrace ? text.slice(lastBrace + 1) : ""}`;
    }
    text = text
      .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted URL]")
      .replace(/\barn:[^\s"'<>]+/gi, "[redacted ARN]")
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted email]")
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[redacted authorization]")
      .replace(
        /((?:authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|token)\s*["']?\s*[:=]\s*["']?)[^"'\s,;]+/gi,
        "$1[redacted]",
      );
    return Array.from(text)
      .filter((character) => {
        const code = character.charCodeAt(0);
        return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
      })
      .join("")
      .slice(0, MAX_DIAGNOSTIC_TEXT);
  }

  identifier(value: string | undefined): string | undefined {
    if (!value || !/^[A-Za-z0-9][A-Za-z0-9_.:/=-]{0,199}$/.test(value)) return undefined;
    return [...this.#secrets].some((secret) => value.includes(secret)) ? undefined : value;
  }

  phase(value: RequestPhase): void {
    this.#phase = value;
  }

  dispatch(attempt: number): void {
    this.#attempt = attempt;
    this.#phase = "upstream_headers";
    this.#upstreamRequestId = undefined;
    this.#upstreamRetryAfterMs = undefined;
    auditLog("info", "upstream_attempt_started", {
      request_id: this.requestId,
      attempt,
      attempt_id: this.attemptId(),
      elapsed_ms: this.elapsed(),
    });
  }

  headers(status: number, headers: Readonly<Record<string, string>>): void {
    const requestId = Object.entries(headers).find(([name]) =>
      ["x-amzn-requestid", "x-amzn-request-id", "x-request-id"].includes(name.toLowerCase()),
    )?.[1];
    this.#upstreamRequestId = this.identifier(requestId);
    this.#upstreamRetryAfterMs = retryAfterMs(
      Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1],
    );
    auditLog("info", "upstream_headers_received", {
      request_id: this.requestId,
      attempt_id: this.attemptId(),
      upstream_status: status,
      upstream_request_id: this.#upstreamRequestId,
      elapsed_ms: this.elapsed(),
    });
  }

  accepted(): void {
    this.#phase = "upstream_stream";
    auditLog("info", "upstream_request_accepted", {
      request_id: this.requestId,
      attempt_id: this.attemptId(),
      upstream_request_id: this.#upstreamRequestId,
      elapsed_ms: this.elapsed(),
    });
  }

  published(): void {
    if (this.#published) return;
    this.#published = true;
    auditLog("info", "downstream_response_committed", {
      request_id: this.requestId,
      attempt_id: this.attemptId(),
      elapsed_ms: this.elapsed(),
    });
  }

  rawFrame(): void {
    this.#rawFrames += 1;
    this.#lastRawAt = this.elapsed();
    this.#firstRawAt ??= this.#lastRawAt;
  }

  projectedFrame(): void {
    this.#projectedFrames += 1;
    this.#firstProjectedAt ??= this.elapsed();
  }

  output(bytes: number): void {
    this.#outputBytes += bytes;
  }

  witness(): void {
    this.#witnessed = true;
  }

  cancel(source: CancelSource): void {
    this.#cancel ??= source;
  }

  failure(reason: unknown, phase = this.#phase): void {
    if (this.#cancel) return;
    const normalized = normalizeSdkError(reason);
    let source = reason;
    const seen = new Set<unknown>();
    for (
      let depth = 0;
      depth < 8 && source && typeof source === "object" && !seen.has(source);
      depth++
    ) {
      seen.add(source);
      const nested = Reflect.get(source, "cause") ?? Reflect.get(source, "error");
      if (!nested || typeof nested !== "object" || seen.has(nested)) break;
      source = nested;
    }
    const underlying = normalizeSdkError(source);
    const localOnly =
      source === reason &&
      reason instanceof Error &&
      [
        "NativeStreamError",
        "SdkStreamProtocolError",
        "ToolCallViolation",
        "StreamIdleTimeoutError",
        "SemanticStreamTruncationError",
        "MissingSdkOutputStreamError",
      ].includes(reason.name);
    const evidence: FailureEvidence = {
      phase,
      failure_code: this.identifier(normalized.code) ?? null,
      upstream_status: underlying.status ?? normalized.status ?? null,
      upstream_code:
        localOnly || ["Error", "TypeError"].includes(underlying.reason ?? underlying.code ?? "")
          ? null
          : (this.identifier(underlying.reason ?? underlying.code) ?? null),
      upstream_request_id:
        this.identifier(underlying.requestId ?? normalized.requestId) ??
        this.#upstreamRequestId ??
        null,
      upstream_retry_after_ms:
        retryAfterMs(
          Object.entries(normalized.headers ?? {}).find(
            ([name]) => name.toLowerCase() === "retry-after",
          )?.[1],
        ) ??
        this.#upstreamRetryAfterMs ??
        null,
      message: this.sanitize(
        underlying.message === "[object Object]" ? normalized.message : underlying.message,
      ),
      attempt: this.#attempt,
      attempt_id: this.attemptId() ?? null,
      elapsed_ms: this.elapsed(),
    };
    if (
      this.#firstFailure?.attempt === evidence.attempt &&
      this.#firstFailure.upstream_status === evidence.upstream_status &&
      this.#firstFailure.upstream_code === null
    ) {
      this.#firstFailure = { ...evidence, elapsed_ms: this.#firstFailure.elapsed_ms };
    }
    this.#firstFailure ??= evidence;
    this.#lastFailure = evidence;
    const { message: _message, ...fields } = evidence;
    auditLog("warn", "upstream_attempt_failed", {
      request_id: this.requestId,
      ...fields,
      message_hash: auditHash(evidence.message),
    });
  }

  snapshot(): FailureDiagnostics {
    return {
      phase: this.#phase,
      response_committed: this.#published,
      completion_witnessed: this.#witnessed,
      attempt: this.#attempt,
      attempt_id: this.attemptId() ?? null,
      elapsed_ms: this.elapsed(),
      cancel_source: this.#cancel ?? null,
      first_failure: this.#firstFailure ?? null,
      last_failure: this.#lastFailure ?? null,
    };
  }

  streamError(
    code: string,
    message: string,
  ): {
    readonly code: string;
    readonly message: string;
    readonly request_id: string;
    readonly details: FailureDiagnostics;
  } {
    return {
      code,
      message: this.terminalMessage(message),
      request_id: this.requestId,
      details: this.snapshot(),
    };
  }

  cleanup(): void {
    if (this.#cleanupRecorded) return;
    this.#cleanupRecorded = true;
    auditLog("info", "request_cleanup_complete", {
      request_id: this.requestId,
      attempt_id: this.attemptId(),
      elapsed_ms: this.elapsed(),
      response_committed: this.#published,
      completion_witnessed: this.#witnessed,
      cancel_source: this.#cancel,
      raw_frame_count: this.#rawFrames,
      projected_frame_count: this.#projectedFrames,
      downstream_bytes: this.#outputBytes,
      first_upstream_frame_ms: this.#firstRawAt,
      last_upstream_frame_ms: this.#lastRawAt,
      first_projected_frame_ms: this.#firstProjectedAt,
    });
  }

  async response(response: Response): Promise<Response> {
    const headers = new Headers(response.headers);
    const upstreamId = this.identifier(headers.get("x-request-id") ?? undefined);
    if (upstreamId && upstreamId !== this.requestId)
      headers.set("X-Kiro-Upstream-Request-Id", upstreamId);
    headers.set("X-Request-Id", this.requestId);
    if (response.ok) {
      return new Response(response.body, { status: response.status, headers });
    }
    const last = this.#lastFailure;
    if (
      !headers.has("Retry-After") &&
      last?.upstream_retry_after_ms !== null &&
      last?.upstream_retry_after_ms !== undefined &&
      [429, 503, 504].includes(response.status)
    ) {
      const remaining = Math.max(
        0,
        last.upstream_retry_after_ms - (this.elapsed() - last.elapsed_ms),
      );
      headers.set("Retry-After", String(Math.ceil(remaining / 1_000)));
    }
    const value: unknown = await response.json().catch(() => undefined);
    headers.delete("Content-Length");
    if (
      !value ||
      typeof value !== "object" ||
      !("error" in value) ||
      !value.error ||
      typeof value.error !== "object"
    ) {
      return Response.json(
        {
          error: {
            type: "upstream_error",
            message: "Request failed",
            request_id: this.requestId,
            details: this.snapshot(),
          },
        },
        { status: response.status, headers },
      );
    }
    const original = value.error as Record<string, unknown>;
    const error = {
      message:
        typeof original.message === "string"
          ? this.terminalMessage(original.message)
          : "Request failed",
      type: typeof original.type === "string" ? this.sanitize(original.type) : "upstream_error",
      ...(typeof original.code === "string" ? { code: this.sanitize(original.code) } : {}),
      ...(typeof original.param === "string" ? { param: this.sanitize(original.param) } : {}),
      ...(typeof original.retry_after_ms === "number" && Number.isFinite(original.retry_after_ms)
        ? { retry_after_ms: original.retry_after_ms }
        : {}),
      ...(typeof original.retry_after === "number" && Number.isFinite(original.retry_after)
        ? { retry_after: original.retry_after }
        : {}),
      request_id: this.requestId,
      details: this.snapshot(),
    };
    return Response.json(
      {
        ...("type" in value && value.type === "error"
          ? { type: "error", request_id: this.requestId }
          : {}),
        error,
      },
      { status: response.status, headers },
    );
  }

  async publicResponse(response: Response): Promise<Response> {
    const annotated = await this.response(response);
    this.published();
    const body = annotated.body;
    if (!body) {
      this.bodyClosed();
      return annotated;
    }
    const reader = body.getReader();
    const trace = this;
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              controller.close();
              trace.bodyClosed();
            } else {
              trace.output(next.value.byteLength);
              controller.enqueue(next.value);
            }
          } catch (error) {
            controller.error(error);
            trace.bodyClosed();
          }
        },
        async cancel(reason) {
          trace.cancel("consumer_cancel");
          try {
            await boundedCleanup(() => reader.cancel(reason));
          } finally {
            trace.bodyClosed();
          }
        },
      }),
      { status: annotated.status, headers: annotated.headers },
    );
  }

  private bodyClosed(): void {
    if (this.#bodyClosed) return;
    this.#bodyClosed = true;
    auditLog("info", "response_body_closed", {
      request_id: this.requestId,
      downstream_bytes: this.#outputBytes,
      raw_frame_count: this.#rawFrames,
      projected_frame_count: this.#projectedFrames,
      cancel_source: this.#cancel,
      completion_witnessed: this.#witnessed,
      elapsed_ms: this.elapsed(),
    });
  }

  private attemptId(): string | undefined {
    return this.#attempt ? `${this.requestId}.attempt.${this.#attempt}` : undefined;
  }

  private terminalMessage(message: string): string {
    const prior = [this.#lastFailure, this.#firstFailure].find(
      (failure) => failure?.upstream_status !== null && failure?.upstream_status !== undefined,
    );
    if (this.#cancel !== "request_deadline" || !prior) return this.sanitize(message);
    const suffix =
      `; earlier upstream failure HTTP ${prior.upstream_status}` +
      (prior.upstream_code ? ` (${prior.upstream_code})` : "") +
      (prior.upstream_request_id ? `, upstream_request_id: ${prior.upstream_request_id}` : "");
    return this.sanitize(message.endsWith(suffix) ? message : message + suffix);
  }

  private elapsed(): number {
    return Math.round(performance.now() - this.started);
  }
}
