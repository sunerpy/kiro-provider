import { describe, expect, test } from "bun:test";
import {
  buildWireDiffReport,
  diffSafeValues,
  sanitizeWireValue,
} from "../scripts/kiro-cli-wire-diff.js";

describe("kiro CLI wire diff", () => {
  test("redacts credentials, signatures, text, tool names, and ids", () => {
    const sanitized = sanitizeWireValue({
      authorization: "Bearer secret",
      conversationId: "conversation-secret",
      content: "prompt-secret",
      signature: "signature-secret",
      name: "tool-secret",
      modelId: "claude-opus-5",
    });
    const rendered = JSON.stringify(sanitized);

    for (const marker of [
      "Bearer secret",
      "conversation-secret",
      "prompt-secret",
      "signature-secret",
      "tool-secret",
    ]) {
      expect(rendered).not.toContain(marker);
    }
    expect(sanitized).toMatchObject({
      authorization: "<redacted>",
      signature: "<redacted>",
      modelId: "claude-opus-5",
    });
  });

  test("unwraps request envelopes and reports structural differences only", () => {
    const cli = new TextEncoder().encode(
      JSON.stringify({
        request: {
          conversationState: {
            conversationId: "cli-conversation",
            currentMessage: {
              userInputMessage: {
                content: "same synthetic marker",
                modelId: "claude-opus-5",
                origin: "AI_EDITOR",
              },
            },
          },
          authorization: "secret-cli-token",
        },
      }),
    );
    const provider = new TextEncoder().encode(
      JSON.stringify({
        conversationState: {
          conversationId: "provider-conversation",
          currentMessage: {
            userInputMessage: {
              content: "same synthetic marker",
              modelId: "claude-opus-5",
              origin: "AI_EDITOR",
              userInputMessageContext: { tools: [] },
            },
          },
        },
      }),
    );

    const report = buildWireDiffReport(cli, provider);
    expect(report.differences.map((difference) => difference.path)).toEqual([
      "$.authorization",
      "$.conversationState.conversationId",
      "$.conversationState.currentMessage.userInputMessage.userInputMessageContext",
    ]);
    expect(JSON.stringify(report)).not.toContain("secret-cli-token");
    expect(JSON.stringify(report)).not.toContain("same synthetic marker");
  });

  test("diffs arrays and missing fields deterministically", () => {
    expect(diffSafeValues({ values: [1, 2] }, { values: [1, 3], extra: true })).toEqual([
      { path: "$.extra", provider: true },
      { path: "$.values[1]", cli: 2, provider: 3 },
    ]);
  });
});
