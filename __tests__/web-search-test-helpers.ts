import { createHash } from "node:crypto";
import type { GenerateAssistantResponseCommand } from "@aws/codewhisperer-streaming-client";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import { loadReasoningReplayKeyring } from "../src/reasoning/keyring.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import { type AppDependencies, createApp } from "../src/server/app.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";
import {
  WebSearchToolDefinitionCache,
  webSearchReservationBytes,
} from "../src/web-search/session.js";
import { WebSearchSnapshotStore } from "../src/web-search/snapshot-store.js";

export const WEB_SEARCH_FIXTURE_KEY = "sk-web-search-fixture";
export const FIXTURE_TOOL_DESCRIPTION =
  "Backend-owned fixture description. Cite sources with [description](url).";
export const FIXTURE_TOOL_SCHEMA: Record<string, unknown> = {
  additionalProperties: false,
  type: "object",
  properties: { query: { type: "string", description: "The search query to execute." } },
  required: ["query"],
};

export interface FixtureSource {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly publishedDate?: number;
  readonly id: string;
  readonly domain: string;
  readonly maxVerbatimWordLimit: number;
  readonly publicDomain: boolean;
}

export const FIXTURE_SOURCES: readonly FixtureSource[] = [
  {
    title: "Fixture Runtime 9.9 release notes",
    url: "https://docs.example.com/blog/runtime-9-9",
    snippet:
      "Fixture Runtime 9.9 ships a faster installer, a new test reporter and many bug fixes for the package manager.",
    publishedDate: 1788586772000,
    id: "0",
    domain: "example.com",
    maxVerbatimWordLimit: 30,
    publicDomain: true,
  },
  {
    title: "Fixture Runtime releases",
    url: "https://github.com/example/runtime/releases",
    snippet: "Release history for Fixture Runtime.",
    publishedDate: 1788000000000,
    id: "1",
    domain: "github.com",
    maxVerbatimWordLimit: 30,
    publicDomain: true,
  },
];

export interface McpCall {
  /** JSON-RPC request id; the evidenced service echoes it. */
  readonly id: unknown;
  readonly method: string;
  readonly params: unknown;
  readonly target: string | null;
  readonly userAgent: string | null;
  readonly authorization: string | null;
  readonly profileArn: unknown;
  readonly url: string;
}

export type McpResponder = (call: McpCall) => Response | Promise<Response>;

/** Answers InvokeMCP exactly as the evidenced KiroRuntime service does. */
export function defaultMcpResponder(
  sources: readonly FixtureSource[] = FIXTURE_SOURCES,
): McpResponder {
  return (call) => {
    if (call.method === "tools/list") {
      return Response.json(
        {
          id: call.id,
          jsonrpc: "2.0",
          result: {
            tools: [
              {
                name: "web_search",
                description: FIXTURE_TOOL_DESCRIPTION,
                inputSchema: FIXTURE_TOOL_SCHEMA,
              },
            ],
          },
        },
        { headers: { "content-type": "application/x-amz-json-1.0" } },
      );
    }
    const query = (call.params as { arguments?: { query?: unknown } }).arguments?.query;
    return Response.json(
      {
        id: call.id,
        jsonrpc: "2.0",
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                results: sources,
                totalResults: sources.length,
                query,
                error: null,
              }),
            },
          ],
          isError: false,
        },
      },
      { headers: { "content-type": "application/x-amz-json-1.0" } },
    );
  };
}

export const ACCOUNT_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/fixture";
export const FIXTURE_REPLAY_KEY = `fixture:${Buffer.alloc(32, 7).toString("base64url")}`;

/** The tenant the auth gate derives from an API key. */
export function fixtureTenant(apiKey: string = WEB_SEARCH_FIXTURE_KEY): string {
  return createHash("sha256").update("kiro-provider-tenant-v1\0").update(apiKey).digest("hex");
}

export async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

/**
 * A generation that emits its events and then stalls like a silent upstream
 * until the dispatch is aborted (or `release` resolves).
 */
export interface StalledGeneration {
  readonly stalled: readonly SdkStreamEvent[];
  readonly release?: Promise<void>;
}

export function webSearchFixture(
  generations: ReadonlyArray<readonly SdkStreamEvent[] | StalledGeneration>,
  options: {
    readonly config?: Partial<Config> & Record<string, unknown>;
    readonly mcp?: McpResponder;
    readonly dependencies?: Partial<AppDependencies> & Record<string, unknown>;
    /** Shared state, so a second fixture can model a restarted process. */
    readonly database?: AccountsDatabase;
    /** Profile of the single fixture account; its region is the runtime region. */
    readonly accountProfileArn?: string;
    /** Id of the single fixture account, so a second fixture can model another account. */
    readonly accountId?: string;
  } = {},
) {
  const config = ConfigSchema.parse({
    api_keys: [WEB_SEARCH_FIXTURE_KEY],
    protocol_projection_mode: "v3-auto",
    request_timeout_ms: 5_000,
    stream_idle_timeout_ms: 2_000,
    rate_limit_retry_delay_ms: 1,
    test_upstream_endpoint: "https://runtime.fixture.invalid",
    web_search_enabled: true,
    // Below the request deadline, so a search is never paused for lack of time.
    web_search_timeout_ms: 1_000,
    reasoning_replay_keys: [FIXTURE_REPLAY_KEY],
    ...options.config,
  });
  const database = options.database ?? new AccountsDatabase(":memory:");
  const keyring = loadReasoningReplayKeyring(config);
  const store = new WebSearchSnapshotStore(database, () => keyring, {
    capacityBytes: config.web_search_max_cache_bytes,
    reservationBytes: webSearchReservationBytes(config),
  });
  const preparedIds: string[] = [];
  const prepare = store.prepare.bind(store);
  store.prepare = (input) => {
    preparedIds.push(input.callId);
    prepare(input);
  };
  const profileArn = options.accountProfileArn ?? ACCOUNT_PROFILE_ARN;
  const account: ManagedAccount = {
    id: options.accountId ?? "web-search-fixture-account",
    email: "fixture@example.invalid",
    authMethod: "desktop",
    region: (profileArn.split(":")[3] ?? "us-east-1") as ManagedAccount["region"],
    profileArn,
    refreshToken: "fixture-refresh",
    accessToken: "fixture-access",
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
  };
  const inputs: GenerateAssistantResponseCommand["input"][] = [];
  const mcpCalls: McpCall[] = [];
  const state = { iteratorsClosed: 0, upstreamAborts: 0 };
  const responder = options.mcp ?? defaultMcpResponder();
  const webSearchFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      id?: unknown;
      method?: string;
      params?: unknown;
      profileArn?: unknown;
    };
    const call: McpCall = {
      id: body.id,
      method: String(body.method),
      params: body.params,
      target: headers.get("x-amz-target"),
      userAgent: headers.get("user-agent"),
      authorization: headers.get("authorization"),
      profileArn: body.profileArn,
      url: String(input instanceof Request ? input.url : input),
    };
    mcpCalls.push(call);
    const signal = init?.signal;
    if (!signal) return responder(call);
    if (signal.aborted) throw signal.reason;
    // Like the real fetch, an aborted request rejects even if the server stalls.
    return await new Promise<Response>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(responder(call)).then(
        (response) => {
          signal.removeEventListener("abort", onAbort);
          resolve(response);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  };
  const dependencies = {
    accountManager: {
      reconcileFromDb: () => [account],
      selectHealthyAccount: (_preferred?: string, allowed?: ReadonlySet<string>) =>
        allowed === undefined || allowed.has(account.id) ? account : null,
      getAccountCount: () => 1,
      toAuthDetails: () => ({
        refresh: account.refreshToken,
        access: account.accessToken,
        expires: account.expiresAt,
        authMethod: account.authMethod,
        region: account.region,
        profileArn: account.profileArn,
      }),
      markRateLimited() {},
      markUnhealthy() {},
    },
    tokenRefresher: {
      refreshIfNeeded: async () => account,
      forceRefresh: async () => account,
    },
    makeClient: () => ({
      async send(command, sendOptions) {
        const generation = generations[inputs.length] ?? [
          { assistantResponseEvent: { content: "UNEXPECTED_EXTRA_GENERATION" } },
        ];
        inputs.push(command.input);
        sendOptions.abortSignal.addEventListener("abort", () => state.upstreamAborts++, {
          once: true,
        });
        const signal = sendOptions.abortSignal;
        return {
          generateAssistantResponseResponse: (async function* () {
            try {
              const events = "stalled" in generation ? generation.stalled : generation;
              yield* events;
              if ("stalled" in generation) {
                await new Promise<void>((resolve, reject) => {
                  if (signal.aborted) reject(signal.reason);
                  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                  void generation.release?.then(resolve);
                });
              }
              if (!events.some((event) => event.metadataEvent?.tokenUsage !== undefined)) {
                yield {
                  metadataEvent: {
                    tokenUsage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
                  },
                };
              }
            } finally {
              state.iteratorsClosed++;
            }
          })(),
        };
      },
    }),
    reasoningReplayStore: new ReasoningReplayStore(database, config, keyring),
    webSearch: {
      store,
      keyring: () => keyring,
      fetch: webSearchFetch,
      definitions: new WebSearchToolDefinitionCache(),
    },
    ...options.dependencies,
  } as AppDependencies;
  const app = createApp(config, dependencies);
  const post = (
    path: string,
    body: Record<string, unknown>,
    init: { signal?: AbortSignal; headers?: Record<string, string> } = {},
  ) =>
    app(
      new Request(`http://fixture${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${WEB_SEARCH_FIXTURE_KEY}`,
          ...init.headers,
        },
        body: JSON.stringify(body),
        ...(init.signal ? { signal: init.signal } : {}),
      }),
    );
  return {
    app,
    post,
    inputs,
    mcpCalls,
    state,
    config,
    account,
    database,
    store,
    keyring,
    tenantId: fixtureTenant(),
    /** Public ids of every hosted call recorded so far, in order. */
    publishedSearchIds: () => [...preparedIds],
  };
}

/** One Kiro generation that calls the hosted search tool once. */
export function searchCallGeneration(
  query: string,
  toolUseId = "call_fixture_search_0001",
  preamble?: string,
): SdkStreamEvent[] {
  return [
    ...(preamble ? [{ assistantResponseEvent: { content: preamble } }] : []),
    { toolUseEvent: { toolUseId, name: "web_search", input: JSON.stringify({ query }) } },
    { toolUseEvent: { toolUseId, name: "web_search", input: "", stop: true } },
  ] as SdkStreamEvent[];
}

export function textGeneration(text: string): SdkStreamEvent[] {
  return [{ assistantResponseEvent: { content: text } }];
}

export function sseData(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .filter((line) => line !== "[DONE]")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
