import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { CanonicalProtocol, KiroReasoningContent } from "../protocol/canonical.js";
import type { ReasoningReplayKey, ReasoningReplayKeyring } from "./keyring.js";

export const PORTABLE_REPLAY_PREFIX = "kr2_";
export const LEGACY_REPLAY_PREFIX = "kr1_";
export const MAX_PORTABLE_REPLAY_TOKEN_BYTES = 4 * 1024 * 1024;
// Base64 expands bytes by 4/3. Keep plaintext below 3 MB so padding,
// authenticated headers, nonce and tag always fit the 4 MiB public token cap.
const MAX_PORTABLE_REPLAY_PLAINTEXT_BYTES = 3_000_000;
const LEGACY_TOKEN_VERSION = 2;
const TOKEN_VERSION = 3;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const CONTEXT_DIGEST_BYTES = 32;
const PADDING_BUCKET_BYTES = 1024;
const LEGACY_AAD_DOMAIN = "kiro-provider-reasoning-replay-v2";
const AAD_DOMAIN = "kiro-provider-reasoning-replay-v3";

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

export interface PortableReplayMintProvenance {
  readonly protocol: CanonicalProtocol;
  readonly region: string;
  readonly profileArn?: string;
  readonly runtimeProtocol: "codewhisperer" | "kiro-runtime";
  readonly upstreamOperation: "GenerateAssistantResponse";
  readonly issuedAt: number;
  readonly expiresAt: number;
}

type ReplayMaterial = {
  readonly outputFingerprint: string;
  readonly kind: "reasoning_text" | "redacted_content";
  readonly text?: string;
  readonly signature?: string;
  readonly redactedContent?: string;
};

interface LegacyPortableReplayEnvelope extends PortableReplayOrigin, ReplayMaterial {
  readonly version: 2;
}

interface PortableReplayEnvelope
  extends PortableReplayOrigin,
    PortableReplayMintProvenance,
    ReplayMaterial {
  readonly version: 3;
}

export type DecodedPortableReplayToken = PortableReplayOrigin & {
  readonly content: KiroReasoningContent;
  readonly keyId: string;
} & (
    | { readonly legacy: true }
    | { readonly legacy: false; readonly provenance: PortableReplayMintProvenance }
  );

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

function aad(context: PortableReplayContext, keyId: string, version: number): Buffer {
  return Buffer.concat([
    lengthPrefixed(version === LEGACY_TOKEN_VERSION ? LEGACY_AAD_DOMAIN : AAD_DOMAIN),
    lengthPrefixed(String(version)),
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

function replayMaterial(
  capture: PortableReplayCapture,
  context: PortableReplayContext,
): ReplayMaterial {
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
        outputFingerprint: context.outputFingerprint,
        kind: "redacted_content",
        redactedContent: Buffer.from(capture.redactedContent as Uint8Array).toString("base64"),
      }
    : {
        outputFingerprint: context.outputFingerprint,
        kind: "reasoning_text",
        text: capture.text,
        signature: capture.signature,
      };
}

function envelopeFor(
  capture: PortableReplayCapture,
  context: PortableReplayContext,
  origin: PortableReplayOrigin,
  provenance: PortableReplayMintProvenance,
): PortableReplayEnvelope {
  if (
    !Number.isSafeInteger(provenance.issuedAt) ||
    !Number.isSafeInteger(provenance.expiresAt) ||
    provenance.issuedAt <= 0 ||
    provenance.expiresAt <= provenance.issuedAt ||
    provenance.region.length === 0 ||
    (provenance.profileArn !== undefined && provenance.profileArn.length === 0)
  ) {
    throw new PortableReplayTokenError(
      "Reasoning replay mint provenance is invalid",
      "invalid_reasoning_replay",
    );
  }
  return {
    version: TOKEN_VERSION,
    ...origin,
    ...provenance,
    ...replayMaterial(capture, context),
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

function contextDigest(domain: string, value: string, version: number): Buffer {
  const prefix =
    version === LEGACY_TOKEN_VERSION
      ? `kiro-provider-replay-v2-${domain}\0`
      : `kiro-provider-replay-v3-${domain}\0`;
  return createHash("sha256").update(prefix).update(value).digest();
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
    contextDigest("tenant", context.tenantId, TOKEN_VERSION),
    contextDigest("model", context.model, TOKEN_VERSION),
    contextDigest("output", context.outputFingerprint, TOKEN_VERSION),
    nonce,
  ]);
}

export function encodePortableReplayToken(
  capture: PortableReplayCapture,
  context: PortableReplayContext,
  origin: PortableReplayOrigin,
  provenance: PortableReplayMintProvenance,
  key: ReasoningReplayKey,
): string {
  const envelope = envelopeFor(capture, context, origin, provenance);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key.key, nonce);
  cipher.setAAD(aad(context, key.id, TOKEN_VERSION));
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

function replayEnvelope(value: unknown): LegacyPortableReplayEnvelope | PortableReplayEnvelope {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    (value.version !== LEGACY_TOKEN_VERSION && value.version !== TOKEN_VERSION) ||
    !("accountId" in value) ||
    typeof value.accountId !== "string" ||
    !("conversationId" in value) ||
    typeof value.conversationId !== "string" ||
    !("outputFingerprint" in value) ||
    typeof value.outputFingerprint !== "string" ||
    !("kind" in value) ||
    (value.kind !== "reasoning_text" && value.kind !== "redacted_content")
  ) {
    throw new PortableReplayTokenError(
      "Reasoning replay plaintext has an invalid envelope",
      "reasoning_replay_decryption_failed",
    );
  }
  if (value.version === LEGACY_TOKEN_VERSION) return value as LegacyPortableReplayEnvelope;
  if (
    !("protocol" in value) ||
    (value.protocol !== "responses" &&
      value.protocol !== "anthropic-messages" &&
      value.protocol !== "chat-completions") ||
    !("region" in value) ||
    typeof value.region !== "string" ||
    value.region.length === 0 ||
    ("profileArn" in value &&
      value.profileArn !== undefined &&
      (typeof value.profileArn !== "string" || value.profileArn.length === 0)) ||
    !("runtimeProtocol" in value) ||
    (value.runtimeProtocol !== "codewhisperer" && value.runtimeProtocol !== "kiro-runtime") ||
    !("upstreamOperation" in value) ||
    value.upstreamOperation !== "GenerateAssistantResponse" ||
    !("issuedAt" in value) ||
    typeof value.issuedAt !== "number" ||
    !Number.isSafeInteger(value.issuedAt) ||
    value.issuedAt <= 0 ||
    !("expiresAt" in value) ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= value.issuedAt
  ) {
    throw new PortableReplayTokenError(
      "Reasoning replay plaintext has invalid mint provenance",
      "reasoning_replay_decryption_failed",
    );
  }
  return value as PortableReplayEnvelope;
}

function parseEnvelope(plaintext: Buffer): LegacyPortableReplayEnvelope | PortableReplayEnvelope {
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
  return replayEnvelope(parsed);
}

function contentFromEnvelope(
  envelope: LegacyPortableReplayEnvelope | PortableReplayEnvelope,
): KiroReasoningContent {
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
  now: number = Date.now(),
): DecodedPortableReplayToken {
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
    (version !== LEGACY_TOKEN_VERSION && version !== TOKEN_VERSION) ||
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
    contextDigest("tenant", context.tenantId, version),
    contextDigest("model", context.model, version),
    contextDigest("output", context.outputFingerprint, version),
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
    decipher.setAAD(aad(context, keyId, version));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new PortableReplayTokenError(
      "Reasoning replay authentication or decryption failed",
      "reasoning_replay_decryption_failed",
    );
  }
  const envelope = parseEnvelope(plaintext);
  if (envelope.version !== version || envelope.outputFingerprint !== context.outputFingerprint) {
    throw new PortableReplayTokenError(
      "Reasoning replay output fingerprint does not match",
      "reasoning_replay_context_mismatch",
    );
  }
  const base = {
    accountId: envelope.accountId,
    conversationId: envelope.conversationId,
    content: contentFromEnvelope(envelope),
    keyId,
  };
  if (envelope.version === LEGACY_TOKEN_VERSION) return { ...base, legacy: true };
  if (envelope.expiresAt <= now) {
    throw new PortableReplayTokenError(
      "Reasoning replay token has expired",
      "reasoning_replay_expired",
    );
  }
  return {
    ...base,
    legacy: false,
    provenance: {
      protocol: envelope.protocol,
      region: envelope.region,
      ...(envelope.profileArn !== undefined ? { profileArn: envelope.profileArn } : {}),
      runtimeProtocol: envelope.runtimeProtocol,
      upstreamOperation: envelope.upstreamOperation,
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
    },
  };
}
