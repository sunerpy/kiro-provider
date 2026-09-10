import { expect, test } from "bun:test";
import type { PipelineAffinityStore } from "../src/core/pipeline.js";
import { canonicalCompletionFromResponse } from "../src/server/responses/store.js";
import { fidelityFixture, nativeResponse } from "./responses-fidelity-helpers.js";
import { makeSdkResponse } from "./sdk-stream-test-helpers.js";

const model = "claude-opus-5";
type Body = { id: string; previous_response_id: string | null; status: string };

test.each([false, true])(
  "V1 stateless migration preserves known history or rejects missing replay order: %s",
  async (withReplay) => {
    const f = fidelityFixture();
    try {
      const first = (await (
        await f.send({
          model,
          instructions: "ONE_TURN_ONLY",
          input: [
            ...(withReplay
              ? [
                  { type: "reasoning", summary: [], encrypted_content: "kr1_legacy" },
                  { role: "assistant", content: "Earlier output" },
                ]
              : []),
            { role: "developer", content: "PERSISTENT_POLICY" },
            { role: "user", content: "FIRST" },
          ],
        })
      ).json()) as Body;
      const stored = f.responseStore.get("fidelity-test", first.id);
      const canonical = f.canonical[0];
      if (!stored || !canonical) throw new Error("Missing legacy fixture");
      f.responseStore.put(
        "fidelity-test",
        stored.response,
        stored.inputItems,
        canonical,
        canonicalCompletionFromResponse(stored.response),
      );
      const next = await f.send({ model, previous_response_id: first.id, input: "SECOND" });
      expect(next.status).toBe(withReplay ? 409 : 200);
      if (withReplay) {
        expect(f.canonical).toHaveLength(1);
        expect(await next.text()).toContain("response_context_unavailable");
      } else {
        const second = (await next.json()) as Body;
        const secondStored = f.responseStore.get("fidelity-test", second.id);
        expect(secondStored?.continuation?.legacyRequest).toBeDefined();
        expect(
          JSON.parse(
            f.database.getStoredResponse(second.id, "fidelity-test")?.canonicalJson ?? "{}",
          ).version,
        ).toBe(3);
        f.responseStore.delete("fidelity-test", first.id);
        expect(
          (await f.send({ model, previous_response_id: second.id, input: "THIRD" })).status,
        ).toBe(200);
        const history = JSON.stringify(f.canonical[2]?.messages);
        expect(history).toContain("PERSISTENT_POLICY");
        expect(history).toContain("FIRST");
        expect(history).toContain("SECOND");
        expect(history).not.toContain("ONE_TURN_ONLY");
      }
    } finally {
      f.database.close();
    }
  },
);

test("affected native models replay exact history without inheriting top-level instructions", async () => {
  const f = fidelityFixture();
  try {
    const first = (await (
      await f.send({ model, input: "FIRST", instructions: "Only for first." })
    ).json()) as Body;
    const secondResponse = await f.send({
      model,
      previous_response_id: first.id,
      input: "SECOND",
      instructions: "Only for second.",
    });
    const second = (await secondResponse.json()) as Body;
    expect(secondResponse.headers.get("x-kiro-transport")).toBe("native-adapted");
    expect(second.previous_response_id).toBe(first.id);
    expect(f.requests[1]?.previous_response_id).toBeUndefined();
    expect(f.requests[1]?.instructions).toBe("Only for second.");
    expect(f.requests[1]?.input).toMatchObject([
      { role: "user", content: "FIRST" },
      { type: "message", role: "assistant" },
      { role: "user", content: "SECOND" },
    ]);
    f.responseStore.delete("fidelity-test", first.id);
    const third = await f.send({ model, previous_response_id: second.id, input: "THIRD" });
    expect(third.status).toBe(200);
    expect(f.requests[2]?.instructions).toBeUndefined();
    expect(f.requests[2]?.input).toHaveLength(5);
    expect(f.selections.map((selection) => selection.selected)).toEqual([
      f.accounts[0]?.id,
      f.accounts[0]?.id,
      f.accounts[0]?.id,
    ]);
  } finally {
    f.database.close();
  }
});

test("a native replay lineage keeps its exact history when the next model changes", async () => {
  const f = fidelityFixture();
  try {
    const first = (await (await f.send({ model, input: "Remember this" })).json()) as Body;
    const next = await f.send({
      model: "gpt-5.6-sol",
      previous_response_id: first.id,
      input: "Continue",
    });
    expect(next.status).toBe(200);
    expect(next.headers.get("x-kiro-transport")).toBe("native-adapted");
    expect(f.requests[1]?.previous_response_id).toBeUndefined();
    expect(f.requests[1]?.input).toMatchObject([
      { role: "user", content: "Remember this" },
      { role: "assistant" },
      { role: "user", content: "Continue" },
    ]);
  } finally {
    f.database.close();
  }
});

test("legacy native records stay readable but a cache cannot invent missing owner metadata", async () => {
  const f = fidelityFixture();
  try {
    const first = (await (await f.send({ model, input: "LEGACY" })).json()) as Body;
    const row = f.database.getStoredResponse(first.id, "fidelity-test");
    if (!row) throw new Error("Missing fixture response");
    f.database.putStoredResponse(
      { ...row, canonicalJson: '{"version":2,"transport":"kiro-native-responses"}' },
      100,
    );
    const response = await f.send({ model, previous_response_id: first.id, input: "NEXT" });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("response_context_unavailable");
    expect(f.requests).toHaveLength(1);
    expect(f.responseStore.get("fidelity-test", first.id)?.response.id).toBe(first.id);
    expect(
      JSON.parse(f.database.getStoredResponse(first.id, "fidelity-test")?.canonicalJson ?? "{}")
        .version,
    ).toBe(2);
  } finally {
    f.database.close();
  }
});

test("a committed owner remains usable when the optional affinity cache fails", async () => {
  const f = fidelityFixture();
  const cache: PipelineAffinityStore = {
    getSessionAffinity: () => undefined,
    claimSessionAffinity: () => {
      throw new Error("cache failed");
    },
    rebindSessionAffinity: () => {
      throw new Error("cache failed");
    },
    resolveOutputLineage: () => undefined,
    recordOutputLineage: () => {},
  };
  try {
    const first = (await (
      await f.send({ model: "gpt-5.6-sol", input: "Hi" }, { affinityStore: cache })
    ).json()) as Body;
    expect(first.status).toBe("completed");
    const second = await f.send(
      { model: "gpt-5.6-sol", previous_response_id: first.id, input: "Next" },
      { affinityStore: cache },
    );
    expect(second.status).toBe(200);
    expect(f.selections[1]?.selected).toBe(f.accounts[0]?.id);
  } finally {
    f.database.close();
  }
});

test("incomplete native outputs remain retrievable but cannot be silently replayed as complete calls", async () => {
  const f = fidelityFixture({
    native: () =>
      Response.json({
        ...nativeResponse("resp_partial", model),
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            type: "function_call",
            id: "fc_partial",
            call_id: "call_partial",
            name: "echo",
            arguments: '{"unfinished":',
            status: "incomplete",
          },
        ],
      }),
  });
  try {
    expect((await f.send({ model, input: "Hi" })).status).toBe(200);
    expect(f.responseStore.get("fidelity-test", "resp_partial")?.response.status).toBe(
      "incomplete",
    );
    expect(
      (await f.send({ model, previous_response_id: "resp_partial", input: "Next" })).status,
    ).toBe(409);
    expect(f.requests).toHaveLength(1);
  } finally {
    f.database.close();
  }
});

test.each([true, false])(
  "strict single instructions require the actual systemPrompt feature: %s",
  async (available) => {
    const f = fidelityFixture({ config: { responses_fidelity_mode: "strict" } });
    let calls = 0;
    try {
      const response = await f.send(
        {
          model,
          store: false,
          input: [
            { role: "developer", content: "Policy" },
            { role: "user", content: "Hi" },
          ],
        },
        {
          runPipeline: undefined,
          nativeContextCapabilities: {
            ensureAccountNativeContext: async () => ({
              status: available ? "available" : "unavailable",
              source: "live",
              featureCount: available ? 1 : 0,
              systemFieldInjection: available,
              systemPromptMigration: false,
            }),
          },
          makeClient: () => ({
            send: async () => {
              calls += 1;
              return makeSdkResponse([{ assistantResponseEvent: { content: "OK" } }]);
            },
          }),
        },
      );
      expect(response.status).toBe(available ? 200 : 400);
      expect(calls).toBe(available ? 1 : 0);
      if (available) expect(response.headers.get("x-kiro-compatibility")).toBeNull();
    } finally {
      f.database.close();
    }
  },
);
