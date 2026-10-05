import { type CanonicalProtocol, canonicalFingerprint } from "../protocol/canonical.js";
import {
  type DomainFilter,
  type DomainRule,
  MAX_DOMAIN_FILTER_ENTRIES,
  parseDomainRule,
} from "./domain-filter.js";
import type { SearchContextSize } from "./projection.js";

/**
 * Protocol-neutral, validated hosted web search declaration.
 *
 * Only the verified real-time search surface is accepted. Cached or indexed
 * search, preview tools, image search, dynamic filtering, geolocation, code
 * execution callers and every unrecognized control are rejected before any
 * generation, never accepted and ignored.
 */

export type HostedWebSearchType = "web_search" | "web_search_2025_08_26" | "web_search_20250305";

export interface HostedWebSearchDeclaration {
  readonly protocol: CanonicalProtocol;
  readonly publicType: HostedWebSearchType;
  readonly publicName: "web_search";
  /** Messages `max_uses`; the provider-wide call ceiling applies as well. */
  readonly maxUses?: number;
  readonly filter?: DomainFilter;
  readonly contextSize: SearchContextSize;
  readonly path: string;
  /** Binds pending calls to an unchanged declaration across requests. */
  readonly fingerprint: string;
}

export type DeclarationResult =
  | { readonly ok: true; readonly declaration: HostedWebSearchDeclaration }
  | {
      readonly ok: false;
      readonly code:
        | "unsupported_web_search"
        | "unsupported_web_search_parameter"
        | "invalid_web_search_declaration";
      readonly message: string;
      readonly param: string;
    };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsupportedParameter(path: string, message: string): DeclarationResult {
  return { ok: false, code: "unsupported_web_search_parameter", message, param: path };
}

function invalid(path: string, message: string): DeclarationResult {
  return { ok: false, code: "invalid_web_search_declaration", message, param: path };
}

function parseRules(
  value: unknown,
  path: string,
  allowPath: boolean,
): { readonly ok: true; readonly rules: readonly DomainRule[] } | DeclarationResult {
  if (!Array.isArray(value)) return invalid(path, `${path} must be an array of domains`);
  if (value.length > MAX_DOMAIN_FILTER_ENTRIES) {
    return invalid(path, `${path} accepts at most ${MAX_DOMAIN_FILTER_ENTRIES} entries`);
  }
  const rules: DomainRule[] = [];
  for (const [index, entry] of value.entries()) {
    const parsed = parseDomainRule(entry, allowPath);
    if (!parsed.ok) return invalid(`${path}.${index}`, `${path}.${index} ${parsed.reason}`);
    rules.push(parsed.rule);
  }
  return { ok: true, rules };
}

function fingerprint(
  declaration: Omit<HostedWebSearchDeclaration, "fingerprint" | "path">,
): string {
  return canonicalFingerprint({
    version: "hosted-web-search-declaration-v1",
    protocol: declaration.protocol,
    publicType: declaration.publicType,
    publicName: declaration.publicName,
    maxUses: declaration.maxUses ?? null,
    filter: declaration.filter ?? null,
    contextSize: declaration.contextSize,
  });
}

const RESPONSES_KEYS = new Set([
  "type",
  "external_web_access",
  "search_context_size",
  "filters",
  "user_location",
]);

/** `tools[]` entry of an OpenAI Responses request whose type starts with web_search. */
export function parseResponsesWebSearchTool(
  tool: Readonly<Record<string, unknown>>,
  path: string,
): DeclarationResult {
  const type = tool.type;
  if (type !== "web_search" && type !== "web_search_2025_08_26") {
    return {
      ok: false,
      code: "unsupported_web_search",
      message: `Responses tool type ${String(type)} is not supported by the provider web search`,
      param: path,
    };
  }
  for (const key of Object.keys(tool)) {
    if (!RESPONSES_KEYS.has(key)) {
      return unsupportedParameter(
        `${path}.${key}`,
        `Responses ${type}.${key} is not supported by the provider web search`,
      );
    }
  }
  if (tool.external_web_access !== undefined && tool.external_web_access !== true) {
    return unsupportedParameter(
      `${path}.external_web_access`,
      "Only live web search is supported; cached or offline search (external_web_access=false) is rejected",
    );
  }
  if (tool.user_location !== undefined && tool.user_location !== null) {
    return unsupportedParameter(
      `${path}.user_location`,
      "Localized web search (user_location) is not supported",
    );
  }
  let contextSize: SearchContextSize = "medium";
  if (tool.search_context_size !== undefined) {
    if (
      tool.search_context_size !== "low" &&
      tool.search_context_size !== "medium" &&
      tool.search_context_size !== "high"
    ) {
      return invalid(
        `${path}.search_context_size`,
        "search_context_size must be low, medium, or high",
      );
    }
    contextSize = tool.search_context_size;
  }
  let filter: DomainFilter | undefined;
  if (tool.filters !== undefined && tool.filters !== null) {
    if (!isRecord(tool.filters)) return invalid(`${path}.filters`, "filters must be an object");
    for (const key of Object.keys(tool.filters)) {
      if (key !== "allowed_domains" && key !== "blocked_domains") {
        return unsupportedParameter(
          `${path}.filters.${key}`,
          `Responses web search filters.${key} is not supported`,
        );
      }
    }
    const lists = (["allowed_domains", "blocked_domains"] as const).filter(
      (key) => tool.filters !== null && isRecord(tool.filters) && tool.filters[key] != null,
    );
    if (lists.length > 1) {
      return invalid(
        `${path}.filters`,
        "Use filters.allowed_domains or filters.blocked_domains, not both",
      );
    }
    for (const key of lists) {
      const rules = parseRules(
        (tool.filters as Readonly<Record<string, unknown>>)[key],
        `${path}.filters.${key}`,
        false,
      );
      if (!("rules" in rules)) return rules;
      if (rules.rules.length > 0) {
        filter = { mode: key === "allowed_domains" ? "allow" : "block", rules: rules.rules };
      }
    }
  }
  const base = {
    protocol: "responses" as const,
    publicType: type as HostedWebSearchType,
    publicName: "web_search" as const,
    ...(filter !== undefined ? { filter } : {}),
    contextSize,
  };
  return { ok: true, declaration: { ...base, path, fingerprint: fingerprint(base) } };
}

const MESSAGES_KEYS = new Set([
  "type",
  "name",
  "max_uses",
  "allowed_domains",
  "blocked_domains",
  "user_location",
  "allowed_callers",
  "cache_control",
]);

/** Anthropic `tools[]` entry with a `web_search_*` server tool type. */
export function parseMessagesWebSearchTool(
  tool: Readonly<Record<string, unknown>>,
  path: string,
): DeclarationResult {
  const type = tool.type;
  if (type !== "web_search_20250305") {
    return {
      ok: false,
      code: "unsupported_web_search",
      message: `Messages tool type ${String(type)} is not supported; only web_search_20250305 without dynamic filtering is available`,
      param: `${path}.type`,
    };
  }
  for (const key of Object.keys(tool)) {
    if (!MESSAGES_KEYS.has(key)) {
      return unsupportedParameter(
        `${path}.${key}`,
        `Messages web_search_20250305.${key} is not supported by the provider web search`,
      );
    }
  }
  if (tool.name !== "web_search") {
    return invalid(`${path}.name`, "web_search_20250305 must be named web_search");
  }
  if (tool.user_location !== undefined) {
    return unsupportedParameter(
      `${path}.user_location`,
      "Localized web search (user_location) is not supported",
    );
  }
  if (tool.allowed_callers !== undefined) {
    if (
      !Array.isArray(tool.allowed_callers) ||
      tool.allowed_callers.length !== 1 ||
      tool.allowed_callers[0] !== "direct"
    ) {
      return unsupportedParameter(
        `${path}.allowed_callers`,
        'Only direct web search calls are supported (allowed_callers: ["direct"])',
      );
    }
  }
  let maxUses: number | undefined;
  if (tool.max_uses !== undefined) {
    if (
      typeof tool.max_uses !== "number" ||
      !Number.isSafeInteger(tool.max_uses) ||
      tool.max_uses < 1
    ) {
      return invalid(`${path}.max_uses`, "max_uses must be a positive integer");
    }
    maxUses = tool.max_uses;
  }
  if (tool.allowed_domains !== undefined && tool.blocked_domains !== undefined) {
    return invalid(
      path,
      "Use allowed_domains or blocked_domains for web_search, not both in the same request",
    );
  }
  let filter: DomainFilter | undefined;
  for (const [key, mode] of [
    ["allowed_domains", "allow"],
    ["blocked_domains", "block"],
  ] as const) {
    const value = tool[key];
    if (value === undefined) continue;
    const rules = parseRules(value, `${path}.${key}`, true);
    if (!("rules" in rules)) return rules;
    if (rules.rules.length > 0) filter = { mode, rules: rules.rules };
  }
  const base = {
    protocol: "anthropic-messages" as const,
    publicType: "web_search_20250305" as const,
    publicName: "web_search" as const,
    ...(maxUses !== undefined ? { maxUses } : {}),
    ...(filter !== undefined ? { filter } : {}),
    contextSize: "medium" as const,
  };
  return { ok: true, declaration: { ...base, path, fingerprint: fingerprint(base) } };
}

/**
 * Verified capability cells: protocol x Kiro wire model x region. A cell is
 * listed only after the provider's own real-client and real-backend
 * acceptance passed for it; every alias and effort suffix of a listed wire
 * model shares the cell.
 */
const VERIFIED_WEB_SEARCH_CELLS: ReadonlySet<string> = new Set([
  "responses:gpt-5.6-sol:us-east-1",
  "responses:claude-opus-5.5:us-east-1",
  "anthropic-messages:gpt-5.6-sol:us-east-1",
  "anthropic-messages:claude-opus-5.5:us-east-1",
]);

export function isVerifiedWebSearchCell(
  protocol: CanonicalProtocol,
  wireModel: string,
  region: string,
): boolean {
  return VERIFIED_WEB_SEARCH_CELLS.has(`${protocol}:${wireModel}:${region}`);
}

export function isVerifiedWebSearchModel(protocol: CanonicalProtocol, wireModel: string): boolean {
  for (const cell of VERIFIED_WEB_SEARCH_CELLS) {
    if (cell.startsWith(`${protocol}:${wireModel}:`)) return true;
  }
  return false;
}
