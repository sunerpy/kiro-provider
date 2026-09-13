import { describe, expect, test } from "bun:test";
import { toolOutputValidator } from "../src/core/tool-output-validation.js";
import { transformSdkOutputStream } from "../src/kiro/transform/streaming/sdk-output-transformer.js";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { CanonicalOutputEvent } from "../src/protocol/output.js";
import { NativeToolValidation } from "../src/server/responses/native-tool-validation.js";

const schema = {
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
  additionalProperties: false,
};
const validate = toolOutputValidator([{ name: "lookup", schema }]);
const witness: SdkStreamEvent = {
  metadataEvent: { tokenUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
};

async function transform(
  fragments: readonly string[],
  options: { stop?: boolean; complete?: boolean; maximumBytes?: number; name?: string } = {},
) {
  const emitted: CanonicalOutputEvent[] = [];
  let failure: unknown;
  try {
    for await (const event of transformSdkOutputStream(
      {
        generateAssistantResponseResponse: {
          async *[Symbol.asyncIterator]() {
            for (const [index, input] of fragments.entries()) {
              yield {
                toolUseEvent: {
                  toolUseId: "call-1",
                  name: options.name ?? "lookup",
                  input,
                  stop: options.stop !== false && index === fragments.length - 1,
                },
              };
            }
            if (options.complete !== false) yield witness;
          },
        },
      },
      "gpt-5.6-sol",
      "fixture",
      undefined,
      {
        validateToolArguments: validate,
        maxToolArgumentsBytes: options.maximumBytes ?? 1_024,
      },
    ))
      emitted.push(event);
  } catch (error) {
    failure = error;
  }
  return { emitted, failure };
}

describe("incremental SDK tool integrity", () => {
  test("preserves Unicode split across SDK fragments and emits identity only once", async () => {
    const result = await transform(['{"query":"中', "\ud83d", '\ude00\\"\\\\', '文"}']);
    expect(result.failure).toBeUndefined();
    const deltas = result.emitted.filter((event) => event.type === "tool_call_delta");
    expect(deltas.filter((event) => event.id !== undefined)).toHaveLength(1);
    expect(deltas.map((event) => event.arguments).join("")).toBe('{"query":"中😀\\"\\\\文"}');
    expect(result.emitted.filter((event) => event.type === "completed")).toHaveLength(1);
    // A high surrogate is held until its matching low surrogate arrives.
    expect(deltas.every((event) => !/[\ud800-\udbff]$/.test(event.arguments ?? ""))).toBe(true);
  });

  test.each([
    {
      label: "missing response witness",
      fragments: ['{"query":"ok"}'],
      complete: false,
      code: "upstream_stream_incomplete",
    },
    {
      label: "missing tool stop",
      fragments: ['{"query":"ok"}'],
      stop: false,
      code: "incomplete_upstream_tool_call",
    },
    {
      label: "malformed JSON",
      fragments: ['{"query":'],
      code: "malformed_upstream_tool_arguments",
    },
    {
      label: "isolated Unicode surrogate",
      fragments: ['{"query":"\udc00"}'],
      code: "malformed_upstream_tool_arguments",
    },
    {
      label: "schema mismatch",
      fragments: ['{"query":1}'],
      code: "upstream_tool_schema_violation",
    },
    {
      label: "aggregate argument budget",
      fragments: ['{"query":"', "x".repeat(64), '"}'],
      maximumBytes: 48,
      code: "upstream_tool_arguments_too_large",
    },
    {
      label: "undeclared identity",
      fragments: ['{"query":"ok"}'],
      name: "other",
      code: "unknown_upstream_tool",
    },
  ])(
    "$label never becomes a completed call",
    async ({ label: _label, code, fragments, ...options }) => {
      const result = await transform(fragments, options);
      expect(result.failure).toMatchObject({ code });
      expect(result.emitted.some((event) => event.type === "completed")).toBe(false);
      if (code === "unknown_upstream_tool")
        expect(result.emitted.filter((event) => event.type === "tool_call_delta")).toHaveLength(0);
    },
  );
});

describe("declared tool schema validation", () => {
  test("rejects invalid values without coercion, defaults, or removing extra fields", () => {
    for (const value of [{ query: 1 }, {}, { query: "ok", extra: true }]) {
      const original = JSON.stringify(value);
      expect(() => validate("lookup", value)).toThrow("declared schema");
      expect(JSON.stringify(value)).toBe(original);
    }
    expect(() => validate("lookup", { query: "ok" })).not.toThrow();
  });

  test.each([
    "https://json-schema.org/draft/2019-09/schema",
    "https://json-schema.org/draft/2020-12/schema",
  ])("validates local references in %s", ($schema) => {
    const validator = toolOutputValidator([
      {
        name: "lookup",
        schema: {
          $schema,
          $defs: { args: schema },
          $ref: "#/$defs/args",
        },
      },
    ]);
    expect(() => validator("lookup", { query: "ok" })).not.toThrow();
    expect(() => validator("lookup", {})).toThrow("declared schema");
  });

  test.each([
    { $async: true },
    { $ref: "https://schemas.example.invalid/tool.json" },
    { type: "not-a-type" },
  ])("rejects schemas which cannot be validated before dispatch", (invalid) => {
    expect(() => toolOutputValidator([{ name: "lookup", schema: invalid }])).toThrow(
      "cannot be validated",
    );
  });

  test("rejects duplicate custom declarations and calls when tool_choice is none", () => {
    expect(() =>
      toolOutputValidator([
        { name: "custom", schema: {}, publicType: "custom" },
        { name: "custom", schema: {}, publicType: "custom" },
      ]),
    ).toThrow("cannot be validated");
    const disabled = toolOutputValidator([{ name: "lookup", schema }], false);
    expect(() => disabled.assertName("lookup")).toThrow("tool_choice=none");
  });
});

const item = {
  type: "function_call",
  id: "fc-1",
  call_id: "call-1",
  name: "lookup",
  arguments: '{"query":"ok"}',
  status: "completed",
};
const added = {
  type: "response.output_item.added",
  output_index: 0,
  item: { ...item, arguments: "", status: "in_progress" },
};
const delta = {
  type: "response.function_call_arguments.delta",
  output_index: 0,
  item_id: "fc-1",
  delta: item.arguments,
};
const done = {
  type: "response.function_call_arguments.done",
  output_index: 0,
  item_id: "fc-1",
  arguments: item.arguments,
};
const itemDone = { type: "response.output_item.done", output_index: 0, item };
function native() {
  return new NativeToolValidation(1_024, validate);
}

describe("native tool stream integrity", () => {
  test("validates exactly matching deltas, done and terminal output without changing events", () => {
    const validator = native();
    const events = [
      added,
      delta,
      done,
      itemDone,
      { type: "response.completed", response: { output: [item] } },
    ];
    const before = JSON.stringify(events);
    for (const event of events) validator.accept(event);
    expect(JSON.stringify(events)).toBe(before);
  });

  test.each([
    { label: "unannounced arguments", events: [delta] },
    { label: "unannounced completion", events: [itemDone] },
    { label: "duplicate identity", events: [added, added] },
    {
      label: "reused call ID",
      events: [added, { ...added, output_index: 1, item: { ...added.item, id: "fc-2" } }],
    },
    {
      label: "reused output index",
      events: [added, { ...added, item: { ...added.item, id: "fc-2", call_id: "call-2" } }],
    },
    { label: "changed index", events: [added, { ...delta, output_index: 1 }] },
    {
      label: "mismatching done arguments",
      events: [added, delta, { ...done, arguments: '{"query":"changed"}' }],
    },
    { label: "duplicate arguments done", events: [added, delta, done, done] },
    { label: "arguments after done", events: [added, delta, done, delta] },
    { label: "duplicate item done", events: [added, delta, itemDone, itemDone] },
    {
      label: "changed public identity",
      events: [added, { ...itemDone, item: { ...item, name: "other" } }],
    },
    {
      label: "missing final tool",
      events: [added, { type: "response.completed", response: { output: [] } }],
    },
    {
      label: "malformed JSON",
      events: [
        added,
        { ...done, arguments: "{" },
        { ...itemDone, item: { ...item, arguments: "{" } },
      ],
    },
    {
      label: "schema mismatch",
      events: [
        added,
        { ...done, arguments: '{"query":4}' },
        { ...itemDone, item: { ...item, arguments: '{"query":4}' } },
      ],
    },
    {
      label: "incomplete tool in a completed response",
      events: [
        added,
        { ...itemDone, item: { ...item, status: "incomplete" } },
        { type: "response.completed", response: { output: [item] } },
      ],
    },
  ])("rejects $label", ({ events }) => {
    const validator = native();
    expect(() => {
      for (const event of events) validator.accept(event);
    }).toThrow();
  });

  test("applies the aggregate byte budget before a growing delta is forwarded", () => {
    const validator = new NativeToolValidation(48, validate);
    validator.accept(added);
    expect(() => validator.accept({ ...delta, delta: "x".repeat(49) })).toThrow(
      "configured request-body budget",
    );
  });

  test("validates JSON response tools even without stream lifecycle events", () => {
    native().complete([item]);
    native().complete([{ ...item, status: undefined }]);
    expect(() => native().complete([{ ...item, status: "failed" }])).toThrow("incomplete tool");
    expect(() => native().complete([item, item])).toThrow("repeated");
    expect(() => native().complete([item, { ...item, id: "fc-2" }])).toThrow(
      "repeated a tool call",
    );
    expect(() => native().complete([{ ...item, arguments: "{}" }])).toThrow("declared schema");
    expect(() => native().complete([{ ...item, name: "other" }])).toThrow("undeclared");
  });
});
