import { describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import type {
  PipelineAccountManager,
  PipelineTokenRefresher,
  RunChatCompletionOptions,
} from "../src/core/pipeline.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import {
  CANONICAL_OUTPUT_JSON_CONTENT_TYPE,
  CANONICAL_OUTPUT_VERSION,
} from "../src/protocol/output.js";
import {
  completedToolCallItems,
  handleResponses,
  outputTextContent,
  type ResponsesDependencies,
  responsesUsage,
} from "../src/server/routes/responses.js";

const MODEL = "gpt-5.6-sol";

function config(): Config {
  return ConfigSchema.parse({
    api_keys: ["sk-responses"],
    request_timeout_ms: 1_000,
    max_request_body_bytes: 16_384,
  });
}

function account(): ManagedAccount {
  return {
    id: "responses-account",
    email: "responses@example.com",
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
  async refreshIfNeeded(selected) {
    return selected;
  },
  async forceRefresh(selected) {
    return selected;
  },
};

function dependencies(
  runPipeline: (options: RunChatCompletionOptions) => Promise<Response>,
): ResponsesDependencies {
  return { accountManager: new StubAccountManager(), tokenRefresher, runPipeline };
}

function request(body: unknown): Request {
  return new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function canonicalResponse(overrides: Readonly<Record<string, unknown>> = {}): Response {
  return new Response(
    JSON.stringify({
      canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
      conversationId: "conversation-id",
      model: MODEL,
      createdAt: 1_700_000_000,
      text: "answer",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      ...overrides,
    }),
    { headers: { "Content-Type": CANONICAL_OUTPUT_JSON_CONTENT_TYPE } },
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("non-stream Responses output shape", () => {
  test("marks function_call items completed and includes logprobs and usage details", async () => {
    const response = await handleResponses(
      request({
        model: MODEL,
        input: "hello",
        stream: false,
        tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
      }),
      config(),
      dependencies(async () =>
        canonicalResponse({
          toolCalls: [{ id: "call-1", name: "read", input: '{"path":"a"}' }],
          finishReason: "tool_calls",
        }),
      ),
    );
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    if (!isRecord(body) || !Array.isArray(body.output)) {
      throw new TypeError("Responses body must contain output items");
    }
    const message = body.output.find((item) => isRecord(item) && item.type === "message");
    const call = body.output.find((item) => isRecord(item) && item.type === "function_call");
    expect(message).toMatchObject({
      type: "message",
      status: "completed",
      content: [{ type: "output_text", text: "answer", annotations: [], logprobs: [] }],
    });
    expect(call).toMatchObject({
      type: "function_call",
      call_id: "call-1",
      name: "read",
      arguments: '{"path":"a"}',
      status: "completed",
    });
    expect(body.usage).toEqual({
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    });
  });

  test("exposes the shared helpers used to build the completed output", () => {
    expect(outputTextContent("text")).toEqual({
      type: "output_text",
      text: "text",
      annotations: [],
      logprobs: [],
    });
    expect(responsesUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 3 })).toEqual({
      input_tokens: 1,
      output_tokens: 2,
      total_tokens: 3,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    });
    expect(
      completedToolCallItems([
        { id: "fc_1", type: "function_call", call_id: "call-1", name: "read", arguments: "{}" },
        { id: "fc_2", type: "custom_tool_call", call_id: "call-2", name: "shell", input: "ls" },
      ]),
    ).toEqual([
      {
        id: "fc_1",
        type: "function_call",
        call_id: "call-1",
        name: "read",
        arguments: "{}",
        status: "completed",
      },
      {
        id: "fc_2",
        type: "custom_tool_call",
        call_id: "call-2",
        name: "shell",
        input: "ls",
        status: "completed",
      },
    ]);
  });
});
