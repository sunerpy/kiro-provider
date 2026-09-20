import type { GenerateAssistantResponseCommand } from "@aws/codewhisperer-streaming-client";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import { type AppDependencies, createApp } from "../src/server/app.js";

export const MESSAGES_FIXTURE_KEY = "sk-messages-regression-fixture";
export const FABLE_MODEL = "claude-fable-5-1";

export function messagesFixture(
  events: readonly SdkStreamEvent[] = [{ assistantResponseEvent: { content: "CONTINUED" } }],
  options: {
    config?: Partial<Config>;
    dependencies?: Partial<AppDependencies>;
    stream?: (signal: AbortSignal) => AsyncIterable<SdkStreamEvent>;
  } = {},
) {
  const config = ConfigSchema.parse({
    api_keys: [MESSAGES_FIXTURE_KEY],
    request_timeout_ms: 2_000,
    stream_idle_timeout_ms: 1_000,
    ...options.config,
  });
  const selected: ManagedAccount = {
    id: "messages-fixture-account",
    email: "fixture@example.invalid",
    authMethod: "desktop",
    region: "us-east-1",
    profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/fixture",
    refreshToken: "fixture-refresh",
    accessToken: "fixture-access",
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
  };
  const inputs: GenerateAssistantResponseCommand["input"][] = [];
  const state = { iteratorClosed: 0, aborted: 0 };
  const dependencies: AppDependencies = {
    accountManager: {
      reconcileFromDb: () => [selected],
      selectHealthyAccount: () => selected,
      getAccountCount: () => 1,
      toAuthDetails: () => ({
        refresh: selected.refreshToken,
        access: selected.accessToken,
        expires: selected.expiresAt,
        authMethod: selected.authMethod,
        region: selected.region,
        profileArn: selected.profileArn,
      }),
      markRateLimited() {},
      markUnhealthy() {},
    },
    tokenRefresher: {
      refreshIfNeeded: async () => selected,
      forceRefresh: async () => selected,
    },
    makeClient: () => ({
      async send(command, sendOptions) {
        inputs.push(command.input);
        sendOptions.abortSignal.addEventListener("abort", () => state.aborted++, { once: true });
        return {
          generateAssistantResponseResponse:
            options.stream?.(sendOptions.abortSignal) ??
            (async function* () {
              try {
                yield* events;
                yield {
                  metadataEvent: {
                    tokenUsage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
                  },
                };
              } finally {
                state.iteratorClosed++;
              }
            })(),
        };
      },
    }),
    ...options.dependencies,
  };
  const app = createApp(config, dependencies);
  const request = (
    body: Record<string, unknown>,
    path = "/v1/messages",
    init: { signal?: AbortSignal; key?: string } = {},
  ) =>
    app(
      new Request(`http://fixture${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": init.key ?? MESSAGES_FIXTURE_KEY,
        },
        body: JSON.stringify({ model: FABLE_MODEL, max_tokens: 1024, ...body }),
        ...(init.signal ? { signal: init.signal } : {}),
      }),
    );
  return { app, request, inputs, state, config, dependencies };
}

export function messagesSseEvents(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}
