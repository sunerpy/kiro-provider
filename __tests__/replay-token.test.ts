import { describe, expect, test } from "bun:test";
import { createCipheriv, createHash } from "node:crypto";
import type { ReasoningReplayKeyring } from "../src/reasoning/keyring.js";
import {
  decodePortableReplayToken,
  encodePortableReplayToken as encodeReplayToken,
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
const provenance = {
  protocol: "responses",
  region: "us-east-1",
  profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/source",
  runtimeProtocol: "kiro-runtime",
  upstreamOperation: "GenerateAssistantResponse",
  issuedAt: 1_700_000_000_000,
  expiresAt: 1_700_086_400_000,
} as const;

function encodePortableReplayToken(
  capture: Parameters<typeof encodeReplayToken>[0],
  replayContext: Parameters<typeof encodeReplayToken>[1],
  replayOrigin: Parameters<typeof encodeReplayToken>[2],
  replayKey: Parameters<typeof encodeReplayToken>[4],
): string {
  return encodeReplayToken(capture, replayContext, replayOrigin, provenance, replayKey);
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}

function legacyV2Token(): { readonly token: string; readonly ring: ReasoningReplayKeyring } {
  const ring = keyring(key(9, "legacy-v2"));
  const nonce = Buffer.alloc(12, 7);
  const digest = (domain: string, value: string) =>
    createHash("sha256").update(`kiro-provider-replay-v2-${domain}\0`).update(value).digest();
  const header = Buffer.concat([
    Buffer.from([2, Buffer.byteLength(ring.active.id)]),
    Buffer.from(ring.active.id),
    digest("tenant", context.tenantId),
    digest("model", context.model),
    digest("output", context.outputFingerprint),
    nonce,
  ]);
  const envelope = Buffer.from(
    JSON.stringify({
      version: 2,
      ...origin,
      outputFingerprint: context.outputFingerprint,
      kind: "reasoning_text",
      text: "legacy reasoning",
      signature: "legacy signature",
    }),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(envelope.byteLength);
  const used = 4 + envelope.byteLength;
  const plaintext = Buffer.concat([
    length,
    envelope,
    Buffer.alloc(Math.ceil(used / 1024) * 1024 - used),
  ]);
  const cipher = createCipheriv("aes-256-gcm", ring.active.key, nonce);
  cipher.setAAD(
    Buffer.concat([
      lengthPrefixed("kiro-provider-reasoning-replay-v2"),
      lengthPrefixed("2"),
      lengthPrefixed(ring.active.id),
      lengthPrefixed(context.tenantId),
      lengthPrefixed(context.model),
      lengthPrefixed(context.outputFingerprint),
    ]),
  );
  return {
    token: `kr2_${Buffer.concat([header, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]).toString("base64url")}`,
    ring,
  };
}

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
      expect(decodePortableReplayToken(token, context, ring, provenance.issuedAt + 1)).toEqual({
        ...origin,
        keyId: ring.active.id,
        legacy: false,
        provenance,
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
    expect(
      decodePortableReplayToken(token, context, ring, provenance.issuedAt + 1).content,
    ).toEqual({
      kind: "redacted_content",
      bytes: Uint8Array.from([0, 1, 2, 255]),
    });
  });

  test("binds tenant, model, output and key rotation", () => {
    const old = key(3, "old");
    const current = key(4, "current");
    const token = encodePortableReplayToken({ text: "r", signature: "s" }, context, origin, old);
    const rotated = keyring(current, old);
    expect(decodePortableReplayToken(token, context, rotated, provenance.issuedAt + 1).keyId).toBe(
      "old",
    );
    for (const mismatch of [
      { ...context, tenantId: "tenant-b" },
      { ...context, model: "gpt-5.6-terra" },
      { ...context, outputFingerprint: "output-b" },
    ]) {
      expect(() =>
        decodePortableReplayToken(token, mismatch, rotated, provenance.issuedAt + 1),
      ).toThrow(PortableReplayTokenError);
    }
    expect(() =>
      decodePortableReplayToken(token, context, keyring(current), provenance.issuedAt + 1),
    ).toThrow("decryption key is unavailable");
  });

  test("authenticates mint provenance and enforces the absolute token lifetime", () => {
    const ring = keyring(key(8));
    const token = encodePortableReplayToken(
      { text: "r", signature: "s" },
      context,
      origin,
      ring.active,
    );
    const decoded = decodePortableReplayToken(token, context, ring, provenance.expiresAt - 1);
    expect(decoded).toMatchObject({
      legacy: false,
      provenance: {
        protocol: "responses",
        region: "us-east-1",
        profileArn: provenance.profileArn,
        runtimeProtocol: "kiro-runtime",
        upstreamOperation: "GenerateAssistantResponse",
        issuedAt: provenance.issuedAt,
        expiresAt: provenance.expiresAt,
      },
    });
    expect(() => decodePortableReplayToken(token, context, ring, provenance.expiresAt)).toThrow(
      "has expired",
    );
  });

  test("reads pre-release v2 envelopes only as legacy owner-bound material", () => {
    const { token, ring } = legacyV2Token();
    expect(decodePortableReplayToken(token, context, ring)).toEqual({
      ...origin,
      keyId: "legacy-v2",
      legacy: true,
      content: {
        kind: "reasoning_text",
        text: "legacy reasoning",
        signature: "legacy signature",
      },
    });
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
