import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import { createApp } from "../src/server/app.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";
import {
  MESSAGES_FIXTURE_KEY,
  messagesFixture,
  messagesSseEvents,
} from "./messages-regression-helpers.js";

const MODEL = "claude-opus-5-5";
const SUMMARY = "synthetic unsigned output metadata";
const TOOLS = [
  {
    type: "function",
    name: "lookup",
    description: "Read a synthetic status",
    parameters: { type: "object" },
  },
];
const TOOL_CALL = {
  type: "function_call",
  id: "fc_pi_fixture",
  call_id: "call_pi_fixture",
  name: "lookup",
  arguments: "{}",
};
const SUMMARY_ITEM = {
  id: "rs_pi_fixture",
  type: "reasoning",
  summary: [{ type: "summary_text", text: SUMMARY }],
};

function fixture(strict = false) {
  const database = new AccountsDatabase(":memory:");
  const f = messagesFixture(
    [
      { reasoningContentEvent: { text: "authenticated history", signature: "fixture-signature" } },
      { assistantResponseEvent: { content: "CONTINUED" } },
    ],
    {
      config: {
        protocol_projection_mode: "safe",
        responses_fidelity_mode: strict ? "strict" : "compatible",
        reasoning_replay_keys: [`fixture:${Buffer.alloc(32, 7).toString("base64url")}`],
        max_inflight_requests: 1,
      },
    },
  );
  const store = new ReasoningReplayStore(database, f.config);
  const app = createApp(f.config, { ...f.dependencies, reasoningReplayStore: store });
  return {
    ...f,
    database,
    send(input: unknown[], stream = false, key = MESSAGES_FIXTURE_KEY, signal?: AbortSignal) {
      return app(
        new Request("http://fixture/v1/responses", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: MODEL, store: false, stream, tools: TOOLS, input }),
          ...(signal ? { signal } : {}),
        }),
      );
    },
  };
}

function history(summary: Record<string, unknown> = SUMMARY_ITEM): unknown[] {
  return [
    { role: "user", content: "Check the synthetic status" },
    summary,
    TOOL_CALL,
    { type: "function_call_output", call_id: TOOL_CALL.call_id, output: "healthy" },
    { role: "user", content: "Continue" },
  ];
}

const resources: ReturnType<typeof fixture>[] = [];
const tracked = (strict = false) => {
  const f = fixture(strict);
  resources.push(f);
  return f;
};
afterEach(() => {
  for (const f of resources.splice(0)) f.database.close();
});

describe("Pi summary-only Responses history recovery", () => {
  test.each([false, true])(
    "recovers input.267 with signed earlier history (stream=%s)",
    async (stream) => {
      const logs = spyOn(console, "error").mockImplementation(() => {});
      try {
        const f = tracked();
        const first = await f.send([{ role: "user", content: "Start" }]);
        expect(first.status).toBe(200);
        const output = ((await first.json()) as { output: Record<string, unknown>[] }).output;
        expect(output[0]?.encrypted_content).toMatch(/^kr2_/);
        const input: unknown[] = Array.from({ length: 132 }, (_, i) => [
          { role: "user", content: `fixture turn ${i}` },
          { role: "assistant", content: `fixture answer ${i}` },
        ]).flat();
        input[263] = { role: "user", content: "Begin the authenticated generation" };
        input.push(...output, { role: "user", content: "Check again" }, ...history().slice(1));
        expect(input[267]).toEqual(SUMMARY_ITEM);
        const response = await f.send(input, stream);
        const wire = await response.text();
        expect(wire).not.toContain('"error":{');
        expect(response.status).toBe(200);
        expect(response.headers.get("x-kiro-compatibility")).toBe(
          "reasoning_summary_replay_omitted",
        );
        if (stream) {
          const events = messagesSseEvents(wire);
          expect(events.at(-1)?.type).toBe("response.completed");
          expect(events.some((event) => event.type === "response.failed")).toBe(false);
        } else expect(JSON.parse(wire).status).toBe("completed");
        expect(f.inputs).toHaveLength(2);
        const upstream = JSON.stringify(f.inputs[1]);
        expect(upstream).not.toContain(SUMMARY);
        expect(upstream).toContain("fixture-signature");
        expect(upstream).toContain("healthy");
        expect(upstream).toContain(TOOL_CALL.call_id);
        expect(upstream).toContain("fixture answer 0");
        const audits = logs.mock.calls
          .map(([line]) => String(line))
          .filter((line) => line.includes('"event":"responses_reasoning_summary_omitted"'));
        expect(audits).toHaveLength(1);
        expect(JSON.parse(audits[0] as string)).toMatchObject({
          protocol: "responses",
          reasoning_item_count: 1,
        });
        expect(audits[0]).not.toContain(SUMMARY);
        expect(audits[0]).not.toContain("rs_pi_fixture");
        // Admission remains owned until the prior body is consumed, then releases.
        const followup = await f.send([{ role: "user", content: "One more" }]);
        expect(followup.status).toBe(200);
        await followup.text();
      } finally {
        logs.mockRestore();
      }
    },
  );

  test("strict keeps the original typed rejection without dispatch", async () => {
    const f = tracked(true);
    const response = await f.send(history());
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "unsupported_reasoning_plaintext_replay",
    );
    expect(f.inputs).toHaveLength(0);
  });

  test.each([
    [
      "plaintext content",
      { ...SUMMARY_ITEM, content: [{ type: "reasoning_text", text: "private" }] },
    ],
    ["empty token", { ...SUMMARY_ITEM, encrypted_content: "" }],
    ["external token", { ...SUMMARY_ITEM, encrypted_content: "external-token" }],
    ["invalid provider token", { ...SUMMARY_ITEM, encrypted_content: "kr2_invalid" }],
    ["unknown field", { ...SUMMARY_ITEM, extra: "unsupported" }],
    [
      "unknown summary field",
      { ...SUMMARY_ITEM, summary: [{ type: "summary_text", text: SUMMARY, extra: true }] },
    ],
    ["empty reasoning", { type: "reasoning", summary: [] }],
  ])("does not downgrade %s", async (_label, item) => {
    const f = tracked();
    const response = await f.send(history(item));
    expect(response.status).toBe(400);
    await response.text();
    expect(f.inputs).toHaveLength(0);
    expect(response.headers.get("x-kiro-compatibility") ?? "").not.toContain(
      "reasoning_summary_replay_omitted",
    );
  });

  test("does not admit summary-only orphan reasoning as a historical turn", async () => {
    const f = tracked();
    const response = await f.send([SUMMARY_ITEM, { role: "user", content: "Continue" }]);
    expect(response.status).toBe(400);
    await response.text();
    expect(f.inputs).toHaveLength(0);
  });

  test("auth still precedes recovery and dispatch", async () => {
    const f = tracked();
    const response = await f.send(history(), false, "invalid");
    expect(response.status).toBe(401);
    await response.text();
    expect(f.inputs).toHaveLength(0);
  });

  test("a sibling with an authenticated token remains lossless", async () => {
    const f = tracked();
    const first = await f.send([{ role: "user", content: "Start" }]);
    const output = ((await first.json()) as { output: unknown[] }).output;
    const response = await f.send([...output, SUMMARY_ITEM, { role: "user", content: "Continue" }]);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-kiro-compatibility")).toBeNull();
    await response.text();
    expect(JSON.stringify(f.inputs[1])).toContain("fixture-signature");
  });
});
