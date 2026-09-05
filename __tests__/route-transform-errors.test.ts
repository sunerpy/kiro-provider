import { describe, expect, test } from "bun:test";
import type { GenerateAssistantResponseCommand } from "@aws/codewhisperer-streaming-client";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import type {
  PipelineAccountManager,
  PipelineClientFactory,
  PipelineSdkClient,
  PipelineTokenRefresher,
} from "../src/core/pipeline.js";
import type {
  SdkStreamEvent,
  SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import { handleChatCompletions } from "../src/server/routes/chat-completions.js";
import { handleMessages } from "../src/server/routes/messages.js";
import { handleResponses } from "../src/server/routes/responses.js";

function config(): Config {
  return ConfigSchema.parse({
    api_keys: ["sk-route-transform"],
    enable_legacy_chat_completions: true,
    protocol_projection_mode: "legacy-user-prefix",
    request_timeout_ms: 5_000,
    rate_limit_retry_delay_ms: 1,
  });
}

function account(): ManagedAccount {
  return {
    id: "route-transform-account",
    email: "route-transform@example.com",
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

class StubAccountManager implements PipelineAccountManager {
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

const tokenRefresher: PipelineTokenRefresher = {
  refreshIfNeeded: async (selected) => selected,
  forceRefresh: async (selected) => selected,
};

function sdkResponse(events: readonly SdkStreamEvent[]): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
        for (const event of events) yield event;
      },
    },
  };
}

function post(path: string, body: unknown): Request {
  return new Request(`http://gateway${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rejectingDependencies(): {
  readonly dependencies: {
    readonly accountManager: StubAccountManager;
    readonly tokenRefresher: PipelineTokenRefresher;
    readonly makeClient: PipelineClientFactory;
  };
  readonly calls: () => { readonly factories: number; readonly sends: number };
} {
  let factories = 0;
  let sends = 0;
  const client: PipelineSdkClient = {
    async send() {
      sends += 1;
      return sdkResponse([]);
    },
  };
  return {
    dependencies: {
      accountManager: new StubAccountManager(),
      tokenRefresher,
      makeClient: () => {
        factories += 1;
        return client;
      },
    },
    calls: () => ({ factories, sends }),
  };
}

describe("public route transform failures", () => {
  test("Responses preserves missing_current_input code and param without creating an SDK client", async () => {
    const fixture = rejectingDependencies();
    const response = await handleResponses(
      post("/v1/responses", {
        model: "gpt-5.6-sol",
        stream: false,
        input: [{ role: "assistant", content: "prefill" }],
      }),
      config(),
      fixture.dependencies,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        code: "missing_current_input",
        param: "input.0",
      },
    });
    expect(fixture.calls()).toEqual({ factories: 0, sends: 0 });
  });

  test("Chat preserves missing_current_input code and param without creating an SDK client", async () => {
    const fixture = rejectingDependencies();
    const response = await handleChatCompletions(
      post("/v1/chat/completions", {
        model: "gpt-5.6-sol",
        stream: false,
        messages: [{ role: "assistant", content: "prefill" }],
      }),
      config(),
      fixture.dependencies,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        code: "missing_current_input",
        param: "messages.0",
      },
    });
    expect(fixture.calls()).toEqual({ factories: 0, sends: 0 });
  });

  test("Anthropic returns its native invalid_request_error envelope without contacting Kiro", async () => {
    const fixture = rejectingDependencies();
    const response = await handleMessages(
      post("/v1/messages", {
        model: "claude-sonnet-5",
        max_tokens: 1_024,
        stream: false,
        messages: [{ role: "assistant", content: "prefill" }],
      }),
      config(),
      fixture.dependencies,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: expect.stringContaining("no current user input"),
      },
    });
    expect(fixture.calls()).toEqual({ factories: 0, sends: 0 });
  });

  test("Responses preserves the Kiro tool-description rejection path without SDK dispatch", async () => {
    const fixture = rejectingDependencies();
    const response = await handleResponses(
      post("/v1/responses", {
        model: "gpt-5.6-sol",
        stream: false,
        input: "hello",
        tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
      }),
      config(),
      fixture.dependencies,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        code: "missing_tool_description",
        param: "tools.0.description",
      },
    });
    expect(fixture.calls()).toEqual({ factories: 0, sends: 0 });
  });

  test("Chat preserves the Kiro tool-description rejection path without SDK dispatch", async () => {
    const fixture = rejectingDependencies();
    const response = await handleChatCompletions(
      post("/v1/chat/completions", {
        model: "gpt-5.6-sol",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            type: "function",
            function: { name: "read", parameters: { type: "object" } },
          },
        ],
      }),
      config(),
      fixture.dependencies,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        code: "missing_tool_description",
        param: "tools.0.function.description",
      },
    });
    expect(fixture.calls()).toEqual({ factories: 0, sends: 0 });
  });

  test("Anthropic maps the Kiro tool-description rejection to its native envelope", async () => {
    const fixture = rejectingDependencies();
    const response = await handleMessages(
      post("/v1/messages", {
        model: "claude-sonnet-5",
        max_tokens: 1_024,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
        tools: [{ name: "read", input_schema: { type: "object" } }],
      }),
      config(),
      fixture.dependencies,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: expect.stringContaining("requires a non-empty description"),
      },
    });
    expect(fixture.calls()).toEqual({ factories: 0, sends: 0 });
  });
});

describe("public route trailing-instruction projection", () => {
  const cases = [
    {
      label: "Responses",
      run: handleResponses,
      request: () =>
        post("/v1/responses", {
          model: "gpt-5.6-sol",
          stream: false,
          input: [
            { role: "user", content: "question" },
            { role: "assistant", content: "final answer" },
            { role: "developer", content: "RECONCILE" },
          ],
        }),
    },
    {
      label: "Chat",
      run: handleChatCompletions,
      request: () =>
        post("/v1/chat/completions", {
          model: "gpt-5.6-sol",
          stream: false,
          messages: [
            { role: "user", content: "question" },
            { role: "assistant", content: "final answer" },
            { role: "developer", content: "RECONCILE" },
          ],
        }),
    },
  ] as const;

  for (const route of cases) {
    test(`${route.label} sends the trailing instruction as the non-empty current message`, async () => {
      let command: GenerateAssistantResponseCommand | undefined;
      const client: PipelineSdkClient = {
        async send(next) {
          command = next;
          return sdkResponse([
            { assistantResponseEvent: { content: "done" } },
            {
              metadataEvent: {
                tokenUsage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
              },
            },
          ]);
        },
      };
      const response = await route.run(route.request(), config(), {
        accountManager: new StubAccountManager(),
        tokenRefresher,
        makeClient: () => client,
      });

      expect(response.status).toBe(200);
      const input = command?.input as
        | {
            conversationState?: {
              history?: Array<{
                userInputMessage?: { content?: string };
                assistantResponseMessage?: { content?: string };
              }>;
              currentMessage?: { userInputMessage?: { content?: string } };
            };
          }
        | undefined;
      expect(
        input?.conversationState?.history?.map(
          (entry) => entry.userInputMessage?.content ?? entry.assistantResponseMessage?.content,
        ),
      ).toEqual(["question", "final answer"]);
      expect(input?.conversationState?.currentMessage?.userInputMessage?.content).toBe("RECONCILE");
    });
  }
});
