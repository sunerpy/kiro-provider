import { createHash } from "node:crypto";
import { z } from "zod";
import type { Config } from "../config/schema.js";
import { auditHash, auditLog } from "../core/audit-log.js";
import { KIRO_CONSTANTS } from "./constants.js";
import type { KiroAuthDetails, ManagedAccount } from "./types.js";

const FEATURE_CONFIG_TARGET = "KiroRuntimeService.GetFeatureConfiguration";
const FEATURE_CONFIG_KEY_SALT = "kiro-feature-config-key-salt-3e9b1d7a";
const SYSTEM_FIELD_INJECTION = "system_field_injection";
const SYSTEM_PROMPT_MIGRATION = "system_prompt_migration";
const FEATURE_CONFIG_TTL_MS = 15 * 60_000;
const FEATURE_CONFIG_FAILURE_BACKOFF_MS = 60_000;
const FEATURE_CONFIG_TIMEOUT_MS = 5_000;

/**
 * Exact client/KAS versions used for the verified 2026-09-05 V3 wire capture.
 * The feature service receives the Kiro CLI version, not the gateway version.
 */
export const KIRO_RUNTIME_COMPATIBILITY = {
  cliVersion: "2.21.1",
  kasVersion: "0.58.7",
} as const;

const FeatureConfigurationResponseSchema = z
  .object({
    configuration: z.record(z.unknown()),
  })
  .passthrough();

type CapabilitySource = "cache" | "live" | "probe-error";

export interface NativeContextCapability {
  readonly status: "available" | "unavailable" | "unknown";
  readonly source: CapabilitySource;
  readonly featureCount: number;
  readonly systemFieldInjection: boolean;
  readonly systemPromptMigration: boolean;
}

export interface PipelineNativeContextCapabilities {
  ensureAccountNativeContext(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    signal?: AbortSignal,
  ): Promise<NativeContextCapability>;
}

interface CapabilitySnapshot {
  readonly accessTokenHash: string;
  readonly fetchedAt: number;
  readonly value: Omit<NativeContextCapability, "source">;
}

interface CapabilityFailure {
  readonly at: number;
  readonly count: number;
}

class KiroFeatureConfigurationError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "KiroFeatureConfigurationError";
  }
}

function featureKey(key: string): string {
  return createHash("sha256")
    .update(FEATURE_CONFIG_KEY_SALT + key)
    .digest("hex");
}

export const KIRO_NATIVE_CONTEXT_FEATURE_KEYS = {
  systemFieldInjection: featureKey(SYSTEM_FIELD_INJECTION),
  systemPromptMigration: featureKey(SYSTEM_PROMPT_MIGRATION),
} as const;

function tokenHash(token: string): string {
  return createHash("sha256")
    .update("kiro-provider-native-context-token-v1\0")
    .update(token)
    .digest("hex");
}

function runtimeEndpoint(config: Pick<Config, "test_upstream_endpoint">, region: string): string {
  return (
    config.test_upstream_endpoint ?? KIRO_CONSTANTS.RUNTIME_ENDPOINT.replace("{{region}}", region)
  );
}

function capabilityFromConfiguration(
  configuration: Readonly<Record<string, unknown>>,
): Omit<NativeContextCapability, "source"> {
  const systemFieldInjection =
    configuration[KIRO_NATIVE_CONTEXT_FEATURE_KEYS.systemFieldInjection] === true;
  const systemPromptMigration =
    configuration[KIRO_NATIVE_CONTEXT_FEATURE_KEYS.systemPromptMigration] === true;
  return {
    status: systemFieldInjection ? "available" : "unavailable",
    featureCount: Object.keys(configuration).length,
    systemFieldInjection,
    systemPromptMigration,
  };
}

async function fetchFeatureConfiguration(
  auth: KiroAuthDetails,
  endpoint: string,
  proxyUrl: string | undefined,
  signal: AbortSignal | undefined,
): Promise<Readonly<Record<string, unknown>>> {
  const timeout = AbortSignal.timeout(FEATURE_CONFIG_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.access}`,
        "Content-Type": "application/x-amz-json-1.0",
        "User-Agent": `KiroCLI/${KIRO_RUNTIME_COMPATIBILITY.cliVersion} KAS/${KIRO_RUNTIME_COMPATIBILITY.kasVersion}`,
        "X-Amz-Target": FEATURE_CONFIG_TARGET,
        "X-Amzn-Kiro-Client-Attribution": "unrecognized",
      },
      body: JSON.stringify({
        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
        version: KIRO_RUNTIME_COMPATIBILITY.cliVersion,
        ...(auth.profileArn ? { profileArn: auth.profileArn } : {}),
      }),
      signal: requestSignal,
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    });
  } catch (error) {
    throw new KiroFeatureConfigurationError(
      "Kiro feature configuration request failed",
      undefined,
      {
        cause: error,
      },
    );
  }
  if (!response.ok) {
    void response.body?.cancel();
    throw new KiroFeatureConfigurationError(
      "Kiro feature configuration request was rejected",
      response.status,
    );
  }
  let parsedBody: unknown;
  try {
    parsedBody = await response.json();
  } catch (error) {
    throw new KiroFeatureConfigurationError(
      "Kiro feature configuration response was not JSON",
      response.status,
      { cause: error },
    );
  }
  const parsed = FeatureConfigurationResponseSchema.safeParse(parsedBody);
  if (!parsed.success) {
    throw new KiroFeatureConfigurationError(
      "Kiro feature configuration response had an invalid shape",
      response.status,
      { cause: parsed.error },
    );
  }
  return parsed.data.configuration;
}

export class NativeContextCapabilityService implements PipelineNativeContextCapabilities {
  private readonly snapshots = new Map<string, CapabilitySnapshot>();
  private readonly inFlight = new Map<string, Promise<CapabilitySnapshot>>();
  private readonly failures = new Map<string, CapabilityFailure>();

  constructor(
    private readonly config: Pick<Config, "proxy_url" | "test_upstream_endpoint">,
    private readonly fetchConfiguration: typeof fetchFeatureConfiguration = fetchFeatureConfiguration,
    private readonly now: () => number = Date.now,
  ) {}

  async ensureAccountNativeContext(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    signal?: AbortSignal,
  ): Promise<NativeContextCapability> {
    const now = this.now();
    const accessTokenHash = tokenHash(auth.access);
    const existing = this.snapshots.get(account.id);
    if (
      existing !== undefined &&
      existing.accessTokenHash === accessTokenHash &&
      now - existing.fetchedAt <= FEATURE_CONFIG_TTL_MS
    ) {
      return { ...existing.value, source: "cache" };
    }
    const failure = this.failures.get(account.id);
    if (failure !== undefined && now - failure.at < FEATURE_CONFIG_FAILURE_BACKOFF_MS) {
      return {
        status: "unknown",
        source: "probe-error",
        featureCount: 0,
        systemFieldInjection: false,
        systemPromptMigration: false,
      };
    }

    const inFlightKey = `${account.id}:${accessTokenHash}`;
    let refresh = this.inFlight.get(inFlightKey);
    if (refresh === undefined) {
      refresh = this.fetchSnapshot(account, auth, accessTokenHash, signal).finally(() => {
        if (this.inFlight.get(inFlightKey) === refresh) this.inFlight.delete(inFlightKey);
      });
      this.inFlight.set(inFlightKey, refresh);
    }
    try {
      const snapshot = await refresh;
      return { ...snapshot.value, source: "live" };
    } catch (error) {
      if (!signal?.aborted) this.recordFailure(account.id, error);
      return {
        status: "unknown",
        source: "probe-error",
        featureCount: 0,
        systemFieldInjection: false,
        systemPromptMigration: false,
      };
    }
  }

  private async fetchSnapshot(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    accessTokenHash: string,
    signal?: AbortSignal,
  ): Promise<CapabilitySnapshot> {
    const configuration = await this.fetchConfiguration(
      auth,
      runtimeEndpoint(this.config, auth.region),
      this.config.proxy_url || undefined,
      signal,
    );
    const value = capabilityFromConfiguration(configuration);
    const snapshot = {
      accessTokenHash,
      fetchedAt: this.now(),
      value,
    };
    this.snapshots.set(account.id, snapshot);
    this.failures.delete(account.id);
    auditLog("info", "native_context_capability_refreshed", {
      account_hash: auditHash(account.id),
      client_version: KIRO_RUNTIME_COMPATIBILITY.cliVersion,
      feature_count: value.featureCount,
      system_field_injection: value.systemFieldInjection,
      system_prompt_migration: value.systemPromptMigration,
      status: value.status,
    });
    return snapshot;
  }

  private recordFailure(accountId: string, error: unknown): void {
    const count = (this.failures.get(accountId)?.count ?? 0) + 1;
    this.failures.set(accountId, { at: this.now(), count });
    auditLog("warn", "native_context_capability_refresh_failed", {
      account_hash: auditHash(accountId),
      status: error instanceof KiroFeatureConfigurationError ? error.status : undefined,
      consecutive_failures: count,
      backoff_ms: FEATURE_CONFIG_FAILURE_BACKOFF_MS,
    });
  }
}
