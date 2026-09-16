import { describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import type {
  PipelineAccountManager,
  PipelineSdkClient,
  PipelineTokenRefresher,
  RunChatCompletionOptions,
} from "../src/core/pipeline.js";
import { RequestTransformError } from "../src/kiro/transform/errors.js";
import { buildCodeWhispererRequest } from "../src/kiro/transform/request-core.js";
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
import { makeSdkResponse } from "./sdk-stream-test-helpers.js";

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
    return [
      {
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        type: "completed",
        finishReason,
        usage: {
          inputTokens: usage?.prompt_tokens ?? 0,
          outputTokens: usage?.completion_tokens ?? 0,
          totalTokens: usage?.total_tokens ?? 0,
        },
      },
    ];
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
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      if (!data) throw new TypeError(`SSE frame has no data line: ${frame}`);
      return JSON.parse(data.slice("data: ".length)) as Readonly<Record<string, unknown>>;
    });
}

describe("Anthropic request adapter", () => {
  test("native-context-safe preserves one system string for the runtime capability gate", () => {
    const adapted = adaptAnthropicMessagesRequest(
      validRequest({
        system: "NATIVE",
        messages: [{ role: "user", content: "hello" }],
      }),
      { requireMaxTokens: true },
      "native-context-safe",
    );

    expect(adapted).toMatchObject({
      ok: true,
      value: {
        body: {
          projectionMode: "native-context-safe",
          messages: [
            { role: "system", content: [{ type: "text", text: "NATIVE" }] },
            { role: "user", content: [{ type: "text", text: "hello" }] },
          ],
        },
      },
    });
  });

  test("rejects missing and blank tool descriptions at the Kiro projection boundary", () => {
    const cases = [
      [{ name: "read", input_schema: { type: "object" } }],
      [{ name: "read", description: " ", input_schema: { type: "object" } }],
    ] as const;

    for (const tools of cases) {
      const adapted = adaptAnthropicMessagesRequest(validRequest({ tools }), {
        requireMaxTokens: true,
      });
      expect(adapted.ok).toBe(true);
      if (!adapted.ok) continue;

      try {
        buildCodeWhispererRequest(
          adapted.value.body,
          MODEL,
          new FakeAccountManager().toAuthDetails(account()),
        );
        throw new TypeError("Expected missing tool description rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(RequestTransformError);
        expect(error).toMatchObject({
          code: "missing_tool_description",
          param: "tools.0.description",
        });
      }
    }
  });

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

  test("lifts one image-valued tool result beside an adjacent text run", () => {
    const adapted = adaptAnthropicMessagesRequest(
      validRequest({
        tools: [
          { name: "inspect", description: "inspect state", input_schema: { type: "object" } },
          { name: "export", description: "export an image", input_schema: { type: "object" } },
        ],
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "tool-text", name: "inspect", input: {} },
              { type: "tool_use", id: "tool-image", name: "export", input: {} },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-text",
                content: [{ type: "text", text: "ready" }],
              },
              {
                type: "tool_result",
                tool_use_id: "tool-image",
                content: [
                  {
                    type: "image",
                    source: { type: "base64", media_type: "image/png", data: "AQID" },
                  },
                ],
              },
              { type: "text", text: "continue " },
              { type: "text", text: "now" },
            ],
          },
        ],
      }),
      { requireMaxTokens: true },
    );

    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    expect(adapted.value.body.messages[1]?.content).toEqual([
      {
        type: "tool_result",
        toolCallId: "tool-text",
        content: [expect.objectContaining({ type: "text", text: "ready" })],
        isError: false,
        path: "messages.1.content.0",
      },
      {
        type: "tool_result",
        toolCallId: "tool-image",
        content: [],
        isError: false,
        path: "messages.1.content.1",
      },
      {
        type: "image",
        data: "AQID",
        mediaType: "image/png",
        path: "messages.1.content.1.content.0",
      },
      expect.objectContaining({
        type: "text",
        text: "continue ",
        path: "messages.1.content.2.text",
      }),
      expect.objectContaining({
        type: "text",
        text: "now",
        path: "messages.1.content.3.text",
      }),
    ]);

    const transformed = buildCodeWhispererRequest(
      adapted.value.body,
      MODEL,
      new FakeAccountManager().toAuthDetails(account()),
    );
    expect(transformed.request.conversationState.currentMessage.userInputMessage).toMatchObject({
      content: "continue now",
      images: [{ format: "png", source: { bytes: Uint8Array.from([1, 2, 3]) } }],
      userInputMessageContext: {
        toolResults: [
          { toolUseId: "tool-text", content: [{ text: "ready" }], status: "success" },
          { toolUseId: "tool-image", content: [], status: "success" },
        ],
      },
    });
  });

  test("rejects ambiguous image origins across tool results or direct message content", () => {
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AQID" },
    };
    const assistant = {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tool-a", name: "export", input: {} },
        { type: "tool_use", id: "tool-b", name: "export", input: {} },
      ],
    };
    const tools = [
      { name: "export", description: "export an image", input_schema: { type: "object" } },
    ];

    expect(
      adaptAnthropicMessagesRequest(
        validRequest({
          tools,
          messages: [
            assistant,
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "tool-a", content: [image] },
                { type: "tool_result", tool_use_id: "tool-b", content: [image] },
              ],
            },
          ],
        }),
        { requireMaxTokens: true },
      ),
    ).toMatchObject({
      ok: false,
      code: "unsupported_tool_result_content",
      param: "messages.1.content.1.content.0",
    });

    expect(
      adaptAnthropicMessagesRequest(
        validRequest({
          tools,
          messages: [
            assistant,
            {
              role: "user",
              content: [image, { type: "tool_result", tool_use_id: "tool-a", content: [image] }],
            },
          ],
        }),
        { requireMaxTokens: true },
      ),
    ).toMatchObject({
      ok: false,
      code: "unsupported_tool_result_content",
      param: "messages.1.content.1.content.0",
    });

    expect(
      adaptAnthropicMessagesRequest(
        validRequest({
          tools,
          messages: [
            assistant,
            {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "tool-a", content: [image] }, image],
            },
          ],
        }),
        { requireMaxTokens: true },
      ),
    ).toMatchObject({
      ok: false,
      code: "unsupported_tool_result_content",
      param: "messages.1.content.1",
    });
  });

  test("rejects malformed or unsupported nested tool-result image content", () => {
    const result = (content: unknown) =>
      adaptAnthropicMessagesRequest(
        validRequest({
          tools: [
            { name: "export", description: "export an image", input_schema: { type: "object" } },
          ],
          messages: [
            {
              role: "assistant",
              content: [{ type: "tool_use", id: "tool-image", name: "export", input: {} }],
            },
            {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "tool-image", content }],
            },
          ],
        }),
        { requireMaxTokens: true },
      );

    expect(result({ type: "text", text: "not an array" })).toMatchObject({
      ok: false,
      code: "unsupported_tool_result_content",
      param: "messages.1.content.0.content",
    });
    expect(result([null])).toMatchObject({
      ok: false,
      code: "unsupported_tool_result_content",
      param: "messages.1.content.0.content.0",
    });
    expect(result([{ type: "document", source: { type: "base64", data: "AQID" } }])).toMatchObject({
      ok: false,
      code: "unsupported_tool_result_content",
      param: "messages.1.content.0.content.0",
    });
    expect(
      result([{ type: "image", source: { type: "url", url: "https://example.test/a" } }]),
    ).toMatchObject({
      ok: false,
      code: "unsupported_image_source",
      param: "messages.1.content.0.content.0",
    });
  });

  test("rejects assistant-prefill requests before contacting Kiro", () => {
    const adapted = adaptAnthropicMessagesRequest(
      validRequest({
        messages: [{ role: "assistant", content: "prefill" }],
      }),
      { requireMaxTokens: true },
    );
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;

    try {
      buildCodeWhispererRequest(
        adapted.value.body,
        MODEL,
        new FakeAccountManager().toAuthDetails(account()),
      );
      throw new TypeError("Expected missing current input rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(RequestTransformError);
      expect(error).toMatchObject({
        code: "missing_current_input",
        param: "messages.0",
      });
    }
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

  test("accepts Claude Code cache hints and no-op context management without changing input", () => {
    const result = adaptAnthropicMessagesRequest(
      validRequest({
        model: "claude-opus-5",
        max_tokens: 64_000,
        temperature: 0,
        system: [
          { type: "text", text: "billing marker" },
          {
            type: "text",
            text: "You are a Claude coding agent.",
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "runtime context" },
              {
                type: "text",
                text: "Reply with exactly: CLAUDE_CODE_OK",
                cache_control: { type: "ephemeral" },
              },
            ],
          },
        ],
        tools: [
          {
            name: "Read",
            description: "Read a file",
            input_schema: { type: "object" },
            cache_control: { type: "ephemeral", ttl: "5m" },
          },
        ],
        thinking: { type: "adaptive", display: "omitted" },
        context_management: {
          edits: [{ type: "clear_thinking_20251015", keep: "all" }],
        },
        output_config: { effort: "max" },
        metadata: { user_id: '{"session_id":"test-session"}' },
        stream: true,
      }),
      { requireMaxTokens: true },
      "v3-auto",
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        body: {
          model: "claude-opus-5",
          stream: true,
          outputTokenLimit: 64_000,
          temperature: 0,
          reasoningEffort: "max",
          includeEncryptedReasoning: true,
          thinking: { enabled: true, display: "omitted" },
          messages: [
            {
              role: "system",
              content: [
                { type: "text", text: "billing marker" },
                { type: "text", text: "You are a Claude coding agent." },
              ],
            },
            {
              role: "user",
              content: [
                { type: "text", text: "runtime context" },
                { type: "text", text: "Reply with exactly: CLAUDE_CODE_OK" },
              ],
            },
          ],
          tools: [{ name: "Read", wireName: "Read" }],
        },
        cacheControlCount: 3,
        contextManagementRequested: true,
        thinkingDisplay: "omitted",
      },
    });
  });

  test("rejects a fifth cache marker instead of silently adding or dropping one", () => {
    const result = adaptAnthropicMessagesRequest(
      validRequest({
        messages: [
          {
            role: "user",
            content: Array.from({ length: 5 }, (_, index) => ({
              type: "text",
              text: `stable-${index}`,
              cache_control: { type: "ephemeral" },
            })),
          },
        ],
      }),
      {},
      "v3-auto",
    );
    expect(result).toMatchObject({
      ok: false,
      code: "too_many_cache_checkpoints",
      param: "cache_control",
    });
  });

  test("maps mid-conversation system text and provider replay signatures", () => {
    const result = adaptAnthropicMessagesRequest(
      validRequest({
        messages: [
          { role: "user", content: "first" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "", signature: "kr1_token" },
              { type: "text", text: "answer" },
            ],
          },
          { role: "system", content: [{ type: "text", text: "Today is fixed." }] },
          { role: "user", content: "follow-up" },
        ],
      }),
      {},
      "v3-auto",
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        body: {
          messages: [
            { role: "user" },
            { role: "assistant" },
            { role: "system", content: [{ type: "text", text: "Today is fixed." }] },
            { role: "user" },
          ],
          reasoningReplays: [{ lookup: { kind: "anthropic-token", signature: "kr1_token" } }],
        },
      },
    });
  });

  test("restores a hidden GPT placeholder through the exact replay store lookup", () => {
    const result = adaptAnthropicMessagesRequest(
      validRequest({
        model: "gpt-5.6-sol",
        messages: [
          { role: "user", content: "first" },
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "",
                signature: ".KTR.native-placeholder-signature",
              },
              { type: "text", text: "answer" },
            ],
          },
          { role: "user", content: "follow-up" },
        ],
      }),
      { unsupportedOutputTokenLimitMode: "advisory" },
      "v3-auto",
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        body: {
          reasoningReplays: [{ lookup: { kind: "chat-hash", reasoningText: "..." } }],
        },
      },
    });
  });

  test("keeps GPT max_tokens fail-closed unless the Anthropic caller explicitly accepts advisory mode", () => {
    expect(
      adaptAnthropicMessagesRequest(validRequest({ model: "gpt-5.6-sol" }), {
        requireMaxTokens: true,
      }),
    ).toMatchObject({
      ok: false,
      code: "unsupported_output_token_limit",
      param: "max_tokens",
    });
    expect(
      adaptAnthropicMessagesRequest(
        validRequest({
          model: "gpt-5.6-sol",
          output_config: { effort: "max" },
        }),
        {
          requireMaxTokens: true,
          unsupportedOutputTokenLimitMode: "advisory",
        },
      ),
    ).toMatchObject({
      ok: true,
      value: {
        body: {
          model: "gpt-5.6-sol",
          reasoningEffort: "max",
          includeEncryptedReasoning: false,
        },
        outputTokenLimitMode: "advisory",
      },
    });
    const accepted = adaptAnthropicMessagesRequest(validRequest({ model: "gpt-5.6-sol" }), {
      requireMaxTokens: true,
      unsupportedOutputTokenLimitMode: "advisory",
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.value.body).not.toHaveProperty("outputTokenLimit");
    }
    expect(
      adaptAnthropicMessagesRequest(validRequest({ model: "qwen3-coder-next" }), {
        requireMaxTokens: true,
        unsupportedOutputTokenLimitMode: "advisory",
      }),
    ).toMatchObject({
      ok: false,
      code: "unsupported_output_token_limit",
      param: "max_tokens",
    });
  });

  test("rejects Kiro-invalid native max_tokens ranges before the pipeline", () => {
    expect(
      adaptAnthropicMessagesRequest(validRequest({ max_tokens: 1_023 }), {
        requireMaxTokens: true,
      }),
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
      adaptAnthropicMessagesRequest(validRequest({ tools: [], tool_choice: { type: "any" } })),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("tool_choice.type any is not supported"),
    });
    expect(
      adaptAnthropicMessagesRequest(
        validRequest({
          tools: [
            { name: "read", description: "Read once", input_schema: { type: "object" } },
            { name: "read", description: "Read twice", input_schema: { type: "object" } },
          ],
        }),
      ),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("duplicate tool name read"),
    });
  });

  test("rejects unsupported cache controls, context edits, nested fields, and reasoning aliases", () => {
    expect(
      adaptAnthropicMessagesRequest(
        validRequest({
          system: [{ type: "text", text: "system policy", cache_control: { type: "durable" } }],
        }),
        {},
        "legacy-user-prefix",
      ),
    ).toMatchObject({
      ok: false,
      code: "unsupported_cache_control",
      param: "system.0.cache_control.type",
      message: expect.stringContaining("system.0.cache_control.type"),
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
        validRequest({
          context_management: {
            edits: [
              {
                type: "clear_thinking_20251015",
                keep: { type: "thinking_turns", value: 1 },
              },
            ],
          },
        }),
      ),
    ).toMatchObject({
      ok: false,
      code: "unsupported_context_edit",
      param: "context_management.edits.0",
      message: expect.stringContaining("capability_rejected:context_management"),
    });
    expect(
      adaptAnthropicMessagesRequest(
        validRequest({
          context_management: {
            edits: [{ type: "clear_thinking_20251015", keep: "all", future: true }],
          },
        }),
      ),
    ).toMatchObject({
      ok: false,
      code: "unsupported_context_edit",
      param: "context_management.edits.0.future",
      message: expect.stringContaining("capability_rejected:context_management"),
    });
    expect(
      adaptAnthropicMessagesRequest(
        validRequest({ thinking: { type: "adaptive", display: "updates" } }),
      ),
    ).toMatchObject({
      ok: false,
      code: "unsupported_reasoning_display",
      param: "thinking.display",
    });
  });

  test("covers strict Claude compatibility rejection and replay boundaries", () => {
    const failures: ReadonlyArray<{
      readonly request: unknown;
      readonly options?: Parameters<typeof adaptAnthropicMessagesRequest>[1];
      readonly projection?: Parameters<typeof adaptAnthropicMessagesRequest>[2];
      readonly code?: string;
      readonly param: string;
    }> = [
      {
        request: validRequest({ cache_control: "ephemeral" }),
        code: "unsupported_cache_control",
        param: "cache_control",
      },
      {
        request: validRequest({ cache_control: { type: "ephemeral", ttl: "2h" } }),
        code: "unsupported_cache_control",
        param: "cache_control.ttl",
      },
      {
        request: validRequest({ context_management: { edits: [], future: true } }),
        code: "unsupported_context_edit",
        param: "context_management.future",
      },
      {
        request: validRequest({
          model: "claude-opus-5",
          messages: [
            { role: "user", content: "first" },
            {
              role: "assistant",
              content: [{ type: "thinking", thinking: "must be empty", signature: "kr1_token" }],
            },
            { role: "user", content: "again" },
          ],
        }),
        code: "invalid_reasoning_replay",
        param: "messages.1.content.0.thinking",
      },
      {
        request: validRequest({
          messages: [
            { role: "system", content: [{ type: "image", source: { type: "base64" } }] },
            { role: "user", content: "hello" },
          ],
        }),
        code: "unsupported_instruction_projection",
        param: "messages.0.content.0",
      },
      {
        request: validRequest({
          tools: [
            {
              name: "read",
              description: "Read a file",
              input_schema: { type: "object" },
              future: true,
            },
          ],
        }),
        code: "unsupported_tool_field",
        param: "tools.0.future",
      },
      {
        request: validRequest({ thinking: { type: "disabled", display: "omitted" } }),
        code: "unsupported_parameter",
        param: "thinking.display",
      },
      {
        request: validRequest({
          messages: [
            { role: "system", content: "Today is fixed." },
            { role: "user", content: "hello" },
          ],
        }),
        code: "unsupported_instruction_projection",
        param: "messages",
        projection: "safe",
      },
    ];

    for (const testCase of failures) {
      expect(
        adaptAnthropicMessagesRequest(
          testCase.request,
          testCase.options ?? {},
          testCase.projection ?? "v3-auto",
        ),
      ).toMatchObject({
        ok: false,
        ...(testCase.code !== undefined ? { code: testCase.code } : {}),
        param: testCase.param,
      });
    }

    const emptySignedThinking = adaptAnthropicMessagesRequest(
      validRequest({
        messages: [
          { role: "user", content: "first" },
          {
            role: "assistant",
            content: [{ type: "thinking", thinking: "", signature: "native-signature" }],
          },
          { role: "user", content: "again" },
        ],
      }),
    );
    expect(emptySignedThinking).toMatchObject({
      ok: true,
      value: {
        body: {
          reasoningReplays: [
            {
              lookup: {
                kind: "anthropic-direct",
                content: { kind: "reasoning_text", text: "", signature: "native-signature" },
              },
            },
          ],
        },
      },
    });

    const redacted = adaptAnthropicMessagesRequest(
      validRequest({
        messages: [
          { role: "user", content: "first" },
          {
            role: "assistant",
            content: [{ type: "redacted_thinking", data: "YWJj" }],
          },
          { role: "user", content: "again" },
        ],
      }),
      {},
      "v3-auto",
    );
    expect(redacted).toMatchObject({
      ok: true,
      value: {
        body: {
          reasoningReplays: [
            {
              lookup: {
                kind: "anthropic-direct",
                content: { kind: "redacted_content" },
              },
            },
          ],
        },
      },
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

  test("routes Claude Code compatibility metadata and omitted thinking to the response adapter", async () => {
    const response = await handleMessages(
      request(
        validRequest({
          thinking: { type: "adaptive", display: "omitted" },
          context_management: {
            edits: [{ type: "clear_thinking_20251015", keep: "all" }],
          },
          system: [
            {
              type: "text",
              text: "system policy",
              cache_control: { type: "ephemeral" },
            },
          ],
        }),
      ),
      config(),
      dependencies(async () =>
        canonicalResponse(
          completion({
            text: "answer",
            reasoning: {
              text: "private reasoning",
              signature: "native-signature",
              encryptedContent: "kr1_replay-token",
            },
          }),
        ),
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-kiro-prompt-cache-mode")).toBe("server-auto");
    expect(await response.json()).toMatchObject({
      content: [
        { type: "thinking", thinking: "", signature: "kr1_replay-token" },
        { type: "text", text: "answer" },
      ],
      context_management: { applied_edits: [] },
    });
  });

  test.each([false, true])(
    "accepts GPT max_tokens as advisory only through the explicit compatibility header (stream=%s)",
    async (stream) => {
      let captured: RunChatCompletionOptions | undefined;
      const response = await handleMessages(
        request(
          validRequest({
            model: "gpt-5.6-sol",
            max_tokens: 64_000,
            output_config: { effort: "xhigh" },
            stream,
          }),
          "/v1/messages",
          {
            Authorization: `Bearer ${API_KEY}`,
            "X-Kiro-Output-Token-Limit-Mode": "advisory",
          },
        ),
        config(),
        dependencies(async (options) => {
          captured = options;
          return stream
            ? ndjson([chunk({ content: "answer" }, null), chunk({}, "stop")])
            : canonicalResponse(completion({ model: "gpt-5.6-sol", text: "answer" }));
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("x-kiro-output-token-limit-mode")).toBe("advisory-unenforced");
      expect(captured?.body).toMatchObject({
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
      });
      expect(captured?.body).not.toHaveProperty("outputTokenLimit");
      if (stream) await response.text();
      else await response.json();
    },
  );

  test("does not let a missing or misspelled compatibility header bypass GPT max_tokens", async () => {
    const headerCases: ReadonlyArray<Readonly<Record<string, string>>> = [
      { Authorization: `Bearer ${API_KEY}` },
      {
        Authorization: `Bearer ${API_KEY}`,
        "X-Kiro-Output-Token-Limit-Mode": "ignore",
      },
    ];
    for (const headers of headerCases) {
      let called = false;
      const response = await handleMessages(
        request(validRequest({ model: "gpt-5.6-terra" }), "/v1/messages", headers),
        config(),
        dependencies(async () => {
          called = true;
          return canonicalResponse(completion());
        }),
      );
      expect(response.status).toBe(400);
      expect(called).toBe(false);
      expect(await response.json()).toMatchObject({
        type: "error",
        error: { type: "invalid_request_error" },
      });
    }
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
            chunk({}, "tool_calls", { prompt_tokens: 13, completion_tokens: 8, total_tokens: 21 }),
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
          chunk({}, "tool_calls", { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 }),
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
      dependencies(async () => ndjson([{ object: "unexpected", choices: [] }])),
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
        message: expect.stringContaining("Output-token limiting is not available"),
      },
    });
  });
});

describe("Claude Code HTTP surface", () => {
  test("preserves signature-only thinking through a non-stream subagent tool turn", async () => {
    const client: PipelineSdkClient = {
      async send() {
        return makeSdkResponse([
          { reasoningContentEvent: { signature: "native-signature" } },
          {
            toolUseEvent: {
              name: "first_task",
              toolUseId: "tool-a",
              input: '{"task":"a"}',
              stop: true,
            },
          },
          {
            toolUseEvent: {
              name: "second_task",
              toolUseId: "tool-b",
              input: '{"task":"b"}',
              stop: true,
            },
          },
        ]);
      },
    };
    const app = createApp(config(), {
      accountManager: new FakeAccountManager(),
      tokenRefresher: new FakeTokenRefresher(),
      makeClient: () => client,
    });

    const response = await app(
      request(
        validRequest({
          tools: [
            {
              name: "first_task",
              description: "Run the first subtask",
              input_schema: { type: "object" },
            },
            {
              name: "second_task",
              description: "Run the second subtask",
              input_schema: { type: "object" },
            },
          ],
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      content: [
        { type: "thinking", thinking: "", signature: "native-signature" },
        { type: "tool_use", id: "tool-a", name: "first_task", input: { task: "a" } },
        { type: "tool_use", id: "tool-b", name: "second_task", input: { task: "b" } },
      ],
      stop_reason: "tool_use",
    });
  });

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
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "count this",
                  cache_control: { type: "ephemeral" },
                },
              ],
            },
          ],
        },
        "/v1/messages/count_tokens",
        { "x-api-key": API_KEY },
      ),
    );
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-kiro-token-count-mode")).toBe("estimate");
    expect(response.headers.get("x-kiro-prompt-cache-mode")).toBe("server-auto");
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
