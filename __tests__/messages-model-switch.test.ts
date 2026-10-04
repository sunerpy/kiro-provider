import { describe, expect, test } from "bun:test";
import type { GenerateAssistantResponseCommandInput } from "@aws/codewhisperer-streaming-client";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import { createApp } from "../src/server/app.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import { mintV3ReplayFixture } from "./legacy-replay-token-helpers.js";
import { fidelityFixture } from "./responses-fidelity-helpers.js";

describe("Messages model changes retain authenticated thinking/tool history", () => {
  for (const format of ["portable-v2", "database-v1", "legacy-v3"] as const) {
    for (const stream of [false, true]) {
      for (const target of ["claude-opus-5-5-low", "claude-opus-5", "claude-fable-5-1"]) {
        test(`${format}, stream=${stream}, target=${target}`, async () => {
          const audit = captureAuditEvents();
          const f = fidelityFixture({
            config: {
              reasoning_replay_token_format: format === "legacy-v3" ? "portable-v2" : format,
              reasoning_replay_keys: [`fixture:${Buffer.alloc(32, 4).toString("base64url")}`],
            },
          });
          const store = new ReasoningReplayStore(f.database, f.config);
          if (format === "legacy-v3")
            store.store = (capture, context) =>
              capture.signature || capture.redactedContent
                ? mintV3ReplayFixture(capture, context, Buffer.alloc(32, 4), Date.now(), true)
                : undefined;
          const dispatched: GenerateAssistantResponseCommandInput[] = [];
          const app = createApp(f.config, {
            accountManager: f.dependencies.accountManager,
            tokenRefresher: f.dependencies.tokenRefresher,
            reasoningReplayStore: store,
            makeClient: () => ({
              async send(command) {
                dispatched.push(command.input);
                const first = dispatched.length === 1;
                return {
                  generateAssistantResponseResponse: {
                    async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
                      if (first) {
                        yield {
                          reasoningContentEvent: {
                            text: "private fixture",
                            signature: "signed fixture",
                          },
                        };
                        yield { assistantResponseEvent: { content: "VISIBLE" } };
                        yield {
                          toolUseEvent: {
                            toolUseId: "call-fixture",
                            name: "capture_fixture",
                            input: '{"value":41}',
                            stop: true,
                          },
                        };
                      } else yield { assistantResponseEvent: { content: "ACK:41" } };
                      yield {
                        metadataEvent: {
                          tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                        },
                      };
                    },
                  },
                };
              },
            }),
          });
          const initial = [{ role: "user", content: "Call capture_fixture with 41" }];
          const send = (model: string, messages: unknown[], next: boolean) =>
            app(
              new Request("http://fixture/v1/messages", {
                method: "POST",
                headers: {
                  authorization: `Bearer ${f.config.api_keys[0]}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  model,
                  system: "FIXTURE_SYSTEM",
                  stream: next && stream,
                  max_tokens: 2048,
                  thinking: { type: "adaptive", display: "omitted" },
                  output_config: { effort: next ? "low" : "max" },
                  tools: [
                    {
                      name: "capture_fixture",
                      description: "Capture the fixture value",
                      input_schema: { type: "object", properties: { value: { type: "integer" } } },
                    },
                  ],
                  messages,
                }),
              }),
            );
          try {
            const source = format === "legacy-v3" ? "claude-fable-5-1" : "claude-opus-5-5-max";
            const first = await send(source, initial, false);
            expect(first.status).toBe(200);
            const content = (
              (await first.json()) as { content: Array<{ type: string; signature?: string }> }
            ).content;
            expect(
              content.find((block: { type: string }) => block.type === "thinking")?.signature,
            ).toStartWith(format === "database-v1" ? "kr1_" : "kr2_");
            const second = await send(
              target,
              [
                ...initial,
                { role: "assistant", content },
                {
                  role: "user",
                  content: [{ type: "tool_result", tool_use_id: "call-fixture", content: "41" }],
                },
              ],
              true,
            );
            expect(second.status).toBe(200);
            const omitted =
              format === "legacy-v3"
                ? target !== "claude-fable-5-1"
                : target !== "claude-opus-5-5-low";
            expect(second.headers.get("x-kiro-reasoning-model-replay-mode")).toBe(
              omitted ? "incompatible-omitted" : null,
            );
            const text = await second.text();
            expect(text).toContain("ACK:41");
            if (stream) expect(text.match(/event: message_stop/g)).toHaveLength(1);
            expect(dispatched).toHaveLength(2);
            const history = dispatched[1]?.conversationState?.history ?? [];
            expect(history.map((turn) => turn.userInputMessage?.content).join("\n")).toContain(
              "FIXTURE_SYSTEM",
            );
            const assistant = history.find(
              (turn) => turn.assistantResponseMessage?.toolUses?.length,
            )?.assistantResponseMessage;
            expect(assistant?.content).toBe("VISIBLE");
            expect(assistant?.toolUses?.[0]).toMatchObject({
              toolUseId: "call-fixture",
              name: "capture_fixture",
              input: { value: 41 },
            });
            expect(assistant?.reasoningContent).toEqual(
              omitted
                ? undefined
                : { reasoningText: { text: "private fixture", signature: "signed fixture" } },
            );
            expect(
              dispatched[1]?.conversationState?.currentMessage?.userInputMessage
                ?.userInputMessageContext?.toolResults?.[0],
            ).toMatchObject({ toolUseId: "call-fixture", content: [{ text: "41" }] });
          } finally {
            f.database.close();
            audit.restore();
          }
        });
      }
    }
  }
});
