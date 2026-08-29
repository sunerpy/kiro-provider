import { auditHash } from "./audit-log.js";

const STREAM_FAILURES = {
  request_deadline_exceeded: {
    disposition: "retryable",
    message: "Request deadline exceeded",
  },
  upstream_stream_error: {
    disposition: "retryable",
    message: "Upstream stream error",
  },
  upstream_stream_incomplete: {
    disposition: "retryable",
    message: "Upstream stream ended before completion",
  },
  upstream_stream_idle_timeout: {
    disposition: "retryable",
    message: "Upstream stream idle timeout",
  },
  incomplete_upstream_tool_call: {
    disposition: "fatal",
    message: "Upstream returned an incomplete tool call",
  },
  invalid_upstream_reasoning: {
    disposition: "fatal",
    message: "Upstream returned invalid reasoning metadata",
  },
  invalid_upstream_tool_call: {
    disposition: "fatal",
    message: "Upstream returned an invalid tool call",
  },
  missing_upstream_stream: {
    disposition: "fatal",
    message: "Upstream response did not include a stream",
  },
  unsupported_upstream_event: {
    disposition: "fatal",
    message: "Upstream returned an unsupported stream event",
  },
  upstream_invalid_state: {
    disposition: "fatal",
    message: "Upstream returned an invalid stream state",
  },
  upstream_protocol_error: {
    disposition: "fatal",
    message: "Upstream stream protocol error",
  },
} as const;

export type StreamFailureCode = keyof typeof STREAM_FAILURES;
export type StreamFailureDisposition =
  (typeof STREAM_FAILURES)[StreamFailureCode]["disposition"];

export interface StreamFailure {
  readonly code: StreamFailureCode;
  readonly message: string;
  readonly disposition: StreamFailureDisposition;
}

function property(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function stringProperty(value: unknown, key: string): string | undefined {
  const candidate = property(value, key);
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

function knownCode(value: unknown): StreamFailureCode | undefined {
  const code = stringProperty(value, "code");
  return code !== undefined && Object.hasOwn(STREAM_FAILURES, code)
    ? (code as StreamFailureCode)
    : undefined;
}

function safeDiagnosticCode(value: unknown): string | undefined {
  const code = stringProperty(value, "code");
  return code !== undefined && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(code)
    ? code
    : undefined;
}

export function streamFailure(
  code: StreamFailureCode,
  message?: string,
): StreamFailure {
  const descriptor = STREAM_FAILURES[code];
  return {
    code,
    disposition: descriptor.disposition,
    message: message ?? descriptor.message,
  };
}

export function normalizeStreamFailure(
  reason: unknown,
  fallbackCode: StreamFailureCode = "upstream_stream_error",
): StreamFailure {
  const code = knownCode(reason) ?? knownCode(property(reason, "cause"));
  return streamFailure(code ?? fallbackCode);
}

export function streamErrorAuditFields(
  reason: unknown,
): Readonly<Record<string, string>> {
  const normalized = normalizeStreamFailure(reason);
  const message = stringProperty(reason, "message");
  const sourceErrorCode = safeDiagnosticCode(reason);
  const cause = property(reason, "cause");
  const causeType = stringProperty(cause, "name");
  const causeCode = safeDiagnosticCode(cause);
  const causeMessage = stringProperty(cause, "message");
  return {
    error_type: stringProperty(reason, "name") ?? typeof reason,
    error_code: normalized.code,
    error_disposition: normalized.disposition,
    ...(message !== undefined
      ? { error_message_hash: auditHash(message) }
      : {}),
    ...(sourceErrorCode !== undefined
      ? { source_error_code: sourceErrorCode }
      : {}),
    ...(causeType !== undefined ? { error_cause_type: causeType } : {}),
    ...(causeCode !== undefined ? { error_cause_code: causeCode } : {}),
    ...(causeMessage !== undefined
      ? { error_cause_message_hash: auditHash(causeMessage) }
      : {}),
  };
}
