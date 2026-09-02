import { describe, expect, test } from "bun:test";
import { resolveInlineDocument, toKiroDocument } from "../src/kiro/transform/document-handler.js";
import { RequestTransformError } from "../src/kiro/transform/errors.js";

describe("native Kiro document projection", () => {
  test("keeps the original filename in canonical input and moves its extension to format", () => {
    const document = resolveInlineDocument(
      "marker.TXT",
      "data:text/plain;base64,bWFya2Vy",
      "input.0.content.0.file_data",
      "input.0.content.0.filename",
    );

    expect(document.name).toBe("marker.TXT");
    expect(toKiroDocument(document)).toEqual({
      name: "marker",
      format: "txt",
      source: {
        bytes: new Uint8Array([109, 97, 114, 107, 101, 114]),
      },
    });
  });

  test("accepts an ASCII native name without an extension when media type supplies the format", () => {
    const document = resolveInlineDocument(
      "meeting notes",
      "data:text/plain;base64,SGVsbG8=",
      "input.0.content.0.file_data",
      "input.0.content.0.filename",
    );

    expect(toKiroDocument(document).name).toBe("meeting notes");
    expect(toKiroDocument(document).format).toBe("txt");
  });

  test("rejects lossy filename rewrites instead of silently sanitizing them", () => {
    for (const filename of [
      "report.v1.txt",
      "会议记录.txt",
      " leading.txt",
      "trailing .txt",
      "double  space.txt",
      `${"a".repeat(201)}.txt`,
    ]) {
      expect(() =>
        resolveInlineDocument(
          filename,
          "data:text/plain;base64,SGVsbG8=",
          "input.0.content.0.file_data",
          "input.0.content.0.filename",
        ),
      ).toThrow(RequestTransformError);

      try {
        resolveInlineDocument(
          filename,
          "data:text/plain;base64,SGVsbG8=",
          "input.0.content.0.file_data",
          "input.0.content.0.filename",
        );
      } catch (error) {
        expect(error).toBeInstanceOf(RequestTransformError);
        expect((error as RequestTransformError).code).toBe("invalid_file_name");
        expect((error as RequestTransformError).param).toBe("input.0.content.0.filename");
      }
    }
  });

  test("rejects unsupported formats and malformed inline encodings", () => {
    for (const [filename, data, code] of [
      ["archive.bin", "SGVsbG8=", "unsupported_file_format"],
      ["notes.txt", "data:text/plain;base64", "invalid_file_data"],
      ["notes.txt", "data:text/plain,hello", "unsupported_file_encoding"],
      ["notes.txt", "", "invalid_file_data"],
      ["notes.txt", "%%%", "invalid_file_data"],
    ] as const) {
      try {
        resolveInlineDocument(
          filename,
          data,
          "input.0.content.0.file_data",
          "input.0.content.0.filename",
        );
        throw new Error(`Expected ${code}`);
      } catch (error) {
        expect(error).toBeInstanceOf(RequestTransformError);
        expect((error as RequestTransformError).code).toBe(code);
      }
    }
  });

  test("accepts raw base64 and validates manually constructed canonical documents", () => {
    const document = resolveInlineDocument(
      "notes.txt",
      "SGVsbG8=",
      "input.0.content.0.file_data",
      "input.0.content.0.filename",
    );
    expect(toKiroDocument(document).source.bytes).toEqual(new Uint8Array([72, 101, 108, 108, 111]));

    expect(() =>
      toKiroDocument({
        name: "bad.name.txt",
        format: "txt",
        data: "SGVsbG8=",
        path: "messages.0.content.0",
      }),
    ).toThrow(RequestTransformError);
    expect(() =>
      toKiroDocument({
        name: "notes.txt",
        format: "txt",
        data: "%%%",
        path: "messages.0.content.0",
      }),
    ).toThrow(RequestTransformError);
  });
});
