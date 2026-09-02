import { describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import type {
  PipelineAccountManager,
  PipelineTokenRefresher,
} from "../src/core/pipeline.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import { createApp } from "../src/server/app.js";

const API_KEY = "sk-routing";
const encoder = new TextEncoder();

function config(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    api_keys: [API_KEY],
    enable_legacy_chat_completions: true,
    request_timeout_ms: 1_000,
    max_request_body_bytes: 1_024,
    ...overrides,
  });
}

function account(): ManagedAccount {
  return {
    id: "routing-account",
    email: "routing@example.com",
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

function app(overrides: Partial<Config> = {}): ReturnType<typeof createApp> {
  return createApp(config(overrides), {
    accountManager: new StubAccountManager(),
    tokenRefresher,
  });
}

const bearer = { Authorization: `Bearer ${API_KEY}` };

function request(
  path: string,
  init: RequestInit & { readonly headers?: Record<string, string> } = {},
): Request {
  return new Request(`http://gateway${path}`, init);
}

describe("route dispatch", () => {
  test.each([
    ["GET", "/v1/responses", "POST"],
    ["GET", "/v1/chat/completions", "POST"],
    ["PUT", "/v1/models", "GET"],
    ["POST", "/health", "GET, HEAD"],
    ["DELETE", "/ready", "GET"],
  ])("answers %s %s with 405 and an Allow header", async (method, path, allow) => {
    const response = await app()(request(path, { method, headers: bearer }));

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe(allow);
    expect(await response.json()).toMatchObject({
      error: { type: "invalid_request_error", code: "method_not_allowed" },
    });
  });

  test("uses the Anthropic envelope for 405 on Anthropic routes", async () => {
    const response = await app()(request("/v1/messages", { method: "GET", headers: bearer }));

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect(await response.json()).toMatchObject({
      type: "error",
      error: { type: "invalid_request_error" },
    });
  });

  test("answers OPTIONS on known paths with 405 before authentication", async () => {
    const openAi = await app()(request("/v1/responses", { method: "OPTIONS" }));
    const anthropic = await app()(request("/v1/messages/count_tokens", { method: "OPTIONS" }));

    expect(openAi.status).toBe(405);
    expect(openAi.headers.get("Allow")).toBe("POST");
    expect(anthropic.status).toBe(405);
    expect(anthropic.headers.get("Allow")).toBe("POST");
    expect(await anthropic.json()).toMatchObject({ type: "error" });
  });

  test("answers HEAD /health with 200 and no body", async () => {
    const response = await app()(request("/health", { method: "HEAD" }));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  test("tolerates exactly one trailing slash", async () => {
    const health = await app()(request("/health/"));
    const models = await app()(request("/v1/models/", { headers: bearer }));
    const messages = await app()(request("/v1/messages/", { method: "POST" }));
    const doubleSlash = await app()(request("/v1/models//", { headers: bearer }));

    expect(health.status).toBe(200);
    expect(models.status).toBe(200);
    expect(await models.json()).toMatchObject({ object: "list" });
    expect(messages.status).toBe(401);
    expect(await messages.json()).toMatchObject({
      type: "error",
      error: { type: "authentication_error" },
    });
    expect(doubleSlash.status).toBe(404);
  });

  test("keeps unknown routes behind authentication", async () => {
    const anonymous = await app()(request("/v1/unknown"));
    const authenticated = await app()(request("/v1/unknown", { headers: bearer }));

    expect(anonymous.status).toBe(401);
    expect(authenticated.status).toBe(404);
  });

  test("rejects a wrong method even when the legacy Chat route is disabled", async () => {
    const response = await app({ enable_legacy_chat_completions: false })(
      request("/v1/chat/completions", { method: "GET", headers: bearer }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });
});

describe("authentication gate over HTTP", () => {
  test("adds WWW-Authenticate: Bearer to 401 responses in both envelopes", async () => {
    const openAi = await app()(request("/v1/models"));
    const anthropic = await app()(request("/v1/messages", { method: "POST" }));

    expect(openAi.status).toBe(401);
    expect(openAi.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(anthropic.status).toBe(401);
    expect(anthropic.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  test("matches the Bearer scheme case-insensitively", async () => {
    const response = await app()(
      request("/v1/models", { headers: { Authorization: `bearer ${API_KEY}` } }),
    );

    expect(response.status).toBe(200);
  });

  test("accepts x-api-key on OpenAI routes", async () => {
    const models = await app()(request("/v1/models", { headers: { "x-api-key": API_KEY } }));
    const ready = await app()(request("/ready", { headers: { "x-api-key": API_KEY } }));

    expect(models.status).toBe(200);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: "ready" });
  });
});

describe("Anthropic ingress envelopes", () => {
  const headers = { ...bearer, "Content-Type": "application/json" };

  test("returns 413 in the Anthropic envelope for an oversized body", async () => {
    const response = await app()(
      request("/v1/messages", {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "claude-sonnet-5", padding: "x".repeat(2_048) }),
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: { type: "request_too_large" },
    });
  });

  test("returns 504 in the Anthropic envelope when the upload stalls past the deadline", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"model":"claude-sonnet-5",'));
      },
    });
    const response = await app({ request_timeout_ms: 20 })(
      request("/v1/messages", { method: "POST", headers, body: stalled }),
    );

    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: { type: "api_error", message: "Request deadline exceeded" },
    });
  });

  test("returns 499 in the Anthropic envelope when the client aborts mid-upload", async () => {
    const controller = new AbortController();
    const stalled = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(encoder.encode('{"model":"claude-sonnet-5",'));
      },
    });
    const pending = app()(
      request("/v1/messages", {
        method: "POST",
        headers,
        body: stalled,
        signal: controller.signal,
      }),
    );
    await Bun.sleep(10);
    controller.abort();
    const response = await pending;

    expect(response.status).toBe(499);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: { type: "api_error", message: "Client closed request" },
    });
  });
});
