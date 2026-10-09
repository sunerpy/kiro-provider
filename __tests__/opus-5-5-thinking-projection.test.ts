import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigSchema } from "../src/config/schema.js";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import { adaptAnthropicMessagesRequest } from "../src/server/anthropic/request-adapter.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import {
  MESSAGES_FIXTURE_KEY,
  messagesFixture,
  messagesSseEvents,
} from "./messages-regression-helpers.js";

const model = "claude-opus-5-5";
const signature = "fixture-opus-complete-signature";
const request = {
  model,
  messages: [{ role: "user", content: "Synthetic Opus thinking fixture." }],
  thinking: { type: "adaptive", display: "omitted" },
  output_config: { effort: "max" },
};
const tool = {
  name: "fixture_tool",
  description: "Return a synthetic value.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
};
const databases: AccountsDatabase[] = [];
let audit: ReturnType<typeof captureAuditEvents>;
beforeEach(() => {
  audit = captureAuditEvents();
});
afterEach(() => {
  audit.restore();
  for (const database of databases.splice(0)) database.close();
});

function fixture(toolTurn = false, conflicting = false) {
  const config = ConfigSchema.parse({
    api_keys: [MESSAGES_FIXTURE_KEY],
    reasoning_replay_keys: [`fixture:${Buffer.alloc(32, 11).toString("base64url")}`],
    reasoning_replay_token_format: "portable-v2",
  });
  const database = new AccountsDatabase(":memory:");
  databases.push(database);
  const store = new ReasoningReplayStore(database, config);
  const f = messagesFixture([], {
    config: {
      reasoning_replay_keys: config.reasoning_replay_keys,
      reasoning_replay_token_format: config.reasoning_replay_token_format,
    },
    dependencies: { reasoningReplayStore: store, affinityStore: database },
    stream: (): AsyncIterable<SdkStreamEvent> =>
      (async function* () {
        try {
          const fields = f.inputs.at(-1)?.additionalModelRequestFields as
            | { thinking?: { display?: string } }
            | undefined;
          // Synthetic upstream reproduces signed summary conflicts when the
          // requested omitted display is lost during ingress-to-SDK projection.
          if (fields?.thinking?.display !== "omitted" || conflicting) {
            yield { reasoningContentEvent: { text: "fixture first", signature: "fixture-first" } };
            yield {
              reasoningContentEvent: { text: "fixture second", signature: "fixture-second" },
            };
          } else {
            yield { reasoningContentEvent: { text: "", signature } };
          }
          if (toolTurn && f.inputs.length === 1) {
            yield {
              toolUseEvent: {
                name: tool.name,
                toolUseId: "fixture-opus-call",
                input: "{}",
                stop: true,
              },
            };
          } else {
            yield { assistantResponseEvent: { content: "OPUS_THINKING_OK" } };
          }
          yield {
            metadataEvent: { tokenUsage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 } },
          };
        } finally {
          f.state.iteratorClosed++;
        }
      })(),
  });
  return f;
}

const summary = "Synthetic Opus reasoning summary.";
const summarizedRequest = { ...request, thinking: { type: "adaptive", display: "summarized" } };

function summarizedFixture(
  options: {
    toolTurn?: boolean;
    events?: readonly SdkStreamEvent[];
    stalled?: boolean;
    requestTimeout?: number;
  } = {},
) {
  const f = messagesFixture([], {
    config: { request_timeout_ms: options.requestTimeout ?? 2_000, stream_max_attempts: 3 },
    stream: (signal): AsyncIterable<SdkStreamEvent> =>
      (async function* () {
        try {
          if (options.events) {
            yield* options.events;
          } else {
            yield { reasoningContentEvent: { text: summary, signature } };
            if (options.toolTurn && f.inputs.length === 1) {
              yield {
                toolUseEvent: {
                  name: tool.name,
                  toolUseId: "fixture-opus-call",
                  input: "{}",
                  stop: true,
                },
              };
            } else {
              yield { assistantResponseEvent: { content: "OPUS_SUMMARY_OK" } };
            }
          }
          if (options.stalled) {
            await new Promise<void>((_resolve, reject) => {
              if (signal.aborted) reject(signal.reason);
              else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          }
          yield {
            metadataEvent: { tokenUsage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 } },
          };
        } finally {
          f.state.iteratorClosed++;
        }
      })(),
  });
  return f;
}

function sseContent(body: string): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  const toolInputs = new Map<number, string>();
  for (const event of messagesSseEvents(body)) {
    const index = event.index as number;
    if (event.type === "content_block_start") {
      content[index] = { ...(event.content_block as Record<string, unknown>) };
    } else if (event.type === "content_block_delta") {
      const delta = event.delta as Record<string, unknown>;
      const block = content[index];
      if (!block) throw new Error("SSE delta preceded its content block");
      if (delta.type === "thinking_delta")
        block.thinking = `${block.thinking ?? ""}${delta.thinking}`;
      if (delta.type === "signature_delta")
        block.signature = `${block.signature ?? ""}${delta.signature}`;
      if (delta.type === "text_delta") block.text = `${block.text ?? ""}${delta.text}`;
      if (delta.type === "input_json_delta") {
        toolInputs.set(index, `${toolInputs.get(index) ?? ""}${delta.partial_json}`);
      }
    }
  }
  for (const [index, input] of toolInputs) {
    const block = content[index];
    if (!block) throw new Error("SSE tool input preceded its content block");
    block.input = JSON.parse(input);
  }
  return content;
}

async function waitForCleanup(f: ReturnType<typeof messagesFixture>): Promise<void> {
  const until = performance.now() + 1_000;
  while (
    (f.state.iteratorClosed === 0 || audit.events("request_admission_released").length === 0) &&
    performance.now() < until
  ) {
    await Bun.sleep(5);
  }
  expect(f.state.iteratorClosed).toBe(1);
  expect(f.state.aborted).toBe(1);
  expect(f.inputs).toHaveLength(1);
  expect(audit.events("request_admission_released").at(-1)).toMatchObject({
    active_requests: 0,
    reserved_body_bytes: 0,
  });
}

describe("Opus 5.5 thinking projection at max", () => {
  for (const stream of [false, true]) {
    test(`preserves explicit omitted display and opaque replay (stream=${stream})`, async () => {
      const f = fixture();
      const response = await f.request({ ...request, stream });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("OPUS_THINKING_OK");
      expect(body).toContain("kr2_");
      expect(body).not.toContain(signature);
      expect(body).not.toContain("fixture first");
      expect(response.headers.get("x-kiro-reasoning-replay-mode")).toBeNull();
      expect(f.inputs).toHaveLength(1);
      expect(f.inputs[0]?.additionalModelRequestFields).toMatchObject({
        thinking: { type: "adaptive", display: "omitted" },
        output_config: { effort: "max" },
      });
      if (stream) {
        const events = messagesSseEvents(body);
        expect(events.filter((event) => event.type === "message_stop")).toHaveLength(1);
        expect(events.some((event) => event.type === "error")).toBe(false);
      }
      expect(f.state.iteratorClosed).toBe(1);
    });

    test(`defaults adaptive display without changing max (stream=${stream})`, async () => {
      const f = fixture();
      const response = await f.request({ ...request, thinking: { type: "adaptive" }, stream });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("OPUS_THINKING_OK");
      expect(body).toContain(signature);
      expect(f.inputs[0]?.additionalModelRequestFields).toMatchObject({
        thinking: { type: "adaptive", display: "omitted" },
        output_config: { effort: "max" },
      });
    });

    test(`replays signed thinking and the tool result on the next turn (stream=${stream})`, async () => {
      const f = fixture(true);
      const first = await f.request({ ...request, tools: [tool], stream: false });
      expect(first.status).toBe(200);
      const { content } = (await first.json()) as { content: Array<Record<string, unknown>> };
      expect(content).toContainEqual({
        type: "tool_use",
        id: "fixture-opus-call",
        name: tool.name,
        input: {},
      });
      expect(content.find((block) => block.type === "thinking")?.signature).toStartWith("kr2_");
      const second = await f.request({
        ...request,
        stream,
        tools: [],
        messages: [
          ...request.messages,
          { role: "assistant", content },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "fixture-opus-call", content: "42" }],
          },
        ],
      });
      expect(second.status).toBe(200);
      const body = await second.text();
      expect(body).toContain("OPUS_THINKING_OK");
      expect(body).not.toContain("event: error");
      expect(f.inputs).toHaveLength(2);
      expect(f.inputs[1]?.additionalModelRequestFields).toMatchObject({
        thinking: { type: "adaptive", display: "omitted" },
        output_config: { effort: "max" },
      });
      expect(JSON.stringify(f.inputs[1])).toContain(signature);
      expect(JSON.stringify(f.inputs[1])).not.toContain("kr2_");
      expect(
        f.inputs[1]?.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
          ?.toolResults,
      ).toEqual([{ toolUseId: "fixture-opus-call", content: [{ text: "42" }], status: "success" }]);
      expect(f.state.iteratorClosed).toBe(2);
    });

    test(`still fails closed on conflicting nonempty reasoning (stream=${stream})`, async () => {
      const f = fixture(false, true);
      const response = await f.request({ ...request, stream });
      const body = await response.text();
      expect(response.status).toBe(502);
      expect(body).not.toContain("OPUS_THINKING_OK");
      expect(body).not.toContain("kr2_");
      expect(body).toContain("conflicting reasoning");
      expect(body).not.toContain("message_start");
      expect(body).not.toContain("fixture first");
      expect(body).not.toContain("fixture second");
      expect(f.inputs).toHaveLength(1);
      expect(f.state.iteratorClosed).toBe(1);
      expect(f.state.aborted).toBe(1);
      expect(audit.events("anthropic_output_reasoning_conflict_omitted")).toHaveLength(0);
    });
  }

  test("authenticates before dispatching the thinking request", async () => {
    const f = fixture();
    const response = await f.request(request, "/v1/messages", { key: "fixture-invalid-key" });
    expect(response.status).toBe(401);
    await response.text();
    expect(f.inputs).toHaveLength(0);
  });
});

describe("Opus 5.5 explicit summarized thinking", () => {
  for (const stream of [false, true]) {
    for (const effort of ["max", "xhigh"]) {
      test(`preserves summaries, signed tool history, and effort (${stream}/${effort})`, async () => {
        const f = summarizedFixture({ toolTurn: true });
        const body = { ...summarizedRequest, stream, output_config: { effort } };
        const first = await f.request({ ...body, tools: [tool] });
        expect(first.status).toBe(200);
        expect(first.headers.get("x-kiro-reasoning-replay-mode")).toBeNull();
        const firstBody = await first.text();
        const content = stream ? sseContent(firstBody) : JSON.parse(firstBody).content;
        expect(content).toEqual([
          { type: "thinking", thinking: summary, signature },
          { type: "tool_use", id: "fixture-opus-call", name: tool.name, input: {} },
        ]);
        expect(firstBody).not.toContain("kr2_");
        const second = await f.request({
          ...body,
          tools: [],
          messages: [
            ...request.messages,
            { role: "assistant", content },
            {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "fixture-opus-call", content: "42" }],
            },
          ],
        });
        expect(second.status).toBe(200);
        const secondBody = await second.text();
        expect(secondBody).toContain("OPUS_SUMMARY_OK");
        expect(secondBody).toContain(summary);
        expect(secondBody).not.toContain("event: error");
        expect(f.inputs).toHaveLength(2);
        for (const input of f.inputs) {
          expect(input.additionalModelRequestFields).toMatchObject({
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort },
          });
        }
        expect(JSON.stringify(f.inputs[1])).toContain(summary);
        expect(JSON.stringify(f.inputs[1])).toContain(signature);
        expect(
          f.inputs[1]?.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
            ?.toolResults,
        ).toEqual([
          { toolUseId: "fixture-opus-call", content: [{ text: "42" }], status: "success" },
        ]);
        if (stream) {
          const events = messagesSseEvents(secondBody);
          expect(events[0]?.type).toBe("message_start");
          expect(events.at(-1)?.type).toBe("message_stop");
          expect(events.filter((event) => event.type === "message_stop")).toHaveLength(1);
          expect(events.filter((event) => event.type === "message_delta")).toHaveLength(1);
          expect(events.find((event) => event.type === "message_delta")?.usage).toMatchObject({
            output_tokens: 7,
          });
        } else {
          expect(JSON.parse(secondBody).usage).toMatchObject({
            input_tokens: 12,
            output_tokens: 7,
          });
        }
        expect(f.state.iteratorClosed).toBe(2);
        expect(audit.events("anthropic_output_reasoning_conflict_omitted")).toHaveLength(0);
        expect(JSON.stringify(audit.events())).not.toContain(summary);
        expect(JSON.stringify(audit.events())).not.toContain(signature);
      });
    }

    test(`still authenticates before dispatch (stream=${stream})`, async () => {
      const f = summarizedFixture();
      const response = await f.request({ ...summarizedRequest, stream }, "/v1/messages", {
        key: "fixture-invalid-key",
      });
      expect(response.status).toBe(401);
      await response.text();
      expect(f.inputs).toHaveLength(0);
    });

    for (const thinkingText of ["", "Synthetic conflicting summary."]) {
      test(`rejects summarized signature conflicts without omission or retry (${stream}/${thinkingText.length})`, async () => {
        const f = summarizedFixture({
          events: [
            { reasoningContentEvent: { text: thinkingText, signature: "fixture-summary-a" } },
            { reasoningContentEvent: { text: thinkingText, signature: "fixture-summary-b" } },
            { assistantResponseEvent: { content: "MUST_NOT_ESCAPE" } },
          ],
        });
        const response = await f.request({ ...summarizedRequest, stream });
        expect(response.status).toBe(stream ? 200 : 502);
        const body = await response.text();
        expect(body).toContain(
          stream
            ? "Upstream returned invalid reasoning metadata"
            : "conflicting reasoning signatures",
        );
        expect(body).not.toContain("MUST_NOT_ESCAPE");
        expect(body).not.toContain("kr2_");
        expect(body).not.toContain("message_stop");
        if (stream) expect(body).toContain("event: error");
        expect(response.headers.get("x-kiro-reasoning-replay-mode")).toBeNull();
        expect(audit.events("anthropic_output_reasoning_conflict_omitted")).toHaveLength(0);
        await waitForCleanup(f);
      });
    }

    test(`cancels an accepted summarized generation and releases admission (stream=${stream})`, async () => {
      const f = summarizedFixture({ stalled: true });
      const controller = new AbortController();
      const pending = f.request({ ...summarizedRequest, stream }, "/v1/messages", {
        signal: controller.signal,
      });
      const until = performance.now() + 1_000;
      while (f.inputs.length === 0 && performance.now() < until) await Bun.sleep(5);
      expect(f.inputs).toHaveLength(1);
      if (stream) {
        const response = await pending;
        expect(response.status).toBe(200);
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Summarized SSE response has no body");
        expect((await reader.read()).done).toBe(false);
        await reader.cancel("fixture cancellation");
      } else {
        controller.abort();
        const response = await pending;
        expect(response.status).toBe(499);
        await response.text();
      }
      await waitForCleanup(f);
    });

    test(`times out an accepted summarized generation without retry (stream=${stream})`, async () => {
      const f = summarizedFixture({ stalled: true, requestTimeout: 50 });
      const response = await f.request({ ...summarizedRequest, stream });
      expect(response.status).toBe(stream ? 200 : 504);
      const body = await response.text();
      if (stream) {
        expect(body).toContain("event: error");
        expect(body).not.toContain("message_stop");
      }
      await waitForCleanup(f);
    });
  }

  test("recognizes the max alias while preserving an explicit summarized display", async () => {
    const f = summarizedFixture();
    const response = await f.request({ ...summarizedRequest, model: `${model}-max` });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(summary);
    expect(f.inputs[0]?.additionalModelRequestFields).toMatchObject({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "max" },
    });
  });

  test("preserves enabled thinking and an explicit xhigh effort with summaries", async () => {
    const f = summarizedFixture();
    const response = await f.request({
      ...summarizedRequest,
      thinking: { type: "enabled", budget_tokens: 8192, display: "summarized" },
      output_config: { effort: "xhigh" },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(summary);
    expect(f.inputs[0]?.additionalModelRequestFields).toMatchObject({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "xhigh" },
    });
  });

  test.each([
    { model: "claude-opus-5", display: "summarized" },
    { model: "claude-sonnet-5", display: "summarized" },
    { model: "gpt-5.6-sol", display: "summarized" },
    { model, display: "updates" },
  ])("keeps unsupported models and displays fail closed: %j", async (policy) => {
    const f = summarizedFixture();
    for (const stream of [false, true]) {
      const response = await f.app(
        new Request("http://fixture/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": MESSAGES_FIXTURE_KEY,
            "x-kiro-output-token-limit-mode": "advisory",
          },
          body: JSON.stringify({
            ...summarizedRequest,
            stream,
            model: policy.model,
            max_tokens: 1024,
            thinking: { type: "adaptive", display: policy.display },
          }),
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("capability_rejected:thinking.display");
    }
    expect(f.inputs).toHaveLength(0);
  });

  test("keeps unknown model display validation typed instead of throwing", () => {
    expect(
      adaptAnthropicMessagesRequest({ ...summarizedRequest, model: "fixture-unknown-model" }),
    ).toMatchObject({
      ok: false,
      code: "unsupported_reasoning_display",
      param: "thinking.display",
    });
  });
});
