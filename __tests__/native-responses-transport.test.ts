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
import { SqliteResponseStore } from "../src/server/responses/store.js";
import { handleResponses, type ResponsesDependencies } from "../src/server/routes/responses.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

function account(id = "native-account"): ManagedAccount {
  return {
    id,
    email: `${id}@example.invalid`,
    authMethod: "desktop",
    region: "us-east-1",
    profileArn: `arn:aws:codewhisperer:us-east-1:123456789012:profile/${id}`,
    refreshToken: "refresh-token",
    accessToken: `access-${id}`,
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
  };
}

class StubAccountManager implements PipelineAccountManager {
  readonly selected = account();
  readonly preferred: Array<string | undefined> = [];

  reconcileFromDb(): readonly ManagedAccount[] {
    return [this.selected];
  }

  selectHealthyAccount(preferredAccountId?: string): ManagedAccount {
    this.preferred.push(preferredAccountId);
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
      profileArn: selected.profileArn,
    };
  }

  markRateLimited(): void {}

  markUnhealthy(): void {}
}

const tokenRefresher: PipelineTokenRefresher = {
  refreshIfNeeded: async (selected) => selected,
  forceRefresh: async (selected) => selected,
};

function config(): Config {
  return ConfigSchema.parse({
    api_keys: ["sk-native"],
    protocol_projection_mode: "v3-auto",
    request_timeout_ms: 5_000,
    test_upstream_endpoint: "https://runtime.example.invalid",
  });
}

function request(body: unknown): Request {
  return new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function nativeResponse(id: string, model = "gpt-5.6-sol"): Record<string, unknown> {
  return {
    id,
    object: "response",
    created_at: 1_788_590_000,
    completed_at: 1_788_590_001,
    status: "completed",
    background: false,
    billing: { synthetic: true },
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    max_tool_calls: null,
    metadata: {},
    model,
    output: [
      {
        id: `msg_${id}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "OK", annotations: [], logprobs: [] }],
      },
    ],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    service_tier: null,
    store: true,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_logprobs: null,
    top_p: null,
    truncation: "disabled",
    user: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

describe("native KiroRuntime Responses transport", () => {
  test("projects model effort, strips private fields, mirrors state, and binds continuation", async () => {
    const database = new AccountsDatabase(":memory:");
    const responseStore = new SqliteResponseStore(database);
    const accountManager = new StubAccountManager();
    const bodies: Array<Record<string, unknown>> = [];
    const headers: string[] = [];
    let call = 0;
    const dependencies: ResponsesDependencies = {
      accountManager,
      tokenRefresher,
      tenantId: "tenant-native",
      affinityStore: database,
      responseStore,
      nativeResponsesFetch: async (_url: string | URL | Request, init?: RequestInit) => {
        call += 1;
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        headers.push(new Headers(init?.headers).get("x-amzn-kiro-profile") ?? "");
        const response = nativeResponse(`resp_native_${call}`);
        if (call === 2) response.previous_response_id = "resp_native_1";
        return Response.json(response);
      },
    };

    try {
      const first = await handleResponses(
        request({
          model: "gpt-5.6-sol-xhigh",
          input: "hello",
          metadata: { thread: "one" },
          service_tier: "default",
        }),
        config(),
        dependencies,
      );
      const firstBody = (await first.json()) as Record<string, unknown>;

      expect(first.status).toBe(200);
      expect(bodies[0]).toMatchObject({
        model: "gpt-5.6-sol",
        input: "hello",
        reasoning: { effort: "xhigh" },
      });
      expect(headers[0]).toContain("profile/native-account");
      expect(firstBody.model).toBe("gpt-5.6-sol-xhigh");
      expect(firstBody.metadata).toEqual({ thread: "one" });
      expect(firstBody.service_tier).toBe("default");
      expect("billing" in firstBody).toBe(false);
      expect(responseStore.get("tenant-native", "resp_native_1")?.response).toMatchObject({
        id: "resp_native_1",
      });
      expect(responseStore.get("tenant-native", "resp_native_1")?.inputItems).toMatchObject([
        {
          id: expect.stringMatching(/^msg_/),
          type: "message",
          status: "completed",
        },
      ]);

      const second = await handleResponses(
        request({
          model: "gpt-5.6-sol",
          previous_response_id: "resp_native_1",
          input: "continue",
        }),
        config(),
        dependencies,
      );
      expect(second.status).toBe(200);
      expect(accountManager.preferred).toEqual([undefined, "native-account"]);
      expect(bodies[1]).toMatchObject({
        previous_response_id: "resp_native_1",
        input: "continue",
      });

      const storeFalseContinuation = await handleResponses(
        request({
          model: "gpt-5.6-sol",
          previous_response_id: "resp_native_1",
          input: "continue without storage",
          store: false,
        }),
        config(),
        dependencies,
      );
      expect(storeFalseContinuation.status).toBe(400);
      expect(await storeFalseContinuation.json()).toMatchObject({
        error: {
          code: "native_store_false_requires_stateless_transport",
          param: "store",
        },
      });

      const serialContinuation = await handleResponses(
        request({
          model: "gpt-5.6-sol",
          previous_response_id: "resp_native_1",
          input: "continue serially",
          parallel_tool_calls: false,
        }),
        config(),
        dependencies,
      );
      expect(serialContinuation.status).toBe(400);
      expect(await serialContinuation.json()).toMatchObject({
        error: {
          code: "native_parallel_tool_control_requires_stateless_transport",
          param: "parallel_tool_calls",
        },
      });

      const maxContinuation = await handleResponses(
        request({
          model: "gpt-5.6-sol-max",
          previous_response_id: "resp_native_1",
          input: "continue at max effort",
        }),
        config(),
        dependencies,
      );
      expect(maxContinuation.status).toBe(400);
      expect(await maxContinuation.json()).toMatchObject({
        error: {
          code: "native_max_effort_requires_stateless_transport",
          param: "model",
        },
      });
      expect(call).toBe(2);
    } finally {
      database.close();
    }
  });

  test("normalizes standard SSE events and stores the completed response", async () => {
    const database = new AccountsDatabase(":memory:");
    const responseStore = new SqliteResponseStore(database);
    const created = nativeResponse("resp_stream");
    created.status = "in_progress";
    created.completed_at = null;
    created.output = [];
    const completed = nativeResponse("resp_stream");
    const sse = [
      `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: created })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: 1, delta: "OK", item_id: "msg", output_index: 0, content_index: 0 })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 2, response: completed })}`,
    ].join("");
    const dependencies: ResponsesDependencies = {
      accountManager: new StubAccountManager(),
      tokenRefresher,
      tenantId: "tenant-stream",
      affinityStore: database,
      responseStore,
      nativeResponsesFetch: async () =>
        new Response(sse, {
          headers: { "Content-Type": "text/event-stream" },
        }),
    };

    try {
      const response = await handleResponses(
        request({ model: "gpt-5.6-sol-xhigh", input: "stream", stream: true }),
        config(),
        dependencies,
      );
      const output = await response.text();

      expect(response.status).toBe(200);
      expect(output).toContain("response.output_text.delta");
      expect(output).toContain('"model":"gpt-5.6-sol-xhigh"');
      expect(output).not.toContain("billing");
      expect(responseStore.get("tenant-stream", "resp_stream")?.response).toMatchObject({
        id: "resp_stream",
        model: "gpt-5.6-sol-xhigh",
      });
    } finally {
      database.close();
    }
  });

  test("rejects model-incompatible controls before dispatch", async () => {
    let calls = 0;
    const dependencies: ResponsesDependencies = {
      accountManager: new StubAccountManager(),
      tokenRefresher,
      nativeResponsesFetch: async () => {
        calls += 1;
        return Response.json(nativeResponse("never"));
      },
    };

    const gptTemperature = await handleResponses(
      request({ model: "gpt-5.6-sol", input: "q", temperature: 0 }),
      config(),
      dependencies,
    );
    const claudeTopP = await handleResponses(
      request({ model: "claude-opus-5", input: "q", top_p: 0.9 }),
      config(),
      dependencies,
    );

    expect(gptTemperature.status).toBe(400);
    expect(claudeTopP.status).toBe(400);
    expect(calls).toBe(0);
  });

  test("routes store=false through the stateless pipeline", async () => {
    let nativeCalls = 0;
    let pipelineOptions: RunChatCompletionOptions | undefined;
    const dependencies: ResponsesDependencies = {
      accountManager: new StubAccountManager(),
      tokenRefresher,
      nativeResponsesFetch: async () => {
        nativeCalls += 1;
        return Response.json(nativeResponse("unexpected"));
      },
      runPipeline: async (options) => {
        pipelineOptions = options;
        return new Response(
          JSON.stringify({
            canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
            conversationId: "stateless",
            model: "gpt-5.6-sol",
            createdAt: Date.now(),
            text: "OK",
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }),
          { headers: { "Content-Type": CANONICAL_OUTPUT_JSON_CONTENT_TYPE } },
        );
      },
    };

    const response = await handleResponses(
      request({
        model: "gpt-5.6-sol",
        instructions: "Reply exactly OK.",
        input: "hello",
        store: false,
      }),
      config(),
      dependencies,
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(nativeCalls).toBe(0);
    expect(pipelineOptions?.body.projectionMode).toBe("legacy-user-prefix");
    expect(body.store).toBe(false);
  });

  test("routes custom and namespace tool extensions through the stateless pipeline", async () => {
    let nativeCalls = 0;
    const pipelineBodies: RunChatCompletionOptions["body"][] = [];
    const dependencies: ResponsesDependencies = {
      accountManager: new StubAccountManager(),
      tokenRefresher,
      nativeResponsesFetch: async () => {
        nativeCalls += 1;
        return Response.json(nativeResponse("unexpected"));
      },
      runPipeline: async (options) => {
        pipelineBodies.push(options.body);
        return new Response(
          JSON.stringify({
            canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
            conversationId: "stateless-tools",
            model: "gpt-5.6-sol",
            createdAt: Date.now(),
            text: "OK",
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }),
          { headers: { "Content-Type": CANONICAL_OUTPUT_JSON_CONTENT_TYPE } },
        );
      },
    };

    const response = await handleResponses(
      request({
        model: "gpt-5.6-sol",
        input: "hello",
        tools: [
          {
            type: "namespace",
            name: "collaboration",
            description: "Synthetic collaboration namespace",
            tools: [
              {
                type: "function",
                name: "spawn_agent",
                description: "Spawn one synthetic agent",
                parameters: {
                  type: "object",
                  properties: { message: { type: "string" } },
                  required: ["message"],
                },
              },
            ],
          },
        ],
      }),
      config(),
      dependencies,
    );

    expect(response.status).toBe(200);
    expect(nativeCalls).toBe(0);
    expect(pipelineBodies[0]?.projectionMode).toBe("legacy-user-prefix");
    expect(pipelineBodies[0]?.tools[0]?.wireName).toMatch(/^kiro_ns_/);
  });
});
