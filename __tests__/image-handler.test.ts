import { describe, expect, test } from "bun:test";
import { RequestTransformError } from "../src/kiro/transform/errors.js";
import { convertImagesToKiroFormat } from "../src/kiro/transform/image-handler.js";

const HELLO_B64 = "SGVsbG8=";
const HELLO_BYTES = [72, 101, 108, 108, 111];

describe("convertImagesToKiroFormat", () => {
  test("decodes base64 to exact byte values and derives format from media type", () => {
    const result = convertImagesToKiroFormat([{ mediaType: "image/png", data: HELLO_B64 }]);
    expect(result.omitted).toBe(0);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.format).toBe("png");
    expect(Array.from(result.images[0]?.source.bytes ?? [])).toEqual(HELLO_BYTES);
    expect(result.images[0]?.source.bytes).toBeInstanceOf(Uint8Array);
  });
  test.each(["image", "image/jpg", "image/svg+xml", "application/pdf", ""])(
    "rejects media type %p instead of guessing a Kiro format",
    (mediaType) => {
      let caught: unknown;
      try {
        convertImagesToKiroFormat([{ mediaType, data: HELLO_B64, path: "messages.0.content.1" }]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RequestTransformError);
      expect(caught).toMatchObject({
        code: "unsupported_image_media_type",
        param: "messages.0.content.1",
      });
    },
  );
  test("accepts the four SDK formats case-insensitively", () => {
    expect(
      convertImagesToKiroFormat([
        { mediaType: "image/GIF", data: HELLO_B64 },
        { mediaType: "image/jpeg", data: HELLO_B64 },
        { mediaType: "image/png", data: HELLO_B64 },
        { mediaType: "image/webp", data: HELLO_B64 },
      ]).images.map((image) => image.format),
    ).toEqual(["gif", "jpeg", "png", "webp"]);
  });
  test.each(["not base64!", "A", ""])(
    "rejects invalid base64 %p with a transform error instead of a DOMException",
    (data) => {
      let caught: unknown;
      try {
        convertImagesToKiroFormat([{ mediaType: "image/png", data, path: "input.0.content.2" }]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RequestTransformError);
      expect(caught).not.toBeInstanceOf(DOMException);
      expect(caught).toMatchObject({ code: "invalid_image_data", param: "input.0.content.2" });
    },
  );
  test("caps at 4 images and reports the omitted count", () => {
    const result = convertImagesToKiroFormat(
      Array.from({ length: 6 }, () => ({ mediaType: "image/png", data: HELLO_B64 })),
    );
    expect(result.images).toHaveLength(4);
    expect(result.omitted).toBe(2);
  });
  test("stops before exceeding the total byte budget", () => {
    const big = "A".repeat(2_000_000);
    const result = convertImagesToKiroFormat([
      { mediaType: "image/png", data: big },
      { mediaType: "image/png", data: big },
    ]);
    expect(result.images).toHaveLength(1);
    expect(result.omitted).toBe(1);
  });
  test("empty input yields no images and zero omitted", () => {
    expect(convertImagesToKiroFormat([])).toEqual({ images: [], omitted: 0 });
  });
});
