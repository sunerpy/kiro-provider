import { expect, test } from "bun:test";
import type { PipelineAffinityStore } from "../src/core/pipeline.js";
import {
  canonicalCompletionFromResponse,
  SqliteResponseStore,
} from "../src/server/responses/store.js";
import { fidelityFixture, nativeResponse, sse } from "./responses-fidelity-helpers.js";
import { makeSdkResponse } from "./sdk-stream-test-helpers.js";

const model = "claude-opus-5";
type Body = { id: string; previous_response_id: string | null; status: string };

test.each([false, true])(
  "opaque native custom output retains exact wire history for continuation, stream=%s",
  async (stream) => {
    const argumentsText = '{"input" : "x\\\\y\\n雪"}';
    const f = fidelityFixture({
      native: (body, call) => {
        const response = nativeResponse(`resp_native_${call}`);
        if (call === 1)
          response.output = [
            {
              type: "reasoning",
              id: "rs_native",
              summary: [],
              content: [],
              encrypted_content: "native-opaque",
            },
            {
              type: "function_call",
              id: "fc_native",
              call_id: "call_native",
              name: (body.tools as Array<{ name: string }>)[0]?.name,
              arguments: argumentsText,
              status: "completed",
            },
          ];
        if (!stream) return Response.json(response);
        return new Response(
          [
            {
              type: "response.created",
              sequence_number: 0,
              response: { ...response, status: "in_progress", output: [] },
            },
            { type: "response.completed", sequence_number: 1, response },
          ]
            .map(sse)
            .join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    try {
      const first = await f.send({
        model: "gpt-5.6-sol",
        stream,
        input: "Use emit",
        tools: [{ type: "custom", name: "emit", description: "Emit text" }],
      });
      expect(first.status).toBe(200);
      await first.text();
      const stored = f.responseStore.get("fidelity-test", "resp_native_1");
      expect(stored?.continuation?.wireSnapshot?.output[1]?.arguments).toBe(argumentsText);
      expect(stored?.response.output[1]).toMatchObject({
        type: "custom_tool_call",
        input: "x\\y\n雪",
      });
      const next = await f.send({
        model: "gpt-5.6-sol",
        stream,
        previous_response_id: "resp_native_1",
        input: [{ type: "custom_tool_call_output", call_id: "call_native", output: "OK" }],
      });
      expect(next.status).toBe(200);
      await next.text();
      expect(f.requests[1]?.previous_response_id).toBeUndefined();
      const replay = f.requests[1]?.input as Array<Record<string, unknown>>;
      expect(replay[1]?.encrypted_content).toBe("native-opaque");
      expect(replay[2]?.arguments).toBe(argumentsText);
      expect(replay[3]).toMatchObject({ type: "function_call_output", call_id: "call_native" });
      expect(
        f.responseStore.get("fidelity-test", "resp_native_2")?.continuation?.nativeReplay?.input,
      ).toHaveLength(4);
    } finally {
      f.database.close();
    }
  },
);

test("manual native opaque replay recovers its owner after a store restart and rejects mismatched provenance", async () => {
  const f = fidelityFixture({
    native: (_body, call) =>
      Response.json({
        ...nativeResponse(`resp_opaque_${call}`),
        output: [
          ...(call === 1
            ? [
                {
                  type: "reasoning",
                  id: "rs_opaque",
                  summary: [],
                  encrypted_content: "upstream-opaque",
                },
              ]
            : []),
          ...(nativeResponse("text").output as unknown[]),
        ],
      }),
  });
  try {
    const first = await f.send({ model: "gpt-5.6-sol", input: "First" });
    await first.text();
    const record = f.database.getStoredResponse("resp_opaque_1", "fidelity-test");
    if (!record) throw new Error("Missing native fixture");
    f.database.putStoredResponse(
      {
        ...record,
        id: "resp_future",
        responseJson: JSON.stringify({
          ...nativeResponse("resp_future"),
          output: ["future-item", null, 42],
        }),
        canonicalJson: '{"version":99}',
      },
      100,
    );
    const freshStore = new SqliteResponseStore(f.database);
    const input = [
      ...(freshStore.get("fidelity-test", "resp_opaque_1")?.response.output ?? []),
      { role: "user", content: "Continue" },
    ];
    expect(
      (await f.send({ model: "gpt-5.6-sol", input }, { responseStore: freshStore })).status,
    ).toBe(200);
    expect(f.selections[1]?.selected).toBe(f.selections[0]?.selected);
    expect((await f.send({ model: "gpt-5.6-sol", input }, { tenantId: "other" })).status).toBe(400);
    expect((await f.send({ model: "gpt-5.6-terra", input })).status).toBe(400);
    freshStore.delete("fidelity-test", "resp_opaque_1");
    expect((await f.send({ model: "gpt-5.6-sol", input })).status).toBe(400);
    expect(f.requests).toHaveLength(2);
    expect(f.canonical).toHaveLength(0);
    expect(f.database.getStoredResponse("resp_future", "fidelity-test")?.canonicalJson).toBe(
      '{"version":99}',
    );
  } finally {
    f.database.close();
  }
});

test("the same opaque token cannot choose between conflicting account owners", async () => {
  const f = fidelityFixture({
    native: (_body, call) =>
      Response.json({
        ...nativeResponse(`resp_conflict_${call}`),
        output: [
          {
            type: "reasoning",
            id: `rs_${call}`,
            summary: [],
            encrypted_content: "ambiguous-opaque",
          },
        ],
      }),
  });
  try {
    await f.send({ model: "gpt-5.6-sol", input: "First" });
    await f.send({ model: "gpt-5.6-sol", input: "Second" });
    const response = await f.send({
      model: "gpt-5.6-sol",
      input: [
        { type: "reasoning", summary: [], encrypted_content: "ambiguous-opaque" },
        { role: "user", content: "Continue" },
      ],
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("response_context_unavailable");
    expect(f.requests).toHaveLength(2);
  } finally {
    f.database.close();
  }
});

test("manual native custom replay preserves the original wrapper bytes and rejects changed arguments", async () => {
  const argumentsText = '{"input" : "raw text"}';
  const f = fidelityFixture({
    native: (body, call) =>
      Response.json({
        ...nativeResponse(`resp_manual_${call}`),
        ...(call === 1
          ? {
              output: [
                {
                  type: "reasoning",
                  id: "rs_manual",
                  summary: [],
                  encrypted_content: "opaque-manual",
                },
                {
                  type: "function_call",
                  id: "fc_manual",
                  call_id: "call_manual",
                  name: (body.tools as Array<{ name: string }>)[0]?.name,
                  arguments: argumentsText,
                  status: "completed",
                },
              ],
            }
          : {}),
      }),
  });
  try {
    await f.send({
      model: "gpt-5.6-sol",
      input: "Use emit",
      tools: [{ type: "custom", name: "emit", description: "Emit text" }],
    });
    const original = f.responseStore.get("fidelity-test", "resp_manual_1")?.response.output ?? [];
    const input = [
      { role: "user", content: "Use emit" },
      ...original,
      { type: "custom_tool_call_output", call_id: "call_manual", output: "OK" },
    ];
    expect((await f.send({ model: "gpt-5.6-sol", input })).status).toBe(200);
    expect((f.requests[1]?.input as Array<{ arguments?: string }>)[2]?.arguments).toBe(
      argumentsText,
    );
    expect(f.selections[1]?.selected).toBe(f.selections[0]?.selected);
    const changed = input.map((item) =>
      "type" in item && item.type === "custom_tool_call" ? { ...item, input: "changed" } : item,
    );
    expect((await f.send({ model: "gpt-5.6-sol", input: changed })).status).toBe(409);
    expect(f.requests).toHaveLength(2);
  } finally {
    f.database.close();
  }
});

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
