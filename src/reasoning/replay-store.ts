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
import {
  decodePortableReplayToken,
  encodePortableReplayToken,
  isLegacyReplayToken,
  isPortableReplayToken,
  type PortableReplayMintProvenance,
  PortableReplayTokenError,
} from "./replay-token.js";

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
  readonly protocol: PortableReplayMintProvenance["protocol"];
  readonly region: string;
  readonly profileArn?: string;
  readonly runtimeProtocol: PortableReplayMintProvenance["runtimeProtocol"];
  readonly upstreamOperation: PortableReplayMintProvenance["upstreamOperation"];
}

export interface ReasoningReplayContext {
  readonly tenantId: string;
  readonly model: string;
  readonly outputFingerprint: string;
  readonly compatibleOutputFingerprints?: readonly string[];
  readonly accountId?: string;
  readonly conversationId?: string;
  readonly now?: number;
}

export interface ReasoningReplayResolution {
  readonly accountId: string;
  readonly conversationId: string;
  /** Only provenance-authenticated portable replay may enter a verified cell. */
  readonly portable?: true;
  readonly provenance?: PortableReplayMintProvenance;
  /** Pre-release kr2/v2 compatibility is bounded and remains owner-bound. */
  readonly legacyPortable?: true;
  /** Authenticated, unexpired kr1 database record; carries no mint provenance. */
  readonly databaseLegacy?: true;
  readonly replay: ResolvedReasoningReplay;
}

export interface ReasoningReplayReadiness {
  readonly writable: boolean;
  readonly keyringAvailable: boolean;
  readonly missingKeyIds: readonly string[];
}

/** Sanitized evidence returned by the local recovery utility. */
export interface LegacyReplayRecovery {
  readonly record: ReasoningReplayRecord;
  readonly outputFingerprint: string;
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
  readonly #tokenFormat: Config["reasoning_replay_token_format"];

  constructor(
    database: AccountsDatabase,
    config: Config,
    keyring: ReasoningReplayKeyring = loadReasoningReplayKeyring(config),
  ) {
    this.#database = database;
    this.#keyring = keyring;
    this.#ttlMs = config.reasoning_replay_ttl_ms;
    this.#maxEntries = config.reasoning_replay_max_entries;
    this.#tokenFormat = config.reasoning_replay_token_format;
    this.#database.ensureLegacyPortableReplayCutoff(Date.now(), this.#ttlMs);
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

  recoverLegacyRecord(
    record: ReasoningReplayRecord,
    now: number = Date.now(),
  ): LegacyReplayRecovery {
    const envelope = this.decryptLegacyEnvelope(record);
    if (!constantEqual(record.fingerprintHash, fingerprintHash(envelope.outputFingerprint))) {
      throw new ReasoningReplayError(
        "Reasoning replay backup output fingerprint does not authenticate",
        "reasoning_replay_context_mismatch",
      );
    }
    return {
      record: this.renewLegacyRecord(record, envelope, now),
      outputFingerprint: envelope.outputFingerprint,
    };
  }

  store(
    capture: ReasoningCapture,
    context: ReasoningCaptureContext,
    now: number = Date.now(),
  ): string | undefined {
    const hasRedacted = capture.redactedContent !== undefined;
    const hasSignedText = capture.signature !== undefined && capture.signature.length > 0;
    if (!hasRedacted && !hasSignedText) return undefined;
    if (hasRedacted && (capture.text.length > 0 || capture.signature !== undefined)) {
      throw new ReasoningReplayError(
        "Upstream returned both signed text and redacted reasoning payloads",
        "reasoning_replay_ambiguous",
      );
    }

    if (this.#tokenFormat === "portable-v2") {
      try {
        const expiresAt = now + this.#ttlMs;
        return encodePortableReplayToken(
          capture,
          {
            tenantId: context.tenantId,
            model: context.model,
            outputFingerprint: context.outputFingerprint,
          },
          { accountId: context.accountId, conversationId: context.conversationId },
          {
            protocol: context.protocol,
            region: context.region,
            ...(context.profileArn !== undefined ? { profileArn: context.profileArn } : {}),
            runtimeProtocol: context.runtimeProtocol,
            upstreamOperation: context.upstreamOperation,
            issuedAt: now,
            expiresAt,
          },
          this.#keyring.active,
        );
      } catch (error) {
        if (error instanceof PortableReplayTokenError) {
          throw new ReasoningReplayError(
            error.message,
            error.code,
            error.code.endsWith("unavailable"),
          );
        }
        throw error;
      }
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
    return this.resolveResponsesBatch([
      { token, context, insertBeforeMessage },
    ])[0] as ReasoningReplayResolution;
  }

  resolveResponsesBatch(
    items: readonly {
      readonly token: string;
      readonly context: ReasoningReplayContext;
      readonly insertBeforeMessage: number;
    }[],
  ): ReasoningReplayResolution[] {
    if (items.length === 0) return [];
    const legacyDigests = items
      .filter(({ token }) => isLegacyReplayToken(token))
      .map(({ token }) => tokenHash(token));
    const legacyByHash = new Map(
      this.#database
        .getReasoningReplayRecords(legacyDigests)
        .map((record) => [record.tokenHash, record]),
    );
    const maintained: ReasoningReplayRecord[] = [];
    const keyIds = new Set<string>();
    let portableCount = 0;
    let legacyCount = 0;
    const resolutions = items.map(({ token, context, insertBeforeMessage }) => {
      if (isPortableReplayToken(token)) {
        try {
          const decoded = decodePortableReplayToken(
            token,
            {
              tenantId: context.tenantId,
              model: context.model,
              outputFingerprint: context.outputFingerprint,
            },
            this.#keyring,
            context.now ?? Date.now(),
          );
          if (decoded.legacy) {
            const now = context.now ?? Date.now();
            const acceptedUntil = this.#database.acceptLegacyPortableReplay(
              tokenHash(token),
              decoded.keyId,
              now,
              this.#ttlMs,
              this.#maxEntries,
            );
            if (acceptedUntil === undefined) {
              throw new ReasoningReplayError(
                "Legacy portable reasoning replay compatibility has expired",
                "reasoning_replay_expired",
              );
            }
            legacyCount += 1;
            keyIds.add(decoded.keyId);
            return {
              accountId: decoded.accountId,
              conversationId: decoded.conversationId,
              legacyPortable: true as const,
              replay: { insertBeforeMessage, content: decoded.content },
            };
          }
          portableCount += 1;
          keyIds.add(decoded.keyId);
          return {
            accountId: decoded.accountId,
            conversationId: decoded.conversationId,
            portable: true as const,
            provenance: decoded.provenance,
            replay: { insertBeforeMessage, content: decoded.content },
          };
        } catch (error) {
          if (error instanceof PortableReplayTokenError) {
            throw new ReasoningReplayError(
              error.message,
              error.code,
              error.code.endsWith("unavailable"),
            );
          }
          throw error;
        }
      }
      if (!isLegacyReplayToken(token)) {
        throw new ReasoningReplayError(
          "Reasoning encrypted_content token has an invalid format",
          "invalid_reasoning_replay",
        );
      }
      const now = context.now ?? Date.now();
      const digest = tokenHash(token);
      const record = legacyByHash.get(digest);
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
      const envelope = this.decryptLegacyRecord(record, context);
      const renewed = this.renewLegacyRecord(record, envelope, now);
      maintained.push(renewed);
      legacyCount += 1;
      keyIds.add(renewed.keyId);
      return {
        accountId: record.accountId,
        conversationId: record.conversationId,
        databaseLegacy: true as const,
        replay: { insertBeforeMessage, content: replayContent(envelope) },
      };
    });
    this.#database.updateReasoningReplayRecords(maintained);
    auditLog("info", "reasoning_replay_resolved", {
      replay_count: resolutions.length,
      portable_count: portableCount,
      legacy_count: legacyCount,
      key_count: keyIds.size,
    });
    return resolutions;
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
    const envelope = this.decryptLegacyRecord(record, context);
    const renewed = this.renewLegacyRecord(record, envelope, now);
    this.#database.updateReasoningReplayRecords([renewed]);
    auditLog("info", "reasoning_replay_resolved", {
      replay_count: 1,
      portable_count: 0,
      legacy_count: 1,
      key_count: 1,
    });
    return {
      accountId: record.accountId,
      conversationId: record.conversationId,
      replay: { insertBeforeMessage, content: replayContent(envelope) },
    };
  }

  private decryptLegacyRecord(
    record: ReasoningReplayRecord,
    context: ReasoningReplayContext,
  ): StoredEnvelope {
    const outputFingerprints = [
      context.outputFingerprint,
      ...(context.compatibleOutputFingerprints ?? []),
    ];
    const outputMatches = outputFingerprints.some((outputFingerprint) =>
      constantEqual(record.fingerprintHash, fingerprintHash(outputFingerprint)),
    );
    const mismatches = (
      [
        ["tenant", !constantEqual(record.tenantId, context.tenantId)],
        ["model", record.model !== context.model],
        ["output", !outputMatches],
        ["account", context.accountId !== undefined && record.accountId !== context.accountId],
        [
          "conversation",
          context.conversationId !== undefined && record.conversationId !== context.conversationId,
        ],
      ] as const
    )
      .filter(([, mismatch]) => mismatch)
      .map(([field]) => field);
    if (mismatches.length > 0) {
      auditLog("warn", "reasoning_replay_context_mismatch", {
        mismatch_fields: mismatches.join(","),
        token_hash: record.tokenHash.slice(0, 16),
      });
      throw new ReasoningReplayError(
        `Reasoning replay context does not match: ${mismatches.join(", ")}. Replay the complete, unchanged assistant output associated with this token`,
        "reasoning_replay_context_mismatch",
      );
    }
    const envelope = this.decryptLegacyEnvelope(record);
    if (
      !outputFingerprints.some((outputFingerprint) =>
        constantEqual(envelope.outputFingerprint, outputFingerprint),
      )
    ) {
      throw new ReasoningReplayError(
        "Reasoning replay output fingerprint does not match",
        "reasoning_replay_context_mismatch",
      );
    }
    return envelope;
  }

  private decryptLegacyEnvelope(record: ReasoningReplayRecord): StoredEnvelope {
    const key = this.#keyring.byId.get(record.keyId);
    if (!key) {
      throw new ReasoningReplayError(
        "Reasoning replay decryption key is unavailable",
        "reasoning_replay_key_unavailable",
        true,
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
    return envelope;
  }

  private renewLegacyRecord(
    record: ReasoningReplayRecord,
    envelope: StoredEnvelope,
    now: number,
  ): ReasoningReplayRecord {
    const key = this.#keyring.active;
    const expiresAt = now + this.#ttlMs;
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key.key, nonce);
    cipher.setAAD(
      aad({
        tenantId: record.tenantId,
        model: record.model,
        accountId: record.accountId,
        conversationId: record.conversationId,
        fingerprintHash: record.fingerprintHash,
        expiresAt,
        keyId: key.id,
      }),
    );
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(envelope), "utf8"),
      cipher.final(),
    ]);
    return {
      ...record,
      keyId: key.id,
      nonce: Uint8Array.from(nonce),
      ciphertext: Uint8Array.from(ciphertext),
      authTag: Uint8Array.from(cipher.getAuthTag()),
      lastSeen: now,
      expiresAt,
    };
  }
}
