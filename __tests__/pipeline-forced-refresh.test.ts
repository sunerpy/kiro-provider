import { describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import {
  type PipelineAccountManager,
  type PipelineSdkClient,
  type PipelineTokenRefresher,
  runChatCompletion,
} from "../src/core/pipeline.js";
import type {
  SdkStreamEvent,
  SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import { canonicalRequest, message } from "./canonical-test-helpers.js";

/**
 * C6: the pipeline, not the classifier, records which accounts were
 * force-refreshed. Each account gets exactly one forced refresh per request;
 * the next credential rejection on it switches accounts or terminates, so the
 * refresh-then-retry path cannot loop until max_request_iterations.
 */

const BODY = canonicalRequest([message("user", "hello")], { model: "auto" });

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

  selectHealthyAccount(
    _preferredAccountId?: string,
    eligibleAccountIds?: ReadonlySet<string>,
  ): ManagedAccount | null {
    return (
      this.accounts.find(
        (candidate) => candidate.isHealthy && (eligibleAccountIds?.has(candidate.id) ?? true),
      ) ?? null
    );
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
      email: selected.email,
    };
  }

  markRateLimited(selected: ManagedAccount): void {
    this.rateLimited.push(selected.id);
  }

  markUnhealthy(selected: ManagedAccount): void {
    this.unhealthy.push(selected.id);
  }
}

class RecordingRefresher implements PipelineTokenRefresher {
  readonly forced: string[] = [];

  async refreshIfNeeded(selected: ManagedAccount): Promise<ManagedAccount> {
    return selected;
  }

  async forceRefresh(selected: ManagedAccount): Promise<ManagedAccount> {
    this.forced.push(selected.id);
    return selected;
  }
}

function config(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    api_keys: ["sk-test"],
    request_timeout_ms: 5_000,
    stream_idle_timeout_ms: 1_000,
    rate_limit_retry_delay_ms: 1,
    rate_limit_max_retries: 5,
    max_request_iterations: 20,
    ...overrides,
  });
}

function sdkError(status: number, message: string): unknown {
  return { name: "SdkError", message, $metadata: { httpStatusCode: status } };
}

function completion(): SdkStreamResponse {
  const events: readonly SdkStreamEvent[] = [
    { assistantResponseEvent: { content: "ok" } },
    { metadataEvent: { tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } },
  ];
  return {
    generateAssistantResponseResponse: {
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
        for (const event of events) yield event;
      },
    },
  };
}

/** Scripts upstream per account: the listed accounts always reject credentials. */
function rejectingClient(
  auth: KiroAuthDetails,
  rejected: ReadonlySet<string>,
  status: number,
  detail: string,
  sends: string[],
): PipelineSdkClient {
  return {
    async send() {
      const email = auth.email ?? "missing";
      sends.push(email);
      if (rejected.has(email)) throw sdkError(status, detail);
      return completion();
    },
  };
}

describe("pipeline forced-refresh bookkeeping (C6)", () => {
  test.each([
    [401, "unauthorized"],
    [403, "The bearer token included in the request is invalid"],
  ])(
    "force-refreshes a single account once for a %i then terminates with that status",
    async (status, detail) => {
      // Given
      const refresher = new RecordingRefresher();
      const sends: string[] = [];
      const rejected = new Set(["account-a@example.com"]);

      // When
      const response = await runChatCompletion({
        body: BODY,
        model: "auto",
        stream: false,
        config: config(),
        accountManager: new FakeAccountManager([account("account-a")]),
        tokenRefresher: refresher,
        makeClient: (auth) => rejectingClient(auth, rejected, status, detail, sends),
      });

      // Then: one refresh, one retry, then the classifier fails instead of looping.
      expect(response.status).toBe(status);
      expect(refresher.forced).toEqual(["account-a"]);
      expect(sends).toEqual(["account-a@example.com", "account-a@example.com"]);
    },
  );

  test("switches to the next account after the one forced refresh is rejected again", async () => {
    // Given
    const refresher = new RecordingRefresher();
    const manager = new FakeAccountManager([account("account-a"), account("account-b")]);
    const sends: string[] = [];
    const rejected = new Set(["account-a@example.com"]);

    // When
    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: manager,
      tokenRefresher: refresher,
      makeClient: (auth) => rejectingClient(auth, rejected, 401, "unauthorized", sends),
    });

    // Then
    expect(response.status).toBe(200);
    expect(refresher.forced).toEqual(["account-a"]);
    expect(sends).toEqual([
      "account-a@example.com",
      "account-a@example.com",
      "account-b@example.com",
    ]);
    expect(manager.rateLimited).toEqual(["account-a"]);
  });

  test("tracks forced refreshes per account when every account rejects credentials", async () => {
    // Given
    const refresher = new RecordingRefresher();
    const sends: string[] = [];
    const rejected = new Set(["account-a@example.com", "account-b@example.com"]);

    // When
    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([account("account-a"), account("account-b")]),
      tokenRefresher: refresher,
      makeClient: (auth) => rejectingClient(auth, rejected, 401, "unauthorized", sends),
    });

    // Then: two accounts, two forced refreshes, four sends, no further iterations.
    expect(response.status).toBe(401);
    expect(refresher.forced).toEqual(["account-a", "account-b"]);
    expect(sends).toEqual([
      "account-a@example.com",
      "account-a@example.com",
      "account-b@example.com",
      "account-b@example.com",
    ]);
  });
});
