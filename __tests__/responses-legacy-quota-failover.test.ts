import { describe, expect, test } from "bun:test";
import { ConfigSchema } from "../src/config/schema.js";
import { type PipelineAccountManager, runChatCompletion } from "../src/core/pipeline.js";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import { assistantOutputFingerprint } from "../src/protocol/canonical.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import { handleMessages } from "../src/server/routes/messages.js";
import { handleResponses } from "../src/server/routes/responses.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

function account(id: string, exhausted = false): ManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    authMethod: "desktop",
    region: "us-east-1",
    profileArn: `arn:aws:codewhisperer:us-east-1:123456789012:profile/${id}`,
    refreshToken: `${id}-refresh`,
    accessToken: `${id}-access`,
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: exhausted ? 100 : 1,
    limitCount: 100,
  };
}

function manager(accounts: ManagedAccount[]): PipelineAccountManager {
  return {
    reconcileFromDb: () => accounts,
    getAccountCount: () => accounts.length,
    selectHealthyAccount: (preferred, eligible) =>
      accounts.find((entry) => entry.id === preferred && (eligible?.has(entry.id) ?? true)) ??
      accounts.find((entry) => eligible?.has(entry.id) ?? true) ??
      null,
    toAuthDetails: (entry) => ({
      refresh: entry.refreshToken,
      access: entry.accessToken,
      expires: entry.expiresAt,
      authMethod: entry.authMethod,
      region: entry.region,
      profileArn: entry.profileArn,
    }),
    markRateLimited: () => undefined,
    markUnhealthy: () => undefined,
  };
}

describe("Responses legacy quota failover through the public route", () => {
  test.each([
    { label: "database kr1 streaming", stream: true, mixed: false, strict: false },
    { label: "mixed old kr1 and new-owner kr2", stream: false, mixed: true, strict: false },
    { label: "strict owner binding", stream: false, mixed: false, strict: true },
  ])("preserves replay admission for $label", async ({ stream, mixed, strict }) => {
    const database = new AccountsDatabase(":memory:");
    const replayConfig = ConfigSchema.parse({
      api_keys: ["sk-test"],
      protocol_projection_mode: "v3-auto",
      reasoning_replay_token_format: "database-v1",
      reasoning_replay_legacy_account_failover: strict ? "strict" : "verified-current-cell",
      reasoning_replay_keys: [`test:${Buffer.alloc(32, 7).toString("base64url")}`],
      request_timeout_ms: 1_000,
      stream_idle_timeout_ms: 1_000,
    });
    try {
      const legacyStore = new ReasoningReplayStore(database, replayConfig);
      const context = {
        tenantId: "tenant-a",
        model: "gpt-5.6-sol",
        accountId: "account-a",
        conversationId: "conversation-a",
        outputFingerprint: assistantOutputFingerprint({ text: "prior answer", toolCalls: [] }),
        protocol: "responses" as const,
        region: "us-east-1",
        profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/account-a",
        runtimeProtocol: "codewhisperer" as const,
        upstreamOperation: "GenerateAssistantResponse" as const,
      };
      const legacy = legacyStore.store(
        { text: "signed old reasoning", signature: "old native signature" },
        context,
      );
      expect(legacy?.startsWith("kr1_")).toBe(true);
      const input: unknown[] = [
        { type: "reasoning", encrypted_content: legacy, summary: [] },
        { role: "assistant", content: "prior answer" },
        { role: "user", content: "continue" },
      ];
      if (mixed) {
        const portableStore = new ReasoningReplayStore(database, {
          ...replayConfig,
          reasoning_replay_token_format: "portable-v2",
        });
        const portable = portableStore.store(
          { text: "signed new reasoning", signature: "new native signature" },
          {
            ...context,
            accountId: "account-b",
            conversationId: "conversation-b",
            outputFingerprint: assistantOutputFingerprint({ text: "new answer", toolCalls: [] }),
            profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/account-b",
          },
        );
        expect(portable?.startsWith("kr2_")).toBe(true);
        input.push(
          { type: "reasoning", encrypted_content: portable, summary: [] },
          { role: "assistant", content: "new answer" },
          { role: "user", content: "continue again" },
        );
      }
      const selected: Array<string | undefined> = [];
      const runtimes: Array<string | undefined> = [];
      const commands: unknown[] = [];
      const projections: string[] = [];
      const response = await handleResponses(
        new Request("http://gateway/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-5.6-sol",
            store: false,
            stream,
            include: ["reasoning.encrypted_content"],
            input,
          }),
        }),
        replayConfig,
        {
          accountManager: manager([account("account-a", true), account("account-b")]),
          tokenRefresher: {
            refreshIfNeeded: async (entry) => entry,
            forceRefresh: async (entry) => entry,
          },
          tenantId: "tenant-a",
          reasoningReplayStore: legacyStore,
          runPipeline: (options) => {
            projections.push(options.body.projectionMode);
            return runChatCompletion({
              ...options,
              makeClient: (...args) => {
                selected.push(args[5]);
                runtimes.push(args[7]);
                return {
                  async send(command) {
                    commands.push(command.input);
                    return {
                      generateAssistantResponseResponse: {
                        async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
                          yield { assistantResponseEvent: { content: "legacy continued" } };
                          yield {
                            metadataEvent: {
                              tokenUsage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
                            },
                          };
                        },
                      },
                    };
                  },
                };
              },
            });
          },
        },
      );

      expect(projections).toEqual(["legacy-user-prefix"]);
      if (strict) {
        expect(response.status).toBe(402);
        expect(await response.json()).toMatchObject({
          error: { code: "reasoning_replay_account_quota_exhausted" },
        });
        expect(selected).toEqual([]);
      } else {
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain("legacy continued");
        if (stream) expect(text).toContain("response.completed");
        expect(selected).toEqual(["account-b"]);
        expect(runtimes).toEqual(["codewhisperer"]);
        const payload = JSON.stringify(commands);
        expect(payload).toContain("signed old reasoning");
        expect(payload).toContain("old native signature");
        expect(payload).toContain("prior answer");
        expect(payload).not.toContain("conversation-a");
        if (mixed) {
          expect(payload).toContain("signed new reasoning");
          expect(payload).toContain("new native signature");
          expect(payload).toContain("new answer");
        }
      }
    } finally {
      database.close();
    }
  });
});

describe("Messages quota failover through the public route", () => {
  for (const model of ["claude-sonnet-5", "claude-opus-5"]) {
    for (const format of ["database-v1", "portable-v2"] as const) {
      test.each([false, true])(
        `${model} ${format} keeps signed tool replay (stream=%s)`,
        async (stream) => {
          const db = new AccountsDatabase(":memory:");
          const config = ConfigSchema.parse({
            api_keys: ["sk-test"],
            protocol_projection_mode: "v3-auto",
            reasoning_replay_token_format: format,
            reasoning_replay_legacy_account_failover: "verified-current-cell",
            reasoning_replay_keys: [`test:${Buffer.alloc(32, 7).toString("base64url")}`],
          });
          try {
            const store = new ReasoningReplayStore(db, config);
            const token = store.store(
              { text: "private reasoning", signature: "signed material" },
              {
                tenantId: "tenant-a",
                model,
                accountId: "account-a",
                conversationId: "original",
                outputFingerprint: assistantOutputFingerprint({
                  text: "answer",
                  toolCalls: [{ id: "call-a", name: "lookup", input: '{"q":1}' }],
                }),
                protocol: "anthropic-messages",
                region: "us-east-1",
                profileArn: account("account-a").profileArn,
                runtimeProtocol: "kiro-runtime",
                upstreamOperation: "GenerateAssistantResponse",
              },
            );
            const selected: Array<string | undefined> = [];
            const response = await handleMessages(
              new Request("http://gateway/v1/messages", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model,
                  max_tokens: 1024,
                  stream,
                  tools: [
                    {
                      name: "lookup",
                      description: "Read a synthetic result",
                      input_schema: { type: "object", properties: { q: { type: "integer" } } },
                    },
                  ],
                  messages: [
                    { role: "user", content: "lookup" },
                    {
                      role: "assistant",
                      content: [
                        { type: "thinking", thinking: "", signature: token },
                        { type: "text", text: "answer" },
                        { type: "tool_use", id: "call-a", name: "lookup", input: { q: 1 } },
                      ],
                    },
                    {
                      role: "user",
                      content: [
                        { type: "tool_result", tool_use_id: "call-a", content: "synthetic result" },
                      ],
                    },
                  ],
                }),
              }),
              config,
              {
                accountManager: manager([account("account-a", true), account("account-b")]),
                tokenRefresher: { refreshIfNeeded: async (a) => a, forceRefresh: async (a) => a },
                tenantId: "tenant-a",
                reasoningReplayStore: store,
                runPipeline: (options) =>
                  runChatCompletion({
                    ...options,
                    makeClient: (...args) => {
                      selected.push(args[5]);
                      expect(args[7]).toBe("kiro-runtime");
                      return {
                        async send(command) {
                          const wire = JSON.stringify(command.input);
                          expect(wire).toContain("signed material");
                          expect(wire).toContain("private reasoning");
                          expect(wire).toContain("synthetic result");
                          expect(command.input.conversationState?.conversationId).not.toBe(
                            "original",
                          );
                          return {
                            generateAssistantResponseResponse: {
                              async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
                                yield { assistantResponseEvent: { content: "messages continued" } };
                                yield {
                                  metadataEvent: {
                                    tokenUsage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
                                  },
                                };
                              },
                            },
                          };
                        },
                      };
                    },
                  }),
              },
            );
            expect(response.status).toBe(200);
            const text = await response.text();
            expect(text).toContain("messages continued");
            if (stream) expect(text).toContain("message_stop");
            expect(selected).toEqual(["account-b"]);
          } finally {
            db.close();
          }
        },
      );
    }
  }
});
