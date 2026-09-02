import { describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import type { PipelineAccountManager, PipelineTokenRefresher } from "../src/core/pipeline.js";
import { CLEANUP_GRACE_MS } from "../src/core/stream-cleanup.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import { openAiError } from "../src/server/errors.js";
import {
  anthropicIngressErrors,
  buildPipelineOptions,
  classifyBodyReadFailure,
  createIngress,
  type IngressErrorEnvelope,
  openAiIngressErrors,
  type RouteDependencies,
  readJsonBody,
  withRetryAfter,
} from "../src/server/ingress.js";
import type { RequestIdleTimeoutLease } from "../src/server/request-lifecycle.js";
import { handleChatCompletions } from "../src/server/routes/chat-completions.js";
import { handleMessages } from "../src/server/routes/messages.js";
import { handleResponses } from "../src/server/routes/responses.js";
import { canonicalRequest, message } from "./canonical-test-helpers.js";

const encoder = new TextEncoder();

function config(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    api_keys: ["sk-ingress"],
    enable_legacy_chat_completions: true,
    request_timeout_ms: 1_000,
    max_request_body_bytes: 64,
    ...overrides,
  });
}

function account(): ManagedAccount {
  return {
    id: "ingress-account",
    email: "ingress@example.com",
    authMethod: "desktop",
    region: "us-east-1",
    refreshToken: "refresh-token",
    accessToken: "access-token",
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
  };
}

class StubAccountManager implements PipelineAccountManager {
  readonly selected = account();

  reconcileFromDb(): readonly ManagedAccount[] {
    return [this.selected];
  }

  selectHealthyAccount(): ManagedAccount {
    return this.selected;
  }

  getAccountCount(): number {
    return 1;
  }

  toAuthDetails(selected: ManagedAccount): KiroAuthDetails {
    return {
      refresh: selected.refreshToken,
      access: selected.accessToken,
      expires: selected.expiresAt,
      authMethod: selected.authMethod,
      region: selected.region,
    };
  }

  markRateLimited(): void {}

  markUnhealthy(): void {}
}

const tokenRefresher: PipelineTokenRefresher = {
  async refreshIfNeeded(selected) {
    return selected;
  },
  async forceRefresh(selected) {
    return selected;
  },
};

function post(body: RequestInit["body"], init: RequestInit = {}): Request {
  return new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    ...init,
  });
}

function throwingBody(error: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull() {
      throw error;
    },
  });
}

function stalledBody(prefix = '{"model":"auto",'): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(prefix));
    },
  });
}

type Envelope = {
  readonly label: string;
  readonly errors: IngressErrorEnvelope;
  readonly expectError: (body: unknown, kind: string) => void;
};

const envelopes: readonly Envelope[] = [
  {
    label: "OpenAI",
    errors: openAiIngressErrors,
    expectError: (body, kind) => {
      const codes: Record<string, string> = {
        tooLarge: "request_too_large",
        deadline: "request_timeout",
        clientClosed: "client_disconnected",
        malformed: "malformed_request_body",
        invalidJson: "invalid_json",
        internal: "internal_error",
      };
      expect(body).toMatchObject({ error: { code: codes[kind] } });
    },
  },
  {
    label: "Anthropic",
    errors: anthropicIngressErrors,
    expectError: (body, kind) => {
      const types: Record<string, string> = {
        tooLarge: "request_too_large",
        deadline: "api_error",
        clientClosed: "api_error",
        malformed: "invalid_request_error",
        invalidJson: "invalid_request_error",
        internal: "api_error",
      };
      expect(body).toMatchObject({ type: "error", error: { type: types[kind] } });
    },
  },
];

describe("createIngress", () => {
  test("combines deadline and client signals and manages the idle-timeout lease once", () => {
    const controller = new AbortController();
    const request = post("{}", { signal: controller.signal });
    const calls: string[] = [];
    const lease: RequestIdleTimeoutLease = {
      disable: () => {
        calls.push("disable");
      },
      restore: () => {
        calls.push("restore");
      },
    };
    let created = 0;
    const ingress = createIngress(request, { request_timeout_ms: 5_000 }, () => {
      created += 1;
      return lease;
    });

    expect(ingress.signals.client).toBe(request.signal);
    expect(ingress.signals.combined.aborted).toBe(false);
    ingress.disableIdleTimeout();
    ingress.disableIdleTimeout();
    expect(created).toBe(1);
    controller.abort();
    expect(ingress.signals.combined.aborted).toBe(true);
    expect(ingress.signals.deadline.aborted).toBe(false);
    ingress.finalize();
    expect(calls).toEqual(["disable", "restore"]);
  });

  test("aborts the deadline signal after request_timeout_ms unless finalized first", async () => {
    const fired = createIngress(post(null), { request_timeout_ms: 10 });
    const cleared = createIngress(post(null), { request_timeout_ms: 10 });
    cleared.finalize();

    await Bun.sleep(40);

    expect(fired.signals.deadline.aborted).toBe(true);
    expect(fired.signals.deadline.reason).toBeInstanceOf(DOMException);
    expect(cleared.signals.deadline.aborted).toBe(false);
    fired.finalize();
  });
});

describe("readJsonBody", () => {
  test("decodes a valid JSON body", async () => {
    const request = post(JSON.stringify({ model: "auto" }));
    const ingress = createIngress(request, config());

    const result = await readJsonBody(request, config(), ingress.signals, openAiIngressErrors);

    ingress.finalize();
    expect(result).toEqual({ ok: true, value: { model: "auto" } });
  });

  test("treats a missing body as an empty document", async () => {
    const request = new Request("http://gateway/v1/responses", { method: "POST" });
    const ingress = createIngress(request, config());

    const result = await readJsonBody(request, config(), ingress.signals, openAiIngressErrors);

    ingress.finalize();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
    }
  });

  for (const envelope of envelopes) {
    test(`returns 400 for invalid JSON in the ${envelope.label} envelope`, async () => {
      const request = post("{bad");
      const ingress = createIngress(request, config());

      const result = await readJsonBody(request, config(), ingress.signals, envelope.errors);

      ingress.finalize();
      if (result.ok) throw new TypeError("Expected a failure");
      expect(result.response.status).toBe(400);
      envelope.expectError(await result.response.json(), "invalidJson");
    });

    test(`returns 413 for an oversized body in the ${envelope.label} envelope`, async () => {
      const request = post(JSON.stringify({ padding: "x".repeat(200) }));
      const ingress = createIngress(request, config());

      const result = await readJsonBody(request, config(), ingress.signals, envelope.errors);

      ingress.finalize();
      if (result.ok) throw new TypeError("Expected a failure");
      expect(result.response.status).toBe(413);
      envelope.expectError(await result.response.json(), "tooLarge");
    });

    test(`returns 504 when the deadline expires mid-upload in the ${envelope.label} envelope`, async () => {
      const request = post(stalledBody());
      const ingress = createIngress(request, { request_timeout_ms: 10 });

      const result = await readJsonBody(request, config(), ingress.signals, envelope.errors);

      ingress.finalize();
      if (result.ok) throw new TypeError("Expected a failure");
      expect(result.response.status).toBe(504);
      envelope.expectError(await result.response.json(), "deadline");
    });

    test(`returns 499 when the client aborts mid-upload in the ${envelope.label} envelope`, async () => {
      const controller = new AbortController();
      const request = post(stalledBody(), { signal: controller.signal });
      const ingress = createIngress(request, config());

      const pending = readJsonBody(request, config(), ingress.signals, envelope.errors);
      await Bun.sleep(5);
      controller.abort();
      const result = await pending;

      ingress.finalize();
      if (result.ok) throw new TypeError("Expected a failure");
      expect(result.response.status).toBe(499);
      envelope.expectError(await result.response.json(), "clientClosed");
    });

    test(`returns 499 for a connection-closed abort in the ${envelope.label} envelope`, async () => {
      const request = post(
        throwingBody(new DOMException("The connection was closed.", "AbortError")),
      );
      const ingress = createIngress(request, config());

      const result = await readJsonBody(request, config(), ingress.signals, envelope.errors);

      ingress.finalize();
      if (result.ok) throw new TypeError("Expected a failure");
      expect(result.response.status).toBe(499);
      envelope.expectError(await result.response.json(), "clientClosed");
    });

    test(`returns 400 for a malformed transfer in the ${envelope.label} envelope`, async () => {
      const request = post(throwingBody(new TypeError("Invalid chunked transfer encoding")));
      const ingress = createIngress(request, config());

      const result = await readJsonBody(request, config(), ingress.signals, envelope.errors);

      ingress.finalize();
      if (result.ok) throw new TypeError("Expected a failure");
      expect(result.response.status).toBe(400);
      envelope.expectError(await result.response.json(), "malformed");
    });

    test(`hides server-side read failures behind a fixed 500 in the ${envelope.label} envelope`, async () => {
      const request = post(throwingBody(new Error("disk /var/lib/secret exploded")));
      const ingress = createIngress(request, config());

      const result = await readJsonBody(request, config(), ingress.signals, envelope.errors);

      ingress.finalize();
      if (result.ok) throw new TypeError("Expected a failure");
      expect(result.response.status).toBe(500);
      const text = await result.response.text();
      expect(text).not.toContain("secret");
      const body: unknown = JSON.parse(text);
      envelope.expectError(body, "internal");
      expect(body).toMatchObject({
        error: {
          message: expect.stringMatching(/^Internal server error \(request_id: req_[0-9a-f-]+\)$/),
        },
      });
      expect(text).toMatch(/"request_id":"req_[0-9a-f-]+"/);
    });
  }
});

describe("classifyBodyReadFailure", () => {
  test("separates client disconnects, malformed transfers, and internal failures", () => {
    expect(classifyBodyReadFailure(new DOMException("closed", "AbortError"))).toBe("client-closed");
    expect(classifyBodyReadFailure(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(
      "client-closed",
    );
    expect(classifyBodyReadFailure(new SyntaxError("bad chunk size"))).toBe("malformed");
    expect(classifyBodyReadFailure(new RangeError("unexpected end of data"))).toBe("malformed");
    expect(classifyBodyReadFailure(new TypeError("ReadableStream is locked"))).toBe("internal");
    expect(classifyBodyReadFailure(new Error("body stream failed"))).toBe("internal");
    expect(classifyBodyReadFailure("string failure")).toBe("internal");
  });
});

describe("buildPipelineOptions", () => {
  const body = canonicalRequest([message("user", "hello")]);
  const accountManager = new StubAccountManager();
  const signal = new AbortController().signal;

  test("spreads every optional dependency exactly like the former per-route literal", () => {
    const quotaRechecker = { recheckDueAccounts: async () => {}, syncDueAccounts: async () => {} };
    const affinityStore = {} as NonNullable<RouteDependencies["affinityStore"]>;
    const reasoningReplayStore = {} as NonNullable<RouteDependencies["reasoningReplayStore"]>;
    const modelCapabilities = {} as NonNullable<RouteDependencies["modelCapabilities"]>;
    const makeClient = (() => {
      throw new TypeError("unused");
    }) as unknown as NonNullable<RouteDependencies["makeClient"]>;
    const affinity = { keyHash: "hash", source: "responses.prompt_cache_key" as const };
    const lineage = {
      source: "responses.history_lineage" as const,
      outputKeyHash: (fingerprint: string) => fingerprint,
    };
    const resolved = config();

    const options = buildPipelineOptions({
      body,
      model: "gpt-5.6-sol",
      stream: true,
      config: resolved,
      dependencies: {
        accountManager,
        tokenRefresher,
        quotaRechecker,
        tenantId: "tenant",
        affinityStore,
        reasoningReplayStore,
        modelCapabilities,
        makeClient,
      },
      affinity,
      lineage,
      deadlineSignal: signal,
    });

    expect(options).toEqual({
      body,
      model: "gpt-5.6-sol",
      stream: true,
      config: resolved,
      accountManager,
      tokenRefresher,
      quotaRechecker,
      affinity,
      lineage,
      affinityStore,
      tenantId: "tenant",
      reasoningReplayStore,
      modelCapabilities,
      deadlineSignal: signal,
      makeClient,
    });
  });

  test("omits absent optional dependencies while keeping tenantId explicit", () => {
    const options = buildPipelineOptions({
      body,
      model: "gpt-5.6-sol",
      stream: false,
      config: config(),
      dependencies: { accountManager, tokenRefresher },
      deadlineSignal: signal,
    });

    expect(Object.keys(options).sort()).toEqual(
      [
        "accountManager",
        "body",
        "config",
        "deadlineSignal",
        "model",
        "stream",
        "tenantId",
        "tokenRefresher",
      ].sort(),
    );
    expect(options.tenantId).toBeUndefined();
  });
});

describe("withRetryAfter", () => {
  test("promotes a retry_after_ms hint into Retry-After on 429 responses", async () => {
    const hinted = Response.json(
      {
        error: {
          message: "slow down",
          type: "upstream_error",
          code: "rate_limited",
          retry_after_ms: 2_500,
        },
      },
      { status: 429 },
    );

    const result = await withRetryAfter(hinted);

    expect(result.status).toBe(429);
    expect(result.headers.get("Retry-After")).toBe("3");
    expect(await result.json()).toMatchObject({ error: { code: "rate_limited" } });
  });

  test("accepts a retry_after seconds hint", async () => {
    const result = await withRetryAfter(
      Response.json({ error: { message: "slow", retry_after: 7 } }, { status: 429 }),
    );

    expect(result.headers.get("Retry-After")).toBe("7");
  });

  test("leaves responses without a known delay or with an existing header untouched", async () => {
    const existing = new Response("{}", { status: 429, headers: { "Retry-After": "42" } });
    const plain = openAiError(429, "no hint", "rate_limit_error");
    const other = Response.json({ error: { retry_after_ms: 1_000 } }, { status: 503 });

    expect(await withRetryAfter(existing)).toBe(existing);
    expect(await withRetryAfter(plain)).toBe(plain);
    expect(await withRetryAfter(other)).toBe(other);
    expect(other.headers.has("Retry-After")).toBe(false);
  });
});

describe("routes on the shared ingress", () => {
  const dependencies: RouteDependencies = {
    accountManager: new StubAccountManager(),
    tokenRefresher,
    async runPipeline() {
      throw new TypeError("pipeline must not run for an aborted upload");
    },
  };
  const routes = [
    {
      label: "chat-completions",
      handle: handleChatCompletions,
      envelope: { error: { code: "client_disconnected" } },
    },
    {
      label: "responses",
      handle: handleResponses,
      envelope: { error: { code: "client_disconnected" } },
    },
    {
      label: "messages",
      handle: handleMessages,
      envelope: { type: "error", error: { type: "api_error" } },
    },
  ] as const;

  for (const route of routes) {
    test(`returns 499 without an unhandled rejection when the client aborts mid-upload on ${route.label}`, async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        const controller = new AbortController();
        const request = new Request(`http://gateway/v1/${route.label}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: stalledBody(),
          signal: controller.signal,
        });
        const pending = route.handle(request, config(), dependencies);
        await Bun.sleep(5);
        controller.abort();
        const response = await pending;

        expect(response.status).toBe(499);
        expect(await response.json()).toMatchObject(route.envelope);
        await Bun.sleep(CLEANUP_GRACE_MS + 50);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
      expect(unhandled).toEqual([]);
    });
  }

  test("adds Retry-After to a hinted 429 from the pipeline on the Chat route", async () => {
    const response = await handleChatCompletions(
      new Request("http://gateway/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
      }),
      config({ max_request_body_bytes: 16_384 }),
      {
        ...dependencies,
        async runPipeline() {
          return Response.json(
            {
              error: {
                message: "busy",
                type: "upstream_error",
                code: "rate_limited",
                retry_after_ms: 900,
              },
            },
            { status: 429 },
          );
        },
      },
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("1");
  });
});
