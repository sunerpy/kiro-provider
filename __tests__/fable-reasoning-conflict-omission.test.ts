import { describe, expect, spyOn, test } from "bun:test";
import { ConfigSchema } from "../src/config/schema.js";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import { FABLE_MODEL, messagesFixture, messagesSseEvents } from "./messages-regression-helpers.js";

const firstSignature = "synthetic-empty-signature-first";
const secondSignature = "synthetic-empty-signature-second";
const conflict: SdkStreamEvent[] = [
  { reasoningContentEvent: { text: "", signature: firstSignature } },
  { reasoningContentEvent: { signature: secondSignature } },
];
const tool = {
  name: "fixture_tool",
  description: "Return the synthetic fixture value.",
  input_schema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
};
const text: SdkStreamEvent = { assistantResponseEvent: { content: "FABLE_OK" } };
const call: SdkStreamEvent = {
  toolUseEvent: {
    name: tool.name,
    toolUseId: "fixture-preserved-call",
    input: '{"value":"中文\\\\quote"}',
    stop: true,
  },
};
const base = { messages: [{ role: "user", content: "Run the synthetic fixture." }] };

describe("Fable omitted reasoning conflict prefix", () => {
  for (const stream of [false, true]) {
    for (const format of ["database-v1", "portable-v2"] as const) {
      for (const explicit of [false, true]) {
        test(`omits every conflicting signature without capture (${stream}/${format}/${explicit})`, async () => {
          const config = ConfigSchema.parse({
            api_keys: ["fixture"],
            reasoning_replay_keys: [`fixture:${Buffer.alloc(32, 7).toString("base64url")}`],
            reasoning_replay_token_format: format,
          });
          const database = new AccountsDatabase(":memory:");
          const store = new ReasoningReplayStore(database, config);
          const capture = spyOn(store, "store");
          const insert = spyOn(database, "insertReasoningReplay");
          const lineage = spyOn(database, "recordOutputLineage");
          const audit = captureAuditEvents();
          try {
            const fixture = messagesFixture([...conflict, text], {
              config: {
                reasoning_replay_keys: config.reasoning_replay_keys,
                reasoning_replay_token_format: format,
              },
              dependencies: { reasoningReplayStore: store, affinityStore: database },
            });
            const response = await fixture.request({
              ...base,
              stream,
              thinking: { type: "adaptive", ...(explicit ? { display: "omitted" } : {}) },
            });
            expect(response.status).toBe(200);
            expect(response.headers.get("x-kiro-reasoning-replay-mode")).toBe("conflict-omitted");
            const body = await response.text();
            expect(body).toContain("FABLE_OK");
            for (const secret of [firstSignature, secondSignature, "kr1_", "kr2_", '"thinking"']) {
              expect(body).not.toContain(secret);
            }
            expect(capture).not.toHaveBeenCalled();
            expect(insert).not.toHaveBeenCalled();
            expect(lineage).toHaveBeenCalledTimes(1);
            expect(fixture.inputs).toHaveLength(1);
            expect(fixture.state.iteratorClosed).toBe(1);
            if (stream) {
              const events = messagesSseEvents(body);
              expect(events.filter((event) => event.type === "message_start")).toHaveLength(1);
              expect(events.filter((event) => event.type === "message_stop")).toHaveLength(1);
              expect(events.some((event) => event.type === "error")).toBe(false);
            }
            const omitted = audit.events("anthropic_output_reasoning_conflict_omitted");
            expect(omitted).toHaveLength(1);
            expect(omitted[0]).toMatchObject({
              model: FABLE_MODEL,
              direction: "output",
              reasoning_event_count: 2,
              prefix_event_count: 2,
            });
            expect(Object.keys(omitted[0] ?? {}).sort()).toEqual([
              "direction",
              "event",
              "level",
              "model",
              "prefix_bytes",
              "prefix_event_count",
              "reasoning_event_count",
              "timestamp",
            ]);
            const auditText = JSON.stringify(audit.events());
            expect(auditText).not.toContain(firstSignature);
            expect(auditText).not.toContain(secondSignature);
          } finally {
            audit.restore();
            capture.mockRestore();
            insert.mockRestore();
            lineage.mockRestore();
            database.close();
          }
        });
      }
    }
  }

  test.each([false, true])(
    "preserves the tool and its next-turn result (stream=%s)",
    async (stream) => {
      const first = messagesFixture([...conflict, call]);
      const response = await first.request({
        ...base,
        stream,
        tools: [tool],
        thinking: { type: "adaptive", display: "omitted" },
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain("thinking");
      expect(body).toContain("fixture-preserved-call");
      const content = stream
        ? [
            {
              type: "tool_use",
              id: "fixture-preserved-call",
              name: tool.name,
              input: { value: "中文\\quote" },
            },
          ]
        : JSON.parse(body).content;
      if (stream) {
        const events = messagesSseEvents(body);
        const deltas = events
          .flatMap((event) => {
            const delta = event.delta as { type?: string; partial_json?: string } | undefined;
            return delta?.type === "input_json_delta" ? [delta.partial_json ?? ""] : [];
          })
          .join("");
        expect(JSON.parse(deltas)).toEqual({ value: "中文\\quote" });
      } else {
        expect(content).toEqual([
          {
            type: "tool_use",
            id: "fixture-preserved-call",
            name: tool.name,
            input: { value: "中文\\quote" },
          },
        ]);
      }
      const second = messagesFixture([text]);
      const continued = await second.request({
        stream,
        tools: [],
        thinking: { type: "adaptive" },
        messages: [
          ...base.messages,
          { role: "assistant", content },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "fixture-preserved-call", content: "42" },
            ],
          },
        ],
      });
      expect(continued.status).toBe(200);
      expect(await continued.text()).toContain("FABLE_OK");
      expect(JSON.stringify(second.inputs)).not.toContain("reasoningContent");
      expect(
        second.inputs[0]?.conversationState?.currentMessage?.userInputMessage
          ?.userInputMessageContext?.toolResults,
      ).toEqual([
        { toolUseId: "fixture-preserved-call", content: [{ text: "42" }], status: "success" },
      ]);
    },
  );

  test.each([false, true])(
    "leaves identical duplicate signatures on the native path (stream=%s)",
    async (stream) => {
      const fixture = messagesFixture([
        conflict[0] as SdkStreamEvent,
        conflict[0] as SdkStreamEvent,
        text,
      ]);
      const response = await fixture.request({ ...base, stream, thinking: { type: "adaptive" } });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-kiro-reasoning-replay-mode")).toBeNull();
      expect(await response.text()).toContain(firstSignature);
    },
  );

  test.each([
    {
      name: "nonempty",
      events: [
        { reasoningContentEvent: { text: "private", signature: firstSignature } },
        conflict[1],
      ],
    },
    {
      name: "redacted",
      events: [
        {
          reasoningContentEvent: {
            signature: firstSignature,
            redactedContent: new Uint8Array([1]),
          },
        },
        conflict[1],
      ],
    },
    {
      name: "empty-redacted",
      events: [
        { reasoningContentEvent: { signature: firstSignature, redactedContent: new Uint8Array() } },
        conflict[1],
      ],
    },
    {
      name: "later-nonempty",
      events: [...conflict, { reasoningContentEvent: { text: "private" } }],
    },
    {
      name: "later-redacted",
      events: [...conflict, { reasoningContentEvent: { redactedContent: new Uint8Array([1]) } }],
    },
    { name: "missing-signature", events: [{ reasoningContentEvent: { text: "" } }, ...conflict] },
    {
      name: "event-limit",
      events: [
        ...Array.from({ length: 129 }, () => ({
          contextUsageEvent: { contextUsagePercentage: 1 },
        })),
      ],
    },
    {
      name: "byte-limit",
      events: [{ reasoningContentEvent: { signature: "字".repeat(1 << 19) } }],
    },
  ])("rejects an unsafe prefix before headers: $name", async ({ events }) => {
    for (const stream of [false, true]) {
      const fixture = messagesFixture([...(events as SdkStreamEvent[]), text]);
      const response = await fixture.request({
        ...base,
        stream,
        thinking: { type: "adaptive", display: "omitted" },
      });
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain("FABLE_OK");
      expect(fixture.inputs).toHaveLength(1);
      expect(fixture.state.aborted).toBe(1);
      expect(fixture.state.iteratorClosed).toBe(1);
    }
  });

  test.each([
    { model: "claude-sonnet-5", thinking: { type: "adaptive", display: "omitted" } },
    { model: FABLE_MODEL, thinking: { type: "adaptive", display: "summarized" } },
    { model: FABLE_MODEL, thinking: { type: "disabled" } },
    { model: FABLE_MODEL },
  ])("keeps other protocol/model policies strict: %j", async (policy) => {
    for (const stream of [false, true]) {
      const fixture = messagesFixture([...conflict, text]);
      const response = await fixture.request({ ...base, stream, ...policy });
      expect(response.status).toBe(stream ? 200 : 502);
      const body = await response.text();
      expect(body).not.toContain("FABLE_OK");
      if (stream) expect(body).toContain("event: error");
      expect(response.headers.get("x-kiro-reasoning-replay-mode")).toBeNull();
      expect(fixture.inputs).toHaveLength(1);
    }
  });

  test.each([false, true])(
    "rejects late reasoning after an omitted prefix (stream=%s)",
    async (stream) => {
      const fixture = messagesFixture([
        ...conflict,
        text,
        { reasoningContentEvent: { signature: "synthetic-late" } },
      ]);
      const response = await fixture.request({ ...base, stream, thinking: { type: "adaptive" } });
      expect(response.status).toBe(stream ? 200 : 502);
      const body = await response.text();
      if (stream) {
        expect(body).toContain("FABLE_OK");
        expect(body).toContain("event: error");
        expect(messagesSseEvents(body).some((event) => event.type === "message_stop")).toBe(false);
      }
      expect(body).not.toContain("synthetic-late");
      expect(fixture.inputs).toHaveLength(1);
    },
  );
});
