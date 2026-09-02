import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
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
  type CanonicalOutputToolCall,
} from "../src/protocol/output.js";
import { handleResponses, type ResponsesDependencies } from "../src/server/routes/responses.js";

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

function completionWithToolCalls(toolCalls: readonly CanonicalOutputToolCall[]): Response {
  return new Response(
    JSON.stringify({
      canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
      conversationId: "conversation-id",
      model: MODEL,
      createdAt: 1_700_000_000,
      text: "",
      toolCalls,
      finishReason: "tool_calls",
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    }),
    { headers: { "Content-Type": CANONICAL_OUTPUT_JSON_CONTENT_TYPE } },
  );
}

describe("non-stream Responses tool restoration failures", () => {
  let errorSpy: Mock<typeof console.error>;

  beforeEach(() => {
    errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  function auditEvents(): Array<Readonly<Record<string, unknown>>> {
    return errorSpy.mock.calls
      .map((call) => call[0])
      .filter((line): line is string => typeof line === "string")
      .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>)
      .filter((entry) => entry.event === "upstream_tool_restore_failed");
  }

  test("an undeclared upstream tool returns 502 unknown_upstream_tool with a hashed audit event", async () => {
    const response = await handleResponses(
      request({
        model: MODEL,
        input: "hello",
        stream: false,
        tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
      }),
      config(),
      dependencies(async () =>
        completionWithToolCalls([{ id: "call-1", name: "hallucinated_tool", input: "{}" }]),
      ),
    );
    const body: unknown = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: {
        message: expect.stringContaining("undeclared"),
        type: "upstream_error",
        code: "unknown_upstream_tool",
      },
    });
    const audits = auditEvents();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      level: "warn",
      protocol: "responses",
      error_code: "unknown_upstream_tool",
      error_disposition: "fatal",
      bridge_code: "unknown_tool_alias",
      tool_name_hash: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(JSON.stringify(audits[0])).not.toContain("hallucinated_tool");
  });

  test("a malformed custom wrapper returns 502 invalid_custom_tool_input", async () => {
    const response = await handleResponses(
      request({
        model: MODEL,
        input: "hello",
        stream: false,
        tools: [{ type: "custom", name: "exec" }],
      }),
      config(),
      dependencies(async () =>
        completionWithToolCalls([{ id: "call-1", name: "kiro_custom_0", input: '{"input":1}' }]),
      ),
    );
    const body: unknown = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      error: { type: "upstream_error", code: "invalid_custom_tool_input" },
    });
    expect(auditEvents()[0]).toMatchObject({
      error_code: "invalid_custom_tool_input",
      bridge_code: "invalid_custom_tool_input",
    });
  });

  test("a declared tool call still completes without any restore audit", async () => {
    const response = await handleResponses(
      request({
        model: MODEL,
        input: "hello",
        stream: false,
        tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
      }),
      config(),
      dependencies(async () =>
        completionWithToolCalls([{ id: "call-1", name: "read", input: '{"path":"a"}' }]),
      ),
    );

    expect(response.status).toBe(200);
    expect(auditEvents()).toHaveLength(0);
  });
});
