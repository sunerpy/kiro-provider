import Ajv from "ajv";
import { utf8AppendByteLength, utf8ByteLength } from "../../core/utf8-byte-length.js";

/**
 * Shared core of the one local structured-output profile: a root object with
 * exactly one required, bounded string property. Both public lanes (OpenAI
 * Responses `text.format` and Anthropic Messages `output_config.format`)
 * recognise their own wire shape and then delegate schema validation,
 * enforcement, and stream buffering here. Nothing in this module inspects the
 * client, model, prompt, or any request metadata; failures name the public
 * parameter the profile was recognised from.
 */

export const LOCAL_STRUCTURED_OUTPUT_MAX_BUFFER_BYTES = 64 * 1024;
export const LOCAL_STRUCTURED_OUTPUT_PROFILE_KIND = "single-string-object-v1";
/** Local ceiling for the single string property, in Unicode code points. */
export const LOCAL_STRUCTURED_OUTPUT_MAX_PROPERTY_LENGTH = 256;

const PROPERTY_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DANGEROUS_PROPERTY_NAMES = new Set(["__proto__", "prototype", "constructor"]);
const ROOT_SCHEMA_KEYS = new Set(["type", "properties", "required", "additionalProperties"]);
const PROPERTY_SCHEMA_KEYS = new Set(["type", "minLength", "maxLength"]);

export type LocalStructuredOutputProfileKind = typeof LOCAL_STRUCTURED_OUTPUT_PROFILE_KIND;

export interface LocalSingleStringObjectProfile {
  readonly kind: LocalStructuredOutputProfileKind;
  readonly propertyName: string;
  readonly minLength: number;
  readonly maxLength: number;
  /** The frozen, locally-owned schema the output is validated against. */
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface LocalStructuredOutputEnforcementOptions {
  /** Public request parameter the profile was recognised from; names failures. */
  readonly param: string;
  readonly maxBufferBytes?: number;
}

export type LocalStructuredOutputFailureCode =
  | "structured_output_validation_failed"
  | "structured_output_buffer_exceeded";

export interface LocalStructuredOutputFailure {
  readonly ok: false;
  readonly code: LocalStructuredOutputFailureCode;
  readonly message: string;
  readonly param: string;
}

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

export const STRUCTURED_OUTPUT_VALIDATION_FAILED_MESSAGE =
  "Upstream output could not satisfy the local structured output profile";
export const STRUCTURED_OUTPUT_BUFFER_EXCEEDED_MESSAGE =
  "Upstream output exceeded the local structured output buffer limit";
export const STRUCTURED_OUTPUT_UNEXPECTED_TOOL_CALL_MESSAGE =
  "Upstream returned a tool call for a local structured output request";

export function structuredOutputValidationFailure(param: string): LocalStructuredOutputFailure {
  return Object.freeze({
    ok: false,
    code: "structured_output_validation_failed",
    message: STRUCTURED_OUTPUT_VALIDATION_FAILED_MESSAGE,
    param,
  });
}

export function structuredOutputBufferFailure(param: string): LocalStructuredOutputFailure {
  return Object.freeze({
    ok: false,
    code: "structured_output_buffer_exceeded",
    message: STRUCTURED_OUTPUT_BUFFER_EXCEEDED_MESSAGE,
    param,
  });
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === allowed.size && keys.every((key) => typeof key === "string" && allowed.has(key))
  );
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

export interface SingleStringObjectSchema {
  readonly propertyName: string;
  readonly minLength: number;
  readonly maxLength: number;
  readonly schema: Readonly<Record<string, unknown>>;
}

export type SingleStringObjectSchemaBounds =
  /** Both `minLength` and `maxLength` must be present on the property schema. */
  | { readonly kind: "required" }
  /** Either bound may be omitted; the local default then applies. */
  | { readonly kind: "defaulted"; readonly minLength: number; readonly maxLength: number };

/**
 * Recognise the bare JSON Schema of the profile: a root object with exactly one
 * required string property and `additionalProperties: false`. Returns the
 * frozen, locally-owned schema so no client-supplied object is ever compiled.
 */
export function parseSingleStringObjectSchema(
  schema: unknown,
  bounds: SingleStringObjectSchemaBounds,
): SingleStringObjectSchema | undefined {
  if (
    !isRecord(schema) ||
    !hasExactlyKeys(schema, ROOT_SCHEMA_KEYS) ||
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    !isRecord(schema.properties) ||
    !Array.isArray(schema.required)
  ) {
    return undefined;
  }

  const propertyNames = Reflect.ownKeys(schema.properties);
  if (propertyNames.length !== 1 || typeof propertyNames[0] !== "string") return undefined;
  const propertyName = propertyNames[0];
  if (
    !PROPERTY_NAME_PATTERN.test(propertyName) ||
    DANGEROUS_PROPERTY_NAMES.has(propertyName) ||
    schema.required.length !== 1 ||
    schema.required[0] !== propertyName
  ) {
    return undefined;
  }

  const propertySchema = schema.properties[propertyName];
  if (!isRecord(propertySchema) || propertySchema.type !== "string") return undefined;
  if (bounds.kind === "required") {
    if (!hasExactlyKeys(propertySchema, PROPERTY_SCHEMA_KEYS)) return undefined;
  } else if (!hasOnlyKeys(propertySchema, PROPERTY_SCHEMA_KEYS)) {
    return undefined;
  }
  const requestedMin = Object.hasOwn(propertySchema, "minLength")
    ? propertySchema.minLength
    : bounds.kind === "defaulted"
      ? bounds.minLength
      : undefined;
  const requestedMax = Object.hasOwn(propertySchema, "maxLength")
    ? propertySchema.maxLength
    : bounds.kind === "defaulted"
      ? bounds.maxLength
      : undefined;
  if (!Number.isSafeInteger(requestedMin) || !Number.isSafeInteger(requestedMax)) return undefined;
  const minLength = requestedMin as number;
  const maxLength = requestedMax as number;
  if (
    minLength < 1 ||
    minLength > maxLength ||
    maxLength > LOCAL_STRUCTURED_OUTPUT_MAX_PROPERTY_LENGTH
  ) {
    return undefined;
  }

  const safePropertySchema = Object.freeze({ type: "string", minLength, maxLength });
  const safeProperties = Object.freeze({ [propertyName]: safePropertySchema });
  const safeSchema = Object.freeze({
    type: "object",
    properties: safeProperties,
    required: Object.freeze([propertyName]),
    additionalProperties: false,
  });
  return { propertyName, minLength, maxLength, schema: safeSchema };
}

function trimUnicodeWhitespace(value: string): string {
  return value.replace(/^[\p{White_Space}\uFEFF]+/u, "").replace(/[\p{White_Space}\uFEFF]+$/u, "");
}

function parsedCandidate(
  profile: LocalSingleStringObjectProfile,
  text: string,
): string | undefined {
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
  profile: LocalSingleStringObjectProfile,
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
export function enforceLocalSingleStringOutput(
  profile: LocalSingleStringObjectProfile,
  visibleText: string,
  options: LocalStructuredOutputEnforcementOptions,
): LocalStructuredOutputResult {
  const maxBufferBytes = options.maxBufferBytes ?? LOCAL_STRUCTURED_OUTPUT_MAX_BUFFER_BYTES;
  const validationFailure = structuredOutputValidationFailure(options.param);
  const inputBytes = utf8ByteLength(visibleText);
  if (inputBytes > maxBufferBytes) return structuredOutputBufferFailure(options.param);

  const trimmedText = trimUnicodeWhitespace(visibleText);
  const parsed = parsedCandidate(profile, trimmedText);
  if (parsed === undefined) return validationFailure;
  const candidate = trimUnicodeWhitespace(parsed);
  const codePoints = Array.from(candidate);
  if (codePoints.length < profile.minLength) return validationFailure;

  const truncated = codePoints.length > profile.maxLength;
  const normalized = truncated ? codePoints.slice(0, profile.maxLength).join("") : candidate;
  if (Array.from(normalized).length < profile.minLength) return validationFailure;

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
    return validationFailure;
  }
  if (!validate(value)) return validationFailure;

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
export class LocalSingleStringTextBuffer {
  readonly #profile: LocalSingleStringObjectProfile;
  readonly #param: string;
  readonly #maxBufferBytes: number;
  #chunks: string[] = [];
  #byteLength = 0;
  #terminal: LocalStructuredOutputResult | undefined;
  #disposed = false;

  constructor(
    profile: LocalSingleStringObjectProfile,
    param: string,
    maxBufferBytes = LOCAL_STRUCTURED_OUTPUT_MAX_BUFFER_BYTES,
  ) {
    if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes < 0) {
      throw new RangeError("maxBufferBytes must be a non-negative safe integer");
    }
    this.#profile = profile;
    this.#param = param;
    this.#maxBufferBytes = maxBufferBytes;
  }

  get byteLength(): number {
    return this.#byteLength;
  }

  append(delta: string): { readonly ok: true } | LocalStructuredOutputFailure {
    if (this.#terminal !== undefined) {
      return this.#terminal.ok ? structuredOutputValidationFailure(this.#param) : this.#terminal;
    }
    if (this.#disposed) return structuredOutputValidationFailure(this.#param);
    if (delta.length === 0) return { ok: true };

    const addedBytes = utf8AppendByteLength(this.#chunks.at(-1) ?? "", delta);
    const byteLength = this.#byteLength + addedBytes;
    if (byteLength > this.#maxBufferBytes) {
      this.#byteLength = byteLength;
      this.#chunks = [];
      const failure = structuredOutputBufferFailure(this.#param);
      this.#terminal = failure;
      return failure;
    }

    this.#byteLength = byteLength;
    this.#chunks.push(delta);
    return { ok: true };
  }

  complete(): LocalStructuredOutputResult {
    if (this.#terminal !== undefined) return this.#terminal;
    if (this.#disposed) return structuredOutputValidationFailure(this.#param);
    const visibleText = this.#chunks.join("");
    this.#chunks = [];
    this.#terminal = enforceLocalSingleStringOutput(this.#profile, visibleText, {
      param: this.#param,
      maxBufferBytes: this.#maxBufferBytes,
    });
    return this.#terminal;
  }

  dispose(): void {
    this.#chunks = [];
    this.#byteLength = 0;
    this.#terminal = undefined;
    this.#disposed = true;
  }
}
