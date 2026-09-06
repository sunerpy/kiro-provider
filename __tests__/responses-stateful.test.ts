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
import { responseState } from "../src/server/responses/state.js";
import { SqliteResponseStore } from "../src/server/responses/store.js";
import {
  handleResponses,
  handleStoredResponse,
  type ResponsesDependencies,
} from "../src/server/routes/responses.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

const MODEL = "gpt-5.6-sol";

function config(): Config {
  return ConfigSchema.parse({
    api_keys: ["sk-stateful"],
    protocol_projection_mode: "safe",
    request_timeout_ms: 1_000,
    max_request_body_bytes: 16_384,
  });
}

function account(): ManagedAccount {
  return {
    id: "stateful-account",
    email: "stateful@example.invalid",
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

function post(body: unknown): Request {
  return new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function canonicalResponse(
  text: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Response {
  return new Response(
    JSON.stringify({
      canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
      conversationId: crypto.randomUUID(),
      model: MODEL,
      createdAt: Date.now(),
      text,
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      ...overrides,
    }),
    { headers: { "Content-Type": CANONICAL_OUTPUT_JSON_CONTENT_TYPE } },
  );
}

describe("locally mirrored Responses state", () => {
  test("stores, retrieves, continues, lists input items, and deletes a response", async () => {
    const database = new AccountsDatabase(":memory:");
    const responseStore = new SqliteResponseStore(database);
    const captured: RunChatCompletionOptions[] = [];
    const dependencies: ResponsesDependencies = {
      accountManager: new StubAccountManager(),
      tokenRefresher,
      tenantId: "tenant-stateful",
      responseStore,
      runPipeline: async (options) => {
        captured.push(options);
        return canonicalResponse(`answer-${captured.length}`);
      },
    };

    try {
      const first = await handleResponses(
        post({ model: MODEL, input: "first", stream: false }),
        config(),
        dependencies,
      );
      const firstBody = (await first.json()) as {
        id: string;
        store: boolean;
        previous_response_id: string | null;
      };
      expect(first.status).toBe(200);
      expect(firstBody.store).toBe(true);
      expect(firstBody.previous_response_id).toBeNull();

      const retrieved = handleStoredResponse(
        new Request(`http://gateway/v1/responses/${firstBody.id}`),
        dependencies,
        firstBody.id,
        "retrieve",
      );
      expect(retrieved.status).toBe(200);
      expect(await retrieved.json()).toMatchObject({ id: firstBody.id, status: "completed" });

      const items = handleStoredResponse(
        new Request(`http://gateway/v1/responses/${firstBody.id}/input_items`),
        dependencies,
        firstBody.id,
        "input_items",
      );
      expect(await items.json()).toMatchObject({
        object: "list",
        data: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "first" }],
          },
        ],
        has_more: false,
      });

      const second = await handleResponses(
        post({
          model: MODEL,
          previous_response_id: firstBody.id,
          input: "second",
          stream: false,
        }),
        config(),
        dependencies,
      );
      const secondBody = (await second.json()) as {
        previous_response_id: string | null;
      };
      if (second.status !== 200) {
        throw new Error(`Unexpected continuation response: ${await second.text()}`);
      }
      expect(secondBody.previous_response_id).toBe(firstBody.id);
      expect(
        captured[1]?.body.messages.map((message) => ({
          role: message.role,
          text: message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
        })),
      ).toEqual([
        { role: "user", text: "first" },
        { role: "assistant", text: "answer-1" },
        { role: "user", text: "second" },
      ]);

      const deleted = handleStoredResponse(
        new Request(`http://gateway/v1/responses/${firstBody.id}`, { method: "DELETE" }),
        dependencies,
        firstBody.id,
        "delete",
      );
      expect(await deleted.json()).toEqual({
        id: firstBody.id,
        object: "response.deleted",
        deleted: true,
      });
      expect(
        handleStoredResponse(
          new Request(`http://gateway/v1/responses/${firstBody.id}`),
          dependencies,
          firstBody.id,
          "retrieve",
        ).status,
      ).toBe(404);
    } finally {
      database.close();
    }
  });

  test("keeps stored responses tenant-isolated and honors store=false", async () => {
    const database = new AccountsDatabase(":memory:");
    const responseStore = new SqliteResponseStore(database);
    const dependencies: ResponsesDependencies = {
      accountManager: new StubAccountManager(),
      tokenRefresher,
      tenantId: "tenant-a",
      responseStore,
      runPipeline: async () => canonicalResponse("ephemeral"),
    };

    try {
      const response = await handleResponses(
        post({ model: MODEL, input: "private", store: false }),
        config(),
        dependencies,
      );
      const body = (await response.json()) as { id: string; store: boolean };
      expect(body.store).toBe(false);
      expect(responseStore.get("tenant-a", body.id)).toBeUndefined();
      expect(responseStore.get("tenant-b", body.id)).toBeUndefined();
    } finally {
      database.close();
    }
  });

  test("lists stored input items in OpenAI cursor order with stable ids", async () => {
    const database = new AccountsDatabase(":memory:");
    const responseStore = new SqliteResponseStore(database);
    const dependencies: ResponsesDependencies = {
      accountManager: new StubAccountManager(),
      tokenRefresher,
      tenantId: "tenant-pagination",
      responseStore,
    };
    const responseId = "resp_pagination";
    responseStore.putNative(
      "tenant-pagination",
      responseState({ id: responseId, model: MODEL, status: "completed" }),
      [
        { id: "msg_1", type: "message", role: "user", content: "one" },
        { id: "msg_2", type: "message", role: "user", content: "two" },
        { id: "msg_3", type: "message", role: "user", content: "three" },
      ],
    );

    try {
      const firstPage = handleStoredResponse(
        new Request(`http://gateway/v1/responses/${responseId}/input_items?limit=2`),
        dependencies,
        responseId,
        "input_items",
      );
      expect(await firstPage.json()).toMatchObject({
        data: [{ id: "msg_3" }, { id: "msg_2" }],
        first_id: "msg_3",
        last_id: "msg_2",
        has_more: true,
      });

      const nextPage = handleStoredResponse(
        new Request(`http://gateway/v1/responses/${responseId}/input_items?limit=2&after=msg_2`),
        dependencies,
        responseId,
        "input_items",
      );
      expect(await nextPage.json()).toMatchObject({
        data: [{ id: "msg_1" }],
        first_id: "msg_1",
        last_id: "msg_1",
        has_more: false,
      });

      const ascending = handleStoredResponse(
        new Request(`http://gateway/v1/responses/${responseId}/input_items?order=asc&limit=2`),
        dependencies,
        responseId,
        "input_items",
      );
      expect(await ascending.json()).toMatchObject({
        data: [{ id: "msg_1" }, { id: "msg_2" }],
      });

      const invalidCursor = handleStoredResponse(
        new Request(`http://gateway/v1/responses/${responseId}/input_items?after=msg_missing`),
        dependencies,
        responseId,
        "input_items",
      );
      expect(invalidCursor.status).toBe(400);
      expect(await invalidCursor.json()).toMatchObject({
        error: { code: "invalid_cursor", param: "after" },
      });
    } finally {
      database.close();
    }
  });

  test("continues a stored function call with a standard function_call_output item", async () => {
    const database = new AccountsDatabase(":memory:");
    const responseStore = new SqliteResponseStore(database);
    const captured: RunChatCompletionOptions[] = [];
    const dependencies: ResponsesDependencies = {
      accountManager: new StubAccountManager(),
      tokenRefresher,
      tenantId: "tenant-tools",
      responseStore,
      runPipeline: async (options) => {
        captured.push(options);
        return captured.length === 1
          ? canonicalResponse("", {
              toolCalls: [
                {
                  id: "call_weather",
                  name: "weather",
                  input: '{"city":"Shanghai"}',
                },
              ],
              finishReason: "tool_calls",
            })
          : canonicalResponse("sunny");
      },
    };
    const tools = [
      {
        type: "function",
        name: "weather",
        description: "Get synthetic weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];

    try {
      const first = await handleResponses(
        post({ model: MODEL, input: "weather?", tools }),
        config(),
        dependencies,
      );
      const firstBody = (await first.json()) as { id: string };
      const second = await handleResponses(
        post({
          model: MODEL,
          previous_response_id: firstBody.id,
          input: [
            {
              type: "function_call_output",
              call_id: "call_weather",
              output: "sunny",
            },
          ],
          tools,
        }),
        config(),
        dependencies,
      );

      if (second.status !== 200) {
        throw new Error(`Unexpected tool continuation response: ${await second.text()}`);
      }
      expect(captured[1]?.body.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "tool",
      ]);
      expect(captured[1]?.body.messages[1]?.toolCalls).toEqual([
        {
          id: "call_weather",
          name: "weather",
          input: { city: "Shanghai" },
          path: expect.any(String),
        },
      ]);
      expect(captured[1]?.body.messages[2]?.content).toMatchObject([
        {
          type: "tool_result",
          toolCallId: "call_weather",
          content: [{ type: "text", text: "sunny" }],
        },
      ]);
    } finally {
      database.close();
    }
  });
});
