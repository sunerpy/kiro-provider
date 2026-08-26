import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../config/schema.js";

export interface ReasoningReplayKey {
  readonly id: string;
  readonly key: Uint8Array;
}

export interface ReasoningReplayKeyring {
  readonly active: ReasoningReplayKey;
  readonly byId: ReadonlyMap<string, ReasoningReplayKey>;
  readonly source: "environment" | "file";
  readonly path?: string;
}

interface KeyFile {
  readonly version: 1;
  readonly keys: readonly { readonly id: string; readonly key: string }[];
}

function defaultKeyPath(): string {
  const configRoot =
    process.platform === "win32"
      ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
      : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return join(configRoot, "kiro-provider", "reasoning-replay-keys.json");
}

export const REASONING_REPLAY_KEY_PATH = defaultKeyPath();

function keyId(key: Uint8Array): string {
  return `rk_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function parseKeyMaterial(encoded: string, source: string): Uint8Array {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, "base64url");
  } catch {
    throw new TypeError(`${source} contains invalid base64url key material`);
  }
  if (bytes.byteLength !== 32) {
    throw new TypeError(`${source} must decode to exactly 32 bytes for AES-256-GCM`);
  }
  return Uint8Array.from(bytes);
}

function parseEntry(entry: string, source: string): ReasoningReplayKey {
  const separator = entry.indexOf(":");
  const id = separator > 0 ? entry.slice(0, separator) : undefined;
  const encoded = separator > 0 ? entry.slice(separator + 1) : entry;
  const key = parseKeyMaterial(encoded, source);
  const resolvedId = id ?? keyId(key);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(resolvedId)) {
    throw new TypeError(`${source} contains an invalid key id`);
  }
  return { id: resolvedId, key };
}

function toKeyring(
  keys: readonly ReasoningReplayKey[],
  source: ReasoningReplayKeyring["source"],
  path?: string,
): ReasoningReplayKeyring {
  if (keys.length === 0) throw new TypeError("Reasoning replay keyring is empty");
  const byId = new Map<string, ReasoningReplayKey>();
  for (const key of keys) {
    if (byId.has(key.id)) throw new TypeError(`Duplicate reasoning replay key id ${key.id}`);
    byId.set(key.id, key);
  }
  const active = keys[0];
  if (!active) throw new TypeError("Reasoning replay keyring is empty");
  return path === undefined
    ? { active, byId, source }
    : { active, byId, source, path };
}

function readKeyFile(path: string): ReasoningReplayKeyring {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new TypeError(`Unable to read reasoning replay key file ${path}`, { cause: error });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("keys" in parsed) ||
    !Array.isArray(parsed.keys)
  ) {
    throw new TypeError(`Reasoning replay key file ${path} has an invalid format`);
  }
  const keys = parsed.keys.map((value, index) => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("id" in value) ||
      typeof value.id !== "string" ||
      !("key" in value) ||
      typeof value.key !== "string"
    ) {
      throw new TypeError(`Reasoning replay key file ${path} has an invalid keys.${index}`);
    }
    return parseEntry(`${value.id}:${value.key}`, `${path} keys.${index}`);
  });
  if (process.platform !== "win32") chmodSync(path, 0o600);
  return toKeyring(keys, "file", path);
}

function writeGeneratedKeyFile(path: string): ReasoningReplayKeyring {
  mkdirSync(dirname(path), { recursive: true });
  const key = Uint8Array.from(randomBytes(32));
  const payload: KeyFile = {
    version: 1,
    keys: [{ id: keyId(key), key: Buffer.from(key).toString("base64url") }],
  };
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    if (existsSync(path)) {
      unlinkSync(temporary);
      return readKeyFile(path);
    }
    renameSync(temporary, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    if (existsSync(path)) return readKeyFile(path);
    throw error;
  }
  return toKeyring([{ id: keyId(key), key }], "file", path);
}

export function loadReasoningReplayKeyring(config: Config): ReasoningReplayKeyring {
  if (config.reasoning_replay_keys.length > 0) {
    return toKeyring(
      config.reasoning_replay_keys.map((entry, index) =>
        parseEntry(entry, `KIRO_PROVIDER_REASONING_REPLAY_KEYS[${index}]`),
      ),
      "environment",
    );
  }
  const path = config.reasoning_replay_key_path ?? REASONING_REPLAY_KEY_PATH;
  return existsSync(path) ? readKeyFile(path) : writeGeneratedKeyFile(path);
}
