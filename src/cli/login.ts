import { createHash } from "node:crypto";
import type { Config } from "../config/schema.js";
import { resolveProxyUrl } from "../core/proxy.js";
import { encodeRefreshToken } from "../kiro/auth.js";
import { isQuotaExhausted } from "../kiro/health.js";
import { authorizeKiroIDC, pollKiroIDCToken } from "../kiro/oauth-idc.js";
import { RegionSchema } from "../kiro/regions.js";
import type { KiroAuthDetails, KiroUsageSnapshot, ManagedAccount } from "../kiro/types.js";
import { fetchUsageLimits } from "../kiro/usage-client.js";
import { ACCOUNTS_DB_PATH, AccountsDatabase, type StoredAccount } from "../storage/accounts-db.js";

/** Email reported by the device-code token endpoint before usage lookup. */
const PLACEHOLDER_EMAIL = "builder-id@aws.amazon.com";

export type LoginOptions = {
  readonly startUrl?: string;
  readonly region?: string;
  readonly replaceAccount?: StoredAccount;
};

export type LoginResult = {
  readonly account: StoredAccount;
  readonly removedDuplicateIds: readonly string[];
};

export type LoginDependencies = {
  readonly authorize?: typeof authorizeKiroIDC;
  readonly poll?: typeof pollKiroIDCToken;
  readonly fetchUsage?: typeof fetchUsageLimits;
  readonly openDb?: (
    path: string,
  ) => Pick<AccountsDatabase, "getAccounts" | "insertAccount" | "removeAccount" | "close">;
  readonly stdout?: (message: string) => void;
  readonly stderr?: (message: string) => void;
};

export class ReloginIdentityMismatchError extends Error {
  constructor(
    readonly expectedEmail: string,
    readonly actualEmail: string,
  ) {
    super(
      `Re-login authenticated ${actualEmail}, but the selected account is ${expectedEmail}. No credentials were changed.`,
    );
    this.name = "ReloginIdentityMismatchError";
  }
}

export function normalizeStartUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const url = new URL(value.trim());
  url.hash = "";
  url.search = "";
  url.pathname = `${url.pathname.replace(/\/start\/?$/, "").replace(/\/+$/, "")}/start`;
  return url.toString();
}

function accountId(email: string, clientId: string): string {
  return createHash("sha256").update(`${email}:idc:${clientId}:`).digest("hex");
}

function normalizedEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizedIdentityStartUrl(value: string | undefined): string {
  try {
    return normalizeStartUrl(value) ?? "";
  } catch {
    return value?.trim() ?? "";
  }
}

function isSameLoginIdentity(
  account: StoredAccount,
  reference: Pick<ManagedAccount, "email" | "authMethod" | "startUrl" | "profileArn">,
): boolean {
  return (
    normalizedEmail(account.email) === normalizedEmail(reference.email) &&
    account.authMethod === reference.authMethod &&
    normalizedIdentityStartUrl(account.startUrl) ===
      normalizedIdentityStartUrl(reference.startUrl) &&
    (account.profileArn ?? "") === (reference.profileArn ?? "")
  );
}

function usageAuth(
  token: Awaited<ReturnType<typeof pollKiroIDCToken>>,
  region: ManagedAccount["region"],
  profileArn: string | undefined,
): KiroAuthDetails {
  return {
    refresh: encodeRefreshToken({
      refreshToken: token.refreshToken,
      clientId: token.clientId,
      clientSecret: token.clientSecret,
      authMethod: "idc",
    }),
    access: token.accessToken,
    expires: token.expiresAt,
    authMethod: "idc",
    region,
    oidcRegion: region,
    clientId: token.clientId,
    clientSecret: token.clientSecret,
    email: token.email,
    ...(profileArn ? { profileArn } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runLogin(
  config: Config,
  options: LoginOptions = {},
  dependencies: LoginDependencies = {},
): Promise<LoginResult> {
  const authorize = dependencies.authorize ?? authorizeKiroIDC;
  const poll = dependencies.poll ?? pollKiroIDCToken;
  const fetchUsage = dependencies.fetchUsage ?? fetchUsageLimits;
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  const replaceAccount = options.replaceAccount;
  const startUrl = normalizeStartUrl(options.startUrl ?? replaceAccount?.startUrl);
  const region = RegionSchema.parse(
    options.region ?? replaceAccount?.oidcRegion ?? replaceAccount?.region ?? config.default_region,
  );
  const proxyUrl = resolveProxyUrl(config);
  const authorization = await authorize(region, startUrl, proxyUrl);
  stdout(`Open this URL to sign in:\n${authorization.verificationUriComplete}`);

  const token = await poll(
    authorization.clientId,
    authorization.clientSecret,
    authorization.deviceCode,
    authorization.interval,
    authorization.expiresIn,
    region,
    undefined,
    proxyUrl,
  );
  const refreshedAt = Date.now();

  // The token endpoint only yields a placeholder email. Always ask Kiro for
  // the authoritative usage snapshot so the real identity is known before the
  // account ID is derived; a fresh login degrades to the placeholder on
  // failure, a re-login must verify identity and therefore fails closed.
  let usage: KiroUsageSnapshot | undefined;
  try {
    usage = await fetchUsage(usageAuth(token, region, replaceAccount?.profileArn), {
      proxyUrl,
      timeoutMs: config.quota_recheck_timeout_ms,
    });
  } catch (error) {
    if (replaceAccount) {
      throw new Error(
        `Kiro usage verification failed: ${errorMessage(error)}. No credentials were changed.`,
        { cause: error },
      );
    }
    stderr(
      `Warning: could not fetch Kiro usage to determine the account email (${errorMessage(error)}); storing the placeholder ${token.email}. Run "kiro-provider accounts refresh --all" once the network recovers.`,
    );
  }

  let email = token.email;
  if (replaceAccount) {
    if (!usage?.email) {
      throw new Error(
        "Kiro usage verification did not return an account email. No credentials were changed.",
      );
    }
    email = usage.email;
    const selectedEmail = normalizedEmail(replaceAccount.email);
    if (selectedEmail !== PLACEHOLDER_EMAIL && selectedEmail !== normalizedEmail(email)) {
      throw new ReloginIdentityMismatchError(replaceAccount.email, email);
    }
  } else if (usage?.email) {
    email = usage.email;
  } else if (usage) {
    stderr(
      `Warning: Kiro usage did not include an account email; storing the placeholder ${token.email}.`,
    );
  }
  const identityVerified = usage?.email !== undefined && normalizedEmail(usage.email) !== "";

  const database =
    dependencies.openDb?.(ACCOUNTS_DB_PATH) ?? new AccountsDatabase(ACCOUNTS_DB_PATH);
  const removedDuplicateIds: string[] = [];
  let persisted: StoredAccount;
  let reusedExisting: StoredAccount | undefined;
  try {
    const existingAccounts = database.getAccounts();
    if (replaceAccount && !existingAccounts.some(({ id }) => id === replaceAccount.id)) {
      throw new Error(
        `Account ${replaceAccount.id} was removed while re-login was in progress. No credentials were changed.`,
      );
    }
    // Fresh login: when the identity is verified, an existing row for the
    // same person (email + auth method + start URL + profile) is updated in
    // place instead of inserting a second row with a new client ID.
    const sameIdentity =
      replaceAccount || !identityVerified
        ? []
        : existingAccounts.filter((candidate) =>
            isSameLoginIdentity(candidate, {
              email,
              authMethod: "idc",
              ...(startUrl ? { startUrl } : {}),
            }),
          );
    reusedExisting = sameIdentity[0];
    const previous = replaceAccount ?? reusedExisting;
    const duplicates = replaceAccount
      ? existingAccounts.filter(
          (candidate) =>
            candidate.id !== replaceAccount.id && isSameLoginIdentity(candidate, replaceAccount),
        )
      : sameIdentity.slice(1);

    const account: ManagedAccount = {
      id: previous?.id ?? accountId(email, token.clientId),
      email,
      authMethod: "idc",
      region,
      oidcRegion: region,
      clientId: token.clientId,
      clientSecret: token.clientSecret,
      ...(startUrl ? { startUrl } : {}),
      ...(replaceAccount?.profileArn ? { profileArn: replaceAccount.profileArn } : {}),
      refreshToken: token.refreshToken,
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      rateLimitResetTime:
        usage && isQuotaExhausted(usage) ? refreshedAt + config.quota_recheck_interval_ms : 0,
      isHealthy: true,
      failCount: 0,
      lastUsed: previous?.lastUsed ?? 0,
      usedCount: usage?.usedCount ?? previous?.usedCount ?? 0,
      limitCount: usage?.limitCount ?? previous?.limitCount ?? 0,
      overageCount: usage?.overageCount ?? previous?.overageCount ?? 0,
      lastSync: usage ? refreshedAt : (previous?.lastSync ?? 0),
    };

    persisted = database.insertAccount(account);
    for (const duplicate of duplicates) {
      database.removeAccount(duplicate.id);
      removedDuplicateIds.push(duplicate.id);
    }
  } finally {
    database.close();
  }
  if (replaceAccount) {
    stdout(`Re-login successful: ${persisted.email} [${persisted.id}]`);
  } else if (reusedExisting) {
    stdout(`Login successful: ${persisted.email} [${persisted.id}] (updated existing account)`);
  } else {
    stdout(`Login successful: ${persisted.email}`);
  }
  if (removedDuplicateIds.length > 0) {
    stdout(`Removed ${removedDuplicateIds.length} duplicate account record(s).`);
  }
  return { account: persisted, removedDuplicateIds };
}
