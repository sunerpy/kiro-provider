import { describe, expect, test } from "bun:test";
import { pendingAccountCapacityCount } from "../src/core/account-capacity.js";
import { accountQueueDepth } from "../src/core/pipeline-runtime.js";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import { messagesFixture, messagesSseEvents } from "./messages-regression-helpers.js";

const prefix: SdkStreamEvent[] = [
  { reasoningContentEvent: { signature: "fixture-prefix-a" } },
  { reasoningContentEvent: { signature: "fixture-prefix-b" } },
];
const body = {
  messages: [{ role: "user", content: "Synthetic lifecycle fixture." }],
  thinking: { type: "adaptive", display: "omitted" },
};
function stalledSource() {
  const waiting = Promise.withResolvers<void>();
  const read = Promise.withResolvers<IteratorResult<SdkStreamEvent>>();
  let closed = 0;
  const stream: AsyncIterable<SdkStreamEvent> = {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next() {
          const value = prefix[index++];
          if (value) return Promise.resolve({ value, done: false as const });
          waiting.resolve();
          return read.promise;
        },
        return() {
          closed++;
          read.resolve({ value: undefined, done: true });
          return Promise.resolve({ value: undefined, done: true as const });
        },
      };
    },
  };
  return { stream, waiting: waiting.promise, closed: () => closed };
}

describe("Fable prepublication prefix lifecycle", () => {
  for (const stream of [false, true]) {
    test(`client cancellation before prefix classification cleans up (${stream})`, async () => {
      const source = stalledSource();
      const fixture = messagesFixture([], { stream: () => source.stream });
      const abort = new AbortController();
      let responded = false;
      const pending = fixture
        .request({ ...body, stream }, "/v1/messages", { signal: abort.signal })
        .then((response) => {
          responded = true;
          return response;
        });
      await source.waiting;
      expect(responded).toBe(false);
      abort.abort(new DOMException("Fixture client left", "AbortError"));
      const response = await pending;
      expect(response.status).toBe(499);
      await response.text();
      expect(source.closed()).toBe(1);
      expect(fixture.inputs).toHaveLength(1);
      expect(fixture.state.aborted).toBe(1);
      expect(pendingAccountCapacityCount()).toBe(0);
      expect(accountQueueDepth("messages-fixture-account")).toBe(0);
    });

    test.each([
      { idle: 15, deadline: 200, status: 502, provenance: "idle_timeout" },
      { idle: 200, deadline: 20, status: 504, provenance: "external_abort" },
    ])(
      `timeout owns cleanup without upstream replay (${stream}): %j`,
      async ({ idle, deadline, status, provenance }) => {
        const source = stalledSource();
        const audit = captureAuditEvents();
        try {
          const fixture = messagesFixture([], {
            config: { stream_idle_timeout_ms: idle, request_timeout_ms: deadline },
            stream: () => source.stream,
          });
          const response = await fixture.request({ ...body, stream });
          expect(response.status).toBe(status);
          expect(await response.text()).not.toContain("message_start");
          expect(source.closed()).toBe(1);
          expect(fixture.inputs).toHaveLength(1);
          expect(fixture.state.aborted).toBe(1);
          expect(pendingAccountCapacityCount()).toBe(0);
          expect(accountQueueDepth("messages-fixture-account")).toBe(0);
          expect(audit.events("sdk_stream_terminal")).toHaveLength(1);
          expect(audit.events("sdk_stream_terminal")[0]?.terminal_provenance).toBe(provenance);
          expect(audit.events("anthropic_output_reasoning_conflict_omitted")).toHaveLength(0);
        } finally {
          audit.restore();
        }
      },
    );
  }

  test("raw activity resets the idle timer while the header decision stays pending", async () => {
    const fixture = messagesFixture([], {
      config: { stream_idle_timeout_ms: 35, request_timeout_ms: 500 },
      stream: () =>
        (async function* () {
          yield* prefix;
          for (let i = 0; i < 5; i++) {
            await Bun.sleep(12);
            yield { contextUsageEvent: { contextUsagePercentage: 1 } };
          }
          yield { assistantResponseEvent: { content: "PREFIX_ALIVE" } };
          yield {
            metadataEvent: { tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
          };
        })(),
    });
    const response = await fixture.request({ ...body, stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-kiro-reasoning-replay-mode")).toBe("conflict-omitted");
    const events = messagesSseEvents(await response.text());
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.filter((event) => event.type === "message_stop")).toHaveLength(1);
    expect(fixture.inputs).toHaveLength(1);
  });

  test.each([false, true])(
    "retains the account lease until prefetch teardown settles (%s)",
    async (stream) => {
      const closing = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let requests = 0;
      const fixture = messagesFixture([], {
        config: { account_inference_concurrency: 1 },
        stream: () => {
          requests++;
          if (requests > 1) {
            return (async function* () {
              yield { assistantResponseEvent: { content: "SECOND_OK" } };
              yield {
                metadataEvent: { tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
              };
            })();
          }
          return {
            [Symbol.asyncIterator]() {
              const events = [...prefix, { reasoningContentEvent: { text: "unsafe" } }];
              let index = 0;
              return {
                next: async () => ({
                  value: events[index++] as SdkStreamEvent,
                  done: false as const,
                }),
                return: async () => {
                  closing.resolve();
                  await release.promise;
                  return { done: true as const, value: undefined };
                },
              };
            },
          };
        },
      });
      const first = fixture.request({ ...body, stream });
      await closing.promise;
      const second = fixture.request({ ...body, stream });
      await Bun.sleep(5);
      expect(fixture.inputs).toHaveLength(1);
      expect(accountQueueDepth("messages-fixture-account")).toBe(1);
      release.resolve();
      expect((await first).status).toBe(502);
      const continued = await second;
      expect(continued.status).toBe(200);
      expect(await continued.text()).toContain("SECOND_OK");
      expect(fixture.inputs).toHaveLength(2);
    },
  );
});
