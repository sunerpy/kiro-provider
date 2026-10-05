/**
 * Pre-fix reproducer for provider-executed hosted web search.
 *
 *   bun scripts/reproduce-web-search-baseline.ts [--out <file outside the repository>]
 *
 * Statically imports only modules that already exist at the pre-implementation
 * baseline (0691fafd3b665bd556baf4a40368f84c2ef3a785), so this exact file runs
 * unchanged on that revision and on the implementation. It enters createApp
 * with the request shapes captured from Codex 0.159.3 (`web_search` live) and
 * the Claude Code 2.1.285 WebSearch side request, stream and non-stream, over
 * an in-process Kiro fake: a first generation that calls `web_search` and a
 * second one that answers. Hosted search services (snapshot store and an
 * in-process InvokeMCP fake) are attached only when the tree has them; their
 * absence is recorded, not hidden. The report holds statuses, typed error
 * codes and counts only.
 */
import { resolve } from "node:path";
import { ConfigSchema } from "../src/config/schema.js";
import { loadReasoningReplayKeyring } from "../src/reasoning/keyring.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import { type AppDependencies, createApp } from "../src/server/app.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

type Json = Record<string, unknown>;

const API_KEY = "sk-web-search-reproducer";
const QUERY = "fixture runtime latest release";
const SOURCE_URL = "https://docs.example.com/blog/runtime-9-9";
const ANSWER = `Fixture Runtime 9.9 is the latest release, per the [release notes](${SOURCE_URL}).`;
const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/reproducer";

const CASES = [
  {
    path: "/v1/responses",
    body: (stream: boolean): Json => ({
      model: "gpt-5.6-sol",
      store: false,
      stream,
      input: [{ role: "user", content: [{ type: "input_text", text: "What is new in Fixture?" }] }],
      tools: [{ type: "web_search", external_web_access: true }],
      tool_choice: "auto",
      include: ["reasoning.encrypted_content", "web_search_call.action.sources"],
    }),
  },
  {
    path: "/v1/messages",
    body: (stream: boolean): Json => ({
      model: "claude-opus-5-5",
      max_tokens: 128_000,
      stream,
      system: [{ type: "text", text: "You are an assistant for performing a web search tool use" }],
      messages: [{ role: "user", content: `Perform a web search for the query: ${QUERY}` }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
      tool_choice: { type: "auto" },
      output_config: { effort: "max" },
    }),
  },
] as const;

function generations(): Json[][] {
  return [
    [
      {
        toolUseEvent: {
          toolUseId: "call_reproducer_search_0001",
          name: "web_search",
          input: JSON.stringify({ query: QUERY }),
          stop: true,
        },
      },
      { metadataEvent: { tokenUsage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } } },
    ],
    [
      { assistantResponseEvent: { content: ANSWER } },
      { metadataEvent: { tokenUsage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } } },
    ],
  ];
}

/** InvokeMCP answered exactly as the evidenced KiroRuntime service does. */
function mcpFake(counter: { calls: number }) {
  return async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const request = JSON.parse(String(init?.body ?? "{}")) as { id?: unknown; method?: string };
    const headers = { "content-type": "application/x-amz-json-1.0" };
    if (request.method === "tools/list") {
      return Response.json(
        {
          id: request.id,
          jsonrpc: "2.0",
          result: {
            tools: [
              {
                name: "web_search",
                description: "Reproducer search. Cite sources with [description](url).",
                inputSchema: {
                  type: "object",
                  additionalProperties: false,
                  properties: { query: { type: "string" } },
                  required: ["query"],
                },
              },
            ],
          },
        },
        { headers },
      );
    }
    counter.calls += 1;
    const results = [
      {
        title: "Fixture Runtime 9.9 release notes",
        url: SOURCE_URL,
        snippet: "Fixture Runtime 9.9 ships a faster installer.",
        publishedDate: 1788586772000,
        id: "0",
        domain: "example.com",
        maxVerbatimWordLimit: 30,
        publicDomain: true,
      },
    ];
    return Response.json(
      {
        id: request.id,
        jsonrpc: "2.0",
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ results, totalResults: 1, query: QUERY, error: null }),
            },
          ],
          isError: false,
        },
      },
      { headers },
    );
  };
}

async function hostedSearchDependencies(
  database: AccountsDatabase,
  keyring: ReturnType<typeof loadReasoningReplayKeyring>,
  counter: { calls: number },
): Promise<Json | undefined> {
  // The pre-fix tree has no hosted search modules; that is part of the result.
  const store = "../src/web-search/snapshot-store.js";
  const session = "../src/web-search/session.js";
  try {
    const snapshots = (await import(store)) as Json;
    const sessions = (await import(session)) as Json;
    const Store = snapshots.WebSearchSnapshotStore as new (...args: unknown[]) => unknown;
    const Definitions = sessions.WebSearchToolDefinitionCache as new () => unknown;
    return {
      store: new Store(database, () => keyring, {
        capacityBytes: 268_435_456,
        reservationBytes: 1_048_576,
      }),
      keyring: () => keyring,
      fetch: mcpFake(counter),
      definitions: new Definitions(),
    };
  } catch {
    return undefined;
  }
}

async function runCase(path: string, body: Json, stream: boolean): Promise<Json> {
  const config = ConfigSchema.parse({
    api_keys: [API_KEY],
    protocol_projection_mode: "v3-auto",
    request_timeout_ms: 5_000,
    stream_idle_timeout_ms: 2_000,
    rate_limit_retry_delay_ms: 1,
    test_upstream_endpoint: "https://runtime.reproducer.invalid",
    web_search_enabled: true,
    web_search_timeout_ms: 1_000,
    reasoning_replay_keys: [`reproducer:${Buffer.alloc(32, 9).toString("base64url")}`],
  });
  const database = new AccountsDatabase(":memory:");
  const keyring = loadReasoningReplayKeyring(config);
  const account = {
    id: "reproducer-account",
    email: "reproducer@example.invalid",
    authMethod: "desktop",
    region: "us-east-1",
    profileArn: PROFILE_ARN,
    refreshToken: "reproducer-refresh",
    accessToken: "reproducer-access",
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
  };
  const planned = generations();
  let dispatched = 0;
  const counter = { calls: 0 };
  const webSearch = await hostedSearchDependencies(database, keyring, counter);
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
      async send() {
        const events = planned[dispatched] ?? [
          { assistantResponseEvent: { content: "UNEXPECTED_EXTRA_GENERATION" } },
        ];
        dispatched += 1;
        return {
          generateAssistantResponseResponse: (async function* () {
            yield* events;
          })(),
        };
      },
    }),
    reasoningReplayStore: new ReasoningReplayStore(database, config, keyring),
    ...(webSearch !== undefined ? { webSearch } : {}),
  } as unknown as AppDependencies;
  const app = createApp(config, dependencies);
  const response = await app(
    new Request(`http://reproducer${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  let code: unknown = null;
  let type: unknown = null;
  if (response.status >= 400) {
    try {
      const error = (JSON.parse(text) as { error?: Json }).error;
      code = error?.code ?? null;
      type = error?.type ?? null;
    } catch {
      code = null;
    }
  }
  database.close();
  return {
    path,
    stream,
    status: response.status,
    code,
    type,
    generations: dispatched,
    mcp_search_calls: counter.calls,
    search_items:
      (text.match(/"type":"web_search_call"/g) ?? []).length +
      (text.match(/"type":"server_tool_use"/g) ?? []).length,
    citations:
      (text.match(/"type":"url_citation"/g) ?? []).length +
      (text.match(/"type":"web_search_result_location"/g) ?? []).length,
  };
}

async function main(): Promise<void> {
  const results: Json[] = [];
  for (const entry of CASES) {
    for (const stream of [false, true]) {
      results.push(await runCase(entry.path, entry.body(stream), stream));
    }
  }
  let hostedModules = true;
  try {
    await import("../src/web-search/snapshot-store.js" as string);
  } catch {
    hostedModules = false;
  }
  const report = { schema_version: 1, hosted_search_modules_present: hostedModules, results };
  const output = process.argv.indexOf("--out");
  const target = output < 0 ? undefined : process.argv[output + 1];
  if (target !== undefined) {
    const repository = resolve(import.meta.dir, "..");
    if (resolve(target).startsWith(`${repository}/`)) throw new Error("output_outside_repository");
    await Bun.write(target, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

await main();
