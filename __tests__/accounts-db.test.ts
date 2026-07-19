import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ManagedAccount } from '../src/kiro/types.js'
import {
  AccountsDatabase,
  type StoredAccount
} from '../src/storage/accounts-db.js'

const temporaryDirectories: string[] = []
const openDatabases: AccountsDatabase[] = []

function account(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: 'account-1',
    email: 'builder@example.com',
    authMethod: 'idc',
    region: 'us-east-1',
    oidcRegion: 'us-west-2',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/test',
    startUrl: 'https://example.awsapps.com/start',
    refreshToken: 'refresh-token-1',
    accessToken: 'access-token-1',
    expiresAt: 2_000_000_000_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 3,
    limitCount: 100,
    overageCount: 1,
    lastSync: 1_700_000_000_000,
    lastUsed: 1_700_000_000_001,
    ...overrides
  }
}

function createDatabasePair(): readonly [AccountsDatabase, AccountsDatabase, string] {
  const directory = mkdtempSync(join(tmpdir(), 'kiro-provider-accounts-'))
  const path = join(directory, 'accounts.db')
  const first = new AccountsDatabase(path)
  const second = new AccountsDatabase(path)

  temporaryDirectories.push(directory)
  openDatabases.push(first, second)
  return [first, second, path]
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('AccountsDatabase', () => {
  test('migrates a legacy accounts table and preserves CAS updates', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kiro-provider-legacy-'))
    const path = join(directory, 'accounts.db')
    temporaryDirectories.push(directory)
    const legacy = new Database(path, { create: true })
    legacy.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, auth_method TEXT NOT NULL,
        region TEXT NOT NULL, oidc_region TEXT, client_id TEXT, client_secret TEXT,
        profile_arn TEXT, start_url TEXT, refresh_token TEXT NOT NULL,
        access_token TEXT NOT NULL, expires_at INTEGER NOT NULL,
        rate_limit_reset INTEGER DEFAULT 0, is_healthy INTEGER DEFAULT 1,
        unhealthy_reason TEXT, recovery_time INTEGER, fail_count INTEGER DEFAULT 0,
        last_used INTEGER DEFAULT 0, used_count INTEGER DEFAULT 0,
        limit_count INTEGER DEFAULT 0, last_sync INTEGER DEFAULT 0,
        overage_count INTEGER DEFAULT 0
      );
      INSERT INTO accounts (
        id, email, auth_method, region, refresh_token, access_token, expires_at
      ) VALUES (
        'legacy-1', 'legacy@example.com', 'desktop', 'us-east-1',
        'refresh-token', 'access-token', 2000000000000
      );
    `)
    legacy.close()

    const database = new AccountsDatabase(path)
    openDatabases.push(database)
    const migrated = new Database(path, { readonly: true })
    const columns = migrated
      .query<{ name: string }, []>('PRAGMA table_info(accounts)')
      .all()
      .map(({ name }) => name)
    migrated.close()
    const stored = database.getById('legacy-1')
    expect(stored).toBeDefined()
    if (stored === undefined) return

    const changes = database.updateExistingAccounts([
      { ...stored, accessToken: 'updated-token' }
    ])

    expect(columns).toContain('generation')
    expect(stored.generation).toBe(1)
    expect(changes).toBe(1)
    expect(database.getById('legacy-1')).toMatchObject({
      accessToken: 'updated-token',
      generation: 2
    })
  })

  test('supports insert, read, CAS update, and tombstone removal', () => {
    const [database] = createDatabasePair()

    const inserted = database.insertAccount(account())
    const beforeUpdate = database.getAccounts()
    const accountBeforeUpdate = beforeUpdate[0]
    expect(accountBeforeUpdate).toBeDefined()
    if (accountBeforeUpdate === undefined) return
    const updated = database.updateExistingAccounts([
      { ...accountBeforeUpdate, accessToken: 'access-token-2' }
    ])
    const afterUpdate = database.getById('account-1')
    database.removeAccount('account-1')

    expect(inserted.generation).toBe(1)
    expect(beforeUpdate).toHaveLength(1)
    expect(beforeUpdate[0]).toMatchObject({
      accessToken: 'access-token-1',
      generation: 1,
      usedCount: 3,
      overageCount: 1
    })
    expect(updated).toBe(1)
    expect(afterUpdate).toMatchObject({ accessToken: 'access-token-2', generation: 2 })
    expect(database.getAccounts()).toEqual([])
    expect(database.getById('account-1')).toBeUndefined()
  })

  test('does not resurrect an account when another connection deletes it', () => {
    const [reader, remover] = createDatabasePair()
    reader.insertAccount(account())
    const stale = reader.getById('account-1')
    expect(stale).toBeDefined()
    if (stale === undefined) return

    remover.removeAccount(stale.id)
    const changes = reader.updateExistingAccounts([
      { ...stale, accessToken: 'stale-token' }
    ])

    expect(changes).toBe(0)
    expect(reader.getById(stale.id)).toBeUndefined()
    expect(reader.getAccounts()).toEqual([])
  })

  test('rejects a stale write after another connection refreshes the row', () => {
    const [staleWriter, refresher] = createDatabasePair()
    staleWriter.insertAccount(account())
    const stale = staleWriter.getById('account-1')
    const fresh = refresher.getById('account-1')
    expect(stale).toBeDefined()
    expect(fresh).toBeDefined()
    if (stale === undefined || fresh === undefined) return

    expect(
      refresher.updateExistingAccounts([{ ...fresh, accessToken: 'fresh-token' }])
    ).toBe(1)
    const staleChanges = staleWriter.updateExistingAccounts([
      { ...stale, accessToken: 'stale-token' }
    ])

    expect(staleChanges).toBe(0)
    expect(staleWriter.getById(stale.id)).toMatchObject({
      accessToken: 'fresh-token',
      generation: 2
    })
  })

  test('rejects generation one after delete and same-id relogin', () => {
    const [staleWriter, reloginWriter] = createDatabasePair()
    const initial = staleWriter.insertAccount(account())
    const stale = staleWriter.getById(initial.id)
    expect(stale).toBeDefined()
    if (stale === undefined) return

    reloginWriter.removeAccount(stale.id)
    const relogged = reloginWriter.insertAccount(
      account({ refreshToken: 'refresh-token-2', accessToken: 'relogin-token' })
    )
    const staleChanges = staleWriter.updateExistingAccounts([
      { ...stale, accessToken: 'stale-token' }
    ])

    expect(stale.generation).toBe(1)
    expect(relogged.generation).toBe(2)
    expect(staleChanges).toBe(0)
    expect(staleWriter.getById(stale.id)).toMatchObject({
      refreshToken: 'refresh-token-2',
      accessToken: 'relogin-token',
      generation: 2
    })
  })

  test('clears the tombstone and advances generation on deliberate relogin', () => {
    const [database] = createDatabasePair()
    const initial = database.insertAccount(account())
    database.removeAccount(initial.id)

    const relogged = database.insertAccount(
      account({ refreshToken: 'refresh-token-2', accessToken: 'relogin-token' })
    )

    expect(initial.generation).toBe(1)
    expect(relogged.generation).toBe(2)
    expect(database.getAccounts()).toEqual([relogged])
    expect(
      database.updateExistingAccounts([{ ...relogged, accessToken: 'updated-token' }])
    ).toBe(1)
  })

  test('never inserts an account through updateExistingAccounts', () => {
    const [database] = createDatabasePair()
    const missing: StoredAccount = { ...account(), generation: 1 }

    expect(database.updateExistingAccounts([missing])).toBe(0)
    expect(database.getAccounts()).toEqual([])
  })

  test('restricts the database and existing WAL sidecars to mode 0600', () => {
    const [database, , path] = createDatabasePair()
    database.insertAccount(account())

    expect(statSync(path).mode & 0o777).toBe(0o600)
    for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
      if (existsSync(sidecar)) expect(statSync(sidecar).mode & 0o777).toBe(0o600)
    }
  })
})
