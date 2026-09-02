import { describe, expect, test } from "bun:test";
import {
  KIRO_OUTPUT_TOKEN_LIMIT_MAX,
  KIRO_OUTPUT_TOKEN_LIMIT_MIN,
  resolveOutputTokenLimit,
} from "../src/kiro/output-token-limit.js";

describe("probe-backed Kiro output-token limits", () => {
  test.each([
    ["claude-sonnet-5", "claude-sonnet-5"],
    ["claude-sonnet-5-thinking", "claude-sonnet-5"],
    ["claude-sonnet-5-high", "claude-sonnet-5"],
    ["claude-opus-5", "claude-opus-5"],
    ["claude-opus-5-thinking", "claude-opus-5"],
    ["claude-opus-5-max", "claude-opus-5"],
  ])("maps %s to native Claude max_tokens", (model, wireModel) => {
    expect(resolveOutputTokenLimit(model, 4_096)).toEqual({
      ok: true,
      wireModel,
      additionalModelRequestFields: { max_tokens: 4_096 },
    });
  });

  test.each(["claude-sonnet-5", "claude-opus-5"])(
    "rejects out-of-range %s max_tokens values before Kiro",
    (model) => {
      for (const limit of [KIRO_OUTPUT_TOKEN_LIMIT_MIN - 1, KIRO_OUTPUT_TOKEN_LIMIT_MAX + 1]) {
        expect(resolveOutputTokenLimit(model, limit)).toMatchObject({
          ok: false,
          code: "invalid_output_token_limit",
        });
      }
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
