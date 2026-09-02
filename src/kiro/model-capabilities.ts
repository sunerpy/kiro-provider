import type { Config } from "../config/schema.js";
import { auditHash, auditLog } from "../core/audit-log.js";
import {
  type KiroAvailableModel,
  KiroManagementError,
  listAvailableModels,
} from "./management-client.js";
import {
  MODEL_CATALOG,
  type ModelCatalogEntry,
  modelCatalogFromAvailableModels,
} from "./model-catalog.js";
import { isKnownModel, registerDynamicWireModels, resolveModelVariant } from "./models.js";
import type { KiroAuthDetails, ManagedAccount } from "./types.js";

interface AccountModelSnapshot {
  readonly accountId: string;
  readonly fetchedAt: number;
  readonly models: ReadonlyMap<string, KiroAvailableModel>;
}

interface RefreshFailure {
  readonly at: number;
  readonly count: number;
}

/**
 * Negative cache: after a failed catalog fetch the account is not probed again
 * until this window elapses. It starts at min(model_catalog_ttl_ms, 60 s) and
 * doubles per consecutive failure up to model_catalog_ttl_ms.
 */
const MAX_BACKOFF_BASE_MS = 60_000;

export interface ModelAvailability {
  readonly supported: boolean;
  readonly source: "live" | "stale" | "static" | "disabled";
  readonly wireModel?: string;
}

export interface ModelCapabilitiesReadiness {
  readonly enabled: boolean;
  readonly usable: boolean;
  readonly source: "live" | "stale" | "static" | "disabled";
  readonly freshAccounts: number;
  readonly staleAccounts: number;
  readonly lastSuccessAt?: number;
}

export interface PipelineModelCapabilities {
  ensureAccountModel(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    model: string,
    signal?: AbortSignal,
  ): Promise<ModelAvailability>;
  eligibleAccountIds(model: string, accountIds: readonly string[]): ReadonlySet<string> | undefined;
  isKnownModel(model: string): boolean;
  catalog(): readonly ModelCatalogEntry[];
  readiness(): ModelCapabilitiesReadiness;
  refreshAccounts(
    accounts: readonly ManagedAccount[],
    authFor: (account: ManagedAccount) => KiroAuthDetails,
    signal?: AbortSignal,
  ): Promise<void>;
}

type ListModels = typeof listAvailableModels;

/**
 * `serve`: request path. A usable stale snapshot is returned immediately and
 * revalidated in the background (stale-while-revalidate).
 * `await`: explicit refresh (models route). Waits for the live result unless
 * the account is inside its failure backoff window.
 */
type RefreshMode = "serve" | "await";

function staticWireModel(model: string): string | undefined {
  try {
    return resolveModelVariant(model).wireId;
  } catch {
    return undefined;
  }
}

export class ModelCapabilityService implements PipelineModelCapabilities {
  private readonly snapshots = new Map<string, AccountModelSnapshot>();
  private readonly inFlight = new Map<string, Promise<AccountModelSnapshot>>();
  private readonly failures = new Map<string, RefreshFailure>();
  private lastSuccessAt: number | undefined;

  constructor(
    private readonly config: Pick<
      Config,
      | "dynamic_model_catalog"
      | "model_catalog_ttl_ms"
      | "model_catalog_stale_ttl_ms"
      | "model_catalog_request_timeout_ms"
      | "proxy_url"
    >,
    private readonly listModels: ListModels = listAvailableModels,
    private readonly now: () => number = Date.now,
  ) {}

  async ensureAccountModel(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    model: string,
    signal?: AbortSignal,
  ): Promise<ModelAvailability> {
    if (!this.config.dynamic_model_catalog) {
      const wireModel = staticWireModel(model);
      return wireModel === undefined
        ? { supported: false, source: "disabled" }
        : { supported: true, source: "disabled", wireModel };
    }
    const snapshot = await this.refreshAccount(account, auth, signal, "serve");
    if (snapshot !== undefined) {
      registerDynamicWireModels(snapshot.models.keys());
      const wireModel = staticWireModel(model);
      if (wireModel !== undefined && snapshot.models.has(wireModel)) {
        return {
          supported: true,
          source: this.isFresh(snapshot) ? "live" : "stale",
          wireModel,
        };
      }
      return {
        supported: false,
        source: this.isFresh(snapshot) ? "live" : "stale",
      };
    }
    const wireModel = staticWireModel(model);
    return wireModel === undefined
      ? { supported: false, source: "static" }
      : { supported: true, source: "static", wireModel };
  }

  eligibleAccountIds(
    model: string,
    accountIds: readonly string[],
  ): ReadonlySet<string> | undefined {
    if (!this.config.dynamic_model_catalog) return undefined;
    this.registerUsableModels();
    const wireModel = staticWireModel(model);
    const now = this.now();
    const eligible = new Set<string>();
    let hasKnownSnapshot = false;
    for (const accountId of accountIds) {
      const snapshot = this.snapshots.get(accountId);
      if (!snapshot || !this.isUsable(snapshot, now)) {
        eligible.add(accountId);
        continue;
      }
      hasKnownSnapshot = true;
      if (wireModel !== undefined && snapshot.models.has(wireModel)) {
        eligible.add(accountId);
      }
    }
    return hasKnownSnapshot ? eligible : undefined;
  }

  isKnownModel(model: string): boolean {
    this.registerUsableModels();
    return isKnownModel(model);
  }

  catalog(): readonly ModelCatalogEntry[] {
    const models = new Map<string, KiroAvailableModel>();
    const now = this.now();
    for (const snapshot of this.snapshots.values()) {
      if (!this.isUsable(snapshot, now)) continue;
      for (const [modelId, model] of snapshot.models) models.set(modelId, model);
    }
    if (models.size === 0) return MODEL_CATALOG;
    registerDynamicWireModels(models.keys());
    return modelCatalogFromAvailableModels([...models.values()]);
  }

  readiness(): ModelCapabilitiesReadiness {
    if (!this.config.dynamic_model_catalog) {
      return {
        enabled: false,
        usable: true,
        source: "disabled",
        freshAccounts: 0,
        staleAccounts: 0,
      };
    }
    const now = this.now();
    let freshAccounts = 0;
    let staleAccounts = 0;
    for (const snapshot of this.snapshots.values()) {
      if (this.isFresh(snapshot, now)) freshAccounts += 1;
      else if (this.isUsable(snapshot, now)) staleAccounts += 1;
    }
    return {
      enabled: true,
      usable: true,
      source: freshAccounts > 0 ? "live" : staleAccounts > 0 ? "stale" : "static",
      freshAccounts,
      staleAccounts,
      ...(this.lastSuccessAt !== undefined ? { lastSuccessAt: this.lastSuccessAt } : {}),
    };
  }

  async refreshAccounts(
    accounts: readonly ManagedAccount[],
    authFor: (account: ManagedAccount) => KiroAuthDetails,
    signal?: AbortSignal,
  ): Promise<void> {
    await Promise.allSettled(
      accounts.map((account) => this.refreshAccount(account, authFor(account), signal, "await")),
    );
  }

  private async refreshAccount(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    signal: AbortSignal | undefined,
    mode: RefreshMode,
  ): Promise<AccountModelSnapshot | undefined> {
    const now = this.now();
    const existing = this.snapshots.get(account.id);
    if (existing && this.isFresh(existing, now)) return existing;
    const usable = existing && this.isUsable(existing, now) ? existing : undefined;
    if (this.backoffUntil(account.id) > now) return usable;
    const serveStale = mode === "serve" && usable !== undefined;
    const inFlight = this.inFlight.get(account.id);
    if (inFlight) {
      if (serveStale) return usable;
      try {
        return await inFlight;
      } catch {
        return this.usableSnapshot(account.id);
      }
    }
    // A background revalidation must outlive the request that triggered it, so
    // it only carries the catalog request timeout, not the caller's signal.
    const fetchSignal = serveStale ? undefined : signal;
    const refresh = this.fetchSnapshot(account, auth, fetchSignal)
      .catch((error: unknown) => {
        // A caller-cancelled fetch says nothing about the endpoint's health.
        if (!fetchSignal?.aborted) this.recordFailure(account.id, error);
        throw error;
      })
      .finally(() => {
        if (this.inFlight.get(account.id) === refresh) this.inFlight.delete(account.id);
      });
    this.inFlight.set(account.id, refresh);
    if (serveStale) {
      refresh.catch(() => undefined);
      return usable;
    }
    try {
      return await refresh;
    } catch {
      return this.usableSnapshot(account.id);
    }
  }

  private recordFailure(accountId: string, error: unknown): void {
    const now = this.now();
    const count = (this.failures.get(accountId)?.count ?? 0) + 1;
    this.failures.set(accountId, { at: now, count });
    auditLog("warn", "model_catalog_refresh_failed", {
      account_hash: auditHash(accountId),
      status: error instanceof KiroManagementError ? error.status : undefined,
      consecutive_failures: count,
      backoff_ms: this.backoffMs(count),
      stale_available: this.usableSnapshot(accountId, now) !== undefined,
    });
  }

  private backoffMs(consecutiveFailures: number): number {
    const ttl = this.config.model_catalog_ttl_ms;
    const base = Math.min(ttl, MAX_BACKOFF_BASE_MS);
    return Math.min(ttl, base * 2 ** Math.max(0, consecutiveFailures - 1));
  }

  private backoffUntil(accountId: string): number {
    const failure = this.failures.get(accountId);
    return failure === undefined ? 0 : failure.at + this.backoffMs(failure.count);
  }

  private async fetchSnapshot(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    signal?: AbortSignal,
  ): Promise<AccountModelSnapshot> {
    const response = await this.listModels(auth, account.region, {
      proxyUrl: this.config.proxy_url || undefined,
      signal,
      timeoutMs: this.config.model_catalog_request_timeout_ms,
    });
    const fetchedAt = this.now();
    const snapshot: AccountModelSnapshot = {
      accountId: account.id,
      fetchedAt,
      models: new Map(response.models.map((model) => [model.modelId, model] as const)),
    };
    this.snapshots.set(account.id, snapshot);
    this.failures.delete(account.id);
    this.lastSuccessAt = fetchedAt;
    registerDynamicWireModels(snapshot.models.keys());
    auditLog("info", "model_catalog_refreshed", {
      account_hash: auditHash(account.id),
      model_count: snapshot.models.size,
      default_model: response.defaultModelId,
    });
    return snapshot;
  }

  private registerUsableModels(): void {
    const now = this.now();
    for (const snapshot of this.snapshots.values()) {
      if (this.isUsable(snapshot, now)) registerDynamicWireModels(snapshot.models.keys());
    }
  }

  private usableSnapshot(
    accountId: string,
    now: number = this.now(),
  ): AccountModelSnapshot | undefined {
    const snapshot = this.snapshots.get(accountId);
    return snapshot && this.isUsable(snapshot, now) ? snapshot : undefined;
  }

  private isFresh(snapshot: AccountModelSnapshot, now: number = this.now()): boolean {
    return now - snapshot.fetchedAt <= this.config.model_catalog_ttl_ms;
  }

  private isUsable(snapshot: AccountModelSnapshot, now: number = this.now()): boolean {
    return now - snapshot.fetchedAt <= this.config.model_catalog_stale_ttl_ms;
  }
}
