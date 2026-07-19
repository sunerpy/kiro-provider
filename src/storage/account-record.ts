import type { ManagedAccount } from '../kiro/types.js'

export interface StoredAccount extends ManagedAccount {
  generation: number
}

export interface AccountRow {
  id: string
  email: string
  auth_method: ManagedAccount['authMethod']
  region: ManagedAccount['region']
  oidc_region: ManagedAccount['oidcRegion'] | null
  client_id: string | null
  client_secret: string | null
  profile_arn: string | null
  start_url: string | null
  refresh_token: string
  access_token: string
  expires_at: number
  rate_limit_reset: number
  is_healthy: number
  unhealthy_reason: string | null
  recovery_time: number | null
  fail_count: number
  last_used: number
  used_count: number
  limit_count: number
  last_sync: number
  overage_count: number
  generation: number
}

export function accountToRow(account: ManagedAccount, generation: number): AccountRow {
  return {
    id: account.id,
    email: account.email,
    auth_method: account.authMethod,
    region: account.region,
    oidc_region: account.oidcRegion ?? null,
    client_id: account.clientId ?? null,
    client_secret: account.clientSecret ?? null,
    profile_arn: account.profileArn ?? null,
    start_url: account.startUrl ?? null,
    refresh_token: account.refreshToken,
    access_token: account.accessToken,
    expires_at: account.expiresAt,
    rate_limit_reset: account.rateLimitResetTime,
    is_healthy: account.isHealthy ? 1 : 0,
    unhealthy_reason: account.unhealthyReason ?? null,
    recovery_time: account.recoveryTime ?? null,
    fail_count: account.failCount,
    last_used: account.lastUsed ?? 0,
    used_count: account.usedCount ?? 0,
    limit_count: account.limitCount ?? 0,
    last_sync: account.lastSync ?? 0,
    overage_count: account.overageCount ?? 0,
    generation
  }
}

export function rowToAccount(row: AccountRow): StoredAccount {
  return {
    id: row.id,
    email: row.email,
    authMethod: row.auth_method,
    region: row.region,
    oidcRegion: row.oidc_region ?? undefined,
    clientId: row.client_id ?? undefined,
    clientSecret: row.client_secret ?? undefined,
    profileArn: row.profile_arn ?? undefined,
    startUrl: row.start_url ?? undefined,
    refreshToken: row.refresh_token,
    accessToken: row.access_token,
    expiresAt: row.expires_at,
    rateLimitResetTime: row.rate_limit_reset,
    isHealthy: row.is_healthy === 1,
    unhealthyReason: row.unhealthy_reason ?? undefined,
    recoveryTime: row.recovery_time ?? undefined,
    failCount: row.fail_count,
    lastUsed: row.last_used,
    usedCount: row.used_count,
    limitCount: row.limit_count,
    lastSync: row.last_sync,
    overageCount: row.overage_count,
    generation: row.generation
  }
}

export function rowBindings(row: AccountRow): (string | number | null)[] {
  return [
    row.id, row.email, row.auth_method, row.region ?? null, row.oidc_region ?? null,
    row.client_id ?? null, row.client_secret ?? null, row.profile_arn ?? null,
    row.start_url ?? null, row.refresh_token,
    row.access_token, row.expires_at, row.rate_limit_reset, row.is_healthy,
    row.unhealthy_reason ?? null, row.recovery_time ?? null, row.fail_count, row.last_used,
    row.used_count, row.limit_count, row.last_sync, row.overage_count, row.generation
  ]
}
