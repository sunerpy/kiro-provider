import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { EventStreamCodec } from "@smithy/core/event-streams";
import { fromUtf8, toUtf8 } from "@smithy/core/serde";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import {
  type PipelineAccountManager,
  type PipelineTokenRefresher,
  runChatCompletion,
} from "../src/core/pipeline.js";
import { clearSdkClientCache } from "../src/core/sdk-client.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import { parseCanonicalOutputEventLine } from "../src/protocol/output.js";
import { canonicalRequest, message } from "./canonical-test-helpers.js";

/**
 * A1: the upstream Kiro HTTP request must really be torn down when the
 * pipeline stops consuming it (idle timeout, consumer cancel, deadline, or a
 * failed non-stream collection) and must NOT be aborted on normal completion.
 *
 * These tests drive the REAL SDK client and NodeHttpHandler built by
 * createSdkClient against a loopback Bun.serve event-stream upstream and
 * observe the upstream side: ReadableStream.cancel() fires only when the
 * client destroys the connection before the body completed.
 */

type UpstreamMode = "stall" | "complete" | "bad-tool";

interface UpstreamState {
  requests: number;
  cancelled: number;
  closed: number;
}

const codec = new EventStreamCodec(toUtf8, fromUtf8);

function encodeEvent(eventType: string, body: unknown): Uint8Array {
  return codec.encode({
    headers: {
      ":message-type": { type: "string", value: "event" },
      ":event-type": { type: "string", value: eventType },
      ":content-type": { type: "string", value: "application/json" },
    },
    body: fromUtf8(JSON.stringify(body)),
  });
}

const ASSISTANT_EVENT = encodeEvent("assistantResponseEvent", { content: "mock response" });
const METERING_EVENT = encodeEvent("meteringEvent", {
  usage: 0.01,
  unit: "credit",
  unitPlural: "credits",
});
// A tool fragment without a name is an invalid_upstream_tool_call the collector
// rejects while the socket is still open (fatal, so no retry follows).
const BAD_TOOL_EVENT = encodeEvent("toolUseEvent", { toolUseId: "tool-1", input: "{" });

function startUpstream(mode: UpstreamMode): {
  readonly endpoint: string;
  readonly state: UpstreamState;
  stop(): void;
} {
  const state: UpstreamState = { requests: 0, cancelled: 0, closed: 0 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      state.requests += 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(ASSISTANT_EVENT);
            if (mode === "bad-tool") controller.enqueue(BAD_TOOL_EVENT);
            if (mode === "complete") {
              controller.enqueue(METERING_EVENT);
              controller.close();
              state.closed += 1;
            }
          },
          cancel() {
            state.cancelled += 1;
          },
        }),
        {
          headers: {
            "Content-Type": "application/vnd.amazon.eventstream",
            "x-amzn-codewhisperer-conversation-id": "upstream-abort-test",
          },
        },
      );
    },
  });
  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    state,
    stop: () => server.stop(true),
  };
}

function account(): ManagedAccount {
  return {
    id: "upstream-abort-account",
    email: "upstream-abort@example.com",
    authMethod: "desktop",
    region: "us-east-1",
    refreshToken: "refresh-token",
    accessToken: "access-token",
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
  };
}

class FakeAccountManager implements PipelineAccountManager {
  readonly selected = account();

  reconcileFromDb(): readonly ManagedAccount[] {
    return [this.selected];
  }

  selectHealthyAccount(): ManagedAccount {
    return this.selected;
  }

  getAccountCount(): number {
    return 1;
  }

  toAuthDetails(selected: ManagedAccount): KiroAuthDetails {
    return {
      refresh: selected.refreshToken,
      access: selected.accessToken,
      expires: selected.expiresAt,
      authMethod: selected.authMethod,
      region: selected.region,
    };
  }

  markRateLimited(): void {}

  markUnhealthy(): void {}
}

const refresher: PipelineTokenRefresher = {
  refreshIfNeeded: async (selected) => selected,
  forceRefresh: async (selected) => selected,
};

function config(endpoint: string, overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    api_keys: ["sk-test"],
    request_timeout_ms: 5_000,
    stream_idle_timeout_ms: 1_000,
    rate_limit_retry_delay_ms: 1,
    rate_limit_max_retries: 0,
    test_upstream_endpoint: endpoint,
    ...overrides,
  });
}

function run(
  endpoint: string,
  stream: boolean,
  overrides: Partial<Config> = {},
  deadlineSignal?: AbortSignal,
): Promise<Response> {
  return runChatCompletion({
    body: canonicalRequest([message("user", "hello")], { model: "auto" }),
    model: "auto",
    stream,
    config: config(endpoint, overrides),
    accountManager: new FakeAccountManager(),
    tokenRefresher: refresher,
    ...(deadlineSignal ? { deadlineSignal } : {}),
  });
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

function reader(response: Response) {
  if (!response.body) throw new TypeError("streaming response must have a body");
  return response.body.getReader();
}

const unhandledRejections: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandledRejections.push(reason);
};

beforeAll(() => {
  process.on("unhandledRejection", onUnhandled);
});

afterAll(() => {
  process.off("unhandledRejection", onUnhandled);
});

afterEach(async () => {
  clearSdkClientCache();
  await Bun.sleep(10);
  expect(unhandledRejections).toEqual([]);
  unhandledRejections.length = 0;
});

describe("upstream request teardown through the real SDK transport (A1)", () => {
  test("destroys the upstream connection after a stream idle timeout", async () => {
    const upstream = startUpstream("stall");
    try {
      const response = await run(upstream.endpoint, true, { stream_idle_timeout_ms: 50 });
      const body = reader(response);
      await body.read();
      const delta = await body.read();
      expect(new TextDecoder().decode(delta.value)).toContain("mock response");

      await expect(body.read()).rejects.toMatchObject({ name: "StreamIdleTimeoutError" });

      await waitFor(() => upstream.state.cancelled === 1, "upstream cancel after idle timeout");
      expect(upstream.state.requests).toBe(1);
    } finally {
      upstream.stop();
    }
  });

  test("destroys the upstream connection when the consumer cancels the stream", async () => {
    const upstream = startUpstream("stall");
    try {
      const response = await run(upstream.endpoint, true);
      const body = reader(response);
      await body.read();
      await body.read();

      await body.cancel("client went away");

      await waitFor(() => upstream.state.cancelled === 1, "upstream cancel after consumer cancel");
    } finally {
      upstream.stop();
    }
  });

  test("destroys the upstream connection when the ingress deadline fires mid-stream", async () => {
    const upstream = startUpstream("stall");
    const deadline = new AbortController();
    try {
      const response = await run(upstream.endpoint, true, {}, deadline.signal);
      const body = reader(response);
      await body.read();
      await body.read();

      deadline.abort(new DOMException("Request deadline exceeded", "TimeoutError"));

      await expect(body.read()).rejects.toBeDefined();
      await waitFor(() => upstream.state.cancelled === 1, "upstream cancel after deadline");
    } finally {
      upstream.stop();
    }
  });

  test("does not abort the upstream connection on normal stream completion", async () => {
    const upstream = startUpstream("complete");
    try {
      const response = await run(upstream.endpoint, true);
      const text = await response.text();
      const events = text
        .trim()
        .split("\n")
        .map((line) => parseCanonicalOutputEventLine(line));

      expect(events.at(-1)?.type).toBe("completed");
      await Bun.sleep(50);
      expect(upstream.state).toEqual({ requests: 1, cancelled: 0, closed: 1 });
    } finally {
      upstream.stop();
    }
  });

  test("destroys the upstream connection when non-stream collection fails", async () => {
    const upstream = startUpstream("bad-tool");
    try {
      const response = await run(upstream.endpoint, false);

      expect(response.status).toBe(502);
      const body = (await response.json()) as { error: { code?: string } };
      expect(body.error.code).toBe("invalid_upstream_tool_call");
      await waitFor(() => upstream.state.cancelled === 1, "upstream cancel after collection failure");
    } finally {
      upstream.stop();
    }
  });

  test("does not abort the upstream connection on normal non-stream completion", async () => {
    const upstream = startUpstream("complete");
    try {
      const response = await run(upstream.endpoint, false);

      expect(response.status).toBe(200);
      await Bun.sleep(50);
      expect(upstream.state).toEqual({ requests: 1, cancelled: 0, closed: 1 });
    } finally {
      upstream.stop();
    }
  });
});
