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
import { captureAuditEvents } from "./audit-test-helpers.js";
import { canonicalRequest, message } from "./canonical-test-helpers.js";

/**
 * Pre-publication retry through the REAL SDK client and NodeHttpHandler
 * (the loopback fixture from pipeline-upstream-abort.test.ts): the first
 * upstream response ends before any event, the replacement attempt
 * completes, and the client sees one clean stream.
 */

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

interface UpstreamState {
  requests: number;
  cancelled: number;
}

/** Request 1 ends with no events (clean EOF, no witness); later requests complete. */
function startUpstream(): {
  readonly endpoint: string;
  readonly state: UpstreamState;
  stop(): void;
} {
  const state: UpstreamState = { requests: 0, cancelled: 0 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      state.requests += 1;
      const truncated = state.requests === 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            if (!truncated) {
              controller.enqueue(ASSISTANT_EVENT);
              controller.enqueue(METERING_EVENT);
            }
            controller.close();
          },
          cancel() {
            state.cancelled += 1;
          },
        }),
        {
          headers: {
            "Content-Type": "application/vnd.amazon.eventstream",
            "x-amzn-codewhisperer-conversation-id": "prepublication-retry-test",
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
    id: "prepublication-account",
    email: "prepublication@example.com",
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
  readonly rateLimited: string[] = [];

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

  markRateLimited(selected: ManagedAccount): void {
    this.rateLimited.push(selected.id);
  }

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

const unhandledRejections: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandledRejections.push(reason);
};
let audit: ReturnType<typeof captureAuditEvents>;

beforeAll(() => {
  process.on("unhandledRejection", onUnhandled);
});

afterAll(() => {
  process.off("unhandledRejection", onUnhandled);
});

afterEach(async () => {
  audit?.restore();
  clearSdkClientCache();
  await Bun.sleep(10);
  expect(unhandledRejections).toEqual([]);
  unhandledRejections.length = 0;
});

describe("pre-publication retry through the real SDK transport", () => {
  test("a stream whose first upstream response ends without events is retried transparently", async () => {
    const upstream = startUpstream();
    const manager = new FakeAccountManager();
    audit = captureAuditEvents();
    try {
      const response = await runChatCompletion({
        body: canonicalRequest([message("user", "hello")], { model: "auto" }),
        model: "auto",
        stream: true,
        config: config(upstream.endpoint),
        accountManager: manager,
        tokenRefresher: refresher,
      });
      const text = await response.text();
      const events = text
        .trim()
        .split("\n")
        .map((line) => parseCanonicalOutputEventLine(line));

      expect(response.status).toBe(200);
      expect(events.map((event) => event?.type)).toEqual(["started", "text_delta", "completed"]);
      expect(events[1]).toMatchObject({ type: "text_delta", text: "mock response" });
      expect(upstream.state.requests).toBe(2);
      expect(audit.events("sdk_stream_attempt_retry")).toEqual([
        expect.objectContaining({
          attempt: 1,
          same_account: true,
          error_code: "upstream_stream_incomplete",
        }),
      ]);
      expect(manager.rateLimited).toEqual([]);
    } finally {
      upstream.stop();
    }
  });

  test("the non-stream path takes the same replacement attempt", async () => {
    const upstream = startUpstream();
    audit = captureAuditEvents();
    try {
      const response = await runChatCompletion({
        body: canonicalRequest([message("user", "hello")], { model: "auto" }),
        model: "auto",
        stream: false,
        config: config(upstream.endpoint),
        accountManager: new FakeAccountManager(),
        tokenRefresher: refresher,
      });

      expect(response.status).toBe(200);
      expect(((await response.json()) as { text: string }).text).toBe("mock response");
      expect(upstream.state.requests).toBe(2);
      expect(audit.events("sdk_stream_attempt_retry")).toHaveLength(1);
    } finally {
      upstream.stop();
    }
  });
});
