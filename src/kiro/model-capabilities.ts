import type { Config } from '../config/schema.js'
import { auditHash, auditLog } from '../core/audit-log.js'
import {
  type KiroAvailableModel,
  KiroManagementError,
  listAvailableModels
} from './management-client.js'
import {
  MODEL_CATALOG,
  type ModelCatalogEntry,
  modelCatalogFromAvailableModels
} from './model-catalog.js'
import {
  isKnownModel,
  registerDynamicWireModels,
  resolveModelVariant
} from './models.js'
import type { KiroAuthDetails, ManagedAccount } from './types.js'

interface AccountModelSnapshot {
  readonly accountId: string
  readonly fetchedAt: number
  readonly models: ReadonlyMap<string, KiroAvailableModel>
}

export interface ModelAvailability {
  readonly supported: boolean
  readonly source: 'live' | 'stale' | 'static' | 'disabled'
  readonly wireModel?: string
}

export interface ModelCapabilitiesReadiness {
  readonly enabled: boolean
  readonly usable: boolean
  readonly source: 'live' | 'stale' | 'static' | 'disabled'
  readonly freshAccounts: number
  readonly staleAccounts: number
  readonly lastSuccessAt?: number
}

export interface PipelineModelCapabilities {
  ensureAccountModel(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    model: string,
    signal?: AbortSignal
  ): Promise<ModelAvailability>
  eligibleAccountIds(
    model: string,
    accountIds: readonly string[]
  ): ReadonlySet<string> | undefined
  isKnownModel(model: string): boolean
  catalog(): readonly ModelCatalogEntry[]
  readiness(): ModelCapabilitiesReadiness
  refreshAccounts(
    accounts: readonly ManagedAccount[],
    authFor: (account: ManagedAccount) => KiroAuthDetails,
    signal?: AbortSignal
  ): Promise<void>
}

type ListModels = typeof listAvailableModels

function staticWireModel(model: string): string | undefined {
  try {
    return resolveModelVariant(model).wireId
  } catch {
    return undefined
  }
}

export class ModelCapabilityService implements PipelineModelCapabilities {
  private readonly snapshots = new Map<string, AccountModelSnapshot>()
  private readonly inFlight = new Map<string, Promise<AccountModelSnapshot>>()
  private readonly failedAt = new Map<string, number>()
  private lastSuccessAt: number | undefined

  constructor(
    private readonly config: Pick<
      Config,
      | 'dynamic_model_catalog'
      | 'model_catalog_ttl_ms'
      | 'model_catalog_stale_ttl_ms'
      | 'model_catalog_request_timeout_ms'
      | 'proxy_url'
    >,
    private readonly listModels: ListModels = listAvailableModels
  ) {}

  async ensureAccountModel(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    model: string,
    signal?: AbortSignal
  ): Promise<ModelAvailability> {
    if (!this.config.dynamic_model_catalog) {
      const wireModel = staticWireModel(model)
      return wireModel === undefined
        ? { supported: false, source: 'disabled' }
        : { supported: true, source: 'disabled', wireModel }
    }
    const snapshot = await this.refreshAccount(account, auth, signal)
    if (snapshot !== undefined) {
      registerDynamicWireModels(snapshot.models.keys())
      const wireModel = staticWireModel(model)
      if (wireModel !== undefined && snapshot.models.has(wireModel)) {
        return {
          supported: true,
          source: this.isFresh(snapshot) ? 'live' : 'stale',
          wireModel
        }
      }
      return {
        supported: false,
        source: this.isFresh(snapshot) ? 'live' : 'stale'
      }
    }
    const wireModel = staticWireModel(model)
    return wireModel === undefined
      ? { supported: false, source: 'static' }
      : { supported: true, source: 'static', wireModel }
  }

  eligibleAccountIds(
    model: string,
    accountIds: readonly string[]
  ): ReadonlySet<string> | undefined {
    if (!this.config.dynamic_model_catalog) return undefined
    this.registerUsableModels()
    const wireModel = staticWireModel(model)
    const now = Date.now()
    const eligible = new Set<string>()
    let hasKnownSnapshot = false
    for (const accountId of accountIds) {
      const snapshot = this.snapshots.get(accountId)
      if (!snapshot || !this.isUsable(snapshot, now)) {
        eligible.add(accountId)
        continue
      }
      hasKnownSnapshot = true
      if (wireModel !== undefined && snapshot.models.has(wireModel)) {
        eligible.add(accountId)
      }
    }
    return hasKnownSnapshot ? eligible : undefined
  }

  isKnownModel(model: string): boolean {
    this.registerUsableModels()
    return isKnownModel(model)
  }

  catalog(): readonly ModelCatalogEntry[] {
    const models = new Map<string, KiroAvailableModel>()
    const now = Date.now()
    for (const snapshot of this.snapshots.values()) {
      if (!this.isUsable(snapshot, now)) continue
      for (const [modelId, model] of snapshot.models) models.set(modelId, model)
    }
    if (models.size === 0) return MODEL_CATALOG
    registerDynamicWireModels(models.keys())
    return modelCatalogFromAvailableModels([...models.values()])
  }

  readiness(): ModelCapabilitiesReadiness {
    if (!this.config.dynamic_model_catalog) {
      return {
        enabled: false,
        usable: true,
        source: 'disabled',
        freshAccounts: 0,
        staleAccounts: 0
      }
    }
    const now = Date.now()
    let freshAccounts = 0
    let staleAccounts = 0
    for (const snapshot of this.snapshots.values()) {
      if (this.isFresh(snapshot, now)) freshAccounts += 1
      else if (this.isUsable(snapshot, now)) staleAccounts += 1
    }
    return {
      enabled: true,
      usable: true,
      source:
        freshAccounts > 0
          ? 'live'
          : staleAccounts > 0
            ? 'stale'
            : 'static',
      freshAccounts,
      staleAccounts,
      ...(this.lastSuccessAt !== undefined
        ? { lastSuccessAt: this.lastSuccessAt }
        : {})
    }
  }

  async refreshAccounts(
    accounts: readonly ManagedAccount[],
    authFor: (account: ManagedAccount) => KiroAuthDetails,
    signal?: AbortSignal
  ): Promise<void> {
    await Promise.allSettled(
      accounts.map((account) => this.refreshAccount(account, authFor(account), signal))
    )
  }

  private async refreshAccount(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    signal?: AbortSignal
  ): Promise<AccountModelSnapshot | undefined> {
    const existing = this.snapshots.get(account.id)
    if (existing && this.isFresh(existing)) return existing
    const inFlight = this.inFlight.get(account.id)
    if (inFlight) {
      try {
        return await inFlight
      } catch {
        return this.usableSnapshot(account.id)
      }
    }
    const refresh = this.fetchSnapshot(account, auth, signal).finally(() => {
      if (this.inFlight.get(account.id) === refresh) this.inFlight.delete(account.id)
    })
    this.inFlight.set(account.id, refresh)
    try {
      return await refresh
    } catch (error) {
      const now = Date.now()
      const previousFailure = this.failedAt.get(account.id) ?? 0
      this.failedAt.set(account.id, now)
      if (now - previousFailure >= this.config.model_catalog_ttl_ms) {
        auditLog('warn', 'model_catalog_refresh_failed', {
          account_hash: auditHash(account.id),
          status: error instanceof KiroManagementError ? error.status : undefined,
          stale_available: this.usableSnapshot(account.id, now) !== undefined
        })
      }
      return this.usableSnapshot(account.id, now)
    }
  }

  private async fetchSnapshot(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    signal?: AbortSignal
  ): Promise<AccountModelSnapshot> {
    const response = await this.listModels(auth, account.region, {
      proxyUrl: this.config.proxy_url || undefined,
      signal,
      timeoutMs: this.config.model_catalog_request_timeout_ms
    })
    const fetchedAt = Date.now()
    const snapshot: AccountModelSnapshot = {
      accountId: account.id,
      fetchedAt,
      models: new Map(response.models.map((model) => [model.modelId, model] as const))
    }
    this.snapshots.set(account.id, snapshot)
    this.failedAt.delete(account.id)
    this.lastSuccessAt = fetchedAt
    registerDynamicWireModels(snapshot.models.keys())
    auditLog('info', 'model_catalog_refreshed', {
      account_hash: auditHash(account.id),
      model_count: snapshot.models.size,
      default_model: response.defaultModelId
    })
    return snapshot
  }

  private registerUsableModels(): void {
    const now = Date.now()
    for (const snapshot of this.snapshots.values()) {
      if (this.isUsable(snapshot, now)) registerDynamicWireModels(snapshot.models.keys())
    }
  }

  private usableSnapshot(
    accountId: string,
    now: number = Date.now()
  ): AccountModelSnapshot | undefined {
    const snapshot = this.snapshots.get(accountId)
    return snapshot && this.isUsable(snapshot, now) ? snapshot : undefined
  }

  private isFresh(
    snapshot: AccountModelSnapshot,
    now: number = Date.now()
  ): boolean {
    return now - snapshot.fetchedAt <= this.config.model_catalog_ttl_ms
  }

  private isUsable(
    snapshot: AccountModelSnapshot,
    now: number = Date.now()
  ): boolean {
    return now - snapshot.fetchedAt <= this.config.model_catalog_stale_ttl_ms
  }
}
