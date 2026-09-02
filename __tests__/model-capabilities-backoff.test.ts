import { afterEach, describe, expect, test } from "bun:test";
import type {
  KiroAvailableModel,
  KiroAvailableModelsResponse,
} from "../src/kiro/management-client.js";
import { ModelCapabilityService } from "../src/kiro/model-capabilities.js";
import { clearDynamicModelRegistry } from "../src/kiro/models.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";

const TTL_MS = 900_000;
const STALE_TTL_MS = 86_400_000;

function account(id: string): ManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    authMethod: "desktop",
    region: "us-east-1",
    refreshToken: `refresh-${id}`,
    accessToken: `access-${id}`,
    expiresAt: 4_000_000_000_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
  };
}

function auth(value: ManagedAccount): KiroAuthDetails {
  return {
    refresh: value.refreshToken,
    access: value.accessToken,
    expires: value.expiresAt,
    authMethod: value.authMethod,
    region: value.region,
  };
}

function model(modelId: string): KiroAvailableModel {
  return {
    modelId,
    modelName: modelId,
    supportedInputTypes: ["TEXT"],
    tokenLimits: { maxInputTokens: 100_000, maxOutputTokens: 32_000 },
  };
}

interface Harness {
  readonly service: ModelCapabilityService;
  readonly clock: { now: number };
  readonly calls: () => number;
}

function harness(
  respond: (call: number, signal?: AbortSignal) => Promise<KiroAvailableModelsResponse>,
  ttlMs: number = TTL_MS,
): Harness {
  const clock = { now: 1_000_000 };
  let calls = 0;
  const service = new ModelCapabilityService(
    {
      dynamic_model_catalog: true,
      model_catalog_ttl_ms: ttlMs,
      model_catalog_stale_ttl_ms: STALE_TTL_MS,
      model_catalog_request_timeout_ms: 10_000,
      proxy_url: null,
    },
    async (_auth, _region, options) => {
      calls += 1;
      return respond(calls, options?.signal);
    },
    () => clock.now,
  );
  return { service, clock, calls: () => calls };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const selected = account("a");

afterEach(() => clearDynamicModelRegistry());

describe("ModelCapabilityService negative cache", () => {
  test("does not touch the network again within the backoff window after a failure", async () => {
    const { service, clock, calls } = harness(async () => {
      throw new Error("offline");
    });

    const first = await service.ensureAccountModel(selected, auth(selected), "claude-opus-5");
    clock.now += 59_000;
    const second = await service.ensureAccountModel(selected, auth(selected), "claude-opus-5");

    expect(first).toEqual({ supported: true, source: "static", wireModel: "claude-opus-5" });
    expect(second).toEqual(first);
    expect(calls()).toBe(1);
  });

  test("serves the stale snapshot from the backoff window without a network call", async () => {
    const { service, clock, calls } = harness(async (call) => {
      if (call === 1) return { models: [model("future-model")] };
      throw new Error("offline");
    });
    await service.ensureAccountModel(selected, auth(selected), "future-model");
    clock.now += TTL_MS + 1;
    // Stale-while-revalidate: this call returns stale and kicks off the failing refresh.
    const revalidating = await service.ensureAccountModel(selected, auth(selected), "future-model");
    await Bun.sleep(0);
    const inBackoff = await service.ensureAccountModel(selected, auth(selected), "future-model");

    expect(revalidating).toMatchObject({ supported: true, source: "stale" });
    expect(inBackoff).toMatchObject({ supported: true, source: "stale" });
    expect(calls()).toBe(2);
  });

  test("grows the backoff exponentially from min(ttl, 60s) up to the catalog TTL", async () => {
    const { service, clock, calls } = harness(async () => {
      throw new Error("offline");
    });
    const probe = () => service.ensureAccountModel(selected, auth(selected), "claude-opus-5");

    await probe(); // failure 1 at t0 -> backoff 60 s
    clock.now += 59_999;
    await probe();
    expect(calls()).toBe(1);
    clock.now += 1; // t = 60 s
    await probe(); // failure 2 -> backoff 120 s
    expect(calls()).toBe(2);
    clock.now += 119_999;
    await probe();
    expect(calls()).toBe(2);
    clock.now += 1; // t = 180 s
    await probe(); // failure 3 -> backoff 240 s
    expect(calls()).toBe(3);
    clock.now += 240_000; // t = 420 s
    await probe(); // failure 4 -> backoff 480 s
    expect(calls()).toBe(4);
    clock.now += 480_000; // t = 900 s
    await probe(); // failure 5 -> backoff capped at ttl (900 s), not 960 s
    expect(calls()).toBe(5);
    clock.now += 899_999;
    await probe();
    expect(calls()).toBe(5);
    clock.now += 1;
    await probe();
    expect(calls()).toBe(6);
  });

  test("uses the catalog TTL as the base when it is shorter than 60 s", async () => {
    const { service, clock, calls } = harness(async () => {
      throw new Error("offline");
    }, 5_000);
    const probe = () => service.ensureAccountModel(selected, auth(selected), "claude-opus-5");

    await probe();
    clock.now += 4_999;
    await probe();
    expect(calls()).toBe(1);
    clock.now += 1;
    await probe();
    expect(calls()).toBe(2);
  });

  test("clears the backoff after a successful refresh", async () => {
    const { service, clock, calls } = harness(async (call) => {
      if (call === 1) throw new Error("offline");
      return { models: [model("future-model")] };
    });
    const probe = () => service.ensureAccountModel(selected, auth(selected), "future-model");

    await probe();
    clock.now += 60_000;
    const live = await probe();
    clock.now += TTL_MS + 1;
    await probe(); // stale + background revalidation (success)
    await Bun.sleep(0);

    expect(live).toMatchObject({ supported: true, source: "live" });
    expect(calls()).toBe(3);
    expect(service.readiness()).toMatchObject({ source: "live", freshAccounts: 1 });
  });

  test("a caller-cancelled refresh does not open a backoff window", async () => {
    const { service, calls } = harness(async (_call, signal) => {
      if (signal?.aborted) throw signal.reason;
      return { models: [model("future-model")] };
    });
    const cancelled = new AbortController();
    cancelled.abort(new DOMException("client went away", "AbortError"));

    const aborted = await service.ensureAccountModel(
      selected,
      auth(selected),
      "future-model",
      cancelled.signal,
    );
    const next = await service.ensureAccountModel(selected, auth(selected), "future-model");

    expect(aborted).toEqual({ supported: false, source: "static" });
    expect(next).toEqual({ supported: true, source: "live", wireModel: "future-model" });
    expect(calls()).toBe(2);
  });

  test("refreshAccounts respects the backoff window instead of re-probing a failing endpoint", async () => {
    const { service, clock, calls } = harness(async () => {
      throw new Error("offline");
    });

    await service.refreshAccounts([selected], auth);
    clock.now += 30_000;
    await service.refreshAccounts([selected], auth);
    expect(calls()).toBe(1);
    clock.now += 30_000;
    await service.refreshAccounts([selected], auth);
    expect(calls()).toBe(2);
  });
});

describe("ModelCapabilityService stale-while-revalidate", () => {
  test("returns a stale snapshot immediately and revalidates in the background", async () => {
    const pending = deferred<KiroAvailableModelsResponse>();
    const { service, clock, calls } = harness(async (call) => {
      if (call === 1) return { models: [model("future-model")] };
      return pending.promise;
    });
    await service.ensureAccountModel(selected, auth(selected), "future-model");
    clock.now += TTL_MS + 1;

    const controller = new AbortController();
    const stale = await service.ensureAccountModel(
      selected,
      auth(selected),
      "future-model",
      controller.signal,
    );
    const staleAgain = await service.ensureAccountModel(selected, auth(selected), "future-model");
    controller.abort();
    pending.resolve({ models: [model("future-model"), model("newer-model")] });
    await Bun.sleep(0);
    const live = await service.ensureAccountModel(selected, auth(selected), "newer-model");

    expect(stale).toMatchObject({ supported: true, source: "stale" });
    expect(staleAgain).toMatchObject({ supported: true, source: "stale" });
    expect(calls()).toBe(2);
    expect(live).toEqual({ supported: true, source: "live", wireModel: "newer-model" });
  });

  test("still awaits the first fetch when no snapshot exists yet", async () => {
    const pending = deferred<KiroAvailableModelsResponse>();
    const { service } = harness(async () => pending.promise);

    let settled = false;
    const result = service
      .ensureAccountModel(selected, auth(selected), "future-model")
      .then((value) => {
        settled = true;
        return value;
      });
    await Bun.sleep(0);
    expect(settled).toBe(false);
    pending.resolve({ models: [model("future-model")] });

    expect(await result).toEqual({ supported: true, source: "live", wireModel: "future-model" });
  });

  test("refreshAccounts awaits the live catalog for the models route", async () => {
    const pending = deferred<KiroAvailableModelsResponse>();
    const { service, clock } = harness(async (call) => {
      if (call === 1) return { models: [model("future-model")] };
      return pending.promise;
    });
    await service.ensureAccountModel(selected, auth(selected), "future-model");
    clock.now += TTL_MS + 1;

    let settled = false;
    const refresh = service.refreshAccounts([selected], auth).then(() => {
      settled = true;
    });
    await Bun.sleep(0);
    expect(settled).toBe(false);
    pending.resolve({ models: [model("newer-model")] });
    await refresh;

    expect(service.catalog().map((entry) => entry.id)).toEqual(["newer-model"]);
  });
});
