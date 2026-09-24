import type { CanonicalCompletion } from "../../protocol/output.js";
import {
  enforceLocalSingleStringOutput,
  hasExactlyKeys,
  isRecord,
  LOCAL_STRUCTURED_OUTPUT_MAX_BUFFER_BYTES,
  LOCAL_STRUCTURED_OUTPUT_MAX_PROPERTY_LENGTH,
  LOCAL_STRUCTURED_OUTPUT_PROFILE_KIND,
  type LocalSingleStringObjectProfile,
  LocalSingleStringTextBuffer,
  type LocalStructuredOutputFailureCode,
  type LocalStructuredOutputResult,
  parseSingleStringObjectSchema,
  STRUCTURED_OUTPUT_BUFFER_EXCEEDED_MESSAGE,
  STRUCTURED_OUTPUT_UNEXPECTED_TOOL_CALL_MESSAGE,
  STRUCTURED_OUTPUT_VALIDATION_FAILED_MESSAGE,
} from "../structured-output/local-profile.js";

/**
 * The Anthropic Messages lane of the shared `single-string-object-v1` profile.
 * Claude Code 2.1.280 generates session titles with `output_config.format`
 * carrying `{ type: "json_schema", schema }` whose root object has exactly one
 * required string property. Anthropic's wire shape has no `name` or `strict`
 * and no explicit length bounds, so this lane applies fixed local bounds.
 * Recognition inspects protocol structure only, never the client, model, or
 * prompt, and the schema is never sent upstream.
 */

export const ANTHROPIC_STRUCTURED_OUTPUT_PARAM = "output_config.format";
export const ANTHROPIC_STRUCTURED_OUTPUT_HEADER = "x-kiro-structured-output";
export const ANTHROPIC_STRUCTURED_OUTPUT_REJECTION_CODE = "unsupported_structured_output";
export const ANTHROPIC_STRUCTURED_OUTPUT_REJECTION_MESSAGE =
  "Invalid request: output_config.format is outside the supported local structured output profile";

const FORMAT_KEYS = new Set(["type", "schema"]);
const DEFAULT_MIN_LENGTH = 1;
const DEFAULT_MAX_LENGTH = LOCAL_STRUCTURED_OUTPUT_MAX_PROPERTY_LENGTH;

export type AnthropicLocalStructuredOutputProfile = LocalSingleStringObjectProfile;

export type AnthropicStructuredOutputFailureCode =
  | LocalStructuredOutputFailureCode
  | "structured_output_unexpected_tool_call"
  | "structured_output_unexpected_reasoning";

export interface AnthropicStructuredOutputFailure {
  readonly code: AnthropicStructuredOutputFailureCode;
  readonly message: string;
}

const ANTHROPIC_STRUCTURED_OUTPUT_FAILURE_CODES: ReadonlySet<string> = new Set([
  "structured_output_validation_failed",
  "structured_output_buffer_exceeded",
  "structured_output_unexpected_tool_call",
  "structured_output_unexpected_reasoning",
]);

export function isAnthropicStructuredOutputFailureCode(
  code: unknown,
): code is AnthropicStructuredOutputFailureCode {
  return typeof code === "string" && ANTHROPIC_STRUCTURED_OUTPUT_FAILURE_CODES.has(code);
}

/**
 * The fixed local failure for a coded pipeline or stream error. Messages are
 * always the provider's own strings; nothing from an upstream body is echoed.
 */
export function anthropicStructuredOutputFailureForCode(
  code: AnthropicStructuredOutputFailureCode,
): AnthropicStructuredOutputFailure {
  switch (code) {
    case "structured_output_unexpected_tool_call":
      return STRUCTURED_OUTPUT_UNEXPECTED_TOOL_CALL_FAILURE;
    case "structured_output_unexpected_reasoning":
      return STRUCTURED_OUTPUT_UNEXPECTED_REASONING_FAILURE;
    case "structured_output_buffer_exceeded":
      return STRUCTURED_OUTPUT_BUFFER_FAILURE;
    case "structured_output_validation_failed":
      return STRUCTURED_OUTPUT_VALIDATION_FAILURE;
  }
}

export const STRUCTURED_OUTPUT_UNEXPECTED_TOOL_CALL_FAILURE: AnthropicStructuredOutputFailure =
  Object.freeze({
    code: "structured_output_unexpected_tool_call",
    message: STRUCTURED_OUTPUT_UNEXPECTED_TOOL_CALL_MESSAGE,
  });

export const STRUCTURED_OUTPUT_UNEXPECTED_REASONING_FAILURE: AnthropicStructuredOutputFailure =
  Object.freeze({
    code: "structured_output_unexpected_reasoning",
    message: "Upstream returned reasoning for a local structured output request",
  });

export const STRUCTURED_OUTPUT_VALIDATION_FAILURE: AnthropicStructuredOutputFailure = Object.freeze(
  {
    code: "structured_output_validation_failed",
    message: STRUCTURED_OUTPUT_VALIDATION_FAILED_MESSAGE,
  },
);

export const STRUCTURED_OUTPUT_BUFFER_FAILURE: AnthropicStructuredOutputFailure = Object.freeze({
  code: "structured_output_buffer_exceeded",
  message: STRUCTURED_OUTPUT_BUFFER_EXCEEDED_MESSAGE,
});

/**
 * Anthropic error objects carry only `type` and `message`; the stable failure
 * code travels inside the message, matching the route's existing translation
 * of coded upstream failures.
 */
export function anthropicStructuredOutputFailureMessage(
  failure: AnthropicStructuredOutputFailure,
): string {
  return `${failure.message} (code: ${failure.code})`;
}

/**
 * Recognize `output_config.format`. Returns the profile when the format is
 * exactly `{ type: "json_schema", schema }` with a root object holding one
 * required string property, `additionalProperties: false`, and optional integer
 * bounds inside the local 1..256 code point window; `undefined` otherwise.
 */
export function parseAnthropicLocalStructuredOutputFormat(
  format: unknown,
): AnthropicLocalStructuredOutputProfile | undefined {
  if (!isRecord(format) || format.type !== "json_schema" || !hasExactlyKeys(format, FORMAT_KEYS)) {
    return undefined;
  }
  const parsed = parseSingleStringObjectSchema(format.schema, {
    kind: "defaulted",
    minLength: DEFAULT_MIN_LENGTH,
    maxLength: DEFAULT_MAX_LENGTH,
  });
  if (parsed === undefined) return undefined;
  return Object.freeze({
    kind: LOCAL_STRUCTURED_OUTPUT_PROFILE_KIND,
    propertyName: parsed.propertyName,
    minLength: parsed.minLength,
    maxLength: parsed.maxLength,
    schema: parsed.schema,
  });
}

/** Failures name `output_config.format`. */
export function enforceAnthropicStructuredOutput(
  profile: AnthropicLocalStructuredOutputProfile,
  visibleText: string,
  maxBufferBytes = LOCAL_STRUCTURED_OUTPUT_MAX_BUFFER_BYTES,
): LocalStructuredOutputResult {
  return enforceLocalSingleStringOutput(profile, visibleText, {
    param: ANTHROPIC_STRUCTURED_OUTPUT_PARAM,
    maxBufferBytes,
  });
}

/** Stream accumulator for the Messages lane; nothing is published until complete(). */
export class AnthropicStructuredOutputTextBuffer extends LocalSingleStringTextBuffer {
  constructor(
    profile: AnthropicLocalStructuredOutputProfile,
    maxBufferBytes = LOCAL_STRUCTURED_OUTPUT_MAX_BUFFER_BYTES,
  ) {
    super(profile, ANTHROPIC_STRUCTURED_OUTPUT_PARAM, maxBufferBytes);
  }
}

/**
 * Whether the ordinary Messages adapter would publish a thinking or
 * redacted_thinking block for this reasoning. The profile disables thinking at
 * the request boundary, so any such block is an upstream contract violation.
 */
export function reasoningWouldPublish(reasoning: CanonicalCompletion["reasoning"]): boolean {
  return (
    reasoning !== undefined &&
    (reasoning.text !== undefined ||
      reasoning.signature !== undefined ||
      reasoning.redactedContent !== undefined)
  );
}

/**
 * Pre-enforcement checks for one complete non-stream completion. Tool calls and
 * reasoning are rejected before any text is inspected; code references cannot
 * describe the replaced text, so they fail validation like the Responses lane.
 */
export function anthropicStructuredCompletionFailure(
  completion: CanonicalCompletion,
): AnthropicStructuredOutputFailure | undefined {
  if (completion.toolCalls.length > 0 || completion.finishReason === "tool_calls") {
    return STRUCTURED_OUTPUT_UNEXPECTED_TOOL_CALL_FAILURE;
  }
  if (reasoningWouldPublish(completion.reasoning)) {
    return STRUCTURED_OUTPUT_UNEXPECTED_REASONING_FAILURE;
  }
  if ((completion.codeReferences?.length ?? 0) > 0) return STRUCTURED_OUTPUT_VALIDATION_FAILURE;
  return undefined;
}
