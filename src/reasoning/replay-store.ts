import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Config } from "../config/schema.js";
import { auditHash, auditLog } from "../core/audit-log.js";
import type { KiroReasoningContent, ResolvedReasoningReplay } from "../protocol/canonical.js";
import type { AccountsDatabase, ReasoningReplayRecord } from "../storage/accounts-db.js";
import { loadReasoningReplayKeyring, type ReasoningReplayKeyring } from "./keyring.js";

interface StoredEnvelope {
  readonly version: 1;
  readonly outputFingerprint: string;
  readonly text?: string;
  readonly signature?: string;
  readonly redactedContent?: string;
}

export interface ReasoningCapture {
  readonly text: string;
  readonly signature?: string;
  readonly redactedContent?: Uint8Array;
}

export interface ReasoningCaptureContext {
  readonly tenantId: string;
  readonly model: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly outputFingerprint: string;
}

export interface ReasoningReplayContext {
  readonly tenantId: string;
  readonly model: string;
  readonly outputFingerprint: string;
  readonly accountId?: string;
  readonly conversationId?: string;
  readonly now?: number;
}

export interface ReasoningReplayResolution {
  readonly accountId: string;
  readonly conversationId: string;
  readonly replay: ResolvedReasoningReplay;
}

export interface ReasoningReplayReadiness {
  readonly writable: boolean;
  readonly keyringAvailable: boolean;
  readonly missingKeyIds: readonly string[];
}

export class ReasoningReplayError extends Error {
  readonly name = "ReasoningReplayError";

  constructor(
    message: string,
    readonly code: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

function hash(domain: string, ...values: readonly string[]): string {
  const digest = createHash("sha256").update(domain).update("\0");
  for (const value of values) digest.update(value).update("\0");
  return digest.digest("hex");
}

function tokenHash(token: string): string {
  return hash("kiro-provider-reasoning-token-v1", token);
}

function fingerprintHash(fingerprint: string): string {
  return hash("kiro-provider-reasoning-fingerprint-v1", fingerprint);
}

function chatLookupHash(reasoningText: string, outputFingerprint: string): string {
  return hash("kiro-provider-reasoning-chat-lookup-v1", reasoningText, outputFingerprint);
}

function constantEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function aad(record: {
  readonly tenantId: string;
  readonly model: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly fingerprintHash: string;
  readonly expiresAt: number;
  readonly keyId: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      tenantId: record.tenantId,
      model: record.model,
      accountId: record.accountId,
      conversationId: record.conversationId,
      fingerprintHash: record.fingerprintHash,
      expiresAt: record.expiresAt,
      keyId: record.keyId,
    }),
    "utf8",
  );
}

function parseEnvelope(value: string): StoredEnvelope {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("outputFingerprint" in parsed) ||
    typeof parsed.outputFingerprint !== "string"
  ) {
    throw new TypeError("Invalid reasoning replay envelope");
  }
  const text = "text" in parsed && typeof parsed.text === "string" ? parsed.text : undefined;
  const signature =
    "signature" in parsed && typeof parsed.signature === "string" ? parsed.signature : undefined;
  const redactedContent =
    "redactedContent" in parsed && typeof parsed.redactedContent === "string"
      ? parsed.redactedContent
      : undefined;
  return {
    version: 1,
    outputFingerprint: parsed.outputFingerprint,
    ...(text !== undefined ? { text } : {}),
    ...(signature !== undefined ? { signature } : {}),
    ...(redactedContent !== undefined ? { redactedContent } : {}),
  };
}

function replayContent(envelope: StoredEnvelope): KiroReasoningContent {
  if (envelope.redactedContent !== undefined) {
    if (envelope.signature !== undefined || envelope.text !== undefined) {
      throw new ReasoningReplayError(
        "Reasoning replay contains ambiguous text and redacted payloads",
        "reasoning_replay_ambiguous",
      );
    }
    return {
      kind: "redacted_content",
      bytes: Uint8Array.from(Buffer.from(envelope.redactedContent, "base64")),
    };
  }
  if (envelope.text !== undefined && envelope.signature !== undefined) {
    return {
      kind: "reasoning_text",
      text: envelope.text,
      signature: envelope.signature,
    };
  }
  throw new ReasoningReplayError(
    "Reasoning replay does not contain complete signed upstream material",
    "reasoning_replay_incomplete",
  );
}

export class ReasoningReplayStore {
  readonly #database: AccountsDatabase;
  readonly #keyring: ReasoningReplayKeyring;
  readonly #ttlMs: number;
  readonly #maxEntries: number;

  constructor(
    database: AccountsDatabase,
    config: Config,
    keyring: ReasoningReplayKeyring = loadReasoningReplayKeyring(config),
  ) {
    this.#database = database;
    this.#keyring = keyring;
    this.#ttlMs = config.reasoning_replay_ttl_ms;
    this.#maxEntries = config.reasoning_replay_max_entries;
    const missing = this.readiness().missingKeyIds;
    if (missing.length > 0) {
      throw new TypeError(
        `Reasoning replay keyring is missing active key ids: ${missing.join(", ")}`,
      );
    }
  }

  readiness(): ReasoningReplayReadiness {
    const activeIds = this.#database.activeReasoningReplayKeyIds();
    return {
      writable: this.#database.checkWritable(),
      keyringAvailable: this.#keyring.byId.size > 0,
      missingKeyIds: activeIds.filter((id) => !this.#keyring.byId.has(id)),
    };
  }

  store(
    capture: ReasoningCapture,
    context: ReasoningCaptureContext,
    now: number = Date.now(),
  ): string | undefined {
    const hasRedacted = capture.redactedContent !== undefined;
    const hasSignedText = capture.text.length > 0 && capture.signature !== undefined;
    if (!hasRedacted && !hasSignedText) return undefined;
    if (hasRedacted && (capture.text.length > 0 || capture.signature !== undefined)) {
      throw new ReasoningReplayError(
        "Upstream returned both signed text and redacted reasoning payloads",
        "reasoning_replay_ambiguous",
      );
    }

    const token = `kr1_${randomBytes(32).toString("base64url")}`;
    const tokenDigest = tokenHash(token);
    const outputDigest = fingerprintHash(context.outputFingerprint);
    const expiresAt = now + this.#ttlMs;
    const key = this.#keyring.active;
    const nonce = randomBytes(12);
    const envelope: StoredEnvelope = {
      version: 1,
      outputFingerprint: context.outputFingerprint,
      ...(hasSignedText ? { text: capture.text, signature: capture.signature } : {}),
      ...(hasRedacted
        ? { redactedContent: Buffer.from(capture.redactedContent as Uint8Array).toString("base64") }
        : {}),
    };
    const cipher = createCipheriv("aes-256-gcm", key.key, nonce);
    cipher.setAAD(
      aad({
        ...context,
        fingerprintHash: outputDigest,
        expiresAt,
        keyId: key.id,
      }),
    );
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(envelope), "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    this.#database.insertReasoningReplay(
      {
        tokenHash: tokenDigest,
        chatLookupHash: hasSignedText
          ? chatLookupHash(capture.text, context.outputFingerprint)
          : null,
        fingerprintHash: outputDigest,
        tenantId: context.tenantId,
        accountId: context.accountId,
        conversationId: context.conversationId,
        model: context.model,
        keyId: key.id,
        nonce: Uint8Array.from(nonce),
        ciphertext: Uint8Array.from(ciphertext),
        authTag: Uint8Array.from(authTag),
        createdAt: now,
        lastSeen: now,
        expiresAt,
      },
      this.#maxEntries,
      now,
    );
    return token;
  }

  resolveResponses(
    token: string,
    context: ReasoningReplayContext,
    insertBeforeMessage: number,
  ): ReasoningReplayResolution {
    if (!token.startsWith("kr1_")) {
      throw new ReasoningReplayError(
        "Reasoning encrypted_content token has an invalid format",
        "invalid_reasoning_replay",
      );
    }
    const now = context.now ?? Date.now();
    const digest = tokenHash(token);
    const record = this.#database.getReasoningReplayRecord(digest);
    if (!record) {
      auditLog("info", "reasoning_replay_miss", {
        lookup: "responses-token",
        token_hash: digest.slice(0, 16),
      });
      throw new ReasoningReplayError(
        "Reasoning replay token was not found",
        "reasoning_replay_not_found",
      );
    }
    if (record.expiresAt <= now) {
      auditLog("info", "reasoning_replay_expired", {
        lookup: "responses-token",
        token_hash: digest.slice(0, 16),
      });
      throw new ReasoningReplayError(
        "Reasoning replay token has expired",
        "reasoning_replay_expired",
      );
    }
    return this.resolveRecord(record, context, insertBeforeMessage, now);
  }

  resolveChat(
    reasoningText: string,
    context: ReasoningReplayContext,
    insertBeforeMessage: number,
  ): ReasoningReplayResolution {
    const now = context.now ?? Date.now();
    let records = this.#database.findReasoningReplayByChatHash(
      context.tenantId,
      context.model,
      chatLookupHash(reasoningText, context.outputFingerprint),
      now,
    );
    if (context.accountId !== undefined) {
      records = records.filter((record) => record.accountId === context.accountId);
    }
    if (context.conversationId !== undefined) {
      records = records.filter((record) => record.conversationId === context.conversationId);
    }
    if (records.length === 0) {
      auditLog("info", "reasoning_replay_miss", {
        lookup: "chat-hash",
        tenant_hash: auditHash(context.tenantId),
      });
      throw new ReasoningReplayError(
        "No exact signed reasoning record matches reasoning_content and assistant output",
        "reasoning_replay_not_found",
      );
    }
    if (records.length !== 1) {
      throw new ReasoningReplayError(
        "Reasoning replay lookup is ambiguous across accounts or conversations",
        "reasoning_replay_ambiguous",
      );
    }
    const record = records[0];
    if (!record) {
      throw new ReasoningReplayError(
        "Reasoning replay lookup failed",
        "reasoning_replay_not_found",
      );
    }
    return this.resolveRecord(record, context, insertBeforeMessage, now);
  }

  private resolveRecord(
    record: ReasoningReplayRecord,
    context: ReasoningReplayContext,
    insertBeforeMessage: number,
    now: number,
  ): ReasoningReplayResolution {
    const expectedFingerprint = fingerprintHash(context.outputFingerprint);
    if (
      !constantEqual(record.tenantId, context.tenantId) ||
      record.model !== context.model ||
      !constantEqual(record.fingerprintHash, expectedFingerprint) ||
      (context.accountId !== undefined && record.accountId !== context.accountId) ||
      (context.conversationId !== undefined && record.conversationId !== context.conversationId)
    ) {
      throw new ReasoningReplayError(
        "Reasoning replay context does not match tenant, model, account, conversation, or output",
        "reasoning_replay_context_mismatch",
      );
    }
    const key = this.#keyring.byId.get(record.keyId);
    if (!key) {
      throw new ReasoningReplayError(
        "Reasoning replay decryption key is unavailable",
        "reasoning_replay_key_unavailable",
      );
    }
    let envelope: StoredEnvelope;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key.key, record.nonce);
      decipher.setAAD(
        aad({
          tenantId: record.tenantId,
          model: record.model,
          accountId: record.accountId,
          conversationId: record.conversationId,
          fingerprintHash: record.fingerprintHash,
          expiresAt: record.expiresAt,
          keyId: record.keyId,
        }),
      );
      decipher.setAuthTag(record.authTag);
      const plaintext = Buffer.concat([
        decipher.update(record.ciphertext),
        decipher.final(),
      ]).toString("utf8");
      envelope = parseEnvelope(plaintext);
    } catch (error) {
      if (error instanceof ReasoningReplayError) throw error;
      throw new ReasoningReplayError(
        "Reasoning replay authentication or decryption failed",
        "reasoning_replay_decryption_failed",
      );
    }
    if (envelope.outputFingerprint !== context.outputFingerprint) {
      throw new ReasoningReplayError(
        "Reasoning replay output fingerprint does not match",
        "reasoning_replay_context_mismatch",
      );
    }
    this.#database.touchReasoningReplay(record.tokenHash, now);
    auditLog("info", "reasoning_replay_hit", {
      key_id: record.keyId,
      account_hash: auditHash(record.accountId),
      conversation_hash: auditHash(record.conversationId),
      model: record.model,
    });
    return {
      accountId: record.accountId,
      conversationId: record.conversationId,
      replay: { insertBeforeMessage, content: replayContent(envelope) },
    };
  }
}
