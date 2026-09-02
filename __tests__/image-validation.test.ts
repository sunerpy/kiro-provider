import { describe, expect, test } from "bun:test";
import { RequestTransformError } from "../src/kiro/transform/errors.js";
import { transformToSdkRequest } from "../src/kiro/transform/request-sdk.js";
import type { CanonicalContentPart } from "../src/protocol/canonical.js";
import { adaptAnthropicMessagesRequest } from "../src/server/anthropic/request-adapter.js";
import { canonicalRequest, message, TEST_AUTH, textPart } from "./canonical-test-helpers.js";

const MODEL = "claude-sonnet-5";

function transformWithImage(image: CanonicalContentPart): () => void {
  return () =>
    transformToSdkRequest(
      canonicalRequest(
        [message("user", [textPart("inspect", "messages.0.content.0"), image], "messages.0")],
        { model: MODEL },
      ),
      MODEL,
      TEST_AUTH,
    );
}

function caught(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("image projection validation (B23)", () => {
  test("invalid base64 in an Anthropic-style image block is a typed transform error, not a DOMException", () => {
    const error = caught(
      transformWithImage({
        type: "image",
        mediaType: "image/png",
        data: "%%not-base64%%",
        path: "messages.0.content.1",
      }),
    );

    expect(error).toBeInstanceOf(RequestTransformError);
    expect(error).not.toBeInstanceOf(DOMException);
    expect(error).toMatchObject({
      code: "invalid_image_data",
      param: "messages.0.content.1",
    });
  });

  test("invalid base64 in a Responses data URL reports the image part path", () => {
    const error = caught(
      transformWithImage({
        type: "image",
        url: "data:image/png;base64,@@@",
        path: "input.0.content.1",
      }),
    );

    expect(error).toBeInstanceOf(RequestTransformError);
    expect(error).toMatchObject({ code: "invalid_image_data", param: "input.0.content.1" });
  });

  test("a data URL without a payload is rejected as invalid image data", () => {
    const error = caught(
      transformWithImage({
        type: "image",
        url: "data:image/png;base64",
        path: "input.0.content.1",
      }),
    );

    expect(error).toMatchObject({ code: "invalid_image_data", param: "input.0.content.1" });
  });

  test.each(["image/jpg", "image/svg+xml", "image/bmp", "text/plain"])(
    "media type %s is rejected because the Kiro SDK only accepts gif, jpeg, png, and webp",
    (mediaType) => {
      const anthropicStyle = caught(
        transformWithImage({
          type: "image",
          mediaType,
          data: "AQID",
          path: "messages.0.content.1",
        }),
      );
      const dataUrlStyle = caught(
        transformWithImage({
          type: "image",
          url: `data:${mediaType};base64,AQID`,
          path: "input.0.content.1",
        }),
      );

      expect(anthropicStyle).toMatchObject({
        code: "unsupported_image_media_type",
        param: "messages.0.content.1",
      });
      expect(dataUrlStyle).toMatchObject({
        code: "unsupported_image_media_type",
        param: "input.0.content.1",
      });
    },
  );

  test.each([
    ["image/gif", "gif"],
    ["image/jpeg", "jpeg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
  ] as const)("media type %s is projected to Kiro format %s", (mediaType, format) => {
    const prepared = transformToSdkRequest(
      canonicalRequest(
        [
          message(
            "user",
            [
              textPart("inspect", "messages.0.content.0"),
              { type: "image", mediaType, data: "AQID", path: "messages.0.content.1" },
            ],
            "messages.0",
          ),
        ],
        { model: MODEL },
      ),
      MODEL,
      TEST_AUTH,
    );
    const images = prepared.conversationState.currentMessage.userInputMessage?.images;

    expect(images?.[0]?.format).toBe(format);
    expect(Array.from(images?.[0]?.source.bytes ?? [])).toEqual([1, 2, 3]);
  });

  test("the Anthropic request adapter still accepts the image block and leaves validation to projection", () => {
    const adapted = adaptAnthropicMessagesRequest(
      {
        model: MODEL,
        max_tokens: 1_024,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpg", data: "AQID" } },
            ],
          },
        ],
      },
      { requireMaxTokens: true },
    );

    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    const error = caught(() => transformToSdkRequest(adapted.value.body, MODEL, TEST_AUTH));
    expect(error).toMatchObject({
      code: "unsupported_image_media_type",
      param: "messages.0.content.0",
    });
  });
});
