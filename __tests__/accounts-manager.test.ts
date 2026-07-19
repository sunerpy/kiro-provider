import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AccountConcurrentUpdateError,
  AccountManager,
  toAuthDetails
} from '../src/core/account-manager.js'
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
    const updated = manager.markUnhealthy(first, 'HTTP_403')

    // Then
    expect(updated?.isHealthy).toBeFalse()
    expect(updated?.failCount).toBe(10)
    expect(db.getById('A')?.unhealthyReason).toBe('HTTP_403')
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

  test('patches health onto the latest row without overwriting a concurrent token update', () => {
    // Given
    const [managerDb, externalDb] = createDatabasePair()
    const stale = managerDb.insertAccount(account('A'))
    const manager = new AccountManager([stale], 'sticky', managerDb)
    externalDb.updateExistingAccounts([{ ...stale, accessToken: 'external-access' }])

    // When
    manager.markUnhealthy(stale, 'temporary upstream failure')

    // Then
    const persisted = externalDb.getById('A')
    expect(persisted?.accessToken).toBe('external-access')
    expect(persisted?.failCount).toBe(1)
    expect(persisted?.unhealthyReason).toBe('temporary upstream failure')
  })

  test('keeps transient failures selectable until the tenth failure', () => {
    // Given
    const [db] = createDatabasePair()
    const stored = db.insertAccount(account('A'))
    const manager = new AccountManager([stored], 'sticky', db)

    // When
    for (let failure = 1; failure < 10; failure += 1) {
      manager.markUnhealthy(stored, 'temporary upstream failure')
    }
    const ninth = db.getById('A')
    const tenth = manager.markUnhealthy(stored, 'temporary upstream failure', Date.now() + 5_000)

    // Then
    expect(ninth).toMatchObject({ failCount: 9, isHealthy: true })
    expect(tenth).toMatchObject({ failCount: 10, isHealthy: false })
    expect(tenth?.recoveryTime).toBeGreaterThan(Date.now())
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
})

describe('AccountManager reconcileFromDb', () => {
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
