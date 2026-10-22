import { afterEach, describe, expect, test } from "bun:test";
import { ConfigSchema } from "../src/config/schema.js";
import type {
  PipelineAccountManager,
  PipelineModelCapabilities,
  PipelineQuotaRechecker,
  PipelineTokenRefresher,
} from "../src/core/pipeline.js";
import type {
  KiroAvailableModel,
  KiroAvailableModelsResponse,
} from "../src/kiro/management-client.js";
import { ModelCapabilityService } from "../src/kiro/model-capabilities.js";
import { EXPECTED_PUBLIC_MODEL_IDS, MODEL_CATALOG } from "../src/kiro/model-catalog.js";
import { clearDynamicModelRegistry } from "../src/kiro/models.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import { createApp } from "../src/server/app.js";
import { handleHealth } from "../src/server/routes/health.js";
import { handleModels, revalidateModelCatalog } from "../src/server/routes/models.js";
import { captureAuditEvents } from "./audit-test-helpers.js";

describe("GET /v1/models", () => {
  test("returns OpenAI and Codex catalogs from the same source without provider instructions", async () => {
    const response = handleModels();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");

    const body = (await response.json()) as {
      object: string;
      data: unknown[];
      models: Array<{
        slug: string;
        display_name: string;
        base_instructions: string;
        context_window: number;
        shell_type: string;
        default_reasoning_level: string | null;
        supported_reasoning_levels: unknown[];
      }>;
    };
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(Array.isArray(body.models)).toBe(true);

    const entries = body.data as Array<{
      id: string;
      object: string;
      created: number;
      owned_by: string;
    }>;
    const catalogIds = new Set<string>(EXPECTED_PUBLIC_MODEL_IDS);
    const codexCatalogIds = new Set(
      [...catalogIds].filter((id) => !/-(low|medium|high|xhigh|max|thinking)$/.test(id)),
    );
    const responseIds = new Set(entries.map((entry) => entry.id));
    const codexIds = new Set(body.models.map((entry) => entry.slug));

    expect(responseIds.size).toBe(catalogIds.size);
    expect(codexIds.size).toBe(codexCatalogIds.size);
    for (const id of catalogIds) {
      expect(responseIds.has(id)).toBe(true);
      expect(codexIds.has(id)).toBe(codexCatalogIds.has(id));
    }
    for (const entry of entries) {
      expect(catalogIds.has(entry.id)).toBe(true);
      expect(entry.object).toBe("model");
      expect(typeof entry.created).toBe("number");
      expect(typeof entry.owned_by).toBe("string");
    }
    for (const entry of body.models) {
      expect(entry.display_name.length).toBeGreaterThan(0);
      expect(entry.base_instructions).toBe("");
      expect(entry.context_window).toBeGreaterThan(0);
      expect(entry.shell_type).toBe("unified_exec");
      expect(Array.isArray(entry.supported_reasoning_levels)).toBe(true);
    }

    const opus5 = entries.find((entry) => entry.id === "claude-opus-5") as
      | ({ context_limit?: number; output_limit?: number } & (typeof entries)[number])
      | undefined;
    const opus5Codex = body.models.find((entry) => entry.slug === "claude-opus-5");
    expect(opus5).toMatchObject({ context_limit: 1_000_000, output_limit: 128_000 });
    expect(opus5Codex).toMatchObject({
      context_window: 1_000_000,
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "xhigh" },
        { effort: "max" },
      ],
    });

    // kirocodex /model reads models[].supported_reasoning_levels, so a newly
    // catalogued Claude model is only switchable once these are populated.
    const opus55 = entries.find((entry) => entry.id === "claude-opus-5-5") as
      | ({ context_limit?: number; output_limit?: number } & (typeof entries)[number])
      | undefined;
    const opus55Codex = body.models.find((entry) => entry.slug === "claude-opus-5-5");
    expect(opus55).toMatchObject({ context_limit: 1_000_000, output_limit: 128_000 });
    expect(opus55Codex).toMatchObject({
      context_window: 1_000_000,
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "xhigh" },
        { effort: "max" },
      ],
    });
    expect(body.models.find((entry) => entry.slug === "claude-opus-5-5-xhigh")).toBeUndefined();
    expect(responseIds.has("claude-opus-5-5-xhigh")).toBe(true);

    const fable = entries.find((entry) => entry.id === "claude-fable-5-1") as
      | ({ context_limit?: number; output_limit?: number } & (typeof entries)[number])
      | undefined;
    const fableCodex = body.models.find((entry) => entry.slug === "claude-fable-5-1");
    expect(fable).toMatchObject({ context_limit: 1_000_000, output_limit: 128_000 });
    expect(fableCodex).toMatchObject({
      context_window: 1_000_000,
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "xhigh" },
        { effort: "max" },
        { effort: "ultra" },
      ],
      multi_agent_version: "v2",
      multi_agent_reasoning_effort: "max",
    });

    for (const family of ["sol", "terra", "luna"]) {
      const id = `gpt-5.6-${family}`;
      const model = entries.find((entry) => entry.id === id) as
        | ({ context_limit?: number; output_limit?: number } & (typeof entries)[number])
        | undefined;
      const codex = body.models.find((entry) => entry.slug === id);
      expect(model).toMatchObject({ context_limit: 872_000, output_limit: 128_000 });
      expect(codex).toMatchObject({
        context_window: 872_000,
        auto_compact_token_limit: 784_800,
        supported_reasoning_levels: [
          { effort: "low" },
          { effort: "medium" },
          { effort: "high" },
          { effort: "xhigh" },
          { effort: "max" },
          ...(family === "luna" ? [] : [{ effort: "ultra" }]),
        ],
      });
      if (family !== "luna") {
        expect(codex).toMatchObject({
          multi_agent_version: "v2",
          multi_agent_reasoning_effort: "max",
        });
      }
    }
  });

  test("advertises Codex Ultra on base Sol/Terra/Fable while preserving standard OpenAI aliases", async () => {
    const body = (await handleModels().json()) as {
      models: Array<{
        slug: string;
        supported_reasoning_levels: Array<{ effort: string }>;
        multi_agent_version?: string;
        multi_agent_reasoning_effort?: string;
      }>;
      data: Array<{ id: string }>;
    };
    for (const model of body.models) {
      const supportsUltra =
        model.slug === "claude-fable-5-1" || /^gpt-5\.6-(sol|terra)(-|$)/.test(model.slug);
      expect(model.supported_reasoning_levels.some((level) => level.effort === "ultra")).toBe(
        supportsUltra,
      );
      expect(model.multi_agent_reasoning_effort).toBe(supportsUltra ? "max" : undefined);
      expect(model.multi_agent_version).toBe(supportsUltra ? "v2" : undefined);
    }
    // Ultra is a Codex orchestration choice, not a new Kiro model/wire effort.
    expect(body.data.some((model) => model.id.endsWith("-ultra"))).toBe(false);
    expect(
      body.models.some((model) => /-(low|medium|high|xhigh|max|thinking)$/.test(model.slug)),
    ).toBe(false);
    expect(body.data.some((model) => model.id.endsWith("-max"))).toBe(true);
  });

  test("runs due quota recovery before excluding still-exhausted accounts from catalog refresh", async () => {
    const exhausted: ManagedAccount = {
      id: "exhausted",
      email: "exhausted@example.com",
      authMethod: "desktop",
      region: "us-east-1",
      refreshToken: "refresh-exhausted",
      accessToken: "access-exhausted",
      expiresAt: Date.now() + 60_000,
      rateLimitResetTime: 0,
      isHealthy: true,
      failCount: 0,
      usedCount: 100,
      limitCount: 100,
    };
    const available: ManagedAccount = {
      ...exhausted,
      id: "available",
      email: "available@example.com",
      refreshToken: "refresh-available",
      accessToken: "access-available",
      usedCount: 1,
    };
    const accounts = [exhausted, available];
    const refreshed: string[] = [];
    const catalogAccounts: string[] = [];
    let quotaCalls = 0;
    const accountManager: PipelineAccountManager = {
      reconcileFromDb: () => accounts,
      selectHealthyAccount: () => available,
      getAccountCount: () => accounts.length,
      toAuthDetails: (account): KiroAuthDetails => ({
        refresh: account.refreshToken,
        access: account.accessToken,
        expires: account.expiresAt,
        authMethod: account.authMethod,
        region: account.region,
        email: account.email,
      }),
      markRateLimited: () => undefined,
      markUnhealthy: () => undefined,
    };
    const tokenRefresher: PipelineTokenRefresher = {
      async refreshIfNeeded(account) {
        refreshed.push(account.id);
        return account;
      },
      async forceRefresh(account) {
        return account;
      },
    };
    const modelCapabilities: PipelineModelCapabilities = {
      async ensureAccountModel() {
        return { supported: true, source: "static" };
      },
      eligibleAccountIds: () => undefined,
      isKnownModel: () => true,
      catalog: () => [],
      readiness: () => ({
        enabled: true,
        usable: true,
        source: "static",
        freshAccounts: 0,
        staleAccounts: 0,
      }),
      async refreshAccounts(selected) {
        catalogAccounts.push(...selected.map(({ id }) => id));
      },
    };

    const quotaRechecker: PipelineQuotaRechecker = {
      async recheckDueAccounts(selected) {
        quotaCalls += 1;
        expect(selected.map(({ id }) => id)).toEqual(["exhausted", "available"]);
      },
      async syncDueAccounts() {},
    };
    const dependencies = { modelCapabilities, accountManager, tokenRefresher, quotaRechecker };

    const response = handleModels(dependencies);
    // Joins the revalidation the listing started rather than running another.
    await revalidateModelCatalog(dependencies);

    expect(response.status).toBe(200);
    expect(quotaCalls).toBe(1);
    expect(refreshed).toEqual(["available"]);
    expect(catalogAccounts).toEqual(["available"]);
  });
});

type RevalidationStage = "quota recheck" | "token refresh" | "catalog fetch";

const GATEWAY_KEY = "sk-models-route";
const CATALOG_TTL_MS = 60_000;
const CATALOG_REQUEST_TIMEOUT_MS = 10_000;

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function catalogModel(modelId: string): KiroAvailableModel {
  return {
    modelId,
    modelName: modelId,
    supportedInputTypes: ["TEXT"],
    tokenLimits: { maxInputTokens: 100_000, maxOutputTokens: 32_000 },
  };
}

function gatewayAccount(id: string, overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    authMethod: "desktop",
    region: "us-east-1",
    refreshToken: `refresh-${id}`,
    accessToken: `access-${id}`,
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 1,
    limitCount: 100,
    ...overrides,
  };
}

function gatewayAuth(account: ManagedAccount): KiroAuthDetails {
  return {
    refresh: account.refreshToken,
    access: account.accessToken,
    expires: account.expiresAt,
    authMethod: account.authMethod,
    region: account.region,
    email: account.email,
  };
}

/** The response, or "pending" while the route is still blocked on upstream work. */
function settledWithin(response: Promise<Response>, ms: number): Promise<Response | "pending"> {
  return Promise.race([response, Bun.sleep(ms).then(() => "pending" as const)]);
}

async function listedIds(response: Response): Promise<{ data: string[]; codex: string[] }> {
  const body = (await response.json()) as {
    data: Array<{ id: string }>;
    models: Array<{ slug: string }>;
  };
  return { data: body.data.map(({ id }) => id), codex: body.models.map(({ slug }) => slug) };
}

async function until(condition: () => boolean, failure: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(failure);
    await Bun.sleep(5);
  }
}

/**
 * The full ingress path for GET /v1/models: authentication, the real capability
 * service and stubbed upstream stages. `stall` holds one stage open until
 * `release()`, standing in for a slow usage, OIDC or management endpoint.
 */
function modelsGateway(stall?: RevalidationStage) {
  const clock = { now: 1_000_000 };
  const available = gatewayAccount("available");
  const exhausted = gatewayAccount("exhausted", { usedCount: 100 });
  const accounts = [exhausted, available];
  const calls = { quota: 0, token: 0, catalog: 0 };
  const catalogRequests: Array<{ readonly signal?: AbortSignal; readonly timeoutMs?: number }> = [];
  const stalled = {
    quota: deferred<void>(),
    token: deferred<ManagedAccount>(),
    catalog: deferred<KiroAvailableModelsResponse>(),
  };
  const refreshed: KiroAvailableModelsResponse = {
    models: [catalogModel("future-model"), catalogModel("newer-model")],
  };
  let warming = false;
  const capabilities = new ModelCapabilityService(
    {
      dynamic_model_catalog: true,
      model_catalog_ttl_ms: CATALOG_TTL_MS,
      model_catalog_stale_ttl_ms: 86_400_000,
      model_catalog_request_timeout_ms: CATALOG_REQUEST_TIMEOUT_MS,
      proxy_url: null,
    },
    async (_auth, _region, options) => {
      if (warming) return { models: [catalogModel("future-model")] };
      calls.catalog += 1;
      catalogRequests.push({
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      return stall === "catalog fetch" ? stalled.catalog.promise : refreshed;
    },
    () => clock.now,
  );
  const accountManager: PipelineAccountManager = {
    reconcileFromDb: () => accounts,
    selectHealthyAccount: () => available,
    getAccountCount: () => accounts.length,
    toAuthDetails: gatewayAuth,
    markRateLimited: () => undefined,
    markUnhealthy: () => undefined,
  };
  const tokenRefresher: PipelineTokenRefresher = {
    async refreshIfNeeded(account) {
      calls.token += 1;
      return stall === "token refresh" ? stalled.token.promise : account;
    },
    async forceRefresh(account) {
      return account;
    },
  };
  const quotaRechecker: PipelineQuotaRechecker = {
    async recheckDueAccounts() {
      calls.quota += 1;
      if (stall === "quota recheck") await stalled.quota.promise;
    },
    async syncDueAccounts() {},
  };
  const app = createApp(ConfigSchema.parse({ api_keys: [GATEWAY_KEY] }), {
    accountManager,
    tokenRefresher,
    quotaRechecker,
    modelCapabilities: capabilities,
  });
  return {
    calls,
    catalogRequests,
    /** Caches a successful account catalog, then ages it past its fresh TTL. */
    async warm(): Promise<void> {
      warming = true;
      await capabilities.refreshAccounts([available], gatewayAuth);
      warming = false;
      clock.now += CATALOG_TTL_MS + 1;
    },
    listModels: (init: RequestInit = {}): Promise<Response> =>
      app(
        new Request("http://gateway/v1/models", {
          ...init,
          headers: { Authorization: `Bearer ${GATEWAY_KEY}` },
        }),
      ),
    release(): void {
      stalled.quota.resolve();
      stalled.token.resolve(available);
      stalled.catalog.resolve(refreshed);
    },
    revalidated: (): Promise<void> =>
      until(
        () => capabilities.catalog().some(({ id }) => id === "newer-model"),
        "background catalog revalidation did not publish the refreshed catalog",
      ),
  };
}

describe("GET /v1/models background revalidation", () => {
  afterEach(() => clearDynamicModelRegistry());

  test.each(["quota recheck", "token refresh", "catalog fetch"] as const)(
    "answers from the cached stale catalog while the %s is stalled",
    async (stage) => {
      const gateway = modelsGateway(stage);
      await gateway.warm();

      const first = await settledWithin(gateway.listModels(), 1_000);

      // Codex/Zuno abandon a model listing after 5 s; the route must not wait on upstream work.
      expect(first).not.toBe("pending");
      if (first === "pending") return;
      expect(first.status).toBe(200);
      expect(await listedIds(first)).toEqual({ data: ["future-model"], codex: ["future-model"] });

      gateway.release();
      await gateway.revalidated();
      const next = await gateway.listModels();
      expect((await listedIds(next)).data).toEqual(["future-model", "newer-model"]);
      expect(gateway.calls.catalog).toBe(1);
    },
  );

  test("serves the checked-in catalog on a cold start and publishes the live catalog when it arrives", async () => {
    const gateway = modelsGateway("catalog fetch");

    const first = await settledWithin(gateway.listModels(), 1_000);

    expect(first).not.toBe("pending");
    if (first === "pending") return;
    expect(first.status).toBe(200);
    expect((await listedIds(first)).data).toEqual(MODEL_CATALOG.map(({ id }) => id));

    gateway.release();
    await gateway.revalidated();
    const next = await gateway.listModels();
    expect(await listedIds(next)).toEqual({
      data: ["future-model", "newer-model"],
      codex: ["future-model", "newer-model"],
    });
  });

  test("joins concurrent listings to one background revalidation", async () => {
    const gateway = modelsGateway("quota recheck");
    await gateway.warm();

    const responses = await Promise.all(
      [0, 1, 2].map(() => settledWithin(gateway.listModels(), 1_000)),
    );

    expect(responses).not.toContain("pending");
    expect(gateway.calls.quota).toBe(1);
    gateway.release();
    await gateway.revalidated();
    expect(gateway.calls).toEqual({ quota: 1, token: 1, catalog: 1 });
    // The next listing after the revalidation settled starts a fresh one.
    await gateway.listModels();
    await until(() => gateway.calls.quota === 2, "a settled revalidation blocked the next one");
  });

  test("finishes the revalidation after the client that triggered it disconnects", async () => {
    const gateway = modelsGateway("catalog fetch");
    await gateway.warm();
    const client = new AbortController();

    const first = await settledWithin(gateway.listModels({ signal: client.signal }), 1_000);
    client.abort(new DOMException("client went away", "AbortError"));
    gateway.release();

    expect(first).not.toBe("pending");
    await gateway.revalidated();
    expect(gateway.catalogRequests).toHaveLength(1);
    // Detached from the request, the fetch is still bounded by the catalog timeout.
    expect(gateway.catalogRequests[0]?.signal?.aborted ?? false).toBe(false);
    expect(gateway.catalogRequests[0]?.timeoutMs).toBe(CATALOG_REQUEST_TIMEOUT_MS);
  });

  test("keeps serving the catalog when revalidation fails, logging only the error type", async () => {
    const audit = captureAuditEvents();
    try {
      const capabilities = new ModelCapabilityService(
        {
          dynamic_model_catalog: true,
          model_catalog_ttl_ms: CATALOG_TTL_MS,
          model_catalog_stale_ttl_ms: 86_400_000,
          model_catalog_request_timeout_ms: CATALOG_REQUEST_TIMEOUT_MS,
          proxy_url: null,
        },
        async () => ({ models: [catalogModel("future-model")] }),
      );
      const app = createApp(ConfigSchema.parse({ api_keys: [GATEWAY_KEY] }), {
        accountManager: {
          reconcileFromDb: () => {
            throw new Error(
              "SQLITE_BUSY /home/user/.config/kiro-provider/accounts.db refresh-secret",
            );
          },
          selectHealthyAccount: () => null,
          getAccountCount: () => 0,
          toAuthDetails: gatewayAuth,
          markRateLimited: () => undefined,
          markUnhealthy: () => undefined,
        },
        tokenRefresher: {
          refreshIfNeeded: async (account) => account,
          forceRefresh: async (account) => account,
        },
        modelCapabilities: capabilities,
      });

      const response = await settledWithin(
        app(
          new Request("http://gateway/v1/models", {
            headers: { Authorization: `Bearer ${GATEWAY_KEY}` },
          }),
        ),
        1_000,
      );

      expect(response).not.toBe("pending");
      if (response === "pending") return;
      expect(response.status).toBe(200);
      expect((await listedIds(response)).data).toEqual(MODEL_CATALOG.map(({ id }) => id));
      await until(
        () => audit.events("model_catalog_revalidation_failed").length === 1,
        "the background failure was not audited",
      );
      expect(audit.events("model_catalog_revalidation_failed")[0]).toMatchObject({
        level: "warn",
        error_type: "Error",
      });
      expect(audit.events("request_handler_failed")).toEqual([]);
      const logged = JSON.stringify(audit.events());
      expect(logged).not.toContain("refresh-secret");
      expect(logged).not.toContain("accounts.db");
    } finally {
      audit.restore();
    }
  });
});

describe("GET /health", () => {
  test("returns status ok", async () => {
    const response = handleHealth();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");

    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});
