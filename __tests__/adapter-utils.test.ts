import { describe, expect, test } from "bun:test";
import { isRecord, textPart } from "../src/protocol/adapter-utils.js";
import { allowedKeysValidator } from "../src/server/protocol/adaptation.js";

describe("adapter-utils", () => {
  test("isRecord accepts plain objects and rejects arrays, null, and primitives", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("text")).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });

  test("textPart records the text and its source path", () => {
    expect(textPart("hello", "messages.0.content")).toEqual({
      type: "text",
      text: "hello",
      path: "messages.0.content",
    });
  });
});

describe("allowedKeysValidator", () => {
  const validate = allowedKeysValidator("Responses field");

  test("accepts values whose keys are all allowed", () => {
    expect(validate({ type: "text", text: "x" }, "input.0", new Set(["type", "text"]))).toEqual({
      ok: true,
      value: undefined,
    });
  });

  test("fails closed on the first unknown key with the protocol label and param", () => {
    expect(
      validate({ type: "text", extra: 1, other: 2 }, "input.0", new Set(["type", "text"])),
    ).toEqual({
      ok: false,
      code: "unsupported_parameter",
      message: "Responses field input.0.extra is not supported",
      param: "input.0.extra",
    });
    expect(allowedKeysValidator("Chat field")({ bad: true }, "messages.1", new Set())).toMatchObject({
      message: "Chat field messages.1.bad is not supported",
      param: "messages.1.bad",
    });
  });
});
