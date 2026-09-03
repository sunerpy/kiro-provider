import { describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import {
  type PipelineAccountManager,
  type PipelineSdkClient,
  type PipelineTokenRefresher,
  runChatCompletion,
} from "../src/core/pipeline.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import { canonicalRequest, message } from "./canonical-test-helpers.js";

/**
 * Kiro's rejected replayed thinking signature is recognised structurally via
 * the SDK `ValidationExceptionReason` `THINKING_SIGNATURE_INVALID`; the
 * message pattern remains as the fallback for responses without a reason.
 */

function account(id: string): ManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    authMethod: "desktop",
    region: "us-east-1",
    refreshToken: `${id}-refresh`,
    accessToken: `${id}-access`,
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
  };
}

class FakeAccountManager implements PipelineAccountManager {
  readonly rateLimited: string[] = [];
  readonly unhealthy: string[] = [];

  constructor(readonly accounts: ManagedAccount[]) {}

  reconcileFromDb(): readonly ManagedAccount[] {
    return this.accounts;
  }

  selectHealthyAccount(): ManagedAccount | null {
    return this.accounts.find((candidate) => candidate.isHealthy) ?? null;
  }

  getAccountCount(): number {
    return this.accounts.length;
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

  markRateLimited(selected: ManagedAccount): void {
    this.rateLimited.push(selected.id);
  }

  markUnhealthy(selected: ManagedAccount): void {
    this.unhealthy.push(selected.id);
  }
}

const refresher: PipelineTokenRefresher = {
  refreshIfNeeded: async (selected) => selected,
  forceRefresh: async (selected) => selected,
};

function config(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    api_keys: ["sk-test"],
    request_timeout_ms: 5_000,
    rate_limit_retry_delay_ms: 1,
    ...overrides,
  });
}

function validationException(message: string, reason?: string): unknown {
  return {
    name: "ValidationException",
    message,
    ...(reason !== undefined ? { reason } : {}),
    $metadata: { httpStatusCode: 400 },
    $fault: "client",
  };
}

async function run(error: unknown): Promise<{
  readonly response: Response;
  readonly sends: number;
  readonly manager: FakeAccountManager;
}> {
  const manager = new FakeAccountManager([account("account-a"), account("account-b")]);
  let sends = 0;
  const client: PipelineSdkClient = {
    async send() {
      sends += 1;
      throw error;
    },
  };
  const response = await runChatCompletion({
    body: canonicalRequest([message("user", "hello")], { model: "claude-opus-4-8" }),
    model: "claude-opus-4-8",
    stream: false,
    config: config(),
    accountManager: manager,
    tokenRefresher: refresher,
    makeClient: () => client,
  });
  return { response, sends: sends, manager };
}

describe("structured invalid-signature detection", () => {
  test("matches reason THINKING_SIGNATURE_INVALID regardless of the message text", async () => {
    const { response, sends, manager } = await run(
      validationException("Improperly formed request.", "THINKING_SIGNATURE_INVALID"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        message: "Improperly formed request.",
        type: "invalid_request_error",
        code: "invalid_reasoning_signature",
      },
    });
    expect(sends).toBe(1);
    expect(manager.rateLimited).toEqual([]);
    expect(manager.unhealthy).toEqual([]);
  });

  test("falls back to the message pattern when no reason is present", async () => {
    const { response, sends } = await run(
      validationException("messages.1.content.0: Invalid `signature` in `thinking` block"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_reasoning_signature" },
    });
    expect(sends).toBe(1);
  });

  test("an unrelated 400 reason surfaces its structured code on the upstream_error path", async () => {
    const { response } = await run(
      validationException("Improperly formed request.", "SOME_OTHER_VALIDATION_REASON"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { type: "upstream_error", code: "some_other_validation_reason" },
    });
  });
});
