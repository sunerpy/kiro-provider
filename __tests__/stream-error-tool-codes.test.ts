import { describe, expect, test } from "bun:test";
import {
  normalizeStreamFailure,
  type StreamFailureCode,
  type StreamFailureDisposition,
  streamErrorAuditFields,
  streamFailure,
} from "../src/core/stream-error.js";

/**
 * B26 follow-up: the Responses adapter emits `unknown_upstream_tool` and
 * `invalid_custom_tool_input` as terminal codes. They are registered as fatal
 * so every consumer of normalizeStreamFailure classifies them the same way
 * (see docs/STREAM_ERROR_CONTRACT.md, "revisit after real traffic").
 */

const TOOL_OUTPUT_CODES = [
  ["unknown_upstream_tool", "Upstream returned an undeclared tool call"],
  ["invalid_custom_tool_input", "Upstream returned invalid custom tool input"],
] as const;

/** Every code that existed before the tool-output codes, with its pinned disposition. */
const EXISTING_CODES: ReadonlyArray<readonly [StreamFailureCode, StreamFailureDisposition]> = [
  ["request_deadline_exceeded", "retryable"],
  ["upstream_stream_error", "retryable"],
  ["upstream_stream_incomplete", "retryable"],
  ["upstream_stream_idle_timeout", "retryable"],
  ["malformed_upstream_tool_arguments", "retryable"],
  ["incomplete_upstream_tool_call", "fatal"],
  ["invalid_upstream_reasoning", "fatal"],
  ["invalid_upstream_tool_call", "fatal"],
  ["missing_upstream_stream", "fatal"],
  ["unsupported_upstream_event", "fatal"],
  ["upstream_invalid_state", "fatal"],
  ["upstream_protocol_error", "fatal"],
];

describe("Responses tool-output codes in the stream failure registry", () => {
  test.each(TOOL_OUTPUT_CODES)("%s is a fatal registered failure", (code, message) => {
    expect(streamFailure(code)).toEqual({ code, disposition: "fatal", message });
  });

  test.each(TOOL_OUTPUT_CODES)("normalizes an error carrying %s directly", (code) => {
    const error = Object.assign(new Error("private tool detail"), { code });

    expect(normalizeStreamFailure(error)).toEqual(streamFailure(code));
    expect(normalizeStreamFailure({ code })).toEqual(streamFailure(code));
  });

  test.each(TOOL_OUTPUT_CODES)("recovers %s from a wrapped cause", (code) => {
    const cause = Object.assign(new Error("private tool detail"), { code });
    const wrapper = new TypeError("adapter wrapper", { cause });

    expect(normalizeStreamFailure(wrapper)).toEqual(streamFailure(code));
    expect(normalizeStreamFailure(wrapper, "upstream_protocol_error")).toEqual(
      streamFailure(code),
    );
  });

  test.each(TOOL_OUTPUT_CODES)("audits %s with the fatal disposition and no prose", (code) => {
    const fields = streamErrorAuditFields(
      Object.assign(new Error("hallucinated tool secret_lookup"), { code }),
    );

    expect(fields).toMatchObject({
      error_type: "Error",
      error_code: code,
      error_disposition: "fatal",
      source_error_code: code,
    });
    expect(JSON.stringify(fields)).not.toContain("secret_lookup");
  });

  test("keeps the bridge-internal alias code out of the registry", () => {
    // The wire code is unknown_upstream_tool; unknown_tool_alias is only the
    // tool bridge's internal reason and must still fall back like any unknown code.
    const bridgeFailure = { code: "unknown_tool_alias", message: "undeclared tool" };

    expect(normalizeStreamFailure(bridgeFailure)).toEqual(
      streamFailure("upstream_stream_error"),
    );
    expect(normalizeStreamFailure(bridgeFailure, "upstream_protocol_error")).toEqual(
      streamFailure("upstream_protocol_error"),
    );
  });

  test.each(EXISTING_CODES)("leaves %s classified as %s", (code, disposition) => {
    expect(streamFailure(code).disposition).toBe(disposition);
    expect(normalizeStreamFailure({ code })).toEqual(streamFailure(code));
  });
});
