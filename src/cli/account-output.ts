import type { AccountRefreshSummary } from "../core/quota-rechecker.js";
import {
  DEFAULT_OVERAGE_POLICY,
  isIncludedQuotaExhausted,
  isOverageBlocked,
  isPermanentError,
  type OveragePolicy,
} from "../kiro/health.js";
import type { StoredAccount } from "../storage/accounts-db.js";

export type AccountListMode = "table" | "details" | "json";

/**
 * Why an account is or is not selectable, in priority order. `quota-exhausted`
 * is the included quota (usedCount >= limitCount); `overage-blocked` is paid
 * overage above the configured threshold while stop_on_overage is on.
 */
export type AccountAvailability =
  | "needs-relogin"
  | "quota-exhausted"
  | "overage-blocked"
  | "rate-limited"
  | "unhealthy"
  | "available";

/**
 * Columns `accounts list --sort` accepts. `usage` is the used/limit ratio
 * rather than the raw counter, so accounts with different quotas stay
 * comparable; `overage` is the paid overage counter.
 */
export const ACCOUNT_SORT_FIELDS = [
  "email",
  "id",
  "auth",
  "region",
  "health",
  "availability",
  "usage",
  "overage",
  "last-sync",
  "last-used",
  "token-expires",
  "generation",
] as const;

export type AccountSortField = (typeof ACCOUNT_SORT_FIELDS)[number];

export const ACCOUNT_SORT_ORDERS = ["asc", "desc"] as const;

export type AccountSortOrder = (typeof ACCOUNT_SORT_ORDERS)[number];

export type AccountListSort = {
  readonly field: AccountSortField;
  readonly order: AccountSortOrder;
};

/** `accounts list` keeps sorting by email ascending when no flag is given. */
export const DEFAULT_ACCOUNT_SORT: AccountListSort = { field: "email", order: "asc" };

export function isAccountSortField(value: string): value is AccountSortField {
  return (ACCOUNT_SORT_FIELDS as readonly string[]).includes(value);
}

export function isAccountSortOrder(value: string): value is AccountSortOrder {
  return (ACCOUNT_SORT_ORDERS as readonly string[]).includes(value);
}

/**
 * Availability ordered from most to least usable so `--sort availability`
 * ascending answers "what can the scheduler pick right now", with transient
 * states above quota gates and the permanently dead accounts last.
 */
const AVAILABILITY_RANK: Readonly<Record<AccountAvailability, number>> = {
  available: 0,
  "rate-limited": 1,
  unhealthy: 2,
  "overage-blocked": 3,
  "quota-exhausted": 4,
  "needs-relogin": 5,
};

export class AccountNotFoundError extends Error {
  constructor(readonly identifier: string) {
    super(`Account not found: ${identifier}`);
    this.name = "AccountNotFoundError";
  }
}

export class AmbiguousAccountError extends Error {
  constructor(
    readonly identifier: string,
    readonly accountIds: readonly string[],
  ) {
    super(
      `Account identifier is ambiguous: ${identifier}. Matching account IDs: ${accountIds.join(", ")}`,
    );
    this.name = "AmbiguousAccountError";
  }
}

function normalizedEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveAccount(
  accounts: readonly StoredAccount[],
  identifier: string,
): StoredAccount {
  const exactId = accounts.find((account) => account.id === identifier);
  if (exactId) return exactId;

  const email = normalizedEmail(identifier);
  const matches = accounts.filter((account) => normalizedEmail(account.email) === email);
  if (matches.length === 0) throw new AccountNotFoundError(identifier);
  if (matches.length > 1) {
    throw new AmbiguousAccountError(identifier, matches.map(({ id }) => id).sort());
  }
  return matches[0] as StoredAccount;
}

export function accountAvailability(
  account: StoredAccount,
  policy: OveragePolicy = DEFAULT_OVERAGE_POLICY,
  now = Date.now(),
): AccountAvailability {
  if (isPermanentError(account.unhealthyReason)) return "needs-relogin";
  if (isIncludedQuotaExhausted(account)) return "quota-exhausted";
  if (isOverageBlocked(account, policy)) return "overage-blocked";
  if (account.rateLimitResetTime > now) return "rate-limited";
  if (!account.isHealthy) return "unhealthy";
  return "available";
}

/** `undefined` marks "this account has no value for the selected column". */
type SortKey = string | number | undefined;

function positiveTimestamp(value: number | undefined): number | undefined {
  return value !== undefined && value > 0 ? value : undefined;
}

function usageRatio(account: StoredAccount): number | undefined {
  const limit = account.limitCount ?? 0;
  if (limit <= 0) return undefined;
  return (account.usedCount ?? 0) / limit;
}

/**
 * A non-finite numeric key would break the comparator: `NaN` compares equal to
 * every value, which makes the ordering intransitive and the result dependent on
 * row order. Upstream quota JSON can carry `1e9999`, which parses to `Infinity`,
 * so such a key is treated as "no value" and sorts last like any other gap.
 */
function sortKey(
  account: StoredAccount,
  field: AccountSortField,
  policy: OveragePolicy,
  now: number,
): SortKey {
  const key = rawSortKey(account, field, policy, now);
  return typeof key === "number" && !Number.isFinite(key) ? undefined : key;
}

function rawSortKey(
  account: StoredAccount,
  field: AccountSortField,
  policy: OveragePolicy,
  now: number,
): SortKey {
  switch (field) {
    case "email":
      return normalizedEmail(account.email);
    case "id":
      return account.id;
    case "auth":
      return account.authMethod;
    case "region":
      return account.region;
    case "health":
      return account.isHealthy ? 0 : 1;
    case "availability":
      return AVAILABILITY_RANK[accountAvailability(account, policy, now)];
    case "usage":
      return usageRatio(account);
    case "overage":
      return account.overageCount ?? 0;
    case "last-sync":
      return positiveTimestamp(account.lastSync);
    case "last-used":
      return positiveTimestamp(account.lastUsed);
    case "token-expires":
      return positiveTimestamp(account.expiresAt);
    case "generation":
      return account.generation;
  }
}

function compareKeys(left: SortKey, right: SortKey): number {
  if (typeof left === "string" && typeof right === "string") return left.localeCompare(right);
  if (typeof left === "number" && typeof right === "number") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return 0;
}

/**
 * Sorts by one column with a stable email/id tiebreak. Accounts with no value
 * for the column (unknown quota, never synced) always land at the bottom, in
 * both directions, so `--order desc` cannot fill the top of the list with
 * placeholders.
 */
export function sortAccounts(
  accounts: readonly StoredAccount[],
  sort: AccountListSort = DEFAULT_ACCOUNT_SORT,
  policy: OveragePolicy = DEFAULT_OVERAGE_POLICY,
  now = Date.now(),
): StoredAccount[] {
  const descending = sort.order === "desc";
  return accounts
    .map((account) => ({
      account,
      key: sortKey(account, sort.field, policy, now),
      email: normalizedEmail(account.email),
    }))
    .sort((left, right) => {
      if (left.key === undefined || right.key === undefined) {
        if (left.key !== right.key) return left.key === undefined ? 1 : -1;
      } else {
        const compared = compareKeys(left.key, right.key);
        if (compared !== 0) return descending ? -compared : compared;
      }
      return (
        left.email.localeCompare(right.email) || left.account.id.localeCompare(right.account.id)
      );
    })
    .map(({ account }) => account);
}

function formatUsage(account: StoredAccount): string {
  const used = account.usedCount ?? 0;
  const limit = account.limitCount ?? 0;
  return limit > 0 ? `${used}/${limit}` : `${used}/unknown`;
}

function formatTimestamp(value: number | undefined): string {
  if (!value || value <= 0) return "-";
  return new Date(value).toISOString();
}

function jsonTimestamp(value: number | undefined): string | null {
  if (!value || value <= 0) return null;
  return new Date(value).toISOString();
}

function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const render = (row: readonly string[]): string =>
    row
      .map((cell, index) =>
        index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? cell.length),
      )
      .join("  ")
      .trimEnd();
  return [render(headers), render(widths.map((width) => "-".repeat(width))), ...rows.map(render)];
}

function accountJson(
  account: StoredAccount,
  policy: OveragePolicy,
  now: number,
): Readonly<Record<string, unknown>> {
  const used = account.usedCount ?? 0;
  const limit = account.limitCount ?? 0;
  return {
    id: account.id,
    email: account.email,
    auth_method: account.authMethod,
    region: account.region,
    oidc_region: account.oidcRegion ?? null,
    start_url: account.startUrl ?? null,
    health: account.isHealthy ? "healthy" : "unhealthy",
    availability: accountAvailability(account, policy, now),
    unhealthy_reason: account.unhealthyReason ?? null,
    used_count: used,
    limit_count: limit,
    overage_count: account.overageCount ?? 0,
    usage_ratio: limit > 0 ? used / limit : null,
    last_sync: jsonTimestamp(account.lastSync),
    last_used: jsonTimestamp(account.lastUsed),
    token_expires_at: jsonTimestamp(account.expiresAt),
    rate_limit_reset_at: jsonTimestamp(account.rateLimitResetTime),
    generation: account.generation,
  };
}

export function formatAccountList(
  accounts: readonly StoredAccount[],
  mode: AccountListMode,
  policy: OveragePolicy = DEFAULT_OVERAGE_POLICY,
  sort: AccountListSort = DEFAULT_ACCOUNT_SORT,
  now = Date.now(),
): string[] {
  const sorted = sortAccounts(accounts, sort, policy, now);
  if (mode === "json") {
    return [
      JSON.stringify(
        sorted.map((account) => accountJson(account, policy, now)),
        null,
        2,
      ),
    ];
  }
  if (mode === "details") {
    return renderTable(
      [
        "ID",
        "EMAIL",
        "AUTH",
        "REGION",
        "HEALTH",
        "AVAILABILITY",
        "USAGE",
        "OVERAGE",
        "LAST_SYNC",
        "TOKEN_EXPIRES",
        "RECHECK_AT",
        "GENERATION",
      ],
      sorted.map((account) => [
        account.id,
        account.email,
        account.authMethod,
        account.region,
        account.isHealthy ? "healthy" : "unhealthy",
        accountAvailability(account, policy, now),
        formatUsage(account),
        String(account.overageCount ?? 0),
        formatTimestamp(account.lastSync),
        formatTimestamp(account.expiresAt),
        formatTimestamp(account.rateLimitResetTime),
        String(account.generation),
      ]),
    );
  }
  return renderTable(
    ["EMAIL", "REGION", "HEALTH", "AVAILABILITY", "USAGE"],
    sorted.map((account) => [
      account.email,
      account.region,
      account.isHealthy ? "healthy" : "unhealthy",
      accountAvailability(account, policy, now),
      formatUsage(account),
    ]),
  );
}

export function formatAccountRefreshSummary(
  summary: AccountRefreshSummary,
  json: boolean,
): string[] {
  if (json) return [JSON.stringify(summary, null, 2)];
  const lines = [
    `Refreshed ${summary.totalAccounts} accounts · ${summary.tokenRenewed} token renewed · ${summary.usageUpdated} usage updated · ${summary.failed} failed`,
  ];
  for (const account of summary.accounts) {
    const error = account.error ? ` · ${account.error}` : "";
    lines.push(
      `- ${account.email} [${account.accountId}] — ${account.before.usedCount}/${account.before.limitCount} → ${account.after.usedCount}/${account.after.limitCount} · token ${account.tokenStatus} · usage ${account.usageStatus}${error}`,
    );
  }
  return lines;
}
