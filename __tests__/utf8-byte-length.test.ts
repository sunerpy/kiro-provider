import { describe, expect, spyOn, test } from "bun:test";
import { utf8AppendByteLength, utf8ByteLength } from "../src/core/utf8-byte-length.js";
import { collectSdkResponse } from "../src/kiro/transform/sdk-collector.js";
import {
  LocalStructuredOutputTextBuffer,
  parseLocalStructuredOutputProfile,
} from "../src/server/responses/structured-output.js";

describe("portable UTF-8 byte counting", () => {
  test.each([
    ["", 0],
    ["ASCII\u0000\u007f", 7],
    ["\u0080\u07ff", 4],
    ["\u0800\ud7ff\ue000\uffff", 12],
    ["中文", 6],
    ["😀", 4],
    ["\ud800\udc00\udbff\udfff", 8],
    ["\ud83d", 3],
    ["\ude00", 3],
    ["\ude00\ud83d", 6],
    ["\ud83d\ud83d\ude00", 7],
    ["\ud83dX\ude00", 7],
    ["A中😀\ud83d", 11],
  ] as const)("counts %j as %i bytes", (value, expected) => {
    expect(utf8ByteLength(value)).toBe(expected);
  });

  test.each([
    { chunks: ["\ud83d", "", "\ude00"], costs: [3, 0, 1], total: 4 },
    { chunks: ["\ud83d", "X", "\ude00"], costs: [3, 1, 3], total: 7 },
    { chunks: ["\ude00", "\ud83d"], costs: [3, 3], total: 6 },
    { chunks: ["\ud83d", "\ud83d\ude00"], costs: [3, 4], total: 7 },
    { chunks: ["😀\ud83d", "\ude00中", "!"], costs: [7, 4, 1], total: 12 },
  ])(
    "counts append costs across arbitrary chunk boundaries: $chunks",
    ({ chunks, costs, total }) => {
      let previous = "";
      let bytes = 0;
      for (const [index, chunk] of chunks.entries()) {
        const cost = utf8AppendByteLength(previous, chunk);
        const expectedCost = costs[index];
        if (expectedCost === undefined) throw new Error("Missing fixture append cost");
        expect(cost).toBe(expectedCost);
        bytes += cost;
        previous += chunk;
      }
      expect(bytes).toBe(total);
      expect(utf8ByteLength(previous)).toBe(total);
    },
  );
});

function titleProfile() {
  const result = parseLocalStructuredOutputProfile({
    format: {
      type: "json_schema",
      name: "codex_output_schema",
      strict: true,
      schema: {
        type: "object",
        properties: { title: { type: "string", minLength: 1, maxLength: 36 } },
        required: ["title"],
        additionalProperties: false,
      },
    },
  });
  if (result.kind !== "profile") throw new Error("Invalid fixture profile");
  return result.profile;
}

async function withWindowsSurrogateSizing(operation: () => void | Promise<void>): Promise<void> {
  const original = Buffer.byteLength;
  const sizing = spyOn(Buffer, "byteLength").mockImplementation((value, encoding) => {
    // Emulate platform-dependent sizing of isolated halves to reproduce the
    // Windows CI result (two joined bytes under the old subtraction algorithm).
    if (value === "\ud83d" || value === "\ude00") return 2;
    return original(value, encoding);
  });
  try {
    await operation();
  } finally {
    sizing.mockRestore();
  }
}

describe("structured output byte budget across runtimes", () => {
  test("streaming keeps a split emoji at four bytes despite Windows Buffer sizing", async () => {
    await withWindowsSurrogateSizing(() => {
      const buffer = new LocalStructuredOutputTextBuffer(titleProfile(), 4);
      expect(buffer.append("\ud83d")).toEqual({ ok: true });
      expect(buffer.append("")).toEqual({ ok: true });
      expect(buffer.append("\ude00")).toEqual({ ok: true });
      expect(buffer.byteLength).toBe(4);
      expect(buffer.complete()).toMatchObject({ ok: true, text: '{"title":"😀"}' });
    });
  });

  test("collector rejects the byte after a split emoji without reading further output", async () => {
    await withWindowsSurrogateSizing(async () => {
      let reads = 0;
      await expect(
        collectSdkResponse(
          {
            generateAssistantResponseResponse: (async function* () {
              for (const content of ["\ud83d", "", "\ude00", "!"]) {
                reads++;
                yield { assistantResponseEvent: { content } };
              }
              reads++;
              yield {
                metadataEvent: { tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
              };
            })(),
          },
          "gpt-5.6-sol",
          "synthetic-utf8-budget",
          undefined,
          {
            textLimit: {
              maxBytes: 4,
              code: "structured_output_buffer_exceeded",
              message: "Synthetic byte budget exceeded",
            },
          },
        ),
      ).rejects.toMatchObject({ code: "structured_output_buffer_exceeded" });
      expect(reads).toBe(4);
    });
  });
});
