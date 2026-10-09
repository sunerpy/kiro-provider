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

const historicalText = "Synthetic historical signed summary.";
const historicalSignature = "fixture-history-native-signature";
const currentSignature = "fixture-current-native-signature";
const marker = "RECOVERY_CONTINUED";
const tool = {
  name: "fixture_policy_tool",
  description: "Return a synthetic integer.",
  input_schema: {
    type: "object",
    properties: { value: { type: "integer" } },
    required: ["value"],
    additionalProperties: false,
  },
};
const history = [
  { role: "user", content: "Synthetic earlier request." },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: historicalText, signature: historicalSignature },
      { type: "text", text: "Synthetic earlier answer." },
    ],
  },
  { role: "user", content: "Continue the synthetic task with a tool." },
];
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
  mode: "preserve" | "omitted",
  options: { unsafe?: boolean; stalled?: boolean; timeout?: number } = {},
) {
  const config = ConfigSchema.parse({
    api_keys: [MESSAGES_FIXTURE_KEY],
    anthropic_thinking_display_mode: mode,
    reasoning_replay_keys: [`fixture:${Buffer.alloc(32, 23).toString("base64url")}`],
    reasoning_replay_token_format: "portable-v2",
  });
  const database = new AccountsDatabase(":memory:");
  databases.push(database);
  const store = new ReasoningReplayStore(database, config);
  const f = messagesFixture([], {
    config: { ...config, request_timeout_ms: options.timeout ?? 2_000, stream_max_attempts: 3 },
    dependencies: { reasoningReplayStore: store, affinityStore: database },
    stream: (signal): AsyncIterable<SdkStreamEvent> =>
      (async function* () {
        try {
          const fields = f.inputs.at(-1)?.additionalModelRequestFields as
            | { thinking?: { display?: string } }
            | undefined;
          if (fields?.thinking?.display === "summarized" || options.unsafe) {
            // Real failures have many nonempty reasoning events before the
            // second signature. Preserve that shape instead of two lone frames.
            for (let i = 0; i < 150; i++) {
              yield { reasoningContentEvent: { text: "Synthetic summary fragment. " } };
            }
            yield { reasoningContentEvent: { signature: "fixture-conflict-first" } };
            yield {
              reasoningContentEvent: {
                text: "Synthetic later fragment.",
                signature: "fixture-conflict-second",
              },
            };
          } else {
            yield { reasoningContentEvent: { text: "", signature: currentSignature } };
          }
          if (options.stalled) {
            await new Promise<void>((_resolve, reject) => {
              if (signal.aborted) reject(signal.reason);
              else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          }
          if (f.inputs.length === 1) {
            yield {
              toolUseEvent: {
                name: tool.name,
                toolUseId: "fixture-policy-call",
                input: '{"value":',
                stop: false,
              },
            };
            yield {
              toolUseEvent: {
                name: tool.name,
                toolUseId: "fixture-policy-call",
                input: "42}",
                stop: true,
              },
            };
          } else {
            yield { assistantResponseEvent: { content: marker } };
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

function content(wire: string, stream: boolean): Array<Record<string, unknown>> {
  if (!stream) return JSON.parse(wire).content;
  const blocks: Array<Record<string, unknown>> = [];
  const argumentsByIndex = new Map<number, string>();
  for (const event of messagesSseEvents(wire)) {
    const index = event.index as number;
    if (event.type === "content_block_start") {
      blocks[index] = { ...(event.content_block as Record<string, unknown>) };
    } else if (event.type === "content_block_delta") {
      const block = blocks[index];
      const delta = event.delta as Record<string, unknown>;
      if (!block) throw new Error("Synthetic delta preceded its block");
      if (delta.type === "thinking_delta")
        block.thinking = `${block.thinking ?? ""}${delta.thinking}`;
      if (delta.type === "signature_delta")
        block.signature = `${block.signature ?? ""}${delta.signature}`;
      if (delta.type === "text_delta") block.text = `${block.text ?? ""}${delta.text}`;
      if (delta.type === "input_json_delta")
        argumentsByIndex.set(index, `${argumentsByIndex.get(index) ?? ""}${delta.partial_json}`);
    }
  }
  for (const [index, argumentsText] of argumentsByIndex) {
    const block = blocks[index];
    if (!block) throw new Error("Synthetic tool input preceded its block");
    block.input = JSON.parse(argumentsText);
  }
  return blocks;
}

async function cleanup(f: ReturnType<typeof fixture>, calls = 1): Promise<void> {
  const until = performance.now() + 1_000;
  while (audit.events("request_admission_released").length < calls && performance.now() < until)
    await Bun.sleep(5);
  expect(f.inputs).toHaveLength(calls);
  expect(f.state.iteratorClosed).toBe(calls);
  expect(audit.events("request_admission_released").at(-1)).toMatchObject({
    active_requests: 0,
    reserved_body_bytes: 0,
  });
}

describe("Anthropic thinking display recovery policy", () => {
  for (const model of ["claude-opus-5-5", "claude-fable-5-1"]) {
    for (const stream of [false, true]) {
      const body = {
        model,
        stream,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "max" },
        tools: [tool],
        messages: history,
      };

      test(`reproduces the long signed-history conflict under preserve (${model}/${stream})`, async () => {
        const f = fixture("preserve");
        const response = await f.request(body);
        expect(response.status).toBe(stream ? 200 : 502);
        const wire = await response.text();
        expect(wire).not.toContain(marker);
        expect(wire).not.toContain("message_stop");
        expect(wire).not.toContain("kr2_");
        expect(response.headers.get("x-kiro-thinking-display-mode")).toBeNull();
        expect(f.inputs[0]?.additionalModelRequestFields).toMatchObject({
          thinking: { display: "summarized" },
          output_config: { effort: "max" },
        });
        expect(JSON.stringify(f.inputs[0])).toContain(historicalSignature);
        const signatures = audit.events("sdk_reasoning_signature_observed");
        expect(signatures).toHaveLength(2);
        expect(signatures[0]).toMatchObject({
          raw_event_index: 151,
          signature_event_index: 1,
          signature_relation: "first",
          reasoning_chars: 150 * "Synthetic summary fragment. ".length,
          phase: "before-assistant",
        });
        expect(signatures[1]).toMatchObject({
          raw_event_index: 152,
          signature_event_index: 2,
          signature_relation: "distinct",
          event_reasoning_chars: "Synthetic later fragment.".length,
        });
        for (const value of [
          historicalSignature,
          "fixture-conflict-first",
          "fixture-conflict-second",
          "Synthetic summary fragment",
        ])
          expect(JSON.stringify(audit.events())).not.toContain(value);
        await cleanup(f);
      });

      test(`recovers explicit summarized history and replays the next tool result (${model}/${stream})`, async () => {
        const f = fixture("omitted");
        const first = await f.request(body);
        expect(first.status).toBe(200);
        expect(first.headers.get("x-kiro-thinking-display-mode")).toBe("forced-omitted");
        const firstWire = await first.text();
        const blocks = content(firstWire, stream);
        expect(blocks).toHaveLength(2);
        expect(blocks[0]).toMatchObject({ type: "thinking", thinking: "" });
        expect(String(blocks[0]?.signature)).toStartWith("kr2_");
        expect(blocks[1]).toEqual({
          type: "tool_use",
          id: "fixture-policy-call",
          name: tool.name,
          input: { value: 42 },
        });
        expect(firstWire).not.toContain(currentSignature);
        expect(firstWire).not.toContain("Synthetic summary fragment");
        const second = await f.request({
          ...body,
          tools: [],
          messages: [
            ...history,
            { role: "assistant", content: blocks },
            {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "fixture-policy-call", content: "42" }],
            },
          ],
        });
        expect(second.status).toBe(200);
        expect(second.headers.get("x-kiro-thinking-display-mode")).toBe("forced-omitted");
        const secondWire = await second.text();
        expect(secondWire).toContain(marker);
        expect(secondWire).not.toContain("event: error");
        for (const input of f.inputs) {
          expect(input.additionalModelRequestFields).toMatchObject({
            thinking: { type: "adaptive", display: "omitted" },
            output_config: { effort: "max" },
          });
          expect(JSON.stringify(input)).toContain(historicalText);
          expect(JSON.stringify(input)).toContain(historicalSignature);
        }
        const sdkHistory = JSON.stringify(f.inputs[1]?.conversationState?.history);
        expect(sdkHistory).toContain(currentSignature);
        expect(sdkHistory).not.toContain("kr2_");
        expect(
          f.inputs[1]?.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
            ?.toolResults,
        ).toEqual([
          { toolUseId: "fixture-policy-call", content: [{ text: "42" }], status: "success" },
        ]);
        if (stream)
          expect(
            messagesSseEvents(secondWire).filter((event) => event.type === "message_stop"),
          ).toHaveLength(1);
        expect(audit.events("anthropic_thinking_display_overridden")).toHaveLength(2);
        expect(audit.events("anthropic_thinking_display_overridden")[0]).toMatchObject({
          requested_display: "summarized",
          effective_display: "omitted",
        });
        for (const privateValue of [
          historicalText,
          historicalSignature,
          currentSignature,
          tool.name,
        ])
          expect(JSON.stringify(audit.events())).not.toContain(privateValue);
        await cleanup(f, 2);
      });

      test(`still rejects unsafe nonempty conflicts under recovery (${model}/${stream})`, async () => {
        const f = fixture("omitted", { unsafe: true });
        const response = await f.request(body);
        expect(response.status).toBe(502);
        expect(response.headers.get("x-kiro-thinking-display-mode")).toBe("forced-omitted");
        const wire = await response.text();
        expect(wire).not.toContain("message_start");
        expect(wire).not.toContain("kr2_");
        expect(audit.events("anthropic_output_reasoning_conflict_omitted")).toHaveLength(0);
        await cleanup(f);
      });
    }
  }

  test("validates authentication, unsupported displays, models and history before overriding", async () => {
    const f = fixture("omitted");
    const body = {
      model: "claude-opus-5-5",
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "max" },
      messages: history,
    };
    const unauthenticated = await f.request(body, "/v1/messages", { key: "fixture-invalid-key" });
    expect(unauthenticated.status).toBe(401);
    await unauthenticated.text();
    for (const invalid of [
      { ...body, model: "claude-opus-5" },
      { ...body, thinking: { type: "adaptive", display: "updates" } },
      { ...body, thinking: { type: "disabled", display: "summarized" } },
      {
        ...body,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "first", signature: "a" },
              { type: "thinking", thinking: "second", signature: "b" },
            ],
          },
          { role: "user", content: "Synthetic continuation." },
        ],
      },
    ]) {
      const response = await f.request(invalid);
      expect(response.status).toBe(400);
      await response.text();
      expect(response.headers.get("x-kiro-thinking-display-mode")).toBeNull();
    }
    expect(f.inputs).toHaveLength(0);
    expect(audit.events("anthropic_thinking_display_overridden")).toHaveLength(0);
  });

  test.each([
    { first: "fixture-prefix", second: "fixture-prefix", relation: "duplicate", status: 200 },
    {
      first: "fixture-prefix",
      second: "fixture-prefix-extended",
      relation: "extends",
      status: 502,
    },
    {
      first: "fixture-prefix-extended",
      second: "fixture-prefix",
      relation: "shorter-prefix",
      status: 502,
    },
  ])(
    "diagnoses signature relations without treating a prefix as replay evidence: $relation",
    async ({ first, second, relation, status }) => {
      const f = messagesFixture([
        { reasoningContentEvent: { text: "Synthetic visible summary.", signature: first } },
        { reasoningContentEvent: { signature: second } },
        { assistantResponseEvent: { content: marker } },
      ]);
      const response = await f.request({
        model: "claude-opus-5-5",
        thinking: { type: "adaptive", display: "summarized" },
        messages: [{ role: "user", content: "Synthetic signature diagnostics." }],
      });
      expect(response.status).toBe(status);
      await response.text();
      expect(audit.events("sdk_reasoning_signature_observed")[1]).toMatchObject({
        signature_relation: relation,
        reasoning_chars_since_signature: 0,
        signature_bytes: second.length,
        previous_signature_bytes: first.length,
      });
      expect(JSON.stringify(audit.events())).not.toContain(first);
      expect(JSON.stringify(audit.events())).not.toContain(second);
      expect(audit.events("anthropic_output_reasoning_conflict_omitted")).toHaveLength(0);
    },
  );

  test("keeps the original display, max alias, and enabled budget as request provenance", async () => {
    const { adaptAnthropicMessagesRequest } = await import(
      "../src/server/anthropic/request-adapter.js"
    );
    const adapted = adaptAnthropicMessagesRequest(
      {
        model: "claude-opus-5-5-max",
        thinking: { type: "enabled", display: "summarized", budget_tokens: 8192 },
        output_config: { effort: "max" },
        messages: history,
      },
      { thinkingDisplayMode: "omitted" },
      "v3-auto",
    );
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) throw new Error("Synthetic request was rejected");
    expect(adapted.value.source.thinking).toEqual({
      type: "enabled",
      display: "summarized",
      budget_tokens: 8192,
    });
    expect(adapted.value.body.thinking).toEqual({
      enabled: true,
      display: "omitted",
      budgetTokens: 8192,
    });
    expect(adapted.value.body.reasoningEffort).toBe("max");
    expect(adapted.value.body.model).toBe("claude-opus-5-5-max");
    expect(adapted.value.body.includeEncryptedReasoning).toBe(true);
    expect(adapted.value.body.reasoningReplays).toHaveLength(1);
  });

  for (const stream of [false, true]) {
    for (const reason of ["cancel", "timeout"]) {
      test(`releases an accepted recovery request on ${reason} (${stream})`, async () => {
        const f = fixture("omitted", { stalled: true, timeout: reason === "timeout" ? 40 : 2_000 });
        const controller = new AbortController();
        const pending = f.request(
          {
            model: "claude-opus-5-5",
            stream,
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort: "max" },
            messages: history,
          },
          "/v1/messages",
          { signal: controller.signal },
        );
        if (reason === "cancel") {
          const until = performance.now() + 1_000;
          while (f.inputs.length === 0 && performance.now() < until) await Bun.sleep(5);
          expect(f.inputs).toHaveLength(1);
          controller.abort();
        }
        const response = await pending;
        expect(response.status).toBe(reason === "cancel" ? 499 : 504);
        await response.text();
        expect(f.state.aborted).toBe(1);
        await cleanup(f);
      });
    }
  }
});
