import { accessTokenExpired } from "../kiro/auth.js";
import { KiroTokenRefreshError } from "../kiro/errors.js";
import { isClientRegistrationExpired } from "../kiro/health.js";
import { refreshAccessToken } from "../kiro/token.js";
import type { KiroAuthDetails, ManagedAccount } from "../kiro/types.js";
import type { StoredAccount } from "../storage/accounts-db.js";
import type { AccountManager } from "./account-manager.js";
import {
  canAdoptRefreshedAccount,
  credentialRefreshBufferMs,
  recordRefreshFailure,
  sameCredentialTuple,
} from "./credential-state.js";
import { abortable } from "./pipeline-runtime.js";

/** Upper bound for one shared network refresh; independent of any caller's signal. */
export const DEFAULT_REFRESH_TIMEOUT_MS = 30_000;

export class AccountUnavailableError extends Error {
  constructor(readonly accountId: string) {
    super(`Account ${accountId} is no longer available`);
    this.name = "AccountUnavailableError";
  }
}

interface RefreshOperation {
  readonly promise: Promise<StoredAccount>;
  /** Access returned by a successful network grant, never by tuple adoption. */
  readonly provenAccessToken?: string;
}

/**
 * Local-mode token refresher.
 *
 * One network refresh is shared per account id regardless of which account
 * generation each caller holds. The shared refresh owns its own bounded
 * lifetime: a caller's AbortSignal only detaches that caller from the result,
 * it never cancels the refresh other callers are waiting on.
 *
 * Any refresh-token-dead failure, including corrupted stored credentials that
 * fail before the network (`MISSING_CREDENTIALS` from toAuthDetails), marks
 * the account needs-relogin before the typed error reaches the caller.
 */
export class TokenRefresher {
  private readonly inFlight = new Map<string, RefreshOperation>();

  constructor(
    private readonly accountManager: AccountManager,
    private readonly tokenExpiryBufferMs: number,
    private readonly proxyUrl?: string,
    private readonly refreshTimeoutMs: number = DEFAULT_REFRESH_TIMEOUT_MS,
  ) {}

  async refreshIfNeeded(
    account: ManagedAccount,
    _auth: KiroAuthDetails,
    signal?: AbortSignal,
  ): Promise<StoredAccount> {
    const current = this.latestAccount(account.id);
    this.assertRefreshAvailable(current);
    if (
      !accessTokenExpired(
        this.authDetails(current),
        credentialRefreshBufferMs(current, this.tokenExpiryBufferMs),
      )
    ) {
      return current;
    }
    return this.startOrJoinRefresh(current, false, signal);
  }

  async forceRefresh(account: ManagedAccount, signal?: AbortSignal): Promise<StoredAccount> {
    return this.startOrJoinRefresh(account, true, signal);
  }

  private latestAccount(accountId: string): StoredAccount {
    const current = this.accountManager.getLatestAccount(accountId);
    if (!current) throw new AccountUnavailableError(accountId);
    return current;
  }

  /** toAuthDetails with dead-credential bookkeeping; rethrows the typed error. */
  private authDetails(account: StoredAccount): KiroAuthDetails {
    try {
      return this.accountManager.toAuthDetails(account);
    } catch (error) {
      recordRefreshFailure(this.accountManager, account, error);
      throw error;
    }
  }

  private assertRefreshAvailable(account: ManagedAccount): void {
    if (isClientRegistrationExpired(account)) {
      const error = new KiroTokenRefreshError(
        "The OIDC client registration expired; re-login is required",
        "CLIENT_REGISTRATION_EXPIRED",
      );
      recordRefreshFailure(this.accountManager, account, error);
      throw error;
    }
    if ((account.refreshRetryAt ?? 0) > Date.now()) {
      throw new KiroTokenRefreshError(
        "Credential refresh is temporarily backed off",
        "REFRESH_BACKOFF",
        undefined,
        { retryAt: account.refreshRetryAt },
      );
    }
  }

  private startOrJoinRefresh(
    account: ManagedAccount,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<StoredAccount> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const existing = this.inFlight.get(account.id);
    const refresh = existing
      ? existing.promise.then((current) => {
          if (
            !sameCredentialTuple(account, current) &&
            !canAdoptRefreshedAccount(account, current, this.tokenExpiryBufferMs)
          ) {
            throw new AccountUnavailableError(account.id);
          }
          if (
            force &&
            current.accessToken === account.accessToken &&
            existing.provenAccessToken !== current.accessToken
          ) {
            // A normal refresh or a force for another rejected token may have
            // merely adopted this still-rejected access. That result cannot
            // authorize this caller's retry: join/start a force for its token.
            // Cancellation detaches a waiter without cancelling shared work,
            // but must not leave a cancelled waiter starting new shared work.
            if (signal?.aborted) throw signal.reason;
            return this.startOrJoinRefresh(current, true, signal);
          }
          return current;
        })
      : this.beginRefresh(account, force);
    return signal ? abortable(refresh, signal) : refresh;
  }

  private beginRefresh(account: ManagedAccount, force: boolean): Promise<StoredAccount> {
    let provenAccessToken: string | undefined;
    const refresh = this.runRefresh(account, force, (access) => {
      provenAccessToken = access;
    }).finally(() => {
      if (this.inFlight.get(account.id)?.promise === refresh) this.inFlight.delete(account.id);
    });
    // A joiner may detach before settlement; keep the shared promise from
    // surfacing as an unhandled rejection when nobody is left awaiting it.
    refresh.catch(() => undefined);
    this.inFlight.set(account.id, {
      promise: refresh,
      get provenAccessToken() {
        return provenAccessToken;
      },
    });
    return refresh;
  }

  private async runRefresh(
    started: ManagedAccount,
    force: boolean,
    recordNetworkGrant: (access: string) => void,
  ): Promise<StoredAccount> {
    const latest = this.latestAccount(started.id);
    try {
      if (!sameCredentialTuple(started, latest)) {
        if (
          (!force || latest.accessToken !== started.accessToken) &&
          canAdoptRefreshedAccount(started, latest, this.tokenExpiryBufferMs)
        )
          return latest;
        throw new AccountUnavailableError(started.id);
      }
      this.assertRefreshAvailable(latest);
      const latestAuth = this.accountManager.toAuthDetails(latest);
      const alreadyRotated =
        !force &&
        !accessTokenExpired(
          latestAuth,
          credentialRefreshBufferMs(latest, this.tokenExpiryBufferMs),
        );
      if (alreadyRotated) return latest;
      const refreshedAuth = await refreshAccessToken(
        latestAuth,
        AbortSignal.timeout(this.refreshTimeoutMs),
        this.proxyUrl,
      );
      recordNetworkGrant(refreshedAuth.access);
      const updated = this.accountManager.updateFromAuth(latest, refreshedAuth);
      if (!updated) throw new AccountUnavailableError(started.id);
      // CAS may have adopted another writer instead of saving this network
      // grant. Only a grant that itself returned the rejected access may keep
      // that same value; a different network grant cannot authenticate a CAS
      // winner that still contains the rejected access.
      if (
        force &&
        updated.accessToken === started.accessToken &&
        updated.accessToken !== refreshedAuth.access
      ) {
        throw new AccountUnavailableError(started.id);
      }
      return updated;
    } catch (error) {
      const current = this.accountManager.getLatestAccount(latest.id);
      if (
        current &&
        (!force || current.accessToken !== started.accessToken) &&
        canAdoptRefreshedAccount(latest, current, this.tokenExpiryBufferMs)
      )
        return current;
      if (error instanceof KiroTokenRefreshError)
        recordRefreshFailure(this.accountManager, latest, error);
      throw error;
    }
  }
}
