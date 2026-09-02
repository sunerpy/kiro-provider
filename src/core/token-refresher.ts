import { accessTokenExpired } from '../kiro/auth.js'
import { isRefreshTokenDead, toDeadReason } from '../kiro/health.js'
import { refreshAccessToken } from '../kiro/token.js'
import type { KiroAuthDetails, ManagedAccount } from '../kiro/types.js'
import type { StoredAccount } from '../storage/accounts-db.js'
import { errorReason } from './account-errors.js'
import type { AccountManager } from './account-manager.js'
import { abortable } from './pipeline-runtime.js'

/** Upper bound for one shared network refresh; independent of any caller's signal. */
export const DEFAULT_REFRESH_TIMEOUT_MS = 30_000

export class AccountUnavailableError extends Error {
  constructor(readonly accountId: string) {
    super(`Account ${accountId} is no longer available`)
    this.name = 'AccountUnavailableError'
  }
}


function sameTokenSnapshot(left: ManagedAccount, right: ManagedAccount): boolean {
  return (
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.expiresAt === right.expiresAt
  )
}

/**
 * Local-mode token refresher.
 *
 * One network refresh is shared per account id regardless of which account
 * generation each caller holds. The shared refresh owns its own bounded
 * lifetime: a caller's AbortSignal only detaches that caller from the result,
 * it never cancels the refresh other callers are waiting on.
 */
export class TokenRefresher {
  private readonly inFlight = new Map<string, Promise<StoredAccount>>()

  constructor(
    private readonly accountManager: AccountManager,
    private readonly tokenExpiryBufferMs: number,
    private readonly proxyUrl?: string,
    private readonly refreshTimeoutMs: number = DEFAULT_REFRESH_TIMEOUT_MS
  ) {}

  async refreshIfNeeded(
    account: ManagedAccount,
    _auth: KiroAuthDetails,
    signal?: AbortSignal
  ): Promise<StoredAccount> {
    const current = this.latestAccount(account.id)
    if (!accessTokenExpired(this.accountManager.toAuthDetails(current), this.tokenExpiryBufferMs)) {
      return current
    }
    return this.startOrJoinRefresh(current, false, signal)
  }

  async forceRefresh(account: ManagedAccount, signal?: AbortSignal): Promise<StoredAccount> {
    return this.startOrJoinRefresh(account, true, signal)
  }

  private latestAccount(accountId: string): StoredAccount {
    const current = this.accountManager.getLatestAccount(accountId)
    if (!current) throw new AccountUnavailableError(accountId)
    return current
  }

  private startOrJoinRefresh(
    account: ManagedAccount,
    force: boolean,
    signal?: AbortSignal
  ): Promise<StoredAccount> {
    const existing = this.inFlight.get(account.id)
    const refresh = existing ?? this.beginRefresh(account, force)
    return signal ? abortable(refresh, signal) : refresh
  }

  private beginRefresh(account: ManagedAccount, force: boolean): Promise<StoredAccount> {
    const refresh = this.runRefresh(account, force).finally(() => {
      if (this.inFlight.get(account.id) === refresh) this.inFlight.delete(account.id)
    })
    // A joiner may detach before settlement; keep the shared promise from
    // surfacing as an unhandled rejection when nobody is left awaiting it.
    refresh.catch(() => undefined)
    this.inFlight.set(account.id, refresh)
    return refresh
  }

  private async runRefresh(started: ManagedAccount, force: boolean): Promise<StoredAccount> {
    const latest = this.latestAccount(started.id)
    const latestAuth = this.accountManager.toAuthDetails(latest)
    const alreadyRotated = force
      ? !sameTokenSnapshot(started, latest)
      : !accessTokenExpired(latestAuth, this.tokenExpiryBufferMs)
    if (alreadyRotated) return latest
    try {
      const refreshedAuth = await refreshAccessToken(
        latestAuth,
        AbortSignal.timeout(this.refreshTimeoutMs),
        this.proxyUrl
      )
      const updated = this.accountManager.updateFromAuth(latest, refreshedAuth)
      if (!updated) throw new AccountUnavailableError(started.id)
      return updated
    } catch (error) {
      const reason = errorReason(error)
      if (isRefreshTokenDead(reason)) {
        try {
          this.accountManager.markUnhealthy(latest, toDeadReason(reason))
        } catch {
          // The account may have been removed while the refresh was in flight.
        }
      }
      throw error
    }
  }
}
