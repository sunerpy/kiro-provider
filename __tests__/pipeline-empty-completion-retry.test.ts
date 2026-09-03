import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import { auditHash } from "../src/core/audit-log.js";
import {
  type PipelineAccountManager,
  type PipelineClientFactory,
  type PipelineTokenRefresher,
  runChatCompletion,
} from "../src/core/pipeline.js";
import type {
  SdkStreamEvent,
  SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import { parseCanonicalCompletion, parseCanonicalOutputEventLine } from "../src/protocol/output.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import { canonicalRequest, message } from "./canonical-test-helpers.js";

/**
 * One-shot empty-completion retry: a witnessed completion with zero reasoning,
 * zero visible text, and zero tool calls is replaced by one extra same-account
 * attempt when `retry_empty_completion` is on. The retry counts against
 * `stream_max_attempts`; if it is empty too, that result is returned.
 */

const BODY = canonicalRequest([message("user", "hello")], { model: "auto" });
const COMPLETION: SdkStreamEvent = {
  metadataEvent: { tokenUsage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } },
};

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

class PreferredAccountManager implements PipelineAccountManager {
  readonly rateLimited: string[] = [];
  readonly unhealthy: string[] = [];

  constructor(readonly accounts: ManagedAccount[]) {}

  reconcileFromDb(): readonly ManagedAccount[] {
    return this.accounts;
  }

  selectHealthyAccount(
    preferredAccountId?: string,
    eligibleAccountIds?: ReadonlySet<string>,
  ): ManagedAccount | null {
    const selectable = this.accounts.filter(
      (candidate) => candidate.isHealthy && (eligibleAccountIds?.has(candidate.id) ?? true),
    );
    return (
      selectable.find((candidate) => candidate.id === preferredAccountId) ?? selectable[0] ?? null
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

const refresher: PipelineTokenRefresher = {
  refreshIfNeeded: async (selected) => selected,
  forceRefresh: async (selected) => selected,
};

function config(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    api_keys: ["sk-test"],
    request_timeout_ms: 5_000,
    stream_idle_timeout_ms: 1_000,
    rate_limit_retry_delay_ms: 1,
    ...overrides,
  });
}

function eventsResponse(events: readonly SdkStreamEvent[]): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
        for (const event of events) yield event;
      },
    },
  };
}

const EMPTY = (): SdkStreamResponse => eventsResponse([COMPLETION]);
const EMPTY_METERED = (): SdkStreamResponse =>
  eventsResponse([{ meteringEvent: { usage: 0.01, unit: "credit", unitPlural: "credits" } }]);
const TEXT = (): SdkStreamResponse =>
  eventsResponse([{ assistantResponseEvent: { content: "second try" } }, COMPLETION]);
const REDACTED_ONLY = (): SdkStreamResponse =>
  eventsResponse([
    { reasoningContentEvent: { redactedContent: new Uint8Array([1, 2, 3]) } },
    COMPLETION,
  ]);

function scriptedClient(scripts: readonly (() => SdkStreamResponse)[]): {
  readonly makeClient: PipelineClientFactory;
  readonly sends: string[];
} {
  const sends: string[] = [];
  const makeClient: PipelineClientFactory = (
    _auth,
    _region,
    _effort,
    _endpoint,
    _proxy,
    accountId,
  ) => ({
    async send() {
      const script = scripts[Math.min(sends.length, scripts.length - 1)];
      sends.push(accountId ?? "");
      if (!script) throw new TypeError("no scripted response");
      return script();
    },
  });
  return { makeClient, sends };
}

async function eventTypes(response: Response): Promise<{ types: string[]; text: string }> {
  const lines = (await response.text()).trim().split("\n");
  const events = lines.map((line) => parseCanonicalOutputEventLine(line));
  return {
    types: events.map((event) => event?.type ?? "invalid"),
    text: events.map((event) => (event?.type === "text_delta" ? event.text : "")).join(""),
  };
}

let audit: ReturnType<typeof captureAuditEvents>;

beforeEach(() => {
  audit = captureAuditEvents();
});

afterEach(() => {
  audit.restore();
});

describe("empty completion retry (stream)", () => {
  test("replaces an empty completion with the same-account retry's output", async () => {
    const manager = new PreferredAccountManager([account("account-a"), account("account-b")]);
    const scripted = scriptedClient([EMPTY, TEXT]);

    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: true,
      config: config(),
      accountManager: manager,
      tokenRefresher: refresher,
      makeClient: scripted.makeClient,
    });
    const received = await eventTypes(response);

    expect(received.types).toEqual(["started", "text_delta", "completed"]);
    expect(received.text).toBe("second try");
    expect(scripted.sends).toEqual(["account-a", "account-a"]);
    expect(audit.events("sdk_stream_empty_completion_retry")).toEqual([
      expect.objectContaining({
        level: "warn",
        attempt: 1,
        max_attempts: 3,
        account_hash: auditHash("account-a"),
        mode: "stream",
      }),
    ]);
    expect(manager.rateLimited).toEqual([]);
    expect(manager.unhealthy).toEqual([]);
  });

  test("returns the second empty completion without a third attempt", async () => {
    const scripted = scriptedClient([EMPTY, EMPTY_METERED, TEXT]);

    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: true,
      config: config(),
      accountManager: new PreferredAccountManager([account("account-a")]),
      tokenRefresher: refresher,
      makeClient: scripted.makeClient,
    });
    const received = await eventTypes(response);

    expect(received.types).toEqual(["started", "completed"]);
    expect(scripted.sends).toEqual(["account-a", "account-a"]);
    expect(audit.events("sdk_stream_empty_completion_retry")).toHaveLength(1);
  });

  test("does nothing when retry_empty_completion is off", async () => {
    const scripted = scriptedClient([EMPTY, TEXT]);

    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: true,
      config: config({ retry_empty_completion: false }),
      accountManager: new PreferredAccountManager([account("account-a")]),
      tokenRefresher: refresher,
      makeClient: scripted.makeClient,
    });
    const received = await eventTypes(response);

    expect(received.types).toEqual(["started", "completed"]);
    expect(scripted.sends).toEqual(["account-a"]);
    expect(audit.events("sdk_stream_empty_completion_retry")).toEqual([]);
  });

  test("counts against stream_max_attempts", async () => {
    const scripted = scriptedClient([EMPTY, TEXT]);

    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: true,
      config: config({ stream_max_attempts: 1 }),
      accountManager: new PreferredAccountManager([account("account-a")]),
      tokenRefresher: refresher,
      makeClient: scripted.makeClient,
    });

    expect((await eventTypes(response)).types).toEqual(["started", "completed"]);
    expect(scripted.sends).toEqual(["account-a"]);
  });

  test("redacted-only reasoning is not an empty completion", async () => {
    const scripted = scriptedClient([REDACTED_ONLY, TEXT]);

    const response = await runChatCompletion({
      body: { ...BODY, protocol: "anthropic-messages" },
      model: "auto",
      stream: true,
      config: config(),
      accountManager: new PreferredAccountManager([account("account-a")]),
      tokenRefresher: refresher,
      makeClient: scripted.makeClient,
    });

    expect((await eventTypes(response)).types).toEqual([
      "started",
      "reasoning_redacted",
      "completed",
    ]);
    expect(scripted.sends).toEqual(["account-a"]);
    expect(audit.events("sdk_stream_empty_completion_retry")).toEqual([]);
  });
});

describe("empty completion retry (non-stream)", () => {
  test("replaces an empty completion with the retry's output", async () => {
    const scripted = scriptedClient([EMPTY, TEXT]);

    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: new PreferredAccountManager([account("account-a")]),
      tokenRefresher: refresher,
      makeClient: scripted.makeClient,
    });

    expect(response.status).toBe(200);
    expect(parseCanonicalCompletion(await response.json())?.text).toBe("second try");
    expect(scripted.sends).toEqual(["account-a", "account-a"]);
    expect(audit.events("sdk_stream_empty_completion_retry")).toEqual([
      expect.objectContaining({ mode: "non-stream", attempt: 1 }),
    ]);
  });

  test("returns the second empty completion as-is", async () => {
    const scripted = scriptedClient([EMPTY, EMPTY, TEXT]);

    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: new PreferredAccountManager([account("account-a")]),
      tokenRefresher: refresher,
      makeClient: scripted.makeClient,
    });

    expect(response.status).toBe(200);
    expect(parseCanonicalCompletion(await response.json())?.text).toBe("");
    expect(scripted.sends).toEqual(["account-a", "account-a"]);
  });

  test("does nothing when retry_empty_completion is off", async () => {
    const scripted = scriptedClient([EMPTY, TEXT]);

    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: false,
      config: config({ retry_empty_completion: false }),
      accountManager: new PreferredAccountManager([account("account-a")]),
      tokenRefresher: refresher,
      makeClient: scripted.makeClient,
    });

    expect(parseCanonicalCompletion(await response.json())?.text).toBe("");
    expect(scripted.sends).toEqual(["account-a"]);
  });
});
