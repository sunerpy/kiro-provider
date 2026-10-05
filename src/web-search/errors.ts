/**
 * Typed web search failures raised before or outside a committed response.
 * `status` is the public HTTP status; messages are fixed provider text and
 * never carry upstream bodies, queries, URLs or identifiers.
 */
export type WebSearchErrorCode =
  | "web_search_disabled"
  | "unsupported_web_search"
  | "unsupported_web_search_model"
  | "unsupported_web_search_parameter"
  | "invalid_web_search_declaration"
  | "web_search_unavailable"
  | "web_search_store_unavailable"
  | "web_search_cache_full"
  | "web_search_history_too_large"
  | "web_search_replay_not_found"
  | "web_search_replay_expired"
  | "web_search_replay_invalid"
  | "web_search_replay_key_unavailable"
  | "web_search_replay_uncertain"
  | "web_search_replay_pending"
  | "web_search_replay_owner_unavailable"
  | "web_search_pending_unauthorized"
  | "web_search_iteration_limit";

export class WebSearchError extends Error {
  readonly name = "WebSearchError";

  constructor(
    message: string,
    readonly code: WebSearchErrorCode,
    readonly status: 400 | 409 | 502 | 503 = 400,
    readonly param?: string,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.status === 503;
  }
}

/** OpenAI-style error `type` for a web search failure status. */
export function webSearchErrorType(
  status: WebSearchError["status"],
): "invalid_request_error" | "upstream_error" | "service_unavailable" {
  return status === 503
    ? "service_unavailable"
    : status === 502
      ? "upstream_error"
      : "invalid_request_error";
}

export function isWebSearchError(error: unknown): error is WebSearchError {
  return error instanceof WebSearchError;
}
