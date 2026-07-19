import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountManager } from '../src/core/account-manager.js'
import type { ManagedAccount } from '../src/kiro/types.js'
import { AccountsDatabase } from '../src/storage/accounts-db.js'

const databases: AccountsDatabase[] = []
const temporaryDirectories: string[] = []

function createManager(
  strategy: 'sticky' | 'round-robin' | 'lowest-usage',
  accounts: readonly ManagedAccount[]
): AccountManager {
  const directory = mkdtempSync(join(tmpdir(), 'kiro-provider-selector-'))
  const database = new AccountsDatabase(join(directory, 'accounts.db'))
  databases.push(database)
  temporaryDirectories.push(directory)
  const stored = accounts.map((item) => database.insertAccount(item))
  return new AccountManager(stored, strategy, database)
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

describe('AccountManager account selection strategies', () => {
  test('sticky keeps selecting the same healthy account', () => {
    // Given
    const manager = createManager('sticky', [account('B'), account('A')])

    // When
    const selected = [manager.selectHealthyAccount(), manager.selectHealthyAccount()]

    // Then
    expect(selected.map((item) => item?.id)).toEqual(['A', 'A'])
  })

  test('round-robin rotates through healthy accounts', () => {
    // Given
    const manager = createManager('round-robin', [account('B'), account('A')])

    // When
    const selected = [
      manager.selectHealthyAccount(),
      manager.selectHealthyAccount(),
      manager.selectHealthyAccount()
    ]

    // Then
    expect(selected.map((item) => item?.id)).toEqual(['A', 'B', 'A'])
  })

  test('lowest-usage selects the least-used healthy account', () => {
    // Given
    const manager = createManager('lowest-usage', [
      account('A', { usedCount: 8, lastUsed: 100 }),
      account('B', { usedCount: 2, lastUsed: 200 }),
      account('C', { usedCount: 2, lastUsed: 300 })
    ])

    // When
    const selected = manager.selectHealthyAccount()

    // Then
    expect(selected?.id).toBe('B')
  })

  test('returns null when every account is permanently unhealthy or rate-limited', () => {
    // Given
    const manager = createManager('lowest-usage', [
      account('A', { isHealthy: false, unhealthyReason: 'HTTP_401', failCount: 10 }),
      account('B', { rateLimitResetTime: Date.now() + 60_000 })
    ])

    // When
    const selected = manager.getCurrentOrNext()

    // Then
    expect(selected).toBeNull()
  })
})
