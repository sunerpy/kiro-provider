import { decodeRefreshToken, encodeRefreshToken } from '../kiro/auth.js'
import { isAccessTokenError, isPermanentError } from '../kiro/health.js'
import type {
  AccountSelectionStrategy,
  KiroAuthDetails,
  ManagedAccount
} from '../kiro/types.js'
import type { AccountsDatabase, StoredAccount } from '../storage/accounts-db.js'

const MAX_CAS_ATTEMPTS = 4

type AccountPatch = (account: StoredAccount) => StoredAccount

export class AccountConcurrentUpdateError extends Error {
  constructor(readonly accountId: string) {
    super(`Account ${accountId} changed too frequently to update`)
    this.name = 'AccountConcurrentUpdateError'
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported account selection strategy: ${String(value)}`)
}

function cloneAccount(account: StoredAccount): StoredAccount {
  return { ...account }
}

export function toAuthDetails(account: ManagedAccount): KiroAuthDetails {
  return {
    refresh: encodeRefreshToken({
      refreshToken: account.refreshToken,
      authMethod: account.authMethod,
      ...(account.clientId ? { clientId: account.clientId } : {}),
      ...(account.clientSecret ? { clientSecret: account.clientSecret } : {}),
      ...(account.profileArn ? { profileArn: account.profileArn } : {})
    }),
    access: account.accessToken,
    expires: account.expiresAt,
    authMethod: account.authMethod,
    region: account.region,
    ...(account.oidcRegion ? { oidcRegion: account.oidcRegion } : {}),
    ...(account.clientId ? { clientId: account.clientId } : {}),
    ...(account.clientSecret ? { clientSecret: account.clientSecret } : {}),
    ...(account.email ? { email: account.email } : {}),
    ...(account.profileArn ? { profileArn: account.profileArn } : {})
  }
}

export class AccountManager {
  private accounts: StoredAccount[]
  private stickyId: string | undefined
  private roundRobinCursor = 0

  constructor(
    accounts: readonly StoredAccount[],
    private readonly strategy: AccountSelectionStrategy,
    private readonly database: AccountsDatabase
  ) {
    this.accounts = accounts.map(cloneAccount)
  }

  getAccountCount(): number {
    return this.accounts.length
  }

  getAccounts(): StoredAccount[] {
    return this.accounts.map(cloneAccount)
  }

  getMinWaitTime(): number {
    const now = Date.now()
    const waits = this.accounts
      .map(({ rateLimitResetTime }) => rateLimitResetTime - now)
      .filter((wait) => wait > 0)
    return waits.length === 0 ? 0 : Math.min(...waits)
  }

  reconcileFromDb(database: AccountsDatabase = this.database): StoredAccount[] {
    const currentById = new Map(this.accounts.map((account) => [account.id, account]))
    this.accounts = database.getAccounts().map((row) => {
      const current = currentById.get(row.id)
      return current?.generation === row.generation ? current : cloneAccount(row)
    })
    if (this.stickyId && !this.accounts.some(({ id }) => id === this.stickyId)) {
      this.stickyId = undefined
    }
    return this.getAccounts()
  }

  selectHealthyAccount(): StoredAccount | null {
    const now = Date.now()
    const candidates = this.accounts
      .filter((account) => this.isSelectable(account, now))
      .sort((left, right) => left.id.localeCompare(right.id))
    if (candidates.length === 0) return null

    const selected = this.selectCandidate(candidates)
    return (
      this.patchAccount(selected.id, (latest) => ({
        ...latest,
        isHealthy: true,
        unhealthyReason: undefined,
        recoveryTime: undefined,
        lastUsed: now,
        usedCount: (latest.usedCount ?? 0) + 1
      })) ?? null
    )
  }

  getCurrentOrNext(): StoredAccount | null {
    return this.selectHealthyAccount()
  }

  markRateLimited(account: ManagedAccount, resetTime: number): StoredAccount | undefined {
    return this.patchAccount(account.id, (latest) => ({
      ...latest,
      rateLimitResetTime: resetTime
    }))
  }

  markUnhealthy(
    account: ManagedAccount,
    reason: string,
    recoveryTime?: number
  ): StoredAccount | undefined {
    const now = Date.now()
    return this.patchAccount(account.id, (latest) => {
      if (isPermanentError(reason)) {
        return {
          ...latest,
          failCount: 10,
          isHealthy: false,
          unhealthyReason: reason,
          recoveryTime: undefined,
          lastUsed: now
        }
      }

      const failCount = latest.failCount + 1
      return {
        ...latest,
        failCount,
        isHealthy: failCount < 10,
        unhealthyReason: reason,
        recoveryTime: failCount >= 10 ? (recoveryTime ?? now + 3_600_000) : undefined,
        lastUsed: now
      }
    })
  }

  updateFromAuth(account: StoredAccount, auth: KiroAuthDetails): StoredAccount | undefined {
    const refresh = decodeRefreshToken(auth.refresh)
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = attempt === 0 ? account : this.database.getById(account.id)
      if (!current || !this.isSameLogin(account, current)) {
        this.reconcileFromDb()
        return undefined
      }
      const updated: StoredAccount = {
        ...current,
        refreshToken: refresh.refreshToken,
        accessToken: auth.access,
        expiresAt: auth.expires
      }
      if (this.database.updateExistingAccounts([updated]) === 1) {
        const persisted = { ...updated, generation: current.generation + 1 }
        this.replaceAccount(persisted)
        return cloneAccount(persisted)
      }
    }
    this.reconcileFromDb()
    return undefined
  }

  toAuthDetails(account: ManagedAccount): KiroAuthDetails {
    return toAuthDetails(account)
  }

  private isSelectable(account: StoredAccount, now: number): boolean {
    if (isPermanentError(account.unhealthyReason)) return false
    if (account.rateLimitResetTime > now) return false
    if (account.isHealthy || isAccessTokenError(account.unhealthyReason)) return true
    return account.recoveryTime !== undefined && account.recoveryTime <= now
  }

  private isSameLogin(started: StoredAccount, current: StoredAccount): boolean {
    return (
      current.refreshToken === started.refreshToken &&
      current.authMethod === started.authMethod &&
      current.clientId === started.clientId &&
      current.email === started.email &&
      current.startUrl === started.startUrl
    )
  }

  private selectCandidate(candidates: readonly StoredAccount[]): StoredAccount {
    switch (this.strategy) {
      case 'sticky': {
        const sticky = candidates.find(({ id }) => id === this.stickyId)
        const selected = sticky ?? candidates[0]
        if (!selected) throw new RangeError('Candidate list cannot be empty')
        this.stickyId = selected.id
        return selected
      }
      case 'round-robin': {
        const selected = candidates[this.roundRobinCursor % candidates.length]
        if (!selected) throw new RangeError('Candidate list cannot be empty')
        this.roundRobinCursor += 1
        return selected
      }
      case 'lowest-usage': {
        const selected = [...candidates].sort(
          (left, right) =>
            (left.usedCount ?? 0) - (right.usedCount ?? 0) ||
            (left.lastUsed ?? 0) - (right.lastUsed ?? 0) ||
            left.id.localeCompare(right.id)
        )[0]
        if (!selected) throw new RangeError('Candidate list cannot be empty')
        return selected
      }
      default:
        return assertNever(this.strategy)
    }
  }

  private patchAccount(id: string, patch: AccountPatch): StoredAccount | undefined {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const latest = this.database.getById(id)
      if (!latest) {
        this.accounts = this.accounts.filter((account) => account.id !== id)
        return undefined
      }
      const updated = patch(latest)
      if (this.database.updateExistingAccounts([updated]) === 1) {
        const persisted = { ...updated, generation: latest.generation + 1 }
        this.replaceAccount(persisted)
        return cloneAccount(persisted)
      }
    }
    this.reconcileFromDb()
    throw new AccountConcurrentUpdateError(id)
  }

  private replaceAccount(account: StoredAccount): void {
    const index = this.accounts.findIndex(({ id }) => id === account.id)
    if (index === -1) this.accounts.push(account)
    else this.accounts[index] = account
  }
}
