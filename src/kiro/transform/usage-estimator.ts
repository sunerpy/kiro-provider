import { createHash } from "node:crypto";
import { Tiktoken } from "js-tiktoken/lite";
import o200k from "js-tiktoken/ranks/o200k_base";
import { isRecord } from "../../protocol/adapter-utils.js";
import type { SdkPreparedRequest } from "../types.js";

let tokenizer: Tiktoken | undefined;
const tokenCounts = new Map<string, number>();
const MAX_CACHED_COUNTS = 256;

/** An estimate of model tokens, never a billing measurement. Cache no prompt text. */
export function estimateTextTokens(text: string): number {
  if (!text.length) return 0;
  const key = createHash("sha256").update(text).digest("hex");
  const cached = tokenCounts.get(key);
  if (cached !== undefined) {
    tokenCounts.delete(key);
    tokenCounts.set(key, cached);
    return cached;
  }
  tokenizer ??= new Tiktoken(o200k);
  const tokens = tokenizer.encode(text, [], []).length;
  tokenCounts.set(key, tokens);
  if (tokenCounts.size > MAX_CACHED_COUNTS) {
    const oldest = tokenCounts.keys().next().value;
    if (oldest !== undefined) tokenCounts.delete(oldest);
  }
  return tokens;
}

function bytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return Buffer.from(value, "base64");
  return undefined;
}

function dimensions(image: unknown): { width: number; height: number } | undefined {
  if (!isRecord(image) || !isRecord(image.source)) return undefined;
  const data = bytes(image.source.bytes);
  if (!data) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (image.format === "png" && data.length >= 24) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (image.format === "gif" && data.length >= 10) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (image.format === "jpeg" && data.length > 4) {
    let offset = 2;
    while (offset + 8 < data.length) {
      if (data[offset] !== 0xff) break;
      const marker = data[offset + 1];
      const length = view.getUint16(offset + 2);
      if (length < 2 || offset + 2 + length > data.length) break;
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return undefined;
}

/** Bounded vision estimate; do not tokenize base64 pixels as ordinary text. */
function imageTokens(image: unknown): number {
  const size = dimensions(image);
  if (!size || size.width <= 0 || size.height <= 0) return 1_445;
  let width = size.width;
  let height = size.height;
  const fit = Math.min(1, 2048 / Math.max(width, height));
  width *= fit;
  height *= fit;
  const short = Math.min(1, 768 / Math.min(width, height));
  width *= short;
  height *= short;
  return 85 + 170 * Math.ceil(width / 512) * Math.ceil(height / 512);
}

function opaqueTokens(value: unknown): number {
  const data = bytes(value);
  return data ? Math.ceil(data.byteLength / 4) : 0;
}

export function estimateReasoningTokens(value: unknown): number {
  if (!isRecord(value)) return 0;
  if (isRecord(value.reasoningText)) {
    return (
      estimateTextTokens(String(value.reasoningText.text ?? "")) +
      opaqueTokens(value.reasoningText.signature)
    );
  }
  return opaqueTokens(value.redactedContent);
}

function toolCallTokens(value: unknown): number {
  if (!isRecord(value)) return 0;
  return (
    estimateTextTokens(String(value.name ?? "")) +
    estimateTextTokens(
      typeof value.input === "string" ? value.input : JSON.stringify(value.input ?? {}),
    )
  );
}

function contentTokens(value: unknown): number {
  if (typeof value === "string") return estimateTextTokens(value);
  if (Array.isArray(value)) return value.reduce((sum, part) => sum + contentTokens(part), 0);
  if (!isRecord(value)) return 0;
  return (
    (typeof value.text === "string" ? estimateTextTokens(value.text) : 0) +
    (value.image !== undefined ? imageTokens(value.image) : 0)
  );
}

/** Count the projected model content, excluding profile, conversation IDs and credentials. */
export function estimateSdkInputTokens(
  request: Pick<SdkPreparedRequest, "conversationState" | "systemPrompt">,
): number {
  const state = request.conversationState;
  if (!state) return 0;
  let total = 3 + estimateTextTokens(request.systemPrompt ?? "");
  for (const message of [...(state.history ?? []), state.currentMessage]) {
    if (!message) continue;
    total += 4;
    if (message.userInputMessage) {
      const user = message.userInputMessage;
      total += contentTokens(user.content);
      for (const image of user.images ?? []) total += imageTokens(image);
      const context = user.userInputMessageContext;
      for (const tool of context?.tools ?? []) {
        if ("toolSpecification" in tool && tool.toolSpecification)
          total += estimateTextTokens(JSON.stringify(tool.toolSpecification));
      }
      for (const result of context?.toolResults ?? []) total += 4 + contentTokens(result.content);
    }
    if (message.assistantResponseMessage) {
      const assistant = message.assistantResponseMessage;
      total += contentTokens(assistant.content);
      for (const tool of assistant.toolUses ?? []) total += toolCallTokens(tool);
      total += estimateReasoningTokens(assistant.reasoningContent);
    }
  }
  return total;
}

export function estimateGeneratedTokens(
  text: string,
  calls: readonly { readonly name: string; readonly input: string }[] = [],
  reasoning?: unknown,
): { readonly outputTokens: number; readonly reasoningTokens: number } {
  const reasoningTokens = estimateReasoningTokens(reasoning);
  return {
    outputTokens:
      estimateTextTokens(text) +
      calls.reduce((sum, call) => sum + toolCallTokens(call), 0) +
      reasoningTokens,
    reasoningTokens,
  };
}
