import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigSchema } from "../src/config/schema.js";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
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
