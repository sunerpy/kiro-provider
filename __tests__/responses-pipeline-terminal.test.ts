import { describe, expect, test } from "bun:test";
import { createPipelineStreamResponse } from "../src/core/pipeline-stream.js";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import { responsesSseAdapter } from "../src/server/responses/sse-adapter.js";
import { captureAuditEvents } from "./audit-test-helpers.js";

function streamFixture() {
  const signal = new AbortController().signal;
  let finalized = 0;
  let aborted = 0;
  let routeFinalized = 0;
  const response = createPipelineStreamResponse(
    {
      model: "gpt-5.6-sol",
      conversationId: "fixture-terminal",
      abortUpstream: () => {
        aborted++;
      },
      sdkResponse: {
        generateAssistantResponseResponse: {
          async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
            yield { assistantResponseEvent: { content: "FIXTURE_OK" } };
            yield {
              metadataEvent: {
                tokenUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
              },
            };
          },
        },
      },
    },
    signal,
    1000,
    () => {
      finalized++;
    },
  );
  return {
    response,
    counts: () => ({ finalized, aborted, routeFinalized }),
    adapted: () =>
      responsesSseAdapter(response, {
        model: "gpt-5.6-sol",
        signals: { client: signal, deadline: signal, combined: signal },
        finalize: () => {
          routeFinalized++;
        },
        usageMode: "compatible",
        includeEncryptedReasoning: false,
        configuration: {
          instructions: null,
          maxOutputTokens: null,
          metadata: {},
          reasoningEffort: null,
          toolChoice: "auto",
          tools: [],
        },
      }),
  };
}

describe("Responses adapter and pipeline terminal ownership", () => {
  test("completes the Responses stream without closing a cancelled canonical controller again", async () => {
    const audit = captureAuditEvents();
    const f = streamFixture();
    try {
      const text = await f.adapted().text();
      await Bun.sleep(1);
      expect(text.match(/event: response.completed/g)).toHaveLength(1);
      expect(text).not.toContain("event: response.failed");
      expect(f.counts()).toEqual({ finalized: 1, aborted: 0, routeFinalized: 1 });
      expect(audit.events("stream_cleanup_failed")).toEqual([]);
      expect(audit.events("sdk_stream_terminal").map((row) => row.terminal_provenance)).toEqual([
        "normal_complete",
      ]);
    } finally {
      audit.restore();
    }
  });

  test("keeps ordinary EOF, completed cancellation and early cancellation distinct", async () => {
    const audit = captureAuditEvents();
    try {
      const eof = streamFixture();
      await eof.response.text();
      expect(eof.counts()).toMatchObject({ finalized: 1, aborted: 0 });

      const completed = streamFixture();
      const reader = completed.response.body?.getReader();
      if (!reader) throw new Error("fixture stream missing");
      const decoder = new TextDecoder();
      for (;;) {
        const result = await reader.read();
        if (result.done) throw new Error("fixture completed event missing");
        const rows = decoder
          .decode(result.value)
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        if (rows.some((row) => row.type === "completed")) break;
      }
      await reader.cancel();
      expect(completed.counts()).toMatchObject({ finalized: 1, aborted: 0 });

      const early = streamFixture();
      await early.response.body?.cancel("fixture-cancel");
      expect(early.counts()).toMatchObject({ finalized: 1, aborted: 1 });
      expect(audit.events("stream_cleanup_failed")).toEqual([]);
    } finally {
      audit.restore();
    }
  });
});
