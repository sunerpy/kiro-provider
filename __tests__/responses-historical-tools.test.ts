import { describe, expect, test } from "bun:test";
import { runChatCompletion } from "../src/core/pipeline.js";
import { toolOutputValidator } from "../src/core/tool-output-validation.js";
import { buildCodeWhispererRequest } from "../src/kiro/transform/request-core.js";
import { CANONICAL_OUTPUT_JSON_CONTENT_TYPE } from "../src/protocol/output.js";
import { parseResponsesRequest } from "../src/server/request-schema.js";
import { adaptResponsesRequest } from "../src/server/responses/request-adapter.js";
import { parsedResponses, TEST_AUTH } from "./canonical-test-helpers.js";
import { fidelityFixture } from "./responses-fidelity-helpers.js";

const call = {
  type: "function_call",
  call_id: "call-read",
  name: "read",
  arguments: '{ "path": "fixture.json" }',
} as const;
const result = {
  type: "function_call_output",
  call_id: call.call_id,
  output: '{"value":43921}',
} as const;
const input = [
  { role: "user", content: "Read the fixture" } as const,
  call,
  result,
  { role: "user", content: "Repeat the earlier value without reading again" } as const,
];
const tool = (name: string, parameters: Record<string, unknown> = { type: "object" }) => ({
  type: "function" as const,
  name,
  description: `Synthetic ${name}`,
  parameters,
});

describe("Responses historical tools are not current execution authority", () => {
  test.each([
    { label: "unchanged declaration control", tools: [tool("read")] },
    { label: "all tools removed", tools: [] },
    { label: "only a different tool remains", tools: [tool("search")] },
    {
      label: "current same-name schema changed",
      tools: [
        tool("read", {
          type: "object",
          properties: { key: { type: "number" } },
          required: ["key"],
          additionalProperties: false,
        }),
      ],
    },
  ])("$label preserves history without adding declarations", ({ tools }) => {
    const original = JSON.stringify(input);
    const adapted = adaptResponsesRequest(
      parsedResponses({ model: "claude-opus-5", input, tools }),
      "legacy-user-prefix",
    );
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    expect(adapted.bridge.lowerCall(call).function.arguments).toBe(call.arguments);
    const projected = buildCodeWhispererRequest(adapted.body, adapted.body.model, TEST_AUTH);
    const historyCalls =
      projected.request.conversationState.history?.flatMap(
        (item) => item.assistantResponseMessage?.toolUses ?? [],
      ) ?? [];
    expect(historyCalls).toEqual([
      { toolUseId: call.call_id, name: "read", input: { path: "fixture.json" } },
    ]);
    const current =
      projected.request.conversationState.currentMessage.userInputMessage?.userInputMessageContext
        ?.tools ?? [];
    expect(current.map((item) => item.toolSpecification?.name)).toEqual(
      tools.map((item) => item.name),
    );
    expect(adapted.body.tools.map((item) => item.wireName)).toEqual(tools.map((item) => item.name));
    expect(JSON.stringify(input)).toBe(original);
    if (!tools.some((item) => item.name === "read")) {
      const validate = toolOutputValidator(
        adapted.body.tools.map((item) => ({ name: item.wireName, schema: item.inputSchema })),
      );
      expect(() => validate.assertName("read")).toThrow("undeclared");
      expect(
        adapted.bridge.restoreCalls([
          { itemId: "new-item", id: "new-call", name: "read", arguments: "{}" },
        ]),
      ).toMatchObject({ ok: false, code: "unknown_tool_alias" });
      expect(adapted.bridge.identityFor("read")).toBeUndefined();
    }
  });

  test("tool_choice none does not invalidate completed historical calls", () => {
    const adapted = adaptResponsesRequest(
      parsedResponses({ model: "claude-opus-5", input, tools: [], tool_choice: "none" }),
      "legacy-user-prefix",
    );
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    expect(
      buildCodeWhispererRequest(adapted.body, adapted.body.model, TEST_AUTH).request
        .conversationState.history,
    ).toBeDefined();
    expect(adapted.body.tools).toHaveLength(0);
    expect(adapted.body.toolChoice).toBe("none");
  });

  test.each([false, true])(
    "new output still requires current authorization, stream=%s",
    async (stream) => {
      for (const shape of [
        { tools: [], code: "unknown_upstream_tool" },
        { tools: [tool("search")], code: "unknown_upstream_tool" },
        { tools: [tool("read")], tool_choice: "none", code: "upstream_tool_choice_violation" },
        {
          tools: [
            tool("read", {
              type: "object",
              properties: { key: { type: "number" } },
              required: ["key"],
              additionalProperties: false,
            }),
          ],
          code: "upstream_tool_schema_violation",
        },
      ]) {
        const f = fidelityFixture();
        let sends = 0;
        try {
          const response = await f.send(
            {
              model: "claude-opus-5",
              input,
              stream,
              store: false,
              tools: shape.tools,
              tool_choice: shape.tool_choice,
            },
            {
              runPipeline: runChatCompletion,
              makeClient: () => ({
                async send() {
                  sends += 1;
                  return {
                    generateAssistantResponseResponse: {
                      async *[Symbol.asyncIterator]() {
                        yield {
                          toolUseEvent: {
                            toolUseId: "new-read",
                            name: "read",
                            input: '{"path":"new.json"}',
                            stop: true,
                          },
                        };
                        yield {
                          metadataEvent: { tokenUsage: { inputTokens: 1, outputTokens: 1 } },
                        };
                      },
                    },
                  };
                },
              }),
            },
          );
          expect(response.status).toBe(stream ? 200 : 502);
          const text = await response.text();
          expect(text).toContain(shape.code);
          expect(text).not.toContain("event: response.completed");
          expect(text).not.toContain("event: response.output_item.done");
          expect(sends).toBe(1);
        } finally {
          f.database.close();
        }
      }
    },
  );

  test("invalid JSON, duplicates, orphan results and wrong result kinds stay invalid", () => {
    expect(
      parseResponsesRequest({
        model: "claude-opus-5",
        tools: [],
        input: [{ ...call, arguments: "{" }, result],
      }).ok,
    ).toBe(false);
    for (const items of [
      [call, call, result],
      [result],
      [result, call],
      [call, result, result],
      [{ type: "custom_tool_call", call_id: call.call_id, name: "raw", input: "raw" }, result],
    ]) {
      const adapted = adaptResponsesRequest(
        parsedResponses({ model: "claude-opus-5", tools: [], input: items }),
      );
      expect(adapted).toMatchObject({ ok: false, code: "invalid_tool_history" });
    }
  });
});

describe("stored namespace/custom identities never authorize new calls", () => {
  const tools = [
    { type: "namespace", name: "first", tools: [tool("lookup")] },
    { type: "namespace", name: "second", tools: [tool("lookup")] },
    { type: "custom", name: "raw", description: "Raw fixture" },
  ];
  const historical = [
    {
      type: "function_call",
      call_id: "ns-call",
      namespace: "first",
      name: "lookup",
      arguments: '{ "a": 1 }',
    },
    { type: "custom_tool_call", call_id: "raw-call", name: "raw", input: 'raw "quoted"\\\nline' },
  ] as const;

  test("saved aliases survive removal/reordering without schema fabrication", () => {
    const seed = adaptResponsesRequest(
      parsedResponses({ model: "claude-opus-5", input: "start", tools }),
    );
    expect(seed.ok).toBe(true);
    if (!seed.ok) return;
    const originalBindings = seed.bridge.bindings;
    const previous = { messages: [], toolBindings: originalBindings };
    const removed = adaptResponsesRequest(
      parsedResponses({
        model: "claude-opus-5",
        input: historical,
        tools: [tools[1]],
      }),
      "safe",
      previous,
    );
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.body.tools.map((item) => item.wireName)).toEqual(["kiro_ns_1"]);
    for (const item of historical) {
      expect(removed.bridge.lowerCall(item)).toEqual(seed.bridge.lowerCall(item));
      const wire = removed.bridge.lowerCall(item).function.name;
      expect(removed.bridge.identityFor(wire)).toBeUndefined();
      expect(
        removed.bridge.restoreCalls([
          { itemId: "new", id: "new-call", name: wire, arguments: "{}" },
        ]),
      ).toMatchObject({ ok: false, code: "unknown_tool_alias" });
    }
    const reordered = adaptResponsesRequest(
      parsedResponses({
        model: "claude-opus-5",
        input: historical,
        tools: [tools[2], tools[1], tools[0]],
      }),
      "safe",
      previous,
    );
    expect(reordered.ok).toBe(true);
    if (!reordered.ok) return;
    expect(reordered.body.tools.map((item) => item.wireName)).toEqual([
      "kiro_custom_0",
      "kiro_ns_1",
      "kiro_ns_0",
    ]);
  });

  test("unknown historical aliases and collisions fail explicitly", () => {
    expect(
      adaptResponsesRequest(
        parsedResponses({ model: "claude-opus-5", input: historical, tools: [] }),
      ),
    ).toMatchObject({ ok: false, code: "missing_historical_tool_binding", param: "input.0" });
    const conflicting = adaptResponsesRequest(
      parsedResponses({
        model: "claude-opus-5",
        input: historical,
        tools: [tool("kiro_ns_0")],
      }),
      "safe",
      {
        messages: [],
        toolBindings: [
          {
            wireName: "kiro_ns_0",
            identity: {
              kind: "namespace",
              namespace: "first",
              name: "lookup",
              toolType: "function",
            },
          },
          { wireName: "kiro_custom_0", identity: { kind: "custom", name: "raw" } },
        ],
      },
    );
    expect(conflicting).toMatchObject({ ok: false, code: "invalid_tool_declaration" });
  });

  test("previous_response_id persists historical bindings separately from current tools", async () => {
    const f = fidelityFixture();
    let turn = 0;
    try {
      const runner: typeof runChatCompletion = async (options) => {
        turn += 1;
        if (turn === 2) {
          expect(options.body.tools.map((item) => item.wireName)).toEqual(["other"]);
          expect(
            options.body.messages.flatMap((message) => message.toolCalls).map((item) => item.name),
          ).toEqual(["kiro_ns_0", "kiro_ns_1", "kiro_custom_0"]);
          const projected = buildCodeWhispererRequest(options.body, options.model, TEST_AUTH);
          expect(
            projected.request.conversationState.currentMessage.userInputMessage
              ?.userInputMessageContext?.tools,
          ).toHaveLength(1);
        }
        return Response.json(
          {
            canonicalOutputVersion: 1,
            conversationId: "binding-fixture",
            model: options.model,
            createdAt: 1_789_200_000,
            text: turn === 1 ? "" : "43921",
            toolCalls:
              turn === 1
                ? options.body.tools.map((item, index) => ({
                    id: `call-${index}`,
                    name: item.wireName,
                    input: item.publicType === "custom" ? '{"input":"raw"}' : '{"a":1}',
                  }))
                : [],
            finishReason: turn === 1 ? "tool_calls" : "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
          { headers: { "Content-Type": CANONICAL_OUTPUT_JSON_CONTENT_TYPE } },
        );
      };
      const first = await f.send(
        { model: "claude-opus-5", reasoning: { effort: "max" }, input: "start", tools },
        { runPipeline: runner },
      );
      expect(first.status).toBe(200);
      const body = (await first.json()) as {
        id: string;
        output: Array<{ type: string; call_id: string }>;
      };
      expect(f.responseStore.get("fidelity-test", body.id)?.continuation?.tools).toHaveLength(3);
      const second = await f.send(
        {
          model: "claude-opus-5",
          previous_response_id: body.id,
          tools: [tool("other")],
          input: [
            ...body.output.map((item) => ({
              type:
                item.type === "custom_tool_call"
                  ? "custom_tool_call_output"
                  : "function_call_output",
              call_id: item.call_id,
              output: "ok",
            })),
            { role: "user", content: "Remember the value" },
          ],
        },
        { runPipeline: runner },
      );
      expect(second.status).toBe(200);
      expect(await second.text()).toContain("43921");
    } finally {
      f.database.close();
    }
  });
});
