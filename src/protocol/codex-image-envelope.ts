/** Codex's model-visible wrapper around one user-supplied image attachment. */
const CODEX_IMAGE_OPEN = /^<image name=\[Image #\d+\] path="[^"\r\n\0]+">$/u;
const CODEX_IMAGE_CLOSE = "</image>";

function partType(part: unknown): "text" | "image" | undefined {
  if (typeof part !== "object" || part === null) return undefined;
  const type = Reflect.get(part, "type");
  if (type === "text" || type === "input_text") return "text";
  if (type === "image" || type === "input_image") return "image";
  return undefined;
}

function partText(part: unknown): string | undefined {
  return typeof part === "object" && part !== null && typeof Reflect.get(part, "text") === "string"
    ? (Reflect.get(part, "text") as string)
    : undefined;
}

/**
 * Accept only the exact attachment envelope emitted by Codex:
 * `<image name=[Image #N] path="…">`, one image block, then `</image>`.
 * Every image in the message must have its own complete wrapper.
 */
export function isCodexImageEnvelope(parts: readonly unknown[]): boolean {
  let images = 0;
  let opens = 0;
  let closes = 0;
  for (const [index, part] of parts.entries()) {
    const type = partType(part);
    if (type === undefined) return false;
    if (type === "text") {
      const text = partText(part);
      if (text !== undefined && CODEX_IMAGE_OPEN.test(text)) opens += 1;
      if (text === CODEX_IMAGE_CLOSE) closes += 1;
      continue;
    }
    images += 1;
    const open = partText(parts[index - 1]);
    const close = partText(parts[index + 1]);
    if (open === undefined || !CODEX_IMAGE_OPEN.test(open) || close !== CODEX_IMAGE_CLOSE) {
      return false;
    }
  }
  return images > 0 && opens === images && closes === images;
}
