import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
const first: SdkStreamEvent = { reasoningContentEvent: { text: "", signature: "fixture-opus-a" } };
const second: SdkStreamEvent = { reasoningContentEvent: { signature: "fixture-opus-b" } };
const text: SdkStreamEvent = { assistantResponseEvent: { content: "OPUS_PREFIX_OK" } };
const request = {
  model,
  messages: [{ role: "user", content: "Synthetic Opus prefix fixture." }],
  thinking: { type: "adaptive", display: "omitted" },
  output_config: { effort: "max" },
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

function fixture(
  events: readonly SdkStreamEvent[],
  format: "database-v1" | "portable-v2" = "portable-v2",
) {
  const config = ConfigSchema.parse({
    api_keys: [MESSAGES_FIXTURE_KEY],
    reasoning_replay_keys: [`fixture:${Buffer.alloc(32, 13).toString("base64url")}`],
    reasoning_replay_token_format: format,
  });
  const database = new AccountsDatabase(":memory:");
  databases.push(database);
  const store = new ReasoningReplayStore(database, config);
  return {
    ...messagesFixture(events, {
      config: {
        reasoning_replay_keys: config.reasoning_replay_keys,
        reasoning_replay_token_format: format,
      },
      dependencies: { reasoningReplayStore: store, affinityStore: database },
    }),
    database,
    store,
  };
}

describe("Opus 5.5 bounded omitted reasoning prefix", () => {
  for (const stream of [false, true]) {
    for (const format of ["database-v1", "portable-v2"] as const) {
      for (const explicit of [false, true]) {
        test(`omits the complete empty conflict without replay capture (${stream}/${format}/${explicit})`, async () => {
          const f = fixture([first, second, text], format);
          const capture = spyOn(f.store, "store");
          const insert = spyOn(f.database, "insertReasoningReplay");
          const lineage = spyOn(f.database, "recordOutputLineage");
          try {
            const response = await f.request({
              ...request,
              stream,
              thinking: { type: "adaptive", ...(explicit ? { display: "omitted" } : {}) },
            });
            const body = await response.text();
            expect(response.status).toBe(200);
            expect(response.headers.get("x-kiro-reasoning-replay-mode")).toBe("conflict-omitted");
            expect(body.split("OPUS_PREFIX_OK")).toHaveLength(2);
            for (const secret of [
              "fixture-opus-a",
              "fixture-opus-b",
              "kr1_",
              "kr2_",
              '"thinking"',
            ]) {
              expect(body).not.toContain(secret);
              expect(JSON.stringify(audit.events())).not.toContain(secret);
            }
            expect(capture).not.toHaveBeenCalled();
            expect(insert).not.toHaveBeenCalled();
            expect(lineage).toHaveBeenCalledTimes(1);
            expect(f.inputs).toHaveLength(1);
            expect(f.inputs[0]?.additionalModelRequestFields).toMatchObject({
              thinking: { type: "adaptive", display: "omitted" },
              output_config: { effort: "max" },
            });
            expect(f.state.iteratorClosed).toBe(1);
            if (stream) {
              const events = messagesSseEvents(body);
              expect(events.filter((event) => event.type === "message_start")).toHaveLength(1);
              expect(events.filter((event) => event.type === "message_stop")).toHaveLength(1);
              expect(events.some((event) => event.type === "error")).toBe(false);
            }
            const omitted = audit.events("anthropic_output_reasoning_conflict_omitted");
            expect(omitted).toHaveLength(1);
            expect(omitted[0]).toMatchObject({
              model,
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
          } finally {
            capture.mockRestore();
            insert.mockRestore();
            lineage.mockRestore();
          }
        });
      }
    }

    test(`preserves the tool call and its next-turn result (${stream})`, async () => {
      const tool = {
        name: "fixture_tool",
        description: "Return the synthetic fixture value.",
        input_schema: { type: "object", properties: { value: { type: "string" } } },
      };
      const f = fixture([
        first,
        second,
        {
          toolUseEvent: {
            name: tool.name,
            toolUseId: "fixture-opus-call",
            input: '{"value":"42"}',
            stop: true,
          },
        },
      ]);
      const response = await f.request({ ...request, stream, tools: [tool] });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get("x-kiro-reasoning-replay-mode")).toBe("conflict-omitted");
      expect(body).not.toContain("thinking");
      const content = stream
        ? [{ type: "tool_use", id: "fixture-opus-call", name: tool.name, input: { value: "42" } }]
        : JSON.parse(body).content;
      expect(content).toEqual([
        { type: "tool_use", id: "fixture-opus-call", name: tool.name, input: { value: "42" } },
      ]);
      if (stream) {
        const events = messagesSseEvents(body);
        const args = events
          .flatMap((event) => {
            const delta = event.delta as { type?: string; partial_json?: string } | undefined;
            return delta?.type === "input_json_delta" ? [delta.partial_json ?? ""] : [];
          })
          .join("");
        expect(JSON.parse(args)).toEqual({ value: "42" });
        expect(events.some((event) => event.type === "error")).toBe(false);
      }
      const next = fixture([text]);
      const continued = await next.request({
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
      expect(continued.status).toBe(200);
      expect(await continued.text()).toContain("OPUS_PREFIX_OK");
      expect(JSON.stringify(next.inputs)).not.toContain("reasoningContent");
      expect(next.inputs[0]?.additionalModelRequestFields).toMatchObject({
        output_config: { effort: "max" },
      });
      expect(
        next.inputs[0]?.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
          ?.toolResults,
      ).toEqual([{ toolUseId: "fixture-opus-call", content: [{ text: "42" }], status: "success" }]);
      expect(f.inputs).toHaveLength(1);
      expect(next.inputs).toHaveLength(1);
    });

    test(`preserves exact duplicate signatures and their replay token (${stream})`, async () => {
      const f = fixture([first, first, text]);
      const capture = spyOn(f.store, "store");
      try {
        const response = await f.request({ ...request, stream });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-kiro-reasoning-replay-mode")).toBeNull();
        expect(await response.text()).toContain("kr2_");
        expect(capture).toHaveBeenCalledTimes(1);
      } finally {
        capture.mockRestore();
      }
    });

    test.each([
      {
        name: "nonempty",
        events: [
          { reasoningContentEvent: { text: "fixture-private", signature: "fixture-opus-a" } },
          second,
        ],
      },
      {
        name: "redacted",
        events: [
          {
            reasoningContentEvent: {
              signature: "fixture-opus-a",
              redactedContent: new Uint8Array([1]),
            },
          },
          second,
        ],
      },
      {
        name: "empty-redacted",
        events: [
          {
            reasoningContentEvent: {
              signature: "fixture-opus-a",
              redactedContent: new Uint8Array(),
            },
          },
          second,
        ],
      },
      {
        name: "later-text",
        events: [first, second, { reasoningContentEvent: { text: "fixture-private" } }],
      },
      {
        name: "later-redacted",
        events: [
          first,
          second,
          { reasoningContentEvent: { redactedContent: new Uint8Array([1]) } },
        ],
      },
      {
        name: "mixed-boundary",
        events: [first, { ...second, assistantResponseEvent: { content: "MUST_NOT_ESCAPE" } }],
      },
      {
        name: "event-budget",
        events: [
          first,
          second,
          ...Array.from({ length: 127 }, () => ({
            contextUsageEvent: { contextUsagePercentage: 1 },
          })),
        ],
      },
      {
        name: "byte-budget",
        events: [{ reasoningContentEvent: { signature: "x".repeat(1 << 20) } }, second],
      },
    ])(`rejects unsafe prefix before publication (${stream}): $name`, async ({ events }) => {
      const f = fixture([...events, text]);
      const response = await f.request({ ...request, stream });
      const body = await response.text();
      expect(response.status).toBe(502);
      for (const hidden of [
        "OPUS_PREFIX_OK",
        "MUST_NOT_ESCAPE",
        "fixture-private",
        "message_start",
        "kr2_",
      ]) {
        expect(body).not.toContain(hidden);
      }
      expect(response.headers.get("x-kiro-reasoning-replay-mode")).toBeNull();
      expect(f.inputs).toHaveLength(1);
      expect(f.state.iteratorClosed).toBe(1);
      expect(f.state.aborted).toBe(1);
      expect(audit.events("anthropic_output_reasoning_conflict_omitted")).toHaveLength(0);
    });

    test(`rejects a conflicting prefix without assistant output (${stream})`, async () => {
      const f = fixture([first, second]);
      const response = await f.request({ ...request, stream });
      expect(response.status).toBe(502);
      expect(response.headers.get("x-kiro-reasoning-replay-mode")).toBeNull();
      expect(await response.text()).not.toContain("message_start");
      expect(f.inputs).toHaveLength(1);
      expect(f.state.aborted).toBe(1);
    });

    test(`rejects late reasoning after the omitted boundary (${stream})`, async () => {
      const f = fixture([
        first,
        second,
        text,
        { reasoningContentEvent: { signature: "fixture-late" } },
      ]);
      const response = await f.request({ ...request, stream });
      expect(response.status).toBe(stream ? 200 : 502);
      const body = await response.text();
      expect(body).not.toContain("fixture-late");
      expect(body).not.toContain("kr2_");
      if (stream) {
        expect(body).toContain("OPUS_PREFIX_OK");
        expect(body).toContain("event: error");
        expect(body).not.toContain("message_stop");
      }
      expect(f.inputs).toHaveLength(1);
      expect(f.state.iteratorClosed).toBe(1);
      expect(f.state.aborted).toBe(1);
    });
  }

  test("recognizes the max model alias without changing upstream effort", async () => {
    const f = fixture([first, second, text]);
    const response = await f.request({ ...request, model: `${model}-max` });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-kiro-reasoning-replay-mode")).toBe("conflict-omitted");
    expect(await response.text()).toContain("OPUS_PREFIX_OK");
    expect(f.inputs[0]?.additionalModelRequestFields).toMatchObject({
      output_config: { effort: "max" },
    });
    expect(audit.events("anthropic_output_reasoning_conflict_omitted")[0]?.model).toBe(model);
  });

  test("keeps other models outside the compatibility allowlist", async () => {
    const f = fixture([first, second, text]);
    const response = await f.request({ ...request, model: "claude-opus-5" });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("conflicting reasoning signatures");
    expect(audit.events("anthropic_output_reasoning_conflict_omitted")).toHaveLength(0);
  });

  test("keeps summarized signature conflicts fatal after dispatch", async () => {
    const f = fixture([first, second, text]);
    const response = await f.request({
      ...request,
      thinking: { type: "adaptive", display: "summarized" },
    });
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain("conflicting reasoning signatures");
    expect(body).not.toContain("OPUS_PREFIX_OK");
    expect(body).not.toContain("kr2_");
    expect(response.headers.get("x-kiro-reasoning-replay-mode")).toBeNull();
    expect(audit.events("anthropic_output_reasoning_conflict_omitted")).toHaveLength(0);
    expect(f.inputs).toHaveLength(1);
    expect(f.state.aborted).toBe(1);
    expect(f.state.iteratorClosed).toBe(1);
  });
});
