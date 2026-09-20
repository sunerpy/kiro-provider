import { describe, expect, test } from "bun:test";
import { buildServeOptions } from "../src/server/app.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import { MESSAGES_FIXTURE_KEY, messagesFixture } from "./messages-regression-helpers.js";

async function waitFor(predicate: () => boolean, timeout = 1000): Promise<boolean> {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(5);
  }
  return predicate();
}

describe("real HTTP upload disconnect admission cleanup", () => {
  test("releases a closed body reader even before the request signal flips", async () => {
    const fixture = messagesFixture(undefined, {
      config: {
        max_inflight_requests: 1,
        max_request_body_bytes: 1024,
        max_inflight_request_body_bytes: 1024,
      },
    });
    const request = new Request("http://fixture/v1/messages", {
      method: "POST",
      headers: { "x-api-key": MESSAGES_FIXTURE_KEY },
      body: new ReadableStream({
        start(controller) {
          controller.error(new DOMException("The connection was closed.", "AbortError"));
        },
      }),
    });
    expect(request.signal.aborted).toBe(false);
    const closed = await fixture.app(request);
    expect(closed.status).toBe(499);
    const recovered = await fixture.request(
      { messages: [{ role: "user", content: "fixture" }] },
      "/v1/messages/count_tokens",
    );
    expect(recovered.status).toBe(200);
    await recovered.text();
    expect(await closed.json()).toMatchObject({ type: "error", error: { type: "api_error" } });
    expect(fixture.inputs).toHaveLength(0);
  });

  test("releases disconnected uploads even when Bun never consumes their 499 bodies", async () => {
    const audit = captureAuditEvents();
    const fixture = messagesFixture(undefined, {
      config: {
        port: 0,
        request_timeout_ms: 3000,
        max_request_body_bytes: 512 * 1024,
        max_inflight_requests: 2,
        max_inflight_request_body_bytes: 1024 * 1024,
      },
    });
    const server = Bun.serve(buildServeOptions(fixture.config, fixture.dependencies));
    const controllers: AbortController[] = [];
    const pending: Promise<unknown>[] = [];
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const headers = { "Content-Type": "application/json", "x-api-key": MESSAGES_FIXTURE_KEY };
      for (let index = 0; index < 2; index++) {
        const controller = new AbortController();
        controllers.push(controller);
        let sent = false;
        const body = new ReadableStream<Uint8Array>({
          pull(stream) {
            if (sent) return;
            sent = true;
            stream.enqueue(new Uint8Array(256 * 1024).fill(32));
          },
        });
        pending.push(
          fetch(`${base}/v1/messages`, {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
          }).then(
            (response) => response.arrayBuffer(),
            () => undefined,
          ),
        );
      }
      expect(await waitFor(() => audit.events("request_admission_acquired").length === 2)).toBe(
        true,
      );
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(pending);
      expect(
        await waitFor(
          () => audit.events("request_admission_released").at(-1)?.active_requests === 0,
        ),
      ).toBe(true);
      const response = await fetch(`${base}/v1/messages/count_tokens`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "claude-fable-5-1",
          messages: [{ role: "user", content: "fixture" }],
        }),
      });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(audit.events("request_admission_released").at(-1)).toMatchObject({
        active_requests: 0,
        reserved_body_bytes: 0,
      });
      expect(fixture.inputs).toHaveLength(0);
    } finally {
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(pending);
      await server.stop(true);
      audit.restore();
    }
  });
});
