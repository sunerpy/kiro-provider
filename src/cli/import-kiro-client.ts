import { createReadStream } from "node:fs";
import { z } from "zod";
import type { Config } from "../config/schema.js";
import { resolveProxyUrl } from "../core/proxy.js";
import { encodeRefreshToken } from "../kiro/auth.js";
import { IDC_REQUEST_TIMEOUT_MS } from "../kiro/oauth-idc.js";
import { RegionSchema } from "../kiro/regions.js";
import { refreshAccessToken } from "../kiro/token.js";
import type { KiroAuthDetails, ManagedAccount } from "../kiro/types.js";
import { fetchUsageLimits } from "../kiro/usage-client.js";
import { ACCOUNTS_DB_PATH, AccountsDatabase } from "../storage/accounts-db.js";
import {
  admittedIdcAccount,
  builderIdServiceProfile,
  discoverKiroProfile,
  normalizedEmail,
  ProfileAdmissionError,
} from "./account-admission.js";
import { acquireImportLease, type ImportLease, ImportLeaseError } from "./import-lease.js";

export const KIRO_CLIENT_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const KIRO_CLIENT_IMPORT_MAX_ACCOUNTS = 250;

const emailSchema = z.string().trim().min(1).max(320).email();
// The internal refresh serialization uses '|'; never allow an input field to
// change which client/secret is paired with a refresh token during decoding.
const secretSchema = z
  .string()
  .min(1)
  .max(16_384)
  .refine((value) => value.trim().length > 0 && !value.includes("|"));
const timestampSchema = z.number().finite().int().nonnegative().max(253_402_300_799_000);
const credentialSchema = z
  .object({
    email: emailSchema,
    authMethod: z.literal("idc"),
    provider: z.enum(["BuilderId", "IamIdentityCenter"]).optional(),
    oidcRegion: RegionSchema,
    clientId: secretSchema,
    clientSecret: secretSchema,
    refreshToken: secretSchema,
    clientIdIssuedAt: timestampSchema.optional(),
    clientSecretExpiresAt: timestampSchema.optional(),
  })
  .strict();
const legacySchema = credentialSchema
  .omit({ authMethod: true, oidcRegion: true })
  .extend({
    provider: z.literal("BuilderId"),
    region: RegionSchema,
  })
  .strip();

type Credential = z.infer<typeof credentialSchema> & { readonly builderId: boolean };
type InputRow = { readonly legacy: boolean; readonly value: unknown };
type ImportDatabase = Pick<AccountsDatabase, "getAccounts" | "insertAccountIfAbsent" | "close">;

export type KiroClientImportOptions = {
  readonly from: string;
  readonly force?: boolean;
};

export type KiroClientImportResult = {
  readonly imported: number;
  readonly skipped: number;
  readonly failed: number;
  readonly total: number;
};

export type KiroClientImportDependencies = {
  readonly stdout: (message: string) => void;
  readonly openDb?: () => ImportDatabase;
  readonly input?: AsyncIterable<Uint8Array>;
  readonly refreshTimeoutMs?: number;
  readonly lockPath?: string;
  readonly acquireLease?: typeof acquireImportLease;
};

/** Only fixed messages cross the CLI boundary; upstream bodies and parse details are secret. */
class ImportInputError extends Error {
  constructor(readonly code: string) {
    super(`Kiro-client import rejected: ${code}`);
    this.name = "ImportInputError";
  }
}

async function readRows(
  options: KiroClientImportOptions,
  dependencies: KiroClientImportDependencies,
): Promise<readonly InputRow[]> {
  let input: AsyncIterable<Uint8Array>;
  if (options.from === "-") input = dependencies.input ?? process.stdin;
  else input = createReadStream(options.from);
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of input) {
      size += chunk.byteLength;
      if (size > KIRO_CLIENT_IMPORT_MAX_BYTES) throw new ImportInputError("input_too_large");
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof ImportInputError) throw error;
    throw new ImportInputError("input_unreadable");
  }
  let value: unknown;
  try {
    // TextDecoder accepts a Windows UTF-8 BOM and rejects malformed UTF-8.
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new ImportInputError("invalid_json");
  }
  const legacy = Array.isArray(value);
  let accounts: unknown[];
  if (Array.isArray(value)) accounts = value;
  else {
    const parsed = z
      .object({
        format: z.literal("kiro-provider-accounts"),
        version: z.literal(1),
        accounts: z.array(z.unknown()),
      })
      .strict()
      .safeParse(value);
    if (!parsed.success) throw new ImportInputError("invalid_format");
    accounts = parsed.data.accounts;
  }
  if (accounts.length === 0) throw new ImportInputError("empty_accounts");
  if (accounts.length > KIRO_CLIENT_IMPORT_MAX_ACCOUNTS)
    throw new ImportInputError("too_many_accounts");
  return accounts.map((value) => ({ legacy, value }));
}

function credential(row: InputRow): Credential | undefined {
  if (!row.legacy) {
    const parsed = credentialSchema.safeParse(row.value);
    return parsed.success
      ? { ...parsed.data, builderId: parsed.data.provider === "BuilderId" }
      : undefined;
  }
  const parsed = legacySchema.safeParse(row.value);
  if (!parsed.success) return undefined;
  const { provider: _provider, region, ...fields } = parsed.data;
  return { ...fields, authMethod: "idc", oidcRegion: region, builderId: true };
}

function sameTuple(account: ManagedAccount, incoming: Credential): boolean {
  return (
    account.authMethod === "idc" &&
    (account.oidcRegion ?? account.region) === incoming.oidcRegion &&
    account.clientId === incoming.clientId &&
    account.clientSecret === incoming.clientSecret &&
    account.refreshToken === incoming.refreshToken
  );
}

async function verifyCredential(
  incoming: Credential,
  config: Config,
  refreshTimeoutMs: number,
  lease: ImportLease,
): Promise<ManagedAccount> {
  const proxyUrl = resolveProxyUrl(config);
  const originalAuth: KiroAuthDetails = {
    authMethod: "idc",
    region: incoming.oidcRegion,
    oidcRegion: incoming.oidcRegion,
    refresh: encodeRefreshToken({ ...incoming, authMethod: "idc" }),
    access: "",
    expires: 0,
    clientId: incoming.clientId,
    clientSecret: incoming.clientSecret,
    ...(incoming.clientIdIssuedAt === undefined
      ? {}
      : { clientIdIssuedAt: incoming.clientIdIssuedAt }),
    ...(incoming.clientSecretExpiresAt === undefined
      ? {}
      : { clientSecretExpiresAt: incoming.clientSecretExpiresAt }),
  };
  let auth: KiroAuthDetails;
  try {
    lease.assertHeld();
    auth = await refreshAccessToken(
      originalAuth,
      AbortSignal.any([lease.signal, AbortSignal.timeout(refreshTimeoutMs)]),
      proxyUrl,
    );
  } catch {
    throw new ImportInputError("refresh_failed");
  }
  lease.assertHeld();
  const profile = incoming.builderId
    ? builderIdServiceProfile()
    : await discoverKiroProfile(auth, {
        proxyUrl,
        timeoutMs: config.quota_recheck_timeout_ms,
        signal: lease.signal,
      });
  lease.assertHeld();
  let usage: Awaited<ReturnType<typeof fetchUsageLimits>>;
  try {
    usage = await fetchUsageLimits(
      { ...auth, ...profile },
      {
        proxyUrl,
        timeoutMs: config.quota_recheck_timeout_ms,
        signal: lease.signal,
      },
    );
  } catch {
    throw new ImportInputError("identity_verification_failed");
  }
  lease.assertHeld();
  const verifiedEmail = emailSchema.safeParse(usage.email);
  if (
    !verifiedEmail.success ||
    normalizedEmail(verifiedEmail.data) === "builder-id@aws.amazon.com"
  ) {
    throw new ImportInputError("identity_unavailable");
  }
  if (normalizedEmail(verifiedEmail.data) !== normalizedEmail(incoming.email)) {
    throw new ImportInputError("email_mismatch");
  }
  return admittedIdcAccount({
    auth,
    email: verifiedEmail.data,
    ...profile,
    usage,
    now: Date.now(),
    quotaRecheckIntervalMs: config.quota_recheck_interval_ms,
  });
}

export async function runKiroClientImport(
  config: Config,
  options: KiroClientImportOptions,
  dependencies: KiroClientImportDependencies,
): Promise<KiroClientImportResult> {
  // This adapter only adds new identities. Existing credentials must use re-login.
  if (options.force) throw new ImportInputError("force_unsupported_use_accounts_relogin");
  const rows = await readRows(options, dependencies);
  if (
    dependencies.openDb !== undefined &&
    dependencies.lockPath === undefined &&
    dependencies.acquireLease === undefined
  ) {
    throw new ImportInputError("explicit_import_lock_required");
  }
  let lease: ImportLease;
  try {
    lease = await (dependencies.acquireLease ?? acquireImportLease)({
      path: dependencies.lockPath ?? `${ACCOUNTS_DB_PATH}.import`,
    });
  } catch (error) {
    if (error instanceof ImportLeaseError) throw error;
    throw new ImportInputError("import_lock_unavailable");
  }
  try {
    lease.assertHeld();
    return await importWithLease(config, rows, dependencies, lease);
  } finally {
    await releaseImportLease(lease);
  }
}

async function releaseImportLease(lease: ImportLease): Promise<void> {
  try {
    await lease.release();
  } catch {
    throw new ImportInputError("import_lock_release_failed");
  }
}

async function importWithLease(
  config: Config,
  rows: readonly InputRow[],
  dependencies: KiroClientImportDependencies,
  lease: ImportLease,
): Promise<KiroClientImportResult> {
  let database: ImportDatabase;
  try {
    database = dependencies.openDb?.() ?? new AccountsDatabase(ACCOUNTS_DB_PATH);
  } catch {
    throw new ImportInputError("authentication_store_unavailable");
  }
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let result: KiroClientImportResult | undefined;
  let failure: ImportInputError | ImportLeaseError | undefined;
  const emails = new Set<string>();
  const tuples = new Set<string>();
  const report = (index: number, status: "imported" | "skipped" | "failed", reason: string) => {
    dependencies.stdout(`Entry ${index + 1}: ${status} (${reason})`);
  };
  try {
    for (const [index, row] of rows.entries()) {
      const incoming = credential(row);
      if (incoming === undefined) {
        failed += 1;
        report(index, "failed", "invalid_account");
        continue;
      }
      const email = normalizedEmail(incoming.email);
      const tuple = JSON.stringify([
        incoming.oidcRegion,
        incoming.clientId,
        incoming.clientSecret,
        incoming.refreshToken,
      ]);
      if (tuples.has(tuple) && !emails.has(email)) {
        failed += 1;
        report(index, "failed", "duplicate_credentials");
        continue;
      }
      if (emails.has(email) || tuples.has(tuple)) {
        skipped += 1;
        report(index, "skipped", "duplicate_input");
        continue;
      }
      emails.add(email);
      tuples.add(tuple);
      try {
        lease.assertHeld();
        const existing = database.getAccounts();
        if (
          existing.some(
            (account) => account.authMethod === "idc" && normalizedEmail(account.email) === email,
          )
        ) {
          skipped += 1;
          report(index, "skipped", "existing_account");
          continue;
        }
        if (existing.some((account) => sameTuple(account, incoming))) {
          failed += 1;
          report(index, "failed", "credential_identity_conflict");
          continue;
        }
        if (
          incoming.clientSecretExpiresAt !== undefined &&
          incoming.clientSecretExpiresAt <= Date.now()
        ) {
          failed += 1;
          report(index, "failed", "expired_client_registration");
          continue;
        }
        const account = await verifyCredential(
          incoming,
          config,
          dependencies.refreshTimeoutMs ?? IDC_REQUEST_TIMEOUT_MS,
          lease,
        );
        lease.assertHeld();
        if (database.insertAccountIfAbsent(account)) {
          imported += 1;
          report(index, "imported", "verified");
        } else {
          skipped += 1;
          report(index, "skipped", "existing_or_changed_account");
        }
      } catch (error) {
        if (lease.signal.aborted || error instanceof ImportLeaseError)
          throw new ImportLeaseError("import_lock_compromised");
        failed += 1;
        const reason =
          error instanceof ProfileAdmissionError
            ? error.code
            : error instanceof ImportInputError
              ? error.code
              : "account_import_failed";
        report(index, "failed", reason);
      }
    }
    lease.assertHeld();
    const total = database.getAccounts().length;
    result = { imported, skipped, failed, total };
  } catch (error) {
    failure =
      error instanceof ImportLeaseError || error instanceof ImportInputError
        ? error
        : new ImportInputError("authentication_store_unavailable");
  }
  try {
    database.close();
  } catch {
    failure ??= new ImportInputError("authentication_store_unavailable");
  }
  if (failure !== undefined) throw failure;
  if (result === undefined) throw new ImportInputError("authentication_store_unavailable");
  dependencies.stdout(
    `Imported ${result.imported}, skipped ${result.skipped}, failed ${result.failed}, total in DB now ${result.total}`,
  );
  return result;
}
