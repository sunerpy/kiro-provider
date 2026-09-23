/**
 * Bounded, payload-safe probe for native Kiro JSON Schema enforcement.
 *
 * Dry-run (default):
 *   bun run scripts/probe-structured-output-capability.ts
 *
 * Live (synthetic data only, maximum three repeats per case). The isolated
 * root must contain an owner-only, standalone SQLite backup with exactly one
 * account; never point this at the active provider config root:
 *   bun run scripts/probe-structured-output-capability.ts \
 *     --confirm-live-structured-output-probe \
 *     --isolated-config-root /path/to/isolated-xdg \
 *     --repeats 2 [--model gpt-5.6-sol]
 * Windows live probes require PowerShell 7 (pwsh.exe) for DACL inspection.
 *
 * Output intentionally excludes model text, JSON Schema, tokens, profile ARN,
 * account id, and upstream error prose.
 */

import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  GenerateAssistantResponseCommand,
  type GenerateAssistantResponseCommandInput,
} from "@aws/codewhisperer-streaming-client";
import { attachKiroRuntimeRequest, createSdkClient } from "../src/core/sdk-client.js";
import { isValidRegion, KIRO_CONSTANTS } from "../src/kiro/constants.js";
import { loadProbeAuth } from "./probe-v3-request-fields.js";

const CONFIRM_FLAG = "--confirm-live-structured-output-probe";
const MAX_REPEATS = 3;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const SAFE_ERROR_CODES = new Set([
  "AbortError",
  "AccessDeniedException",
  "InternalServerException",
  "REQUEST_BODY_INVALID",
  "ServiceUnavailableException",
  "ThrottlingException",
  "TimeoutError",
  "TooManyRequestsException",
  "UnauthorizedException",
  "ValidationException",
  "access_denied",
  "invalid_request_error",
]);
const SYNTHETIC_PROMPT = "Reply with exactly the plain token NOTJSON. Do not use braces or JSON.";
const SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({
    result: Object.freeze({ type: "string", minLength: 1, maxLength: 8 }),
  }),
  required: Object.freeze(["result"]),
  additionalProperties: false,
});
const FORMAT = Object.freeze({
  type: "json_schema",
  name: "synthetic_probe",
  strict: true,
  schema: SCHEMA,
});

export type ProbeOutcome = {
  readonly status: number;
  readonly code?: string;
  readonly completed: boolean;
  readonly textBytes: number;
  readonly textHash: string;
  readonly schemaAdherent: boolean;
  readonly bodyBytes?: number;
  readonly bodyHash?: string;
};

function argument(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index < 0 || process.argv[index + 1] === undefined
    ? fallback
    : (process.argv[index + 1] as string);
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function existingRealPath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
}

function pathContains(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

const WINDOWS_ACL_SCRIPT = `
#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:KIRO_PROBE_ACL_PATH
$descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
$result = @{
  user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  daclPresent = $null -ne $descriptor.DiscretionaryAcl
  aceCount = if ($null -eq $descriptor.DiscretionaryAcl) { 0 } else { $descriptor.DiscretionaryAcl.Count }
  rules = @($rules | ForEach-Object { @{
    sid = $_.IdentityReference.Value
    type = $_.AccessControlType.ToString()
    rights = [int64]$_.FileSystemRights
    inheritOnly = ($_.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0
  } })
}
$result | ConvertTo-Json -Depth 5 -Compress
`;

/** Windows chmod/stat modes do not describe DACL protection; inspect numeric SIDs instead. */
export function assertPrivateWindowsAcl(
  description: string,
  value: unknown,
  requiredOwnerBits: number,
): void {
  const invalid: () => never = () => {
    throw new Error(`${description} must have a verifiable owner-only Windows ACL`);
  };
  if (
    !isRecord(value) ||
    typeof value.user !== "string" ||
    !/^S-1-(?:\d+-)+\d+$/.test(value.user) ||
    typeof value.owner !== "string" ||
    value.daclPresent !== true ||
    !Array.isArray(value.rules) ||
    value.aceCount !== value.rules.length ||
    value.rules.length === 0
  ) {
    invalid();
  }
  if (value.owner !== value.user) {
    throw new Error(`${description} must be owned by the current user`);
  }
  // SYSTEM and built-in Administrators already have privileged takeover rights,
  // just as root can read a POSIX 0600 file. No ordinary user/group is allowed.
  const privileged = new Set([value.user, "S-1-5-18", "S-1-5-32-544"]);
  let ownerRights = 0;
  for (const rule of value.rules) {
    if (
      !isRecord(rule) ||
      typeof rule.sid !== "string" ||
      rule.type !== "Allow" ||
      !privileged.has(rule.sid) ||
      typeof rule.rights !== "number" ||
      !Number.isSafeInteger(rule.rights) ||
      rule.rights <= 0 ||
      rule.rights > 0x7fffffff ||
      typeof rule.inheritOnly !== "boolean"
    ) {
      invalid();
    }
    if (rule.sid === value.user && !rule.inheritOnly) ownerRights |= rule.rights;
  }
  const requiredRights = (requiredOwnerBits & 0o100) !== 0 ? 0x200a9 : 0x20089;
  if ((ownerRights & requiredRights) !== requiredRights) invalid();
}

function assertOwnerOnly(
  description: string,
  path: string,
  metadata: Stats,
  requiredOwnerBits: number,
): void {
  if (process.platform === "win32") {
    let acl: unknown;
    try {
      acl = JSON.parse(
        execFileSync(
          "pwsh.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(WINDOWS_ACL_SCRIPT, "utf16le").toString("base64"),
          ],
          {
            encoding: "utf8",
            env: { ...process.env, KIRO_PROBE_ACL_PATH: path },
            timeout: 10_000,
            maxBuffer: 64 * 1024,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          },
        ),
      );
    } catch {
      throw new Error(
        `${description} must have a verifiable owner-only Windows ACL (PowerShell 7 pwsh.exe required)`,
      );
    }
    assertPrivateWindowsAcl(description, acl, requiredOwnerBits);
    return;
  }
  if ((metadata.mode & requiredOwnerBits) !== requiredOwnerBits || (metadata.mode & 0o077) !== 0) {
    throw new Error(`${description} must be owner-only`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`${description} must be owned by the current user`);
  }
}

function defaultProtectedConfigRoots(): readonly string[] {
  const platformDefault =
    process.platform === "win32"
      ? join(homedir(), "AppData", "Roaming")
      : join(homedir(), ".config");
  return [
    ...new Set(
      [process.env.XDG_CONFIG_HOME?.trim(), process.env.APPDATA?.trim(), platformDefault].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  ];
}

function validateSnapshotDatabase(databasePath: string): void {
  let database: Database | undefined;
  try {
    database = new Database(databasePath, { readonly: true });
    const integrity = database.query("PRAGMA integrity_check").all() as Record<string, unknown>[];
    if (
      integrity.length !== 1 ||
      Object.values(integrity[0] ?? {}).length !== 1 ||
      Object.values(integrity[0] ?? {})[0] !== "ok"
    ) {
      throw new Error("The isolated account database failed its integrity check");
    }
    const row = database
      .query("SELECT COUNT(*) AS account_count, MIN(region) AS region FROM accounts")
      .get() as { readonly account_count?: unknown; readonly region?: unknown } | null;
    if (row?.account_count !== 1) {
      throw new Error("The isolated account database must contain exactly one account");
    }
    if (typeof row.region !== "string" || !isValidRegion(row.region)) {
      throw new Error("The isolated account database contains an invalid region");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("The isolated account database")) {
      throw error;
    }
    throw new Error("The isolated account database failed schema validation");
  } finally {
    database?.close();
  }
}

export function validateIsolatedConfigRoot(
  supplied: string,
  protectedConfigRoots: readonly string[] = defaultProtectedConfigRoots(),
): string {
  if (!supplied || !isAbsolute(supplied)) {
    throw new Error("Live probes require an absolute --isolated-config-root");
  }
  if (lstatSync(supplied).isSymbolicLink()) {
    throw new Error("The isolated config root must not be a symbolic link");
  }
  const root = realpathSync(supplied);
  const rootStat = statSync(root);
  if (!rootStat.isDirectory()) {
    throw new Error("The isolated config root must be a directory");
  }
  assertOwnerOnly("The isolated config root", root, rootStat, 0o500);

  for (const protectedRoot of protectedConfigRoots) {
    const resolvedProtectedRoot = existingRealPath(protectedRoot);
    if (
      resolvedProtectedRoot !== undefined &&
      (pathContains(resolvedProtectedRoot, root) || pathContains(root, resolvedProtectedRoot))
    ) {
      throw new Error("The isolated config root must not overlap an active config root");
    }
  }

  const providerPath = join(root, "kiro-provider");
  const providerLinkStat = lstatSync(providerPath);
  if (providerLinkStat.isSymbolicLink()) {
    throw new Error("The isolated provider directory must not be a symbolic link");
  }
  const providerPathReal = realpathSync(providerPath);
  const providerStat = statSync(providerPathReal);
  if (!providerStat.isDirectory() || dirname(providerPathReal) !== root) {
    throw new Error("The isolated provider directory must stay inside the config root");
  }
  assertOwnerOnly("The isolated provider directory", providerPathReal, providerStat, 0o500);

  const databasePath = join(providerPathReal, "accounts.db");
  const databaseLinkStat = lstatSync(databasePath);
  if (databaseLinkStat.isSymbolicLink()) {
    throw new Error("The isolated account database must not be a symbolic link");
  }
  const databasePathReal = realpathSync(databasePath);
  const databaseStat = statSync(databasePath);
  if (!databaseStat.isFile() || dirname(databasePathReal) !== providerPathReal) {
    throw new Error("The isolated account database must be a regular file inside the config root");
  }
  assertOwnerOnly("The isolated account database", databasePathReal, databaseStat, 0o400);
  if (databaseStat.nlink !== 1) {
    throw new Error("The isolated account database must not be hard-linked");
  }
  if (databaseStat.size > MAX_SNAPSHOT_BYTES) {
    throw new Error("The isolated account database exceeds the minimal snapshot size limit");
  }
  for (const suffix of ["-wal", "-shm"]) {
    try {
      lstatSync(`${databasePathReal}${suffix}`);
      throw new Error("The isolated account database must not have SQLite sidecars");
    } catch (error) {
      if (error instanceof Error && error.message.includes("must not have SQLite sidecars")) {
        throw error;
      }
      if (!isMissingPath(error)) throw error;
    }
  }

  for (const protectedRoot of protectedConfigRoots) {
    const protectedDatabasePath = join(protectedRoot, "kiro-provider", "accounts.db");
    try {
      const protectedDatabaseStat = statSync(protectedDatabasePath);
      if (
        protectedDatabaseStat.dev === databaseStat.dev &&
        protectedDatabaseStat.ino === databaseStat.ino
      ) {
        throw new Error("The isolated account database must not alias an active database");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("must not alias")) throw error;
      if (!isMissingPath(error)) throw error;
    }
  }

  validateSnapshotDatabase(databasePathReal);
  return root;
}

function requireIsolatedConfigRoot(): string {
  const root = validateIsolatedConfigRoot(argument("--isolated-config-root"));
  process.env.XDG_CONFIG_HOME = root;
  if (process.platform === "win32") process.env.APPDATA = root;
  return root;
}

function hash16(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeProbeErrorCode(value: unknown): string | undefined {
  const candidates = [
    isRecord(value) ? value.code : undefined,
    isRecord(value) ? value.reason : undefined,
    isRecord(value) ? value.name : undefined,
    isRecord(value) && isRecord(value.error) ? value.error.code : undefined,
    isRecord(value) && isRecord(value.error) ? value.error.type : undefined,
  ];
  return candidates.find(
    (candidate): candidate is string =>
      typeof candidate === "string" && SAFE_ERROR_CODES.has(candidate),
  );
}

function statusOf(error: unknown): number {
  if (!isRecord(error) || !isRecord(error.$metadata)) return 0;
  const status = error.$metadata.httpStatusCode;
  return typeof status === "number" && Number.isSafeInteger(status) ? status : 0;
}

function schemaAdherent(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return false;
    const keys = Object.keys(parsed);
    const result = parsed.result;
    return (
      keys.length === 1 &&
      keys[0] === "result" &&
      typeof result === "string" &&
      Array.from(result).length >= 1 &&
      Array.from(result).length <= 8
    );
  } catch {
    return false;
  }
}

function textFromNativeResponse(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.output)) return "";
  return value.output
    .filter(isRecord)
    .filter((item) => item.type === "message" && Array.isArray(item.content))
    .flatMap((item) => item.content as unknown[])
    .filter(isRecord)
    .filter((part) => part.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

async function generateAssistantResponseProbe(
  model: string,
  fields: Readonly<Record<string, unknown>> | undefined,
  proxyUrl: string | undefined,
): Promise<ProbeOutcome> {
  const account = loadProbeAuth();
  const endpoint = KIRO_CONSTANTS.RUNTIME_ENDPOINT.replace("{{region}}", account.auth.region);
  const client = createSdkClient(
    account.auth,
    account.auth.region,
    undefined,
    endpoint,
    proxyUrl,
    account.id,
    false,
    "kiro-runtime",
  );
  const conversationId = crypto.randomUUID();
  const input: GenerateAssistantResponseCommandInput = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId,
      agentContinuationId: crypto.randomUUID(),
      agentTaskType: "vibe",
      currentMessage: {
        userInputMessage: {
          content: SYNTHETIC_PROMPT,
          modelId: model,
          origin: "AI_EDITOR",
        },
      },
    },
    ...(account.auth.profileArn ? { profileArn: account.auth.profileArn } : {}),
    ...(fields
      ? {
          additionalModelRequestFields:
            fields as GenerateAssistantResponseCommandInput["additionalModelRequestFields"],
        }
      : {}),
  };
  const command = new GenerateAssistantResponseCommand(input);
  attachKiroRuntimeRequest(command);
  let text = "";
  let completed = false;
  try {
    const response = await client.send(command, { abortSignal: AbortSignal.timeout(30_000) });
    for await (const event of response.generateAssistantResponseResponse ?? []) {
      text += event.assistantResponseEvent?.content ?? "";
      if (event.metadataEvent?.tokenUsage !== undefined) completed = true;
    }
    return {
      status: response.$metadata.httpStatusCode ?? 200,
      completed,
      textBytes: Buffer.byteLength(text, "utf8"),
      textHash: hash16(text),
      schemaAdherent: completed && schemaAdherent(text),
    };
  } catch (error) {
    return {
      status: statusOf(error),
      ...(safeProbeErrorCode(error) ? { code: safeProbeErrorCode(error) } : {}),
      completed: false,
      textBytes: 0,
      textHash: hash16(""),
      schemaAdherent: false,
    };
  }
}

async function createResponseProbe(
  model: string,
  format: Readonly<Record<string, unknown>> | undefined,
  proxyUrl: string | undefined,
): Promise<ProbeOutcome> {
  const account = loadProbeAuth();
  const endpoint = KIRO_CONSTANTS.RUNTIME_ENDPOINT.replace("{{region}}", account.auth.region);
  const body = JSON.stringify({
    model,
    input: SYNTHETIC_PROMPT,
    stream: false,
    store: false,
    ...(format ? { text: { format } } : {}),
  });
  try {
    const response = await fetch(`${endpoint}/v1/responses`, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${account.auth.access}`,
        "Content-Type": "application/json",
        "User-Agent": "KiroCLI/2.21.1 KAS/0.58.7",
        "x-amzn-kiro-origin": "AI_EDITOR",
        ...(account.auth.profileArn ? { "x-amzn-kiro-profile": account.auth.profileArn } : {}),
      },
      body,
      signal: AbortSignal.timeout(30_000),
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      parsed = undefined;
    }
    const text = textFromNativeResponse(parsed);
    return {
      status: response.status,
      ...(safeProbeErrorCode(parsed) ? { code: safeProbeErrorCode(parsed) } : {}),
      completed: isRecord(parsed) && parsed.status === "completed",
      textBytes: Buffer.byteLength(text, "utf8"),
      textHash: hash16(text),
      schemaAdherent: response.ok && schemaAdherent(text),
      bodyBytes: bytes.byteLength,
      bodyHash: hash16(bytes),
    };
  } catch (error) {
    return {
      status: 0,
      ...(safeProbeErrorCode(error) ? { code: safeProbeErrorCode(error) } : {}),
      completed: false,
      textBytes: 0,
      textHash: hash16(""),
      schemaAdherent: false,
    };
  }
}

export function classifyStructuredOutputProbe(
  outcomes: readonly ProbeOutcome[],
  control?: readonly ProbeOutcome[],
): string {
  const combined = [...outcomes, ...(control ?? [])];
  if (combined.some((outcome) => outcome.status === 401 || outcome.status === 403)) {
    return "unverified_access_denied";
  }
  const controlUsable =
    control !== undefined &&
    control.length >= 2 &&
    control.every((outcome) => outcome.status >= 200 && outcome.status < 300 && outcome.completed);
  const rejectionStatuses = new Set(outcomes.map((outcome) => outcome.status));
  const rejectionCodes = new Set(outcomes.map((outcome) => outcome.code ?? ""));
  const stableFieldRejection =
    outcomes.length >= 2 &&
    rejectionStatuses.size === 1 &&
    rejectionCodes.size === 1 &&
    outcomes.every(
      (outcome) =>
        (outcome.status === 400 || outcome.status === 422) &&
        !outcome.completed &&
        !outcome.schemaAdherent,
    );
  if (stableFieldRejection) {
    return controlUsable ? "field_rejected" : "unverified_control_unavailable";
  }
  if (!controlUsable) return "unverified_control_unavailable";
  const allAdherent =
    outcomes.length >= 2 &&
    outcomes.every(
      (outcome) =>
        outcome.status >= 200 &&
        outcome.status < 300 &&
        outcome.completed &&
        outcome.schemaAdherent,
    );
  const repeatedNonAdherentControl =
    control !== undefined &&
    control.length >= 2 &&
    control.every((outcome) => !outcome.schemaAdherent);
  if (allAdherent && repeatedNonAdherentControl) return "candidate_enforcement_evidence";
  return "enforcement_not_established";
}

async function repeat(
  count: number,
  run: () => Promise<ProbeOutcome>,
): Promise<readonly ProbeOutcome[]> {
  const results: ProbeOutcome[] = [];
  for (let index = 0; index < count; index += 1) results.push(await run());
  return results;
}

async function main(): Promise<void> {
  const model = argument("--model", "gpt-5.6-sol");
  const repeats = Number(argument("--repeats", "2"));
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > MAX_REPEATS) {
    throw new Error(`--repeats must be an integer from 1 to ${MAX_REPEATS}`);
  }
  const proxyUrl = argument("--proxy") || undefined;
  const schemaHash = hash16(JSON.stringify(SCHEMA));
  const cases = [
    "generate_control",
    "generate_output_config_text_format",
    "generate_outputConfig_textFormat",
    "native_control",
    "native_text_format",
  ] as const;
  if (!process.argv.includes(CONFIRM_FLAG)) {
    process.stdout.write(
      `${JSON.stringify({
        schema_version: 1,
        mode: "dry-run",
        model,
        repeats,
        maximum_live_requests: cases.length * repeats,
        cases,
        schema_hash: schemaHash,
        live_confirmation_required: CONFIRM_FLAG,
      })}\n`,
    );
    return;
  }

  process.umask(0o077);
  requireIsolatedConfigRoot();

  const generateControl = await repeat(repeats, () =>
    generateAssistantResponseProbe(model, undefined, proxyUrl),
  );
  const generateSnake = await repeat(repeats, () =>
    generateAssistantResponseProbe(model, { output_config: { text_format: FORMAT } }, proxyUrl),
  );
  const generateCamel = await repeat(repeats, () =>
    generateAssistantResponseProbe(model, { outputConfig: { textFormat: FORMAT } }, proxyUrl),
  );
  const nativeControl = await repeat(repeats, () =>
    createResponseProbe(model, undefined, proxyUrl),
  );
  const nativeFormat = await repeat(repeats, () => createResponseProbe(model, FORMAT, proxyUrl));

  process.stdout.write(
    `${JSON.stringify({
      schema_version: 1,
      mode: "live",
      model,
      repeats,
      schema_hash: schemaHash,
      results: {
        generate_control: generateControl,
        generate_output_config_text_format: {
          classification: classifyStructuredOutputProbe(generateSnake, generateControl),
          outcomes: generateSnake,
        },
        generate_outputConfig_textFormat: {
          classification: classifyStructuredOutputProbe(generateCamel, generateControl),
          outcomes: generateCamel,
        },
        native_control: nativeControl,
        native_text_format: {
          classification: classifyStructuredOutputProbe(nativeFormat, nativeControl),
          outcomes: nativeFormat,
        },
      },
      interpretation:
        "Only repeated schema adherence with a non-adherent control is candidate evidence; HTTP 200 or field acceptance alone is insufficient.",
    })}\n`,
  );
}

if (import.meta.main) await main();
