import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { auditHash } from "../src/core/audit-log.js";
import { collectSdkResponse } from "../src/kiro/transform/sdk-collector.js";
import { transformSdkOutputStream } from "../src/kiro/transform/streaming/sdk-output-transformer.js";
import type {
  SdkStreamEvent,
  SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { CanonicalOutputEvent } from "../src/protocol/output.js";
import { captureAuditEvents } from "./audit-test-helpers.js";

/**
 * A metering event is an authoritative completion witness. When the SDK
 * reader then REJECTS with a transport error while draining the trailing
 * bytes, the canonical stream completes normally and the fault is audited
 * (hashed). Embedded error events after the witness still fail the stream.
 */

const METERING: SdkStreamEvent = {
  meteringEvent: { usage: 0.01, unit: "credit", unitPlural: "credits" },
};
const TRANSPORT_ERROR_MESSAGE = "read ECONNRESET: private transport detail";

function response(
  events: readonly SdkStreamEvent[],
  after: "reject" | "embedded-error" | "eof",
): { readonly sdkResponse: SdkStreamResponse; readonly state: { returns: number } } {
  const state = { returns: 0 };
  let index = 0;
  return {
    state,
    sdkResponse: {
      generateAssistantResponseResponse: {
        [Symbol.asyncIterator](): AsyncIterator<SdkStreamEvent> {
          return {
            next(): Promise<IteratorResult<SdkStreamEvent>> {
              const event = events[index];
              index += 1;
              if (event) return Promise.resolve({ done: false, value: event });
              if (after === "reject") return Promise.reject(new Error(TRANSPORT_ERROR_MESSAGE));
              if (after === "embedded-error" && index === events.length + 1) {
                return Promise.resolve({
                  done: false,
                  value: { error: { message: "upstream hiccup" } } as SdkStreamEvent,
                });
              }
              return Promise.resolve({ done: true, value: undefined });
            },
            return(): Promise<IteratorResult<SdkStreamEvent>> {
              state.returns += 1;
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      },
    },
  };
}

async function drain(sdkResponse: SdkStreamResponse): Promise<{
  readonly events: CanonicalOutputEvent[];
  readonly error: unknown;
}> {
  const events: CanonicalOutputEvent[] = [];
  try {
    for await (const event of transformSdkOutputStream(sdkResponse, "auto", "witness-test")) {
      events.push(event);
    }
    return { events, error: undefined };
  } catch (error) {
    return { events, error };
  }
}

let audit: ReturnType<typeof captureAuditEvents>;

beforeEach(() => {
  audit = captureAuditEvents();
});

afterEach(() => {
  audit.restore();
});

describe("transport errors after a completion witness", () => {
  test("completes normally when the reader rejects after a metering event", async () => {
    const upstream = response(
      [{ assistantResponseEvent: { content: "answer" } }, METERING],
      "reject",
    );

    const { events, error } = await drain(upstream.sdkResponse);

    expect(error).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual(["started", "text_delta", "completed"]);
    expect(events.at(-1)).toMatchObject({ type: "completed", finishReason: "stop" });
    expect(upstream.state.returns).toBe(1);
    const audited = audit.events("sdk_stream_transport_error_after_completion");
    expect(audited).toEqual([
      expect.objectContaining({
        level: "warn",
        model: "auto",
        conversation_hash: auditHash("witness-test"),
        witness_kind: "metering-clean-eof",
        error_type: "Error",
        error_code: "upstream_stream_error",
        error_message_hash: auditHash(TRANSPORT_ERROR_MESSAGE),
      }),
    ]);
    expect(JSON.stringify(audited)).not.toContain("private transport detail");
  });

  test("the non-stream collector folds the same stream into a completion", async () => {
    const upstream = response(
      [{ assistantResponseEvent: { content: "answer" } }, METERING],
      "reject",
    );

    const completion = await collectSdkResponse(upstream.sdkResponse, "auto", "witness-collect");

    expect(completion.text).toBe("answer");
    expect(completion.finishReason).toBe("stop");
    expect(audit.events("sdk_stream_transport_error_after_completion")).toHaveLength(1);
  });

  test("an embedded error event after the metering witness still fails the stream", async () => {
    const upstream = response(
      [{ assistantResponseEvent: { content: "answer" } }, METERING],
      "embedded-error",
    );

    const { events, error } = await drain(upstream.sdkResponse);

    expect(events.map((event) => event.type)).toEqual(["started", "text_delta"]);
    expect(error).toMatchObject({ name: "SdkStreamProtocolError", code: "upstream_stream_error" });
    expect(audit.events("sdk_stream_transport_error_after_completion")).toEqual([]);
  });

  test("a transport error before any witness still fails the stream", async () => {
    const upstream = response([{ assistantResponseEvent: { content: "answer" } }], "reject");

    const { events, error } = await drain(upstream.sdkResponse);

    expect(events.map((event) => event.type)).toEqual(["started", "text_delta"]);
    expect(error).toMatchObject({ message: TRANSPORT_ERROR_MESSAGE });
    expect(audit.events("sdk_stream_transport_error_after_completion")).toEqual([]);
  });

  test("tool calls are still validated when the reader rejects after the witness", async () => {
    const upstream = response(
      [{ toolUseEvent: { toolUseId: "tool-1", name: "lookup", input: "{}" } }, METERING],
      "reject",
    );

    const { error } = await drain(upstream.sdkResponse);

    expect(error).toMatchObject({ code: "incomplete_upstream_tool_call" });
  });
});
