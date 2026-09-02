import { describe, expect, test } from "bun:test";
import {
  CANONICAL_OUTPUT_VERSION,
  parseCanonicalCompletion,
  parseCanonicalOutputEvent,
  parseCanonicalOutputEventLine,
} from "../src/protocol/output.js";

const validCompletion = {
  canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
  conversationId: "conversation-1",
  model: "claude-sonnet-5",
  createdAt: 1_700_000_000,
  text: "done",
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
} as const;

describe("canonical output boundary", () => {
  test("accepts a strict canonical completion", () => {
    expect(parseCanonicalCompletion(validCompletion)).toEqual(validCompletion);
    const withReasoningAndTool = {
      ...validCompletion,
      reasoning: {
        text: "reason",
        signature: "signature",
        redactedContent: "redacted",
        encryptedContent: "kr1_token",
      },
      toolCalls: [{ id: "call-1", name: "lookup", input: '{"q":"x"}' }],
      finishReason: "tool_calls",
    } as const;
    expect(parseCanonicalCompletion(withReasoningAndTool)).toEqual(withReasoningAndTool);
  });

  test("rejects unknown keys and inconsistent terminal state", () => {
    expect(parseCanonicalCompletion({ ...validCompletion, unexpected: true })).toBeUndefined();
    expect(
      parseCanonicalCompletion({
        ...validCompletion,
        finishReason: "tool_calls",
      }),
    ).toBeUndefined();
    expect(
      parseCanonicalCompletion({
        ...validCompletion,
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 6 },
      }),
    ).toBeUndefined();
    expect(parseCanonicalCompletion({ ...validCompletion, reasoning: "reason" })).toBeUndefined();
    expect(
      parseCanonicalCompletion({
        ...validCompletion,
        reasoning: { text: "" },
      }),
    ).toBeUndefined();
    expect(
      parseCanonicalCompletion({
        ...validCompletion,
        toolCalls: [{ id: "", name: "lookup", input: "{}" }],
        finishReason: "tool_calls",
      }),
    ).toBeUndefined();
  });

  test("accepts strict stream events", () => {
    expect(
      parseCanonicalOutputEvent({
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "started",
        conversationId: "conversation-1",
        model: "claude-sonnet-5",
        createdAt: 1_700_000_000,
      }),
    ).toEqual({
      canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
      type: "started",
      conversationId: "conversation-1",
      model: "claude-sonnet-5",
      createdAt: 1_700_000_000,
    });
    expect(
      parseCanonicalOutputEvent({
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "tool_call_delta",
        index: 0,
        id: "call-1",
        name: "lookup",
        arguments: '{"q":"x"}',
      }),
    ).toEqual({
      canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
      type: "tool_call_delta",
      index: 0,
      id: "call-1",
      name: "lookup",
      arguments: '{"q":"x"}',
    });
    expect(
      [
        { type: "reasoning_signature", signature: "signature" },
        { type: "reasoning_redacted", data: "redacted" },
        { type: "reasoning_encrypted", encryptedContent: "kr1_token" },
        {
          type: "completed",
          finishReason: "stop",
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        },
      ].map((event) =>
        parseCanonicalOutputEvent({
          canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
          ...event,
        }),
      ),
    ).toEqual([
      {
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "reasoning_signature",
        signature: "signature",
      },
      {
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "reasoning_redacted",
        data: "redacted",
      },
      {
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "reasoning_encrypted",
        encryptedContent: "kr1_token",
      },
      {
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "completed",
        finishReason: "stop",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      },
    ]);
  });

  test("rejects malformed, empty, fractional, and unknown events", () => {
    expect(parseCanonicalOutputEventLine("{")).toBeUndefined();
    expect(
      parseCanonicalOutputEvent({
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "text_delta",
        text: "",
      }),
    ).toBeUndefined();
    expect(
      parseCanonicalOutputEvent({
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "tool_call_delta",
        index: 0.5,
        arguments: "{}",
      }),
    ).toBeUndefined();
    expect(
      parseCanonicalOutputEvent({
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "started",
        conversationId: "",
        model: "claude-sonnet-5",
        createdAt: 1_700_000_000,
      }),
    ).toBeUndefined();
    expect(
      parseCanonicalOutputEvent({
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "reasoning_signature",
        signature: "",
      }),
    ).toBeUndefined();
    expect(
      parseCanonicalOutputEvent({
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "completed",
        finishReason: "length",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      }),
    ).toBeUndefined();
    expect(
      parseCanonicalOutputEvent({
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "unknown",
      }),
    ).toBeUndefined();
  });
});
