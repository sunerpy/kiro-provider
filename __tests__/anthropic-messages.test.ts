import { describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import type {
  PipelineAccountManager,
  PipelineTokenRefresher,
  RunChatCompletionOptions,
} from "../src/core/pipeline.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import { adaptAnthropicMessagesRequest } from "../src/server/anthropic/request-adapter.js";
import { createApp } from "../src/server/app.js";
import {
  handleMessages,
  handleMessageTokenCount,
  type MessagesDependencies,
} from "../src/server/routes/messages.js";

const API_KEY = "sk-anthropic-test";
const MODEL = "gpt-5.6-sol";

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
    id: "completion-id",
    object: "chat.completion",
    model: MODEL,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hello from Kiro" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    ...overrides,
  };
}

function ndjson(lines: readonly unknown[]): Response {
  return new Response(lines.map((line) => JSON.stringify(line)).join("\n"), {
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

function chunk(
  delta: Readonly<Record<string, unknown>>,
  finishReason: "stop" | "tool_calls" | null,
  usage?: Readonly<Record<string, number>>,
): unknown {
  return {
    id: "completion-id",
    object: "chat.completion.chunk",
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
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
        system: [{ type: "text", text: "system policy", cache_control: { type: "ephemeral" } }],
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
    );

    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    expect(adapted.value.body).toMatchObject({
      system: "system policy",
      max_tokens: 1_024,
      thinkingConfig: { budget_tokens: 8_000 },
      reasoning_effort: "high",
      tools: [{ name: "read" }, { name: "write" }],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tool-1", name: "read" },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              is_error: true,
              content: "missing",
            },
          ],
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
        return Response.json(
          completion({
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "I will read it.",
                  reasoning_content: "hidden reasoning",
                  tool_calls: [
                    {
                      id: "tool-1",
                      type: "function",
                      function: {
                        name: "read",
                        arguments: '{"path":"a.txt"}',
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
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
        Response.json(
          completion({
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "tool-1",
                      type: "function",
                      function: { name: "read", arguments: "{bad-json" },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
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
