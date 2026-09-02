import { describe, expect, test } from "bun:test";
import type { GenerateAssistantResponseCommand } from "@aws/codewhisperer-streaming-client";
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
import type { CanonicalRequest } from "../src/protocol/canonical.js";

/**
 * B25 evidence (docs/audits/kiro-protocol-evidence-probe-2026-09-02.zh.md):
 * Kiro validates replayed thinking signatures itself. A valid signature is
 * accepted in the same conversation, in a brand-new conversation, and on a
 * different account; a tampered one fails with HTTP 400
 * `ValidationException: ... Invalid `signature` in `thinking` block`.
 */

const MODEL = "claude-opus-4-8";

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
        (candidate) =>
          candidate.isHealthy &&
          candidate.rateLimitResetTime <= Date.now() &&
          (eligibleAccountIds?.has(candidate.id) ?? true),
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
    rate_limit_max_retries: 3,
    ...overrides,
  });
}

function responseFrom(events: readonly SdkStreamEvent[]): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
        for (const event of events) yield event;
        yield {
          metadataEvent: { tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        };
      },
    },
  };
}

function signedThinkingRequest(): CanonicalRequest {
  return {
    canonicalVersion: 1,
    protocol: "anthropic-messages",
    projectionMode: "safe",
    model: MODEL,
    stream: false,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "question", path: "messages.0.content.0" }],
        toolCalls: [],
        path: "messages.0",
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "prior answer", path: "messages.1.content.1" }],
        toolCalls: [],
        path: "messages.1",
      },
      {
        role: "user",
        content: [{ type: "text", text: "continue", path: "messages.2.content.0" }],
        toolCalls: [],
        path: "messages.2",
      },
    ],
    tools: [],
    toolChoice: "auto",
    includeEncryptedReasoning: false,
    reasoningReplays: [
      {
        lookup: {
          kind: "anthropic-direct",
          content: {
            kind: "reasoning_text",
            text: "signed reasoning",
            signature: "kiro-native-signature",
          },
        },
        outputFingerprint: "unused-for-anthropic-direct",
        insertBeforeMessage: 1,
        path: "messages.1.content.0",
      },
    ],
  };
}

function validationException(message: string): unknown {
  return {
    name: "ValidationException",
    message,
    $metadata: { httpStatusCode: 400 },
    $fault: "client",
  };
}

async function errorBody(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("error" in body)) {
    throw new TypeError("Expected an OpenAI error envelope");
  }
  return body.error as Record<string, unknown>;
}

describe("anthropic-direct signed thinking replay (B25)", () => {
  test("forwards the signed block without requiring an account/conversation affinity", async () => {
    // Given: no affinity, no lineage, no replay store, fresh conversation
    const commands: GenerateAssistantResponseCommand[] = [];
    const client: PipelineSdkClient = {
      async send(command) {
        commands.push(command);
        return responseFrom([{ assistantResponseEvent: { content: "answer" } }]);
      },
    };

    // When
    const response = await runChatCompletion({
      body: signedThinkingRequest(),
      model: MODEL,
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([account("account-a")]),
      tokenRefresher: refresher,
      makeClient: () => client,
    });

    // Then
    expect(response.status).toBe(200);
    expect(commands).toHaveLength(1);
    const history = commands[0]?.input.conversationState?.history ?? [];
    const replayed = history.find(
      (entry) => entry.assistantResponseMessage?.reasoningContent !== undefined,
    );
    expect(replayed?.assistantResponseMessage?.reasoningContent).toEqual({
      reasoningText: { text: "signed reasoning", signature: "kiro-native-signature" },
    });
  });

  test("maps Kiro's invalid-signature ValidationException to 400 without retry or account marking", async () => {
    // Given
    const manager = new FakeAccountManager([account("account-a"), account("account-b")]);
    let sends = 0;
    const client: PipelineSdkClient = {
      async send() {
        sends += 1;
        throw validationException("messages.1.content.0: Invalid `signature` in `thinking` block");
      },
    };

    // When
    const response = await runChatCompletion({
      body: signedThinkingRequest(),
      model: MODEL,
      stream: false,
      config: config(),
      accountManager: manager,
      tokenRefresher: refresher,
      makeClient: () => client,
    });

    // Then
    expect(response.status).toBe(400);
    expect(await errorBody(response)).toEqual({
      message: "messages.1.content.0: Invalid `signature` in `thinking` block",
      type: "invalid_request_error",
      code: "invalid_reasoning_signature",
    });
    expect(sends).toBe(1);
    expect(manager.rateLimited).toEqual([]);
    expect(manager.unhealthy).toEqual([]);
  });

  test("leaves other 400 ValidationExceptions on the generic upstream_error path", async () => {
    // Given
    const client: PipelineSdkClient = {
      async send() {
        throw validationException("conversationState.currentMessage: unrelated validation issue");
      },
    };

    // When
    const response = await runChatCompletion({
      body: signedThinkingRequest(),
      model: MODEL,
      stream: false,
      config: config(),
      accountManager: new FakeAccountManager([account("account-a")]),
      tokenRefresher: refresher,
      makeClient: () => client,
    });

    // Then
    expect(response.status).toBe(400);
    expect(await errorBody(response)).toMatchObject({
      type: "upstream_error",
      code: "ValidationException",
    });
  });
});
