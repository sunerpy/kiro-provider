import { describe, expect, test } from "bun:test";
import { buildCodeWhispererRequest } from "../src/kiro/transform/request-core.js";
import type { KiroAuthDetails } from "../src/kiro/types.js";
import {
  type ChatCompletionRequest,
  parseChatCompletionRequest,
  parseResponsesRequest,
  type ResponsesRequest,
} from "../src/server/request-schema.js";
import { responsesToInternalChat } from "../src/server/responses/request-adapter.js";

const MODEL = "gpt-5.6-sol";
const AUTH: KiroAuthDetails = {
  refresh: "refresh-token",
  access: "access-token",
  expires: Date.now() + 60_000,
  authMethod: "desktop",
  region: "us-east-1",
};
const EFFORT_CASES: Array<
  [
    "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
    ChatCompletionRequest["reasoning_effort"],
  ]
> = [
  ["none", undefined],
  ["minimal", "low"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "xhigh"],
  ["max", "max"],
];

function parsedResponses(raw: unknown): ResponsesRequest {
  const parsed = parseResponsesRequest(raw);
  if (!parsed.ok) throw new TypeError("Expected a valid Responses request");
  return parsed.value;
}

function adaptedBody(raw: unknown): ChatCompletionRequest {
  const adapted = responsesToInternalChat(parsedResponses(raw));
  if (!adapted.ok) throw new TypeError(`Expected an adapted body, received ${adapted.code}`);

  const internal = parseChatCompletionRequest(adapted.body);
  expect(internal.ok).toBe(true);
  if (!internal.ok) throw new TypeError("Adapted body did not pass internal chat validation");
  return internal.value;
}

async function expectInvalid(raw: unknown): Promise<void> {
  const parsed = parseResponsesRequest(raw);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) throw new TypeError("Expected an invalid Responses request");
  expect(parsed.response.status).toBe(400);
  expect(await parsed.response.json()).toMatchObject({
    error: {
      type: "invalid_request_error",
      code: "invalid_request",
    },
  });
}

describe("Responses request parsing and adaptation", () => {
  test("maps string input, instructions, tools, tool choice, model, and stream", () => {
    const body = adaptedBody({
      model: MODEL,
      instructions: "Follow the repository rules.",
      input: "Inspect the project.",
      stream: true,
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Read one file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          strict: true,
        },
      ],
      tool_choice: "auto",
    });

    expect(body).toEqual({
      model: MODEL,
      stream: true,
      messages: [
        { role: "system", content: "Follow the repository rules." },
        { role: "user", content: "Inspect the project." },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read one file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        },
      ],
      tool_choice: "auto",
    });
  });

  test("accepts Codex server-side tools while exposing only executable tools to Kiro", () => {
    const body = adaptedBody({
      model: MODEL,
      input: "Inspect the project.",
      tools: [
        {
          type: "function",
          name: "exec_command",
          description: "Run a command",
          parameters: { type: "object" },
        },
        {
          type: "web_search",
          external_web_access: true,
        },
      ],
    });

    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "exec_command",
          description: "Run a command",
          parameters: { type: "object" },
        },
      },
    ]);
  });

  test("maps text and image parts while skipping genuinely unknown content parts", () => {
    const body = adaptedBody({
      model: MODEL,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "first" },
            { type: "output_text", text: "second" },
            { type: "input_image", image_url: "data:image/png;base64,AA==" },
            { type: "input_image", image_url: "https://example.test/image.png" },
            { type: "future_content_part", payload: { accepted: true } },
          ],
        },
      ],
    });

    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
          { type: "image_url", image_url: { url: "https://example.test/image.png" } },
        ],
      },
    ]);
  });

  test("preserves Codex collaboration agent plaintext without provider-owned task prefixes", () => {
    const body = adaptedBody({
      model: MODEL,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Spawn another agent." }],
        },
        {
          type: "agent_message",
          author: "/root",
          recipient: "/root/namespace_check",
          content: [
            {
              type: "input_text",
              text: "Message Type: NEW_TASK\nTask name: /root/namespace_check\nSender: /root\nPayload:\n",
            },
            {
              type: "encrypted_content",
              encrypted_content: "Return exactly NAMESPACE_CHILD_OK and nothing else.",
            },
          ],
        },
      ],
    });

    expect(body.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Spawn another agent." }],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Message Type: NEW_TASK\nTask name: /root/namespace_check\nSender: /root\nPayload:\n",
          },
        ],
      },
    ]);

    const transformed = buildCodeWhispererRequest(body, MODEL, AUTH);
    const currentContent =
      transformed.request.conversationState.currentMessage.userInputMessage?.content;
    expect(currentContent).toBe(
      "Spawn another agent.Message Type: NEW_TASK\nTask name: /root/namespace_check\nSender: /root\nPayload:\n",
    );
    expect(currentContent).not.toContain("NAMESPACE_CHILD_OK");
    expect(transformed.request.conversationState.history).toBeUndefined();
  });

  test("maps non-NEW_TASK agent messages without a delegated-task boundary or priority prefix", () => {
    const body = adaptedBody({
      model: MODEL,
      input: [
        {
          type: "agent_message",
          author: "/root/namespace_check",
          recipient: "/root",
          content: [
            { type: "input_text", text: "Message Type: FINAL_ANSWER\n" },
            { type: "encrypted_content", encrypted_content: "NAMESPACE_CHILD_OK" },
          ],
        },
      ],
    });

    expect(body.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Message Type: FINAL_ANSWER\n" }],
      },
    ]);
  });

  test("maps function calls and function outputs to assistant and tool messages", () => {
    const body = adaptedBody({
      model: MODEL,
      input: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "read_file",
          arguments: '{"path":"README.md"}',
        },
        { type: "function_call_output", call_id: "call_1", output: "contents" },
      ],
    });

    expect(body.messages).toEqual([
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"README.md"}' },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "contents" }],
      },
    ]);
  });

  test("keeps two call outputs independently paired through the real Kiro request transformer", () => {
    const body = adaptedBody({
      model: MODEL,
      input: [
        { type: "function_call", call_id: "call_a", name: "alpha", arguments: "{}" },
        { type: "function_call", call_id: "call_b", name: "beta", arguments: "{}" },
        { type: "function_call_output", call_id: "call_a", output: "OUTPUT_A" },
        { type: "function_call_output", call_id: "call_b", output: "OUTPUT_B" },
      ],
    });

    const transformed = buildCodeWhispererRequest(body, MODEL, AUTH);
    expect(
      transformed.request.conversationState.currentMessage.userInputMessage?.userInputMessageContext
        ?.toolResults,
    ).toEqual([
      { toolUseId: "call_a", content: [{ text: "OUTPUT_A" }], status: "success" },
      { toolUseId: "call_b", content: [{ text: "OUTPUT_B" }], status: "success" },
    ]);
  });

  test("preserves only client-declared custom and namespace guidance through a continuation", () => {
    const customParameters = {
      type: "object",
      properties: {
        input: { type: "string" },
      },
      required: ["input"],
      additionalProperties: false,
    };
    const namespaceParameters = {
      type: "object",
      properties: { task_name: { type: "string", minLength: 1 } },
      required: ["task_name"],
      additionalProperties: false,
    };
    const body = adaptedBody({
      model: MODEL,
      tools: [
        {
          type: "custom",
          name: "apply_patch",
          description: "Apply an exact repository patch",
          format: { type: "grammar", syntax: "lark", definition: "start: PATCH_BODY" },
        },
        {
          type: "namespace",
          name: "collaboration",
          description: "Coordinate delegated work",
          tools: [
            {
              type: "function",
              name: "spawn_agent",
              description: "Start one delegated task",
              parameters: namespaceParameters,
            },
          ],
        },
      ],
      input: [
        {
          type: "custom_tool_call",
          call_id: "call_patch_declared",
          name: "apply_patch",
          input: "*** Begin Patch\n*** End Patch",
        },
        {
          type: "function_call",
          call_id: "call_namespace_declared",
          namespace: "collaboration",
          name: "spawn_agent",
          arguments: '{"task_name":"review"}',
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_patch_declared",
          output: "PATCH_APPLIED_EXACTLY",
        },
        {
          type: "function_call_output",
          call_id: "call_namespace_declared",
          output: "AGENT_STARTED_EXACTLY",
        },
      ],
    });

    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "kiro_custom_0",
          description: "Apply an exact repository patch",
          parameters: customParameters,
        },
      },
      {
        type: "function",
        function: {
          name: "kiro_ns_0",
          description: "Coordinate delegated work\n\nStart one delegated task",
          parameters: namespaceParameters,
        },
      },
    ]);
    expect(body.messages[0]).toEqual({
      role: "assistant",
      tool_calls: [
        {
          id: "call_patch_declared",
          type: "function",
          function: {
            name: "kiro_custom_0",
            arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }),
          },
        },
      ],
    });
    expect(body.messages[1]).toEqual({
      role: "assistant",
      tool_calls: [
        {
          id: "call_namespace_declared",
          type: "function",
          function: { name: "kiro_ns_0", arguments: '{"task_name":"review"}' },
        },
      ],
    });

    const transformed = buildCodeWhispererRequest(body, MODEL, AUTH);
    expect(
      transformed.request.conversationState.currentMessage.userInputMessage?.userInputMessageContext
        ?.tools,
    ).toEqual([
      {
        toolSpecification: {
          name: "kiro_custom_0",
          description: "Apply an exact repository patch",
          inputSchema: { json: customParameters },
        },
      },
      {
        toolSpecification: {
          name: "kiro_ns_0",
          description: "Coordinate delegated work\n\nStart one delegated task",
          inputSchema: { json: namespaceParameters },
        },
      },
    ]);
    expect(
      transformed.request.conversationState.history?.flatMap(
        (entry) => entry.assistantResponseMessage?.toolUses ?? [],
      ),
    ).toEqual([
      {
        input: { input: "*** Begin Patch\n*** End Patch" },
        name: "kiro_custom_0",
        toolUseId: "call_patch_declared",
      },
      {
        input: { task_name: "review" },
        name: "kiro_ns_0",
        toolUseId: "call_namespace_declared",
      },
    ]);
    expect(
      transformed.request.conversationState.currentMessage.userInputMessage?.userInputMessageContext
        ?.toolResults,
    ).toEqual([
      {
        toolUseId: "call_patch_declared",
        content: [{ text: "PATCH_APPLIED_EXACTLY" }],
        status: "success",
      },
      {
        toolUseId: "call_namespace_declared",
        content: [{ text: "AGENT_STARTED_EXACTLY" }],
        status: "success",
      },
    ]);
  });

  test.each([
    [
      "duplicate call ids",
      [
        { type: "function_call", call_id: "same", name: "one", arguments: "{}" },
        { type: "function_call", call_id: "same", name: "two", arguments: "{}" },
      ],
    ],
    [
      "duplicate outputs",
      [
        { type: "function_call", call_id: "same", name: "one", arguments: "{}" },
        { type: "function_call_output", call_id: "same", output: "first" },
        { type: "function_call_output", call_id: "same", output: "second" },
      ],
    ],
    [
      "output before a later call",
      [
        { type: "function_call_output", call_id: "late", output: "too soon" },
        { type: "function_call", call_id: "late", name: "one", arguments: "{}" },
      ],
    ],
    [
      "custom output without a call",
      [{ type: "custom_tool_call_output", call_id: "missing", output: "orphan" }],
    ],
    [
      "custom output paired with a function call",
      [
        { type: "function_call", call_id: "wrong", name: "one", arguments: "{}" },
        { type: "custom_tool_call_output", call_id: "wrong", output: "mismatch" },
      ],
    ],
    [
      "function output paired with a custom call",
      [
        { type: "custom_tool_call", call_id: "wrong", name: "exec", input: "pwd" },
        { type: "function_call_output", call_id: "wrong", output: "mismatch" },
      ],
    ],
  ])("rejects invalid tool history: %s", (_label, input) => {
    const adapted = responsesToInternalChat(parsedResponses({ model: MODEL, input }));
    expect(adapted).toMatchObject({ ok: false, code: "invalid_tool_history" });
  });

  test.each([
    ["summary-only", { summary: [{ type: "summary_text", text: "summary" }] }],
    ["content-only", { content: [{ type: "reasoning_text", reasoning_text: "details" }] }],
    [
      "summary before content",
      {
        summary: [
          { type: "summary_text", text: "summary one" },
          { type: "summary_text", text: "" },
        ],
        content: [
          { type: "reasoning_text", reasoning_text: "detail one" },
          { type: "reasoning_text", reasoning_text: "detail two" },
        ],
      },
    ],
  ])("does not replay Responses reasoning (%s) as model-visible text", (_name, reasoning) => {
    const body = adaptedBody({
      model: MODEL,
      input: [
        { type: "reasoning", ...reasoning },
        {
          type: "function_call",
          call_id: "call_reasoned",
          name: "search",
          arguments: "{}",
        },
      ],
    });

    expect(body.messages).toEqual([
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_reasoned",
            type: "function",
            function: { name: "search", arguments: "{}" },
          },
        ],
      },
    ]);
  });

  test("drops standalone replayed reasoning when no following assistant item exists", () => {
    const body = adaptedBody({
      model: MODEL,
      input: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "standalone thought" }],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
    });

    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ]);
  });

  test("accepts nullable fields in Codex reasoning replay items", () => {
    const body = adaptedBody({
      model: MODEL,
      input: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "replayed thought" }],
          content: null,
          encrypted_content: null,
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
    });

    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ]);
  });

  test.each(EFFORT_CASES)("normalizes reasoning effort %s", (effort, expected) => {
    const body = adaptedBody({
      model: MODEL,
      input: "hello",
      reasoning: { effort },
    });

    expect(body.reasoning_effort).toBe(expected);
  });

  test("accepts the canonical Codex request surface and ignores non-adapted fields", () => {
    const parsed = parsedResponses({
      model: MODEL,
      input: "hello",
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: null,
      include: ["reasoning.encrypted_content"],
      store: false,
      text: { format: { type: "text" } },
      service_tier: "default",
      prompt_cache_key: "cache-key",
      client_metadata: { source: "codex" },
      previous_response_id: "resp_previous",
    });
    const adapted = responsesToInternalChat(parsed);

    expect(adapted).toMatchObject({
      ok: true,
      body: {
        model: MODEL,
        messages: [{ role: "user", content: "hello" }],
      },
    });
  });

  test.each([
    ["all unknown items", [{ type: "future_item", payload: true }]],
    ["encrypted-only reasoning", [{ type: "reasoning", encrypted_content: "opaque-ciphertext" }]],
    [
      "system-only input",
      [{ type: "message", role: "system", content: [{ type: "input_text", text: "policy" }] }],
    ],
  ])("returns empty_input for instructions plus %s", (_name, input) => {
    const adapted = responsesToInternalChat(
      parsedResponses({ model: MODEL, instructions: "instructions", input }),
    );
    expect(adapted).toEqual({ ok: false, code: "empty_input" });
  });

  test("keeps known non-system messages executable when all unknown parts are skipped", () => {
    const body = adaptedBody({
      model: MODEL,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "future_content_part", payload: true }],
        },
      ],
    });

    expect(body.messages).toEqual([{ role: "user", content: [] }]);
  });

  test.each([
    ["missing model", { input: "hello" }],
    ["missing input", { model: MODEL }],
    ["invalid input", { model: MODEL, input: 42 }],
    ["invalid effort", { model: MODEL, input: "hello", reasoning: { effort: "extreme" } }],
    ["malformed message", { model: MODEL, input: [{ type: "message", role: "user" }] }],
    [
      "invalid known message role",
      {
        model: MODEL,
        input: [{ type: "message", role: "tool", content: [] }],
      },
    ],
    [
      "malformed known text part",
      {
        model: MODEL,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: 42 }] }],
      },
    ],
    [
      "malformed known image part",
      {
        model: MODEL,
        input: [{ type: "message", role: "user", content: [{ type: "input_image" }] }],
      },
    ],
    [
      "malformed function call",
      {
        model: MODEL,
        input: [{ type: "function_call", call_id: "call_1", name: "search" }],
      },
    ],
    [
      "malformed reasoning summary",
      {
        model: MODEL,
        input: [{ type: "reasoning", summary: [{ type: "summary_text", text: 42 }] }],
      },
    ],
    [
      "malformed top-level custom declaration",
      { model: MODEL, input: "hello", tools: [{ type: "custom", description: "missing name" }] },
    ],
    [
      "malformed top-level namespace declaration",
      { model: MODEL, input: "hello", tools: [{ type: "namespace", name: "workers" }] },
    ],
    [
      "malformed additional custom declaration",
      {
        model: MODEL,
        input: [
          { type: "additional_tools", tools: [{ type: "custom", name: "" }] },
          { type: "message", role: "user", content: [] },
        ],
      },
    ],
    [
      "malformed additional namespace declaration",
      {
        model: MODEL,
        input: [
          {
            type: "additional_tools",
            tools: [{ type: "namespace", name: "workers", tools: [{ type: "custom", name: "" }] }],
          },
          { type: "message", role: "user", content: [] },
        ],
      },
    ],
    [
      "malformed custom tool call",
      {
        model: MODEL,
        input: [{ type: "custom_tool_call", call_id: "call_custom", name: "exec", input: 42 }],
      },
    ],
    [
      "malformed custom tool call output",
      {
        model: MODEL,
        input: [{ type: "custom_tool_call_output", call_id: "call_custom", output: 42 }],
      },
    ],
    [
      "malformed agent message",
      {
        model: MODEL,
        input: [{ type: "agent_message", author: "/root", recipient: "", content: [] }],
      },
    ],
    [
      "malformed encrypted content",
      {
        model: MODEL,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "encrypted_content", encrypted_content: 42 }],
          },
        ],
      },
    ],
  ])("rejects %s as a Responses-style 400", async (_name, raw) => {
    await expectInvalid(raw);
  });
});
