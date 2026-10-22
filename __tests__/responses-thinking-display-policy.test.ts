import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigSchema } from "../src/config/schema.js";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import { createApp } from "../src/server/app.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import {
  MESSAGES_FIXTURE_KEY,
  messagesFixture,
  messagesSseEvents,
} from "./messages-regression-helpers.js";
import { fidelityFixture } from "./responses-fidelity-helpers.js";

const TEXT = "Synthetic upstream reasoning metadata";
const SIGNATURE = "synthetic-thinking-display-signature";
const TOOL = {
  type: "function",
  name: "lookup",
  description: "Read a synthetic value",
  parameters: { type: "object", properties: {} },
};

function requestFields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
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
  options: {
    conflict?: boolean;
    broken?: boolean;
    late?: boolean;
    strict?: boolean;
    mixed?: boolean;
    signatureOnly?: boolean;
  } = {},
) {
  const config = ConfigSchema.parse({
    api_keys: [MESSAGES_FIXTURE_KEY],
    protocol_projection_mode: "safe",
    responses_fidelity_mode: options.strict ? "strict" : "compatible",
    reasoning_replay_keys: [`fixture:${Buffer.alloc(32, 29).toString("base64url")}`],
    stream_max_attempts: 3,
    max_inflight_requests: 1,
    rate_limit_max_retries: 3,
    rate_limit_retry_delay_ms: 1,
  });
  const database = new AccountsDatabase(":memory:");
  databases.push(database);
  const store = new ReasoningReplayStore(database, config);
  const f = messagesFixture([], {
    config,
    dependencies: { reasoningReplayStore: store, affinityStore: database },
    stream: async function* (): AsyncGenerator<SdkStreamEvent> {
      if (options.late) yield { assistantResponseEvent: { content: "CONTINUED" } };
      yield {
        reasoningContentEvent: { text: options.signatureOnly ? "" : TEXT, signature: SIGNATURE },
      };
      if (options.conflict)
        yield { reasoningContentEvent: { signature: "synthetic-conflicting-signature" } };
      if (options.mixed)
        yield { reasoningContentEvent: { redactedContent: new Uint8Array([1, 2, 3]) } };
      if (options.broken) throw new Error("synthetic upstream transport failure");
      yield { reasoningContentEvent: { signature: SIGNATURE } };
      if (!options.late) {
        if (f.inputs.length === 1)
          yield {
            toolUseEvent: {
              toolUseId: "fixture_display_call",
              name: "lookup",
              input: "{}",
              stop: true,
            },
          };
        else yield { assistantResponseEvent: { content: "CONTINUED" } };
      }
      yield {
        metadataEvent: { tokenUsage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 } },
      };
    },
  });
  const apps = {
    preserve: createApp(
      { ...f.config, responses_thinking_display_mode: "preserve" },
      f.dependencies,
    ),
    omitted: createApp({ ...f.config, responses_thinking_display_mode: "omitted" }, f.dependencies),
  };
  return {
    ...f,
    send(
      mode: "preserve" | "omitted",
      input: unknown[] = [{ role: "user", content: "Read the synthetic value" }],
      stream = false,
      extra: Record<string, unknown> = {},
    ) {
      return apps[mode](
        new Request("http://fixture/v1/responses", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${MESSAGES_FIXTURE_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-opus-5-5",
            input,
            tools: [TOOL],
            store: false,
            stream,
            reasoning: { effort: "max", summary: "auto" },
            ...extra,
          }),
        }),
      );
    },
  };
}

async function output(response: Response, stream: boolean): Promise<Record<string, unknown>[]> {
  const wire = await response.text();
  expect(wire).not.toContain(SIGNATURE);
  if (!stream) return (JSON.parse(wire) as { output: Record<string, unknown>[] }).output;
  const events = messagesSseEvents(wire);
  expect(events.at(-1)?.type).toBe("response.completed");
  return (events.at(-1)?.response as { output: Record<string, unknown>[] }).output;
}

describe("Responses thinking display policy through authenticated ingress", () => {
  for (const model of ["claude-opus-5-5", "claude-fable-5-1"]) {
    test.each([false, true])(
      `${model} omitted preserves max, tokens, tools and prior signed history (stream=%s)`,
      async (stream) => {
        const f = fixture();
        const original = await f.send("preserve", undefined, false, { model });
        const originalOutput = await output(original, false);
        // Bun's asymmetric matcher mutates nested values; keep the real token
        // intact because this exact output is replayed in the next request.
        expect(structuredClone(originalOutput[0])).toMatchObject({
          type: "reasoning",
          summary: [{ type: "summary_text", text: TEXT }],
          encrypted_content: expect.stringMatching(/^kr2_/),
        });
        expect(requestFields(f.inputs[0]?.additionalModelRequestFields).thinking).toBeUndefined();
        expect(typeof originalOutput[0]?.encrypted_content).toBe("string");
        const tool = originalOutput.find((item) => item.type === "function_call");
        const response = await f.send(
          "omitted",
          [
            { role: "user", content: "Read the synthetic value" },
            ...originalOutput,
            {
              type: "function_call_output",
              call_id: tool?.call_id,
              output: "synthetic tool result",
            },
          ],
          stream,
          { model },
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("x-kiro-thinking-display-mode")).toBe("forced-omitted");
        const items = await output(response, stream);
        expect(JSON.stringify(items)).not.toContain(TEXT);
        expect(items.find((item) => item.type === "reasoning")).toMatchObject({
          summary: [],
          encrypted_content: expect.stringMatching(/^kr2_/),
        });
        const fields = f.inputs[1]?.additionalModelRequestFields;
        expect(fields).toMatchObject({
          output_config: { effort: "max" },
          thinking: { type: "adaptive", display: "omitted" },
        });
        const upstream = JSON.stringify(f.inputs[1]?.conversationState);
        expect(upstream).toContain(SIGNATURE);
        expect(upstream).toContain(TEXT);
        expect(upstream).toContain("fixture_display_call");
        expect(upstream).toContain("synthetic tool result");
        expect(audit.events("responses_thinking_display_forced")).toHaveLength(1);
        expect(audit.events("responses_thinking_display_forced")[0]).toMatchObject({
          protocol: "responses",
          effective_display: "omitted",
          effort: "max",
        });
        expect(
          audit
            .events("sdk_reasoning_signature_observed")
            .some((event) => event.signature_relation === "duplicate"),
        ).toBe(true);
        const logs = JSON.stringify(audit.events());
        expect(logs).not.toContain(SIGNATURE);
        expect(logs).not.toContain(TEXT);
        expect(logs).not.toContain("signature_hash");
      },
    );
  }

  test("an unspecified effort stays unspecified instead of becoming medium", async () => {
    const before = fixture();
    const after = fixture();
    await output(await before.send("preserve", undefined, false, { reasoning: {} }), false);
    const response = await after.send("omitted", undefined, false, { reasoning: {} });
    expect(response.headers.get("x-kiro-thinking-display-mode")).toBe("forced-omitted");
    await output(response, false);
    expect(requestFields(after.inputs[0]?.additionalModelRequestFields).output_config).toEqual(
      requestFields(before.inputs[0]?.additionalModelRequestFields).output_config,
    );
    expect(requestFields(after.inputs[0]?.additionalModelRequestFields).thinking).toEqual({
      type: "adaptive",
      display: "omitted",
    });
  });

  test("Responses continues to accept a single late signature", async () => {
    const f = fixture({ late: true });
    const response = await f.send("omitted", undefined, true);
    const items = await output(response, true);
    expect(response.status).toBe(200);
    expect(items.find((item) => item.type === "reasoning")).toMatchObject({
      summary: [],
      encrypted_content: expect.stringMatching(/^kr2_/),
    });
    expect(
      audit
        .events("sdk_reasoning_signature_observed")
        .some((event) => event.phase === "after-assistant"),
    ).toBe(true);
  });

  test.each([false, true])(
    "nonempty conflicts remain fatal with no replay (stream=%s)",
    async (stream) => {
      const f = fixture({ conflict: true });
      const response = await f.send("omitted", undefined, stream);
      const wire = await response.text();
      if (stream)
        expect(messagesSseEvents(wire).some((event) => event.type === "response.completed")).toBe(
          false,
        );
      else expect(response.status).toBe(502);
      expect(wire).toContain("invalid_upstream_reasoning");
      expect(wire).not.toContain(TEXT);
      expect(wire).not.toContain(SIGNATURE);
      expect(f.inputs).toHaveLength(1);
      expect(
        audit
          .events("sdk_reasoning_signature_observed")
          .some((event) => event.signature_relation === "distinct"),
      ).toBe(true);
      expect(audit.events("anthropic_output_reasoning_conflict_omitted")).toHaveLength(0);
    },
  );

  test("hidden reasoning still marks semantic acceptance before transport failure", async () => {
    const f = fixture({ broken: true });
    const response = await f.send("omitted", undefined, true);
    const wire = await response.text();
    expect(wire).not.toContain(TEXT);
    expect(messagesSseEvents(wire).some((event) => event.type === "response.completed")).toBe(
      false,
    );
    expect(f.inputs).toHaveLength(1);
    expect(audit.events("sdk_stream_terminal").at(-1)).toMatchObject({
      reasoning_chars: TEXT.length,
      terminal_provenance: "upstream_error",
    });
  });

  test.each([false, true])(
    "signature-only omitted thinking prevents accepted-generation retries (stream=%s)",
    async (stream) => {
      const f = fixture({ broken: true, signatureOnly: true });
      const response = await f.send("omitted", undefined, stream);
      const wire = await response.text();
      expect(f.inputs).toHaveLength(1);
      expect(wire).not.toContain(SIGNATURE);
      expect(wire).not.toContain("response.completed");
      if (!stream) expect(response.status).toBe(502);
    },
  );

  test("mixed reasoning remains fatal", async () => {
    const f = fixture({ mixed: true });
    const response = await f.send("omitted");
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("invalid_upstream_reasoning");
    expect(f.inputs).toHaveLength(1);
  });

  test("invalid replay cannot activate display policy or dispatch", async () => {
    const f = fixture();
    const response = await f.send("omitted", [
      { type: "reasoning", encrypted_content: "kr2_invalid", summary: [] },
      { role: "assistant", content: "prior" },
      { role: "user", content: "Continue" },
    ]);
    expect(response.status).toBe(400);
    expect(response.headers.get("x-kiro-thinking-display-mode")).toBeNull();
    await response.text();
    expect(f.inputs).toHaveLength(0);
    expect(audit.events("responses_thinking_display_forced")).toHaveLength(0);
  });

  test.each(["auto", "concise", "detailed"])(
    "strict summary=%s is rejected before any policy dispatch",
    async (summary) => {
      const f = fixture({ strict: true });
      const response = await f.send("omitted", undefined, false, {
        reasoning: { effort: "max", summary },
      });
      expect(response.status).toBe(400);
      await response.text();
      expect(f.inputs).toHaveLength(0);
      expect(audit.events("responses_thinking_display_forced")).toHaveLength(0);
    },
  );

  test("a non-target model is unaffected", async () => {
    const f = fixture();
    const response = await f.send("omitted", undefined, false, { model: "gpt-5.6-sol" });
    expect(response.headers.get("x-kiro-thinking-display-mode")).toBeNull();
    const items = await output(response, false);
    expect(JSON.stringify(items)).toContain(TEXT);
    expect(requestFields(f.inputs[0]?.additionalModelRequestFields).thinking).toBeUndefined();
  });

  test("native Responses is not rerouted or marked", async () => {
    const f = fidelityFixture({ config: { responses_thinking_display_mode: "omitted" } });
    try {
      const response = await f.send({ model: "gpt-5.6-sol", input: "Synthetic native request" });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-kiro-thinking-display-mode")).toBeNull();
      await response.text();
      expect(f.requests).toHaveLength(1);
      expect(f.canonical).toHaveLength(0);
    } finally {
      f.database.close();
    }
  });
});
