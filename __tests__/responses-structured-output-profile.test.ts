import { describe, expect, test } from "bun:test";
import {
  enforceLocalStructuredOutput,
  LOCAL_STRUCTURED_OUTPUT_MAX_BUFFER_BYTES,
  type LocalStructuredOutputProfile,
  LocalStructuredOutputTextBuffer,
  parseLocalStructuredOutputProfile,
  validateLocalStructuredOutputRequestBoundary,
} from "../src/server/responses/structured-output.js";

const TITLE_FORMAT = {
  type: "json_schema",
  name: "codex_output_schema",
  strict: true,
  schema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        minLength: 1,
        maxLength: 36,
      },
    },
    required: ["title"],
    additionalProperties: false,
  },
} as const;

function textWithFormat(format: unknown): Record<string, unknown> {
  return { format };
}

function parseProfile(format: unknown = TITLE_FORMAT): LocalStructuredOutputProfile {
  const result = parseLocalStructuredOutputProfile(textWithFormat(format));
  if (result.kind !== "profile") {
    throw new Error(`expected profile, received ${result.kind}`);
  }
  return result.profile;
}

function expectRejected(format: unknown): void {
  const result = parseLocalStructuredOutputProfile(textWithFormat(format));
  expect(result).toMatchObject({
    kind: "rejected",
    code: "unsupported_structured_output",
    param: "text.format",
  });
}

describe("single-string-object-v1 profile parser", () => {
  test("accepts the exact Codex title schema without client-specific detection", () => {
    const result = parseLocalStructuredOutputProfile(textWithFormat(TITLE_FORMAT));
    expect(result).toEqual({
      kind: "profile",
      profile: {
        kind: "single-string-object-v1",
        formatName: "codex_output_schema",
        propertyName: "title",
        minLength: 1,
        maxLength: 36,
        requestedFormat: TITLE_FORMAT,
        schema: TITLE_FORMAT.schema,
      },
    });
    if (result.kind !== "profile") throw new Error("unreachable");
    expect(Object.isFrozen(result.profile.requestedFormat)).toBe(true);
    expect(Object.isFrozen(result.profile.schema)).toBe(true);
    expect(Object.isFrozen(result.profile.schema.properties)).toBe(true);
  });

  test.each([
    undefined,
    {},
    { verbosity: "low" },
    { format: undefined },
    { format: { type: "text" } },
  ])("leaves ordinary text handling unchanged for %p", (text) => {
    expect(parseLocalStructuredOutputProfile(text)).toEqual({ kind: "ordinary" });
  });

  test.each([
    { ...TITLE_FORMAT, strict: false },
    (({ strict: _strict, ...rest }) => rest)(TITLE_FORMAT),
    { ...TITLE_FORMAT, type: "json_object" },
    { ...TITLE_FORMAT, type: "text" },
    { ...TITLE_FORMAT, description: "not accepted in v1" },
    { ...TITLE_FORMAT, name: "" },
    { ...TITLE_FORMAT, name: "a".repeat(65) },
    { ...TITLE_FORMAT, name: "has space" },
    { ...TITLE_FORMAT, name: "has.dot" },
  ])("rejects an unsupported format envelope: %p", (format) => {
    expectRejected(format);
  });

  test.each([
    {
      ...TITLE_FORMAT.schema,
      properties: {
        title: TITLE_FORMAT.schema.properties.title,
        subtitle: TITLE_FORMAT.schema.properties.title,
      },
      required: ["title", "subtitle"],
    },
    { ...TITLE_FORMAT.schema, required: [] },
    { ...TITLE_FORMAT.schema, required: ["other"] },
    { ...TITLE_FORMAT.schema, required: ["title", "title"] },
    (({ additionalProperties: _additionalProperties, ...rest }) => rest)(TITLE_FORMAT.schema),
    { ...TITLE_FORMAT.schema, additionalProperties: true },
    { ...TITLE_FORMAT.schema, description: "unknown root keyword" },
    { ...TITLE_FORMAT.schema, $async: true },
    { ...TITLE_FORMAT.schema, $schema: "http://json-schema.org/draft-07/schema#" },
    { ...TITLE_FORMAT.schema, $ref: "https://example.invalid/schema.json" },
    { ...TITLE_FORMAT.schema, $defs: {} },
    { ...TITLE_FORMAT.schema, anyOf: [] },
    { ...TITLE_FORMAT.schema, oneOf: [] },
    { ...TITLE_FORMAT.schema, allOf: [] },
    { ...TITLE_FORMAT.schema, not: {} },
  ])("rejects an unsupported root schema: %p", (schema) => {
    expectRejected({ ...TITLE_FORMAT, schema });
  });

  test.each([
    { type: "string", maxLength: 36 },
    { type: "string", minLength: 1 },
    { type: "string", minLength: 0, maxLength: 36 },
    { type: "string", minLength: 37, maxLength: 36 },
    { type: "string", minLength: 1, maxLength: 257 },
    { type: "string", minLength: 1.5, maxLength: 36 },
    { type: "string", minLength: 1, maxLength: Number.MAX_SAFE_INTEGER + 1 },
    { type: "object", minLength: 1, maxLength: 36 },
    { type: "array", minLength: 1, maxLength: 36 },
    { type: "string", minLength: 1, maxLength: 36, enum: ["x"] },
    { type: "string", minLength: 1, maxLength: 36, const: "x" },
    { type: "string", minLength: 1, maxLength: 36, pattern: ".*" },
    { type: "string", minLength: 1, maxLength: 36, format: "uri" },
    { type: "string", minLength: 1, maxLength: 36, default: "x" },
    { type: "string", minLength: 1, maxLength: 36, description: "unknown property keyword" },
  ])("rejects an unsupported property schema: %p", (propertySchema) => {
    expectRejected({
      ...TITLE_FORMAT,
      schema: {
        ...TITLE_FORMAT.schema,
        properties: { title: propertySchema },
      },
    });
  });

  test.each([
    "1title",
    "with-dash",
    "has space",
    "a".repeat(65),
    "__proto__",
    "prototype",
    "constructor",
  ])("rejects unsafe property name %s", (propertyName) => {
    expectRejected({
      ...TITLE_FORMAT,
      schema: {
        ...TITLE_FORMAT.schema,
        properties: { [propertyName]: TITLE_FORMAT.schema.properties.title },
        required: [propertyName],
      },
    });
  });
});

describe("single-string-object-v1 local envelope", () => {
  test.each([
    ["修复 KiroCodex 标题", '{"title":"修复 KiroCodex 标题"}'],
    ['  {"title":"已经封装"}  ', '{"title":"已经封装"}'],
    ['  "JSON string"  ', '{"title":"JSON string"}'],
    ['  引号 " 反斜杠 \\ 换行\n  ', '{"title":"引号 \\" 反斜杠 \\\\ 换行"}'],
    ['```json\n{"title":"围栏 JSON"}\n```', '{"title":"围栏 JSON"}'],
    ["  ```\r\n围栏纯文本\r\n```  ", '{"title":"围栏纯文本"}'],
    [
      '```json\n{"title":"a"}\n```\n结尾',
      JSON.stringify({ title: '```json\n{"title":"a"}\n```\n结尾' }),
    ],
  ])("enforces and JSON-escapes %p", (visibleText, expected) => {
    const result = enforceLocalStructuredOutput(parseProfile(), visibleText);
    expect(result).toMatchObject({ ok: true, text: expected });
    if (!result.ok) throw new Error("unreachable");
    expect(JSON.parse(result.text)).toEqual({ title: JSON.parse(expected).title });
    expect(Object.getPrototypeOf(result.value)).toBeNull();
  });

  test("counts and truncates by Unicode code point", () => {
    const profile = parseProfile({
      ...TITLE_FORMAT,
      schema: {
        ...TITLE_FORMAT.schema,
        properties: { title: { type: "string", minLength: 1, maxLength: 2 } },
      },
    });
    expect(enforceLocalStructuredOutput(profile, "😀中A")).toMatchObject({
      ok: true,
      text: '{"title":"😀中"}',
      truncated: true,
    });
  });

  test("preserves 36 CJK code points and truncates the 37th", () => {
    const profile = parseProfile();
    expect(enforceLocalStructuredOutput(profile, "中".repeat(36))).toMatchObject({
      ok: true,
      text: `{"title":"${"中".repeat(36)}"}`,
      truncated: false,
    });
    expect(enforceLocalStructuredOutput(profile, `${"中".repeat(36)}界`)).toMatchObject({
      ok: true,
      text: `{"title":"${"中".repeat(36)}"}`,
      truncated: true,
    });
  });

  test.each([
    "",
    " \n\t ",
    "null",
    "42",
    "true",
    "[]",
    "{}",
    '{"wrong":"x"}',
    '{"title":"x","extra":true}',
    '{"title":42}',
  ])("fails closed for an unusable parsed value %p", (visibleText) => {
    expect(enforceLocalStructuredOutput(parseProfile(), visibleText)).toEqual({
      ok: false,
      code: "structured_output_validation_failed",
      message: "Upstream output could not satisfy the local structured output profile",
      param: "text.format",
    });
  });

  test("does not double-wrap a schema-valid object", () => {
    const result = enforceLocalStructuredOutput(parseProfile(), '{"title":"once"}');
    expect(result).toMatchObject({ ok: true, text: '{"title":"once"}' });
  });

  test("cannot mutate Object.prototype", () => {
    const before = Reflect.get(Object.prototype, "polluted");
    const result = enforceLocalStructuredOutput(parseProfile(), "safe");
    expect(result).toMatchObject({ ok: true, text: '{"title":"safe"}' });
    expect(Reflect.get(Object.prototype, "polluted")).toBe(before);
  });

  test("rejects a complete non-stream payload above the UTF-8 byte limit", () => {
    expect(
      enforceLocalStructuredOutput(
        parseProfile(),
        "中".repeat(Math.floor(LOCAL_STRUCTURED_OUTPUT_MAX_BUFFER_BYTES / 3) + 1),
      ),
    ).toEqual({
      ok: false,
      code: "structured_output_buffer_exceeded",
      message: "Upstream output exceeded the local structured output buffer limit",
      param: "text.format",
    });
  });
});

describe("streaming local structured output buffer", () => {
  test("buffers raw deltas and only returns the validated JSON at completion", () => {
    const buffer = new LocalStructuredOutputTextBuffer(parseProfile());
    expect(buffer.append("修复 ")).toEqual({ ok: true });
    expect(buffer.append("标题")).toEqual({ ok: true });
    expect(buffer.complete()).toMatchObject({ ok: true, text: '{"title":"修复 标题"}' });
  });

  test("ignores zero-byte deltas", () => {
    const buffer = new LocalStructuredOutputTextBuffer(parseProfile());
    expect(buffer.append("")).toEqual({ ok: true });
    expect(buffer.byteLength).toBe(0);
    expect(buffer.append("title")).toEqual({ ok: true });
    expect(buffer.complete()).toMatchObject({ ok: true, text: '{"title":"title"}' });
  });

  test("enforces the byte limit across chunk boundaries", () => {
    const buffer = new LocalStructuredOutputTextBuffer(parseProfile(), 4);
    expect(buffer.append("1234")).toEqual({ ok: true });
    expect(buffer.append("5")).toEqual({
      ok: false,
      code: "structured_output_buffer_exceeded",
      message: "Upstream output exceeded the local structured output buffer limit",
      param: "text.format",
    });
    expect(buffer.complete()).toEqual({
      ok: false,
      code: "structured_output_buffer_exceeded",
      message: "Upstream output exceeded the local structured output buffer limit",
      param: "text.format",
    });
  });

  test("counts an emoji split at a UTF-16 surrogate boundary as four UTF-8 bytes", () => {
    const buffer = new LocalStructuredOutputTextBuffer(parseProfile(), 4);
    expect(buffer.append("\ud83d")).toEqual({ ok: true });
    expect(buffer.append("\ude00")).toEqual({ ok: true });
    expect(buffer.byteLength).toBe(4);
  });

  test("dispose drops buffered content and prevents a successful completion", () => {
    const buffer = new LocalStructuredOutputTextBuffer(parseProfile());
    expect(buffer.append("secret upstream text")).toEqual({ ok: true });
    buffer.dispose();
    expect(buffer.complete()).toMatchObject({
      ok: false,
      code: "structured_output_validation_failed",
    });
  });
});

describe("single-string-object-v1 request boundary", () => {
  const base = {
    model: "gpt-5.6-sol",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "task" }] }],
    tools: [],
    tool_choice: "auto",
    store: false,
    stream: true,
    reasoning: { effort: "max" },
    include: ["reasoning.encrypted_content"],
    client_metadata: { thread_id: "not-used-for-recognition" },
    text: { format: TITLE_FORMAT },
  };

  test.each([
    base,
    { ...base, store: undefined },
    { ...base, input: "plain text", tool_choice: "none", tools: undefined },
  ])("accepts one-shot text-only metadata requests", (request) => {
    expect(validateLocalStructuredOutputRequestBoundary(request)).toEqual({ ok: true });
  });

  test.each([
    [{ ...base, store: true }, "store"],
    [{ ...base, previous_response_id: "resp_previous" }, "previous_response_id"],
    [{ ...base, conversation: "conv" }, "conversation"],
    [{ ...base, background: true }, "background"],
    [{ ...base, tools: "invalid" }, "tools"],
    [{ ...base, tool_choice: "required" }, "tool_choice"],
    [{ ...base, input: [{ type: "additional_tools", tools: "invalid" }] }, "input.0"],
    [{ ...base, input: [{ type: "function_call", call_id: "c" }] }, "input.0"],
    [{ ...base, input: [{ type: "function_call_output", call_id: "c" }] }, "input.0"],
    [{ ...base, input: [{ type: "reasoning", encrypted_content: "opaque" }] }, "input.0"],
    [
      {
        ...base,
        input: [{ type: "message", role: "user", content: [{ type: "input_image" }] }],
      },
      "input.0.content.0",
    ],
    [
      {
        ...base,
        input: [{ type: "message", role: "user", content: [{ type: "input_file" }] }],
      },
      "input.0.content.0",
    ],
    [{ ...base, input: [{ type: "future_item" }] }, "input.0"],
  ])("rejects out-of-profile request semantics at %s", (entry, expectedParam) => {
    expect(validateLocalStructuredOutputRequestBoundary(entry)).toMatchObject({
      ok: false,
      code: "unsupported_response_semantics",
      param: expectedParam,
    });
  });
});

describe("Unicode and malformed JSON normalization", () => {
  test("trims Unicode White_Space plus BOM at both boundaries", () => {
    expect(
      enforceLocalStructuredOutput(
        parseProfile(),
        "\uFEFF\u0085\u00A0\u3000title\u3000\u00A0\u0085\uFEFF",
      ),
    ).toMatchObject({ ok: true, text: '{"title":"title"}' });
  });

  test.each([
    ['{"title":"x",}', '{"title":"{\\"title\\":\\"x\\",}"}'],
    ["[broken", '{"title":"[broken"}'],
  ])("wraps malformed JSON-looking output %p as the raw candidate", (text, expected) => {
    expect(enforceLocalStructuredOutput(parseProfile(), text)).toMatchObject({
      ok: true,
      text: expected,
    });
  });
});
