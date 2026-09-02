import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import {
  AccountConcurrentUpdateError,
  AccountManager,
  toAuthDetails
} from '../src/core/account-manager.js'
import { clearSdkClientCache, createSdkClient } from '../src/core/sdk-client.js'
import type { ManagedAccount } from '../src/kiro/types.js'
import { AccountsDatabase } from '../src/storage/accounts-db.js'

const databases: AccountsDatabase[] = []
const temporaryDirectories: string[] = []

function createDatabasePair(): readonly [AccountsDatabase, AccountsDatabase] {
  const directory = mkdtempSync(join(tmpdir(), 'kiro-provider-manager-'))
  const path = join(directory, 'accounts.db')
  const first = new AccountsDatabase(path)
  const second = new AccountsDatabase(path)
  databases.push(first, second)
  temporaryDirectories.push(directory)
  return [first, second]
}

function account(id: string, overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id,
    email: `${id.toLowerCase()}@example.com`,
    authMethod: 'desktop',
    region: 'us-east-1',
    refreshToken: `refresh-${id}`,
    accessToken: `access-${id}`,
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 0,
    limitCount: 100,
    ...overrides
  }
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('AccountManager health persistence', () => {
  test('marks a permanent failure unhealthy and skips the account', () => {
    // Given
    const [db] = createDatabasePair()
    const first = db.insertAccount(account('A'))
    const second = db.insertAccount(account('B'))
    const manager = new AccountManager([first, second], 'sticky', db)

    // When
    const updated = manager.markUnhealthy(first, 'invalid_grant: Refresh failed: Invalid refresh token provided')

    // Then
    expect(updated?.isHealthy).toBeFalse()
    expect(updated?.failCount).toBe(10)
    expect(db.getById('A')?.unhealthyReason).toBe('invalid_grant: Refresh failed: Invalid refresh token provided')
    expect(manager.selectHealthyAccount()?.id).toBe('B')
  })

  test('marks an account rate-limited until an absolute reset time', () => {
    // Given
    const [db] = createDatabasePair()
    const first = db.insertAccount(account('A'))
    const second = db.insertAccount(account('B'))
    const manager = new AccountManager([first, second], 'sticky', db)
    const resetTime = Date.now() + 60_000

    // When
    const updated = manager.markRateLimited(first, resetTime)

    // Then
    expect(updated?.rateLimitResetTime).toBe(resetTime)
    expect(db.getById('A')?.rateLimitResetTime).toBe(resetTime)
    expect(manager.getCurrentOrNext()?.id).toBe('B')
  })

  test('persists an authoritative quota exhaustion signal and skips the account', () => {
    const [db] = createDatabasePair()
    const first = db.insertAccount(account('A', { usedCount: 90, limitCount: 100 }))
    const second = db.insertAccount(account('B', { usedCount: 20, limitCount: 100 }))
    const manager = new AccountManager([first, second], 'sticky', db)
    const recheckAfter = Date.now() + 60_000

    const updated = manager.markQuotaExhausted(first, recheckAfter)

    expect(updated).toMatchObject({
      usedCount: 100,
      limitCount: 100,
      rateLimitResetTime: recheckAfter
    })
    expect(db.getById('A')).toMatchObject({
      usedCount: 100,
      rateLimitResetTime: recheckAfter
    })
    expect(manager.selectHealthyAccount()?.id).toBe('B')
  })

  test('restores exact quota usage without overwriting a concurrent token update', () => {
    const [managerDb, externalDb] = createDatabasePair()
    const stale = managerDb.insertAccount(
      account('A', {
        usedCount: 100,
        limitCount: 100,
        rateLimitResetTime: Date.now() - 1,
        lastSync: 10
      })
    )
    const manager = new AccountManager([stale], 'sticky', managerDb)
    externalDb.updateExistingAccounts([{ ...stale, accessToken: 'external-access' }])

    const updated = manager.updateQuotaUsage(
      stale,
      {
        usedCount: 0,
        limitCount: 100,
        overageCount: 0,
        lastSync: 20
      },
      0
    )

    expect(updated).toMatchObject({
      accessToken: 'external-access',
      usedCount: 0,
      limitCount: 100,
      overageCount: 0,
      lastSync: 20,
      rateLimitResetTime: 0
    })
    expect(manager.selectHealthyAccount()?.id).toBe('A')
  })

  test('does not overwrite a newer external quota snapshot', () => {
    const [managerDb, externalDb] = createDatabasePair()
    const stale = managerDb.insertAccount(
      account('A', { usedCount: 100, limitCount: 100, lastSync: 10 })
    )
    const manager = new AccountManager([stale], 'sticky', managerDb)
    externalDb.updateExistingAccounts([
      {
        ...stale,
        usedCount: 5,
        limitCount: 100,
        lastSync: 30,
        rateLimitResetTime: 0
      }
    ])

    const updated = manager.updateQuotaUsage(
      stale,
      {
        usedCount: 100,
        limitCount: 100,
        overageCount: 0,
        lastSync: 20
      },
      Date.now() + 60_000
    )

    expect(updated).toMatchObject({
      usedCount: 5,
      limitCount: 100,
      lastSync: 30,
      rateLimitResetTime: 0
    })
  })

  test('usage refresh preserves a non-quota cooldown and health state', () => {
    const [db] = createDatabasePair()
    const cooldown = Date.now() + 60_000
    const stored = db.insertAccount(
      account('A', {
        rateLimitResetTime: cooldown,
        isHealthy: false,
        unhealthyReason: 'temporary upstream failure',
        recoveryTime: cooldown,
        failCount: 10,
        usedCount: 20,
        limitCount: 100,
        lastSync: 10
      })
    )
    const manager = new AccountManager([stored], 'sticky', db)

    const updated = manager.updateQuotaUsage(
      stored,
      {
        usedCount: 25,
        limitCount: 100,
        overageCount: 0,
        lastSync: 20
      },
      0
    )

    expect(updated).toMatchObject({
      rateLimitResetTime: cooldown,
      isHealthy: false,
      unhealthyReason: 'temporary upstream failure',
      recoveryTime: cooldown,
      failCount: 10,
      usedCount: 25,
      lastSync: 20
    })
  })

  test('patches health onto the latest row without overwriting a concurrent token update', () => {
    // Given
    const [managerDb, externalDb] = createDatabasePair()
    const stale = managerDb.insertAccount(account('A'))
    const manager = new AccountManager([stale], 'sticky', managerDb)
    externalDb.updateExistingAccounts([{ ...stale, accessToken: 'external-access' }])

    // When
    manager.markUnhealthy(stale, 'InvalidTokenException: refresh credential rejected')

    // Then
    const persisted = externalDb.getById('A')
    expect(persisted?.accessToken).toBe('external-access')
    expect(persisted?.isHealthy).toBeFalse()
    expect(persisted?.failCount).toBe(10)
    expect(persisted?.unhealthyReason).toBe('InvalidTokenException: refresh credential rejected')
  })

  test('marks any reason unhealthy at once and a successful refresh heals it', () => {
    // Given
    const [db] = createDatabasePair()
    const stored = db.insertAccount(account('A'))
    const manager = new AccountManager([stored], 'sticky', db)

    // When
    const marked = manager.markUnhealthy(stored, 'temporary upstream failure')
    if (!marked) throw new Error('account must still exist')
    const healed = manager.updateFromAuth(marked, {
      ...toAuthDetails(marked),
      access: 'fresh-access',
      expires: Date.now() + 3_600_000
    })

    // Then: no transient fail-count ladder, health is binary and refresh-healed
    expect(marked).toMatchObject({ failCount: 10, isHealthy: false, recoveryTime: undefined })
    expect(healed).toMatchObject({
      failCount: 0,
      isHealthy: true,
      unhealthyReason: undefined,
      recoveryTime: undefined,
      accessToken: 'fresh-access'
    })
    expect(manager.selectHealthyAccount()?.id).toBe('A')
  })

  test('reports a concurrent update after exhausting compare-and-swap attempts', () => {
    // Given
    const [db] = createDatabasePair()
    const stored = db.insertAccount(account('A'))
    const manager = new AccountManager([stored], 'sticky', db)
    db.updateExistingAccounts = () => 0

    // When
    const mark = (): void => {
      manager.markRateLimited(stored, Date.now() + 60_000)
    }

    // Then
    expect(mark).toThrow(AccountConcurrentUpdateError)
    expect(mark).toThrow('Account A changed too frequently to update')
  })
})

describe('AccountManager selection metrics', () => {
  test('honors a selectable session-preferred account before the global strategy', () => {
    const [db] = createDatabasePair()
    const first = db.insertAccount(account('A', { usedCount: 0 }))
    const second = db.insertAccount(account('B', { usedCount: 99 }))
    const manager = new AccountManager([first, second], 'lowest-usage', db)

    expect(manager.selectHealthyAccount('B')?.id).toBe('B')
  })

  test('does not select a preferred account whose quota is exhausted', () => {
    const [db] = createDatabasePair()
    const available = db.insertAccount(account('A', { usedCount: 50, limitCount: 100 }))
    const exhausted = db.insertAccount(account('B', { usedCount: 100, limitCount: 100 }))
    const manager = new AccountManager([available, exhausted], 'lowest-usage', db)

    expect(manager.selectHealthyAccount('B')?.id).toBe('A')
    expect(db.getById('B')?.usedCount).toBe(100)
  })

  test('reports account count and the shortest active rate-limit wait', () => {
    // Given
    const [db] = createDatabasePair()
    const now = Date.now()
    const first = db.insertAccount(account('A', { rateLimitResetTime: now + 60_000 }))
    const second = db.insertAccount(account('B', { rateLimitResetTime: now + 30_000 }))
    const manager = new AccountManager([first, second], 'lowest-usage', db)

    // When
    const count = manager.getAccountCount()
    const wait = manager.getMinWaitTime()

    // Then
    expect(count).toBe(2)
    expect(wait).toBeGreaterThan(29_000)
    expect(wait).toBeLessThanOrEqual(30_000)
  })

  test('reports no wait when every rate limit has expired', () => {
    // Given
    const [db] = createDatabasePair()
    const stored = db.insertAccount(account('A', { rateLimitResetTime: Date.now() - 1 }))
    const manager = new AccountManager([stored], 'round-robin', db)

    // When / Then
    expect(manager.getMinWaitTime()).toBe(0)
  })

  test('counts only selectable accounts among the eligible ids', () => {
    // Given
    const [db] = createDatabasePair()
    const healthy = db.insertAccount(account('A'))
    const throttled = db.insertAccount(account('B', { rateLimitResetTime: Date.now() + 60_000 }))
    const exhausted = db.insertAccount(account('C', { usedCount: 100, limitCount: 100 }))
    const manager = new AccountManager([healthy, throttled, exhausted], 'sticky', db)

    // When / Then
    expect(manager.countSelectableAccounts()).toBe(1)
    expect(manager.countSelectableAccounts(new Set(['A', 'B']))).toBe(1)
    expect(manager.countSelectableAccounts(new Set(['B', 'C']))).toBe(0)
  })
})

describe('AccountManager reconcileFromDb', () => {
  test('destroys the SDK transport of an account that disappeared from the database', () => {
    // Given
    const [managerDb, externalDb] = createDatabasePair()
    const stored = managerDb.insertAccount(account('A'))
    const kept = managerDb.insertAccount(account('B'))
    const manager = new AccountManager([stored, kept], 'sticky', managerDb)
    clearSdkClientCache()
    const removedClient = createSdkClient(toAuthDetails(stored), 'us-east-1', undefined, undefined, undefined, 'A')
    const keptClient = createSdkClient(toAuthDetails(kept), 'us-east-1', undefined, undefined, undefined, 'B')
    const removedHandler = removedClient.config.requestHandler
    const keptHandler = keptClient.config.requestHandler
    if (!(removedHandler instanceof NodeHttpHandler) || !(keptHandler instanceof NodeHttpHandler)) {
      throw new TypeError('expected NodeHttpHandler transports')
    }
    const removedDestroy = spyOn(removedHandler, 'destroy')
    const keptDestroy = spyOn(keptHandler, 'destroy')
    externalDb.removeAccount('A')

    // When
    manager.reconcileFromDb(managerDb)

    // Then
    expect(removedDestroy).toHaveBeenCalledTimes(1)
    expect(keptDestroy).not.toHaveBeenCalled()
    expect(manager.getAccounts().map(({ id }) => id)).toEqual(['B'])
    clearSdkClientCache()
  })

  test('makes an externally inserted account visible', () => {
    // Given
    const [managerDb, externalDb] = createDatabasePair()
    const first = managerDb.insertAccount(account('A'))
    const manager = new AccountManager([first], 'sticky', managerDb)
    externalDb.insertAccount(account('B'))

    // When
    manager.reconcileFromDb(managerDb)

    // Then
    expect(manager.getAccounts().map(({ id }) => id).sort()).toEqual(['A', 'B'])
  })

  test('drops an externally removed account so it cannot be selected', () => {
    // Given
    const [managerDb, externalDb] = createDatabasePair()
    const first = managerDb.insertAccount(account('A'))
    const second = managerDb.insertAccount(account('B'))
    const manager = new AccountManager([first, second], 'sticky', managerDb)
    expect(manager.selectHealthyAccount()?.id).toBe('A')
    externalDb.removeAccount('A')

    // When
    manager.reconcileFromDb(managerDb)

    // Then
    expect(manager.getAccounts().map(({ id }) => id)).toEqual(['B'])
    expect(manager.selectHealthyAccount()?.id).toBe('B')
  })

  test('replaces the whole row when the same id is relogged with a new generation', () => {
    // Given
    const [managerDb, externalDb] = createDatabasePair()
    const original = managerDb.insertAccount(
      account('A', {
        clientId: 'old-client',
        clientSecret: 'old-secret',
        refreshToken: 'old-refresh',
        accessToken: 'old-access'
      })
    )
    const manager = new AccountManager([original], 'sticky', managerDb)
    externalDb.removeAccount('A')
    const relogged = externalDb.insertAccount(
      account('A', {
        email: 'fresh@example.com',
        clientId: 'new-client',
        clientSecret: 'new-secret',
        refreshToken: 'new-refresh',
        accessToken: 'new-access'
      })
    )

    // When
    manager.reconcileFromDb(managerDb)

    // Then
    expect(manager.getAccounts()).toEqual([relogged])
    expect(manager.getAccounts()[0]?.generation).toBeGreaterThan(original.generation)
    expect(manager.getAccounts()[0]).toMatchObject({
      email: 'fresh@example.com',
      clientId: 'new-client',
      clientSecret: 'new-secret',
      refreshToken: 'new-refresh',
      accessToken: 'new-access'
    })
  })
})

test('toAuthDetails encodes account credentials for token refresh', () => {
  // Given
  const managed = account('A', {
    authMethod: 'idc',
    oidcRegion: 'eu-west-1',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/test'
  })

  // When
  const auth = toAuthDetails(managed)

  // Then
  expect(auth).toMatchObject({
    refresh: 'refresh-A|client-id|client-secret|idc',
    access: 'access-A',
    expires: managed.expiresAt,
    authMethod: 'idc',
    region: 'us-east-1',
    oidcRegion: 'eu-west-1',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    profileArn: managed.profileArn,
    email: managed.email
  })
})
