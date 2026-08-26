import { describe, expect, test } from "bun:test";
import {
  KIRO_OUTPUT_TOKEN_LIMIT_MAX,
  KIRO_OUTPUT_TOKEN_LIMIT_MIN,
  resolveOutputTokenLimit,
} from "../src/kiro/output-token-limit.js";

describe("probe-backed Kiro output-token limits", () => {
  test.each([
    "claude-sonnet-5",
    "claude-sonnet-5-thinking",
    "claude-sonnet-5-high",
  ])("maps %s to native Claude max_tokens", (model) => {
    expect(resolveOutputTokenLimit(model, 4_096)).toEqual({
      ok: true,
      wireModel: "claude-sonnet-5",
      additionalModelRequestFields: { max_tokens: 4_096 },
    });
  });

  test.each([KIRO_OUTPUT_TOKEN_LIMIT_MIN - 1, KIRO_OUTPUT_TOKEN_LIMIT_MAX + 1])(
    "rejects out-of-range Claude max_tokens value %d before Kiro",
    (limit) => {
      expect(resolveOutputTokenLimit("claude-sonnet-5", limit)).toMatchObject({
        ok: false,
        code: "invalid_output_token_limit",
      });
    },
  );

  test.each(["gpt-5.6-sol", "auto", "claude-sonnet-4-5", "claude-opus-4-8"])(
    "keeps unproven model %s fail-closed",
    (model) => {
      expect(resolveOutputTokenLimit(model, 4_096)).toMatchObject({
        ok: false,
        code: "unsupported_output_token_limit",
      });
    },
  );
});
