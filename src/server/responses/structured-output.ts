import {
  enforceLocalSingleStringOutput,
  hasExactlyKeys,
  isRecord,
  LOCAL_STRUCTURED_OUTPUT_MAX_BUFFER_BYTES,
  LOCAL_STRUCTURED_OUTPUT_PROFILE_KIND,
  type LocalSingleStringObjectProfile,
  LocalSingleStringTextBuffer,
  type LocalStructuredOutputResult,
  parseSingleStringObjectSchema,
} from "../structured-output/local-profile.js";

export {
  LOCAL_STRUCTURED_OUTPUT_MAX_BUFFER_BYTES,
  type LocalStructuredOutputFailure,
  type LocalStructuredOutputResult,
  type LocalStructuredOutputSuccess,
} from "../structured-output/local-profile.js";

const FORMAT_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const FORMAT_KEYS = new Set(["type", "name", "strict", "schema"]);
export const RESPONSES_STRUCTURED_OUTPUT_PARAM = "text.format";

const STRUCTURED_OUTPUT_REJECTION = Object.freeze({
  kind: "rejected",
  code: "unsupported_structured_output",
  message: "Responses text.format is outside the supported local structured output profile",
  param: RESPONSES_STRUCTURED_OUTPUT_PARAM,
} as const);

export interface LocalStructuredOutputFormat {
  readonly type: "json_schema";
  readonly name: string;
  readonly strict: true;
  readonly schema: Readonly<Record<string, unknown>>;
}

/** The Responses lane of the shared single-string profile; failures name `text.format`. */
export interface LocalStructuredOutputProfile extends LocalSingleStringObjectProfile {
  readonly formatName: string;
  readonly requestedFormat: LocalStructuredOutputFormat;
}

export type LocalStructuredOutputProfileResult =
  | { readonly kind: "ordinary" }
  | { readonly kind: "profile"; readonly profile: LocalStructuredOutputProfile }
  | typeof STRUCTURED_OUTPUT_REJECTION;

export type LocalStructuredOutputRequestBoundaryResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "unsupported_response_semantics";
      readonly message: string;
      readonly param: string;
    };

function rejectedProfile(): typeof STRUCTURED_OUTPUT_REJECTION {
  return STRUCTURED_OUTPUT_REJECTION;
}

/**
 * Recognize the one local Responses structured-output profile. This function
 * only inspects protocol structure; it does not inspect the client, model,
 * prompt, schema name, or any other request metadata.
 */
export function parseLocalStructuredOutputProfile(
  text: unknown,
): LocalStructuredOutputProfileResult {
  if (text === undefined) return { kind: "ordinary" };
  if (!isRecord(text) || !Object.hasOwn(text, "format") || text.format === undefined) {
    return { kind: "ordinary" };
  }

  const format = text.format;
  if (isRecord(format) && format.type === "text" && Reflect.ownKeys(format).length === 1) {
    return { kind: "ordinary" };
  }
  if (!isRecord(format) || format.type !== "json_schema" || !hasExactlyKeys(format, FORMAT_KEYS)) {
    return rejectedProfile();
  }
  if (
    format.strict !== true ||
    typeof format.name !== "string" ||
    !FORMAT_NAME_PATTERN.test(format.name)
  ) {
    return rejectedProfile();
  }

  // Codex always sends explicit integer bounds; keep that requirement exact.
  const parsed = parseSingleStringObjectSchema(format.schema, { kind: "required" });
  if (parsed === undefined) return rejectedProfile();

  const requestedFormat = Object.freeze({
    type: "json_schema",
    name: format.name,
    strict: true,
    schema: parsed.schema,
  });
  const profile: LocalStructuredOutputProfile = Object.freeze({
    kind: LOCAL_STRUCTURED_OUTPUT_PROFILE_KIND,
    formatName: format.name,
    propertyName: parsed.propertyName,
    minLength: parsed.minLength,
    maxLength: parsed.maxLength,
    requestedFormat,
    schema: parsed.schema,
  });
  return { kind: "profile", profile };
}

function requestBoundaryFailure(param: string): LocalStructuredOutputRequestBoundaryResult {
  return {
    ok: false,
    code: "unsupported_response_semantics",
    message: `The local structured output profile cannot preserve ${param}`,
    param,
  };
}

/**
 * Admit one-shot, text-only metadata requests, including current declarations
 * attached by Codex's title worker. The ordinary adapter validates and preserves
 * declarations; this profile rejects every output tool call before publication.
 * Recognition has already
 * happened from text.format; this boundary never consults client identity,
 * model, prompt wording, cwd, originator, or private metadata.
 */
export function validateLocalStructuredOutputRequestBoundary(
  request: unknown,
): LocalStructuredOutputRequestBoundaryResult {
  if (!isRecord(request)) return requestBoundaryFailure("request");
  if (request.store !== undefined && request.store !== false) {
    return requestBoundaryFailure("store");
  }
  if (request.previous_response_id !== undefined) {
    return requestBoundaryFailure("previous_response_id");
  }
  if (request.conversation !== undefined) return requestBoundaryFailure("conversation");
  if (request.background === true) return requestBoundaryFailure("background");
  if (request.tools !== undefined && !Array.isArray(request.tools)) {
    return requestBoundaryFailure("tools");
  }
  if (
    request.tool_choice !== undefined &&
    request.tool_choice !== "auto" &&
    request.tool_choice !== "none"
  ) {
    return requestBoundaryFailure("tool_choice");
  }
  if (typeof request.input === "string") return { ok: true };
  if (!Array.isArray(request.input)) return requestBoundaryFailure("input");

  for (const [itemIndex, item] of request.input.entries()) {
    const itemPath = `input.${itemIndex}`;
    if (isRecord(item) && item.type === "additional_tools") {
      if (!Array.isArray(item.tools)) return requestBoundaryFailure(itemPath);
      continue;
    }
    if (!isRecord(item) || (item.type !== undefined && item.type !== "message")) {
      return requestBoundaryFailure(itemPath);
    }
    const content = item.content;
    if (typeof content === "string") continue;
    if (!Array.isArray(content)) return requestBoundaryFailure(`${itemPath}.content`);
    for (const [partIndex, part] of content.entries()) {
      const partPath = `${itemPath}.content.${partIndex}`;
      if (
        !isRecord(part) ||
        (part.type !== "input_text" && part.type !== "output_text") ||
        typeof part.text !== "string"
      ) {
        return requestBoundaryFailure(partPath);
      }
    }
  }
  return { ok: true };
}

/**
 * Deterministically project one complete visible-text output into the bounded
 * single-string object; failures name `text.format`. No prompt injection,
 * repair, retry, or second model inference occurs here.
 */
export function enforceLocalStructuredOutput(
  profile: LocalStructuredOutputProfile,
  visibleText: string,
  maxBufferBytes = LOCAL_STRUCTURED_OUTPUT_MAX_BUFFER_BYTES,
): LocalStructuredOutputResult {
  return enforceLocalSingleStringOutput(profile, visibleText, {
    param: RESPONSES_STRUCTURED_OUTPUT_PARAM,
    maxBufferBytes,
  });
}

/**
 * A bounded streaming accumulator for the Responses lane. Callers emit no
 * public text until complete() returns a validated envelope; dispose() eagerly
 * drops private buffered text.
 */
export class LocalStructuredOutputTextBuffer extends LocalSingleStringTextBuffer {
  constructor(
    profile: LocalStructuredOutputProfile,
    maxBufferBytes = LOCAL_STRUCTURED_OUTPUT_MAX_BUFFER_BYTES,
  ) {
    super(profile, RESPONSES_STRUCTURED_OUTPUT_PARAM, maxBufferBytes);
  }
}
