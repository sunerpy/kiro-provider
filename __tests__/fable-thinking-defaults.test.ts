import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runChatCompletion } from "../src/core/pipeline.js";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import type { RouteDependencies } from "../src/server/ingress.js";
import { handleMessages } from "../src/server/routes/messages.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import { fidelityFixture } from "./responses-fidelity-helpers.js";

let audit: ReturnType<typeof captureAuditEvents>;
beforeEach(() => {
  audit = captureAuditEvents();
});
afterEach(() => audit.restore());

function fixture(multipleSummaryBlocks = true) {
  const f = fidelityFixture({
    config: {
      reasoning_replay_keys: [`fixture:${Buffer.alloc(32, 3).toString("base64url")}`],
      stream_max_attempts: 1,
      retry_empty_completion: false,
    },
  });
  const displays: Array<string | undefined> = [];
  const dependencies: RouteDependencies = {
    ...f.dependencies,
    runPipeline: runChatCompletion,
    reasoningReplayStore: new ReasoningReplayStore(f.database, f.config),
    makeClient: () => ({
      async send(command) {
        const fields = command.input.additionalModelRequestFields as
          | Record<string, unknown>
          | undefined;
        const thinking = fields?.thinking as { display?: string } | undefined;
        const display = thinking?.display;
        displays.push(display);
        return {
          generateAssistantResponseResponse: {
            async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
              if (display !== "omitted" && multipleSummaryBlocks) {
                // Observed Fable shape: text/signature, more text/a different
                // signature, all before assistant text or tool output.
                yield { reasoningContentEvent: { text: "segment one", signature: "sig-one" } };
                yield { reasoningContentEvent: { text: "segment two", signature: "sig-two" } };
              } else {
                yield {
                  reasoningContentEvent: {
                    text: display === "omitted" ? "" : "requested summary",
                    signature: "sig-complete",
                  },
                };
              }
              yield { assistantResponseEvent: { content: "FIXTURE_OK" } };
              yield {
                metadataEvent: {
                  tokenUsage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
                },
              };
            },
          },
        };
      },
    }),
  };
  return {
    ...f,
    displays,
    send(stream: boolean, display?: "omitted" | "summarized") {
      return handleMessages(
        new Request("http://fixture/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "claude-fable-5-1",
            max_tokens: 1024,
            stream,
            thinking: { type: "adaptive", ...(display ? { display } : {}) },
            messages: [{ role: "user", content: "A synthetic default-thinking fixture." }],
          }),
        }),
        f.config,
        dependencies,
      );
    },
  };
}

describe("Fable native default thinking display", () => {
  for (const stream of [false, true]) {
    test(`stream=${stream}: preserves native signatures without requesting summary blocks by default`, async () => {
      const f = fixture();
      try {
        const response = await f.send(stream);
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain("FIXTURE_OK");
        expect(text).toContain('"signature":"sig-complete"');
        expect(text).not.toContain("segment one");
        expect(text).not.toContain("event: error");
        expect(f.displays).toEqual(["omitted"]);
      } finally {
        f.database.close();
      }
    });
  }

  test("keeps the provider-bound opaque envelope for an explicit omitted request", async () => {
    const f = fixture();
    try {
      const response = await f.send(false, "omitted");
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('"signature":"kr2_');
      expect(text).not.toContain("sig-complete");
    } finally {
      f.database.close();
    }
  });

  test("honors an explicit summarized display request", async () => {
    const f = fixture(false);
    try {
      const response = await f.send(false, "summarized");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("requested summary");
      expect(f.displays).toEqual(["summarized"]);
    } finally {
      f.database.close();
    }
  });

  test("does not concatenate, choose one, or discard conflicting signed summary blocks", async () => {
    const f = fixture();
    try {
      const response = await f.send(false, "summarized");
      expect(response.status).toBe(502);
      expect(await response.text()).toContain("conflicting reasoning signatures");
    } finally {
      f.database.close();
    }
  });
});
