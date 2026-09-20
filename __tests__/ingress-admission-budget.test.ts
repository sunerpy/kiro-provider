import { describe, expect, test } from "bun:test";
import { captureAuditEvents } from "./audit-test-helpers.js";
import {
  FABLE_MODEL,
  MESSAGES_FIXTURE_KEY,
  messagesFixture,
} from "./messages-regression-helpers.js";

const payload = {
  model: FABLE_MODEL,
  max_tokens: 1024,
  messages: [{ role: "user", content: "Admission fixture." }],
};
const encoded = new TextEncoder().encode(JSON.stringify(payload));

function pausedUpload(initial?: Uint8Array) {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = 0;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
      },
      pull() {
        pulls++;
      },
      cancel() {
        cancelled++;
      },
    },
    { highWaterMark: 0 },
  );
  if (initial) controller?.enqueue(initial);
  return {
    body,
    finish() {
      controller?.enqueue(encoded);
      controller?.close();
    },
    cancelled: () => cancelled,
    pulls: () => pulls,
  };
}

function uploadRequest(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  return new Request("http://fixture/v1/messages", {
    method: "POST",
    headers: { "x-api-key": MESSAGES_FIXTURE_KEY, "Content-Type": "application/json", ...headers },
    body,
  });
}

describe("Shared HTTP admission before request-body parsing", () => {
  test("retains capacity after an error body closes until upstream teardown completes", async () => {
    const closing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const fixture = messagesFixture(undefined, {
      config: {
        max_inflight_requests: 1,
        max_request_body_bytes: 1024,
        max_inflight_request_body_bytes: 1024,
      },
      stream: () => {
        if (++calls > 1) {
          return (async function* () {
            yield { assistantResponseEvent: { content: "RECOVERED" } };
            yield {
              metadataEvent: { tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
            };
          })();
        }
        return {
          [Symbol.asyncIterator]() {
            let read = 0;
            return {
              async next() {
                if (read++ === 0) {
                  return {
                    done: false as const,
                    value: { assistantResponseEvent: { content: "PARTIAL" } },
                  };
                }
                throw new Error("synthetic transport failure");
              },
              async return() {
                closing.resolve();
                await release.promise;
                return { done: true as const, value: undefined };
              },
            };
          },
        };
      },
    });
    try {
      const first = await fixture.request({ ...payload, stream: true });
      const output = first.text();
      await closing.promise;
      expect(await output).toContain("event: error");
      const rejected = await fixture.request(payload);
      expect(rejected.status).toBe(503);
      await rejected.text();
      expect(fixture.inputs).toHaveLength(1);
      release.resolve();
      await Bun.sleep(1);
      const recovered = await fixture.request(payload);
      expect(recovered.status).toBe(200);
      expect(await recovered.text()).toContain("RECOVERED");
    } finally {
      release.resolve();
    }
  });

  test("rejects the next upload before reading it or dispatching upstream", async () => {
    const fixture = messagesFixture(undefined, {
      config: {
        max_inflight_requests: 1,
        max_request_body_bytes: 1024,
        max_inflight_request_body_bytes: 2048,
      },
    });
    const first = pausedUpload();
    const pending = fixture.app(uploadRequest(first.body));
    await Bun.sleep(1);
    const second = pausedUpload();
    const rejected = await fixture.app(uploadRequest(second.body));
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get("Retry-After")).toBe("1");
    expect(await rejected.json()).toMatchObject({ error: { type: "overloaded_error" } });
    expect(second.pulls()).toBe(0);
    expect(second.cancelled()).toBe(1);
    expect(fixture.inputs).toHaveLength(0);
    expect((await fixture.app(new Request("http://fixture/health"))).status).toBe(200);
    first.finish();
    await (await pending).text();
    expect(fixture.inputs).toHaveLength(1);
    const next = await fixture.request(payload);
    expect(next.status).toBe(200);
    await next.text();
    expect(fixture.inputs).toHaveLength(2);
  });

  test("enforces aggregate bytes for unknown and dishonest Content-Length", async () => {
    const fixture = messagesFixture(undefined, {
      config: {
        max_inflight_requests: 8,
        max_request_body_bytes: 1024,
        max_inflight_request_body_bytes: 2048,
      },
    });
    const uploads = [pausedUpload(), pausedUpload()];
    const pending = uploads.map((upload) =>
      fixture.app(uploadRequest(upload.body, { "Content-Length": "1" })),
    );
    await Bun.sleep(1);
    const denied = pausedUpload();
    const response = await fixture.app(uploadRequest(denied.body));
    expect(response.status).toBe(503);
    await response.text();
    expect(denied.pulls()).toBe(0);
    expect(denied.cancelled()).toBe(1);
    for (const upload of uploads) upload.finish();
    await Promise.all(pending.map(async (result) => (await result).text()));
    expect(fixture.inputs).toHaveLength(2);
  });

  test("authentication happens before capacity disclosure or body reads", async () => {
    const fixture = messagesFixture(undefined, {
      config: {
        max_inflight_requests: 1,
        max_request_body_bytes: 1024,
        max_inflight_request_body_bytes: 1024,
      },
    });
    const first = pausedUpload();
    const pending = fixture.app(uploadRequest(first.body));
    const unauthorized = pausedUpload();
    const response = await fixture.app(
      uploadRequest(unauthorized.body, { "x-api-key": "invalid-fixture" }),
    );
    expect(response.status).toBe(401);
    expect(unauthorized.pulls()).toBe(0);
    first.finish();
    await (await pending).text();
  });

  test("keeps parsed, queued and streaming requests inside the same budget", async () => {
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const fixture = messagesFixture(undefined, {
      config: {
        max_inflight_requests: 1,
        max_request_body_bytes: 1024,
        max_inflight_request_body_bytes: 1024,
      },
      stream: () =>
        (async function* () {
          yield { assistantResponseEvent: { content: "STARTED" } };
          reached.resolve();
          await gate.promise;
          yield {
            metadataEvent: { tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
          };
        })(),
    });
    const response = await fixture.request({ ...payload, stream: true });
    const consumed = response.text();
    await reached.promise;
    const denied = await fixture.request(payload);
    expect(denied.status).toBe(503);
    await denied.text();
    expect(fixture.inputs).toHaveLength(1);
    gate.resolve();
    await consumed;
    const next = await fixture.request(payload);
    expect(next.status).toBe(200);
    await next.text();
  });

  test("rejects overflow on Responses and count_tokens using their own envelopes", async () => {
    const fixture = messagesFixture(undefined, {
      config: {
        max_inflight_requests: 1,
        max_request_body_bytes: 1024,
        max_inflight_request_body_bytes: 1024,
      },
    });
    const first = pausedUpload();
    const pending = fixture.app(uploadRequest(first.body));
    const responses = await fixture.request({ input: "fixture" }, "/v1/responses");
    expect(responses.status).toBe(503);
    expect(await responses.json()).toMatchObject({ error: { code: "request_capacity_exceeded" } });
    const count = await fixture.request(payload, "/v1/messages/count_tokens");
    expect(count.status).toBe(503);
    expect(await count.json()).toMatchObject({ error: { type: "overloaded_error" } });
    first.finish();
    await (await pending).text();
  });

  test("invalid JSON, oversized input and cancelled upload release all reservations", async () => {
    const audit = captureAuditEvents();
    try {
      const fixture = messagesFixture(undefined, {
        config: {
          max_inflight_requests: 1,
          max_request_body_bytes: 1024,
          max_inflight_request_body_bytes: 1024,
          request_timeout_ms: 25,
        },
      });
      for (const raw of ["{", " ".repeat(1025)]) {
        const response = await fixture.app(
          new Request("http://fixture/v1/messages", {
            method: "POST",
            headers: { "x-api-key": MESSAGES_FIXTURE_KEY },
            body: raw,
          }),
        );
        expect(response.status).toBe(raw.length > 1024 ? 413 : 400);
        await response.text();
      }
      const upload = pausedUpload();
      const response = await fixture.app(uploadRequest(upload.body));
      expect(response.status).toBe(504);
      await response.text();
      expect(upload.cancelled()).toBe(1);
      const release = audit.events("request_admission_released").at(-1);
      expect(release).toMatchObject({ active_requests: 0, reserved_body_bytes: 0 });
      expect(fixture.inputs).toHaveLength(0);
    } finally {
      audit.restore();
    }
  });
});
