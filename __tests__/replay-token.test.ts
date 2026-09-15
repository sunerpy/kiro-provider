import { describe, expect, test } from "bun:test";
import type { ReasoningReplayKeyring } from "../src/reasoning/keyring.js";
import {
  decodePortableReplayToken,
  encodePortableReplayToken,
  isProviderReplayToken,
  MAX_PORTABLE_REPLAY_TOKEN_BYTES,
  PortableReplayTokenError,
} from "../src/reasoning/replay-token.js";

function key(byte: number, id = `key-${byte}`) {
  return { id, key: Uint8Array.from(Buffer.alloc(32, byte)) };
}

function keyring(...keys: ReturnType<typeof key>[]): ReasoningReplayKeyring {
  const active = keys[0];
  if (!active) throw new TypeError("missing active key");
  return { active, byId: new Map(keys.map((entry) => [entry.id, entry])), source: "environment" };
}

const context = {
  tenantId: "tenant-a",
  model: "gpt-5.6-sol",
  outputFingerprint: "output-a",
} as const;
const origin = { accountId: "account-a", conversationId: "conversation-a" } as const;

describe("portable reasoning replay tokens", () => {
  test("round-trips signed text, including an empty thinking block", () => {
    const ring = keyring(key(1));
    for (const text of ["private reasoning", ""]) {
      const token = encodePortableReplayToken(
        { text, signature: "native-signature" },
        context,
        origin,
        ring.active,
      );
      expect(token).toStartWith("kr2_");
      expect(isProviderReplayToken(token)).toBe(true);
      expect(decodePortableReplayToken(token, context, ring)).toEqual({
        ...origin,
        keyId: ring.active.id,
        content: { kind: "reasoning_text", text, signature: "native-signature" },
      });
    }
  });

  test("round-trips redacted bytes and keeps origins encrypted", () => {
    const ring = keyring(key(2));
    const token = encodePortableReplayToken(
      { text: "", redactedContent: Uint8Array.from([0, 1, 2, 255]) },
      context,
      origin,
      ring.active,
    );
    expect(token).not.toContain(origin.accountId);
    expect(token).not.toContain(origin.conversationId);
    expect(decodePortableReplayToken(token, context, ring).content).toEqual({
      kind: "redacted_content",
      bytes: Uint8Array.from([0, 1, 2, 255]),
    });
  });

  test("binds tenant, model, output and key rotation", () => {
    const old = key(3, "old");
    const current = key(4, "current");
    const token = encodePortableReplayToken({ text: "r", signature: "s" }, context, origin, old);
    const rotated = keyring(current, old);
    expect(decodePortableReplayToken(token, context, rotated).keyId).toBe("old");
    for (const mismatch of [
      { ...context, tenantId: "tenant-b" },
      { ...context, model: "gpt-5.6-terra" },
      { ...context, outputFingerprint: "output-b" },
    ]) {
      expect(() => decodePortableReplayToken(token, mismatch, rotated)).toThrow(
        PortableReplayTokenError,
      );
    }
    expect(() => decodePortableReplayToken(token, context, keyring(current))).toThrow(
      "decryption key is unavailable",
    );
  });

  test("rejects tampering, mixed content and oversized wire input", () => {
    const ring = keyring(key(5));
    const token = encodePortableReplayToken(
      { text: "r", signature: "s" },
      context,
      origin,
      ring.active,
    );
    const last = token.at(-1);
    const tampered = `${token.slice(0, -1)}${last === "A" ? "B" : "A"}`;
    expect(() => decodePortableReplayToken(tampered, context, ring)).toThrow(
      PortableReplayTokenError,
    );
    expect(() =>
      encodePortableReplayToken(
        { text: "r", signature: "s", redactedContent: Uint8Array.of(1) },
        context,
        origin,
        ring.active,
      ),
    ).toThrow("cannot mix");
    expect(() =>
      decodePortableReplayToken(
        `kr2_${"A".repeat(MAX_PORTABLE_REPLAY_TOKEN_BYTES)}`,
        context,
        ring,
      ),
    ).toThrow("wire-size");
  });

  test("pads ciphertext into fixed 1 KiB buckets", () => {
    const ring = keyring(key(6));
    const short = encodePortableReplayToken(
      { text: "a", signature: "s" },
      context,
      origin,
      ring.active,
    );
    const nearby = encodePortableReplayToken(
      { text: "a".repeat(100), signature: "s" },
      context,
      origin,
      ring.active,
    );
    expect(short.length).toBe(nearby.length);
  });

  test("bounds long reasoning wire growth and rejects oversized plaintext before encryption", () => {
    const ring = keyring(key(7));
    const realistic = encodePortableReplayToken(
      { text: "r".repeat(70_000), signature: "s".repeat(256) },
      context,
      origin,
      ring.active,
    );
    expect(Buffer.byteLength(realistic)).toBeLessThan(100_000);
    expect(() =>
      encodePortableReplayToken(
        { text: "r".repeat(3_000_001), signature: "s" },
        context,
        origin,
        ring.active,
      ),
    ).toThrow("wire-size");
  });
});
