import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { EventStreamCodec } from "@smithy/core/event-streams";
import { fromUtf8, toUtf8 } from "@smithy/core/serde";
import { ConfigSchema } from "../src/config/schema.js";
import type { PipelineAccountManager } from "../src/core/pipeline.js";
import { clearSdkClientCache } from "../src/core/sdk-client.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import { createApp } from "../src/server/app.js";

const codec = new EventStreamCodec(toUtf8, fromUtf8);
const args = JSON.stringify({ query: '中文\\line"ok' });
const firstArguments = args.slice(0, 12);
const laterArguments = args.slice(12);

function frame(type: string, body: unknown): Uint8Array {
  return codec.encode({
    headers: {
      ":message-type": { type: "string", value: "event" },
      ":event-type": { type: "string", value: type },
      ":content-type": { type: "string", value: "application/json" },
    },
    body: fromUtf8(JSON.stringify(body)),
  });
}

class Accounts implements PipelineAccountManager {
  readonly selected: ManagedAccount = {
    id: "delivery-fixture",
    email: "fixture@example.invalid",
    authMethod: "desktop",
    region: "us-east-1",
    refreshToken: "fixture-refresh",
    accessToken: "fixture-access",
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
  };
  reconcileFromDb(): readonly ManagedAccount[] {
    return [this.selected];
  }
  selectHealthyAccount(): ManagedAccount {
    return this.selected;
  }
  getAccountCount(): number {
    return 1;
  }
  toAuthDetails(account: ManagedAccount): KiroAuthDetails {
    return {
      refresh: account.refreshToken,
      access: account.accessToken,
      expires: account.expiresAt,
      authMethod: account.authMethod,
      region: account.region,
    };
  }
  markRateLimited(): void {}
  markUnhealthy(): void {}
}

function fixture(
  path: "responses" | "chat/completions",
  leadingText = false,
  initialMetadata = false,
) {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let requests = 0;
  const accepted = Promise.withResolvers<void>();
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests += 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
            if (initialMetadata)
              value.enqueue(frame("initial-response", { conversationId: "runtime-fixture" }));
            if (leadingText)
              value.enqueue(frame("assistantResponseEvent", { content: "Starting." }));
            value.enqueue(
              frame("toolUseEvent", {
                name: "lookup",
                toolUseId: "call-delivery",
                input: firstArguments,
              }),
            );
            accepted.resolve();
          },
        }),
        { headers: { "Content-Type": "application/vnd.amazon.eventstream" } },
      );
    },
  });
  const config = ConfigSchema.parse({
    api_keys: ["fixture-key"],
    protocol_projection_mode: "v3-auto",
    enable_legacy_chat_completions: true,
    test_upstream_endpoint: `http://127.0.0.1:${upstream.port}`,
    stream_max_attempts: 1,
    rate_limit_max_retries: 0,
    request_timeout_ms: 2_000,
    stream_idle_timeout_ms: 1_000,
  });
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createApp(config, {
      accountManager: new Accounts(),
      tokenRefresher: {
        refreshIfNeeded: async (account) => account,
        forceRefresh: async (account) => account,
      },
    }),
  });
  const abort = new AbortController();
  const tool = {
    name: "lookup",
    description: "Read the synthetic query",
    parameters: { type: "object" },
  };
  const pending = fetch(`http://127.0.0.1:${gateway.port}/v1/${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer fixture-key", "Content-Type": "application/json" },
    body: JSON.stringify(
      path === "responses"
        ? {
            model: "gpt-5.6-sol",
            input: "Use lookup",
            stream: true,
            store: false,
            tools: [{ type: "function", ...tool }],
          }
        : {
            model: "gpt-5.6-sol",
            messages: [{ role: "user", content: "Use lookup" }],
            stream: true,
            tools: [{ type: "function", function: tool }],
          },
    ),
    signal: abort.signal,
  });
  void pending.catch(() => undefined);
  return {
    accepted: accepted.promise,
    pending,
    requests: () => requests,
    complete() {
      controller?.enqueue(
        frame("toolUseEvent", {
          name: "lookup",
          toolUseId: "call-delivery",
          input: laterArguments,
          stop: true,
        }),
      );
      controller?.enqueue(
        frame("meteringEvent", { usage: 0.01, unit: "credit", unitPlural: "credits" }),
      );
      controller?.close();
    },
    stop() {
      abort.abort();
      gateway.stop(true);
      upstream.stop(true);
    },
  };
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("stream delivery remained blocked")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read">,
  predicate: (events: Record<string, unknown>[]) => boolean,
): Promise<{ text: string; events: Record<string, unknown>[] }> {
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const next = await reader.read();
    if (next.done) throw new Error("stream ended before expected progress");
    text += decoder.decode(next.value, { stream: true });
    const events = text
      .split(/\r?\n\r?\n/)
      .flatMap((value) => value.split("\n").filter((line) => line.startsWith("data: ")))
      .map((line) => line.slice(6))
      .filter((line) => line !== "[DONE]")
      .flatMap((value) => {
        try {
          return [JSON.parse(value) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
    if (predicate(events)) return { text, events };
  }
}

afterEach(clearSdkClientCache);

async function headerOnlyUpstream() {
  const ready = Promise.withResolvers<number>();
  const accepted = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const secondAccepted = Promise.withResolvers<void>();
  let requests = 0;
  // A separate Node process verifies actual peer socket closure, independently
  // of Bun's node:http ServerResponse close-event compatibility.
  const child = Bun.spawn(
    ["node", fileURLToPath(new URL("./fixtures/header-only-upstream.mjs", import.meta.url))],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = buffer.indexOf("\n");
      while (boundary >= 0) {
        const event = JSON.parse(buffer.slice(0, boundary)) as {
          port?: number;
          accepted?: number;
          closed?: number;
        };
        buffer = buffer.slice(boundary + 1);
        if (event.port !== undefined) ready.resolve(event.port);
        if (event.accepted !== undefined) {
          requests = event.accepted;
          accepted.resolve();
          if (event.accepted >= 2) secondAccepted.resolve();
        }
        if (event.closed === 1) closed.resolve();
        boundary = buffer.indexOf("\n");
      }
    }
  })();
  const port = await within(ready.promise, 2_000);
  return {
    port,
    accepted: accepted.promise,
    secondAccepted: secondAccepted.promise,
    closed: closed.promise,
    requests: () => requests,
    async stop() {
      child.kill("SIGTERM");
      await child.exited;
      await reading;
    },
  };
}

describe("tool fragment delivery over real HTTP and the AWS SDK", () => {
  test("KiroRuntime RPC initial metadata does not discard the first tool fragment", async () => {
    const run = fixture("chat/completions", false, true);
    try {
      await within(run.accepted, 1_000);
      const response = await within(run.pending, 500);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("missing SSE body");
      const first = await within(
        until(reader, (events) =>
          events.some((event) => JSON.stringify(event).includes("tool_calls")),
        ),
        500,
      );
      run.complete();
      const remaining = await new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            const next = await reader.read();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          },
        }),
      ).text();
      const text = first.text + remaining;
      expect(text).not.toContain('"error":');
      expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
      const chunks = text
        .split("\n\n")
        .filter((part) => part.startsWith("data: {"))
        .map((part) => JSON.parse(part.slice(6)));
      const calls = chunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []);
      expect(calls.map((call) => call.function?.arguments ?? "").join("")).toBe(args);
      expect(calls.filter((call) => call.id !== undefined)).toHaveLength(1);
    } finally {
      run.stop();
    }
  });

  for (const path of ["responses", "chat/completions"] as const) {
    test(`${path}: headers arrive while tool arguments remain open`, async () => {
      const run = fixture(path);
      try {
        await within(run.accepted, 1_000);
        const response = await within(run.pending, 250);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        expect(run.requests()).toBe(1);
      } finally {
        run.stop();
      }
    });

    test(`${path}: parameter deltas precede closure and preserve exact bytes`, async () => {
      const run = fixture(path, true);
      try {
        await within(run.accepted, 1_000);
        const response = await within(run.pending, 500);
        expect(response.status).toBe(200);
        const reader = response.body?.getReader();
        if (!reader) throw new Error("missing SSE body");
        const first = await within(
          until(reader, (events) =>
            path === "responses"
              ? events.some((event) => event.type === "response.function_call_arguments.delta")
              : events.some((event) => JSON.stringify(event).includes("tool_calls")),
          ),
          250,
        );
        expect(first.text).not.toContain("response.function_call_arguments.done");
        expect(first.text).not.toContain('"finish_reason":"tool_calls"');
        run.complete();
        const rest = await new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              const next = await reader.read();
              if (next.done) controller.close();
              else controller.enqueue(next.value);
            },
          }),
        ).text();
        const text = first.text + rest;
        const events = text
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .filter((line) => line !== "[DONE]")
          .map((line) => JSON.parse(line));
        if (path === "responses") {
          expect(events.filter((event) => event.type === "response.completed")).toHaveLength(1);
          expect(
            events
              .filter((event) => event.type === "response.function_call_arguments.delta")
              .map((event) => event.delta)
              .join(""),
          ).toBe(args);
          expect(
            events.filter((event) => event.type === "response.function_call_arguments.done"),
          ).toEqual([expect.objectContaining({ arguments: args })]);
        } else {
          expect(
            events
              .flatMap((event) => event.choices ?? [])
              .flatMap((choice) => choice.delta?.tool_calls ?? [])
              .map((tool) => tool.function?.arguments ?? "")
              .join(""),
          ).toBe(args);
          expect(
            events
              .flatMap((event) => event.choices ?? [])
              .filter((choice) => choice.finish_reason === "tool_calls"),
          ).toHaveLength(1);
        }
        expect(run.requests()).toBe(1);
      } finally {
        run.stop();
      }
    });
  }

  test("the same complete fixture is valid before the delivery fix", async () => {
    const run = fixture("responses");
    try {
      await within(run.accepted, 1_000);
      run.complete();
      const response = await within(run.pending, 1_000);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("response.completed");
      expect(text).not.toContain("response.failed");
    } finally {
      run.stop();
    }
  });

  for (const path of ["responses", "chat/completions"] as const) {
    test(`${path}: accepted HTTP headers do not wait for even the first SDK event`, async () => {
      const upstream = await headerOnlyUpstream();
      const port = upstream.port;
      const config = ConfigSchema.parse({
        api_keys: ["fixture-key"],
        protocol_projection_mode: "v3-auto",
        enable_legacy_chat_completions: true,
        test_upstream_endpoint: `http://127.0.0.1:${port}`,
        request_timeout_ms: 2_000,
        stream_idle_timeout_ms: 1_000,
      });
      const gateway = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: createApp(config, {
          accountManager: new Accounts(),
          tokenRefresher: {
            refreshIfNeeded: async (account) => account,
            forceRefresh: async (account) => account,
          },
        }),
      });
      const abort = new AbortController();
      const body =
        path === "responses"
          ? { model: "gpt-5.6-sol", input: "Synthetic input", stream: true, store: false }
          : {
              model: "gpt-5.6-sol",
              messages: [{ role: "user", content: "Synthetic input" }],
              stream: true,
            };
      const call = (signal: AbortSignal): Promise<Response> =>
        fetch(`http://127.0.0.1:${gateway.port}/v1/${path}`, {
          method: "POST",
          signal,
          headers: { Authorization: "Bearer fixture-key", "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      try {
        const pending = call(abort.signal);
        void pending.catch(() => undefined);
        await within(upstream.accepted, 1_000);
        const response = await within(pending, 250);
        expect(response.status).toBe(200);
        expect(response.headers.get("x-request-id")).toMatch(/^req_/);
        abort.abort();
        await within(upstream.closed, 500);
        const second = await within(call(AbortSignal.timeout(1_000)), 500);
        expect(second.status).toBe(200);
        await within(upstream.secondAccepted, 500);
        await second.body?.cancel();
        expect(upstream.requests()).toBe(2);
      } finally {
        abort.abort();
        gateway.stop(true);
        await upstream.stop();
      }
    });
  }
});
