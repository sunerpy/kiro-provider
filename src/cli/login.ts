import type { Config } from "../config/schema.js";
import { resolveProxyUrl } from "../core/proxy.js";
import { encodeRefreshToken } from "../kiro/auth.js";
import { listAvailableProfiles } from "../kiro/management-client.js";
import { authorizeKiroIDC, pollKiroIDCToken } from "../kiro/oauth-idc.js";
import { RegionSchema } from "../kiro/regions.js";
import type { KiroAuthDetails, KiroUsageSnapshot, ManagedAccount } from "../kiro/types.js";
import { fetchUsageLimits } from "../kiro/usage-client.js";
import { ACCOUNTS_DB_PATH, AccountsDatabase, type StoredAccount } from "../storage/accounts-db.js";
import {
  admittedIdcAccount,
  builderIdServiceProfile,
  discoverKiroProfile,
  isBuilderIdStartUrl,
  isSameLoginIdentity,
  normalizedEmail,
  normalizeStartUrl,
  profileRegion,
} from "./account-admission.js";

export { normalizeStartUrl } from "./account-admission.js";

/** Email reported by the device-code token endpoint before usage lookup. */
const PLACEHOLDER_EMAIL = "builder-id@aws.amazon.com";

export type LoginOptions = {
  readonly startUrl?: string;
  readonly region?: string;
  readonly profileArn?: string;
  readonly replaceAccount?: StoredAccount;
};

export type LoginResult = {
  readonly account: StoredAccount;
  readonly removedDuplicateIds: readonly string[];
};

export type LoginDependencies = {
  readonly authorize?: typeof authorizeKiroIDC;
  readonly poll?: typeof pollKiroIDCToken;
  readonly listProfiles?: typeof listAvailableProfiles;
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
    oidcRegion: token.region,
    clientId: token.clientId,
    clientSecret: token.clientSecret,
    ...(token.clientIdIssuedAt === undefined ? {} : { clientIdIssuedAt: token.clientIdIssuedAt }),
    ...(token.clientSecretExpiresAt === undefined
      ? {}
      : { clientSecretExpiresAt: token.clientSecretExpiresAt }),
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
  const listProfiles = dependencies.listProfiles ?? listAvailableProfiles;
  const fetchUsage = dependencies.fetchUsage ?? fetchUsageLimits;
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  const replaceAccount = options.replaceAccount;
  if (
    options.profileArn !== undefined &&
    replaceAccount?.profileArn !== undefined &&
    options.profileArn !== replaceAccount.profileArn
  ) {
    throw new Error(
      "Re-login cannot change the Kiro profile bound to an existing account; add the other profile with a new login",
    );
  }
  const startUrl = normalizeStartUrl(options.startUrl ?? replaceAccount?.startUrl);
  const builderIdLogin = isBuilderIdStartUrl(startUrl);
  if (builderIdLogin && options.profileArn !== undefined) {
    builderIdServiceProfile(options.profileArn);
  }
  const oidcRegion = RegionSchema.parse(
    options.region ?? replaceAccount?.oidcRegion ?? replaceAccount?.region ?? config.default_region,
  );
  const proxyUrl = resolveProxyUrl(config);
  const authorization = await authorize(oidcRegion, startUrl, proxyUrl);
  stdout(`Open this URL to sign in:\n${authorization.verificationUriComplete}`);

  const polled = await poll(
    authorization.clientId,
    authorization.clientSecret,
    authorization.deviceCode,
    authorization.interval,
    authorization.expiresIn,
    oidcRegion,
    undefined,
    proxyUrl,
  );
  const token = {
    ...polled,
    // Registration metadata belongs to this login's client tuple only; never
    // inherit it (or refresh failure state) from the replaced account.
    clientIdIssuedAt: authorization.clientIdIssuedAt,
    clientSecretExpiresAt: authorization.clientSecretExpiresAt,
  };
  const refreshedAt = Date.now();
  let profileArn = options.profileArn ?? replaceAccount?.profileArn;
  let region = profileArn === undefined ? undefined : profileRegion(profileArn);
  const knownProfile =
    options.profileArn === undefined && profileArn !== undefined && region !== undefined;
  if (!knownProfile) {
    if (builderIdLogin) {
      ({ profileArn, region } = builderIdServiceProfile(options.profileArn));
    } else {
      ({ profileArn, region } = await discoverKiroProfile(usageAuth(token, oidcRegion, undefined), {
        requestedArn: options.profileArn,
        startUrl,
        proxyUrl,
        timeoutMs: config.quota_recheck_timeout_ms,
        listProfiles,
      }));
    }
  }
  if (profileArn === undefined || region === undefined) {
    throw new Error("Kiro profile discovery did not resolve a supported profile ARN");
  }

  // The token endpoint only yields a placeholder email. Always ask Kiro for
  // the authoritative usage snapshot so the real identity is known before the
  // account ID is derived; a fresh login degrades to the placeholder on
  // failure, a re-login must verify identity and therefore fails closed.
  let usage: KiroUsageSnapshot | undefined;
  try {
    usage = await fetchUsage(usageAuth(token, region, profileArn), {
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
  const loginIdentity = {
    email,
    authMethod: "idc" as const,
    ...(startUrl ? { startUrl } : {}),
    profileArn,
  };

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
        : existingAccounts.filter((candidate) => isSameLoginIdentity(candidate, loginIdentity));
    reusedExisting = sameIdentity[0];
    const previous = replaceAccount ?? reusedExisting;
    const duplicates = replaceAccount
      ? existingAccounts.filter(
          (candidate) =>
            candidate.id !== replaceAccount.id && isSameLoginIdentity(candidate, loginIdentity),
        )
      : sameIdentity.slice(1);

    const account = admittedIdcAccount({
      auth: usageAuth(token, region, profileArn),
      email,
      profileArn,
      region,
      usage,
      startUrl,
      previous,
      now: refreshedAt,
      quotaRecheckIntervalMs: config.quota_recheck_interval_ms,
    });

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
