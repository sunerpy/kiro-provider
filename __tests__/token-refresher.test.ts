import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountManager } from '../src/core/account-manager.js'
import { AccountUnavailableError, TokenRefresher } from '../src/core/token-refresher.js'
import type { KiroAuthDetails, ManagedAccount } from '../src/kiro/types.js'
import { AccountsDatabase } from '../src/storage/accounts-db.js'

const realFetch = globalThis.fetch
const databases: AccountsDatabase[] = []
const temporaryDirectories: string[] = []

function installFetch(handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): void {
  globalThis.fetch = Object.assign(handler, { preconnect: realFetch.preconnect })
}

function createFixture(): {
  readonly database: AccountsDatabase
  readonly databasePath: string
  readonly manager: AccountManager
  readonly account: ReturnType<AccountsDatabase['insertAccount']>
  readonly auth: KiroAuthDetails
} {
  const directory = mkdtempSync(join(tmpdir(), 'kiro-provider-refresher-'))
  const databasePath = join(directory, 'accounts.db')
  const database = new AccountsDatabase(databasePath)
  const account = database.insertAccount(managedAccount())
  const manager = new AccountManager([account], 'sticky', database)
  databases.push(database)
  temporaryDirectories.push(directory)
  return { database, databasePath, manager, account, auth: manager.toAuthDetails(account) }
}

function managedAccount(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: 'account-A',
    email: 'account-a@example.com',
    authMethod: 'desktop',
    region: 'us-east-1',
    refreshToken: 'old-refresh',
    accessToken: 'old-access',
    expiresAt: Date.now() - 1,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    ...overrides
  }
}

function refreshResponse(): Response {
  return new Response(
    JSON.stringify({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresIn: 3600
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

function refreshResponseWith(accessToken: string, refreshToken: string): Response {
  return new Response(JSON.stringify({ accessToken, refreshToken, expiresIn: 3600 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  if (!resolvePromise) throw new Error('Deferred resolver was not initialized')
  return { promise, resolve: resolvePromise }
}

afterEach(() => {
  globalThis.fetch = realFetch
  for (const database of databases.splice(0)) database.close()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('TokenRefresher', () => {
  test('returns an unexpired account without a network refresh', async () => {
    // Given
    const fixture = createFixture()
    const refresher = new TokenRefresher(fixture.manager, 300_000)
    fixture.auth.expires = Date.now() + 600_000
    let fetchCalls = 0
    installFetch(async () => {
      fetchCalls += 1
      return refreshResponse()
    })

    // When
    const result = await refresher.refreshIfNeeded(fixture.account, fixture.auth)

    // Then
    expect(result.accessToken).toBe('old-access')
    expect(fetchCalls).toBe(0)
  })

  test('refreshes an expired token and persists it through CAS', async () => {
    // Given
    const fixture = createFixture()
    const refresher = new TokenRefresher(fixture.manager, 300_000)
    installFetch(async () => refreshResponse())

    // When
    const result = await refresher.refreshIfNeeded(fixture.account, fixture.auth)

    // Then
    expect(result.accessToken).toBe('new-access')
    expect(result.refreshToken).toBe('new-refresh')
    expect(fixture.database.getById(fixture.account.id)?.accessToken).toBe('new-access')
    expect(fixture.database.getById(fixture.account.id)?.generation).toBe(
      fixture.account.generation + 1
    )
  })

  test.each([
    { label: 'configured', proxyUrl: 'http://p:1080', expectedProxyUrl: 'http://p:1080' },
    { label: 'disabled', proxyUrl: undefined, expectedProxyUrl: undefined }
  ])('passes the $label proxy URL to token refresh', async ({ proxyUrl, expectedProxyUrl }) => {
    // Given
    const fixture = createFixture()
    const refresher = new TokenRefresher(fixture.manager, 300_000, proxyUrl)
    let capturedProxyUrl: string | undefined
    installFetch(async (_input, init) => {
      capturedProxyUrl =
        init !== undefined && 'proxy' in init && typeof init.proxy === 'string'
          ? init.proxy
          : undefined
      return refreshResponse()
    })

    // When
    await refresher.refreshIfNeeded(fixture.account, fixture.auth)

    // Then
    expect(capturedProxyUrl).toBe(expectedProxyUrl)
  })

  test('deduplicates two concurrent refreshIfNeeded calls for the same account', async () => {
    // Given
    const fixture = createFixture()
    const refresher = new TokenRefresher(fixture.manager, 300_000)
    const started = deferred()
    const release = deferred()
    let fetchCalls = 0
    installFetch(async () => {
      fetchCalls += 1
      started.resolve()
      await release.promise
      return refreshResponse()
    })

    // When
    const first = refresher.refreshIfNeeded(fixture.account, fixture.auth)
    await started.promise
    const second = refresher.refreshIfNeeded(fixture.account, fixture.auth)
    expect(fetchCalls).toBe(1)
    release.resolve()
    const results = await Promise.all([first, second])

    // Then
    expect(fetchCalls).toBe(1)
    expect(results.map(({ accessToken }) => accessToken)).toEqual(['new-access', 'new-access'])
    expect(fixture.database.getById(fixture.account.id)?.generation).toBe(
      fixture.account.generation + 1
    )
  })

  test('persists a refresh after a benign same-login generation bump', async () => {
    // Given
    const fixture = createFixture()
    const concurrentDatabase = new AccountsDatabase(fixture.databasePath)
    databases.push(concurrentDatabase)
    const refresher = new TokenRefresher(fixture.manager, 300_000)
    const started = deferred()
    const release = deferred()
    installFetch(async () => {
      started.resolve()
      await release.promise
      return refreshResponseWith('refreshed-access', 'rotated-refresh')
    })
    const refresh = refresher.refreshIfNeeded(fixture.account, fixture.auth)
    await started.promise
    const current = concurrentDatabase.getById(fixture.account.id)
    expect(current).toBeDefined()
    if (!current) return
    expect(
      concurrentDatabase.updateExistingAccounts([
        { ...current, usedCount: (current.usedCount ?? 0) + 1, lastUsed: 42 }
      ])
    ).toBe(1)

    // When
    release.resolve()
    const refreshed = await refresh

    // Then
    expect(refreshed.accessToken).toBe('refreshed-access')
    expect(refreshed.refreshToken).toBe('rotated-refresh')
    expect(refreshed.usedCount).toBe(1)
    expect(refreshed.lastUsed).toBe(42)
    expect(concurrentDatabase.getById(fixture.account.id)).toMatchObject({
      accessToken: 'refreshed-access',
      refreshToken: 'rotated-refresh',
      usedCount: 1,
      lastUsed: 42
    })
  })

  test('discards a stale refresh after same-id relogin advances the generation', async () => {
    // Given
    const fixture = createFixture()
    const externalDatabase = new AccountsDatabase(fixture.databasePath)
    databases.push(externalDatabase)
    const refresher = new TokenRefresher(fixture.manager, 300_000)
    const started = deferred()
    const release = deferred()
    installFetch(async () => {
      started.resolve()
      await release.promise
      return refreshResponseWith('stale-rotated-access', 'stale-rotated-refresh')
    })
    const staleRefresh = refresher.refreshIfNeeded(fixture.account, fixture.auth)
    await started.promise
    externalDatabase.removeAccount(fixture.account.id)
    const relogged = externalDatabase.insertAccount(
      managedAccount({
        refreshToken: 'fresh-login-refresh',
        accessToken: 'fresh-login-access',
        expiresAt: Date.now() + 3_600_000
      })
    )

    // When
    release.resolve()

    // Then
    await expect(staleRefresh).rejects.toBeInstanceOf(AccountUnavailableError)
    expect(fixture.database.getById(fixture.account.id)).toEqual(relogged)
  })

  test('does not deduplicate refreshes for different generations of the same account', async () => {
    // Given
    const fixture = createFixture()
    const refresher = new TokenRefresher(fixture.manager, 300_000)
    const firstStarted = deferred()
    const releaseFirst = deferred()
    let fetchCalls = 0
    installFetch(async () => {
      fetchCalls += 1
      if (fetchCalls === 1) {
        firstStarted.resolve()
        await releaseFirst.promise
        return refreshResponseWith('generation-1-access', 'generation-1-refresh')
      }
      return refreshResponseWith('generation-2-access', 'generation-2-refresh')
    })
    const first = refresher.forceRefresh(fixture.account)
    await firstStarted.promise
    const generationTwo = { ...fixture.account, generation: fixture.account.generation + 1 }

    // When
    const second = refresher.forceRefresh(generationTwo)
    releaseFirst.resolve()
    await Promise.allSettled([first, second])

    // Then
    expect(fetchCalls).toBe(2)
  })

  test('forceRefresh threads the AbortSignal and abort cancellation rejects', async () => {
    // Given
    const fixture = createFixture()
    const refresher = new TokenRefresher(fixture.manager, 300_000)
    const controller = new AbortController()
    const abortError = new DOMException('The operation was aborted', 'AbortError')
    let capturedSignal: AbortSignal | null | undefined
    installFetch(async (_input, init) => {
      capturedSignal = init?.signal
      controller.abort()
      throw abortError
    })

    // When / Then
    await expect(refresher.forceRefresh(fixture.account, controller.signal)).rejects.toBe(abortError)
    expect(capturedSignal).toBe(controller.signal)
  })
})
