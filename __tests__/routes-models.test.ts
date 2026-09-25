import { describe, expect, test } from "bun:test";
import type {
  PipelineAccountManager,
  PipelineModelCapabilities,
  PipelineTokenRefresher,
} from "../src/core/pipeline.js";
import { EXPECTED_PUBLIC_MODEL_IDS } from "../src/kiro/model-catalog.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import { handleHealth } from "../src/server/routes/health.js";
import { handleModels } from "../src/server/routes/models.js";

describe("GET /v1/models", () => {
  test("returns OpenAI and Codex catalogs from the same source without provider instructions", async () => {
    const response = await handleModels();
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
    const responseIds = new Set(entries.map((entry) => entry.id));
    const codexIds = new Set(body.models.map((entry) => entry.slug));

    expect(responseIds.size).toBe(catalogIds.size);
    expect(codexIds.size).toBe(catalogIds.size);
    for (const id of catalogIds) {
      expect(responseIds.has(id)).toBe(true);
      expect(codexIds.has(id)).toBe(true);
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
    expect(body.models.find((entry) => entry.slug === "claude-opus-5-5-xhigh")).toMatchObject({
      default_reasoning_level: "xhigh",
    });

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

  test("advertises Codex Ultra only for Sol/Terra/Fable, including effort aliases", async () => {
    const body = (await (await handleModels()).json()) as {
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

    const response = await handleModels(
      modelCapabilities,
      accountManager,
      tokenRefresher,
      undefined,
      {
        async recheckDueAccounts(selected) {
          quotaCalls += 1;
          expect(selected.map(({ id }) => id)).toEqual(["exhausted", "available"]);
        },
        async syncDueAccounts() {},
      },
    );

    expect(response.status).toBe(200);
    expect(quotaCalls).toBe(1);
    expect(refreshed).toEqual(["available"]);
    expect(catalogAccounts).toEqual(["available"]);
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
