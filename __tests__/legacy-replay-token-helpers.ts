import { createCipheriv, createHash, randomBytes } from "node:crypto";
import type { ReasoningCapture, ReasoningCaptureContext } from "../src/reasoning/replay-store.js";

/** Independent reproduction of the deployed v3 public-slug authentication. */
export function mintV3ReplayFixture(
  capture: ReasoningCapture,
  context: ReasoningCaptureContext,
  key: Uint8Array,
  now = Date.now(),
  omitProjection = false,
  keyId = "fixture",
): string {
  const digest = (domain: string, value: string) =>
    createHash("sha256").update(`kiro-provider-replay-v3-${domain}\0`).update(value).digest();
  const prefixed = (value: string) => {
    const bytes = Buffer.from(value);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const nonce = randomBytes(12);
  const payload = Buffer.from(
    JSON.stringify({
      version: 3,
      accountId: context.accountId,
      conversationId: context.conversationId,
      outputFingerprint: context.outputFingerprint,
      protocol: context.protocol,
      region: context.region,
      profileArn: context.profileArn,
      runtimeProtocol: context.runtimeProtocol,
      upstreamOperation: context.upstreamOperation,
      issuedAt: now,
      expiresAt: now + 86_400_000,
      ...(omitProjection ? {} : { instructionProjection: context.instructionProjection }),
      ...(capture.redactedContent
        ? {
            kind: "redacted_content",
            redactedContent: Buffer.from(capture.redactedContent).toString("base64"),
          }
        : { kind: "reasoning_text", text: capture.text, signature: capture.signature }),
    }),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const plaintext = Buffer.concat([
    length,
    payload,
    randomBytes(Math.ceil((payload.length + 4) / 1024) * 1024 - payload.length - 4),
  ]);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(
    Buffer.concat(
      [
        "kiro-provider-reasoning-replay-v3",
        "3",
        keyId,
        context.tenantId,
        context.model,
        context.outputFingerprint,
      ].map(prefixed),
    ),
  );
  const header = Buffer.concat([
    Buffer.from([3, keyId.length]),
    Buffer.from(keyId),
    digest("tenant", context.tenantId),
    digest("model", context.model),
    digest("output", context.outputFingerprint),
    nonce,
  ]);
  return `kr2_${Buffer.concat([header, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]).toString("base64url")}`;
}
