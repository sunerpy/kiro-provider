import Ajv from "ajv";
import { utf8AppendByteLength, utf8ByteLength } from "../../core/utf8-byte-length.js";

export const LOCAL_STRUCTURED_OUTPUT_MAX_BUFFER_BYTES = 64 * 1024;

const FORMAT_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PROPERTY_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DANGEROUS_PROPERTY_NAMES = new Set(["__proto__", "prototype", "constructor"]);
const FORMAT_KEYS = new Set(["type", "name", "strict", "schema"]);
const ROOT_SCHEMA_KEYS = new Set(["type", "properties", "required", "additionalProperties"]);
const PROPERTY_SCHEMA_KEYS = new Set(["type", "minLength", "maxLength"]);

const STRUCTURED_OUTPUT_REJECTION = Object.freeze({
  kind: "rejected",
  code: "unsupported_structured_output",
  message: "Responses text.format is outside the supported local structured output profile",
  param: "text.format",
} as const);

const STRUCTURED_OUTPUT_VALIDATION_FAILURE = Object.freeze({
  ok: false,
  code: "structured_output_validation_failed",
  message: "Upstream output could not satisfy the local structured output profile",
  param: "text.format",
} as const);

const STRUCTURED_OUTPUT_BUFFER_FAILURE = Object.freeze({
  ok: false,
  code: "structured_output_buffer_exceeded",
  message: "Upstream output exceeded the local structured output buffer limit",
  param: "text.format",
} as const);

export interface LocalStructuredOutputFormat {
  readonly type: "json_schema";
  readonly name: string;
  readonly strict: true;
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface LocalStructuredOutputProfile {
  readonly kind: "single-string-object-v1";
  readonly formatName: string;
  readonly propertyName: string;
  readonly minLength: number;
  readonly maxLength: number;
  readonly requestedFormat: LocalStructuredOutputFormat;
  readonly schema: Readonly<Record<string, unknown>>;
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

export type LocalStructuredOutputFailure =
  | typeof STRUCTURED_OUTPUT_VALIDATION_FAILURE
  | typeof STRUCTURED_OUTPUT_BUFFER_FAILURE;

export type LocalStructuredOutputSuccess = {
  readonly ok: true;
  readonly text: string;
  readonly value: Readonly<Record<string, string>>;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly truncated: boolean;
};

export type LocalStructuredOutputResult =
  | LocalStructuredOutputSuccess
  | LocalStructuredOutputFailure;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === allowed.size && keys.every((key) => typeof key === "string" && allowed.has(key))
  );
}

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

  const schema = format.schema;
  if (
    !isRecord(schema) ||
    !hasExactlyKeys(schema, ROOT_SCHEMA_KEYS) ||
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    !isRecord(schema.properties) ||
    !Array.isArray(schema.required)
  ) {
    return rejectedProfile();
  }

  const propertyNames = Reflect.ownKeys(schema.properties);
  if (propertyNames.length !== 1 || typeof propertyNames[0] !== "string") {
    return rejectedProfile();
  }
  const propertyName = propertyNames[0];
  if (
    !PROPERTY_NAME_PATTERN.test(propertyName) ||
    DANGEROUS_PROPERTY_NAMES.has(propertyName) ||
    schema.required.length !== 1 ||
    schema.required[0] !== propertyName
  ) {
    return rejectedProfile();
  }

  const propertySchema = schema.properties[propertyName];
  if (
    !isRecord(propertySchema) ||
    !hasExactlyKeys(propertySchema, PROPERTY_SCHEMA_KEYS) ||
    propertySchema.type !== "string" ||
    !Number.isSafeInteger(propertySchema.minLength) ||
    !Number.isSafeInteger(propertySchema.maxLength)
  ) {
    return rejectedProfile();
  }
  const minLength = propertySchema.minLength as number;
  const maxLength = propertySchema.maxLength as number;
  if (minLength < 1 || minLength > maxLength || maxLength > 256) {
    return rejectedProfile();
  }

  const safePropertySchema = Object.freeze({ type: "string", minLength, maxLength });
  const safeProperties = Object.freeze({ [propertyName]: safePropertySchema });
  const safeSchema = Object.freeze({
    type: "object",
    properties: safeProperties,
    required: Object.freeze([propertyName]),
    additionalProperties: false,
  });
  const requestedFormat = Object.freeze({
    type: "json_schema",
    name: format.name,
    strict: true,
    schema: safeSchema,
  });
  const profile = Object.freeze({
    kind: "single-string-object-v1" as const,
    formatName: format.name,
    propertyName,
    minLength,
    maxLength,
    requestedFormat,
    schema: safeSchema,
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

function trimUnicodeWhitespace(value: string): string {
  return value.replace(/^[\p{White_Space}\uFEFF]+/u, "").replace(/[\p{White_Space}\uFEFF]+$/u, "");
}

function parsedCandidate(profile: LocalStructuredOutputProfile, text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (typeof parsed === "string") return parsed;
  if (!isRecord(parsed)) return undefined;
  const keys = Reflect.ownKeys(parsed);
  if (
    keys.length !== 1 ||
    keys[0] !== profile.propertyName ||
    !Object.hasOwn(parsed, profile.propertyName)
  ) {
    return undefined;
  }
  const value = parsed[profile.propertyName];
  return typeof value === "string" ? value : undefined;
}

function compileProfileValidator(
  profile: LocalStructuredOutputProfile,
): (value: unknown) => boolean {
  const ajv = new Ajv({
    strict: true,
    allErrors: false,
    validateFormats: false,
    ownProperties: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    addUsedSchema: false,
  });
  return ajv.compile(profile.schema) as (value: unknown) => boolean;
}

/**
 * Deterministically project one complete visible-text output into the bounded
 * single-string object. No prompt injection, repair, retry, or second model
 * inference occurs here.
 */
export function enforceLocalStructuredOutput(
  profile: LocalStructuredOutputProfile,
  visibleText: string,
  maxBufferBytes = LOCAL_STRUCTURED_OUTPUT_MAX_BUFFER_BYTES,
): LocalStructuredOutputResult {
  const inputBytes = utf8ByteLength(visibleText);
  if (inputBytes > maxBufferBytes) return STRUCTURED_OUTPUT_BUFFER_FAILURE;

  const trimmedText = trimUnicodeWhitespace(visibleText);
  const parsed = parsedCandidate(profile, trimmedText);
  if (parsed === undefined) return STRUCTURED_OUTPUT_VALIDATION_FAILURE;
  const candidate = trimUnicodeWhitespace(parsed);
  const codePoints = Array.from(candidate);
  if (codePoints.length < profile.minLength) return STRUCTURED_OUTPUT_VALIDATION_FAILURE;

  const truncated = codePoints.length > profile.maxLength;
  const normalized = truncated ? codePoints.slice(0, profile.maxLength).join("") : candidate;
  if (Array.from(normalized).length < profile.minLength) {
    return STRUCTURED_OUTPUT_VALIDATION_FAILURE;
  }

  const value = Object.create(null) as Record<string, string>;
  Object.defineProperty(value, profile.propertyName, {
    value: normalized,
    enumerable: true,
    configurable: false,
    writable: false,
  });

  let validate: (value: unknown) => boolean;
  try {
    validate = compileProfileValidator(profile);
  } catch {
    return STRUCTURED_OUTPUT_VALIDATION_FAILURE;
  }
  if (!validate(value)) return STRUCTURED_OUTPUT_VALIDATION_FAILURE;

  const text = JSON.stringify(value);
  return {
    ok: true,
    text,
    value: Object.freeze(value),
    inputBytes,
    outputBytes: utf8ByteLength(text),
    truncated,
  };
}

/**
 * A bounded streaming accumulator. Callers emit no public text until complete()
 * returns a validated envelope; dispose() eagerly drops private buffered text.
 */
export class LocalStructuredOutputTextBuffer {
  readonly #profile: LocalStructuredOutputProfile;
  readonly #maxBufferBytes: number;
  #chunks: string[] = [];
  #byteLength = 0;
  #terminal: LocalStructuredOutputResult | undefined;
  #disposed = false;

  constructor(
    profile: LocalStructuredOutputProfile,
    maxBufferBytes = LOCAL_STRUCTURED_OUTPUT_MAX_BUFFER_BYTES,
  ) {
    if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes < 0) {
      throw new RangeError("maxBufferBytes must be a non-negative safe integer");
    }
    this.#profile = profile;
    this.#maxBufferBytes = maxBufferBytes;
  }

  get byteLength(): number {
    return this.#byteLength;
  }

  append(delta: string): { readonly ok: true } | LocalStructuredOutputFailure {
    if (this.#terminal !== undefined) {
      return this.#terminal.ok ? STRUCTURED_OUTPUT_VALIDATION_FAILURE : this.#terminal;
    }
    if (this.#disposed) return STRUCTURED_OUTPUT_VALIDATION_FAILURE;
    if (delta.length === 0) return { ok: true };

    const addedBytes = utf8AppendByteLength(this.#chunks.at(-1) ?? "", delta);
    const byteLength = this.#byteLength + addedBytes;
    if (byteLength > this.#maxBufferBytes) {
      this.#byteLength = byteLength;
      this.#chunks = [];
      this.#terminal = STRUCTURED_OUTPUT_BUFFER_FAILURE;
      return STRUCTURED_OUTPUT_BUFFER_FAILURE;
    }

    this.#byteLength = byteLength;
    this.#chunks.push(delta);
    return { ok: true };
  }

  complete(): LocalStructuredOutputResult {
    if (this.#terminal !== undefined) return this.#terminal;
    if (this.#disposed) return STRUCTURED_OUTPUT_VALIDATION_FAILURE;
    const visibleText = this.#chunks.join("");
    this.#chunks = [];
    this.#terminal = enforceLocalStructuredOutput(this.#profile, visibleText, this.#maxBufferBytes);
    return this.#terminal;
  }

  dispose(): void {
    this.#chunks = [];
    this.#byteLength = 0;
    this.#terminal = undefined;
    this.#disposed = true;
  }
}
