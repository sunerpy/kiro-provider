import { isRecord } from "./adapter-utils.js";
import { type CodeReference, parseCodeReferences } from "./code-references.js";
import {
  CANONICAL_OUTPUT_VERSION,
  type CanonicalOutputEvent,
  type CanonicalOutputUsage,
  parseCanonicalOutputEvent,
} from "./output.js";
import { parseReportedUsage, parseUsageAccounting } from "./usage.js";

/**
 * Canonical output v2: the ordered event contract for provider-executed hosted
 * tools. Ordinary requests keep v1. A v2 stream carries every real event of a
 * multi-generation execution in order: per-generation reasoning and text,
 * hosted search calls and their results, cited spans, the boundaries between
 * generations, and one terminal with usage summed over all generations.
 *
 * Readers accept v1 and v2; a v2 stream never contains v1 events.
 */

export const CANONICAL_OUTPUT_V2 = 2 as const;

export interface CanonicalSearchSourceView {
  readonly ordinal: number;
  readonly url: string;
  readonly title: string;
  /** UTC date (YYYY-MM-DD) of the backend publishedDate, or null. */
  readonly pageAge: string | null;
  /** Messages `encrypted_content`; absent for protocols that do not carry one. */
  readonly encryptedContent?: string;
}

interface V2Base {
  readonly canonicalOutputVersion: typeof CANONICAL_OUTPUT_V2;
}

type V1Body<T extends CanonicalOutputEvent["type"]> = Omit<
  Extract<CanonicalOutputEvent, { readonly type: T }>,
  "canonicalOutputVersion"
>;

export type CanonicalOutputEventV2 =
  | (V2Base & V1Body<"started">)
  | (V2Base & V1Body<"reasoning_delta">)
  | (V2Base & V1Body<"reasoning_signature">)
  | (V2Base & V1Body<"reasoning_redacted">)
  | (V2Base & V1Body<"reasoning_encrypted">)
  | (V2Base & V1Body<"text_delta">)
  /** One complete client tool call of the final tool group. */
  | (V2Base & V1Body<"tool_call_delta">)
  | (V2Base & {
      readonly type: "search_call_started";
      readonly callId: string;
      readonly query: string;
      /** Recorded but not executed in this response (mixed group or pause). */
      readonly deferred: boolean;
    })
  | (V2Base & {
      readonly type: "search_result";
      readonly callId: string;
      readonly sources: readonly CanonicalSearchSourceView[];
    })
  | (V2Base & { readonly type: "search_call_completed"; readonly callId: string })
  | (V2Base & {
      readonly type: "search_call_failed";
      readonly callId: string;
      readonly errorCode: string;
    })
  | (V2Base & {
      readonly type: "citation";
      /** The exact cited span of model text (also part of the visible text). */
      readonly text: string;
      readonly callId: string;
      readonly ordinal: number;
      readonly url: string;
      readonly title: string;
      readonly citedText: string;
      readonly encryptedIndex?: string;
    })
  | (V2Base & { readonly type: "generation_boundary" })
  /**
   * Opaque key shared by the public identities of one generation's items, so
   * a replayed history can be split back into generations in any item order.
   */
  | (V2Base & { readonly type: "generation_started"; readonly key: string })
  | (V2Base & {
      readonly type: "completed";
      readonly finishReason: "stop" | "tool_calls" | "pause";
      readonly usage: CanonicalOutputUsage;
      readonly webSearchRequests: number;
      readonly codeReferences?: readonly CodeReference[];
    });

export type CanonicalOutputEventV2Type = CanonicalOutputEventV2["type"];

/** Non-stream v2: the same ordered events, collected once execution ended. */
export interface CanonicalCompletionV2 {
  readonly canonicalOutputVersion: typeof CANONICAL_OUTPUT_V2;
  readonly events: readonly CanonicalOutputEventV2[];
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseUsage(value: unknown): CanonicalOutputUsage | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["inputTokens", "outputTokens", "totalTokens", "reported", "accounting"]) ||
    !nonNegativeInteger(value.inputTokens) ||
    !nonNegativeInteger(value.outputTokens) ||
    !nonNegativeInteger(value.totalTokens) ||
    value.totalTokens !== value.inputTokens + value.outputTokens
  ) {
    return undefined;
  }
  const reported = value.reported === undefined ? undefined : parseReportedUsage(value.reported);
  const accounting =
    value.accounting === undefined ? undefined : parseUsageAccounting(value.accounting);
  if (value.reported !== undefined && reported === undefined) return undefined;
  if (value.accounting !== undefined && accounting === undefined) return undefined;
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
    ...(reported !== undefined ? { reported } : {}),
    ...(accounting !== undefined ? { accounting } : {}),
  };
}

function parseSource(value: unknown): CanonicalSearchSourceView | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["ordinal", "url", "title", "pageAge", "encryptedContent"]) ||
    !nonNegativeInteger(value.ordinal) ||
    !nonEmpty(value.url) ||
    typeof value.title !== "string" ||
    (value.pageAge !== null && typeof value.pageAge !== "string") ||
    (value.encryptedContent !== undefined && !nonEmpty(value.encryptedContent))
  ) {
    return undefined;
  }
  return {
    ordinal: value.ordinal,
    url: value.url,
    title: value.title,
    pageAge: value.pageAge,
    ...(typeof value.encryptedContent === "string"
      ? { encryptedContent: value.encryptedContent }
      : {}),
  };
}

const V1_TYPES = new Set([
  "started",
  "reasoning_delta",
  "reasoning_signature",
  "reasoning_redacted",
  "reasoning_encrypted",
  "text_delta",
  "tool_call_delta",
]);

export function parseCanonicalOutputEventV2(value: unknown): CanonicalOutputEventV2 | undefined {
  if (!isRecord(value) || value.canonicalOutputVersion !== CANONICAL_OUTPUT_V2) return undefined;
  const base = { canonicalOutputVersion: CANONICAL_OUTPUT_V2 } as const;
  const type = value.type;
  if (typeof type !== "string") return undefined;
  if (V1_TYPES.has(type)) {
    // Shared payload rules are the v1 rules; only the version marker differs.
    const parsed = parseCanonicalOutputEvent({
      ...value,
      canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
    });
    if (parsed === undefined || parsed.type === "completed") return undefined;
    const { canonicalOutputVersion: _v1, ...body } = parsed;
    return { ...base, ...body } as CanonicalOutputEventV2;
  }
  switch (type) {
    case "search_call_started":
      if (
        !hasOnlyKeys(value, ["canonicalOutputVersion", "type", "callId", "query", "deferred"]) ||
        !nonEmpty(value.callId) ||
        typeof value.query !== "string" ||
        typeof value.deferred !== "boolean"
      ) {
        return undefined;
      }
      return { ...base, type, callId: value.callId, query: value.query, deferred: value.deferred };
    case "search_result": {
      if (
        !hasOnlyKeys(value, ["canonicalOutputVersion", "type", "callId", "sources"]) ||
        !nonEmpty(value.callId) ||
        !Array.isArray(value.sources)
      ) {
        return undefined;
      }
      const sources: CanonicalSearchSourceView[] = [];
      for (const candidate of value.sources) {
        const source = parseSource(candidate);
        if (source === undefined) return undefined;
        sources.push(source);
      }
      return { ...base, type, callId: value.callId, sources };
    }
    case "search_call_completed":
      if (
        !hasOnlyKeys(value, ["canonicalOutputVersion", "type", "callId"]) ||
        !nonEmpty(value.callId)
      ) {
        return undefined;
      }
      return { ...base, type, callId: value.callId };
    case "search_call_failed":
      if (
        !hasOnlyKeys(value, ["canonicalOutputVersion", "type", "callId", "errorCode"]) ||
        !nonEmpty(value.callId) ||
        !nonEmpty(value.errorCode)
      ) {
        return undefined;
      }
      return { ...base, type, callId: value.callId, errorCode: value.errorCode };
    case "citation":
      if (
        !hasOnlyKeys(value, [
          "canonicalOutputVersion",
          "type",
          "text",
          "callId",
          "ordinal",
          "url",
          "title",
          "citedText",
          "encryptedIndex",
        ]) ||
        !nonEmpty(value.text) ||
        !nonEmpty(value.callId) ||
        !nonNegativeInteger(value.ordinal) ||
        !nonEmpty(value.url) ||
        typeof value.title !== "string" ||
        typeof value.citedText !== "string" ||
        (value.encryptedIndex !== undefined && !nonEmpty(value.encryptedIndex))
      ) {
        return undefined;
      }
      return {
        ...base,
        type,
        text: value.text,
        callId: value.callId,
        ordinal: value.ordinal,
        url: value.url,
        title: value.title,
        citedText: value.citedText,
        ...(typeof value.encryptedIndex === "string"
          ? { encryptedIndex: value.encryptedIndex }
          : {}),
      };
    case "generation_boundary":
      if (!hasOnlyKeys(value, ["canonicalOutputVersion", "type"])) return undefined;
      return { ...base, type };
    case "generation_started":
      if (
        !hasOnlyKeys(value, ["canonicalOutputVersion", "type", "key"]) ||
        typeof value.key !== "string" ||
        !/^[0-9a-f]{16}$/.test(value.key)
      ) {
        return undefined;
      }
      return { ...base, type, key: value.key };
    case "completed": {
      if (
        !hasOnlyKeys(value, [
          "canonicalOutputVersion",
          "type",
          "finishReason",
          "usage",
          "webSearchRequests",
          "codeReferences",
        ]) ||
        (value.finishReason !== "stop" &&
          value.finishReason !== "tool_calls" &&
          value.finishReason !== "pause") ||
        !nonNegativeInteger(value.webSearchRequests)
      ) {
        return undefined;
      }
      const usage = parseUsage(value.usage);
      if (usage === undefined) return undefined;
      const codeReferences =
        value.codeReferences === undefined ? undefined : parseCodeReferences(value.codeReferences);
      if (value.codeReferences !== undefined && codeReferences === undefined) return undefined;
      return {
        ...base,
        type,
        finishReason: value.finishReason,
        usage,
        webSearchRequests: value.webSearchRequests,
        ...(codeReferences !== undefined ? { codeReferences } : {}),
      };
    }
    default:
      return undefined;
  }
}

export function parseCanonicalOutputEventV2Line(line: string): CanonicalOutputEventV2 | undefined {
  try {
    return parseCanonicalOutputEventV2(JSON.parse(line));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** Validates a non-stream v2 document, including start/terminal placement. */
export function parseCanonicalCompletionV2(value: unknown): CanonicalCompletionV2 | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["canonicalOutputVersion", "events"]) ||
    value.canonicalOutputVersion !== CANONICAL_OUTPUT_V2 ||
    !Array.isArray(value.events) ||
    value.events.length < 2
  ) {
    return undefined;
  }
  const events: CanonicalOutputEventV2[] = [];
  for (const candidate of value.events) {
    const event = parseCanonicalOutputEventV2(candidate);
    if (event === undefined) return undefined;
    events.push(event);
  }
  if (
    events[0]?.type !== "started" ||
    events.at(-1)?.type !== "completed" ||
    events.slice(1, -1).some((event) => event.type === "started" || event.type === "completed")
  ) {
    return undefined;
  }
  return { canonicalOutputVersion: CANONICAL_OUTPUT_V2, events };
}

/** Reader compatibility: either canonical version, never mixed within one stream. */
export function parseAnyCanonicalOutputEventLine(
  line: string,
): CanonicalOutputEvent | CanonicalOutputEventV2 | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (isRecord(value) && value.canonicalOutputVersion === CANONICAL_OUTPUT_V2) {
      return parseCanonicalOutputEventV2(value);
    }
    return parseCanonicalOutputEvent(value);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export function isV2Event(
  event: CanonicalOutputEvent | CanonicalOutputEventV2,
): event is CanonicalOutputEventV2 {
  return event.canonicalOutputVersion === CANONICAL_OUTPUT_V2;
}
