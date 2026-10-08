/** Synthetic color/marker probe of model-observed order, including signed replay. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { workingDirectoryHash } from "../src/protocol/client-normalization.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
function assert(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
function colorPng(red: number, green: number, blue: number): string {
  const chunk = (name: string, data: Buffer): Buffer => {
    const payload = Buffer.concat([Buffer.from(name), data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, payload, checksum]);
  };
  const width = 128,
    height = 128;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      pixels[offset] = red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = blue;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}
async function main() {
  const base = new URL(option("--base-url") ?? "http://invalid");
  assert(
    base.protocol === "http:" && base.hostname === "127.0.0.1" && base.port && base.port !== "8787",
    "isolated_gateway_required",
  );
  const config = option("--provider-config"),
    out = option("--out");
  assert(
    config && out && !resolve(out).startsWith(`${resolve(import.meta.dir, "..")}/`),
    "external_evidence_and_config_required",
  );
  const key = JSON.parse(readFileSync(config, "utf8")).api_keys[0];
  const rows: Array<Record<string, unknown>> = [];
  const image = (data: string) => ({
    type: "image",
    source: { type: "base64", media_type: "image/png", data },
  });
  const initial = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Read all content blocks in their encounter order. Classify images only by dominant color. First solve 5 mod 17, 7 mod 19, 11 mod 23, 13 mod 29 to engage signed reasoning. Then output ONLY a JSON array of marker letters and image colors, starting at this marker: A",
        },
        image(colorPng(255, 0, 0)),
        { type: "text", text: "B" },
        image(colorPng(0, 0, 255)),
        {
          type: "text",
          text: "C. End of blocks. Output their order as a JSON array, omitting all instructions and using uppercase image colors.",
        },
      ],
    },
  ];
  const withToolPrefix = process.argv.includes("--tool-result-prefix");
  const imageContent = initial[0]?.content;
  assert(imageContent, "invalid_block_sequence");
  const tools = withToolPrefix
    ? [
        {
          name: "FixtureMarker",
          description: "Return the synthetic marker requested by this order probe",
          input_schema: { type: "object", properties: {}, additionalProperties: false },
        },
      ]
    : [];
  async function generate(model: string, stream: boolean, messages: unknown[]) {
    const response = await fetch(new URL("/v1/messages", base), {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "x-kiro-client-normalization": "claude-code-bash-v1",
        "x-kiro-working-directory-hash": workingDirectoryHash("/isolated/image-order"),
      },
      body: JSON.stringify({
        model,
        stream,
        max_tokens: 16000,
        thinking: { type: "adaptive", display: "omitted" },
        output_config: { effort: "max" },
        ...(tools.length ? { tools } : {}),
        messages,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    if (!response.ok) {
      const code = "upstream_rejected";
      rows.push({
        model,
        stream,
        replay: messages.length > 1,
        status: response.status,
        code,
        pass: false,
      });
      writeFileSync(out as string, JSON.stringify({ schema_version: 1, rows }, null, 2));
      throw new Error(code);
    }
    if (!stream) return JSON.parse(text).content as Array<Record<string, unknown>>;
    const blocks: Array<Record<string, unknown>> = [];
    const toolInputs = new Map<number, string>();
    let stopped = 0;
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: {")) continue;
      const event = JSON.parse(line.slice(6));
      assert(event.type !== "error", "stream_error");
      if (event.type === "content_block_start") blocks[event.index] = { ...event.content_block };
      if (event.type === "content_block_delta") {
        const block = blocks[event.index];
        assert(block, "invalid_block_sequence");
        for (const field of ["text", "thinking", "signature"])
          if (typeof event.delta[field] === "string")
            block[field] = String(block[field] ?? "") + event.delta[field];
        if (typeof event.delta.partial_json === "string")
          toolInputs.set(
            event.index,
            (toolInputs.get(event.index) ?? "") + event.delta.partial_json,
          );
      }
      if (event.type === "message_stop") stopped++;
    }
    assert(stopped === 1, "invalid_terminal_count");
    for (const [index, input] of toolInputs) {
      const block = blocks[index];
      assert(block?.type === "tool_use", "invalid_block_sequence");
      block.input = JSON.parse(input);
    }
    return blocks;
  }
  for (const model of (option("--models") ?? "claude-opus-5-5,claude-fable-5-1").split(","))
    for (const stream of [false, true]) {
      let input: unknown[] = initial;
      if (withToolPrefix) {
        const seed = [
          {
            role: "user",
            content:
              "First solve 5 mod 17, 7 mod 19, 11 mod 23, 13 mod 29 to engage signed reasoning. Then call FixtureMarker exactly once with an empty object. The tool result and direct image blocks will arrive in the next user message. Do not answer the image-order task yet.",
          },
        ];
        const output = await generate(model, stream, seed);
        const calls = output.filter((block) => block.type === "tool_use");
        assert(
          calls.length === 1 && calls[0]?.name === "FixtureMarker",
          "tool_prefix_seed_unproven",
        );
        input = [
          ...seed,
          { role: "assistant", content: output },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: calls[0]?.id,
                content: "Synthetic marker tool completed.",
              },
              ...imageContent,
            ],
          },
        ];
      }
      const first = await generate(model, stream, input);
      for (const [replay, content] of [
        [false, first],
        [
          true,
          await generate(model, stream, [
            ...input,
            { role: "assistant", content: first },
            {
              role: "user",
              content:
                "Repeat only the JSON order array from the preceding image blocks. Preserve every marker and image position.",
            },
          ]),
        ],
      ] as const) {
        const text = content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("")
          .replace(/\s/g, "");
        const row = {
          model,
          stream,
          replay,
          scenario: withToolPrefix ? "tool-result-prefix" : "direct-image-runs",
          order_preserved: text === '["A","RED","B","BLUE","C"]',
          signed_thinking: first.some(
            (b) => b.type === "thinking" && String(b.signature).startsWith("kr2_"),
          ),
          pass:
            text === '["A","RED","B","BLUE","C"]' &&
            first.some((b) => b.type === "thinking" && String(b.signature).startsWith("kr2_")),
        };
        rows.push(row);
        writeFileSync(out, JSON.stringify({ schema_version: 1, rows }, null, 2));
        process.stdout.write(`${JSON.stringify(row)}\n`);
        assert(row.pass, "image_order_or_signed_replay_unproven");
      }
    }
}
void main().catch((error) => {
  const allowed = new Set([
    "isolated_gateway_required",
    "external_evidence_and_config_required",
    "upstream_rejected",
    "stream_error",
    "invalid_block_sequence",
    "invalid_terminal_count",
    "image_order_or_signed_replay_unproven",
    "tool_prefix_seed_unproven",
  ]);
  process.stderr.write(
    `${JSON.stringify({ pass: false, code: error instanceof Error && allowed.has(error.message) ? error.message : "probe_failed" })}\n`,
  );
  process.exitCode = 1;
});
