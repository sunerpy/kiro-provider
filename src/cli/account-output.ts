import type { AccountRefreshSummary } from "../core/quota-rechecker.js";
import { isPermanentError, isQuotaExhausted } from "../kiro/health.js";
import type { StoredAccount } from "../storage/accounts-db.js";

export type AccountListMode = "table" | "details" | "json";

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

function accountAvailability(account: StoredAccount, now = Date.now()): string {
  if (isPermanentError(account.unhealthyReason)) return "needs-relogin";
  if (isQuotaExhausted(account)) return "quota-exhausted";
  if (account.rateLimitResetTime > now) return "rate-limited";
  if (!account.isHealthy) return "unhealthy";
  return "available";
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

function accountJson(account: StoredAccount): Readonly<Record<string, unknown>> {
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
    availability: accountAvailability(account),
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
): string[] {
  const sorted = [...accounts].sort(
    (left, right) => left.email.localeCompare(right.email) || left.id.localeCompare(right.id),
  );
  if (mode === "json") {
    return [JSON.stringify(sorted.map(accountJson), null, 2)];
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
        accountAvailability(account),
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
      accountAvailability(account),
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
