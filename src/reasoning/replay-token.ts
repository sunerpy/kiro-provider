import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { KiroReasoningContent } from "../protocol/canonical.js";
import type { ReasoningReplayKey, ReasoningReplayKeyring } from "./keyring.js";

export const PORTABLE_REPLAY_PREFIX = "kr2_";
export const LEGACY_REPLAY_PREFIX = "kr1_";
export const MAX_PORTABLE_REPLAY_TOKEN_BYTES = 4 * 1024 * 1024;
// Base64 expands bytes by 4/3. Keep plaintext below 3 MB so padding,
// authenticated headers, nonce and tag always fit the 4 MiB public token cap.
const MAX_PORTABLE_REPLAY_PLAINTEXT_BYTES = 3_000_000;
const TOKEN_VERSION = 2;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const CONTEXT_DIGEST_BYTES = 32;
const PADDING_BUCKET_BYTES = 1024;
const AAD_DOMAIN = "kiro-provider-reasoning-replay-v2";

export interface PortableReplayCapture {
  readonly text: string;
  readonly signature?: string;
  readonly redactedContent?: Uint8Array;
}

export interface PortableReplayContext {
  readonly tenantId: string;
  readonly model: string;
  readonly outputFingerprint: string;
}

export interface PortableReplayOrigin {
  readonly accountId: string;
  readonly conversationId: string;
}

interface PortableReplayEnvelope {
  readonly version: 2;
  readonly accountId: string;
  readonly conversationId: string;
  readonly outputFingerprint: string;
  readonly kind: "reasoning_text" | "redacted_content";
  readonly text?: string;
  readonly signature?: string;
  readonly redactedContent?: string;
}

export class PortableReplayTokenError extends Error {
  readonly name = "PortableReplayTokenError";

  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export function isLegacyReplayToken(value: string): boolean {
  return value.startsWith(LEGACY_REPLAY_PREFIX);
}

export function isPortableReplayToken(value: string): boolean {
  return value.startsWith(PORTABLE_REPLAY_PREFIX);
}

export function isProviderReplayToken(value: string): boolean {
  return isLegacyReplayToken(value) || isPortableReplayToken(value);
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}

function aad(context: PortableReplayContext, keyId: string): Buffer {
  return Buffer.concat([
    lengthPrefixed(AAD_DOMAIN),
    lengthPrefixed(String(TOKEN_VERSION)),
    lengthPrefixed(keyId),
    lengthPrefixed(context.tenantId),
    lengthPrefixed(context.model),
    lengthPrefixed(context.outputFingerprint),
  ]);
}

function canonicalBase64(value: string): Uint8Array {
  const normalized = value.replace(/=+$/u, "");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64").replace(/=+$/u, "") !== normalized) {
    throw new PortableReplayTokenError(
      "Reasoning replay contains invalid redacted content",
      "invalid_reasoning_replay",
    );
  }
  return Uint8Array.from(bytes);
}

function envelopeFor(
  capture: PortableReplayCapture,
  context: PortableReplayContext,
  origin: PortableReplayOrigin,
): PortableReplayEnvelope {
  const hasRedacted = capture.redactedContent !== undefined;
  const hasSignedText = capture.signature !== undefined && capture.signature.length > 0;
  if (hasRedacted === hasSignedText) {
    throw new PortableReplayTokenError(
      hasRedacted
        ? "Reasoning replay cannot mix signed text and redacted content"
        : "Reasoning replay does not contain complete signed upstream material",
      hasRedacted ? "reasoning_replay_ambiguous" : "reasoning_replay_incomplete",
    );
  }
  return hasRedacted
    ? {
        version: 2,
        ...origin,
        outputFingerprint: context.outputFingerprint,
        kind: "redacted_content",
        redactedContent: Buffer.from(capture.redactedContent as Uint8Array).toString("base64"),
      }
    : {
        version: 2,
        ...origin,
        outputFingerprint: context.outputFingerprint,
        kind: "reasoning_text",
        text: capture.text,
        signature: capture.signature,
      };
}

function paddedPlaintext(envelope: PortableReplayEnvelope): Buffer {
  const payload = Buffer.from(JSON.stringify(envelope), "utf8");
  if (payload.byteLength > MAX_PORTABLE_REPLAY_PLAINTEXT_BYTES) {
    throw new PortableReplayTokenError(
      "Reasoning replay token exceeds the safe wire-size limit",
      "reasoning_replay_too_large",
    );
  }
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(payload.byteLength);
  const used = length.byteLength + payload.byteLength;
  const paddedLength = Math.ceil(used / PADDING_BUCKET_BYTES) * PADDING_BUCKET_BYTES;
  return Buffer.concat([length, payload, randomBytes(paddedLength - used)]);
}

function contextDigest(domain: string, value: string): Buffer {
  return createHash("sha256").update(`kiro-provider-replay-v2-${domain}\0`).update(value).digest();
}

function encodeHeader(
  key: ReasoningReplayKey,
  nonce: Buffer,
  context: PortableReplayContext,
): Buffer {
  const keyId = Buffer.from(key.id, "utf8");
  if (keyId.byteLength === 0 || keyId.byteLength > 128) {
    throw new PortableReplayTokenError(
      "Reasoning replay key id has an invalid length",
      "reasoning_replay_key_unavailable",
    );
  }
  return Buffer.concat([
    Buffer.from([TOKEN_VERSION, keyId.byteLength]),
    keyId,
    contextDigest("tenant", context.tenantId),
    contextDigest("model", context.model),
    contextDigest("output", context.outputFingerprint),
    nonce,
  ]);
}

export function encodePortableReplayToken(
  capture: PortableReplayCapture,
  context: PortableReplayContext,
  origin: PortableReplayOrigin,
  key: ReasoningReplayKey,
): string {
  const envelope = envelopeFor(capture, context, origin);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key.key, nonce);
  cipher.setAAD(aad(context, key.id));
  const ciphertext = Buffer.concat([cipher.update(paddedPlaintext(envelope)), cipher.final()]);
  const token = `${PORTABLE_REPLAY_PREFIX}${Buffer.concat([
    encodeHeader(key, nonce, context),
    ciphertext,
    cipher.getAuthTag(),
  ]).toString("base64url")}`;
  if (Buffer.byteLength(token, "utf8") > MAX_PORTABLE_REPLAY_TOKEN_BYTES) {
    throw new PortableReplayTokenError(
      "Reasoning replay token exceeds the safe wire-size limit",
      "reasoning_replay_too_large",
    );
  }
  return token;
}

function decodeTokenBytes(token: string): Buffer {
  if (!isPortableReplayToken(token)) {
    throw new PortableReplayTokenError(
      "Reasoning encrypted_content token has an invalid format",
      "invalid_reasoning_replay",
    );
  }
  if (Buffer.byteLength(token, "utf8") > MAX_PORTABLE_REPLAY_TOKEN_BYTES) {
    throw new PortableReplayTokenError(
      "Reasoning replay token exceeds the safe wire-size limit",
      "reasoning_replay_too_large",
    );
  }
  const encoded = token.slice(PORTABLE_REPLAY_PREFIX.length);
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded) {
    throw new PortableReplayTokenError(
      "Reasoning encrypted_content token has an invalid encoding",
      "invalid_reasoning_replay",
    );
  }
  return bytes;
}

function parseEnvelope(plaintext: Buffer): PortableReplayEnvelope {
  if (plaintext.byteLength < 4) {
    throw new PortableReplayTokenError(
      "Reasoning replay plaintext is truncated",
      "reasoning_replay_decryption_failed",
    );
  }
  const payloadLength = plaintext.readUInt32BE(0);
  if (payloadLength === 0 || payloadLength > plaintext.byteLength - 4) {
    throw new PortableReplayTokenError(
      "Reasoning replay plaintext has an invalid payload length",
      "reasoning_replay_decryption_failed",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.subarray(4, 4 + payloadLength).toString("utf8"));
  } catch {
    throw new PortableReplayTokenError(
      "Reasoning replay plaintext is invalid",
      "reasoning_replay_decryption_failed",
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 2 ||
    !("accountId" in parsed) ||
    typeof parsed.accountId !== "string" ||
    !("conversationId" in parsed) ||
    typeof parsed.conversationId !== "string" ||
    !("outputFingerprint" in parsed) ||
    typeof parsed.outputFingerprint !== "string" ||
    !("kind" in parsed) ||
    (parsed.kind !== "reasoning_text" && parsed.kind !== "redacted_content")
  ) {
    throw new PortableReplayTokenError(
      "Reasoning replay plaintext has an invalid envelope",
      "reasoning_replay_decryption_failed",
    );
  }
  return parsed as PortableReplayEnvelope;
}

function contentFromEnvelope(envelope: PortableReplayEnvelope): KiroReasoningContent {
  if (envelope.kind === "redacted_content") {
    if (
      typeof envelope.redactedContent !== "string" ||
      envelope.text !== undefined ||
      envelope.signature !== undefined
    ) {
      throw new PortableReplayTokenError(
        "Reasoning replay contains ambiguous redacted content",
        "reasoning_replay_ambiguous",
      );
    }
    return { kind: "redacted_content", bytes: canonicalBase64(envelope.redactedContent) };
  }
  if (
    typeof envelope.text !== "string" ||
    typeof envelope.signature !== "string" ||
    envelope.signature.length === 0 ||
    envelope.redactedContent !== undefined
  ) {
    throw new PortableReplayTokenError(
      "Reasoning replay does not contain complete signed upstream material",
      "reasoning_replay_incomplete",
    );
  }
  return { kind: "reasoning_text", text: envelope.text, signature: envelope.signature };
}

export function decodePortableReplayToken(
  token: string,
  context: PortableReplayContext,
  keyring: ReasoningReplayKeyring,
): PortableReplayOrigin & { readonly content: KiroReasoningContent; readonly keyId: string } {
  const bytes = decodeTokenBytes(token);
  if (bytes.byteLength < 2 + 1 + 3 * CONTEXT_DIGEST_BYTES + NONCE_BYTES + TAG_BYTES) {
    throw new PortableReplayTokenError(
      "Reasoning encrypted_content token is truncated",
      "invalid_reasoning_replay",
    );
  }
  const version = bytes[0];
  const keyIdLength = bytes[1] ?? 0;
  const contextStart = 2 + keyIdLength;
  const nonceStart = contextStart + 3 * CONTEXT_DIGEST_BYTES;
  const headerLength = nonceStart + NONCE_BYTES;
  if (
    version !== TOKEN_VERSION ||
    keyIdLength === 0 ||
    bytes.byteLength < headerLength + TAG_BYTES
  ) {
    throw new PortableReplayTokenError(
      "Reasoning encrypted_content token has an unsupported envelope",
      "invalid_reasoning_replay",
    );
  }
  const keyId = bytes.subarray(2, 2 + keyIdLength).toString("utf8");
  const key = keyring.byId.get(keyId);
  if (!key) {
    throw new PortableReplayTokenError(
      "Reasoning replay decryption key is unavailable",
      "reasoning_replay_key_unavailable",
    );
  }
  const expectedDigests = [
    contextDigest("tenant", context.tenantId),
    contextDigest("model", context.model),
    contextDigest("output", context.outputFingerprint),
  ];
  for (const [index, expected] of expectedDigests.entries()) {
    const actual = bytes.subarray(
      contextStart + index * CONTEXT_DIGEST_BYTES,
      contextStart + (index + 1) * CONTEXT_DIGEST_BYTES,
    );
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
      throw new PortableReplayTokenError(
        "Reasoning replay context does not match tenant, model, or assistant output",
        "reasoning_replay_context_mismatch",
      );
    }
  }
  const nonce = bytes.subarray(nonceStart, headerLength);
  const ciphertext = bytes.subarray(headerLength, -TAG_BYTES);
  const tag = bytes.subarray(-TAG_BYTES);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.key, nonce);
    decipher.setAAD(aad(context, keyId));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new PortableReplayTokenError(
      "Reasoning replay authentication or decryption failed",
      "reasoning_replay_decryption_failed",
    );
  }
  const envelope = parseEnvelope(plaintext);
  if (envelope.outputFingerprint !== context.outputFingerprint) {
    throw new PortableReplayTokenError(
      "Reasoning replay output fingerprint does not match",
      "reasoning_replay_context_mismatch",
    );
  }
  return {
    accountId: envelope.accountId,
    conversationId: envelope.conversationId,
    content: contentFromEnvelope(envelope),
    keyId,
  };
}
