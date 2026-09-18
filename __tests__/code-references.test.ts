import { describe, expect, test } from "bun:test";
import { codeReferenceMetadata, parseCodeReferences } from "../src/protocol/code-references.js";
import { parseCanonicalCompletion, parseCanonicalOutputEvent } from "../src/protocol/output.js";

describe("public code reference metadata contract", () => {
  for (const [label, value] of [
    ["non-array", {}],
    ["null list", null],
    ["null reference", [null]],
    ["primitive reference", [1]],
    ["unknown field", [{ privateField: "fixture" }]],
    ["non-string license", [{ licenseName: 1 }]],
    ["null span", [{ recommendationContentSpan: null }]],
    ["unknown span key", [{ recommendationContentSpan: { bytes: 1 } }]],
    ["negative span", [{ recommendationContentSpan: { start: -1 } }]],
    ["fractional span", [{ recommendationContentSpan: { start: 0.5 } }]],
    ["non-number span", [{ recommendationContentSpan: { end: "1" } }]],
    ["reversed span", [{ recommendationContentSpan: { start: 2, end: 1 } }]],
    ["unsafe span", [{ recommendationContentSpan: { end: Number.MAX_SAFE_INTEGER + 1 } }]],
    ["too many references", Array.from({ length: 129 }, () => ({}))],
    ["too many characters", [{ repository: "x".repeat(256 * 1024 + 1) }]],
    ["UTF-8 byte budget", [{ repository: "中".repeat(90_000) }]],
  ] as const) {
    test(`rejects ${label}`, () => {
      expect(parseCodeReferences(value)).toBeUndefined();
    });
  }

  test("preserves optional public fields, order, duplicate entries, and upstream span units", () => {
    const input = [
      {},
      { licenseName: "" },
      { repository: "fixture", recommendationContentSpan: { start: 4 } },
      { url: "https://example.invalid/source", recommendationContentSpan: { end: 8 } },
      { url: "https://example.invalid/source", recommendationContentSpan: { end: 8 } },
    ];
    expect(parseCodeReferences(input)).toEqual(input);
    expect(parseCodeReferences(Array.from({ length: 128 }, () => ({})))).toHaveLength(128);
  });

  test("copies metadata instead of retaining mutable SDK objects", () => {
    const reference = { licenseName: "MIT", recommendationContentSpan: { start: 0, end: 8 } };
    const input = [reference];
    const parsed = parseCodeReferences(input);
    reference.licenseName = "changed";
    reference.recommendationContentSpan.end = 99;
    expect(parsed).toEqual([
      { licenseName: "MIT", recommendationContentSpan: { start: 0, end: 8 } },
    ]);
  });

  test("accepts the exact serialized byte budget and rejects the next byte", () => {
    const overhead = Buffer.byteLength(JSON.stringify([{ repository: "" }]), "utf8");
    const repository = "x".repeat(256 * 1024 - overhead);
    expect(parseCodeReferences([{ repository }])).toEqual([{ repository }]);
    expect(parseCodeReferences([{ repository: `${repository}x` }])).toBeUndefined();
  });

  test("omits the extension when there is no attribution", () => {
    expect(codeReferenceMetadata(undefined)).toEqual({});
    expect(codeReferenceMetadata([])).toEqual({});
    expect(codeReferenceMetadata([{ licenseName: "MIT" }])).toEqual({
      x_kiro: { code_references: [{ licenseName: "MIT" }] },
    });
  });

  test("validates references at both canonical serialization boundaries", () => {
    const codeReferences = [{ licenseName: "MIT", url: "https://example.invalid/source" }];
    const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };
    const event = { canonicalOutputVersion: 1, type: "completed", finishReason: "stop", usage };
    const completion = {
      canonicalOutputVersion: 1,
      conversationId: "fixture",
      model: "gpt-5.6-sol",
      createdAt: 1,
      text: "original",
      toolCalls: [],
      finishReason: "stop",
      usage,
    };
    expect(parseCanonicalOutputEvent({ ...event, codeReferences })).toMatchObject({
      codeReferences,
    });
    expect(parseCanonicalCompletion({ ...completion, codeReferences })).toMatchObject({
      codeReferences,
    });
    expect(
      parseCanonicalOutputEvent({ ...event, codeReferences: [{}], hidden: true }),
    ).toBeUndefined();
    expect(
      parseCanonicalOutputEvent({ ...event, codeReferences: [{ hidden: true }] }),
    ).toBeUndefined();
    expect(
      parseCanonicalCompletion({ ...completion, codeReferences: [{ hidden: true }] }),
    ).toBeUndefined();
  });
});
