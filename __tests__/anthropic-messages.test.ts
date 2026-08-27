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
  CANONICAL_OUTPUT_STREAM_CONTENT_TYPE,
  CANONICAL_OUTPUT_VERSION,
} from "../src/protocol/output.js";
import { adaptAnthropicMessagesRequest } from "../src/server/anthropic/request-adapter.js";
import { createApp } from "../src/server/app.js";
import {
  handleMessages,
  handleMessageTokenCount,
  type MessagesDependencies,
} from "../src/server/routes/messages.js";

const API_KEY = "sk-anthropic-test";
const MODEL = "claude-sonnet-5";

function config(): Config {
  return ConfigSchema.parse({
    api_keys: [API_KEY],
    request_timeout_ms: 1_000,
    stream_idle_timeout_ms: 1_000,
    max_request_body_bytes: 16_384,
  });
}

function account(): ManagedAccount {
  return {
    id: "anthropic-account",
    email: "anthropic@example.com",
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

class FakeAccountManager implements PipelineAccountManager {
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

class FakeTokenRefresher implements PipelineTokenRefresher {
  async refreshIfNeeded(selected: ManagedAccount): Promise<ManagedAccount> {
    return selected;
  }

  async forceRefresh(selected: ManagedAccount): Promise<ManagedAccount> {
    return selected;
  }
}

function request(
  body: unknown,
  path = "/v1/messages",
  headers: Readonly<Record<string, string>> = {
    Authorization: `Bearer ${API_KEY}`,
  },
): Request {
  return new Request(`http://test${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function validRequest(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    model: MODEL,
    max_tokens: 1_024,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

function completion(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
    conversationId: "conversation-id",
    model: MODEL,
    createdAt: 1_700_000_000,
    text: "hello from Kiro",
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    ...overrides,
  };
}

function canonicalResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": CANONICAL_OUTPUT_JSON_CONTENT_TYPE },
  });
}

function startedEvent(): Readonly<Record<string, unknown>> {
  return {
    canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
    type: "started",
    conversationId: "conversation-id",
    model: MODEL,
    createdAt: 1_700_000_000,
  };
}

function ndjson(lines: readonly (unknown | readonly unknown[])[]): Response {
  const flattened = [
    startedEvent(),
    ...lines.flatMap((line) => (Array.isArray(line) ? line : [line])),
  ];
  return new Response(flattened.map((line) => JSON.stringify(line)).join("\n"), {
    headers: { "Content-Type": CANONICAL_OUTPUT_STREAM_CONTENT_TYPE },
  });
}

function chunk(
  delta: Readonly<Record<string, unknown>>,
  finishReason: "stop" | "tool_calls" | null,
  usage?: Readonly<Record<string, number>>,
): readonly Readonly<Record<string, unknown>>[] {
  if (finishReason !== null) {
    return [{
      canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
      type: "completed",
      finishReason,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? 0,
      },
    }];
  }
  const events: Array<Readonly<Record<string, unknown>>> = [];
  if (typeof delta.reasoning_signature === "string") {
    events.push({
      canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
      type: "reasoning_signature",
      signature: delta.reasoning_signature,
    });
  }
  if (typeof delta.reasoning_content === "string") {
    events.push({
      canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
      type: "reasoning_delta",
      text: delta.reasoning_content,
    });
  }
  if (typeof delta.content === "string") {
    events.push({
      canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
      type: "text_delta",
      text: delta.content,
    });
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const candidate of delta.tool_calls) {
      const call = candidate as {
        readonly index: number;
        readonly id?: string;
        readonly function?: { readonly name?: string; readonly arguments?: string };
      };
      events.push({
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "tool_call_delta",
        index: call.index,
        ...(call.id !== undefined ? { id: call.id } : {}),
        ...(call.function?.name !== undefined ? { name: call.function.name } : {}),
        arguments: call.function?.arguments ?? "",
      });
    }
  }
  return events;
}

function dependencies(
  runPipeline: (options: RunChatCompletionOptions) => Promise<Response>,
  leaseEvents?: string[],
): MessagesDependencies {
  return {
    accountManager: new FakeAccountManager(),
    tokenRefresher: new FakeTokenRefresher(),
    runPipeline,
    ...(leaseEvents
      ? {
          createRequestIdleTimeoutLease: () => ({
            disable: () => leaseEvents.push("disable"),
            restore: () => leaseEvents.push("restore"),
          }),
        }
      : {}),
  };
}

function eventPayloads(text: string): Array<Readonly<Record<string, unknown>>> {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => {
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data: "));
      if (!data) throw new TypeError(`SSE frame has no data line: ${frame}`);
      return JSON.parse(data.slice("data: ".length)) as Readonly<Record<string, unknown>>;
    });
}

describe("Anthropic request adapter", () => {
  test("maps system blocks, structured thinking config, tool use, and tool results", () => {
    const adapted = adaptAnthropicMessagesRequest(
      validRequest({
        system: [{ type: "text", text: "system policy" }],
        thinking: { type: "enabled", budget_tokens: 8_000 },
        output_config: { effort: "high" },
        tools: [
          { name: "read", description: "read a file", input_schema: { type: "object" } },
          { name: "write", description: "write a file", input_schema: { type: "object" } },
        ],
        tool_choice: { type: "auto" },
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "inspect first", signature: "not-forwarded" },
              { type: "tool_use", id: "tool-1", name: "read", input: { path: "a.txt" } },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                is_error: true,
                content: [{ type: "text", text: "missing" }],
              },
            ],
          },
        ],
      }),
      { requireMaxTokens: true },
      "legacy-user-prefix",
    );

    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    expect(adapted.value.body).toMatchObject({
      canonicalVersion: 1,
      protocol: "anthropic-messages",
      projectionMode: "legacy-user-prefix",
      outputTokenLimit: 1_024,
      thinking: { enabled: true, budgetTokens: 8_000 },
      reasoningEffort: "high",
      requestedReasoningEffort: "high",
      tools: [
        { publicType: "function", name: "read", wireName: "read" },
        { publicType: "function", name: "write", wireName: "write" },
      ],
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "system policy" }],
        },
        {
          role: "assistant",
          toolCalls: [{ id: "tool-1", name: "read", input: { path: "a.txt" } }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolCallId: "tool-1",
              isError: true,
              content: [{ type: "text", text: "missing" }],
            },
          ],
        },
      ],
      reasoningReplays: [
        {
          lookup: {
            kind: "anthropic-direct",
            content: {
              kind: "reasoning_text",
              text: "inspect first",
              signature: "not-forwarded",
            },
          },
          insertBeforeMessage: 1,
        },
      ],
    });
  });

  test("requires max_tokens for message generation but not token counting", () => {
    const raw = {
      model: MODEL,
      messages: [{ role: "user", content: "hello" }],
    };

    expect(adaptAnthropicMessagesRequest(raw, { requireMaxTokens: true })).toMatchObject({
      ok: false,
      message: expect.stringContaining("max_tokens"),
    });
    expect(adaptAnthropicMessagesRequest(raw)).toMatchObject({ ok: true });
  });

  test("accepts Opus 5 effort and max_tokens without changing message content", () => {
    const result = adaptAnthropicMessagesRequest(
      validRequest({
        model: "claude-opus-5",
        max_tokens: 128_000,
        output_config: { effort: "xhigh" },
        messages: [{ role: "user", content: "exact user bytes" }],
      }),
      { requireMaxTokens: true },
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        body: {
          model: "claude-opus-5",
          outputTokenLimit: 128_000,
          reasoningEffort: "xhigh",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "exact user bytes" }],
            },
          ],
        },
      },
    });
  });

  test("rejects unproven models and Kiro-invalid max_tokens ranges before the pipeline", () => {
    expect(
      adaptAnthropicMessagesRequest(
        validRequest({ model: "gpt-5.6-sol" }),
        { requireMaxTokens: true },
      ),
    ).toMatchObject({
      ok: false,
      code: "unsupported_output_token_limit",
      param: "max_tokens",
    });
    expect(
      adaptAnthropicMessagesRequest(
        validRequest({ max_tokens: 1_023 }),
        { requireMaxTokens: true },
      ),
    ).toMatchObject({
      ok: false,
      code: "invalid_output_token_limit",
      param: "max_tokens",
    });
  });

  test("rejects unsupported forced tool choices and duplicate declarations", () => {
    expect(
      adaptAnthropicMessagesRequest(
        validRequest({
          tools: [{ name: "read", input_schema: { type: "object" } }],
          tool_choice: { type: "tool", name: "write" },
        }),
      ),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("tool_choice.type tool is not supported"),
    });
    expect(
      adaptAnthropicMessagesRequest(
        validRequest({ tools: [], tool_choice: { type: "any" } }),
      ),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("tool_choice.type any is not supported"),
    });
    expect(
      adaptAnthropicMessagesRequest(
        validRequest({
          tools: [
            { name: "read", input_schema: { type: "object" } },
            { name: "read", input_schema: { type: "object" } },
          ],
        }),
      ),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("duplicate tool name read"),
    });
  });

  test("rejects cache controls, unknown nested fields, and reasoning aliases", () => {
    expect(
      adaptAnthropicMessagesRequest(
        validRequest({
          system: [
            { type: "text", text: "system policy", cache_control: { type: "ephemeral" } },
          ],
        }),
        {},
        "legacy-user-prefix",
      ),
    ).toMatchObject({
      ok: false,
      code: "unsupported_parameter",
      param: "system.0.cache_control",
      message: expect.stringContaining("system.0.cache_control"),
    });
    expect(
      adaptAnthropicMessagesRequest(
        validRequest({
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "hello", unknown: true }],
            },
          ],
        }),
      ),
    ).toMatchObject({
      ok: false,
      code: "unsupported_parameter",
      param: "messages.0.content.0.unknown",
      message: expect.stringContaining("messages.0.content.0.unknown"),
    });
    expect(
      adaptAnthropicMessagesRequest(
        validRequest({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "redacted_thinking",
                  redacted_content: "YWJj",
                },
              ],
            },
          ],
        }),
      ),
    ).toMatchObject({
      ok: false,
      code: "invalid_reasoning_replay",
      param: "messages.0.content.0.redacted_content",
      message: expect.stringContaining("redacted_content"),
    });

    expect(
      adaptAnthropicMessagesRequest(
        validRequest({ context_management: { edits: [] } }),
      ),
    ).toMatchObject({
      ok: false,
      code: "unsupported_parameter",
      param: "context_management",
    });
  });
});

describe("POST /v1/messages", () => {
  test("returns an Anthropic non-streaming message and restores route resources", async () => {
    const leaseEvents: string[] = [];
    let captured: RunChatCompletionOptions | undefined;
    const response = await handleMessages(
      request(validRequest()),
      config(),
      dependencies(async (options) => {
        captured = options;
        return canonicalResponse(
          completion({
            text: "I will read it.",
            reasoning: {
              text: "hidden reasoning",
              signature: "native-signature",
            },
            toolCalls: [
              {
                id: "tool-1",
                name: "read",
                input: '{"path":"a.txt"}',
              },
            ],
            finishReason: "tool_calls",
          }),
        );
      }, leaseEvents),
    );
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [
        { type: "thinking", thinking: "hidden reasoning", signature: "native-signature" },
        { type: "text", text: "I will read it." },
        {
          type: "tool_use",
          id: "tool-1",
          name: "read",
          input: { path: "a.txt" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 11, output_tokens: 7 },
    });
    expect(captured?.stream).toBe(false);
    expect(leaseEvents).toEqual(["disable", "restore"]);
  });

  test("streams Anthropic Messages SSE in protocol order", async () => {
    const leaseEvents: string[] = [];
    const response = await handleMessages(
      request(validRequest({ stream: true })),
      config(),
      dependencies(
        async () =>
          ndjson([
            chunk({ reasoning_signature: "native-signature" }, null),
            chunk({ reasoning_content: "not exposed" }, null),
            chunk({ content: "hello" }, null),
            chunk(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "tool-1",
                    type: "function",
                    function: { name: "read", arguments: "" },
                  },
                ],
              },
              null,
            ),
            chunk(
              {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '{"path":"a.txt"}' },
                  },
                ],
              },
              null,
            ),
            chunk(
              {},
              "tool_calls",
              { prompt_tokens: 13, completion_tokens: 8, total_tokens: 21 },
            ),
          ]),
        leaseEvents,
      ),
    );
    const payloads = eventPayloads(await response.text());

    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(response.headers.get("x-kiro-token-count-mode")).toBe("estimate");
    expect(payloads[0]).toMatchObject({
      type: "message_start",
      message: { usage: { input_tokens: expect.any(Number) } },
    });
    expect(payloads.map((payload) => payload.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(payloads).toContainEqual(
      expect.objectContaining({
        type: "content_block_delta",
        delta: { type: "signature_delta", signature: "native-signature" },
      }),
    );
    expect(payloads).toContainEqual(
      expect.objectContaining({
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' },
      }),
    );
    expect(payloads.at(-2)).toMatchObject({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 8 },
    });
    expect(leaseEvents).toEqual(["disable", "restore"]);
  });

  test("serializes parallel upstream tool fragments into non-overlapping Anthropic blocks", async () => {
    const response = await handleMessages(
      request(validRequest({ stream: true })),
      config(),
      dependencies(async () =>
        ndjson([
          chunk(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "tool-1",
                  type: "function",
                  function: { name: "read", arguments: "" },
                },
                {
                  index: 1,
                  id: "tool-2",
                  type: "function",
                  function: { name: "search", arguments: "" },
                },
              ],
            },
            null,
          ),
          chunk(
            {
              tool_calls: [
                {
                  index: 1,
                  function: { arguments: '{"query":"x"}' },
                },
                {
                  index: 0,
                  function: { arguments: '{"path":"a.txt"}' },
                },
              ],
            },
            null,
          ),
          chunk(
            {},
            "tool_calls",
            { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
          ),
        ]),
      ),
    );
    const payloads = eventPayloads(await response.text()).slice(1, -2);

    expect(payloads.map((payload) => payload.type)).toEqual([
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
    ]);
    expect(payloads.map((payload) => payload.index)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(payloads[0]).toMatchObject({
      content_block: { type: "tool_use", id: "tool-1", name: "read" },
    });
    expect(payloads[3]).toMatchObject({
      content_block: { type: "tool_use", id: "tool-2", name: "search" },
    });
  });

  test("emits an Anthropic error event when the upstream stream is malformed", async () => {
    const response = await handleMessages(
      request(validRequest({ stream: true })),
      config(),
      dependencies(async () =>
        ndjson([{ object: "unexpected", choices: [] }]),
      ),
    );
    const payloads = eventPayloads(await response.text());

    expect(payloads.at(-1)).toMatchObject({
      type: "error",
      error: { type: "api_error", message: "Malformed upstream stream" },
    });
    expect(payloads.some((payload) => payload.type === "message_stop")).toBe(false);
  });

  test("rejects malformed upstream tool arguments atomically for non-streaming calls", async () => {
    const response = await handleMessages(
      request(validRequest()),
      config(),
      dependencies(async () =>
        canonicalResponse(
          completion({
            text: "",
            toolCalls: [
              {
                id: "tool-1",
                name: "read",
                input: "{bad-json",
              },
            ],
            finishReason: "tool_calls",
          }),
        ),
      ),
    );
    const body: unknown = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      type: "error",
      error: { type: "api_error", message: expect.stringContaining("invalid JSON") },
    });
  });

  test("returns Anthropic-shaped validation errors", async () => {
    const response = await handleMessages(
      request(validRequest({ model: "not-a-model" })),
      config(),
      dependencies(async () => {
        throw new TypeError("pipeline must not run");
      }),
    );
    const body: unknown = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: expect.stringContaining("model is not supported"),
      },
    });
  });
});

describe("Claude Code HTTP surface", () => {
  test("uses an Anthropic auth envelope for /v1/messages", async () => {
    const app = createApp(config(), {
      accountManager: new FakeAccountManager(),
      tokenRefresher: new FakeTokenRefresher(),
    });
    const response = await app(request(validRequest(), "/v1/messages", {}));
    const body: unknown = await response.json();

    expect(response.status).toBe(401);
    expect(body).toMatchObject({
      type: "error",
      error: { type: "authentication_error" },
    });
  });

  test("accepts x-api-key and returns an estimated token count", async () => {
    const app = createApp(config(), {
      accountManager: new FakeAccountManager(),
      tokenRefresher: new FakeTokenRefresher(),
    });
    const response = await app(
      request(
        {
          model: MODEL,
          messages: [{ role: "user", content: "count this" }],
        },
        "/v1/messages/count_tokens",
        { "x-api-key": API_KEY },
      ),
    );
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-kiro-token-count-mode")).toBe("estimate");
    expect(body).toMatchObject({ input_tokens: expect.any(Number) });
  });

  test("the direct token-count handler accepts the count-tokens request shape", async () => {
    const response = await handleMessageTokenCount(
      request(
        {
          model: MODEL,
          messages: [{ role: "user", content: "count this" }],
        },
        "/v1/messages/count_tokens",
      ),
      config(),
    );

    expect(response.status).toBe(200);
  });
});
