import { crc32 } from "node:zlib";

export const IMAGE_COUNT = 14;

// A valid 1x1 PNG with an uncompressed ancillary text chunk. This keeps the
// regression deterministic and exercises real inline-image bytes, without
// retaining user screenshots or making the test depend on an image library.
function screenshotBytes(): Buffer {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
    "base64",
  );
  const text = Buffer.from(`fixture\0${"a".repeat(576 * 1024)}`);
  const chunk = Buffer.alloc(12 + text.length);
  chunk.writeUInt32BE(text.length, 0);
  chunk.write("tEXt", 4);
  text.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
}

export const screenshot = screenshotBytes();
const imageUrl = `data:image/png;base64,${screenshot.toString("base64")}`;
export const callIds = Array.from(
  { length: IMAGE_COUNT },
  (_, index) => `call-screenshot-${index}`,
);

export function codexBody(stream = false, imageCount = IMAGE_COUNT): string {
  return JSON.stringify({
    model: "gpt-5.6-sol",
    stream,
    store: false,
    input: [
      { role: "user", content: "Inspect the synthetic screenshots." },
      ...Array.from({ length: imageCount }, (_, index) => [
        {
          type: "function_call",
          call_id: `call-screenshot-${index}`,
          name: "view_image",
          arguments: JSON.stringify({ path: `fixture-${index}.png` }),
        },
        {
          type: "function_call_output",
          call_id: `call-screenshot-${index}`,
          output: [
            { type: "input_text", text: `Synthetic screenshot ${index}` },
            { type: "input_image", image_url: imageUrl },
          ],
        },
      ]).flat(),
      { role: "user", content: "Continue from the screenshot history." },
    ],
  });
}
