import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import type { ReasoningReplayKeyring } from "../reasoning/keyring.js";
import { WebSearchError } from "./errors.js";

/**
 * Authenticated encryption for web search snapshots and the opaque references
 * Messages clients carry (`encrypted_content`, `encrypted_index`).
 *
 * Keys come from the protected reasoning replay keyring, but every use derives
 * its own subkey with HKDF so a search envelope can never be confused with a
 * reasoning token or another search purpose. AES-256-GCM authenticates the
 * tenant and the public call identity as associated data; the plaintext binds
 * the source identity and the visible fields a client must return unchanged.
 */

const HKDF_SALT = "kiro-provider-web-search-v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const WEB_SEARCH_ENVELOPE_PREFIX = "kws1_";
const MAX_ENVELOPE_CHARS = 4096;
const ENVELOPE_VERSION = 1;

type Purpose = "snapshot" | "result" | "citation";

const PURPOSE_KIND: Readonly<Record<Exclude<Purpose, "snapshot">, number>> = {
  result: 1,
  citation: 2,
};

function subkey(key: Uint8Array, purpose: Purpose): Buffer {
  return Buffer.from(hkdfSync("sha256", key, HKDF_SALT, `kiro-provider web-search ${purpose}`, 32));
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}

function associatedData(purpose: Purpose, keyId: string, tenantId: string, callId: string): Buffer {
  return Buffer.concat([
    lengthPrefixed(`kiro-provider-web-search-${purpose}-v1`),
    lengthPrefixed(keyId),
    lengthPrefixed(tenantId),
    lengthPrefixed(callId),
  ]);
}

function seal(
  key: Uint8Array,
  purpose: Purpose,
  keyId: string,
  tenantId: string,
  callId: string,
  plaintext: Buffer,
): { readonly nonce: Buffer; readonly ciphertext: Buffer; readonly authTag: Buffer } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", subkey(key, purpose), nonce);
  cipher.setAAD(associatedData(purpose, keyId, tenantId, callId));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext, authTag: cipher.getAuthTag() };
}

function open(
  key: Uint8Array,
  purpose: Purpose,
  keyId: string,
  tenantId: string,
  callId: string,
  sealed: {
    readonly nonce: Uint8Array;
    readonly ciphertext: Uint8Array;
    readonly authTag: Uint8Array;
  },
): Buffer | undefined {
  if (sealed.nonce.byteLength !== NONCE_BYTES || sealed.authTag.byteLength !== TAG_BYTES) {
    return undefined;
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", subkey(key, purpose), sealed.nonce);
    decipher.setAAD(associatedData(purpose, keyId, tenantId, callId));
    decipher.setAuthTag(sealed.authTag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  } catch {
    return undefined;
  }
}

export interface SealedSnapshot {
  readonly keyId: string;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly authTag: Uint8Array;
}

export function sealSnapshotPayload(
  keyring: ReasoningReplayKeyring,
  tenantId: string,
  callId: string,
  payload: unknown,
): SealedSnapshot {
  const { id, key } = keyring.active;
  const sealed = seal(key, "snapshot", id, tenantId, callId, Buffer.from(JSON.stringify(payload)));
  return { keyId: id, ...sealed };
}

export function openSnapshotPayload(
  keyring: ReasoningReplayKeyring,
  tenantId: string,
  callId: string,
  sealed: SealedSnapshot,
): unknown {
  const key = keyring.byId.get(sealed.keyId);
  if (key === undefined) {
    throw new WebSearchError(
      "The key that sealed this web search snapshot is unavailable",
      "web_search_replay_key_unavailable",
      503,
    );
  }
  const plaintext = open(key.key, "snapshot", sealed.keyId, tenantId, callId, sealed);
  if (plaintext === undefined) {
    throw new WebSearchError(
      "Web search snapshot failed authentication",
      "web_search_replay_invalid",
      400,
    );
  }
  try {
    return JSON.parse(plaintext.toString("utf8")) as unknown;
  } catch {
    throw new WebSearchError("Web search snapshot is malformed", "web_search_replay_invalid", 400);
  }
}

/**
 * A reference a Messages client carries back in `encrypted_content` (bound to
 * the call through associated data) or `encrypted_index` (a citation does not
 * name its call publicly, so the sealed plaintext carries the call id).
 */
export interface WebSearchReference {
  readonly purpose: "result" | "citation";
  readonly callId: string;
  readonly ordinal: number;
  /** Digest of the complete private source record in the snapshot. */
  readonly sourceIdentity: string;
  /** Digest of the visible fields the client must return unchanged. */
  readonly visibleFingerprint: string;
}

function aadCall(purpose: "result" | "citation", callId: string): string {
  return purpose === "result" ? callId : "";
}

export function sealReference(
  keyring: ReasoningReplayKeyring,
  tenantId: string,
  reference: WebSearchReference,
): string {
  const { id, key } = keyring.active;
  const plaintext = Buffer.from(
    JSON.stringify({
      c: reference.callId,
      o: reference.ordinal,
      s: reference.sourceIdentity,
      f: reference.visibleFingerprint,
    }),
  );
  const sealed = seal(
    key,
    reference.purpose,
    id,
    tenantId,
    aadCall(reference.purpose, reference.callId),
    plaintext,
  );
  const keyIdBytes = Buffer.from(id, "utf8");
  if (keyIdBytes.byteLength > 255) throw new TypeError("Key id is too long for a search reference");
  const header = Buffer.from([
    ENVELOPE_VERSION,
    PURPOSE_KIND[reference.purpose],
    keyIdBytes.byteLength,
  ]);
  return `${WEB_SEARCH_ENVELOPE_PREFIX}${Buffer.concat([
    header,
    keyIdBytes,
    sealed.nonce,
    sealed.authTag,
    sealed.ciphertext,
  ]).toString("base64url")}`;
}

export type ReferenceOpenFailure =
  | "web_search_replay_invalid"
  | "web_search_replay_key_unavailable";

export type ReferenceOpenResult =
  | { readonly ok: true; readonly reference: WebSearchReference }
  | { readonly ok: false; readonly code: ReferenceOpenFailure };

/** `callId` is required for results and ignored for citations, whose plaintext names it. */
export function openReference(
  keyring: ReasoningReplayKeyring,
  tenantId: string,
  callId: string,
  purpose: "result" | "citation",
  token: unknown,
): ReferenceOpenResult {
  const invalid = { ok: false, code: "web_search_replay_invalid" } as const;
  if (
    typeof token !== "string" ||
    token.length > MAX_ENVELOPE_CHARS ||
    !token.startsWith(WEB_SEARCH_ENVELOPE_PREFIX)
  ) {
    return invalid;
  }
  const encoded = token.slice(WEB_SEARCH_ENVELOPE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return invalid;
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded || bytes.byteLength < 3) return invalid;
  const version = bytes[0];
  const kind = bytes[1];
  const keyIdLength = bytes[2] ?? 0;
  if (version !== ENVELOPE_VERSION || kind !== PURPOSE_KIND[purpose]) return invalid;
  const keyIdEnd = 3 + keyIdLength;
  if (bytes.byteLength < keyIdEnd + NONCE_BYTES + TAG_BYTES) return invalid;
  const keyId = bytes.subarray(3, keyIdEnd).toString("utf8");
  const key = keyring.byId.get(keyId);
  if (key === undefined) return { ok: false, code: "web_search_replay_key_unavailable" };
  const nonce = bytes.subarray(keyIdEnd, keyIdEnd + NONCE_BYTES);
  const authTag = bytes.subarray(keyIdEnd + NONCE_BYTES, keyIdEnd + NONCE_BYTES + TAG_BYTES);
  const ciphertext = bytes.subarray(keyIdEnd + NONCE_BYTES + TAG_BYTES);
  const plaintext = open(key.key, purpose, keyId, tenantId, aadCall(purpose, callId), {
    nonce,
    authTag,
    ciphertext,
  });
  if (plaintext === undefined) return invalid;
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString("utf8"));
  } catch {
    return invalid;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("c" in parsed) ||
    typeof parsed.c !== "string" ||
    parsed.c.length === 0 ||
    (purpose === "result" && parsed.c !== callId) ||
    !("o" in parsed) ||
    !("s" in parsed) ||
    !("f" in parsed) ||
    !Number.isSafeInteger(parsed.o) ||
    (parsed.o as number) < 0 ||
    typeof parsed.s !== "string" ||
    typeof parsed.f !== "string"
  ) {
    return invalid;
  }
  return {
    ok: true,
    reference: {
      purpose,
      callId: parsed.c,
      ordinal: parsed.o as number,
      sourceIdentity: parsed.s,
      visibleFingerprint: parsed.f,
    },
  };
}

function digest(domain: string, values: readonly (string | number | null)[]): string {
  const hash = createHash("sha256").update(domain);
  for (const value of values) {
    hash.update("\0");
    hash.update(value === null ? "\u0001null" : String(value));
  }
  return hash.digest("hex");
}

export function sourceIdentity(source: {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  readonly publishedDate?: number;
  readonly backendId: string;
  readonly domain: string;
}): string {
  return digest("kiro-provider-web-search-source-v1", [
    source.url,
    source.title,
    source.snippet,
    source.publishedDate ?? null,
    source.backendId,
    source.domain,
  ]);
}

export function resultVisibleFingerprint(fields: {
  readonly url: string;
  readonly title: string;
  readonly pageAge: string | null;
}): string {
  return digest("kiro-provider-web-search-result-visible-v1", [
    fields.url,
    fields.title,
    fields.pageAge,
  ]);
}

export function citationVisibleFingerprint(fields: {
  readonly url: string;
  readonly title: string;
  readonly citedText: string;
}): string {
  return digest("kiro-provider-web-search-citation-visible-v1", [
    fields.url,
    fields.title,
    fields.citedText,
  ]);
}

/** Tenant-isolated lookup key: no plaintext tenant or call id is stored. */
export function snapshotLookupHash(tenantId: string, callId: string): string {
  return digest("kiro-provider-web-search-lookup-v1", [tenantId, callId]);
}
