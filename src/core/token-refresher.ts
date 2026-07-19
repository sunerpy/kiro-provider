import { accessTokenExpired } from '../kiro/auth.js'
import { refreshAccessToken } from '../kiro/token.js'
import type { KiroAuthDetails, ManagedAccount } from '../kiro/types.js'
import type { StoredAccount } from '../storage/accounts-db.js'
import type { AccountManager } from './account-manager.js'

export class AccountUnavailableError extends Error {
  constructor(readonly accountId: string) {
    super(`Account ${accountId} is no longer available`)
    this.name = 'AccountUnavailableError'
  }
}

export class TokenRefresher {
  private readonly inFlight = new Map<string, Promise<StoredAccount>>()

  constructor(
    private readonly accountManager: AccountManager,
    private readonly tokenExpiryBufferMs: number,
    private readonly proxyUrl?: string
  ) {}

  async refreshIfNeeded(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    signal?: AbortSignal
  ): Promise<StoredAccount> {
    if (!accessTokenExpired(auth, this.tokenExpiryBufferMs)) {
      const current = this.accountManager.getAccounts().find(({ id }) => id === account.id)
      if (!current) throw new AccountUnavailableError(account.id)
      return current
    }
    return this.startOrJoinRefresh(account, auth, signal)
  }

  async forceRefresh(account: ManagedAccount, signal?: AbortSignal): Promise<StoredAccount> {
    return this.startOrJoinRefresh(account, this.accountManager.toAuthDetails(account), signal)
  }

  private startOrJoinRefresh(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    signal?: AbortSignal
  ): Promise<StoredAccount> {
    if (!('generation' in account) || typeof account.generation !== 'number') {
      throw new AccountUnavailableError(account.id)
    }
    const refreshAccount: StoredAccount = { ...account, generation: account.generation }
    const refreshKey = `${refreshAccount.id}:${refreshAccount.generation}`
    const existing = this.inFlight.get(refreshKey)
    if (existing) return existing

    const refresh = this.runRefresh(refreshAccount, auth, signal).finally(() => {
      if (this.inFlight.get(refreshKey) === refresh) this.inFlight.delete(refreshKey)
    })
    this.inFlight.set(refreshKey, refresh)
    return refresh
  }

  private async runRefresh(
    account: StoredAccount,
    auth: KiroAuthDetails,
    signal?: AbortSignal
  ): Promise<StoredAccount> {
    const refreshedAuth = await refreshAccessToken(auth, signal, this.proxyUrl)
    const updated = this.accountManager.updateFromAuth(account, refreshedAuth)
    if (!updated) throw new AccountUnavailableError(account.id)
    return updated
  }
}
