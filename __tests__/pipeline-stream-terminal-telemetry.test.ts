import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import { auditHash, resetAuditLogLevel, setAuditLogLevel } from "../src/core/audit-log.js";
import {
  type PipelineAccountManager,
  type PipelineSdkClient,
  type PipelineTokenRefresher,
  runChatCompletion,
} from "../src/core/pipeline.js";
import { createPipelineStreamResponse } from "../src/core/pipeline-stream.js";
import type {
  SdkStreamEvent,
  SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import { type AuditRecord, captureAuditEvents } from "./audit-test-helpers.js";
import { canonicalRequest, message } from "./canonical-test-helpers.js";

/**
 * Exactly one `sdk_stream_terminal` per attempt-stream, carrying the terminal
 * provenance and output counts (never content). consumer_cancel and
 * external_abort previously emitted nothing.
 */

const COMPLETION: SdkStreamEvent = {
  metadataEvent: { tokenUsage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 } },
};

function eventsResponse(events: readonly SdkStreamEvent[]): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
        for (const event of events) yield event;
      },
    },
  };
}

function scriptedResponse(
  events: readonly SdkStreamEvent[],
  then: "stall" | "throw",
): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      [Symbol.asyncIterator](): AsyncIterator<SdkStreamEvent> {
        let index = 0;
        return {
          next(): Promise<IteratorResult<SdkStreamEvent>> {
            const event = events[index];
            index += 1;
            if (event) return Promise.resolve({ done: false, value: event });
            if (then === "throw") return Promise.reject(new Error("upstream broke"));
            return new Promise<IteratorResult<SdkStreamEvent>>(() => undefined);
          },
          return: () => Promise.resolve({ done: true, value: undefined }),
        };
      },
    },
  };
}

function reader(response: Response) {
  if (!response.body) throw new TypeError("streaming response must have a body");
  return response.body.getReader();
}

function terminalEvents(audit: ReturnType<typeof captureAuditEvents>): AuditRecord[] {
  return audit.events("sdk_stream_terminal");
}

const BASE_FIELDS = {
  level: "info",
  model: "claude-opus-4-8",
  conversation_hash: auditHash("telemetry-conversation"),
  mode: "stream",
};

let audit: ReturnType<typeof captureAuditEvents>;

beforeEach(() => {
  audit = captureAuditEvents();
});

afterEach(() => {
  audit.restore();
  resetAuditLogLevel();
});

describe("sdk_stream_terminal on the streaming response", () => {
  test("normal completion reports counts, witness, and the synthesized finish reason", async () => {
    const response = createPipelineStreamResponse(
      {
        sdkResponse: eventsResponse([
          { reasoningContentEvent: { text: "abc" } },
          { assistantResponseEvent: { content: "hello" } },
          { toolUseEvent: { toolUseId: "tool-1", name: "lookup", input: '{"q":1}', stop: true } },
          COMPLETION,
        ]),
        model: "claude-opus-4-8",
        conversationId: "telemetry-conversation",
      },
      new AbortController().signal,
      1_000,
      () => undefined,
    );
    const body = await response.text();

    expect(body).toContain('"type":"completed"');
    expect(terminalEvents(audit)).toEqual([
      expect.objectContaining({
        ...BASE_FIELDS,
        terminal_provenance: "normal_complete",
        completion_witnessed: true,
        witness_kind: "token-usage-metadata",
        reasoning_chars: 3,
        visible_chars: 5,
        tool_count: 1,
        tool_intent_open: false,
        finish_reason: "tool_calls",
        finish_reason_synthesized: true,
        raw_event_count: 4,
        canonical_event_count: 5,
      }),
    ]);
    expect(JSON.stringify(terminalEvents(audit))).not.toContain("hello");
    expect(audit.events("sdk_stream_completed")).toHaveLength(1);
  });

  test("idle timeout", async () => {
    const response = createPipelineStreamResponse(
      {
        sdkResponse: scriptedResponse(
          [{ assistantResponseEvent: { content: "partial" } }],
          "stall",
        ),
        model: "claude-opus-4-8",
        conversationId: "telemetry-conversation",
      },
      new AbortController().signal,
      15,
      () => undefined,
    );

    await expect(response.text()).rejects.toMatchObject({ name: "StreamIdleTimeoutError" });
    expect(terminalEvents(audit)).toEqual([
      expect.objectContaining({
        ...BASE_FIELDS,
        terminal_provenance: "idle_timeout",
        completion_witnessed: false,
        visible_chars: 7,
        reasoning_chars: 0,
        tool_count: 0,
      }),
    ]);
    expect(terminalEvents(audit)[0]).not.toHaveProperty("finish_reason_synthesized");
  });

  test("upstream error with an open tool intent", async () => {
    const response = createPipelineStreamResponse(
      {
        sdkResponse: scriptedResponse(
          [
            { assistantResponseEvent: { content: "hi" } },
            { toolUseEvent: { toolUseId: "tool-1", name: "lookup", input: "{" } },
          ],
          "throw",
        ),
        model: "claude-opus-4-8",
        conversationId: "telemetry-conversation",
      },
      new AbortController().signal,
      1_000,
      () => undefined,
    );

    await expect(response.text()).rejects.toMatchObject({ message: "upstream broke" });
    expect(terminalEvents(audit)).toEqual([
      expect.objectContaining({
        terminal_provenance: "upstream_error",
        completion_witnessed: false,
        tool_intent_open: true,
        tool_count: 0,
        visible_chars: 2,
      }),
    ]);
  });

  test("consumer cancel", async () => {
    const response = createPipelineStreamResponse(
      {
        sdkResponse: scriptedResponse([{ reasoningContentEvent: { text: "thinking" } }], "stall"),
        model: "claude-opus-4-8",
        conversationId: "telemetry-conversation",
      },
      new AbortController().signal,
      1_000,
      () => undefined,
    );
    const body = reader(response);
    await body.read();
    await body.read();

    await body.cancel("client went away");

    expect(terminalEvents(audit)).toEqual([
      expect.objectContaining({
        terminal_provenance: "consumer_cancel",
        reasoning_chars: 8,
        visible_chars: 0,
        completion_witnessed: false,
      }),
    ]);
  });

  test("external abort", async () => {
    const external = new AbortController();
    const response = createPipelineStreamResponse(
      {
        sdkResponse: scriptedResponse(
          [{ assistantResponseEvent: { content: "partial" } }],
          "stall",
        ),
        model: "claude-opus-4-8",
        conversationId: "telemetry-conversation",
      },
      external.signal,
      1_000,
      () => undefined,
    );
    const body = reader(response);
    await body.read();
    await body.read();
    const pending = body.read();

    external.abort(new DOMException("deadline", "TimeoutError"));

    await expect(pending).rejects.toBeDefined();
    expect(terminalEvents(audit)).toEqual([
      expect.objectContaining({ terminal_provenance: "external_abort", visible_chars: 7 }),
    ]);
  });
});

function account(): ManagedAccount {
  return {
    id: "telemetry-account",
    email: "telemetry@example.com",
    authMethod: "desktop",
    region: "us-east-1",
    refreshToken: "refresh",
    accessToken: "access",
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

function config(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    api_keys: ["sk-test"],
    request_timeout_ms: 5_000,
    stream_idle_timeout_ms: 1_000,
    rate_limit_retry_delay_ms: 1,
    ...overrides,
  });
}

describe("sdk_stream_terminal through the pipeline", () => {
  test("the non-stream path reports normal_complete with mode non-stream", async () => {
    const client: PipelineSdkClient = {
      send: async () =>
        eventsResponse([
          { reasoningContentEvent: { text: "why" } },
          { assistantResponseEvent: { content: "because" } },
          COMPLETION,
        ]),
    };

    const response = await runChatCompletion({
      requestId: "req-non-stream",
      body: canonicalRequest([message("user", "hello")], { model: "auto" }),
      model: "auto",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager(),
      tokenRefresher: refresher,
      makeClient: () => client,
    });

    expect(response.status).toBe(200);
    expect(terminalEvents(audit)).toEqual([
      expect.objectContaining({
        mode: "non-stream",
        request_id: "req-non-stream",
        attempt: 1,
        account_hash: auditHash("telemetry-account"),
        terminal_provenance: "normal_complete",
        completion_witnessed: true,
        reasoning_chars: 3,
        visible_chars: 7,
        tool_count: 0,
        finish_reason: "stop",
        finish_reason_synthesized: true,
      }),
    ]);
  });

  test("a non-stream failure after semantic output reports upstream_error", async () => {
    const client: PipelineSdkClient = {
      send: async () =>
        scriptedResponse([{ assistantResponseEvent: { content: "partial" } }], "throw"),
    };

    const response = await runChatCompletion({
      requestId: "req-failed-stream",
      body: canonicalRequest([message("user", "hello")], { model: "auto" }),
      model: "auto",
      stream: false,
      config: config({ rate_limit_max_retries: 0 }),
      accountManager: new FakeAccountManager(),
      tokenRefresher: refresher,
      makeClient: () => client,
    });

    expect(response.status).toBe(500);
    expect(terminalEvents(audit)).toEqual([
      expect.objectContaining({
        mode: "non-stream",
        terminal_provenance: "upstream_error",
        visible_chars: 7,
      }),
    ]);
  });

  test("each attempt-stream of a retried request gets its own terminal event", async () => {
    let sends = 0;
    const client: PipelineSdkClient = {
      send: async () => {
        sends += 1;
        return sends === 1
          ? scriptedResponse([], "throw")
          : eventsResponse([{ assistantResponseEvent: { content: "ok" } }, COMPLETION]);
      },
    };

    const response = await runChatCompletion({
      requestId: "req-retried-stream",
      body: canonicalRequest([message("user", "hello")], { model: "auto" }),
      model: "auto",
      stream: true,
      config: config(),
      accountManager: new FakeAccountManager(),
      tokenRefresher: refresher,
      makeClient: () => client,
    });
    await response.text();

    expect(
      terminalEvents(audit).map((record) => ({
        requestId: record.request_id,
        attempt: record.attempt,
        provenance: record.terminal_provenance,
      })),
    ).toEqual([
      {
        requestId: "req-retried-stream",
        attempt: 1,
        provenance: "upstream_error",
      },
      {
        requestId: "req-retried-stream",
        attempt: 2,
        provenance: "normal_complete",
      },
    ]);
    expect(
      audit.events("sdk_dispatch_started").map((record) => ({
        requestId: record.request_id,
        attempt: record.attempt,
      })),
    ).toEqual([
      { requestId: "req-retried-stream", attempt: 1 },
      { requestId: "req-retried-stream", attempt: 2 },
    ]);
    expect(terminalEvents(audit)[1]).toMatchObject({
      visible_chars: 2,
      completion_witnessed: true,
    });
  });

  test("emits payload-free projection and history stages at debug level", async () => {
    setAuditLogLevel("debug");
    const secret = "do-not-log-this-instruction";
    const client: PipelineSdkClient = {
      send: async () => eventsResponse([{ assistantResponseEvent: { content: "ok" } }, COMPLETION]),
    };

    const response = await runChatCompletion({
      requestId: "req-stage-events",
      body: canonicalRequest(
        [message("user", "question"), message("assistant", "answer"), message("developer", secret)],
        { model: "auto", projectionMode: "legacy-user-prefix" },
      ),
      model: "auto",
      stream: false,
      config: config({ protocol_projection_mode: "legacy-user-prefix" }),
      accountManager: new FakeAccountManager(),
      tokenRefresher: refresher,
      makeClient: () => client,
    });

    expect(response.status).toBe(200);
    expect(audit.events("request_projection_completed")).toEqual([
      expect.objectContaining({
        request_id: "req-stage-events",
        attempt: 1,
        projection_mode: "legacy-user-prefix",
        prefix_instruction_count: 0,
        trailing_instruction_count: 1,
        suffix_action: "synthetic_user",
      }),
    ]);
    expect(audit.events("request_history_built")).toEqual([
      expect.objectContaining({
        request_id: "req-stage-events",
        attempt: 1,
        history_message_count: 2,
        current_role: "user",
        current_text_chars: secret.length,
      }),
    ]);
    expect(JSON.stringify(audit.events())).not.toContain(secret);
  });
});
