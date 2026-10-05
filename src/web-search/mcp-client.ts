import { createHash, randomUUID } from "node:crypto";
import packageMetadata from "../../package.json" with { type: "json" };
import { fetchProxyOption } from "../core/proxy.js";
import { canonicalFingerprint } from "../protocol/canonical.js";
import { decodeWebSearchToolResult, type WebSearchResultSet } from "./decoder.js";

/**
 * Provider-owned KiroRuntime InvokeMCP client for the hosted `web_search` tool.
 *
 * The endpoint, operation and tool name are fixed by the server: clients can
 * never supply an MCP endpoint, a profile ARN or another tool. The request uses
 * the selected account's access token and bound profile ARN with an honest
 * User-Agent; it never starts or reads the Kiro CLI. Search RPCs are never
 * retried here: a call whose outcome is uncertain is reported, not repeated.
 */

export const KIRO_MCP_TARGET = "KiroRuntimeService.InvokeMCP";
export const WEB_SEARCH_TOOL_NAME = "web_search";
export const WEB_SEARCH_USER_AGENT = `kiro-provider/${packageMetadata.version}`;
/** Regions whose InvokeMCP search path passed the provider's own evidence gate. */
export const VERIFIED_WEB_SEARCH_REGIONS: ReadonlySet<string> = new Set(["us-east-1"]);
/** Provider ceiling for a query; larger queries are rejected, never truncated. */
export const MAX_WEB_SEARCH_QUERY_BYTES = 4096;
const MAX_TOOL_LIST_BYTES = 262_144;

export type WebSearchFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface McpCallContext {
  readonly accessToken: string;
  readonly profileArn: string;
  readonly region: string;
  /** Overrides the regional runtime endpoint (tests and isolated probes only). */
  readonly endpoint?: string;
  readonly proxyUrl?: string;
  readonly fetch?: WebSearchFetch;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

/** The backend's own declaration, passed to Kiro verbatim. */
export interface WebSearchToolDefinition {
  readonly name: typeof WEB_SEARCH_TOOL_NAME;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly fingerprint: string;
}

/** Internal failure classes; audit-safe enums, never upstream text. */
export type WebSearchRpcFailure =
  | "region_unverified"
  | "query_empty"
  | "query_too_long"
  | "aborted"
  | "timeout"
  | "transport_error"
  | "http_throttled"
  | "http_access_denied"
  | "http_client_error"
  | "http_server_error"
  | "response_too_large"
  | "response_invalid"
  | "rpc_id_mismatch"
  | "rpc_invalid_params"
  | "rpc_error"
  | "result_not_object"
  | "result_content_invalid"
  | "result_reported_error"
  | "result_text_not_json"
  | "result_schema_mismatch"
  | "tool_definition_invalid";

/** Messages `web_search_tool_result_error.error_code` values the provider can justify. */
export type WebSearchErrorCode =
  | "too_many_requests"
  | "invalid_tool_input"
  | "max_uses_exceeded"
  | "query_too_long"
  | "request_too_large"
  | "unavailable";

export function webSearchErrorCode(failure: WebSearchRpcFailure): WebSearchErrorCode {
  switch (failure) {
    case "query_empty":
    case "rpc_invalid_params":
      return "invalid_tool_input";
    case "query_too_long":
      return "query_too_long";
    case "http_throttled":
      return "too_many_requests";
    default:
      return "unavailable";
  }
}

export class WebSearchRpcError extends Error {
  readonly name = "WebSearchRpcError";

  constructor(
    readonly failure: WebSearchRpcFailure,
    readonly status?: number,
  ) {
    super(`InvokeMCP web_search failed: ${failure}`);
  }
}

export type WebSearchCallOutcome =
  | {
      readonly ok: true;
      readonly result: WebSearchResultSet;
      /** Exact backend text item the result was decoded from. */
      readonly resultText: string;
      readonly responseBytes: number;
      readonly durationMs: number;
    }
  | {
      readonly ok: false;
      readonly failure: WebSearchRpcFailure;
      readonly status?: number;
      readonly durationMs: number;
      /** True when the request may have reached the backend before failing. */
      readonly dispatched: boolean;
    };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function runtimeEndpointFor(region: string, override?: string): string {
  if (override !== undefined) return override.endsWith("/") ? override : `${override}/`;
  return `https://runtime.${region}.kiro.dev/`;
}

export function webSearchQueryFailure(query: unknown): WebSearchRpcFailure | undefined {
  if (typeof query !== "string" || query.trim().length === 0) return "query_empty";
  if (Buffer.byteLength(query, "utf8") > MAX_WEB_SEARCH_QUERY_BYTES) return "query_too_long";
  return undefined;
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new WebSearchRpcError("response_too_large", response.status);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new WebSearchRpcError("response_too_large", response.status);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

function classifyStatus(status: number): WebSearchRpcFailure {
  if (status === 429) return "http_throttled";
  if (status === 401 || status === 403) return "http_access_denied";
  if (status >= 500) return "http_server_error";
  return "http_client_error";
}

interface RpcResponse {
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown };
  readonly responseBytes: number;
}

async function invoke(
  context: McpCallContext,
  method: "tools/list" | "tools/call",
  params: Readonly<Record<string, unknown>>,
  maxResponseBytes: number,
): Promise<RpcResponse> {
  if (!VERIFIED_WEB_SEARCH_REGIONS.has(context.region)) {
    throw new WebSearchRpcError("region_unverified");
  }
  const id = randomUUID();
  // A referenced timer, not AbortSignal.timeout: Bun's timeout signal uses an
  // unreferenced timer, which on Windows never fires while nothing else keeps
  // the event loop running, so a stalled call would never time out.
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new DOMException("The web search call timed out", "TimeoutError")),
    Math.max(1, context.timeoutMs),
  );
  try {
    return await exchange(context, method, params, maxResponseBytes, id, timeout.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function exchange(
  context: McpCallContext,
  method: "tools/list" | "tools/call",
  params: Readonly<Record<string, unknown>>,
  maxResponseBytes: number,
  id: string,
  timeout: AbortSignal,
): Promise<RpcResponse> {
  const signal = AbortSignal.any([context.signal, timeout]);
  const request = context.fetch ?? (fetch as unknown as WebSearchFetch);
  let response: Response;
  try {
    response = await request(runtimeEndpointFor(context.region, context.endpoint), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${context.accessToken}`,
        "Content-Type": "application/x-amz-json-1.0",
        "x-amz-target": KIRO_MCP_TARGET,
        "User-Agent": WEB_SEARCH_USER_AGENT,
      },
      body: JSON.stringify({
        profileArn: context.profileArn,
        jsonrpc: "2.0",
        id,
        method,
        params,
      }),
      signal,
      ...fetchProxyOption(context.proxyUrl),
    });
  } catch {
    if (context.signal.aborted) throw new WebSearchRpcError("aborted");
    if (timeout.aborted) throw new WebSearchRpcError("timeout");
    throw new WebSearchRpcError("transport_error");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new WebSearchRpcError(classifyStatus(response.status), response.status);
  }
  let text: string;
  try {
    text = await readBounded(response, maxResponseBytes);
  } catch (error) {
    if (error instanceof WebSearchRpcError) throw error;
    if (context.signal.aborted) throw new WebSearchRpcError("aborted");
    if (timeout.aborted) throw new WebSearchRpcError("timeout");
    throw new WebSearchRpcError("response_invalid", response.status);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new WebSearchRpcError("response_invalid", response.status);
  }
  if (!isRecord(payload) || payload.jsonrpc !== "2.0") {
    throw new WebSearchRpcError("response_invalid", response.status);
  }
  if (payload.id !== id) throw new WebSearchRpcError("rpc_id_mismatch", response.status);
  const responseBytes = Buffer.byteLength(text, "utf8");
  if (payload.error !== undefined && payload.error !== null) {
    if (!isRecord(payload.error)) throw new WebSearchRpcError("response_invalid", response.status);
    return { error: { code: payload.error.code }, responseBytes };
  }
  return { result: payload.result, responseBytes };
}

/** Reads the backend's own `web_search` declaration from `tools/list`. */
export async function listWebSearchTool(context: McpCallContext): Promise<WebSearchToolDefinition> {
  const response = await invoke(context, "tools/list", {}, MAX_TOOL_LIST_BYTES);
  if (response.error !== undefined) throw new WebSearchRpcError("rpc_error");
  const result = response.result;
  if (!isRecord(result) || !Array.isArray(result.tools)) {
    throw new WebSearchRpcError("tool_definition_invalid");
  }
  const matches = result.tools.filter(
    (tool): tool is Readonly<Record<string, unknown>> =>
      isRecord(tool) && tool.name === WEB_SEARCH_TOOL_NAME,
  );
  const tool = matches[0];
  if (
    matches.length !== 1 ||
    tool === undefined ||
    typeof tool.description !== "string" ||
    tool.description.trim().length === 0 ||
    !isRecord(tool.inputSchema)
  ) {
    throw new WebSearchRpcError("tool_definition_invalid");
  }
  const schema = tool.inputSchema;
  const properties = schema.properties;
  if (
    schema.type !== "object" ||
    !isRecord(properties) ||
    !isRecord(properties.query) ||
    properties.query.type !== "string" ||
    !Array.isArray(schema.required) ||
    !schema.required.includes("query")
  ) {
    throw new WebSearchRpcError("tool_definition_invalid");
  }
  const definition = {
    name: WEB_SEARCH_TOOL_NAME,
    description: tool.description,
    inputSchema: schema,
  } as const;
  return { ...definition, fingerprint: canonicalFingerprint(definition) };
}

/** Executes one search. Never throws; every failure is a typed outcome. */
export async function callWebSearch(
  context: McpCallContext,
  query: string,
  maxResponseBytes: number,
): Promise<WebSearchCallOutcome> {
  const started = performance.now();
  const elapsed = (): number => Math.max(0, Math.round(performance.now() - started));
  const local = webSearchQueryFailure(query);
  if (local !== undefined) {
    return { ok: false, failure: local, durationMs: elapsed(), dispatched: false };
  }
  try {
    const response = await invoke(
      context,
      "tools/call",
      { name: WEB_SEARCH_TOOL_NAME, arguments: { query } },
      maxResponseBytes,
    );
    if (response.error !== undefined) {
      return {
        ok: false,
        failure: response.error.code === -32602 ? "rpc_invalid_params" : "rpc_error",
        durationMs: elapsed(),
        dispatched: true,
      };
    }
    const decoded = decodeWebSearchToolResult(response.result);
    if (!decoded.ok) {
      return { ok: false, failure: decoded.reason, durationMs: elapsed(), dispatched: true };
    }
    return {
      ok: true,
      result: decoded.value,
      resultText: decoded.text,
      responseBytes: response.responseBytes,
      durationMs: elapsed(),
    };
  } catch (error) {
    const failure = error instanceof WebSearchRpcError ? error.failure : "transport_error";
    return {
      ok: false,
      failure,
      ...(error instanceof WebSearchRpcError && error.status !== undefined
        ? { status: error.status }
        : {}),
      durationMs: elapsed(),
      dispatched: failure !== "region_unverified",
    };
  }
}

/** Stable digest of a query for snapshots and audits; never the query text. */
export function webSearchQueryFingerprint(query: string): string {
  return createHash("sha256")
    .update("kiro-provider-web-search-query-v1\0")
    .update(query)
    .digest("hex");
}
