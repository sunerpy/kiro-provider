import { describe, expect, test } from "bun:test";
import type { ProtocolProjectionMode } from "../src/protocol/canonical.js";
import { chatToCanonical } from "../src/server/protocol/chat-adapter.js";
import { parseChatCompletionRequest } from "../src/server/request-schema.js";

function adapt(raw: unknown, projectionMode: ProtocolProjectionMode = "safe") {
  const parsed = parseChatCompletionRequest(raw);
  if (!parsed.ok) throw new TypeError("Expected a schema-valid Chat request");
  return chatToCanonical(parsed.value, projectionMode);
}

describe("Chat output-token projection", () => {
  test.each(["max_tokens", "max_completion_tokens"] as const)(
    "maps %s for the probe-confirmed Claude model",
    (field) => {
      expect(
        adapt({
          model: "claude-sonnet-5",
          messages: [{ role: "user", content: "hello" }],
          [field]: 4_096,
        }),
      ).toMatchObject({ ok: true, value: { outputTokenLimit: 4_096 } });
    },
  );

  test("maps Opus 5 max_tokens and effort variant through the same canonical path", () => {
    expect(
      adapt({
        model: "claude-opus-5-max",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 128_000,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        model: "claude-opus-5-max",
        outputTokenLimit: 128_000,
      },
    });
  });

  test("rejects conflicting aliases, unsupported models, and invalid ranges", () => {
    expect(
      adapt({
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 4_096,
        max_completion_tokens: 4_096,
      }),
    ).toMatchObject({
      ok: false,
      code: "conflicting_output_token_limits",
      param: "max_completion_tokens",
    });
    expect(
      adapt({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hello" }],
        max_completion_tokens: 4_096,
      }),
    ).toMatchObject({
      ok: false,
      code: "unsupported_output_token_limit",
      param: "max_completion_tokens",
    });
    expect(
      adapt({
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 1_023,
      }),
    ).toMatchObject({
      ok: false,
      code: "invalid_output_token_limit",
      param: "max_tokens",
    });
  });
});

describe("Chat protocol-fidelity validation", () => {
  test("supports only the exact standard streaming usage option", () => {
    expect(
      adapt({
        model: "gpt-5.6-sol",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "hello" }],
      }),
    ).toMatchObject({ ok: true });
    expect(
      adapt({
        model: "gpt-5.6-sol",
        stream: true,
        stream_options: { include_usage: true, extra: true },
        messages: [{ role: "user", content: "hello" }],
      }),
    ).toMatchObject({
      ok: false,
      code: "unsupported_parameter",
      param: "stream_options.extra",
    });
    expect(
      adapt({
        model: "gpt-5.6-sol",
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "hello" }],
      }),
    ).toMatchObject({
      ok: false,
      code: "unsupported_parameter",
      param: "stream_options",
    });
  });

  test("accepts only non-strict function declarations and preserves their exact schema", () => {
    const result = adapt({
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "Read a file",
            parameters: { type: "object" },
            strict: false,
          },
        },
      ],
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        tools: [
          {
            name: "read",
            description: "Read a file",
            inputSchema: { type: "object" },
            strict: false,
          },
        ],
      },
    });
    expect(
      adapt({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            type: "function",
            function: { name: "read", strict: true },
          },
        ],
      }),
    ).toMatchObject({
      ok: false,
      code: "unsupported_strict_tools",
      param: "tools.0.function.strict",
    });
  });

  test("rejects unknown nested fields and unsupported image controls before Kiro", () => {
    expect(
      adapt({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: [{ type: "text", text: "hello", extra: true }] }],
      }),
    ).toMatchObject({
      ok: false,
      code: "unsupported_parameter",
      param: "messages.0.content.0.extra",
    });
    expect(
      adapt({
        model: "gpt-5.6-sol",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,YQ==", detail: "high" },
              },
            ],
          },
        ],
      }),
    ).toMatchObject({
      ok: false,
      code: "unsupported_parameter",
      param: "messages.0.content.0.image_url.detail",
    });
    expect(
      adapt({
        model: "gpt-5.6-sol",
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
          },
        ],
      }),
    ).toMatchObject({
      ok: false,
      code: "unsupported_image_source",
      param: "messages.0.content.0.image_url.url",
    });
  });

  test("preserves supported text and image content blocks without changing bytes", () => {
    const result = adapt({
      model: "gpt-5.6-sol",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "alpha\n\nbeta" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,YQ==" },
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "Yg==",
              },
            },
          ],
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        messages: [
          {
            content: [
              { type: "text", text: "alpha\n\nbeta" },
              { type: "image", url: "data:image/png;base64,YQ==" },
              {
                type: "image",
                mediaType: "image/png",
                data: "Yg==",
              },
            ],
          },
        ],
      },
    });
  });

  test("preserves native declarations and structured tool history", () => {
    const result = adapt({
      model: "gpt-5.6-sol",
      tools: [
        {
          name: "read",
          description: "read exactly one path",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      ],
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "content-call",
              name: "read",
              input: { path: "content.txt" },
            },
          ],
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "read",
                arguments: '{"path":"a.txt"}',
              },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              content: [{ type: "text", text: "raw\nresult" }],
              is_error: true,
            },
          ],
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        tools: [
          {
            name: "read",
            description: "read exactly one path",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        ],
        messages: [
          {
            content: [
              {
                type: "tool_use",
                id: "content-call",
                input: { path: "content.txt" },
              },
            ],
            toolCalls: [{ id: "call-1", name: "read", input: { path: "a.txt" } }],
          },
          {
            content: [
              {
                type: "tool_result",
                toolCallId: "call-1",
                isError: true,
                content: [{ type: "text", text: "raw\nresult" }],
              },
            ],
          },
        ],
      },
    });
  });

  test.each([
    ["unknown top-level field", { private_option: true }, "private_option"],
    ["sampling control", { temperature: 0 }, "temperature"],
    ["server storage", { store: true }, "store"],
    [
      "serial tool guarantee",
      {
        parallel_tool_calls: false,
        tools: [{ type: "function", function: { name: "read", parameters: {} } }],
      },
      "parallel_tool_calls",
    ],
    ["required tool choice", { tool_choice: "required" }, "tool_choice"],
    [
      "named tool choice",
      { tool_choice: { type: "function", function: { name: "read" } } },
      "tool_choice",
    ],
  ] as const)("rejects %s before Kiro", (_name, option, param) => {
    expect(
      adapt({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hello" }],
        ...option,
      }),
    ).toMatchObject({ ok: false, param });
  });

  test("accepts parallel_tool_calls=false when it cannot affect model behavior", () => {
    expect(
      adapt({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hello" }],
        parallel_tool_calls: false,
      }),
    ).toMatchObject({ ok: true });
    expect(
      adapt({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hello" }],
        parallel_tool_calls: false,
        tool_choice: "none",
        tools: [{ type: "function", function: { name: "read", parameters: {} } }],
      }),
    ).toMatchObject({ ok: true });
  });

  test("keeps instruction projection fail-closed unless legacy mode is explicit", () => {
    const raw = {
      model: "gpt-5.6-sol",
      messages: [
        { role: "developer", content: "do not rewrite this" },
        { role: "user", content: "hello" },
      ],
    };
    expect(adapt(raw)).toMatchObject({
      ok: false,
      code: "unsupported_instruction_projection",
      param: "messages.0",
    });
    expect(adapt(raw, "legacy-user-prefix")).toMatchObject({
      ok: true,
      value: {
        messages: [
          { role: "developer", content: [{ text: "do not rewrite this" }] },
          { role: "user", content: [{ text: "hello" }] },
        ],
      },
    });
  });

  test("rejects unsupported message and content fields with exact source paths", () => {
    expect(
      adapt({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hello", cache_control: {} }],
      }),
    ).toMatchObject({
      ok: false,
      code: "unsupported_message_field",
      param: "messages.0.cache_control",
    });
    expect(
      adapt({
        model: "gpt-5.6-sol",
        messages: [
          {
            role: "user",
            content: [{ type: "thinking", thinking: "private" }],
          },
        ],
      }),
    ).toMatchObject({
      ok: false,
      code: "unsupported_content_part",
      param: "messages.0.content.0",
    });
    expect(
      adapt({
        model: "gpt-5.6-sol",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "url", data: "https://example.com/a.png" },
              },
            ],
          },
        ],
      }),
    ).toMatchObject({
      ok: false,
      code: "unsupported_image_source",
      param: "messages.0.content.0.source.type",
    });
  });

  test.each([
    [42, "messages.1.content.0.content"],
    [[{ type: "image", data: "YQ==" }], "messages.1.content.0.content.0"],
    [[{ type: "text", text: "result", extra: true }], "messages.1.content.0.content.0.extra"],
  ] as const)("rejects non-text tool result content %#", (content, param) => {
    expect(
      adapt({
        model: "gpt-5.6-sol",
        tools: [
          {
            type: "function",
            function: { name: "read", parameters: { type: "object" } },
          },
        ],
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "read", arguments: "{}" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call-1",
                content,
              },
            ],
          },
        ],
      }),
    ).toMatchObject({ ok: false, param });
  });

  test("rejects missing, duplicate, orphan, and unresolved tool history", () => {
    const call = {
      id: "call-1",
      type: "function",
      function: { name: "read", arguments: "{}" },
    };
    const declaration = {
      type: "function",
      function: { name: "read", parameters: { type: "object" } },
    };
    expect(
      adapt({
        model: "gpt-5.6-sol",
        messages: [{ role: "assistant", tool_calls: [call] }],
      }),
    ).toMatchObject({ ok: false, code: "missing_tool_declaration" });
    expect(
      adapt({
        model: "gpt-5.6-sol",
        tools: [declaration],
        messages: [
          { role: "assistant", tool_calls: [call] },
          { role: "assistant", tool_calls: [call] },
        ],
      }),
    ).toMatchObject({ ok: false, code: "invalid_tool_history" });
    expect(
      adapt({
        model: "gpt-5.6-sol",
        messages: [{ role: "tool", tool_call_id: "call-1", content: "orphan" }],
      }),
    ).toMatchObject({ ok: false, code: "invalid_tool_history" });
    expect(
      adapt({
        model: "gpt-5.6-sol",
        tools: [declaration],
        tool_choice: "none",
        messages: [{ role: "assistant", tool_calls: [call] }],
      }),
    ).toMatchObject({
      ok: false,
      code: "unsupported_tool_choice",
      param: "tool_choice",
    });
  });

  test("rejects duplicate declarations and non-text tool messages", () => {
    const declaration = {
      name: "read",
      input_schema: { type: "object" },
    };
    expect(
      adapt({
        model: "gpt-5.6-sol",
        tools: [declaration, declaration],
        messages: [{ role: "user", content: "hello" }],
      }),
    ).toMatchObject({
      ok: false,
      code: "invalid_tool_declaration",
      param: "tools.1",
    });
    expect(
      adapt({
        model: "gpt-5.6-sol",
        messages: [
          {
            role: "tool",
            tool_call_id: "call-1",
            content: [
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,YQ==" },
              },
            ],
          },
        ],
      }),
    ).toMatchObject({
      ok: false,
      code: "unsupported_tool_result_content",
      param: "messages.0.content",
    });
  });

  test("retains Chat reasoning replay lookup and standard session hints", () => {
    const result = adapt({
      model: "gpt-5.6-sol",
      prompt_cache_key: "session-123",
      reasoning_effort: "high",
      tool_choice: "none",
      messages: [
        {
          role: "assistant",
          content: "answer bytes",
          reasoning_content: "reasoning bytes",
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        promptCacheKey: "session-123",
        reasoningEffort: "high",
        requestedReasoningEffort: "high",
        toolChoice: "none",
        reasoningReplays: [
          {
            lookup: { kind: "chat-hash", reasoningText: "reasoning bytes" },
            insertBeforeMessage: 0,
          },
        ],
      },
    });
  });
});

describe("Chat OpenAI-compatibility parameters", () => {
  test("accepts n=1 and rejects any other choice count", () => {
    const base = {
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hello" }],
    };

    expect(adapt({ ...base, n: 1 })).toMatchObject({ ok: true });
    expect(adapt({ ...base, n: 2 })).toMatchObject({
      ok: false,
      code: "unsupported_parameter",
      param: "n",
    });
  });

  test.each([
    ["none", undefined],
    ["minimal", "low"],
    ["low", "low"],
    ["xhigh", "xhigh"],
  ] as const)("maps reasoning_effort %s like the Responses adapter", (requested, mapped) => {
    const result = adapt({
      model: "gpt-5.6-sol",
      reasoning_effort: requested,
      messages: [{ role: "user", content: "hello" }],
    });

    if (!result.ok) throw new TypeError("Expected the effort to be accepted");
    expect(result.value.reasoningEffort).toBe(mapped);
    expect(result.value.requestedReasoningEffort).toBe(requested);
  });
});
