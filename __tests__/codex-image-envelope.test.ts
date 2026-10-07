import { describe, expect, test } from "bun:test";
import { runChatCompletion } from "../src/core/pipeline.js";
import { isCodexImageEnvelope } from "../src/protocol/codex-image-envelope.js";
import { fidelityFixture } from "./responses-fidelity-helpers.js";
import { makeSdkResponse } from "./sdk-stream-test-helpers.js";

const OPEN = '<image name=[Image #1] path="/fixture/screenshot.png">';
const CLOSE = "</image>";
const IMAGE = {
  type: "input_image" as const,
  image_url: "data:image/png;base64,AQID",
  detail: "auto" as const,
};

function request(stream: boolean, content: readonly Record<string, unknown>[]) {
  return {
    model: "gpt-5.6-sol",
    input: [{ type: "message", role: "user", content }],
    stream,
    store: false,
    reasoning: { effort: "max" },
  };
}

function wireMessages(commandInput: unknown): {
  history?: Array<{
    userInputMessage?: {
      content?: string;
      images?: Array<{ source: { bytes: Uint8Array } }>;
    };
    assistantResponseMessage?: { content?: string };
  }>;
  currentMessage?: { userInputMessage?: { content?: string } };
} {
  return (commandInput as { conversationState?: unknown }).conversationState as ReturnType<
    typeof wireMessages
  >;
}

describe("Codex Responses image envelopes", () => {
  test("recognizes only complete Codex wrappers around every image", () => {
    expect(
      isCodexImageEnvelope([
        { type: "input_text", text: "before" },
        { type: "input_text", text: OPEN },
        IMAGE,
        { type: "input_text", text: CLOSE },
        { type: "input_text", text: '<image name=[Image #2] path="C:\\fixture\\two.png">' },
        IMAGE,
        { type: "input_text", text: CLOSE },
      ]),
    ).toBe(true);
    for (const parts of [
      [],
      [null],
      [{ type: "input_file" }],
      [{ type: "input_text", text: OPEN }, IMAGE],
      [{ type: "input_text", text: OPEN }, IMAGE, { type: "input_text", text: "after" }],
      [
        { type: "input_text", text: OPEN },
        IMAGE,
        { type: "input_text", text: CLOSE },
        { type: "input_text", text: CLOSE },
      ],
    ]) {
      expect(isCodexImageEnvelope(parts)).toBe(false);
    }
  });

  test("accepts the reproduced fifth input item and fourth content block", async () => {
    const fixture = fidelityFixture();
    let sends = 0;
    try {
      const response = await fixture.send(
        {
          ...request(false, []),
          input: [
            { type: "message", role: "developer", content: "POLICY_A" },
            { type: "message", role: "developer", content: "POLICY_B" },
            { type: "message", role: "developer", content: "POLICY_C" },
            { type: "message", role: "user", content: "CONTEXT" },
            {
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: "LOOK" },
                { type: "input_text", text: OPEN },
                IMAGE,
                { type: "input_text", text: CLOSE },
              ],
            },
          ],
        },
        {
          runPipeline: runChatCompletion,
          makeClient: () => ({
            async send() {
              sends += 1;
              return makeSdkResponse([{ assistantResponseEvent: { content: "OK" } }]);
            },
          }),
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("x-kiro-compatibility")).toContain("codex_image_envelope_split");
      await response.text();
      expect(sends).toBe(1);
    } finally {
      fixture.database.close();
    }
  });

  test.each([false, true])(
    "preserves the Codex text-image-text envelope as ordered Kiro user runs (stream=%s)",
    async (stream) => {
      const fixture = fidelityFixture();
      let commandInput: unknown;
      try {
        const response = await fixture.send(
          request(stream, [
            { type: "input_text", text: "LOOK" },
            { type: "input_text", text: OPEN },
            IMAGE,
            { type: "input_text", text: CLOSE },
          ]),
          {
            runPipeline: runChatCompletion,
            makeClient: () => ({
              async send(command) {
                commandInput = command.input;
                return makeSdkResponse([{ assistantResponseEvent: { content: "OK" } }]);
              },
            }),
          },
        );

        expect(response.status).toBe(200);
        expect(response.headers.get("x-kiro-transport")).toBe("stateless");
        expect(response.headers.get("x-kiro-compatibility")).toContain(
          "codex_image_envelope_split",
        );
        await response.text();

        const state = wireMessages(commandInput);
        expect(state.history).toHaveLength(2);
        expect(state.history?.[0]?.userInputMessage?.content).toBe(`LOOK${OPEN}`);
        expect(state.history?.[0]?.userInputMessage?.images).toBeUndefined();
        expect(state.history?.[1]?.userInputMessage?.content).toBe("");
        expect(state.history?.[1]?.userInputMessage?.images).toHaveLength(1);
        expect(
          Array.from(state.history?.[1]?.userInputMessage?.images?.[0]?.source.bytes ?? []),
        ).toEqual([1, 2, 3]);
        expect(state.currentMessage?.userInputMessage?.content).toBe(CLOSE);
      } finally {
        fixture.database.close();
      }
    },
  );

  test("preserves an enveloped image in history before the next user turn", async () => {
    const fixture = fidelityFixture();
    let commandInput: unknown;
    try {
      const response = await fixture.send(
        {
          ...request(false, []),
          input: [
            {
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: OPEN },
                IMAGE,
                { type: "input_text", text: CLOSE },
              ],
            },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "SEEN" }],
            },
            { type: "message", role: "user", content: "NEXT" },
          ],
        },
        {
          runPipeline: runChatCompletion,
          makeClient: () => ({
            async send(command) {
              commandInput = command.input;
              return makeSdkResponse([{ assistantResponseEvent: { content: "OK" } }]);
            },
          }),
        },
      );

      expect(response.status).toBe(200);
      await response.text();
      const state = wireMessages(commandInput);
      expect(state.history).toHaveLength(4);
      expect(state.history?.[0]?.userInputMessage?.content).toBe(OPEN);
      expect(state.history?.[1]?.userInputMessage?.images).toHaveLength(1);
      expect(state.history?.[2]?.userInputMessage?.content).toBe(CLOSE);
      expect(state.history?.[3]).toMatchObject({ assistantResponseMessage: { content: "SEEN" } });
      expect(state.currentMessage?.userInputMessage?.content).toBe("NEXT");
    } finally {
      fixture.database.close();
    }
  });

  test("keeps strict fidelity fail-closed before dispatch", async () => {
    const fixture = fidelityFixture({ config: { responses_fidelity_mode: "strict" } });
    let sends = 0;
    try {
      const response = await fixture.send(
        request(false, [
          { type: "input_text", text: OPEN },
          IMAGE,
          { type: "input_text", text: CLOSE },
        ]),
        {
          runPipeline: runChatCompletion,
          makeClient: () => ({
            async send() {
              sends += 1;
              return makeSdkResponse([{ assistantResponseEvent: { content: "unexpected" } }]);
            },
          }),
        },
      );

      expect(response.status).toBe(400);
      expect(response.headers.get("x-kiro-compatibility")).toContain("codex_image_envelope_split");
      expect(await response.json()).toMatchObject({
        error: {
          code: "unsupported_response_semantics",
          param: "input.0.content",
        },
      });
      expect(sends).toBe(0);
    } finally {
      fixture.database.close();
    }
  });

  test("does not broaden projection for arbitrary text-image-text input", async () => {
    const fixture = fidelityFixture();
    let sends = 0;
    try {
      const response = await fixture.send(
        request(false, [
          { type: "input_text", text: "before" },
          IMAGE,
          { type: "input_text", text: "after" },
        ]),
        {
          runPipeline: runChatCompletion,
          makeClient: () => ({
            async send() {
              sends += 1;
              return makeSdkResponse([{ assistantResponseEvent: { content: "unexpected" } }]);
            },
          }),
        },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          code: "unsupported_content_block_projection",
          param: "input.0.content.2.text",
        },
      });
      expect(sends).toBe(0);
    } finally {
      fixture.database.close();
    }
  });
});
