import { describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import type {
  PipelineAccountManager,
  PipelineTokenRefresher,
  RunChatCompletionOptions,
} from "../src/core/pipeline.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import { openAiError } from "../src/server/errors.js";
import {
  handleMessages,
  type MessagesDependencies,
  translatePipelineError,
} from "../src/server/routes/messages.js";

const MODEL = "claude-sonnet-5";

function config(): Config {
  return ConfigSchema.parse({
    api_keys: ["sk-messages"],
    request_timeout_ms: 1_000,
    max_request_body_bytes: 16_384,
  });
}

function account(): ManagedAccount {
  return {
    id: "messages-account",
    email: "messages@example.com",
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

function dependencies(
  runPipeline: (options: RunChatCompletionOptions) => Promise<Response>,
): MessagesDependencies {
  return { accountManager: new StubAccountManager(), tokenRefresher, runPipeline };
}

function request(): Request {
  return new Request("http://gateway/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1_024,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
}

describe("Anthropic pipeline error translation", () => {
  test("maps 402 quota exhaustion to a retryable rate_limit_error that keeps the provider code", async () => {
    const response = await handleMessages(
      request(),
      config(),
      dependencies(async () =>
        openAiError(
          402,
          "All eligible Kiro accounts have exhausted their quota",
          "upstream_error",
          "quota_exhausted",
        ),
      ),
    );
    const body: unknown = await response.json();

    expect(response.status).toBe(429);
    expect(body).toMatchObject({
      type: "error",
      error: {
        type: "rate_limit_error",
        message: "All eligible Kiro accounts have exhausted their quota (code: quota_exhausted)",
      },
    });
  });

  test("preserves an upstream Retry-After header on translated 429 responses", async () => {
    const translated = await translatePipelineError(
      new Response(
        JSON.stringify({ error: { message: "slow down", type: "upstream_error", code: "rate_limited" } }),
        { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "12" } },
      ),
    );

    expect(translated.status).toBe(429);
    expect(translated.headers.get("Retry-After")).toBe("12");
    expect(await translated.json()).toMatchObject({
      type: "error",
      error: { type: "rate_limit_error", message: "slow down" },
    });
  });

  test("promotes a retry_after_ms hint from the pipeline into Retry-After", async () => {
    const response = await handleMessages(
      request(),
      config(),
      dependencies(async () =>
        Response.json(
          { error: { message: "busy", type: "upstream_error", code: "rate_limited", retry_after_ms: 1_500 } },
          { status: 429 },
        ),
      ),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(await response.json()).toMatchObject({ error: { type: "rate_limit_error" } });
  });

  test("keeps other pipeline statuses in their existing Anthropic classes", async () => {
    const invalid = await translatePipelineError(
      openAiError(400, "bad request", "invalid_request_error", "invalid_request"),
    );
    const overloaded = await translatePipelineError(
      openAiError(503, "no accounts", "service_unavailable", "no_accounts"),
    );
    const opaque = await translatePipelineError(new Response("not json", { status: 502 }));

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { type: "invalid_request_error" } });
    expect(overloaded.status).toBe(503);
    expect(await overloaded.json()).toMatchObject({ error: { type: "overloaded_error" } });
    expect(opaque.status).toBe(502);
    expect(await opaque.json()).toMatchObject({
      error: { type: "api_error", message: "Upstream request failed with HTTP 502" },
    });
  });
});
