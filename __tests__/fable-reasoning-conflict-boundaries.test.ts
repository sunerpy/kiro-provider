import { describe, expect, test } from "bun:test";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import {
  CANONICAL_OUTPUT_STREAM_CONTENT_TYPE,
  CANONICAL_OUTPUT_VERSION,
  type CanonicalCompletion,
} from "../src/protocol/output.js";
import {
  anthropicMessageResponse,
  anthropicSseAdapter,
} from "../src/server/anthropic/response-adapter.js";
import { FABLE_MODEL, messagesFixture } from "./messages-regression-helpers.js";

const request = {
  messages: [{ role: "user", content: "Boundary fixture." }],
  thinking: { type: "adaptive" },
};
const first: SdkStreamEvent = { reasoningContentEvent: { signature: "fixture-a" } };
const second: SdkStreamEvent = { reasoningContentEvent: { signature: "fixture-b" } };
const text: SdkStreamEvent = { assistantResponseEvent: { content: "BOUNDARY_OK" } };

describe("Fable reasoning prefix boundaries", () => {
  test("treats SDK optional undefined fields as absent, without accepting empty redacted bytes", async () => {
    const fixture = messagesFixture([
      {
        reasoningContentEvent: {
          signature: "fixture-a",
          text: undefined,
          redactedContent: undefined,
        },
      },
      {
        reasoningContentEvent: {
          signature: "fixture-b",
          text: undefined,
          redactedContent: undefined,
        },
      },
      text,
    ]);
    const response = await fixture.request({ ...request, stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-kiro-reasoning-replay-mode")).toBe("conflict-omitted");
    expect(await response.text()).toContain("BOUNDARY_OK");
  });
  test("accepts exactly 128 prefix events without changing the boundary text", async () => {
    const metadata = Array.from({ length: 126 }, () => ({
      contextUsageEvent: { contextUsagePercentage: 1 },
    }));
    const fixture = messagesFixture([first, ...metadata, second, text]);
    const response = await fixture.request({ ...request, stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-kiro-reasoning-replay-mode")).toBe("conflict-omitted");
    const output = await response.text();
    expect(output.split("BOUNDARY_OK")).toHaveLength(2);
  });

  test.each([0, 1])("uses a UTF-8 byte budget at the exact limit plus %s", async (extra) => {
    const envelopeBytes = Buffer.byteLength(
      JSON.stringify(first) + JSON.stringify({ reasoningContentEvent: { signature: "" } }),
    );
    const remaining = (1 << 20) - envelopeBytes;
    const signature = "字".repeat(Math.floor(remaining / 3)) + "x".repeat((remaining % 3) + extra);
    const fixture = messagesFixture([first, { reasoningContentEvent: { signature } }, text]);
    const response = await fixture.request({ ...request, stream: true });
    expect(response.status).toBe(extra === 0 ? 200 : 502);
    const output = await response.text();
    expect(output.includes("BOUNDARY_OK")).toBe(extra === 0);
    expect(output).not.toContain("字");
    expect(fixture.inputs).toHaveLength(1);
  });

  test("isolates omission decisions across simultaneous requests", async () => {
    let index = 0;
    const fixture = messagesFixture([], {
      stream: () => {
        const events = index++ === 0 ? [first, second, text] : [first, text];
        return (async function* () {
          yield* events;
          yield {
            metadataEvent: { tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
          };
        })();
      },
    });
    const responses = await Promise.all([
      fixture.request({ ...request, stream: true }),
      fixture.request({ ...request, stream: true }),
    ]);
    const outputs = await Promise.all(responses.map((response) => response.text()));
    expect(
      responses.map((response) => response.headers.get("x-kiro-reasoning-replay-mode")),
    ).toEqual(["conflict-omitted", null]);
    expect(outputs[0]).not.toContain("fixture-a");
    expect(outputs[1]).toContain("fixture-a");
  });

  test("keeps normal signed text intact even though it cannot use conflict omission", async () => {
    const fixture = messagesFixture([
      { reasoningContentEvent: { text: "visible fixture", signature: "fixture-native" } },
      text,
    ]);
    const response = await fixture.request({ ...request, stream: false });
    expect(response.status).toBe(200);
    const output = await response.text();
    expect(output).toContain("visible fixture");
    expect(output).toContain("fixture-native");
    expect(response.headers.get("x-kiro-reasoning-replay-mode")).toBeNull();
  });

  test.each([[], [first, second]].map((events) => ({ events })))(
    "does not turn an unwitnessed EOF into success: %j",
    async ({ events }) => {
      const fixture = messagesFixture([], {
        stream: () =>
          (async function* () {
            yield* events;
          })(),
      });
      const response = await fixture.request({ ...request, stream: false });
      expect(response.status).toBe(502);
      expect(fixture.inputs).toHaveLength(1);
    },
  );

  test("rejects a mixed boundary event before publication", async () => {
    const fixture = messagesFixture([
      first,
      { ...second, assistantResponseEvent: { content: "MUST_NOT_ESCAPE" } },
    ]);
    const response = await fixture.request({ ...request, stream: true });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("MUST_NOT_ESCAPE");
  });
});

describe("trusted omission output contract", () => {
  const completion: CanonicalCompletion = {
    canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
    conversationId: "fixture",
    model: FABLE_MODEL,
    createdAt: 1_700_000_000,
    text: "fixture",
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    reasoning: { text: "MUST_NOT_ESCAPE", signature: "fixture-signature" },
  };
  test("rejects contradictory non-stream output but allows an input-only marker", async () => {
    const bad = anthropicMessageResponse(completion, FABLE_MODEL, { outputReasoningOmitted: true });
    expect(bad.status).toBe(502);
    expect(await bad.text()).not.toContain("MUST_NOT_ESCAPE");
    const inputOnly = anthropicMessageResponse(completion, FABLE_MODEL, {
      reasoningReplayMode: "conflict-omitted",
    });
    expect(inputOnly.status).toBe(200);
    expect(await inputOnly.text()).toContain("MUST_NOT_ESCAPE");
  });
  test("rejects contradictory streaming output before exposing a reasoning block", async () => {
    const controller = new AbortController();
    let finalized = 0;
    const upstream = new Response(
      [
        {
          canonicalOutputVersion: 1,
          type: "started",
          model: FABLE_MODEL,
          conversationId: "fixture",
          createdAt: 1_700_000_000,
        },
        { canonicalOutputVersion: 1, type: "reasoning_delta", text: "MUST_NOT_ESCAPE" },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
      {
        headers: { "Content-Type": CANONICAL_OUTPUT_STREAM_CONTENT_TYPE },
      },
    );
    const response = anthropicSseAdapter(upstream, {
      model: FABLE_MODEL,
      inputTokens: 1,
      outputReasoningOmitted: true,
      signals: {
        combined: controller.signal,
        client: controller.signal,
        deadline: controller.signal,
      },
      finalize: () => finalized++,
    });
    const output = await response.text();
    expect(output).toContain("event: error");
    expect(output).not.toContain("MUST_NOT_ESCAPE");
    expect(output).not.toContain("event: message_stop");
    expect(finalized).toBe(1);
  });
});
