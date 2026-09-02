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
import { canonicalRequest, message } from "./canonical-test-helpers.js";

/**
 * B7: effort request fields are merged into the SDK command input by the
 * pipeline (migrated from the removed sdk-client addEffortConfig middleware,
 * which re-parsed and re-serialized every request body).
 */

function account(): ManagedAccount {
  return {
    id: "effort-account",
    email: "effort@example.com",
    authMethod: "desktop",
    region: "us-east-1",
    refreshToken: "refresh",
    accessToken: "access",
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
  };
}

class FakeAccountManager implements PipelineAccountManager {
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

const refresher: PipelineTokenRefresher = {
  refreshIfNeeded: async (selected) => selected,
  forceRefresh: async (selected) => selected,
};

function config(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    api_keys: ["sk-test"],
    request_timeout_ms: 5_000,
    stream_idle_timeout_ms: 1_000,
    ...overrides,
  });
}

function completion(): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: {
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
        yield { assistantResponseEvent: { content: "ok" } };
        yield {
          metadataEvent: { tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        };
      },
    },
  };
}

async function capturedInput(
  model: string,
  configOverrides: Partial<Config>,
  bodyOverrides: Partial<CanonicalRequest> = {},
): Promise<GenerateAssistantResponseCommand["input"]> {
  const commands: GenerateAssistantResponseCommand[] = [];
  const client: PipelineSdkClient = {
    async send(command) {
      commands.push(command);
      return completion();
    },
  };
  const response = await runChatCompletion({
    body: canonicalRequest([message("user", "hello")], { model, ...bodyOverrides }),
    model,
    stream: false,
    config: config(configOverrides),
    accountManager: new FakeAccountManager(),
    tokenRefresher: refresher,
    makeClient: () => client,
  });
  expect(response.status).toBe(200);
  const command = commands[0];
  if (!command) throw new TypeError("the pipeline must send exactly one command");
  return command.input;
}

describe("effort request fields in the command input (B7)", () => {
  test("injects GPT effort using reasoning.effort for the wire model", async () => {
    const input = await capturedInput("gpt-5.6-sol", { effort: "high" });

    expect(input.conversationState?.currentMessage?.userInputMessage?.modelId).toBe("gpt-5.6-sol");
    expect(input.additionalModelRequestFields).toEqual({ reasoning: { effort: "high" } });
  });

  test("injects Claude effort using output_config.effort for the wire model", async () => {
    const input = await capturedInput("claude-opus-5", { effort: "max" });

    expect(input.additionalModelRequestFields).toEqual({ output_config: { effort: "max" } });
  });

  test("merges Claude effort with the request-scoped max_tokens instead of overwriting it", async () => {
    const input = await capturedInput(
      "claude-opus-5",
      { effort: "high" },
      { outputTokenLimit: 4096 },
    );

    expect(input.additionalModelRequestFields).toEqual({
      max_tokens: 4096,
      output_config: { effort: "high" },
    });
  });

  test("omits additionalModelRequestFields entirely when no effort or limit applies", async () => {
    const input = await capturedInput("claude-opus-5", {});

    expect("additionalModelRequestFields" in input).toBe(false);
  });
});
