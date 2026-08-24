import { describe, expect, test } from "bun:test";
import { parseResponsesRequest, type ResponsesRequest } from "../src/server/request-schema.js";
import { responsesToInternalChat } from "../src/server/responses/request-adapter.js";

const MODEL = "gpt-5.6-sol";

function parsedRequest(raw: unknown): ResponsesRequest {
  const parsed = parseResponsesRequest(raw);
  if (!parsed.ok) throw new TypeError("Expected a valid Responses request");
  return parsed.value;
}

function customBridge() {
  const adapted = responsesToInternalChat(
    parsedRequest({
      model: MODEL,
      tools: [{ type: "custom", name: "exec", description: "Execute a command" }],
      input: "run",
    }),
  );
  if (!adapted.ok) throw new TypeError(`Expected a bridge, received ${adapted.code}`);
  return adapted;
}

describe("ResponsesToolBridge", () => {
  test.each([
    ["patch", "*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch"],
    ["JSON-looking input", '{"nested":true}'],
    ["empty input", ""],
    ["CRLF", "first\r\nsecond\r\n"],
    ["quotes and slashes", 'say "hello" from C:\\tmp\\file'],
    ["Unicode", "你好, Καλημέρα"],
  ])("round-trips custom raw input byte-for-byte: %s", (_label, rawInput) => {
    const adapted = customBridge();
    const alias = adapted.body.tools?.[0]?.function.name;
    if (!alias) throw new TypeError("Custom alias was not generated");

    const restored = adapted.bridge.restoreCalls([
      {
        itemId: "fc_1",
        id: "call_1",
        name: alias,
        arguments: JSON.stringify({ input: rawInput }),
      },
    ]);

    expect(restored).toEqual({
      ok: true,
      items: [
        {
          id: "fc_1",
          type: "custom_tool_call",
          call_id: "call_1",
          name: "exec",
          input: rawInput,
        },
      ],
    });
  });

  test.each(["{}", '{"input":1}', '{"input":"ok","extra":true}', "[]", "{not-json"])(
    "rejects malformed custom wrapper %s",
    (wrapper) => {
      const adapted = customBridge();
      const alias = adapted.body.tools?.[0]?.function.name;
      if (!alias) throw new TypeError("Custom alias was not generated");
      expect(
        adapted.bridge.restoreCalls([
          { itemId: "fc_1", id: "call_1", name: alias, arguments: wrapper },
        ]),
      ).toMatchObject({ ok: false, code: "invalid_custom_tool_input" });
    },
  );

  test("bridges Codex 0.149 namespaced custom tools without losing the public identity", () => {
    const adapted = responsesToInternalChat(
      parsedRequest({
        model: MODEL,
        input: [
          {
            type: "additional_tools",
            role: "developer",
            tools: [
              {
                type: "namespace",
                name: "functions",
                description: "Built-in Codex tools",
                tools: [
                  {
                    type: "custom",
                    name: "exec",
                    description: "Execute a shell command",
                    format: {
                      type: "grammar",
                      syntax: "lark",
                      definition: "start: SOURCE\nSOURCE: /[\\s\\S]+/",
                    },
                  },
                  {
                    type: "function",
                    name: "wait",
                    description: "Wait for a process",
                    parameters: { type: "object" },
                  },
                ],
              },
            ],
          },
          { type: "message", role: "user", content: [] },
        ],
      }),
    );
    if (!adapted.ok) throw new TypeError(`Expected a bridge, received ${adapted.code}`);

    expect(adapted.body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "kiro_ns_0",
          description: "Built-in Codex tools\n\nExecute a shell command",
          parameters: {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "kiro_ns_1",
          description: "Built-in Codex tools\n\nWait for a process",
          parameters: { type: "object" },
        },
      },
    ]);

    expect(
      adapted.bridge.lowerCall({
        type: "custom_tool_call",
        call_id: "call_exec",
        namespace: "functions",
        name: "exec",
        input: "printf 'OK\n'",
      }),
    ).toEqual({
      id: "call_exec",
      type: "function",
      function: {
        name: "kiro_ns_0",
        arguments: JSON.stringify({ input: "printf 'OK\n'" }),
      },
    });

    expect(
      adapted.bridge.restoreCalls([
        {
          itemId: "ctc_exec",
          id: "call_exec",
          name: "kiro_ns_0",
          arguments: JSON.stringify({ input: "printf 'OK\n'" }),
        },
      ]),
    ).toEqual({
      ok: true,
      items: [
        {
          id: "ctc_exec",
          type: "custom_tool_call",
          call_id: "call_exec",
          namespace: "functions",
          name: "exec",
          input: "printf 'OK\n'",
        },
      ],
    });
  });

  test("rebuilds a namespaced custom alias from continuation history", () => {
    const adapted = responsesToInternalChat(
      parsedRequest({
        model: MODEL,
        input: [
          {
            type: "custom_tool_call",
            call_id: "call_exec",
            namespace: "functions",
            name: "exec",
            input: "pwd",
          },
          { type: "custom_tool_call_output", call_id: "call_exec", output: "/workspace" },
        ],
      }),
    );
    if (!adapted.ok) throw new TypeError(`Expected a bridge, received ${adapted.code}`);

    expect(adapted.body.tools?.[0]).toEqual({
      type: "function",
      function: {
        name: "kiro_ns_0",
        parameters: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
          additionalProperties: false,
        },
      },
    });
    expect(adapted.body.messages).toEqual([
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_exec",
            type: "function",
            function: {
              name: "kiro_ns_0",
              arguments: JSON.stringify({ input: "pwd" }),
            },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_exec", content: "/workspace" }],
      },
    ]);
  });

  test("restores namespace and ordinary function calls in one atomic batch", () => {
    const adapted = responsesToInternalChat(
      parsedRequest({
        model: MODEL,
        tools: [
          { type: "function", name: "plain", parameters: { type: "object" } },
          {
            type: "namespace",
            name: "collaboration",
            tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object" } }],
          },
        ],
        input: "run",
      }),
    );
    if (!adapted.ok) throw new TypeError(`Expected a bridge, received ${adapted.code}`);
    const namespaceAlias = adapted.body.tools?.[1]?.function.name;
    if (!namespaceAlias) throw new TypeError("Namespace alias was not generated");

    expect(
      adapted.bridge.restoreCalls([
        { itemId: "fc_1", id: "call_1", name: "plain", arguments: "{}" },
        {
          itemId: "fc_2",
          id: "call_2",
          name: namespaceAlias,
          arguments: '{"task_name":"review"}',
        },
      ]),
    ).toEqual({
      ok: true,
      items: [
        {
          id: "fc_1",
          type: "function_call",
          call_id: "call_1",
          name: "plain",
          arguments: "{}",
        },
        {
          id: "fc_2",
          type: "function_call",
          call_id: "call_2",
          namespace: "collaboration",
          name: "spawn_agent",
          arguments: '{"task_name":"review"}',
        },
      ],
    });
  });

  test("normalizes empty ordinary and namespace function arguments to an object", () => {
    const adapted = responsesToInternalChat(
      parsedRequest({
        model: MODEL,
        tools: [
          { type: "function", name: "plain", parameters: { type: "object" } },
          {
            type: "namespace",
            name: "resources",
            tools: [{ type: "function", name: "list", parameters: { type: "object" } }],
          },
        ],
        input: "run",
      }),
    );
    if (!adapted.ok) throw new TypeError(`Expected a bridge, received ${adapted.code}`);
    const namespaceAlias = adapted.body.tools?.[1]?.function.name;
    if (!namespaceAlias) throw new TypeError("Namespace alias was not generated");

    expect(
      adapted.bridge.restoreCalls([
        { itemId: "fc_1", id: "call_1", name: "plain", arguments: "" },
        { itemId: "fc_2", id: "call_2", name: namespaceAlias, arguments: "   " },
      ]),
    ).toEqual({
      ok: true,
      items: [
        {
          id: "fc_1",
          type: "function_call",
          call_id: "call_1",
          name: "plain",
          arguments: "{}",
        },
        {
          id: "fc_2",
          type: "function_call",
          call_id: "call_2",
          namespace: "resources",
          name: "list",
          arguments: "{}",
        },
      ],
    });
  });

  test("skips reserved aliases occupied by declarations and historical ordinary calls", () => {
    const adapted = responsesToInternalChat(
      parsedRequest({
        model: MODEL,
        tools: [
          { type: "function", name: "kiro_custom_0", parameters: { type: "object" } },
          { type: "custom", name: "exec", description: "Execute a command" },
          {
            type: "namespace",
            name: "collaboration",
            tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object" } }],
          },
        ],
        input: [
          { type: "function_call", call_id: "ordinary_ns", name: "kiro_ns_0", arguments: "{}" },
          { type: "function_call_output", call_id: "ordinary_ns", output: "ordinary result" },
        ],
      }),
    );
    if (!adapted.ok) throw new TypeError(`Expected a bridge, received ${adapted.code}`);

    expect(adapted.body.tools?.map((tool) => tool.function.name)).toEqual([
      "kiro_custom_0",
      "kiro_custom_1",
      "kiro_ns_1",
    ]);
    expect(
      adapted.bridge.restoreCalls([
        {
          itemId: "fc_custom",
          id: "call_custom",
          name: "kiro_custom_1",
          arguments: JSON.stringify({ input: "pwd" }),
        },
        {
          itemId: "fc_namespace",
          id: "call_namespace",
          name: "kiro_ns_1",
          arguments: '{"task_name":"review"}',
        },
        {
          itemId: "fc_declared_ordinary",
          id: "call_declared_ordinary",
          name: "kiro_custom_0",
          arguments: "{}",
        },
        {
          itemId: "fc_historical_ordinary",
          id: "call_historical_ordinary",
          name: "kiro_ns_0",
          arguments: "{}",
        },
      ]),
    ).toEqual({
      ok: true,
      items: [
        {
          id: "fc_custom",
          type: "custom_tool_call",
          call_id: "call_custom",
          name: "exec",
          input: "pwd",
        },
        {
          id: "fc_namespace",
          type: "function_call",
          call_id: "call_namespace",
          namespace: "collaboration",
          name: "spawn_agent",
          arguments: '{"task_name":"review"}',
        },
        {
          id: "fc_declared_ordinary",
          type: "function_call",
          call_id: "call_declared_ordinary",
          name: "kiro_custom_0",
          arguments: "{}",
        },
        {
          id: "fc_historical_ordinary",
          type: "function_call",
          call_id: "call_historical_ordinary",
          name: "kiro_ns_0",
          arguments: "{}",
        },
      ],
    });
  });

  test("rejects an unregistered reserved alias", () => {
    const adapted = customBridge();
    expect(
      adapted.bridge.restoreCalls([
        { itemId: "fc_1", id: "call_1", name: "kiro_ns_999", arguments: "{}" },
      ]),
    ).toMatchObject({ ok: false, code: "unknown_tool_alias" });
  });

  test("disambiguates colon-colliding namespace identities into distinct aliases", () => {
    const adapted = responsesToInternalChat(
      parsedRequest({
        model: MODEL,
        tools: [
          {
            type: "namespace",
            name: "a:b",
            tools: [{ type: "function", name: "c", parameters: { type: "object" } }],
          },
          {
            type: "namespace",
            name: "a",
            tools: [{ type: "function", name: "b:c", parameters: { type: "object" } }],
          },
        ],
        input: "run",
      }),
    );
    if (!adapted.ok) throw new TypeError(`Expected a bridge, received ${adapted.code}`);

    const firstAlias = adapted.body.tools?.[0]?.function.name;
    const secondAlias = adapted.body.tools?.[1]?.function.name;
    if (!firstAlias || !secondAlias) {
      throw new TypeError("Both colliding namespaces must generate aliases");
    }
    expect(adapted.body.tools).toHaveLength(2);
    expect(firstAlias).not.toBe(secondAlias);

    expect(
      adapted.bridge.restoreCalls([
        { itemId: "fc_1", id: "call_1", name: firstAlias, arguments: "{}" },
        { itemId: "fc_2", id: "call_2", name: secondAlias, arguments: "{}" },
      ]),
    ).toEqual({
      ok: true,
      items: [
        {
          id: "fc_1",
          type: "function_call",
          call_id: "call_1",
          namespace: "a:b",
          name: "c",
          arguments: "{}",
        },
        {
          id: "fc_2",
          type: "function_call",
          call_id: "call_2",
          namespace: "a",
          name: "b:c",
          arguments: "{}",
        },
      ],
    });
  });

  test("rebuilds colon-colliding namespace identities from history without declarations", () => {
    const adapted = responsesToInternalChat(
      parsedRequest({
        model: MODEL,
        input: [
          {
            type: "function_call",
            call_id: "call_1",
            namespace: "a:b",
            name: "c",
            arguments: "{}",
          },
          { type: "function_call_output", call_id: "call_1", output: "first" },
          {
            type: "function_call",
            call_id: "call_2",
            namespace: "a",
            name: "b:c",
            arguments: "{}",
          },
          { type: "function_call_output", call_id: "call_2", output: "second" },
        ],
      }),
    );
    if (!adapted.ok) throw new TypeError(`Expected a bridge, received ${adapted.code}`);

    const aliases = adapted.body.tools?.map((tool) => tool.function.name) ?? [];
    expect(aliases).toHaveLength(2);
    expect(new Set(aliases).size).toBe(2);
    const [firstAlias, secondAlias] = aliases;
    if (!firstAlias || !secondAlias) {
      throw new TypeError("Both colliding namespaces must rebuild aliases");
    }

    expect(
      adapted.bridge.restoreCalls([
        { itemId: "fc_1", id: "call_1", name: firstAlias, arguments: "{}" },
        { itemId: "fc_2", id: "call_2", name: secondAlias, arguments: "{}" },
      ]),
    ).toEqual({
      ok: true,
      items: [
        {
          id: "fc_1",
          type: "function_call",
          call_id: "call_1",
          namespace: "a:b",
          name: "c",
          arguments: "{}",
        },
        {
          id: "fc_2",
          type: "function_call",
          call_id: "call_2",
          namespace: "a",
          name: "b:c",
          arguments: "{}",
        },
      ],
    });
  });
});
