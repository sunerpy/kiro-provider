import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAuditLogLevel } from "../src/core/audit-log.js";
import { createPipelineStreamResponse } from "../src/core/pipeline-stream.js";
import type {
  SdkStreamEvent,
  SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import { captureAuditEvents } from "./audit-test-helpers.js";

/**
 * `sdk_stream_idle_timeout` must describe the shape of the stall, not just the
 * fact of it: how long the upstream has been silent and how much tool structure
 * it left behind. Those counts are what distinguish "Kiro stopped mid tool call"
 * from "Kiro finished its tool calls and then went quiet", which is the case
 * that reproduced against KiroRuntime.
 */

/** Never resolves after the scripted events, so the idle watchdog is the only exit. */
function stallingResponse(events: readonly SdkStreamEvent[]): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      [Symbol.asyncIterator](): AsyncIterator<SdkStreamEvent> {
        let index = 0;
        return {
          next(): Promise<IteratorResult<SdkStreamEvent>> {
            const event = events[index];
            index += 1;
            if (event) return Promise.resolve({ done: false, value: event });
            return new Promise<IteratorResult<SdkStreamEvent>>(() => undefined);
          },
          return: () => Promise.resolve({ done: true, value: undefined }),
        };
      },
    },
  };
}

const IDLE_MS = 250;

let audit: ReturnType<typeof captureAuditEvents>;

beforeEach(() => {
  audit = captureAuditEvents();
});

afterEach(() => {
  audit.restore();
  resetAuditLogLevel();
});

/**
 * Drains the published stream with an injected clock, bumps that clock past the
 * frames, and resolves once the watchdog has rejected the reader.
 */
async function stallUntilIdleTimeout(
  events: readonly SdkStreamEvent[],
  silenceMs: number,
): Promise<void> {
  let clock = 1_000_000;
  const response = createPipelineStreamResponse(
    {
      sdkResponse: stallingResponse(events),
      model: "claude-opus-4-8",
      conversationId: "stall-conversation",
      telemetryContext: { requestId: "req-stall", attempt: 1, now: () => clock },
    },
    new AbortController().signal,
    IDLE_MS,
    () => undefined,
  );
  if (!response.body) throw new TypeError("streaming response must have a body");
  const body = response.body.getReader();
  // One read per scripted frame plus the canonical `started` line, so every
  // frame has been observed before the clock jumps.
  for (let read = 0; read <= events.length; read += 1) {
    await body.read();
  }
  clock += silenceMs;

  await expect(body.read()).rejects.toMatchObject({ name: "StreamIdleTimeoutError" });
}

describe("sdk_stream_idle_timeout stall fields", () => {
  test("reports the last-frame age and a fully stopped tool intent", async () => {
    await stallUntilIdleTimeout(
      [
        { assistantResponseEvent: { content: "checking" } },
        { toolUseEvent: { toolUseId: "tool-1", name: "lookup", input: '{"q":1}', stop: true } },
      ],
      300_000,
    );

    expect(audit.events("sdk_stream_idle_timeout")).toEqual([
      expect.objectContaining({
        level: "warn",
        request_id: "req-stall",
        attempt: 1,
        mode: "stream",
        idle_timeout_ms: IDLE_MS,
        last_frame_age_ms: 300_000,
        raw_event_count: 2,
        // The tool call was announced and stopped upstream but never finalized
        // downstream, because the stream died before its completion frame.
        tool_count: 0,
        tool_delta_count: 1,
        tool_intent_count: 1,
        tool_intent_open_count: 0,
        tool_intent_stopped_count: 1,
        tool_intent_open: false,
        tool_intent_all_stopped: true,
        visible_chars: 8,
        reasoning_chars: 0,
        completion_witnessed: false,
      }),
    ]);
  });

  test("reports an unfinished tool intent as open, not all-stopped", async () => {
    await stallUntilIdleTimeout(
      [{ toolUseEvent: { toolUseId: "tool-1", name: "lookup", input: "{" } }],
      42_000,
    );

    expect(audit.events("sdk_stream_idle_timeout")).toEqual([
      expect.objectContaining({
        last_frame_age_ms: 42_000,
        tool_count: 0,
        tool_intent_count: 1,
        tool_intent_open_count: 1,
        tool_intent_stopped_count: 0,
        tool_intent_open: true,
        tool_intent_all_stopped: false,
      }),
    ]);
  });

  test("reports no tool intent and a zero age when the stall precedes every frame", async () => {
    const response = createPipelineStreamResponse(
      {
        sdkResponse: stallingResponse([]),
        model: "claude-opus-4-8",
        conversationId: "stall-conversation",
        telemetryContext: { requestId: "req-stall-immediate", now: () => 1_000_000 },
      },
      new AbortController().signal,
      IDLE_MS,
      () => undefined,
    );

    await expect(response.text()).rejects.toMatchObject({ name: "StreamIdleTimeoutError" });

    const [record] = audit.events("sdk_stream_idle_timeout");
    expect(record).toMatchObject({
      raw_event_count: 0,
      tool_intent_count: 0,
      tool_intent_open: false,
      tool_intent_all_stopped: false,
      completion_witnessed: false,
    });
    // No frame ever arrived, so there is no age to report rather than a fake 0.
    expect(record).not.toHaveProperty("last_frame_age_ms");
  });

  test("carries no model-visible payload across the audit boundary", async () => {
    const secret = "do-not-log-this-tool-argument";
    await stallUntilIdleTimeout(
      [
        { assistantResponseEvent: { content: "visible-answer-text" } },
        { toolUseEvent: { toolUseId: "tool-1", name: "lookup", input: `{"q":"${secret}"}` } },
      ],
      1_000,
    );

    const serialized = JSON.stringify(audit.events("sdk_stream_idle_timeout"));
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("visible-answer-text");
    expect(serialized).not.toContain("stall-conversation");
    expect(serialized).not.toContain("lookup");
  });
});
