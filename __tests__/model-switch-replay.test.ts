import { describe, expect, test } from "bun:test";
import type { GenerateAssistantResponseCommandInput } from "@aws/codewhisperer-streaming-client";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import { createApp } from "../src/server/app.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import { mintV3ReplayFixture } from "./legacy-replay-token-helpers.js";
import { fidelityFixture } from "./responses-fidelity-helpers.js";

const source = "claude-opus-5-5-max";
const cases = [
  ["claude-opus-5-5", false],
  ["claude-opus-5-5-low", false],
  ["claude-opus-5-5-thinking", false],
  ["claude-opus-5", true],
  ["claude-fable-5-1", true],
  ["gpt-5.6-sol", true],
] as const;

async function responsesBody(response: Response, stream: boolean) {
  if (!stream) return response.json();
  const frames = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
  const completed = frames.filter((frame) => frame.type === "response.completed");
  expect(completed).toHaveLength(1);
  expect(frames.some((frame) => frame.type === "error" || frame.type === "response.failed")).toBe(
    false,
  );
  expect(frames.map((frame) => frame.sequence_number)).toEqual(frames.map((_, index) => index));
  return completed[0].response;
}

async function roundTrip(options: {
  target: string;
  stream?: boolean;
  mode?: "strict" | "compatible";
  tenant?: string;
  tamper?: boolean;
  sourceModel?: string;
  toolsRemoved?: boolean;
  legacyV3?: boolean;
  returnRemovedTool?: boolean;
}) {
  const audit = captureAuditEvents();
  const f = fidelityFixture({
    config: {
      api_keys: ["fixture-a", "fixture-b"],
      reasoning_replay_model_switch: options.mode ?? "compatible",
      reasoning_replay_keys: [`fixture:${Buffer.alloc(32, 9).toString("base64url")}`],
    },
  });
  const dispatched: GenerateAssistantResponseCommandInput[] = [];
  const replayStore = new ReasoningReplayStore(f.database, f.config);
  if (options.legacyV3)
    replayStore.store = (capture, context) =>
      capture.signature || capture.redactedContent
        ? mintV3ReplayFixture(capture, context, Buffer.alloc(32, 9))
        : undefined;
  const app = createApp(f.config, {
    accountManager: f.dependencies.accountManager,
    tokenRefresher: f.dependencies.tokenRefresher,
    affinityStore: f.database,
    responseStore: f.responseStore,
    reasoningReplayStore: replayStore,
    makeClient: () => ({
      async send(command) {
        dispatched.push(command.input);
        const first = dispatched.length === 1;
        return {
          generateAssistantResponseResponse: {
            async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
              if (first) {
                yield {
                  reasoningContentEvent: { text: "fixture opaque", signature: "fixture signature" },
                };
                yield { assistantResponseEvent: { content: "VISIBLE" } };
                yield {
                  toolUseEvent: {
                    toolUseId: "fixture-call",
                    name: "capture_fixture",
                    input: '{"value":41}',
                    stop: true,
                  },
                };
              } else if (options.returnRemovedTool)
                yield {
                  toolUseEvent: {
                    toolUseId: "new-call",
                    name: "capture_fixture",
                    input: '{"value":41}',
                    stop: true,
                  },
                };
              else yield { assistantResponseEvent: { content: "ACK:41" } };
              yield {
                metadataEvent: { tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
              };
            },
          },
        };
      },
    }),
  });
  const declaration = {
    type: "function",
    name: "capture_fixture",
    description: "Capture the fixture value",
    parameters: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] },
  };
  const initial = [{ role: "user", content: "Call capture_fixture with 41." }];
  const send = (model: string, input: unknown[], next = false) =>
    app(
      new Request("http://fixture/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${next ? (options.tenant ?? "fixture-a") : "fixture-a"}`,
        },
        body: JSON.stringify({
          model,
          store: false,
          stream: options.stream ?? false,
          reasoning: { effort: next ? "low" : "max" },
          include: ["reasoning.encrypted_content"],
          tools: next && options.toolsRemoved ? [] : [declaration],
          input,
        }),
      }),
    );
  try {
    const first = await send(options.sourceModel ?? source, initial);
    if (!first.ok) throw new Error(JSON.stringify(await first.json()));
    expect(first.status).toBe(200);
    const output = (await responsesBody(first, options.stream ?? false)).output;
    const reasoning = output.find((item: { type: string }) => item.type === "reasoning");
    expect(reasoning.encrypted_content).toStartWith("kr2_");
    const call = output.find((item: { type: string }) => item.type === "function_call");
    expect(call.name).toBe("capture_fixture");
    if (options.tamper)
      output.find((item: { type: string }) => item.type === "message").content[0].text = "CHANGED";
    const second = await send(
      options.target,
      [
        ...initial,
        ...output,
        { type: "function_call_output", call_id: call.call_id, output: "41" },
      ],
      true,
    );
    const header = second.headers.get("x-kiro-reasoning-model-replay-mode");
    const status = second.status;
    const body =
      status === 200 ? await responsesBody(second, options.stream ?? false) : await second.json();
    return {
      status,
      body,
      header,
      dispatched,
      events: audit.events("reasoning_replay_model_omitted"),
    };
  } finally {
    f.database.close();
    audit.restore();
  }
}

describe("Responses model switching with full encrypted reasoning and tool history", () => {
  for (const stream of [false, true])
    for (const target of ["claude-opus-5-5", "claude-opus-5-5-low", "gpt-5.6-sol"]) {
      test(`deployed v3 full-history token: target=${target}, stream=${stream}`, async () => {
        const result = await roundTrip({ target, stream, legacyV3: true });
        expect(result.status).toBe(200);
        expect(result.dispatched).toHaveLength(2);
        expect(result.body.output[0].content[0].text).toBe("ACK:41");
        expect(result.header).toBe(target === "gpt-5.6-sol" ? "incompatible-omitted" : null);
      });
    }
  for (const stream of [false, true]) {
    for (const [target, omitted] of cases) {
      test(`${source} -> ${target}, stream=${stream}`, async () => {
        const result = await roundTrip({ target, stream });
        expect(result.status).toBe(200);
        expect(result.dispatched).toHaveLength(2);
        expect(result.body.output[0].content[0].text).toBe("ACK:41");
        expect(result.header).toBe(omitted ? "incompatible-omitted" : null);
        const second = result.dispatched[1]?.conversationState;
        const history = second?.history ?? [];
        const assistant = history.find(
          (turn) => turn.assistantResponseMessage?.toolUses?.length,
        )?.assistantResponseMessage;
        expect(history.map((turn) => turn.assistantResponseMessage?.content)).toContain("VISIBLE");
        expect(assistant?.toolUses?.[0]).toMatchObject({
          toolUseId: "fixture-call",
          name: "capture_fixture",
          input: { value: 41 },
        });
        if (omitted) {
          expect(
            history.some((turn) => turn.assistantResponseMessage?.reasoningContent !== undefined),
          ).toBe(false);
          expect(result.events).toHaveLength(1);
          expect(Object.keys(result.events[0] ?? {}).sort()).toEqual(
            ["event", "level", "replay_count", "timestamp"].sort(),
          );
          expect(result.events[0]?.replay_count).toBe(1);
        } else
          expect(
            history.find((turn) => turn.assistantResponseMessage?.reasoningContent)
              ?.assistantResponseMessage?.reasoningContent,
          ).toEqual({ reasoningText: { text: "fixture opaque", signature: "fixture signature" } });
        expect(
          second?.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults?.[0],
        ).toMatchObject({ toolUseId: "fixture-call", content: [{ text: "41" }] });
      });
    }
    test(`base effort max -> low remains lossless, stream=${stream}`, async () => {
      expect(
        (await roundTrip({ sourceModel: "claude-opus-5-5", target: "claude-opus-5-5", stream }))
          .status,
      ).toBe(200);
    });
    test(`strict admits aliases but rejects a different wire model, stream=${stream}`, async () => {
      expect(
        (await roundTrip({ target: "claude-opus-5-5-low", stream, mode: "strict" })).status,
      ).toBe(200);
      const rejection = await roundTrip({ target: "gpt-5.6-sol", stream, mode: "strict" });
      expect(rejection.status).toBe(400);
      expect(rejection.body.error.code).toBe("reasoning_replay_context_mismatch");
      expect(rejection.dispatched).toHaveLength(1);
    });
  }
  for (const target of ["claude-opus-5-5-low", "gpt-5.6-sol"]) {
    for (const change of [{ tenant: "fixture-b" }, { tamper: true }]) {
      test(`${target}: rejects altered tenant/output before omission and dispatch ${JSON.stringify(change)}`, async () => {
        const result = await roundTrip({ target, ...change });
        expect(result.status).toBe(400);
        expect(result.body.error.code).toBe("reasoning_replay_context_mismatch");
        expect(result.dispatched).toHaveLength(1);
        expect(result.events).toHaveLength(0);
      });
    }
  }
  test("a model switch preserves historical calls when current declarations remove the tool", async () => {
    const result = await roundTrip({ target: "gpt-5.6-sol", toolsRemoved: true });
    expect(result.status).toBe(200);
    expect(
      result.dispatched[1]?.conversationState?.currentMessage?.userInputMessage
        ?.userInputMessageContext?.tools,
    ).toBeUndefined();
  });
  test("authenticated cross-model history never authorizes a removed tool for the new output", async () => {
    const result = await roundTrip({
      target: "gpt-5.6-sol",
      toolsRemoved: true,
      returnRemovedTool: true,
    });
    expect(result.status).toBe(502);
    expect(result.body.error.code).toBe("unknown_upstream_tool");
    expect(result.dispatched).toHaveLength(2);
  });
});
