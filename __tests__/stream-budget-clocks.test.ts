import { afterEach, describe, expect, test } from "bun:test";
import { ConfigSchema } from "../src/config/schema.js";
import type { PipelineAccountManager } from "../src/core/pipeline.js";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import { createApp } from "../src/server/app.js";
import { captureAuditEvents } from "./audit-test-helpers.js";

let audit: ReturnType<typeof captureAuditEvents> | undefined;
afterEach(() => audit?.restore());

const account: ManagedAccount = {
  id: "clock-fixture",
  email: "clock@example.invalid",
  authMethod: "desktop",
  region: "us-east-1",
  accessToken: "fixture-access",
  refreshToken: "fixture-refresh",
  expiresAt: Date.now() + 60_000,
  rateLimitResetTime: 0,
  isHealthy: true,
  failCount: 0,
};
const accounts: PipelineAccountManager = {
  reconcileFromDb: () => [account],
  selectHealthyAccount: () => account,
  getAccountCount: () => 1,
  toAuthDetails: () => ({
    access: account.accessToken,
    refresh: account.refreshToken,
    expires: account.expiresAt,
    authMethod: account.authMethod,
    region: account.region,
  }),
  markRateLimited() {},
  markUnhealthy() {},
};

describe.each(["responses", "chat/completions"] as const)("%s stream clocks over HTTP", (path) => {
  test.each(["raw-only", "growing-tool", "idle"] as const)(
    "%s ends at the correct clock without replay",
    async (mode) => {
      audit = captureAuditEvents();
      let sends = 0;
      let aborted = 0;
      let closed = 0;
      const config = ConfigSchema.parse({
        api_keys: ["fixture-key"],
        enable_legacy_chat_completions: true,
        request_timeout_ms: 200,
        stream_idle_timeout_ms: 65,
        rate_limit_max_retries: 3,
        stream_max_attempts: 3,
      });
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: createApp(config, {
          accountManager: accounts,
          tokenRefresher: {
            refreshIfNeeded: async () => account,
            forceRefresh: async () => account,
          },
          makeClient: () => ({
            async send(_command, options) {
              sends += 1;
              options.abortSignal.addEventListener(
                "abort",
                () => {
                  aborted += 1;
                },
                { once: true },
              );
              return {
                generateAssistantResponseResponse: {
                  async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
                    try {
                      let index = 0;
                      while (!options.abortSignal.aborted) {
                        if (mode === "idle" && index > 0) {
                          await new Promise<void>((resolve) =>
                            options.abortSignal.addEventListener("abort", () => resolve(), {
                              once: true,
                            }),
                          );
                          break;
                        }
                        yield mode === "growing-tool"
                          ? {
                              toolUseEvent: {
                                name: "lookup",
                                toolUseId: "clock-call",
                                input: index === 0 ? '{"query":"' : "x",
                              },
                            }
                          : { contextUsageEvent: { contextUsagePercentage: 1 } };
                        index += 1;
                        await Bun.sleep(10);
                      }
                    } finally {
                      closed += 1;
                    }
                  },
                },
              };
            },
          }),
        }),
      });
      try {
        const tool = {
          name: "lookup",
          description: "Synthetic tool; never execute",
          parameters: { type: "object" },
        };
        const response = await fetch(`http://127.0.0.1:${server.port}/v1/${path}`, {
          method: "POST",
          headers: { Authorization: "Bearer fixture-key", "Content-Type": "application/json" },
          body: JSON.stringify(
            path === "responses"
              ? {
                  model: "gpt-5.6-sol",
                  stream: true,
                  store: false,
                  input: "Synthetic budget probe",
                  tools: [{ type: "function", ...tool }],
                }
              : {
                  model: "gpt-5.6-sol",
                  stream: true,
                  messages: [{ role: "user", content: "Synthetic budget probe" }],
                  tools: [{ type: "function", function: tool }],
                },
          ),
        });
        expect(response.status).toBe(200);
        const text = await response.text();
        const terminal = audit.events("sdk_stream_terminal");
        expect(terminal).toHaveLength(1);
        expect(terminal[0]).toMatchObject({
          terminal_provenance: mode === "idle" ? "idle_timeout" : "external_abort",
          completion_witnessed: false,
          tool_count: 0,
          tool_intent_open: mode === "growing-tool",
        });
        if (mode !== "idle") {
          expect(terminal[0]?.raw_event_count).toBeGreaterThan(3);
          expect(audit.events("sdk_stream_idle_timeout")).toHaveLength(0);
        }
        if (path === "responses") {
          expect(text.match(/event: response.failed\n/g)).toHaveLength(1);
          expect(text).not.toContain("event: response.completed");
          expect(text).not.toContain("event: response.function_call_arguments.done");
          expect(text).not.toContain("event: response.output_item.done");
          expect(text.includes("event: response.function_call_arguments.delta")).toBe(
            mode === "growing-tool",
          );
        } else {
          expect(text).toContain('"error":');
          expect(text).not.toContain("data: [DONE]");
          expect(text).not.toContain('"finish_reason":"tool_calls"');
        }
        expect(text).toContain(mode === "idle" ? "upstream_stream_idle_timeout" : "deadline");
        expect(sends).toBe(1);
        expect(aborted).toBe(1);
        await Bun.sleep(15);
        expect(closed).toBe(1);
        expect(audit.events("request_cleanup_complete")).toHaveLength(1);
      } finally {
        server.stop(true);
      }
    },
  );
});
