import { describe, expect, test } from "bun:test";
import { acquireAccountQueue } from "../src/core/pipeline-runtime.js";
import { transformToSdkRequest } from "../src/kiro/transform/request-sdk.js";
import { ResponseContextError } from "../src/server/responses/continuation.js";
import { nativeRetryDelay } from "../src/server/responses/native-transport.js";
import { handleStoredResponse } from "../src/server/routes/responses.js";
import { fidelityFixture, nativeResponse, sse, textEvents } from "./responses-fidelity-helpers.js";

interface TestResponse {
  id: string;
  store: boolean;
  parallel_tool_calls: boolean;
  output: Array<Record<string, unknown>>;
  error: { code: string };
  data: Array<Record<string, unknown>>;
}

const basic = { model: "gpt-5.6-sol", input: "Hi" };

describe("Responses fidelity regression", () => {
  test.each([
    "instructions",
    "previous_response_id",
    "temperature",
    "max_output_tokens",
    "store",
    "stream",
  ])("accepts standard nullable %s without turning null into false", async (key) => {
    const f = fidelityFixture();
    try {
      const response = await f.send({ ...basic, [key]: null });
      expect(response.status).toBe(200);
      expect(((await response.json()) as TestResponse).store).toBe(true);
      expect(f.requests).toHaveLength(1);
    } finally {
      f.database.close();
    }
  });

  test("accepts SDK nullable function fields without changing JSON schema null values", async () => {
    const f = fidelityFixture();
    try {
      const tools = [
        { type: "function", name: "ping", description: null, strict: null, parameters: null },
        {
          type: "function",
          name: "echo",
          parameters: { type: "object", properties: { value: { const: null } } },
          strict: false,
        },
      ];
      expect((await f.send({ ...basic, tools })).status).toBe(200);
      expect(f.requests[0]?.tools).toEqual([{ type: "function", name: "ping" }, tools[1]]);
    } finally {
      f.database.close();
    }
  });

  test("preserves standard reasoning text and assistant phase on native input", async () => {
    const f = fidelityFixture();
    try {
      const input = [
        {
          type: "reasoning",
          summary: [],
          content: [{ type: "reasoning_text", text: "Synthetic fixture" }],
        },
        { role: "assistant", phase: "commentary", content: "Working" },
        { role: "user", content: "Continue" },
      ];
      expect((await f.send({ ...basic, input })).status).toBe(200);
      expect(f.requests[0]?.input).toEqual(input);
      const rejected = await f.send({
        ...basic,
        input: [{ role: "user", phase: "commentary", content: "Hi" }],
      });
      expect(rejected.status).toBe(400);
    } finally {
      f.database.close();
    }
  });

  test.each([
    { reasoning: { unknown: true } },
    { stream: true, stream_options: { unknown: true } },
  ])("rejects unknown controls before upstream dispatch: %j", async (extra) => {
    const f = fidelityFixture();
    try {
      expect((await f.send({ ...basic, ...extra })).status).toBe(400);
      expect(f.requests).toHaveLength(0);
    } finally {
      f.database.close();
    }
  });

  test("reports known compatibility losses and rejects them in strict mode", async () => {
    for (const mode of ["compatible", "strict"] as const) {
      const f = fidelityFixture({ config: { responses_fidelity_mode: mode } });
      try {
        const response = await f.send({
          ...basic,
          text: { verbosity: "low" },
          reasoning: { context: "all_turns" },
        });
        expect(response.status).toBe(mode === "strict" ? 400 : 200);
        expect(response.headers.get("x-kiro-compatibility")).toContain("text_verbosity_ignored");
        expect(response.headers.get("x-kiro-compatibility")).toContain("reasoning_context_ignored");
        expect(f.requests.length).toBe(mode === "strict" ? 0 : 1);
      } finally {
        f.database.close();
      }
    }
  });

  test("strict mode rejects an effort value that the legacy model would clamp", async () => {
    const f = fidelityFixture({ config: { responses_fidelity_mode: "strict" } });
    try {
      const response = await f.send({
        model: "claude-sonnet-4-6",
        store: false,
        input: "Hi",
        reasoning: { effort: "xhigh" },
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("x-kiro-compatibility")).toContain(
        "reasoning_effort_approximated",
      );
      expect(f.canonical).toHaveLength(0);
    } finally {
      f.database.close();
    }
  });

  test("routes kr1 replay by token ownership even without include", async () => {
    const f = fidelityFixture();
    try {
      const response = await f.send({
        ...basic,
        input: [
          { type: "reasoning", summary: [], encrypted_content: "kr1_fixture" },
          { role: "assistant", content: "Prior answer" },
          { role: "user", content: "Continue" },
        ],
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-kiro-transport")).toBe("stateless");
      expect(f.requests).toHaveLength(0);
      expect(f.canonical[0]?.reasoningReplays).toHaveLength(1);
    } finally {
      f.database.close();
    }
  });

  test("never sends native opaque reasoning into the kr1 decoder", async () => {
    const f = fidelityFixture();
    try {
      const response = await f.send({
        ...basic,
        store: false,
        input: [
          { type: "reasoning", summary: [], encrypted_content: "upstream-opaque" },
          { role: "assistant", content: "Prior" },
          { role: "user", content: "Next" },
        ],
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as TestResponse).error.code).toBe(
        "native_response_transport_conflict",
      );
      expect(f.canonical).toHaveLength(0);
    } finally {
      f.database.close();
    }
  });

  test("restores private reasoning on a stored stateless continuation", async () => {
    const f = fidelityFixture({
      reasoning: { text: "Synthetic summary", encryptedContent: "kr1_stored" },
    });
    try {
      const first = (await (
        await f.send({
          model: "claude-opus-5",
          input: [
            { role: "developer", content: "Policy" },
            { role: "user", content: "First" },
          ],
        })
      ).json()) as TestResponse;
      expect(JSON.stringify(first)).not.toContain("kr1_stored");
      const stored = f.responseStore.get("fidelity-test", first.id);
      expect(stored?.continuation?.transport).toBe("stateless");
      expect(JSON.stringify(stored?.continuation?.output)).toContain("kr1_stored");
      const second = await f.send({
        model: "claude-opus-5",
        input: "Next",
        previous_response_id: first.id,
      });
      expect(second.status).toBe(200);
      expect(f.canonical[1]?.reasoningReplays).toHaveLength(1);
    } finally {
      f.database.close();
    }
  });

  test("store=false returns an available replay token without include and writes no response row", async () => {
    const f = fidelityFixture({
      reasoning: { text: "Synthetic summary", encryptedContent: "kr1_volatile" },
    });
    try {
      const body = (await (await f.send({ ...basic, store: false })).json()) as TestResponse;
      expect(body.output[0]?.encrypted_content).toBe("kr1_volatile");
      expect(f.responseStore.get("fidelity-test", body.id)).toBeUndefined();
    } finally {
      f.database.close();
    }
  });

  test("binds native continuation to its owner when the affinity cache is missing", async () => {
    const f = fidelityFixture();
    try {
      const first = (await (await f.send(basic)).json()) as TestResponse;
      const second = await f.send(
        { ...basic, previous_response_id: first.id },
        { affinityStore: undefined },
      );
      expect(second.status).toBe(200);
      expect(f.selections[1]?.selected).toBe(f.accounts[0]?.id);
      f.primary.rateLimitResetTime = Date.now() + 60000;
      const third = await f.send({ ...basic, previous_response_id: first.id });
      expect(third.status).toBe(429);
      expect(third.headers.get("retry-after")).not.toBeNull();
      expect(f.requests).toHaveLength(2);
    } finally {
      f.database.close();
    }
  });

  test("rejects changed profile and unknown future storage versions without deleting records", async () => {
    const f = fidelityFixture();
    try {
      const first = (await (await f.send(basic)).json()) as TestResponse;
      f.primary.profileArn = "changed-profile";
      expect((await f.send({ ...basic, previous_response_id: first.id })).status).toBe(409);
      f.database.putStoredResponse(
        {
          id: "resp_future",
          tenantId: "fidelity-test",
          model: basic.model,
          responseJson: JSON.stringify(nativeResponse("resp_future")),
          inputItemsJson: "[]",
          canonicalJson: '{"version":99}',
          createdAt: Date.now(),
          lastSeen: Date.now(),
          expiresAt: Date.now() + 10000,
        },
        100,
      );
      expect(() => f.responseStore.get("fidelity-test", "resp_future")).toThrow(
        ResponseContextError,
      );
      expect(f.database.getStoredResponse("resp_future", "fidelity-test")).toBeDefined();
    } finally {
      f.database.close();
    }
  });

  test("does not report completed storage after a persistence failure", async () => {
    const f = fidelityFixture();
    try {
      const store = {
        ...f.responseStore,
        putNative() {
          throw new Error("disk failure");
        },
        put() {
          throw new Error("disk failure");
        },
        get: () => undefined,
        delete: () => false,
      };
      for (const body of [
        basic,
        {
          ...basic,
          model: "claude-opus-5",
          input: [
            { role: "developer", content: "Policy" },
            { role: "user", content: "Hi" },
          ],
        },
      ]) {
        const response = await f.send(body, { responseStore: store });
        expect(response.status).toBe(502);
        expect(((await response.json()) as TestResponse).error.code).toBe(
          "response_state_store_failed",
        );
      }
    } finally {
      f.database.close();
    }
  });

  test("parallel=false without callable tools stays native and retains token controls", async () => {
    const f = fidelityFixture();
    try {
      const response = await f.send({
        ...basic,
        parallel_tool_calls: false,
        max_output_tokens: 32,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-kiro-transport")).toBe("native");
      expect(((await response.json()) as TestResponse).parallel_tool_calls).toBe(false);
      expect(f.requests[0]?.max_output_tokens).toBe(32);
    } finally {
      f.database.close();
    }
  });

  test("compatible tool control reports the loss; strict rejects before generation", async () => {
    for (const mode of ["compatible", "strict"] as const) {
      const f = fidelityFixture({ parallelCalls: true, config: { responses_fidelity_mode: mode } });
      try {
        const response = await f.send({
          ...basic,
          parallel_tool_calls: false,
          tools: ["a", "b"].map((name) => ({
            type: "function",
            name,
            parameters: { type: "object" },
          })),
        });
        expect(response.status).toBe(mode === "strict" ? 400 : 200);
        if (mode === "compatible") {
          expect(response.headers.get("x-kiro-compatibility")).toContain(
            "parallel_tool_calls_unenforced",
          );
          expect(((await response.json()) as TestResponse).output).toHaveLength(2);
        } else expect(f.canonical).toHaveLength(0);
      } finally {
        f.database.close();
      }
    }
  });

  test("explicit effort wins over the alias on both transports, including none", async () => {
    for (const effort of ["low", "none"] as const) {
      const f = fidelityFixture();
      try {
        for (const store of [true, false]) {
          await f.send({ ...basic, model: "gpt-5.6-sol-xhigh", reasoning: { effort }, store });
        }
        expect(f.requests[0]?.reasoning).toMatchObject({ effort });
        const canonical = f.canonical[0];
        if (!canonical) throw new Error("Missing canonical request");
        const sdk = transformToSdkRequest(
          canonical,
          canonical.model,
          f.dependencies.accountManager.toAuthDetails(f.primary),
        );
        expect(sdk.effort).toBe(effort === "none" ? undefined : effort);
      } finally {
        f.database.close();
      }
    }
  });

  test("keeps an intermediate instruction at its original turn boundary", async () => {
    const f = fidelityFixture();
    try {
      await f.send({
        model: "claude-opus-5",
        input: [
          { role: "user", content: "FIRST" },
          { role: "assistant", content: "ANSWER" },
          { role: "developer", content: "NEW_POLICY" },
          { role: "user", content: "SECOND" },
        ],
      });
      const canonical = f.canonical[0];
      if (!canonical) throw new Error("Missing canonical request");
      const sdk = transformToSdkRequest(
        canonical,
        canonical.model,
        f.dependencies.accountManager.toAuthDetails(f.primary),
      );
      expect(sdk.conversationState.history?.[0]?.userInputMessage?.content).toBe("FIRST");
      expect(sdk.conversationState.currentMessage.userInputMessage?.content).toBe(
        "NEW_POLICY\n\nSECOND",
      );
    } finally {
      f.database.close();
    }
  });

  test("normalizes easy messages in input_items with stable IDs", async () => {
    const f = fidelityFixture();
    try {
      const body = (await (
        await f.send({ ...basic, input: [{ role: "user", content: "Hi" }] })
      ).json()) as TestResponse;
      const read = () =>
        handleStoredResponse(
          new Request("http://gateway"),
          f.dependencies,
          body.id,
          "input_items",
        ).json() as Promise<TestResponse>;
      const first = await read();
      expect(first.data[0]).toMatchObject({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Hi" }],
      });
      expect(await read()).toEqual(first);
    } finally {
      f.database.close();
    }
  });

  test("cancellation while waiting for an account queue returns a typed error and releases the waiter", async () => {
    const f = fidelityFixture();
    const release = await acquireAccountQueue(f.primary.id, new AbortController().signal);
    try {
      const controller = new AbortController();
      const request = f.send(basic, {}, controller.signal);
      await Bun.sleep(5);
      controller.abort();
      expect((await request).status).toBe(499);
      expect(f.requests).toHaveLength(0);
    } finally {
      release();
      f.database.close();
    }
  });
});

describe("native Responses stream contract", () => {
  test.each([false, true])(
    "rejects an upstream tool_choice=none violation, stream=%s",
    async (stream) => {
      const item = {
        type: "function_call",
        id: "fc_wrong",
        call_id: "call_wrong",
        name: "echo",
        arguments: "{}",
        status: "completed",
      };
      const f = fidelityFixture({
        native: () =>
          stream
            ? new Response(
                [
                  textEvents()[0],
                  { type: "response.output_item.added", sequence_number: 1, output_index: 0, item },
                ]
                  .map(sse)
                  .join(""),
                { headers: { "Content-Type": "text/event-stream" } },
              )
            : Response.json({ ...nativeResponse("resp_wrong"), output: [item] }),
      });
      try {
        const response = await f.send({
          ...basic,
          stream,
          tool_choice: "none",
          parallel_tool_calls: false,
          tools: [{ type: "function", name: "echo", parameters: { type: "object" } }],
        });
        expect(response.status).toBe(502);
        expect(await response.text()).toContain("upstream_tool_choice_violation");
        expect(f.requests).toHaveLength(1);
      } finally {
        f.database.close();
      }
    },
  );

  test.each([false, true])(
    "idle timeout is explicit before/after publication: %s",
    async (published) => {
      let cancelled = false;
      const f = fidelityFixture({
        config: { stream_idle_timeout_ms: 10 },
        native: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                if (published)
                  controller.enqueue(
                    new TextEncoder().encode(textEvents().slice(0, 4).map(sse).join("")),
                  );
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
      });
      try {
        const response = await f.send({ ...basic, stream: true });
        expect(response.status).toBe(published ? 200 : 502);
        expect(await response.text()).toContain("upstream_stream_idle_timeout");
        await Bun.sleep(1);
        expect(cancelled).toBe(true);
        const release = await acquireAccountQueue(f.primary.id, AbortSignal.timeout(200));
        release();
      } finally {
        f.database.close();
      }
    },
  );

  test("prepublication deadline retains HTTP 504 and client abort retains 499", async () => {
    for (const client of [false, true]) {
      const f = fidelityFixture({
        config: { request_timeout_ms: 20, stream_idle_timeout_ms: 1000 },
        native: () =>
          new Response(new ReadableStream<Uint8Array>(), {
            headers: { "Content-Type": "text/event-stream" },
          }),
      });
      try {
        const abort = new AbortController();
        const request = f.send({ ...basic, stream: true }, {}, abort.signal);
        if (client) {
          await Bun.sleep(2);
          abort.abort();
        }
        expect((await request).status).toBe(client ? 499 : 504);
      } finally {
        f.database.close();
      }
    }
  });

  test("a slow consumer can cancel without retaining the account lease", async () => {
    const f = fidelityFixture({
      native: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(textEvents().slice(0, 4).map(sse).join("")),
              );
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    try {
      const response = await f.send({ ...basic, stream: true });
      await response.body?.cancel();
      const release = await acquireAccountQueue(f.primary.id, AbortSignal.timeout(200));
      release();
    } finally {
      f.database.close();
    }
  });

  test.each(["application/json", "text/plain"])(
    "rejects success with content type %s",
    async (contentType) => {
      const f = fidelityFixture({
        native: () =>
          new Response('{"message":"not SSE"}', { headers: { "Content-Type": contentType } }),
      });
      try {
        const response = await f.send({ ...basic, stream: true });
        expect(response.status).toBe(502);
        expect(((await response.json()) as TestResponse).error.code).toBe(
          "invalid_upstream_response",
        );
      } finally {
        f.database.close();
      }
    },
  );

  test.each(["data: {broken}\n\n", "data: [DONE]\n\n", ""])(
    "rejects unusable prepublication data %j",
    async (data) => {
      const f = fidelityFixture({
        native: () => new Response(data, { headers: { "Content-Type": "text/event-stream" } }),
      });
      try {
        expect((await f.send({ ...basic, stream: true })).status).toBe(502);
      } finally {
        f.database.close();
      }
    },
  );

  test("turns postpublication EOF into one failed event", async () => {
    const f = fidelityFixture({
      native: () =>
        new Response(textEvents().slice(0, 4).map(sse).join(""), {
          headers: { "Content-Type": "text/event-stream" },
        }),
    });
    try {
      const response = await f.send({ ...basic, stream: true });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text.match(/event: response.failed/g)).toHaveLength(1);
      expect(text).toContain("upstream_stream_incomplete");
      expect(text).not.toContain("response.completed");
      expect(f.responseStore.get("fidelity-test", "resp_stream")).toBeUndefined();
      expect(f.requests).toHaveLength(1);
    } finally {
      f.database.close();
    }
  });

  test("retries prepublication EOF while holding the lease and hides the abandoned response ID", async () => {
    let leaseHeldDuringRetry = false;
    const f = fidelityFixture({
      config: { stream_max_attempts: 2 },
      native: async (_body, call) => {
        if (call === 2) {
          try {
            const release = await acquireAccountQueue(f.primary.id, AbortSignal.timeout(5));
            release();
          } catch {
            leaseHeldDuringRetry = true;
          }
        }
        return new Response(
          (call === 1 ? textEvents("resp_abandoned").slice(0, 3) : textEvents("resp_kept"))
            .map(sse)
            .join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    try {
      const response = await f.send({ ...basic, stream: true });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(f.requests).toHaveLength(2);
      expect(leaseHeldDuringRetry).toBe(true);
      expect(text).toContain("resp_kept");
      expect(text).not.toContain("resp_abandoned");
      expect(text).not.toContain("response.failed");
      expect(f.responseStore.get("fidelity-test", "resp_abandoned")).toBeUndefined();
      expect(f.responseStore.get("fidelity-test", "resp_kept")).toBeDefined();
      const release = await acquireAccountQueue(f.primary.id, AbortSignal.timeout(100));
      release();
    } finally {
      f.database.close();
    }
  });

  test("exhausts the shared HTTP budget across prepublication stream retries", async () => {
    const f = fidelityFixture({
      config: { rate_limit_max_retries: 1, stream_max_attempts: 3 },
      native: (_body, call) =>
        call === 2
          ? new Response(textEvents("resp_abandoned").slice(0, 1).map(sse).join(""), {
              headers: { "Content-Type": "text/event-stream" },
            })
          : Response.json({ error: { message: "unavailable" } }, { status: 503 }),
    });
    try {
      const response = await f.send({ ...basic, stream: true });
      expect(response.status).toBe(502);
      expect(f.requests).toHaveLength(3);
    } finally {
      f.database.close();
    }
  });

  test("handles one-byte chunks, CRLF, comments, and an unterminated terminal frame", async () => {
    const frames = `: heartbeat\n\n${textEvents().map(sse).join("")}`
      .replaceAll('"OK"', '"你好🌐"')
      .trimEnd()
      .replaceAll("\n", "\r\n");
    const bytes = new TextEncoder().encode(frames);
    const f = fidelityFixture({
      native: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    try {
      const response = await f.send({ ...basic, stream: true });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("response.completed");
      expect(text).toContain("你好🌐");
      expect(text).not.toContain("�");
      expect(
        f.responseStore.get("fidelity-test", "resp_stream")?.continuation?.owner?.accountId,
      ).toBe(f.accounts[0]?.id);
    } finally {
      f.database.close();
    }
  });

  test("preserves a genuine incomplete terminal reason", async () => {
    const events = [
      ...textEvents().slice(0, -1),
      {
        type: "response.incomplete",
        sequence_number: 7,
        response: {
          ...nativeResponse("resp_stream"),
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        },
      },
    ];
    const f = fidelityFixture({
      native: () =>
        new Response(events.map(sse).join(""), {
          headers: { "Content-Type": "text/event-stream" },
        }),
    });
    try {
      const text = await (await f.send({ ...basic, stream: true })).text();
      expect(text).toContain("response.incomplete");
      expect(text).toContain("max_output_tokens");
      expect(text).not.toContain("response.failed");
    } finally {
      f.database.close();
    }
  });

  test.each([false, true])("rejects duplicate terminal events, split=%s", async (split) => {
    const terminal = textEvents().at(-1);
    const frames = textEvents().map(sse);
    const f = fidelityFixture({
      native: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(frames.join("") + (split ? "" : sse(terminal))));
              if (split) controller.enqueue(encoder.encode(sse(terminal)));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    try {
      const response = await f.send({ ...basic, stream: true });
      const text = await response.text();
      expect(text).toContain("upstream_protocol_error");
      expect(text.match(/event: response.failed/g)).toHaveLength(1);
      expect(text).not.toContain("event: response.completed");
      expect(f.responseStore.get("fidelity-test", "resp_stream")).toBeUndefined();
      expect(f.requests).toHaveLength(1);
    } finally {
      f.database.close();
    }
  });

  test("accepts DONE only after a valid terminal response", async () => {
    let upstreamSignal: AbortSignal | null | undefined;
    const f = fidelityFixture({
      native: (_body, _call, init) => {
        upstreamSignal = init?.signal;
        return new Response(`${textEvents().map(sse).join("")}data: [DONE]\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });
    try {
      const text = await (await f.send({ ...basic, stream: true })).text();
      expect(text.match(/event: response.completed/g)).toHaveLength(1);
      expect(text).not.toContain("event: response.failed");
      expect(upstreamSignal?.aborted).toBe(false);
    } finally {
      f.database.close();
    }
  });

  test.each(["sequence", "identity", "status"])(
    "rejects contradictory %s after partial output",
    async (kind) => {
      const terminal = {
        type: "response.completed",
        sequence_number: kind === "sequence" ? 0 : 7,
        response: {
          ...nativeResponse(kind === "identity" ? "resp_wrong" : "resp_stream"),
          status: kind === "status" ? "failed" : "completed",
        },
      };
      const f = fidelityFixture({
        native: () =>
          new Response([...textEvents().slice(0, 4), terminal].map(sse).join(""), {
            headers: { "Content-Type": "text/event-stream" },
          }),
      });
      try {
        const text = await (await f.send({ ...basic, stream: true })).text();
        expect(text).toContain("response.failed");
        expect(text).toContain("upstream_protocol_error");
        expect(text).not.toContain("event: response.completed");
      } finally {
        f.database.close();
      }
    },
  );
});

describe("native retry-after", () => {
  test.each([true, false])(
    "returns throttling instead of waiting past the ingress deadline, header=%s",
    async (withHeader) => {
      const f = fidelityFixture({
        config: {
          request_timeout_ms: 100,
          rate_limit_retry_delay_ms: 1000,
          rate_limit_max_retries: 3,
        },
        native: () =>
          Response.json(
            { message: "busy" },
            { status: 429, headers: withHeader ? { "Retry-After": "15" } : {} },
          ),
      });
      try {
        const response = await f.send(basic);
        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe(withHeader ? "15" : "1");
        expect(f.requests).toHaveLength(1);
      } finally {
        f.database.close();
      }
    },
  );

  test("retries network failures within the configured transport budget", async () => {
    const f = fidelityFixture({
      config: { rate_limit_max_retries: 1 },
      native: (_body, call) => {
        if (call === 1) throw new TypeError("connection reset");
        return Response.json(nativeResponse("resp_reconnected"));
      },
    });
    try {
      const response = await f.send(basic);
      expect(response.status).toBe(200);
      expect(f.requests).toHaveLength(2);
    } finally {
      f.database.close();
    }
  });

  test("distinguishes missing, zero, seconds, and HTTP dates", () => {
    expect(nativeRetryDelay(new Response(), 123)).toBe(123);
    expect(nativeRetryDelay(new Response(null, { headers: { "retry-after": "0" } }), 123)).toBe(0);
    expect(nativeRetryDelay(new Response(null, { headers: { "retry-after": "15" } }), 123)).toBe(
      15000,
    );
    expect(
      nativeRetryDelay(
        new Response(null, { headers: { "retry-after": new Date(30000).toUTCString() } }),
        123,
        10000,
      ),
    ).toBe(20000);
    expect(
      nativeRetryDelay(new Response(null, { headers: { "retry-after": "invalid" } }), 123),
    ).toBe(123);
  });

  test("returns retry-after to the caller and honors the bounded retry budget", async () => {
    const f = fidelityFixture({
      config: { rate_limit_max_retries: 1 },
      native: () =>
        Response.json(
          { message: "busy", reason: "throttled" },
          { status: 429, headers: { "Retry-After": "0.001" } },
        ),
    });
    try {
      const response = await f.send(basic);
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("0.001");
      expect(f.requests).toHaveLength(2);
    } finally {
      f.database.close();
    }
  });
});
