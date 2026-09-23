import { describe, expect, test } from "bun:test";
import { createConnection } from "node:net";
import type { Config } from "../src/config/schema.js";
import { buildServeOptions } from "../src/server/app.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import { callIds, codexBody, IMAGE_COUNT, screenshot } from "./fixtures/responses-large-body.js";
import { MESSAGES_FIXTURE_KEY, messagesFixture } from "./messages-regression-helpers.js";

const MIB = 1024 * 1024;
function loopback(config: Partial<Config> = {}) {
  const fixture = messagesFixture([{ assistantResponseEvent: { content: "LARGE_BODY_OK" } }], {
    config: { port: 0, request_timeout_ms: 10_000, ...config },
  });
  const server = Bun.serve(buildServeOptions(fixture.config, fixture.dependencies));
  return {
    ...fixture,
    server,
    post(
      body: string | ReadableStream<Uint8Array>,
      key = MESSAGES_FIXTURE_KEY,
      signal?: AbortSignal,
    ) {
      return fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
        method: "POST",
        // Isolate each probe from Bun connection reuse after unread 401/413 bodies.
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Connection: "close",
        },
        body,
        signal,
      });
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<boolean> {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(5);
  }
  return predicate();
}

/**
 * Observe Bun's header-level 413 before sending a multi-megabyte body. Native
 * Windows fetch can otherwise surface the server's early close as ECONNRESET
 * while it is still uploading, hiding the HTTP status from the test harness.
 */
function rejectedUploadStatus(port: number, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let headers = "";
    let finished = false;
    const finish = (error?: Error, status?: number): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else if (status !== undefined) resolve(status);
    };
    const timer = setTimeout(() => finish(new Error("missing oversized upload rejection")), 3000);
    socket.on("error", (error) => finish(error));
    socket.on("close", () => {
      if (!finished) finish(new Error("connection closed without an HTTP rejection"));
    });
    socket.on("data", (bytes) => {
      headers += bytes.toString("utf8");
      if (!headers.includes("\r\n\r\n")) return;
      const status = /^HTTP\/1\.[01] (\d{3}) /.exec(headers)?.[1];
      if (status === undefined) finish(new Error("invalid HTTP rejection"));
      else finish(undefined, Number(status));
    });
    socket.on("connect", () =>
      socket.write(
        [
          "POST /v1/responses HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          `Authorization: Bearer ${MESSAGES_FIXTURE_KEY}`,
          "Content-Type: application/json",
          `Content-Length: ${Buffer.byteLength(body)}`,
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      ),
    );
  });
}

describe("Codex screenshot history across the real HTTP body limit", () => {
  test.each([false, true])(
    "default accepts fourteen historical screenshots above 10 MiB, stream=%s",
    async (stream) => {
      const audit = captureAuditEvents();
      const run = loopback();
      try {
        const body = codexBody(stream);
        expect(Buffer.byteLength(body)).toBeGreaterThan(10 * MIB);
        expect(Buffer.byteLength(body)).toBeLessThan(32 * MIB);
        const response = await run.post(body);
        expect(response.status).toBe(200);
        const output = await response.text();
        if (stream) {
          expect(response.headers.get("content-type")).toContain("text/event-stream");
          const events = output
            .split("\n")
            .filter((line) => line.startsWith("data: {"))
            .map((line) => JSON.parse(line.slice(6)) as { type: string });
          expect(events[0]?.type).toBe("response.created");
          expect(events.filter((event) => event.type === "response.completed")).toHaveLength(1);
          expect(events.at(-1)?.type).toBe("response.completed");
          expect(output).not.toContain("response.failed");
        } else {
          expect(JSON.parse(output)).toMatchObject({ status: "completed" });
        }
        expect(output).toContain("LARGE_BODY_OK");
        expect(run.inputs).toHaveLength(1);
        const conversation = run.inputs[0]?.conversationState;
        const messages = [
          ...(conversation?.history ?? []),
          ...(conversation?.currentMessage ? [conversation.currentMessage] : []),
        ];
        const images = messages.flatMap((item) => item.userInputMessage?.images ?? []);
        expect(images).toHaveLength(IMAGE_COUNT);
        expect(
          images.every((item) => Buffer.from(item.source?.bytes ?? []).equals(screenshot)),
        ).toBe(true);
        const results = messages.flatMap(
          (item) => item.userInputMessage?.userInputMessageContext?.toolResults ?? [],
        );
        expect(results.map((item) => item.toolUseId)).toEqual(callIds);
        expect(results.every((item) => item.status === "success")).toBe(true);
        const calls = messages.flatMap((item) => item.assistantResponseMessage?.toolUses ?? []);
        expect(calls.map((item) => item.toolUseId)).toEqual(callIds);
        expect(
          await waitFor(
            () => audit.events("request_admission_released").at(-1)?.active_requests === 0,
          ),
        ).toBe(true);
        expect(audit.events("request_admission_released").at(-1)).toMatchObject({
          active_requests: 0,
          reserved_body_bytes: 0,
        });
        expect(JSON.stringify(audit.events())).not.toContain("data:image");
      } finally {
        await run.server.stop(true);
        audit.restore();
      }
    },
  );

  test("an explicit legacy 10 MiB limit still refuses the same screenshot history", async () => {
    const run = loopback({ max_request_body_bytes: 10 * MIB });
    try {
      expect(await rejectedUploadStatus(run.server.port as number, codexBody())).toBe(413);
      expect(run.inputs).toHaveLength(0);
      const recovered = await run.post(codexBody(false, 1));
      expect(recovered.status).toBe(200);
      expect(await recovered.text()).toContain("LARGE_BODY_OK");
    } finally {
      await run.server.stop(true);
    }
  });

  test("the default still rejects requests above 32 MiB before upstream dispatch", async () => {
    const run = loopback();
    try {
      const oversized = codexBody(false, 43);
      expect(Buffer.byteLength(oversized)).toBeGreaterThan(32 * MIB);
      expect(await rejectedUploadStatus(run.server.port as number, oversized)).toBe(413);
      expect(run.inputs).toHaveLength(0);
      const recovered = await run.post(codexBody(false, 1));
      expect(recovered.status).toBe(200);
      await recovered.text();
    } finally {
      await run.server.stop(true);
    }
  });

  test("large unauthorized requests acquire no budget and never dispatch upstream", async () => {
    const audit = captureAuditEvents();
    const run = loopback();
    try {
      const response = await run.post(codexBody(), "invalid-fixture-key");
      expect(response.status).toBe(401);
      await response.text();
      expect(audit.events("request_admission_acquired")).toHaveLength(0);
      expect(run.inputs).toHaveLength(0);
      const recovered = await run.post(codexBody());
      expect(recovered.status).toBe(200);
      await recovered.text();
    } finally {
      await run.server.stop(true);
      audit.restore();
    }
  });

  test("four unfinished uploads exhaust the unchanged 128 MiB budget and cancellation releases it", async () => {
    const audit = captureAuditEvents();
    const run = loopback();
    const controllers: AbortController[] = [];
    const pending: Promise<unknown>[] = [];
    try {
      expect(run.config.max_inflight_requests).toBe(16);
      expect(run.config.max_inflight_request_body_bytes).toBe(128 * MIB);
      for (let index = 0; index < 4; index++) {
        const abort = new AbortController();
        controllers.push(abort);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(64 * 1024).fill(32));
          },
        });
        pending.push(
          run.post(body, MESSAGES_FIXTURE_KEY, abort.signal).then(
            (response) => response.arrayBuffer(),
            () => undefined,
          ),
        );
      }
      expect(await waitFor(() => audit.events("request_admission_acquired").length === 4)).toBe(
        true,
      );
      const rejected = await run.post(codexBody(false, 1));
      expect(rejected.status).toBe(503);
      expect(await rejected.json()).toMatchObject({ error: { code: "request_capacity_exceeded" } });
      expect(audit.events("request_admission_rejected").at(-1)).toMatchObject({
        reason: "body_budget",
        active_requests: 4,
        reserved_body_bytes: 128 * MIB,
      });
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(pending);
      expect(
        await waitFor(
          () => audit.events("request_admission_released").at(-1)?.active_requests === 0,
        ),
      ).toBe(true);
      expect(audit.events("request_admission_released").at(-1)).toMatchObject({
        active_requests: 0,
        reserved_body_bytes: 0,
      });
      expect(run.inputs).toHaveLength(0);
      const recovered = await run.post(codexBody());
      expect(recovered.status).toBe(200);
      expect(await recovered.text()).toContain("LARGE_BODY_OK");
    } finally {
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(pending);
      await run.server.stop(true);
      audit.restore();
    }
  });
});
