import { createHash } from "node:crypto";
import type { Config } from "../config/schema.js";
import { resolveProxyUrl } from "../core/proxy.js";
import { encodeRefreshToken } from "../kiro/auth.js";
import { isQuotaExhausted } from "../kiro/health.js";
import { type KiroAvailableProfile, listAvailableProfiles } from "../kiro/management-client.js";
import { authorizeKiroIDC, pollKiroIDCToken } from "../kiro/oauth-idc.js";
import { RegionSchema } from "../kiro/regions.js";
import type {
  KiroAuthDetails,
  KiroRegion,
  KiroUsageSnapshot,
  ManagedAccount,
} from "../kiro/types.js";
import { fetchUsageLimits } from "../kiro/usage-client.js";
import { ACCOUNTS_DB_PATH, AccountsDatabase, type StoredAccount } from "../storage/accounts-db.js";

/** Email reported by the device-code token endpoint before usage lookup. */
const PLACEHOLDER_EMAIL = "builder-id@aws.amazon.com";

// Kiro's commercial profile control plane is currently exposed in these two
// regions. An IdC token can own a profile in either region independently of the
// OIDC region that issued it, so profile discovery must not assume they match.
const PROFILE_DISCOVERY_REGIONS: readonly KiroRegion[] = ["us-east-1", "eu-central-1"];

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

export function normalizeStartUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const url = new URL(value.trim());
  url.hash = "";
  url.search = "";
  url.pathname = `${url.pathname.replace(/\/start\/?$/, "").replace(/\/+$/, "")}/start`;
  return url.toString();
}

function accountId(email: string, clientId: string, profileArn: string): string {
  return createHash("sha256").update(`${email}:idc:${clientId}:${profileArn}`).digest("hex");
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

function profileRegion(profileArn: string): KiroRegion | undefined {
  const matched = /^arn:[^:]+:codewhisperer:([^:]+):[^:]+:profile\/.+$/u.exec(profileArn);
  if (!matched) return undefined;
  const parsed = RegionSchema.safeParse(matched[1]);
  return parsed.success && PROFILE_DISCOVERY_REGIONS.includes(parsed.data)
    ? parsed.data
    : undefined;
}

function selectProfile(
  profiles: readonly KiroAvailableProfile[],
  startUrl: string | undefined,
  requestedArn: string | undefined,
): KiroAvailableProfile {
  if (requestedArn !== undefined) {
    const selected = profiles.find((profile) => profile.arn === requestedArn);
    if (selected) return selected;
    throw new Error("The requested Kiro profile ARN is not available for this identity");
  }
  if (startUrl !== undefined) {
    const matching = profiles.filter(
      (profile) =>
        profile.startUrl !== undefined &&
        normalizedIdentityStartUrl(profile.startUrl) === normalizedIdentityStartUrl(startUrl),
    );
    if (matching.length === 1) return matching[0] as KiroAvailableProfile;
  }
  if (profiles.length === 1) return profiles[0] as KiroAvailableProfile;
  if (profiles.length === 0) {
    throw new Error("No available Kiro profile was returned for this identity");
  }
  throw new Error(
    `Kiro returned ${profiles.length} available profiles; rerun login with --profile-arn <arn>`,
  );
}

function discoveryRegions(requestedArn: string | undefined): readonly KiroRegion[] {
  if (requestedArn === undefined) return PROFILE_DISCOVERY_REGIONS;
  const region = profileRegion(requestedArn);
  if (region === undefined) {
    throw new Error("The requested Kiro profile ARN has an unsupported region or invalid format");
  }
  return [region];
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
  const oidcRegion = RegionSchema.parse(
    options.region ?? replaceAccount?.oidcRegion ?? replaceAccount?.region ?? config.default_region,
  );
  const proxyUrl = resolveProxyUrl(config);
  const authorization = await authorize(oidcRegion, startUrl, proxyUrl);
  stdout(`Open this URL to sign in:\n${authorization.verificationUriComplete}`);

  const token = await poll(
    authorization.clientId,
    authorization.clientSecret,
    authorization.deviceCode,
    authorization.interval,
    authorization.expiresIn,
    oidcRegion,
    undefined,
    proxyUrl,
  );
  const refreshedAt = Date.now();
  let profileArn = options.profileArn ?? replaceAccount?.profileArn;
  let region = profileArn === undefined ? undefined : profileRegion(profileArn);
  const knownProfile =
    options.profileArn === undefined && profileArn !== undefined && region !== undefined;
  if (!knownProfile) {
    const regions = discoveryRegions(options.profileArn);
    let profilePages: readonly (readonly KiroAvailableProfile[])[];
    try {
      profilePages = await Promise.all(
        regions.map((profileRegion) =>
          listProfiles(usageAuth(token, profileRegion, undefined), profileRegion, {
            proxyUrl,
            timeoutMs: config.quota_recheck_timeout_ms,
          }),
        ),
      );
    } catch (error) {
      throw new Error(
        `Kiro profile discovery failed: ${errorMessage(error)}. No credentials were stored.`,
        { cause: error },
      );
    }
    const profiles = [
      ...new Map(profilePages.flat().map((profile) => [profile.arn, profile])).values(),
    ];
    profileArn = selectProfile(profiles, startUrl, options.profileArn).arn;
    region = profileRegion(profileArn);
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

    const account: ManagedAccount = {
      id: previous?.id ?? accountId(email, token.clientId, profileArn),
      email,
      authMethod: "idc",
      region,
      oidcRegion,
      clientId: token.clientId,
      clientSecret: token.clientSecret,
      ...(startUrl ? { startUrl } : {}),
      ...(profileArn ? { profileArn } : {}),
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
