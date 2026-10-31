import { createHash } from "node:crypto";
import { decodeRefreshToken } from "../kiro/auth.js";
import { KIRO_AUTH_SERVICE } from "../kiro/constants.js";
import { isQuotaExhausted } from "../kiro/health.js";
import {
  type KiroAvailableProfile,
  KiroManagementError,
  listAvailableProfiles,
} from "../kiro/management-client.js";
import { RegionSchema } from "../kiro/regions.js";
import type {
  KiroAuthDetails,
  KiroRegion,
  KiroUsageSnapshot,
  ManagedAccount,
} from "../kiro/types.js";

// OIDC issuers and Kiro profile control planes have independent regions.
const PROFILE_DISCOVERY_REGIONS: readonly KiroRegion[] = ["us-east-1", "eu-central-1"];

export function normalizeStartUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const url = new URL(value.trim());
  url.hash = "";
  url.search = "";
  url.pathname = `${url.pathname.replace(/\/start\/?$/, "").replace(/\/+$/, "")}/start`;
  return url.toString();
}

export function normalizedEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizedIdentityStartUrl(value: string | undefined): string {
  try {
    return (
      normalizeStartUrl(
        value === undefined || value.trim() === "" ? KIRO_AUTH_SERVICE.BUILDER_ID_START_URL : value,
      ) ?? ""
    );
  } catch {
    return value?.trim() ?? "";
  }
}

/** An omitted start URL selects Builder ID in the device authorization flow. */
export function isBuilderIdStartUrl(value: string | undefined): boolean {
  return (
    normalizedIdentityStartUrl(value) ===
    normalizedIdentityStartUrl(KIRO_AUTH_SERVICE.BUILDER_ID_START_URL)
  );
}

export function isSameLoginIdentity(
  account: ManagedAccount,
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

export function profileRegion(profileArn: string): KiroRegion | undefined {
  const matched = /^arn:[^:]+:codewhisperer:([^:]+):[^:]+:profile\/.+$/u.exec(profileArn);
  if (!matched) return undefined;
  const parsed = RegionSchema.safeParse(matched[1]);
  return parsed.success && PROFILE_DISCOVERY_REGIONS.includes(parsed.data)
    ? parsed.data
    : undefined;
}

export class ProfileAdmissionError extends Error {
  constructor(
    readonly code:
      | "profile_discovery_failed"
      | "no_profile"
      | "ambiguous_profile"
      | "invalid_profile",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProfileAdmissionError";
  }
}

/**
 * Builder ID has no account-scoped profile to discover. This is the same
 * request-scoped service profile used by the shipped Kiro CLI.
 */
export function builderIdServiceProfile(requestedArn?: string): {
  readonly profileArn: string;
  readonly region: KiroRegion;
} {
  if (requestedArn !== undefined && requestedArn !== KIRO_AUTH_SERVICE.BUILDER_ID_PROFILE_ARN) {
    throw new ProfileAdmissionError(
      "invalid_profile",
      "AWS Builder ID cannot be bound to an organization Kiro profile ARN",
    );
  }
  return {
    profileArn: KIRO_AUTH_SERVICE.BUILDER_ID_PROFILE_ARN,
    region: "us-east-1",
  };
}

function selectProfile(
  profiles: readonly KiroAvailableProfile[],
  startUrl: string | undefined,
  requestedArn: string | undefined,
): KiroAvailableProfile {
  if (requestedArn !== undefined) {
    const selected = profiles.find((profile) => profile.arn === requestedArn);
    if (selected) return selected;
    throw new ProfileAdmissionError(
      "invalid_profile",
      "The requested Kiro profile ARN is not available for this identity",
    );
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
    throw new ProfileAdmissionError(
      "no_profile",
      "No available Kiro profile was returned for this identity",
    );
  }
  throw new ProfileAdmissionError(
    "ambiguous_profile",
    `Kiro returned ${profiles.length} available profiles; rerun login with --profile-arn <arn>`,
  );
}

export async function discoverKiroProfile(
  auth: KiroAuthDetails,
  options: {
    readonly requestedArn?: string;
    readonly startUrl?: string;
    readonly proxyUrl?: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly listProfiles?: typeof listAvailableProfiles;
  },
): Promise<{ readonly profileArn: string; readonly region: KiroRegion }> {
  const requestedRegion =
    options.requestedArn === undefined ? undefined : profileRegion(options.requestedArn);
  if (options.requestedArn !== undefined && requestedRegion === undefined) {
    throw new ProfileAdmissionError(
      "invalid_profile",
      "The requested Kiro profile ARN has an unsupported region or invalid format",
    );
  }
  const regions = requestedRegion === undefined ? PROFILE_DISCOVERY_REGIONS : [requestedRegion];
  const listProfiles = options.listProfiles ?? listAvailableProfiles;
  let pages: readonly (readonly KiroAvailableProfile[])[];
  try {
    pages = await Promise.all(
      regions.map((region) =>
        listProfiles({ ...auth, region }, region, {
          proxyUrl: options.proxyUrl,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
        }),
      ),
    );
  } catch (error) {
    const status = error instanceof KiroManagementError ? error.status : undefined;
    throw new ProfileAdmissionError(
      "profile_discovery_failed",
      `Kiro profile discovery failed${status === undefined ? "" : ` (HTTP ${status})`}. No credentials were stored.`,
      { cause: error },
    );
  }
  const profiles = [...new Map(pages.flat().map((profile) => [profile.arn, profile])).values()];
  const profileArn = selectProfile(profiles, options.startUrl, options.requestedArn).arn;
  const region = profileRegion(profileArn);
  if (region === undefined) {
    throw new ProfileAdmissionError(
      "invalid_profile",
      "Kiro profile discovery did not resolve a supported profile ARN",
    );
  }
  return { profileArn, region };
}

/** Both direct login and import construct the same provider-owned account record. */
export function admittedIdcAccount(options: {
  readonly auth: KiroAuthDetails;
  readonly email: string;
  readonly profileArn: string;
  readonly region: KiroRegion;
  readonly usage?: KiroUsageSnapshot;
  readonly startUrl?: string;
  readonly previous?: ManagedAccount;
  readonly now: number;
  readonly quotaRecheckIntervalMs: number;
}): ManagedAccount {
  const { auth, email, profileArn, region, usage, previous, now } = options;
  const refresh = decodeRefreshToken(auth.refresh);
  if (auth.authMethod !== "idc" || !auth.clientId || !auth.clientSecret) {
    throw new TypeError("IDC account admission requires complete client credentials");
  }
  return {
    id:
      previous?.id ??
      createHash("sha256").update(`${email}:idc:${auth.clientId}:${profileArn}`).digest("hex"),
    email,
    authMethod: "idc",
    region,
    oidcRegion: auth.oidcRegion ?? auth.region,
    clientId: auth.clientId,
    clientSecret: auth.clientSecret,
    ...(auth.clientIdIssuedAt === undefined ? {} : { clientIdIssuedAt: auth.clientIdIssuedAt }),
    ...(auth.clientSecretExpiresAt === undefined
      ? {}
      : { clientSecretExpiresAt: auth.clientSecretExpiresAt }),
    ...(options.startUrl ? { startUrl: options.startUrl } : {}),
    profileArn,
    refreshToken: refresh.refreshToken,
    accessToken: auth.access,
    expiresAt: auth.expires,
    rateLimitResetTime: usage && isQuotaExhausted(usage) ? now + options.quotaRecheckIntervalMs : 0,
    isHealthy: true,
    failCount: 0,
    lastUsed: previous?.lastUsed ?? 0,
    usedCount: usage?.usedCount ?? previous?.usedCount ?? 0,
    limitCount: usage?.limitCount ?? previous?.limitCount ?? 0,
    overageCount: usage?.overageCount ?? previous?.overageCount ?? 0,
    lastSync: usage ? now : (previous?.lastSync ?? 0),
  };
}
