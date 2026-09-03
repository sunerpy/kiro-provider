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
import { parseCanonicalCompletion } from "../src/protocol/output.js";
import { canonicalRequest, message } from "./canonical-test-helpers.js";

/**
 * B4: on the non-stream path nothing has reached the client yet, so stream
 * failures are routed by normalizeStreamFailure().disposition — retryable
 * ones (malformed tool arguments, embedded stream error, truncation) get the
 * bounded retry, fatal ones terminate as 502 (never 500).
 *
 * A retryable failure before the first semantic event (no reasoning, text, or
 * validated tool call yet) takes the pre-publication retry bounded by
 * `stream_max_attempts`; one after semantic output keeps the
 * `rate_limit_max_retries` bound.
 */

const BODY = canonicalRequest([message("user", "hello")], { model: "auto" });
const COMPLETION: SdkStreamEvent = {
  metadataEvent: { tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
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
    rate_limit_max_retries: 2,
    ...overrides,
  });
}

function exactResponse(events: readonly SdkStreamEvent[]): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
        for (const event of events) yield event;
      },
    },
  };
}

function sequence(responses: readonly SdkStreamResponse[]): {
  readonly client: PipelineSdkClient;
  readonly sends: () => number;
} {
  let sends = 0;
  return {
    sends: () => sends,
    client: {
      async send() {
        const response = responses[Math.min(sends, responses.length - 1)];
        sends += 1;
        if (!response) throw new TypeError("no scripted response");
        return response;
      },
    },
  };
}

async function errorBody(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  return body.error;
}

const OK = exactResponse([{ assistantResponseEvent: { content: "recovered" } }, COMPLETION]);

describe("non-stream stream-failure routing (B4)", () => {
  test("retries malformed tool arguments (ToolCallViolation) then succeeds", async () => {
    const malformed = exactResponse([
      { toolUseEvent: { toolUseId: "tool-1", name: "lookup", input: "{not json", stop: true } },
      COMPLETION,
    ]);
    const scripted = sequence([malformed, OK]);
    const manager = new FakeAccountManager([account("account-a")]);

    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: manager,
      tokenRefresher: refresher,
      makeClient: () => scripted.client,
    });

    expect(response.status).toBe(200);
    expect(scripted.sends()).toBe(2);
    expect(parseCanonicalCompletion(await response.json())?.text).toBe("recovered");
    expect(manager.rateLimited).toEqual([]);
    expect(manager.unhealthy).toEqual([]);
  });

  test("retries an embedded upstream stream error then succeeds", async () => {
    const embeddedError = exactResponse([
      { assistantResponseEvent: { content: "partial" } },
      { error: { message: "upstream hiccup" } } as SdkStreamEvent,
    ]);
    const scripted = sequence([embeddedError, OK]);

    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([account("account-a")]),
      tokenRefresher: refresher,
      makeClient: () => scripted.client,
    });

    expect(response.status).toBe(200);
    expect(scripted.sends()).toBe(2);
  });

  test("returns 502 once a retryable pre-semantic failure exhausts stream_max_attempts", async () => {
    const malformed = exactResponse([
      { toolUseEvent: { toolUseId: "tool-1", name: "lookup", input: "{not json", stop: true } },
      COMPLETION,
    ]);
    const scripted = sequence([malformed]);

    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: false,
      config: config({ rate_limit_max_retries: 1, stream_max_attempts: 2 }),
      accountManager: new FakeAccountManager([account("account-a")]),
      tokenRefresher: refresher,
      makeClient: () => scripted.client,
    });

    expect(response.status).toBe(502);
    expect(scripted.sends()).toBe(2);
    expect(await errorBody(response)).toMatchObject({
      type: "upstream_error",
      code: "malformed_upstream_tool_arguments",
    });
  });

  const fatalCases: {
    readonly label: string;
    readonly events: readonly SdkStreamEvent[];
    readonly code: string;
  }[] = [
    {
      label: "incomplete tool call (ToolCallViolation)",
      events: [{ toolUseEvent: { toolUseId: "tool-1", name: "lookup", input: "{}" } }, COMPLETION],
      code: "incomplete_upstream_tool_call",
    },
    {
      label: "tool call without identity (ToolCallViolation)",
      events: [{ toolUseEvent: { toolUseId: "tool-1", input: "{}" } }, COMPLETION],
      code: "invalid_upstream_tool_call",
    },
    {
      label: "unknown stream event (SdkStreamProtocolError)",
      events: [{ $unknown: ["mystery", {}] } as unknown as SdkStreamEvent, COMPLETION],
      code: "unsupported_upstream_event",
    },
    {
      label: "invalid stream state (SdkStreamProtocolError)",
      events: [{ invalidStateEvent: { reason: "x" } } as unknown as SdkStreamEvent, COMPLETION],
      code: "upstream_invalid_state",
    },
  ];

  test.each(fatalCases)("maps a fatal $label to 502 without retrying", async ({ events, code }) => {
    const scripted = sequence([exactResponse(events), OK]);
    const manager = new FakeAccountManager([account("account-a"), account("account-b")]);

    const response = await runChatCompletion({
      body: BODY,
      model: "auto",
      stream: false,
      config: config(),
      accountManager: manager,
      tokenRefresher: refresher,
      makeClient: () => scripted.client,
    });

    expect(response.status).toBe(502);
    expect(scripted.sends()).toBe(1);
    expect(await errorBody(response)).toMatchObject({ type: "upstream_error", code });
    expect(manager.rateLimited).toEqual([]);
    expect(manager.unhealthy).toEqual([]);
  });
});
